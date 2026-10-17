import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports below ensure tests never open the configured deployment database.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';

test('authentication, user administration, and legacy migration', async t => {
  const { default: db } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { default: Koa } = await import('koa');
  const { default: Router } = await import('koa-router');
  const { default: bodyParser } = await import('koa-bodyparser');
  const { authMiddleware } = await import('../src/middlewares/auth');
  const { errorHandler } = await import('../src/middlewares/errorHandler');
  const { default: logger } = await import('../src/utils/logger');
  logger.silent = true;
  const { authRoutes } = await import('../src/routes/auth');
  const { userRoutes } = await import('../src/routes/users');
  const { settingsRoutes } = await import('../src/routes/settings');

  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,password TEXT DEFAULT '',
      client_id TEXT NOT NULL,refresh_token TEXT NOT NULL,status TEXT DEFAULT 'active',last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#123456',created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE account_tags(account_id INTEGER,tag_id INTEGER,PRIMARY KEY(account_id,tag_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id),FOREIGN KEY(tag_id) REFERENCES tags(id));
    INSERT INTO accounts(email,client_id,refresh_token) VALUES('legacy@example.test','client','refresh');
    INSERT INTO tags(name) VALUES('legacy'); INSERT INTO account_tags VALUES(1,1);
  `);
  await runMigrations();
  await runMigrations();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM account_tags').get() as { count: number }).count, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=1').get() as { owner_user_id: null }).owner_user_id, null);

  const router = new Router({ prefix: '/api' });
  router.use('/auth', authRoutes.routes());
  router.use('/users', userRoutes.routes());
  router.use('/settings', settingsRoutes.routes());
  const app = new Koa();
  app.use(errorHandler); app.use(bodyParser()); app.use(authMiddleware); app.use(router.routes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function call(b: Browser, method: string, url: string, body?: unknown, csrf = true, origin?: string) {
    const headers: Record<string, string> = { Cookie: Array.from(b.cookies, ([key, value]) => `${key}=${value}`).join('; ') };
    if (csrf && b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const cookie of response.headers.getSetCookie()) {
      const part = cookie.split(';')[0], split = part.indexOf('=');
      b.cookies.set(part.slice(0, split), part.slice(split + 1));
    }
    const payload = await response.json() as any;
    if (payload.data?.csrfToken) b.csrf = payload.data.csrfToken;
    return { status: response.status, headers: response.headers, ...payload };
  }
  const admin = browser(), alice = browser();
  let adminId = 0, aliceId = 0;
  try {
    await t.test('initialization gate and anonymous CSRF', async () => {
      const config = await call(alice, 'GET', '/auth/config');
      assert.equal(config.data.initialized, false);
      assert.equal(config.data.registration_enabled, false);
      assert.match(config.headers.get('set-cookie') || '', /httponly/i);
      assert.equal((await call(alice, 'POST', '/auth/register', { username: 'early', password: 'early-pass-1234' }, false)).status, 403);
      assert.equal((await call(alice, 'POST', '/auth/register', { username: 'early', password: 'early-pass-1234' })).status, 503);
      const first = userModel.create({ username: 'admin', display_name: 'Admin', password_hash: await hashPassword('admin-pass-1234'), role: 'admin', source: 'admin', must_change_password: false });
      adminId = first.id;
    });
    await t.test('self registration, privilege rejection, and cookie sessions', async () => {
      assert.equal((await call(alice, 'POST', '/auth/register', { username: 'alice', password: 'alice-pass-1234', role: 'admin' })).status, 400);
      const registered = await call(alice, 'POST', '/auth/register', { username: 'Alice', password: 'alice-pass-1234' });
      assert.equal(registered.status, 200);
      assert.equal(registered.data.user.username, 'alice');
      assert.equal(registered.data.user.must_change_password, false);
      assert.equal(registered.data.user.source, 'self');
      assert.equal('password_hash' in registered.data.user, false);
      aliceId = registered.data.user.id;
      assert.equal((await call(alice, 'GET', '/users')).status, 403);
      const session = db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(aliceId) as { token_hash: string };
      assert.notEqual(session.token_hash, alice.cookies.get('xoyol_session'));
      await call(admin, 'GET', '/auth/config');
      assert.equal((await call(admin, 'POST', '/auth/login', { username: 'ADMIN', password: 'admin-pass-1234', remember: true })).status, 200);
      const expiry = db.prepare('SELECT expires_at FROM sessions WHERE user_id=?').get(adminId) as { expires_at: number };
      assert.ok(expiry.expires_at > Date.now() + 6 * 86_400_000);
    });
    await t.test('administrator invariants, uniqueness, and registration setting', async () => {
      assert.equal((await call(admin, 'PATCH', `/users/${adminId}`, { role: 'user' })).status, 409);
      assert.equal((await call(admin, 'PATCH', `/users/${adminId}`, { status: 'disabled' })).status, 409);
      assert.equal((await call(admin, 'POST', '/users', { username: 'ALICE', password: 'other-pass-1234' })).status, 409);
      assert.equal((await call(admin, 'PATCH', '/settings', { registration_enabled: false }, false)).status, 403);
      assert.equal((await call(admin, 'PATCH', '/settings', { registration_enabled: false }, true, 'https://attacker.invalid')).status, 403);
      assert.equal((await call(admin, 'PATCH', '/settings', { registration_enabled: false })).status, 200);
      const fresh = browser(); await call(fresh, 'GET', '/auth/config');
      assert.equal((await call(fresh, 'POST', '/auth/register', { username: 'closed', password: 'closed-pass-1234' })).status, 403);
    });
    await t.test('temporary passwords force a change and revoke all sessions', async () => {
      const created = await call(admin, 'POST', '/users', { username: 'bob', password: 'bob-pass-1234' });
      assert.equal(created.status, 200); assert.equal(created.data.must_change_password, true);
      const bob = browser(); await call(bob, 'GET', '/auth/config');
      assert.equal((await call(bob, 'POST', '/auth/login', { username: 'bob', password: 'bob-pass-1234' })).status, 200);
      assert.equal((await call(bob, 'GET', '/settings')).data.reason, 'PASSWORD_CHANGE_REQUIRED');
      assert.equal((await call(bob, 'PUT', '/auth/password', { current_password: 'bob-pass-1234', new_password: 'bob-next-pass-1234' })).status, 200);
      assert.equal((await call(bob, 'GET', '/auth/me')).status, 401);
    });
    await t.test('resource deletion constraints, disabling, and logout', async () => {
      db.prepare('UPDATE accounts SET owner_user_id=? WHERE id=1').run(aliceId);
      assert.equal((await call(admin, 'DELETE', `/users/${aliceId}`)).status, 409);
      assert.equal((await call(admin, 'PATCH', `/users/${aliceId}`, { status: 'disabled' })).status, 200);
      assert.equal((await call(alice, 'GET', '/auth/me')).status, 401);
      assert.equal((await call(admin, 'POST', '/auth/logout')).status, 200);
      assert.equal((await call(admin, 'GET', '/auth/me')).status, 401);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

test('email migration rejects canonical collisions atomically and enforces global uniqueness', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations } = await import('../src/database/migrations');
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY,email TEXT NOT NULL,password TEXT,
      client_id TEXT NOT NULL,refresh_token TEXT NOT NULL);
      INSERT INTO accounts VALUES(1,'Alice@Example.test','','client','refresh');
      INSERT INTO accounts VALUES(2,' alice@example.test ','','client','refresh');`);
    await assert.rejects(runMigrations(legacy, ':memory:'), /历史邮箱.*重复.*迁移已回滚/);
    assert.equal(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='users'").get(), undefined);
    assert.equal(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    assert.equal((legacy.prepare('SELECT email FROM accounts WHERE id=2').get() as { email: string }).email, ' alice@example.test ');
    assert.equal(legacy.pragma('foreign_keys', { simple: true }), 1);
  } finally { legacy.close(); }

  const versionOne = new Database(':memory:');
  try {
    await runMigrations(versionOne, ':memory:');
    versionOne.exec(`DELETE FROM schema_migrations WHERE version>=2;
      DELETE FROM settings WHERE key='short_link_length';
      DROP TABLE account_share_links;
      DROP INDEX idx_accounts_game_normalized;
      DROP INDEX idx_accounts_claim_code;
      DROP INDEX idx_accounts_claim_status;
      DROP INDEX idx_accounts_email_normalized;
      INSERT INTO accounts(email,client_id,refresh_token) VALUES('Alice@Example.test','client','refresh');
      INSERT INTO accounts(email,client_id,refresh_token) VALUES('alice@example.test','client','refresh');`);
    for (const column of ['game_account', 'game_password', 'real_name', 'id_last_six', 'claim_status', 'claim_code_hash', 'claim_code_expires_at', 'claimed_at', 'admin_imported', 'inventory_admin_id']) {
      versionOne.exec(`ALTER TABLE accounts DROP COLUMN ${column}`);
    }
    await assert.rejects(runMigrations(versionOne, ':memory:'), /历史邮箱.*重复/);
    assert.equal((versionOne.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 1);
    versionOne.exec('DELETE FROM accounts WHERE id=2');
    await runMigrations(versionOne, ':memory:');
    assert.equal((versionOne.prepare('SELECT email FROM accounts WHERE id=1').get() as { email: string }).email, 'alice@example.test');
    assert.throws(() => versionOne.prepare('INSERT INTO accounts(email,client_id,refresh_token) VALUES(?,?,?)').run('ALICE@EXAMPLE.TEST', 'client', 'refresh'), /UNIQUE constraint failed/);
  } finally { versionOne.close(); }
});

test('claimed latest migration versions still require real schema and constraints', async t => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION, validateDatabaseSchema } = await import('../src/database/migrations');
  const forged = new Database(':memory:');
  try {
    forged.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at DATETIME);
      INSERT INTO schema_migrations(version) VALUES(${SCHEMA_VERSION});`);
    await assert.rejects(runMigrations(forged, ':memory:'), /数据库结构校验失败.*accounts/);
  } finally { forged.close(); }

  const cases = [
    { name: 'missing authentication column', mutation: 'ALTER TABLE users RENAME COLUMN password_hash TO missing_password', expected: /users.*password_hash/ },
    { name: 'nonunique email index under the correct name', mutation: 'DROP INDEX idx_accounts_email_normalized; CREATE INDEX idx_accounts_email_normalized ON accounts(lower(email))', expected: /邮箱唯一索引/ },
    { name: 'default proxy uniqueness weakened by a partial predicate', mutation: 'DROP INDEX idx_proxy_owner_default; CREATE UNIQUE INDEX idx_proxy_owner_default ON proxies(owner_user_id) WHERE is_default=1 AND owner_user_id IS NOT NULL AND id>0', expected: /唯一默认代理索引/ },
    { name: 'session table with all columns but no foreign key', mutation: `DROP TABLE sessions;
      CREATE TABLE sessions(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,token_hash TEXT UNIQUE NOT NULL,
        csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at DATETIME);`, expected: /sessions.user_id.*外键/ },
    { name: 'short-link token without uniqueness', mutation: `DROP TABLE account_share_links;
      CREATE TABLE account_share_links(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL UNIQUE,
        token TEXT NOT NULL CHECK(length(token) BETWEEN 8 AND 64),owner_user_id INTEGER NOT NULL,created_at DATETIME,expires_at INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE);`, expected: /account_share_links.*唯一约束.*token/ },
    { name: 'short-link account relationship without cascading deletion', mutation: `DROP TABLE account_share_links;
      CREATE TABLE account_share_links(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE CHECK(length(token) BETWEEN 8 AND 64),owner_user_id INTEGER NOT NULL,created_at DATETIME,expires_at INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id),
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE);`, expected: /account_share_links.account_id.*外键/ },
  ];
  for (const example of cases) {
    await t.test(example.name, async () => {
      const candidate = new Database(':memory:');
      try {
        await runMigrations(candidate, ':memory:');
        validateDatabaseSchema(candidate);
        candidate.exec(example.mutation);
        await assert.rejects(runMigrations(candidate, ':memory:'), example.expected);
      } finally { candidate.close(); }
    });
  }
  await t.test('session deletion trigger cannot invalidate checked administrators', async () => {
    const candidate = new Database(':memory:');
    try {
      await runMigrations(candidate, ':memory:');
      candidate.exec(`INSERT INTO users(username,display_name,password_hash,role,status,source)
        VALUES('restore_admin','Admin','placeholder','admin','active','admin');
        INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at)
        VALUES(1,'placeholder','placeholder',9999999999999);
        CREATE TRIGGER disable_admin AFTER DELETE ON sessions BEGIN
          UPDATE users SET status='disabled';
        END;`);
      await assert.rejects(runMigrations(candidate, ':memory:'), /不允许包含触发器/);
      assert.equal((candidate.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND status='active'").get() as { count: number }).count, 1);
      assert.equal((candidate.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 1);
    } finally { candidate.close(); }
  });
});
