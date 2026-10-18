import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

test('version nine adds API keys without changing accounts, short links, or access history', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION, validateDatabaseSchema } = await import('../src/database/migrations');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-api-key-migration-'));
  const dbPath = path.join(directory, 'app.db');
  const database = new Database(dbPath);
  try {
    await runMigrations(database, dbPath);
    database.exec(`DELETE FROM schema_migrations WHERE version>=9;
      DROP TABLE api_keys;
      INSERT INTO users(id,username,display_name,password_hash,role,source)
        VALUES(1,'api_migration_admin','管理员','unused','admin','admin');
      INSERT INTO accounts(id,email,client_id,refresh_token,owner_user_id,inventory_admin_id)
        VALUES(1,'api@migration.test','client','refresh',1,1);
      INSERT INTO account_share_links(id,account_id,token,owner_user_id,last_accessed_at)
        VALUES(17,1,'abcdefgh',1,1780000000000);`);
    const accounts = database.prepare('SELECT * FROM accounts').all();
    const links = database.prepare('SELECT * FROM account_share_links').all();
    await runMigrations(database, dbPath);
    assert.equal((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
    assert.deepEqual(database.prepare('SELECT * FROM accounts').all(), accounts);
    assert.deepEqual(database.prepare('SELECT * FROM account_share_links').all(), links);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    validateDatabaseSchema(database);
    const snapshots = fs.readdirSync(path.join(directory, 'migration-backups'));
    assert.equal(snapshots.length, 1);
    const old = new Database(path.join(directory, 'migration-backups', snapshots[0]), { readonly: true });
    try {
      assert.equal((old.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, 8);
      assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='api_keys'").get(), undefined);
      assert.deepEqual(old.prepare('SELECT * FROM account_share_links').all(), links);
    } finally { old.close(); }

    const insert = database.prepare('INSERT INTO api_keys(name,key_hash,prefix,created_by,scopes) VALUES(?,?,?,?,?)');
    insert.run('deployment', 'a'.repeat(64), 'xoyol_aaaa', 1, '["accounts:read"]');
    assert.throws(() => insert.run('duplicate', 'a'.repeat(64), 'xoyol_aaaa', 1, '[]'), /UNIQUE/);
    assert.throws(() => insert.run('orphan', 'b'.repeat(64), 'xoyol_bbbb', 9999, '[]'), /FOREIGN KEY/);
    const keys = database.prepare('SELECT * FROM api_keys').all();
    await runMigrations(database, dbPath);
    assert.deepEqual(database.prepare('SELECT * FROM api_keys').all(), keys);
    assert.equal(fs.readdirSync(path.join(directory, 'migration-backups')).length, 1);
    const backupPath = path.join(directory, 'backup.db');
    await database.backup(backupPath);
    const backup = new Database(backupPath, { readonly: true });
    try {
      validateDatabaseSchema(backup);
      assert.deepEqual(backup.prepare('SELECT * FROM api_keys').all(), keys);
    } finally { backup.close(); }
    database.exec('DROP TABLE api_keys');
    await assert.rejects(runMigrations(database, dbPath), /api_keys/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
