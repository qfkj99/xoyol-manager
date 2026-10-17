import { Context } from 'koa';
import db from '../database';
import { assertAdmin } from '../middlewares/auth';
import { publicUser, userModel, UserRecord } from '../models/User';
import { recordAudit } from '../services/audit';
import { hashPassword, validateDisplayName, validatePassword, validateUsername } from '../services/password';
import { clearSessionCookie, revokeUserSessions } from '../services/session';
import { success } from '../utils/response';

function targetUser(ctx: Context): UserRecord {
  const id = Number(ctx.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) ctx.throw(400, '无效的用户 ID');
  const record = userModel.getById(id);
  if (!record || record.status === 'deleted') ctx.throw(404, '用户不存在');
  return record;
}

function protectLastAdmin(ctx: Context, target: UserRecord, role: unknown, status: unknown) {
  if (target.role !== 'admin' || target.status !== 'active' || (role === 'admin' && status === 'active')) return;
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").get() as { count: number };
  if (count <= 1) ctx.throw(409, '必须保留至少一个有效管理员');
}

export class UserController {
  async list(ctx: Context) {
    assertAdmin(ctx);
    const page = Math.max(1, Math.min(1_000_000, Number(ctx.query.page) || 1)) | 0;
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 20)) | 0;
    const search = typeof ctx.query.search === 'string' ? ctx.query.search.slice(0, 128) : '';
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (search) { conditions.push('(u.username LIKE ? OR u.display_name LIKE ?)'); values.push(`%${search}%`, `%${search}%`); }
    if (ctx.query.role) {
      if (!['admin', 'user'].includes(String(ctx.query.role))) ctx.throw(400, '无效的角色');
      conditions.push('u.role=?'); values.push(ctx.query.role);
    }
    if (ctx.query.status) {
      if (!['active', 'disabled', 'deleted'].includes(String(ctx.query.status))) ctx.throw(400, '无效的状态');
      conditions.push('u.status=?'); values.push(ctx.query.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM users u ${where}`).get(...values) as { total: number };
    const records = db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM accounts WHERE owner_user_id=u.id) AS account_count,
      (SELECT COUNT(*) FROM proxies WHERE owner_user_id=u.id) AS proxy_count,
      (SELECT COUNT(*) FROM tags WHERE owner_user_id=u.id) AS tag_count
      FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as UserRecord[];
    success(ctx, { list: records.map(publicUser), total, page, pageSize });
  }

  async create(ctx: Context) {
    assertAdmin(ctx);
    const body = ctx.request.body as Record<string, unknown> || {};
    if (Object.keys(body).some(key => !['username', 'display_name', 'role', 'password'].includes(key))) ctx.throw(400, '创建请求包含不允许的字段');
    const username = validateUsername(body.username);
    const display_name = validateDisplayName(body.display_name, username);
    const role = body.role === undefined ? 'user' : body.role;
    if (role !== 'admin' && role !== 'user') ctx.throw(400, '无效的角色');
    validatePassword(body.password);
    const password_hash = await hashPassword(body.password);
    const created = db.transaction(() => {
      const actor = assertAdmin(ctx);
      const user = userModel.create({ username, display_name, password_hash, role, source: 'admin', must_change_password: true });
      recordAudit(actor.id, 'user.create', 'user', user.id, ctx.ip);
      return publicUser(user);
    }).immediate();
    success(ctx, created);
  }

  async update(ctx: Context) {
    const body = ctx.request.body as Record<string, unknown> || {};
    if (Object.keys(body).some(key => !['display_name', 'role', 'status'].includes(key))) ctx.throw(400, '只允许修改显示名称、角色和启用状态');
    const updated = db.transaction(() => {
      const actor = assertAdmin(ctx);
      const target = targetUser(ctx);
      const displayName = 'display_name' in body ? validateDisplayName(body.display_name, target.username) : target.display_name;
      const role = body.role ?? target.role;
      const status = body.status ?? target.status;
      if (role !== 'admin' && role !== 'user') ctx.throw(400, '无效的角色');
      if (status !== 'active' && status !== 'disabled') ctx.throw(400, '无效的状态');
      if (actor.id === target.id && status !== 'active') ctx.throw(409, '不能停用自己的账号');
      protectLastAdmin(ctx, target, role, status);
      db.prepare('UPDATE users SET display_name=?,role=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(displayName, role, status, target.id);
      if (role !== target.role || status !== target.status) revokeUserSessions(target.id);
      recordAudit(actor.id, 'user.update', 'user', target.id, ctx.ip);
      if (role !== target.role) recordAudit(actor.id, `user.role.${role}`, 'user', target.id, ctx.ip);
      if (status !== target.status) recordAudit(actor.id, `user.status.${status}`, 'user', target.id, ctx.ip);
      return publicUser(userModel.getById(target.id)!);
    }).immediate();
    success(ctx, updated);
  }

  async remove(ctx: Context) {
    db.transaction(() => {
      const actor = assertAdmin(ctx);
      const target = targetUser(ctx);
      if (actor.id === target.id) ctx.throw(409, '不能注销自己的账号');
      protectLastAdmin(ctx, target, target.role, 'deleted');
      const counts = userModel.resourceCounts(target.id);
      if (counts.account_count || counts.proxy_count || counts.tag_count) ctx.throw(409, '请先移交邮箱并清理该用户的标签和代理');
      db.prepare("UPDATE users SET status='deleted',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(target.id);
      revokeUserSessions(target.id);
      recordAudit(actor.id, 'user.delete', 'user', target.id, ctx.ip);
    }).immediate();
    success(ctx, null);
  }

  async resetPassword(ctx: Context) {
    assertAdmin(ctx);
    const body = ctx.request.body as Record<string, unknown> || {};
    validatePassword(body.password);
    const hash = await hashPassword(body.password);
    let isSelf = false;
    db.transaction(() => {
      const actor = assertAdmin(ctx);
      const target = targetUser(ctx);
      db.prepare('UPDATE users SET password_hash=?,must_change_password=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hash, target.id);
      revokeUserSessions(target.id);
      recordAudit(actor.id, 'user.reset_password', 'user', target.id, ctx.ip);
      isSelf = actor.id === target.id;
    }).immediate();
    if (isSelf) clearSessionCookie(ctx);
    success(ctx, null);
  }

  async revokeSessions(ctx: Context) {
    const actor = assertAdmin(ctx);
    const target = targetUser(ctx);
    revokeUserSessions(target.id);
    recordAudit(actor.id, 'user.revoke_sessions', 'user', target.id, ctx.ip);
    if (actor.id === target.id) clearSessionCookie(ctx);
    success(ctx, null);
  }
}
