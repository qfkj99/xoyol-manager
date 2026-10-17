import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-integration-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

// Every request uses a temporary database; Microsoft calls are stubbed below.
test('resource isolation, ownership transfer, and consistent backup restore', async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { lockResources } = await import('../src/services/resourceAccess');
  const { OAuthService } = await import('../src/services/OAuthService');
  const { GraphApiService } = await import('../src/services/GraphApiService');
  const { default: Database } = await import('better-sqlite3');
  logger.silent = true;
  await runMigrations();
  const password = 'integration-pass-1234';
  const adminRecord = userModel.create({ username: 'admin', display_name: '管理员', password_hash: await hashPassword(password), role: 'admin', source: 'admin', must_change_password: false });
  const rollbackAdminRecord = userModel.create({ username: 'recovery', display_name: '恢复管理员', password_hash: await hashPassword(password), role: 'admin', source: 'admin', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function call(b: Browser, method: string, url: string, body?: unknown) {
    const response = await raw(b, method, url, body);
    const json = await response.json() as any;
    if (json.data?.csrfToken) b.csrf = json.data.csrfToken;
    return { status: response.status, ...json };
  }
  async function raw(b: Browser, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: base.replace('/api', '') };
    if (b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  async function login(b: Browser, username: string) {
    await call(b, 'GET', '/auth/config');
    assert.equal((await call(b, 'POST', '/auth/login', { username, password })).status, 200);
  }
  const admin = browser(), alice = browser(), bob = browser(), recovery = browser();
  let aliceId: number, bobId: number, a: any, b: any, pa: any, pb: any, ta: any, tb: any;
  let snapshot: Buffer;
  const account = (email: string) => ({ email, password: 'mail-password', client_id: 'client-id', refresh_token: 'mail-refresh-token' });
  try {
    await t.test('public boundaries and self registration', async () => {
      assert.equal((await call(browser(), 'GET', '/accounts')).status, 401);
      await login(admin, 'admin'); await login(recovery, 'recovery');
      for (const [br, username] of [[alice, 'alice'], [bob, 'bob']] as const) {
        await call(br, 'GET', '/auth/config');
        const registered = await call(br, 'POST', '/auth/register', { username, password });
        assert.equal(registered.status, 200, registered.message);
        if (username === 'alice') aliceId = registered.data.user.id; else bobId = registered.data.user.id;
      }
    });
    await t.test('list filtering, sensitive credential reads, and owner assignment', async () => {
      a = (await call(admin, 'POST', '/accounts', { ...account('ALICE@example.test'), owner_user_id: aliceId })).data;
      b = (await call(admin, 'POST', '/accounts', { ...account('bob@example.test'), owner_user_id: bobId })).data;
      assert.ok(a?.id); assert.ok(b?.id);
      const list = await call(alice, 'GET', '/accounts');
      assert.equal(list.data.total, 1); assert.equal(list.data.list[0].owner_user_id, aliceId);
      assert.equal(list.data.list[0].password, ''); assert.equal(list.data.list[0].refresh_token, '');
      assert.equal((await call(alice, 'GET', `/accounts/${a.id}/credentials`)).data.refresh_token, 'mail-refresh-token');
      assert.equal((await call(admin, 'GET', '/accounts')).data.total, 2);
      assert.equal((await call(admin, 'GET', `/accounts?owner_user_id=${bobId}`)).data.total, 1);
      assert.equal((await call(alice, 'GET', `/accounts?owner_user_id=${bobId}`)).status, 403);
      assert.equal((await call(alice, 'POST', '/accounts', { ...account('spoof@example.test'), owner_user_id: bobId })).status, 403);
    });
    await t.test('ID and batch operations cannot cross ownership or partially mutate', async () => {
      const attempts: [string, string, unknown?][] = [
        ['GET', `/accounts/${b.id}/credentials`], ['PUT', `/accounts/${b.id}`, { remark: 'hijack' }],
        ['DELETE', `/accounts/${b.id}`], ['POST', '/accounts/batch-delete', { ids: [a.id, b.id] }],
        ['POST', '/accounts/export', { ids: [a.id, b.id] }],
        ['GET', `/mails/cached?account_id=${b.id}&mailbox=INBOX`],
        ['POST', '/mails/fetch', { account_id: b.id, mailbox: 'INBOX' }],
        ['POST', '/mails/fetch-new', { account_id: b.id, mailbox: 'INBOX' }],
        ['POST', '/mails/verification-code', { account_id: b.id, mailbox: 'INBOX' }],
        ['DELETE', '/mails/clear', { account_id: b.id, mailbox: 'INBOX' }],
      ];
      for (const [method, url, body] of attempts) assert.equal((await call(alice, method, url, body)).status, 404, `${method} ${url}`);
      assert.equal((await call(alice, 'GET', '/accounts')).data.total, 1);
      const exported = await call(alice, 'POST', '/accounts/export', {});
      assert.equal(exported.data.count, 1); assert.ok(exported.data.content.includes('alice@example.test')); assert.ok(!exported.data.content.includes('bob@'));
    });
    await t.test('global email uniqueness and import overwrite are safe', async () => {
      assert.equal((await call(admin, 'POST', '/accounts', { ...account('BOB@example.test'), owner_user_id: aliceId })).status, 409);
      const content = 'new@example.test----newpw----client----newtoken\nbob@example.test----changed----client----changed';
      const preview = await call(admin, 'POST', '/accounts/import-preview', { content, owner_user_id: aliceId });
      assert.equal(preview.data.errors.length, 1); assert.equal(preview.data.duplicates.length, 0);
      const imported = await call(admin, 'POST', '/accounts/import-confirm', { content, mode: 'overwrite', owner_user_id: aliceId });
      assert.equal(imported.status, 409);
      assert.equal((await call(alice, 'GET', '/accounts')).data.total, 1);
      assert.equal((await call(bob, 'GET', `/accounts/${b.id}/credentials`)).data.password, 'mail-password');
      const own = await call(admin, 'POST', '/accounts/import-confirm', { content: 'alice@example.test----changed----client----changed', mode: 'overwrite', owner_user_id: aliceId });
      assert.equal(own.data.imported, 1);
      assert.equal((await call(alice, 'GET', `/accounts/${a.id}/credentials`)).data.password, 'changed');
    });
    await t.test('tags, proxies, and default proxies are scoped to owners', async () => {
      ta = (await call(alice, 'POST', '/tags', { name: '同名标签' })).data;
      tb = (await call(bob, 'POST', '/tags', { name: '同名标签' })).data;
      assert.ok(ta.id); assert.ok(tb.id);
      assert.equal((await call(alice, 'GET', '/tags')).data.length, 1);
      assert.equal((await call(alice, 'POST', `/accounts/${a.id}/tags`, { tag_ids: [ta.id] })).status, 200);
      assert.equal((await call(alice, 'POST', `/accounts/${a.id}/tags`, { tag_ids: [tb.id] })).status, 404);
      assert.equal((await call(admin, 'POST', `/accounts/${a.id}/tags`, { tag_ids: [tb.id] })).status, 400);
      assert.equal((await call(bob, 'DELETE', `/tags/${ta.id}`)).status, 404);
      pa = (await call(alice, 'POST', '/proxies', { name: 'A', host: '8.8.8.8', port: 8080, type: 'http', password: 'proxy-secret', is_default: true })).data;
      pb = (await call(bob, 'POST', '/proxies', { name: 'B', host: '1.1.1.1', port: 8080, type: 'http', is_default: true })).data;
      assert.ok(pa?.id); assert.ok(pb?.id);
      assert.equal((await call(alice, 'GET', '/proxies')).data.length, 1);
      assert.equal((await call(alice, 'GET', '/proxies')).data[0].password, '');
      assert.equal((await call(alice, 'GET', `/proxies/${pa.id}/credentials`)).data.password, 'proxy-secret');
      for (const [method, suffix] of [['GET', '/credentials'], ['PUT', '/default'], ['POST', '/test'], ['DELETE', '']] as const) assert.equal((await call(alice, method, `/proxies/${pb.id}${suffix}`)).status, 404);
      assert.equal((await call(alice, 'POST', '/mails/fetch', { account_id: a.id, mailbox: 'INBOX', proxy_id: pb.id })).status, 404);
      assert.equal((await call(alice, 'POST', '/proxies', { host: '127.0.0.1', port: 80, type: 'http' })).status, 400);
    });
    await t.test('mail cache, dashboard counts, and selected proxies stay within ownership', async () => {
      const used: number[] = [];
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async (_id, _token, proxy) => { used.push(proxy!.id); return { access_token: 'stub', has_mail_scope: true, expires_in: 3600 }; });
      t.mock.method(GraphApiService.prototype, 'fetchMails', async () => [{ mail_id: 'm1', subject: 'private mail', mail_date: new Date().toISOString() }]);
      assert.equal((await call(alice, 'POST', '/mails/fetch', { account_id: a.id, mailbox: 'INBOX' })).status, 200);
      assert.deepEqual(used, [pa.id]);
      const statsA = await call(alice, 'GET', '/dashboard/stats');
      const statsB = await call(bob, 'GET', '/dashboard/stats');
      assert.equal(statsA.data.totalInboxMails, 1); assert.equal(statsB.data.totalInboxMails, 0);
      assert.equal(statsB.data.recentMails.length, 0); assert.equal(statsA.data.totalProxies, 1);
      assert.equal((await call(admin, 'GET', '/dashboard/stats')).data.totalAccounts, 2);
      assert.equal((await call(bob, 'GET', `/dashboard/stats?owner_user_id=${aliceId}`)).status, 403);
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${a.id}&mailbox=invalid`)).status, 400);
    });
    await t.test('busy resource locks block edits and ownership transfer', async () => {
      const release = lockResources([a.id], [pa.id]);
      try {
        assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [a.id], target_user_id: bobId })).status, 409);
        assert.equal((await call(alice, 'PUT', `/accounts/${a.id}`, { remark: 'busy' })).status, 409);
        assert.equal((await call(alice, 'DELETE', `/proxies/${pa.id}`)).status, 409);
        assert.equal((await call(admin, 'POST', '/accounts/transfer-resources', { source_user_id: aliceId, target_user_id: bobId })).status, 409);
      } finally { release(); }
    });
    await t.test('individual and all-resource transfers preserve cache and merge tags', async () => {
      assert.equal((await call(alice, 'POST', '/accounts/transfer', { ids: [a.id], target_user_id: bobId })).status, 403);
      assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [a.id], target_user_id: bobId })).status, 200);
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${a.id}`)).status, 404);
      assert.equal((await call(bob, 'GET', `/mails/cached?account_id=${a.id}`)).data.total, 1);
      assert.equal((await call(bob, 'GET', '/accounts')).data.list.find((row: any) => row.id === a.id).tags.length, 0);
      assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [a.id], target_user_id: aliceId })).status, 200);
      await call(alice, 'POST', `/accounts/${a.id}/tags`, { tag_ids: [ta.id] });
      const moved = await call(admin, 'POST', '/accounts/transfer-resources', { source_user_id: aliceId, target_user_id: bobId });
      assert.equal(moved.status, 200); assert.equal(moved.data.accounts, 1); assert.equal(moved.data.proxies, 1);
      assert.equal((await call(bob, 'GET', '/tags')).data.length, 1);
      assert.equal((await call(bob, 'GET', '/proxies')).data.filter((p: any) => p.is_default).length, 1);
      const transferred = (await call(bob, 'GET', '/accounts')).data.list.find((row: any) => row.id === a.id);
      assert.equal(transferred.tags[0].id, tb.id);
      assert.equal((await call(admin, 'DELETE', `/users/${aliceId}`)).status, 200);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
    await t.test('admin reauthentication and WAL-safe backup without sessions', async () => {
      assert.equal((await call(bob, 'POST', '/backup/download', { password })).status, 403);
      assert.equal((await call(admin, 'POST', '/backup/download', { password: 'wrong-password' })).status, 403);
      const response = await raw(admin, 'POST', '/backup/download', { password });
      assert.equal(response.status, 200);
      snapshot = Buffer.from(await response.arrayBuffer());
      const filename = path.join(directory, 'snapshot.db'); fs.writeFileSync(filename, snapshot);
      const copy = new Database(filename, { readonly: true });
      try {
        assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal((copy.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any).c, 0);
        assert.equal((copy.prepare('SELECT COUNT(*) AS c FROM accounts').get() as any).c, 2);
      } finally { copy.close(); }
      const audits = await call(admin, 'GET', '/audit');
      assert.equal(audits.status, 200); assert.ok(audits.data.total > 5);
      assert.ok(!JSON.stringify(audits).includes('mail-refresh-token'));
      assert.ok(!JSON.stringify(audits).includes('proxy-secret'));
    });
    await t.test('invalid or incomplete restore preserves live data and replacement failure rolls back', async () => {
      assert.equal((await call(admin, 'POST', '/backup/restore', { password, fileContent: Buffer.from('invalid').toString('base64') })).status, 400);
      const incompletePath = path.join(directory, 'incomplete.db');
      fs.writeFileSync(incompletePath, snapshot);
      const incomplete = new Database(incompletePath);
      incomplete.exec('DROP INDEX idx_accounts_email_normalized');
      incomplete.close();
      const rejected = await call(recovery, 'POST', '/backup/restore', { password, fileContent: fs.readFileSync(incompletePath).toString('base64') });
      assert.equal(rejected.status, 400, 'a latest-version backup must still have all required constraints');
      assert.equal((await call(admin, 'GET', '/accounts')).data.total, 2);
      const rename = fs.renameSync;
      const mock = t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
        if (String(source).includes('.restore-')) throw new Error('simulated replacement failure');
        return rename(source, destination);
      });
      try {
        const failed = await call(recovery, 'POST', '/backup/restore', { password, fileContent: snapshot.toString('base64') });
        assert.equal(failed.status, 500);
        assert.equal((await call(admin, 'GET', '/accounts')).data.total, 2);
      } finally { mock.mock.restore(); }
    });
    await t.test('modern restore replaces state, retains rollback copy, and revokes all sessions', async () => {
      const extra = await call(admin, 'POST', '/accounts', { ...account('after-backup@example.test'), owner_user_id: bobId }); assert.equal(extra.status, 200);
      let releaseFetch!: () => void, notifyStarted!: () => void;
      const started = new Promise<void>(resolve => { notifyStarted = resolve; });
      const paused = new Promise<void>(resolve => { releaseFetch = resolve; });
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => {
        notifyStarted(); await paused;
        return { access_token: 'stub', has_mail_scope: true, expires_in: 3600 };
      });
      const pendingMail = call(bob, 'POST', '/mails/fetch', { account_id: extra.data.id, mailbox: 'INBOX' });
      await started;
      const pendingRestore = call(admin, 'POST', '/backup/restore', { password, fileContent: snapshot.toString('base64') });
      try {
        let status = 0;
        for (let attempt = 0; attempt < 100 && status !== 503; attempt++) {
          status = (await call(browser(), 'GET', '/auth/config')).status;
          if (status !== 503) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(status, 503, 'maintenance blocks new requests while draining existing mail operations');
      } finally { releaseFetch(); }
      assert.equal((await pendingMail).status, 200);
      const restored = await pendingRestore;
      assert.equal(restored.status, 200, restored.message);
      assert.equal((await call(admin, 'GET', '/auth/me')).status, 401);
      assert.equal((await call(bob, 'GET', '/auth/me')).status, 401);
      await login(admin, 'admin');
      assert.equal((await call(admin, 'GET', '/accounts')).data.total, 2);
      assert.ok(fs.readdirSync(path.join(directory, 'restore-backups')).length >= 1);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    });
    await t.test('legacy restore migrates tags and assigns resources to the administrator', async () => {
      const legacyPath = path.join(directory, 'legacy.db'); const legacy = new Database(legacyPath);
      legacy.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,password TEXT DEFAULT '',client_id TEXT NOT NULL,refresh_token TEXT NOT NULL,status TEXT DEFAULT 'active',last_synced_at DATETIME,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE proxies(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL DEFAULT '',type TEXT NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,username TEXT DEFAULT '',password TEXT DEFAULT '',is_default INTEGER DEFAULT 0,last_tested_at DATETIME,last_test_ip TEXT DEFAULT '',status TEXT DEFAULT 'untested',created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE tags(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL DEFAULT '#123456',created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE account_tags(account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(account_id,tag_id));
        CREATE TABLE mail_cache(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,mailbox TEXT NOT NULL DEFAULT 'INBOX',mail_id TEXT DEFAULT '',sender TEXT DEFAULT '',sender_name TEXT DEFAULT '',subject TEXT DEFAULT '',text_content TEXT DEFAULT '',html_content TEXT DEFAULT '',mail_date DATETIME,is_read INTEGER DEFAULT 0,cached_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO accounts(email,client_id,refresh_token) VALUES('legacy@example.test','c','t'); INSERT INTO tags(name) VALUES('旧标签'); INSERT INTO account_tags VALUES(1,1);
        INSERT INTO proxies(type,host,port,is_default) VALUES('http','8.8.8.8',80,1),('http','1.1.1.1',80,1);`);
      legacy.close();
      const result = await call(admin, 'POST', '/backup/restore', { password, fileContent: fs.readFileSync(legacyPath).toString('base64') });
      assert.equal(result.status, 200, result.message);
      await login(admin, 'admin');
      const list = await call(admin, 'GET', '/accounts');
      assert.equal(list.data.total, 1); assert.equal(list.data.list[0].owner_user_id, adminRecord.id);
      assert.equal(list.data.list[0].tags[0].name, '旧标签');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      assert.ok(fs.readdirSync(path.join(directory, 'migration-backups')).length >= 1);
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c, 1);
    });
  } finally {
    t.mock.restoreAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
