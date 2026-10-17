import { Context } from 'koa';
import Database, { Database as SqliteDatabase } from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import db, { closeDatabase, reopenDatabase } from '../database';
import { runMigrations } from '../database/migrations';
import { config } from '../config';
import { assertAdmin } from '../middlewares/auth';
import { beginMaintenance } from '../middlewares/maintenance';
import { verifyPassword } from '../services/password';
import { recordAudit } from '../services/audit';
import { success } from '../utils/response';

const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const attempts = new Map<number, { count: number; until: number }>();

async function verifyAdministrator(ctx: Context) {
  const user = assertAdmin(ctx);
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const limit = attempts.get(user.id) || { count: 0, until: now + 60_000 };
  if (++limit.count > 5) ctx.throw(429, '备份操作过于频繁，请一分钟后重试');
  attempts.set(user.id, limit);
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as any;
  if (!row || !await verifyPassword((ctx.request.body as any)?.password, row.password_hash)) {
    recordAudit(user.id, 'backup.reauthenticate', 'system', '', ctx.ip, 'failure');
    ctx.throw(403, '当前密码不正确');
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as any;
  assertAdmin(ctx);
  if (fresh?.status !== 'active' || fresh?.role !== 'admin' || fresh.password_hash !== row.password_hash) {
    ctx.throw(403, '管理员权限已发生变化，请重新登录');
  }
  return fresh;
}

function integrityCheck(database: SqliteDatabase) {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw Object.assign(new Error('备份数据库完整性检查失败'), { status: 400 });
  }
  if ((database.pragma('foreign_key_check') as unknown[]).length) {
    throw Object.assign(new Error('备份数据库存在无效的数据关联'), { status: 400 });
  }
}

