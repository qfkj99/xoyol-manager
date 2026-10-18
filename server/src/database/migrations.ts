import defaultDb from './index';
import { Database } from 'better-sqlite3';
import { config } from '../config';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { validateDatabaseSchema } from './schema';
export { validateDatabaseSchema } from './schema';

export const SCHEMA_VERSION = 9;

/** A consistent SQLite snapshot precedes an atomic, versioned upgrade. */
export async function runMigrations(db: Database = defaultDb, dbPath = config.dbPath) {
  let currentVersion = 0;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (exists) {
    const latest = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((latest.version || 0) > SCHEMA_VERSION) throw new Error('数据库版本高于当前程序，请使用对应版本恢复');
    if (latest.version === SCHEMA_VERSION) {
      validateDatabaseSchema(db);
      return;
    }
    currentVersion = latest.version || 0;
  }
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  if (hasData && dbPath !== ':memory:') {
    const backupDir = path.join(path.dirname(dbPath), 'migration-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await db.backup(path.join(backupDir, `before-users-${stamp}-${randomUUID()}.db`));
  }
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, password TEXT DEFAULT '',
          client_id TEXT NOT NULL, refresh_token TEXT NOT NULL,
          status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','error')),
          last_synced_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
        CREATE TABLE IF NOT EXISTS proxies (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL CHECK(type IN ('socks5','http')), host TEXT NOT NULL, port INTEGER NOT NULL,
          username TEXT DEFAULT '', password TEXT DEFAULT '', is_default INTEGER DEFAULT 0,
          last_tested_at DATETIME, last_test_ip TEXT DEFAULT '',
          status TEXT DEFAULT 'untested' CHECK(status IN ('untested','active','failed')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS mail_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
          mailbox TEXT NOT NULL DEFAULT 'INBOX' CHECK(mailbox IN ('INBOX','Junk')),
          mail_id TEXT DEFAULT '', sender TEXT DEFAULT '', sender_name TEXT DEFAULT '', subject TEXT DEFAULT '',
          text_content TEXT DEFAULT '', html_content TEXT DEFAULT '', mail_date DATETIME,
          is_read INTEGER DEFAULT 0, cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mail_cache_account ON mail_cache(account_id, mailbox);
        CREATE INDEX IF NOT EXISTS idx_mail_cache_date ON mail_cache(mail_date DESC);
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL DEFAULT '#3B82F6', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS account_tags (
          account_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(account_id, tag_id),
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','deleted')),
          must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
          source TEXT NOT NULL CHECK(source IN ('self','admin')),
          last_login_at DATETIME, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
          token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key,value) VALUES ('registration_enabled','true');
        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL,
          target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL DEFAULT 'success', ip TEXT NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(actor_id) REFERENCES users(id)
        );
        CREATE INDEX idx_audit_created ON audit_logs(id DESC);
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      `);
      const columns = db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
      if (!columns.some(c => c.name === 'token_refreshed_at')) db.exec('ALTER TABLE accounts ADD COLUMN token_refreshed_at DATETIME');
      if (!columns.some(c => c.name === 'remark')) db.exec("ALTER TABLE accounts ADD COLUMN remark TEXT DEFAULT ''");
      db.exec(`
        ALTER TABLE accounts ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
        ALTER TABLE proxies ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
        CREATE INDEX idx_accounts_owner ON accounts(owner_user_id);
        CREATE INDEX idx_proxies_owner ON proxies(owner_user_id);
        CREATE UNIQUE INDEX idx_proxy_owner_default ON proxies(owner_user_id)
          WHERE is_default = 1 AND owner_user_id IS NOT NULL;
        CREATE TABLE tags_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#3B82F6', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          UNIQUE(owner_user_id,name)
        );
        INSERT INTO tags_new (id,name,color,created_at) SELECT id,name,color,created_at FROM tags;
        CREATE TABLE account_tags_new (
          account_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY(account_id,tag_id),
          FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY(tag_id) REFERENCES tags_new(id) ON DELETE CASCADE
        );
        INSERT INTO account_tags_new SELECT account_id,tag_id FROM account_tags;
        DROP TABLE account_tags;
        DROP TABLE tags;
        ALTER TABLE tags_new RENAME TO tags;
        ALTER TABLE account_tags_new RENAME TO account_tags;
        CREATE INDEX idx_tags_owner ON tags(owner_user_id);
      `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
      }
      if (currentVersion < 2) {
        const duplicate = db.prepare(`SELECT GROUP_CONCAT(id) AS ids FROM accounts
          GROUP BY lower(trim(email)) HAVING COUNT(*) > 1 LIMIT 1`).get() as { ids: string } | undefined;
        if (duplicate) throw new Error(`历史邮箱忽略大小写和首尾空格后存在重复，请先在旧版本合并再升级（邮箱 ID：${duplicate.ids}）；迁移已回滚`);
        db.exec(`UPDATE accounts SET email=lower(trim(email));
          CREATE UNIQUE INDEX idx_accounts_email_normalized ON accounts(lower(email));`);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
      }
      if (currentVersion < 3) {
        db.exec(`
          ALTER TABLE accounts ADD COLUMN game_account TEXT NOT NULL DEFAULT '';
          ALTER TABLE accounts ADD COLUMN game_password TEXT NOT NULL DEFAULT '';
          ALTER TABLE accounts ADD COLUMN real_name TEXT NOT NULL DEFAULT '';
          ALTER TABLE accounts ADD COLUMN id_last_six TEXT NOT NULL DEFAULT '';
          ALTER TABLE accounts ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'assigned' CHECK(claim_status IN ('assigned','available'));
          ALTER TABLE accounts ADD COLUMN claim_code_hash TEXT;
          ALTER TABLE accounts ADD COLUMN claim_code_expires_at INTEGER;
          ALTER TABLE accounts ADD COLUMN claimed_at DATETIME;
          CREATE UNIQUE INDEX idx_accounts_game_normalized ON accounts(lower(game_account)) WHERE game_account <> '';
          CREATE UNIQUE INDEX idx_accounts_claim_code ON accounts(claim_code_hash) WHERE claim_code_hash IS NOT NULL;
          CREATE INDEX idx_accounts_claim_status ON accounts(claim_status);
        `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();
      }
      if (currentVersion < 4) {
        db.exec(`
          CREATE TABLE account_share_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL UNIQUE,
            token TEXT NOT NULL UNIQUE CHECK(length(token) = 22),
            owner_user_id INTEGER NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at INTEGER,
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run();
      }
      if (currentVersion < 5) {
        db.exec(`
          ALTER TABLE accounts ADD COLUMN admin_imported INTEGER NOT NULL DEFAULT 0 CHECK(admin_imported IN (0,1));
          UPDATE accounts SET admin_imported=1 WHERE owner_user_id IN (SELECT id FROM users WHERE role='admin')
            AND game_account<>'' AND game_password<>'' AND real_name<>'' AND id_last_six<>'';
        `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (5)').run();
      }
      if (currentVersion < 6) {
        db.exec(`
          ALTER TABLE accounts ADD COLUMN inventory_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
          UPDATE accounts SET inventory_admin_id=owner_user_id
            WHERE owner_user_id IN (SELECT id FROM users WHERE role='admin');
        `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (6)').run();
      }
      if (currentVersion < 7) {
        const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='account_share_links'").get() as { seq: number } | undefined;
        db.exec(`
          CREATE TABLE account_share_links_v7 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL UNIQUE,
            token TEXT NOT NULL UNIQUE CHECK(length(token) BETWEEN 8 AND 64),
            owner_user_id INTEGER NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at INTEGER,
            FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          INSERT INTO account_share_links_v7(id,account_id,token,owner_user_id,created_at,expires_at)
            SELECT id,account_id,token,owner_user_id,created_at,expires_at FROM account_share_links;
          DROP TABLE account_share_links;
          ALTER TABLE account_share_links_v7 RENAME TO account_share_links;
          INSERT OR IGNORE INTO settings(key,value) VALUES('short_link_length','22');
        `);
        if (sequence) {
          const updated = db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='account_share_links'").run(sequence.seq);
          if (!updated.changes) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('account_share_links', sequence.seq);
        }
        db.prepare('INSERT INTO schema_migrations (version) VALUES (7)').run();
      }
      if (currentVersion < 8) {
        db.exec('ALTER TABLE account_share_links ADD COLUMN last_accessed_at INTEGER');
        db.prepare('INSERT INTO schema_migrations (version) VALUES (8)').run();
      }
      if (currentVersion < 9) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            prefix TEXT NOT NULL,
            created_by INTEGER NOT NULL,
            scopes TEXT NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            last_used_at INTEGER,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_api_keys_creator ON api_keys(created_by);
        `);
        db.prepare('INSERT INTO schema_migrations (version) VALUES (9)').run();
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('数据库外键校验失败，升级已回滚');
      validateDatabaseSchema(db);
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
