import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

const versionSixShareTable = `CREATE TABLE account_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE CHECK(length(token)=22),
  owner_user_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at INTEGER,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

test('version seven supports configurable token lengths without changing delivered links', async t => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION, validateDatabaseSchema } = await import('../src/database/migrations');
  const database = new Database(':memory:');
  try {
    await runMigrations(database, ':memory:');
    database.exec(`DELETE FROM schema_migrations WHERE version>=7;
      DROP TABLE api_keys;
      DELETE FROM settings WHERE key='short_link_length';
      DROP TABLE account_share_links;
      ${versionSixShareTable};
      INSERT INTO users(id,username,display_name,password_hash,role,source) VALUES
        (1,'length_admin','管理员','unused','admin','admin'),
        (2,'length_user','用户','unused','user','self'),
        (3,'length_share_owner','短链持有人','unused','user','self');`);
    const insertAccount = database.prepare('INSERT INTO accounts(id,email,client_id,refresh_token,owner_user_id,inventory_admin_id) VALUES(?,?,?,?,?,?)');
    for (let id = 1; id <= 10; id++) insertAccount.run(id, `length-${id}@migration.test`, `client-${id}`, `token-${id}`, id === 2 ? 2 : null, id === 2 ? 1 : null);
    database.prepare("INSERT INTO mail_cache(account_id,mailbox,mail_id,text_content) VALUES(2,'Junk','before-length-migration','验证码 123456')").run();
    const insert = database.prepare('INSERT INTO account_share_links(id,account_id,token,owner_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?)');
    insert.run(5, 1, 'A'.repeat(22), 1, '2026-01-01 01:02:03', Date.now() + 604800000);
    insert.run(9, 2, 'B'.repeat(22), 2, '2026-02-02 02:03:04', Date.now() - 100000);
    insert.run(12, 3, 'C'.repeat(22), 1, '2026-03-03 03:04:05', null);
    insert.run(31, 4, 'D'.repeat(22), 1, '2026-04-04 04:05:06', null);
    database.prepare('DELETE FROM account_share_links WHERE id=31').run();
    const originalLinks = database.prepare('SELECT * FROM account_share_links ORDER BY id').all() as Record<string, unknown>[];
    const originalAccounts = database.prepare('SELECT * FROM accounts ORDER BY id').all();
    const originalMail = database.prepare('SELECT * FROM mail_cache ORDER BY id').all();
    assert.throws(() => database.prepare('INSERT INTO account_share_links(account_id,token,owner_user_id) VALUES(4,?,1)').run('E'.repeat(8)), /CHECK/);

    await t.test('v6 migration retains valid, expired, and permanent links and all related data', async () => {
      await runMigrations(database, ':memory:');
      assert.deepEqual(database.prepare('SELECT * FROM account_share_links ORDER BY id').all(), originalLinks.map(row => ({ ...row, last_accessed_at: null })));
      assert.deepEqual(database.prepare('SELECT * FROM accounts ORDER BY id').all(), originalAccounts);
      assert.deepEqual(database.prepare('SELECT * FROM mail_cache ORDER BY id').all(), originalMail);
      assert.equal((database.prepare("SELECT value FROM settings WHERE key='short_link_length'").get() as any).value, '22');
      assert.equal((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
      assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(database.pragma('foreign_key_check'), []);
      validateDatabaseSchema(database);
    });

    await t.test('8 and 64 character tokens work while 7 and 65 character tokens fail', () => {
      const statement = database.prepare('INSERT INTO account_share_links(account_id,token,owner_user_id) VALUES(?,?,1)');
      const short = statement.run(4, 'E'.repeat(8));
      assert.equal(Number(short.lastInsertRowid), 32, 'rebuilding preserves the original AUTOINCREMENT high water mark');
      statement.run(5, 'F'.repeat(64));
      assert.throws(() => statement.run(6, 'G'.repeat(7)), /CHECK/);
      assert.throws(() => statement.run(6, 'H'.repeat(65)), /CHECK/);
      assert.equal((database.prepare('SELECT COUNT(*) AS c FROM account_share_links').get() as any).c, 5);
    });

    await t.test('unique account and token constraints and both cascading foreign keys remain enforced', () => {
      const statement = database.prepare('INSERT INTO account_share_links(account_id,token,owner_user_id) VALUES(?,?,?)');
      assert.throws(() => statement.run(6, 'A'.repeat(22), 1), /UNIQUE/);
      assert.throws(() => statement.run(1, 'I'.repeat(8), 1), /UNIQUE/);
      assert.throws(() => statement.run(999999, 'J'.repeat(8), 1), /FOREIGN KEY/);
      assert.throws(() => statement.run(6, 'K'.repeat(8), 999999), /FOREIGN KEY/);
      database.prepare('DELETE FROM accounts WHERE id=4').run();
      assert.equal(database.prepare('SELECT id FROM account_share_links WHERE account_id=4').get(), undefined);
      statement.run(6, 'L'.repeat(8), 3);
      database.prepare('DELETE FROM users WHERE id=3').run();
      assert.equal(database.prepare('SELECT id FROM account_share_links WHERE account_id=6').get(), undefined);
      assert.ok(database.prepare('SELECT id FROM accounts WHERE id=6').get());
      assert.deepEqual(database.pragma('foreign_key_check'), []);
      validateDatabaseSchema(database);
    });

    await t.test('repeated startup preserves changed settings, migration history, and all current links', async () => {
      database.prepare("UPDATE settings SET value='8' WHERE key='short_link_length'").run();
      const beforeLinks = database.prepare('SELECT * FROM account_share_links ORDER BY id').all();
      const beforeVersions = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
      await runMigrations(database, ':memory:');
      await runMigrations(database, ':memory:');
      assert.deepEqual(database.prepare('SELECT * FROM account_share_links ORDER BY id').all(), beforeLinks);
      assert.deepEqual(database.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), beforeVersions);
      assert.equal((database.prepare("SELECT value FROM settings WHERE key='short_link_length'").get() as any).value, '8');
    });

    await t.test('a current database backup retains the widened constraint and validates directly', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-link-length-backup-'));
      const backupPath = path.join(directory, 'backup.db');
      try {
        await database.backup(backupPath);
        const backup = new Database(backupPath, { readonly: true });
        try {
          validateDatabaseSchema(backup);
          assert.deepEqual(backup.prepare('SELECT * FROM account_share_links ORDER BY id').all(), database.prepare('SELECT * FROM account_share_links ORDER BY id').all());
          assert.equal((backup.prepare("SELECT value FROM settings WHERE key='short_link_length'").get() as any).value, '8');
        } finally { backup.close(); }
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
  } finally { database.close(); }
});

test('v7 initialization preserves preexisting configured lengths and can rebuild an empty historical table', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, validateDatabaseSchema } = await import('../src/database/migrations');
  const database = new Database(':memory:');
  try {
    await runMigrations(database, ':memory:');
    database.exec(`DELETE FROM schema_migrations WHERE version>=7;
      DROP TABLE api_keys;
      UPDATE settings SET value='64' WHERE key='short_link_length';
      DROP TABLE account_share_links;
      ${versionSixShareTable};
      INSERT INTO users(id,username,display_name,password_hash,role,source)
        VALUES(1,'empty_table_admin','管理员','unused','admin','admin');
      INSERT INTO accounts(id,email,client_id,refresh_token) VALUES(1,'empty@migration.test','client','token');
      INSERT INTO account_share_links(id,account_id,token,owner_user_id) VALUES(99,1,'1234567890123456789012',1);
      DELETE FROM account_share_links;`);
    await runMigrations(database, ':memory:');
    assert.equal((database.prepare("SELECT value FROM settings WHERE key='short_link_length'").get() as any).value, '64');
    const created = database.prepare('INSERT INTO account_share_links(account_id,token,owner_user_id) VALUES(1,?,1)').run('Z'.repeat(64));
    assert.equal(Number(created.lastInsertRowid), 100);
    validateDatabaseSchema(database);
  } finally { database.close(); }
});

test('a claimed v7 schema with the old 22 character constraint is rejected', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, validateDatabaseSchema } = await import('../src/database/migrations');
  const database = new Database(':memory:');
  try {
    await runMigrations(database, ':memory:');
    database.exec(`DROP TABLE account_share_links; ${versionSixShareTable};
      ALTER TABLE account_share_links ADD COLUMN last_accessed_at INTEGER`);
    assert.throws(() => validateDatabaseSchema(database), /account_share_links.token.*长度约束/);
    await assert.rejects(runMigrations(database, ':memory:'), /account_share_links.token.*长度约束/);
  } finally { database.close(); }
});
