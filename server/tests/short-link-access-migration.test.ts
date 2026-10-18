import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

test('version eight upgrades existing short links without changing URLs and persists access metadata in backups', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION, validateDatabaseSchema } = await import('../src/database/migrations');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-link-access-migration-'));
  const dbPath = path.join(directory, 'app.db');
  const database = new Database(dbPath);
  try {
    await runMigrations(database, dbPath);
    database.exec(`DELETE FROM schema_migrations WHERE version>=8;
      DROP TABLE api_keys;
      ALTER TABLE account_share_links DROP COLUMN last_accessed_at;
      INSERT INTO users(id,username,display_name,password_hash,role,source)
        VALUES(1,'access_admin','管理员','unused','admin','admin');
      INSERT INTO accounts(id,email,client_id,refresh_token,owner_user_id,inventory_admin_id)
        VALUES(1,'access@migration.test','client','token',1,1),
              (2,'expired@migration.test','client2','token2',1,1);
      INSERT INTO account_share_links(id,account_id,token,owner_user_id,created_at,expires_at)
        VALUES(17,1,'abcdefgh',1,'2026-01-01 01:02:03',NULL),
              (18,2,'abcdefgh12345678',1,'2026-02-02 02:03:04',1);`);
    const before = database.prepare('SELECT * FROM account_share_links ORDER BY id').all() as Record<string, unknown>[];
    await runMigrations(database, dbPath);
    assert.deepEqual(database.prepare('SELECT * FROM account_share_links ORDER BY id').all(), before.map(row => ({ ...row, last_accessed_at: null })));
    assert.equal((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
    validateDatabaseSchema(database);
    const snapshots = fs.readdirSync(path.join(directory, 'migration-backups'));
    assert.equal(snapshots.length, 1, 'the v7 database is snapshotted before upgrade');
    const old = new Database(path.join(directory, 'migration-backups', snapshots[0]), { readonly: true });
    try {
      assert.equal((old.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, 7);
      assert.equal((old.prepare('PRAGMA table_info(account_share_links)').all() as any[]).some(column => column.name === 'last_accessed_at'), false);
      assert.deepEqual(old.prepare('SELECT * FROM account_share_links ORDER BY id').all(), before);
    } finally { old.close(); }

    const visited = Date.now();
    database.prepare('UPDATE account_share_links SET last_accessed_at=? WHERE id=17').run(visited);
    const links = database.prepare('SELECT * FROM account_share_links ORDER BY id').all();
    await runMigrations(database, dbPath);
    assert.deepEqual(database.prepare('SELECT * FROM account_share_links ORDER BY id').all(), links);
    assert.equal(fs.readdirSync(path.join(directory, 'migration-backups')).length, 1);
    const backupPath = path.join(directory, 'current-backup.db');
    await database.backup(backupPath);
    const backup = new Database(backupPath);
    try {
      await runMigrations(backup, backupPath);
      validateDatabaseSchema(backup);
      assert.deepEqual(backup.prepare('SELECT * FROM account_share_links ORDER BY id').all(), links);
    } finally { backup.close(); }
    database.exec('ALTER TABLE account_share_links DROP COLUMN last_accessed_at');
    await assert.rejects(runMigrations(database, dbPath), /account_share_links.*last_accessed_at/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
