import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-import-claims-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('administrator deliveries and user imports claim existing inventory', async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { lockResources } = await import('../src/services/resourceAccess');
  logger.silent = true;
  await runMigrations();
  const password = 'inventory-platform-pass-1234';
  const administrator = userModel.create({ username: 'inventory_admin', display_name: '库存管理员', password_hash: await hashPassword(password), role: 'admin', source: 'admin', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function raw(b: Browser, method: string, route: string, body?: unknown) {
    const headers: Record<string, string> = { Cookie: [...b.cookies].map(([key, value]) => `${key}=${value}`).join('; '), Origin: origin };
    if (b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], separator = pair.indexOf('=');
      b.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  async function call(b: Browser, method: string, route: string, body?: unknown) {
    const response = await raw(b, method, route, body);
    const result = await response.json() as any;
    if (result.data?.csrfToken) b.csrf = result.data.csrfToken;
    return { status: response.status, ...result };
  }
  async function login(b: Browser, username: string) {
    await call(b, 'GET', '/auth/config');
    assert.equal((await call(b, 'POST', '/auth/login', { username, password })).status, 200);
  }
  const data = (label: string, extra: Record<string, string> = {}) => ({
    game_account: `inventory_${label}`, game_password: ` game-pass-${label} `,
    real_name: '交付姓名', id_last_six: '00123X', email: `${label}@inventory.test`,
    password: `mail-pass-${label}`, client_id: `client-${label}`, refresh_token: `refresh-${label}`, ...extra,
  });
  const line = (label: string, extra: Record<string, string> = {}) => Object.values(data(label, extra)).join('----');
  const admin = browser(), alice = browser(), bob = browser();
  const deliveries = new Map<string, any>();
  const deliveryLine = (label: string, extra: Record<string, string> = {}) => {
    const item = { ...deliveries.get(label), ...extra };
    return [item.game_account, item.game_password, item.real_name, item.id_last_six, origin + item.path].join('----');
  };
  const labels = ['delivery', 'full', 'wrong', 'expired', 'race', 'busy', 'backup'];
  let aliceId = 0, bobId = 0;
  try {
    await login(admin, administrator.username);
    for (const [b, username] of [[alice, 'inventory_alice'], [bob, 'inventory_bob']] as const) {
      await call(b, 'GET', '/auth/config');
      const result = await call(b, 'POST', '/auth/register', { username, password });
      assert.equal(result.status, 200, result.message);
      if (b === alice) aliceId = result.data.user.id; else bobId = result.data.user.id;
    }

    await t.test('batch import generates only successful deliveries with lasting independent links', async () => {
      const result = await call(admin, 'POST', '/accounts/import-confirm', {
        content: `${labels.map(label => line(label)).join('\n')}\ninvalid----row`, mode: 'skip', generate_share_links: true,
      });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, labels.length);
      assert.equal(result.data.errors.length, 1);
      assert.equal(result.data.share_exports.length, labels.length);
      for (const [index, label] of labels.entries()) {
        const exported = result.data.share_exports[index];
        deliveries.set(label, exported);
        assert.deepEqual(Object.keys(exported).sort(), ['game_account', 'game_password', 'real_name', 'id_last_six', 'path'].sort());
        assert.equal(exported.id_last_six, '00123X');
        assert.equal(exported.game_password, data(label).game_password);
        assert.match(exported.path, /^\/s\/[A-Za-z0-9_-]{22}$/);
        const account = db.prepare('SELECT * FROM accounts WHERE game_account=?').get(exported.game_account) as any;
        assert.equal(account.owner_user_id, administrator.id);
        assert.equal(account.admin_imported, 1);
        assert.equal(account.claim_status, 'available');
        assert.equal(account.claim_code_hash, null);
        assert.equal((db.prepare('SELECT expires_at FROM account_share_links WHERE account_id=?').get(account.id) as any).expires_at, null);
      }
      assert.equal(new Set(result.data.share_exports.map((item: any) => item.path)).size, labels.length);
      const shared = await call(browser(), 'GET', '/share/' + deliveries.get('delivery').path.split('/').pop());
      assert.equal(shared.status, 200);
      assert.equal(shared.data.password, data('delivery').password);
    });

    await t.test('skip never exports duplicates and overwrite preserves the delivered token', async () => {
      const skipped = await call(admin, 'POST', '/accounts/import-confirm', { content: line('delivery'), mode: 'skip', generate_share_links: true });
      assert.equal(skipped.status, 200, skipped.message);
      assert.equal(skipped.data.skipped, 1);
      assert.deepEqual(skipped.data.share_exports, []);
      const overwritten = await call(admin, 'POST', '/accounts/import-confirm', { content: line('delivery', { game_password: 'new-delivery-pass' }), mode: 'overwrite', generate_share_links: true });
      assert.equal(overwritten.status, 200, overwritten.message);
      assert.equal(overwritten.data.share_exports[0].path, deliveries.get('delivery').path);
      assert.equal(overwritten.data.share_exports[0].game_password, 'new-delivery-pass');
      deliveries.set('delivery', overwritten.data.share_exports[0]);
      const ordinary = await call(admin, 'POST', '/accounts/import', { content: line('unlinked') });
      assert.equal(ordinary.status, 200);
      assert.equal(ordinary.data.share_exports, undefined);
      assert.equal(db.prepare('SELECT l.id FROM account_share_links l JOIN accounts a ON a.id=l.account_id WHERE a.game_account=?').get(data('unlinked').game_account), undefined);
    });

    await t.test('users cannot create accounts or request administrator import options', async () => {
      assert.equal((await call(alice, 'POST', '/accounts', data('not-in-stock'))).status, 403);
      for (const option of [{ owner_user_id: aliceId }, { placement: 'owned' }, { generate_share_links: false }]) {
        assert.equal((await call(alice, 'POST', '/accounts/import-preview', { content: deliveryLine('delivery'), ...option })).status, 403);
      }
      assert.equal((await call(alice, 'POST', '/accounts/import-confirm', { content: deliveryLine('delivery'), mode: 'overwrite' })).status, 400);
      assert.equal((await call(admin, 'POST', '/accounts/import', { content: line('invalid-option'), generate_share_links: 'yes' })).status, 400);
    });

    await t.test('five-column preview validates supplied information without revealing mailbox credentials', async () => {
      const result = await call(alice, 'POST', '/accounts/import-preview', {
        content: `${deliveryLine('delivery')}\n${deliveryLine('wrong', { game_password: 'incorrect' })}\n${line('unknown')}`,
      });
      assert.equal(result.status, 200);
      assert.equal(result.data.newItems.length, 1);
      assert.equal(result.data.errors.length, 2);
      const text = JSON.stringify(result.data);
      assert.equal(text.includes(data('delivery').password), false);
      assert.equal(text.includes(data('delivery').refresh_token), false);
      assert.equal(text.includes(data('delivery').email), false);
      assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE game_account=?').get(data('delivery').game_account) as any).owner_user_id, administrator.id);
    });

    await t.test('five-column import preserves the delivered share and its lifetime while moving mail and ownership', async () => {
      const account = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('delivery').game_account) as any;
      db.prepare("INSERT INTO mail_cache(account_id,mailbox,mail_id,subject,text_content) VALUES(?,'INBOX','delivery-cache','验证码','验证码 001234')").run(account.id);
      const limited = await call(admin, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: 7 });
      assert.equal(limited.status, 200, limited.message);
      deliveries.set('delivery', { ...deliveries.get('delivery'), path: limited.data.path });
      const before = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id) as any;
      const original = deliveryLine('delivery');
      const result = await call(alice, 'POST', '/accounts/import', { content: original });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, 1);
      const stored = db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id) as any;
      assert.equal(stored.owner_user_id, aliceId);
      assert.equal(stored.admin_imported, 0);
      assert.equal(stored.claim_status, 'assigned');
      assert.ok(stored.claimed_at);
      const inherited = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id) as any;
      assert.deepEqual(inherited, { ...before, owner_user_id: aliceId });
      const managed = await call(alice, 'GET', `/accounts/${account.id}/share-link`);
      assert.equal(managed.status, 200, managed.message);
      assert.deepEqual(managed.data, { enabled: true, path: deliveries.get('delivery').path, created_at: before.created_at, expires_at: new Date(before.expires_at).toISOString() });
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${account.id}`)).data.total, 1);
      const shared = await call(browser(), 'GET', '/share/' + deliveries.get('delivery').path.split('/').pop());
      assert.equal(shared.status, 200);
      assert.equal(shared.data.game_account, data('delivery').game_account);
      assert.equal(shared.data.password, data('delivery').password);
      const repeated = await call(alice, 'POST', '/accounts/import', { content: original });
      assert.equal(repeated.data.imported, 0);
      assert.equal(repeated.data.skipped, 1);
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id), inherited);
      const theft = await call(bob, 'POST', '/accounts/import', { content: original });
      assert.equal(theft.data.imported, 0);
      assert.equal(theft.data.errors.length, 1);
      assert.equal((await call(bob, 'GET', `/accounts/${account.id}/credentials`)).status, 404);
      for (const method of ['GET', 'POST', 'DELETE']) {
        assert.equal((await call(bob, method, `/accounts/${account.id}/share-link`, method === 'POST' ? { expires_in_days: null } : undefined)).status, 404);
      }
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id), inherited);
    });

    await t.test('eight-column imports verify every credential and cannot introduce unknown accounts', async () => {
      const wrong = await call(bob, 'POST', '/accounts/import', { content: `${line('wrong', { refresh_token: 'incorrect-token' })}\n${line('unknown')}` });
      assert.equal(wrong.status, 200);
      assert.equal(wrong.data.imported, 0);
      assert.equal(wrong.data.errors.length, 2);
      assert.equal(db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('unknown').game_account), undefined);
      const before = db.prepare('SELECT l.* FROM account_share_links l JOIN accounts a ON a.id=l.account_id WHERE a.game_account=?').get(data('full').game_account) as any;
      const correct = await call(bob, 'POST', '/accounts/import', { content: line('full') });
      assert.equal(correct.status, 200, correct.message);
      assert.equal(correct.data.imported, 1);
      const account = db.prepare('SELECT * FROM accounts WHERE game_account=?').get(data('full').game_account) as any;
      assert.equal(account.owner_user_id, bobId);
      assert.equal(account.game_password, data('full').game_password);
      assert.equal(account.password, data('full').password);
      const inherited = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id) as any;
      assert.deepEqual(inherited, { ...before, owner_user_id: bobId });
      const managed = await call(bob, 'GET', `/accounts/${account.id}/share-link`);
      assert.equal(managed.status, 200);
      assert.deepEqual(managed.data, { enabled: true, path: deliveries.get('full').path, created_at: before.created_at, expires_at: null });
      assert.equal((await call(browser(), 'GET', '/share/' + before.token)).status, 200);
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).status, 404);
      const repeated = await call(bob, 'POST', '/accounts/import', { content: line('full') });
      assert.equal(repeated.data.skipped, 1);
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id), inherited);
      const manual = await call(admin, 'POST', '/accounts', data('manually-added'));
      assert.equal(manual.status, 200);
      const rejected = await call(alice, 'POST', '/accounts/import', { content: line('manually-added') });
      assert.equal(rejected.data.imported, 0);
      assert.equal(rejected.data.errors.length, 1, 'only batch imported inventory is eligible');
    });

    await t.test('the claimant can reset and close the inherited link with immediate effect', async () => {
      const account = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('delivery').game_account) as any;
      const oldToken = deliveries.get('delivery').path.split('/').pop();
      const reset = await call(alice, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: 30 });
      assert.equal(reset.status, 200, reset.message);
      assert.notEqual(reset.data.path, deliveries.get('delivery').path);
      assert.equal((await call(browser(), 'GET', '/share/' + oldToken)).status, 404);
      const newToken = reset.data.path.split('/').pop();
      assert.equal((await call(browser(), 'GET', '/share/' + newToken)).status, 200);
      const closed = await call(alice, 'DELETE', `/accounts/${account.id}/share-link`);
      assert.equal(closed.status, 200);
      assert.deepEqual(closed.data, { enabled: false });
      assert.equal((await call(browser(), 'GET', '/share/' + newToken)).status, 404);
      assert.deepEqual((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).data, { enabled: false });
    });

    await t.test('expired links and busy accounts cannot be claimed, and concurrent imports have one winner', async () => {
      const expired = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('expired').game_account) as any;
      db.prepare('UPDATE account_share_links SET expires_at=? WHERE account_id=?').run(Date.now() - 1000, expired.id);
      const rejected = await call(alice, 'POST', '/accounts/import', { content: deliveryLine('expired') });
      assert.equal(rejected.data.imported, 0);
      assert.equal(rejected.data.errors.length, 1);
      const busy = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('busy').game_account) as any;
      const release = lockResources([busy.id]);
      try {
        const blocked = await call(alice, 'POST', '/accounts/import', { content: deliveryLine('busy') });
        assert.equal(blocked.data.imported, 0);
        assert.equal(blocked.data.errors.length, 1);
        assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(busy.id) as any).owner_user_id, administrator.id);
      } finally { release(); }
      const responses = await Promise.all([call(alice, 'POST', '/accounts/import', { content: deliveryLine('race') }), call(bob, 'POST', '/accounts/import', { content: deliveryLine('race') })]);
      assert.equal(responses.filter(result => result.data?.imported === 1).length, 1);
      assert.equal(responses.filter(result => result.data?.errors.length === 1).length, 1);
    });

    await t.test('single-use claim codes also retain an existing valid delivery link', async () => {
      const account = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('busy').game_account) as any;
      const before = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id) as any;
      const published = await call(admin, 'POST', '/accounts/claim-pool', { ids: [account.id] });
      assert.equal(published.status, 200, published.message);
      const claimed = await call(alice, 'POST', '/accounts/claim', { code: published.data.claim_codes[0].code });
      assert.equal(claimed.status, 200, claimed.message);
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(account.id), { ...before, owner_user_id: aliceId });
      const managed = await call(alice, 'GET', `/accounts/${account.id}/share-link`);
      assert.equal(managed.status, 200);
      assert.equal(managed.data.path, deliveries.get('busy').path);
      assert.equal((await call(browser(), 'GET', '/share/' + before.token)).status, 200);
    });

    await t.test('claiming never creates a missing link or revives expired and mismatched links', async () => {
      const mismatched = db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('wrong').game_account) as any;
      db.prepare('UPDATE account_share_links SET owner_user_id=? WHERE account_id=?').run(aliceId, mismatched.id);
      const result = await call(bob, 'POST', '/accounts/import', { content: ['unlinked', 'expired', 'wrong'].map(label => line(label)).join('\n') });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, 3);
      assert.deepEqual(result.data.errors, []);
      for (const label of ['unlinked', 'expired', 'wrong']) {
        const account = db.prepare('SELECT id,owner_user_id FROM accounts WHERE game_account=?').get(data(label).game_account) as any;
        assert.equal(account.owner_user_id, bobId);
        assert.equal(db.prepare('SELECT id FROM account_share_links WHERE account_id=?').get(account.id), undefined);
        assert.deepEqual((await call(bob, 'GET', `/accounts/${account.id}/share-link`)).data, { enabled: false });
      }
      for (const label of ['expired', 'wrong']) {
        assert.equal((await call(browser(), 'GET', '/share/' + deliveries.get(label).path.split('/').pop())).status, 404);
      }
    });

    await t.test('restoring old inventory revokes both public links and credential-based claim eligibility', async () => {
      const response = await raw(admin, 'POST', '/backup/download', { password });
      assert.equal(response.status, 200);
      const snapshot = Buffer.from(await response.arrayBuffer()).toString('base64');
      assert.equal((await call(bob, 'POST', '/accounts/import', { content: deliveryLine('backup') })).data.imported, 1);
      const restored = await call(admin, 'POST', '/backup/restore', { password, fileContent: snapshot });
      assert.equal(restored.status, 200, restored.message);
      await login(admin, administrator.username);
      await login(alice, 'inventory_alice');
      const rejected = await call(alice, 'POST', '/accounts/import', { content: line('backup') });
      assert.equal(rejected.data.imported, 0);
      assert.equal(rejected.data.errors.length, 1);
      assert.equal((db.prepare('SELECT admin_imported FROM accounts WHERE game_account=?').get(data('backup').game_account) as any).admin_imported, 0);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('version five recognizes complete historical administrator inventory without exposing user-owned records', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations, SCHEMA_VERSION } = await import('../src/database/migrations');
  const database = new Database(':memory:');
  try {
    await runMigrations(database, ':memory:');
    database.exec(`DELETE FROM schema_migrations WHERE version>=5;
      DELETE FROM settings WHERE key='short_link_length';
      DROP TABLE account_share_links;
      CREATE TABLE account_share_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE CHECK(length(token)=22),owner_user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE);
      ALTER TABLE accounts DROP COLUMN inventory_admin_id;
      ALTER TABLE accounts DROP COLUMN admin_imported;
      INSERT INTO users(id,username,display_name,password_hash,role,source) VALUES
        (1,'old_admin','旧管理员','not-used','admin','admin'),
        (2,'old_user','旧用户','not-used','user','self');
      INSERT INTO accounts(email,client_id,refresh_token,owner_user_id,game_account,game_password,real_name,id_last_six) VALUES
        ('old-stock@example.test','client','token',1,'old_stock','game-pass','姓名','00123X'),
        ('old-owned@example.test','client','token',2,'old_owned','game-pass','姓名','00123X'),
        ('old-mail@example.test','client','token',1,'','','','');`);
    await runMigrations(database, ':memory:');
    await runMigrations(database, ':memory:');
    const rows = database.prepare('SELECT admin_imported FROM accounts ORDER BY id').all() as { admin_imported: number }[];
    assert.deepEqual(rows.map(row => row.admin_imported), [1, 0, 0]);
    assert.equal((database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally { database.close(); }
});
