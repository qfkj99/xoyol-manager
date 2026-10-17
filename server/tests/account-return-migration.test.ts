import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

test('version six records historical administrator ownership without guessing user account origins', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION, validateDatabaseSchema } = await import('../src/database/migrations');
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    await runMigrations(database, ':memory:');
    database.exec(`DELETE FROM schema_migrations WHERE version>=6;
      DELETE FROM settings WHERE key='short_link_length';
      DROP TABLE account_share_links;
      CREATE TABLE account_share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE CHECK(length(token)=22),owner_user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE);
      ALTER TABLE accounts DROP COLUMN inventory_admin_id;
      INSERT INTO users(id,username,display_name,password_hash,role,source,status) VALUES
        (1,'first_admin','管理员一','not-used','admin','admin','active'),
        (2,'stock_admin','管理员二','not-used','admin','admin','active'),
        (3,'old_user','用户','not-used','user','self','active'),
        (4,'disabled_admin','停用管理员','not-used','admin','admin','disabled');
      INSERT INTO accounts(email,client_id,refresh_token,owner_user_id) VALUES
        ('first@example.test','client','refresh',1),
        ('stock@example.test','client','refresh',2),
        ('user@example.test','client','refresh',3),
        ('unassigned@example.test','client','refresh',NULL),
        ('disabled@example.test','client','refresh',4);`);
    const before = database.prepare('SELECT * FROM accounts ORDER BY id').all() as Record<string, unknown>[];
    await runMigrations(database, ':memory:');
    const after = database.prepare('SELECT * FROM accounts ORDER BY id').all() as Record<string, unknown>[];
    assert.deepEqual(after.map(row => row.inventory_admin_id), [1, 2, null, null, 4]);
    for (const [i, row] of after.entries()) {
      const { inventory_admin_id: _, ...originalFields } = row;
      assert.deepEqual(originalFields, before[i]);
    }
    await runMigrations(database, ':memory:');
    assert.deepEqual(database.prepare('SELECT * FROM accounts ORDER BY id').all(), after);
    assert.equal((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
    assert.throws(() => database.prepare('UPDATE accounts SET inventory_admin_id=? WHERE id=1').run(999999), /FOREIGN KEY/);
    validateDatabaseSchema(database);
    database.exec('ALTER TABLE accounts DROP COLUMN inventory_admin_id');
    assert.throws(() => validateDatabaseSchema(database), /inventory_admin_id/);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally { database.close(); }
});