export class BackupController {
  async download(ctx: Context) {
    const user = await verifyAdministrator(ctx);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-backup-'));
    const snapshot = path.join(directory, 'backup.db');
    try {
      await db.backup(snapshot);
      assertAdmin(ctx);
      const copy = new Database(snapshot);
      try {
        copy.pragma('journal_mode = DELETE');
        copy.exec('DELETE FROM sessions');
        integrityCheck(copy);
      } finally { copy.close(); }
      recordAudit(user.id, 'backup.download', 'system', '', ctx.ip);
      const filename = `outlook-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      ctx.set('Content-Type', 'application/octet-stream');
      ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
      ctx.set('Content-Length', String(fs.statSync(snapshot).size));
      const stream = fs.createReadStream(snapshot);
      stream.once('close', () => {
        fs.rmSync(snapshot, { force: true });
        fs.rmdirSync(directory);
      });
      ctx.body = stream;
    } catch (error) {
      fs.rmSync(snapshot, { force: true });
      fs.rmdirSync(directory);
      throw error;
    }
  }

  async restore(ctx: Context) {
    const admin = await verifyAdministrator(ctx);
    const fileContent = (ctx.request.body as any)?.fileContent;
    if (typeof fileContent !== 'string' || !fileContent.length || fileContent.length > Math.ceil(MAX_BACKUP_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileContent)) {
      ctx.throw(400, '请选择有效的 SQLite 备份文件，最大 50 MB');
    }
    const buffer = Buffer.from(fileContent, 'base64');
    if (buffer.length > MAX_BACKUP_BYTES || buffer.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
      ctx.throw(400, '文件不是有效的 SQLite 数据库');
    }
    if (config.dbPath === ':memory:') ctx.throw(409, '内存数据库不支持文件恢复');
    const parent = path.dirname(config.dbPath);
    const stagedPath = path.join(parent, `.restore-${randomUUID()}.db`);
    const rollbackDir = path.join(parent, 'restore-backups');
    fs.mkdirSync(rollbackDir, { recursive: true });
    const rollbackPath = path.join(rollbackDir, `before-restore-${Date.now()}-${randomUUID()}.db`);
    let staged: SqliteDatabase | undefined;
    let release: (() => void) | undefined;
    let originalMoved = false;
    let replacementInstalled = false;
    try {
      fs.writeFileSync(stagedPath, buffer, { mode: 0o600, flag: 'wx' });
      staged = new Database(stagedPath);
      staged.pragma('trusted_schema = OFF');
      for (const table of ['accounts', 'proxies', 'mail_cache', 'tags', 'account_tags']) {
        if (!staged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          ctx.throw(400, '该文件不是本项目的完整备份');
        }
      }
      integrityCheck(staged);
      const legacy = !staged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
      await runMigrations(staged, stagedPath);
      staged.transaction(() => {
        if (legacy) {
          staged!.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,status,must_change_password,source)
            VALUES (?,?,?,?,'admin','active',0,'admin')`).run(admin.id, admin.username, admin.display_name, admin.password_hash);
          staged!.exec(`UPDATE proxies SET is_default=0 WHERE id NOT IN (SELECT MIN(id) FROM proxies WHERE is_default=1)`);
          for (const table of ['accounts', 'proxies', 'tags']) {
            staged!.prepare(`UPDATE ${table} SET owner_user_id=? WHERE owner_user_id IS NULL`).run(admin.id);
          }
        }
        if (!staged!.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active'").get()) {
          ctx.throw(400, '备份中没有有效管理员，不能恢复');
        }
        for (const table of ['accounts', 'tags', 'proxies']) {
          if (staged!.prepare(`SELECT 1 FROM ${table} WHERE owner_user_id IS NULL LIMIT 1`).get()) {
            ctx.throw(400, '备份含有尚未分配归属的资源，请先初始化该备份');
          }
        }
        if (staged!.prepare(`SELECT 1 FROM account_tags at JOIN accounts a ON at.account_id=a.id
          JOIN tags t ON at.tag_id=t.id WHERE a.owner_user_id<>t.owner_user_id LIMIT 1`).get()) {
          ctx.throw(400, '备份存在跨用户的标签关联');
        }
        staged!.exec('DELETE FROM sessions');
        // Restoring a snapshot must never revive previously revoked public links.
        staged!.exec('DELETE FROM account_share_links');
        // Import credentials are also claim credentials; old snapshots must not revive them.
        staged!.exec('UPDATE accounts SET admin_imported=0');
        // A snapshot may predate a successful claim. Never revive its old bearer codes.
        staged!.exec("UPDATE accounts SET claim_status='assigned', claim_code_hash=NULL, claim_code_expires_at=NULL WHERE claim_status='available' OR claim_code_hash IS NOT NULL OR claim_code_expires_at IS NOT NULL");
        staged!.prepare(`INSERT INTO audit_logs (actor_id,action,target_type,target_id,ip,result)
          VALUES (NULL,'backup.restore','administrator',?,?,'success')`).run(admin.username, ctx.ip);
      }).immediate();
      integrityCheck(staged);
      staged.pragma('journal_mode = DELETE');
      staged.close();
      staged = undefined;

      release = await beginMaintenance(ctx);
      assertAdmin(ctx);
      const current = db.prepare('SELECT role,status,password_hash FROM users WHERE id=?').get(admin.id) as any;
      if (current?.role !== 'admin' || current.status !== 'active' || current.password_hash !== admin.password_hash) {
        ctx.throw(403, '管理员权限已发生变化，请重新登录');
      }
      closeDatabase();
      fs.renameSync(config.dbPath, rollbackPath);
      originalMoved = true;
      fs.renameSync(stagedPath, config.dbPath);
      replacementInstalled = true;
      reopenDatabase();
      integrityCheck(db);
      success(ctx, { message: '数据恢复完成，请使用备份中的账号重新登录', backup: path.basename(rollbackPath) });
    } catch (error: any) {
      if (originalMoved) {
        closeDatabase();
        if (replacementInstalled) fs.rmSync(config.dbPath, { force: true });
        fs.renameSync(rollbackPath, config.dbPath);
        reopenDatabase();
      } else if (!db.open) {
        reopenDatabase();
      }
      if (error.code?.startsWith('SQLITE_')) ctx.throw(400, '备份格式或数据库版本无效，当前数据未被替换');
      throw error;
    } finally {
      staged?.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(stagedPath + suffix, { force: true });
      release?.();
    }
  }
}
