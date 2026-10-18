import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-external-api-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('administrator API keys support scoped automation without granting browser sessions', { timeout: 30_000 }, async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { MailService } = await import('../src/services/MailService');
  logger.silent = true;
  const logs: string[] = [];
  t.mock.method(logger, 'info', (...args: unknown[]) => { logs.push(JSON.stringify(args)); return logger; });
  t.mock.method(logger, 'error', (...args: unknown[]) => { logs.push(JSON.stringify(args)); return logger; });
  await runMigrations();
  const password = 'external-api-password-2026';
  const hash = await hashPassword(password);
  const adminRecord = userModel.create({ username: 'api_admin', display_name: 'API 管理员', password_hash: hash, role: 'admin', source: 'admin', must_change_password: false });
  const otherAdminRecord = userModel.create({ username: 'api_other_admin', display_name: '另一管理员', password_hash: hash, role: 'admin', source: 'admin', must_change_password: false });
  const aliceRecord = userModel.create({ username: 'api_alice', display_name: '用户甲', password_hash: hash, role: 'user', source: 'self', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function raw(b: Browser, method: string, route: string, body?: unknown, csrf = true) {
    const headers: Record<string, string> = { Origin: origin, Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (csrf && b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  async function call(b: Browser, method: string, route: string, body?: unknown, csrf = true) {
    const response = await raw(b, method, route, body, csrf);
    const json = await response.json() as any;
    if (json.data?.csrfToken) b.csrf = json.data.csrfToken;
    return { status: response.status, headers: response.headers, ...json };
  }
  const external = async (key: string | undefined, method: string, route: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (key !== undefined) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api/external/v1${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, ...await response.json() as any };
  };
  const admin = browser(), otherAdmin = browser(), alice = browser();
  async function login(b: Browser, username: string) {
    await call(b, 'GET', '/auth/config');
    assert.equal((await call(b, 'POST', '/auth/login', { username, password })).status, 200);
  }
  const scopes = ['accounts:read', 'accounts:import', 'share-links:write', 'mail:read'];
  const keys: string[] = [];
  async function makeKey(selectedScopes = scopes, b = admin, extra: Record<string, unknown> = {}) {
    const result = await call(b, 'POST', '/api-keys', { name: 'automation', scopes: selectedScopes, expires_in_days: null, ...extra });
    assert.equal(result.status, 200, result.message);
    assert.match(result.data.key, /^xoyol_[a-f0-9]{64}$/);
    keys.push(result.data.key);
    return result.data as { key: string; api_key: any };
  }
  const data = (label: string) => ({ game_account: `api_game_${label}`, game_password: `game-pass-${label}`, real_name: '接口姓名', id_last_six: '00123X', email: `${label}@api.test`, password: `mail-pass-${label}`, client_id: `client-${label}`, refresh_token: `refresh-${label}` });
  const line = (label: string, overrides: Record<string, string> = {}) => Object.values({ ...data(label), ...overrides }).join('----');
  let fullKey = '', importedAccount: any, importedPath = '';
  try {
    await login(admin, adminRecord.username);
    await login(otherAdmin, otherAdminRecord.username);
    await login(alice, aliceRecord.username);

    await t.test('key management requires an administrator browser session and CSRF', async () => {
      assert.equal((await call(browser(), 'GET', '/api-keys')).status, 401);
      assert.equal((await call(alice, 'GET', '/api-keys')).status, 403);
      assert.equal((await call(alice, 'POST', '/api-keys', { name: 'denied', scopes })).status, 403);
      assert.equal((await call(admin, 'POST', '/api-keys', { name: 'denied', scopes }, false)).status, 403);
      for (const body of [{ name: '', scopes }, { name: 'bad', scopes: [] }, { name: 'bad', scopes: ['users:write'] }, { name: 'bad', scopes, expires_in_days: 1 }]) {
        assert.equal((await call(admin, 'POST', '/api-keys', body)).status, 400);
      }
      const made = await makeKey();
      fullKey = made.key;
      assert.deepEqual(made.api_key.scopes, scopes);
      assert.equal(made.api_key.created_by, adminRecord.id);
      assert.equal(made.api_key.creator_username, adminRecord.username);
      assert.equal(made.api_key.expires_at, null);
      assert.equal(made.api_key.revoked_at, null);
      assert.equal(made.api_key.last_used_at, null);
      const stored = db.prepare('SELECT * FROM api_keys WHERE id=?').get(made.api_key.id) as any;
      assert.equal(stored.key_hash, createHash('sha256').update(fullKey).digest('hex'));
      assert.equal(JSON.stringify(stored).includes(fullKey), false);
      const list = await call(admin, 'GET', '/api-keys');
      assert.equal(list.data.list.some((item: any) => item.id === made.api_key.id), true);
      assert.equal(JSON.stringify(list.data).includes(fullKey), false);
      assert.equal(JSON.stringify(list.data).includes(stored.key_hash), false);
      assert.match(list.headers.get('cache-control') || '', /no-store/i);
    });

    await t.test('alternate API prefix casing cannot bypass CSRF or required password changes', async () => {
      const countKeys = () => (db.prepare('SELECT COUNT(*) AS count FROM api_keys').get() as any).count;
      const before = countKeys();
      const body = { name: 'case-bypass-denied', scopes: ['accounts:read'], expires_in_days: null };
      try {
        for (const requiredPasswordChange of [0, 1]) {
          db.prepare('UPDATE users SET must_change_password=? WHERE id=?').run(requiredPasswordChange, adminRecord.id);
          for (const prefix of ['/API', '/ApI']) {
            const response = await fetch(`${origin}${prefix}/api-keys`, {
              method: 'POST',
              headers: {
                Cookie: [...admin.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
                Origin: 'https://malicious.example.test', 'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            assert.equal(response.status, 404, `${prefix}, must_change_password=${requiredPasswordChange}`);
            assert.equal((await response.json() as any).data, null);
            assert.match(response.headers.get('cache-control') || '', /no-store/i);
            assert.equal(countKeys(), before, 'rejected requests must not create keys');
          }
          if (requiredPasswordChange) {
            const denied = await call(admin, 'POST', '/api-keys', body);
            assert.equal(denied.status, 403);
            assert.equal(denied.data.reason, 'PASSWORD_CHANGE_REQUIRED');
          } else {
            assert.equal((await call(admin, 'POST', '/api-keys', body, false)).status, 403);
          }
          assert.equal(countKeys(), before);
        }
      } finally {
        db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(adminRecord.id);
      }
    });

    await t.test('bearer authentication is isolated from cookies, CSRF, query keys, and browser-only routes', async () => {
      assert.equal((await external(undefined, 'GET', '/accounts')).status, 401);
      assert.equal((await external('wrong', 'GET', '/accounts')).status, 401);
      assert.equal((await external(undefined, 'GET', `/accounts?api_key=${fullKey}`)).status, 401);
      assert.equal((await call(admin, 'GET', '/external/v1/accounts')).status, 401);
      const result = await external(fullKey, 'GET', '/accounts', undefined, { Origin: 'https://automation.example.test' });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.headers.has('set-cookie'), false);
      assert.match(result.headers.get('cache-control') || '', /no-store/i);
      assert.ok((db.prepare('SELECT last_used_at FROM api_keys WHERE key_hash=?').get(createHash('sha256').update(fullKey).digest('hex')) as any).last_used_at);
      for (const route of ['/accounts', '/users', '/api-keys']) {
        const response = await fetch(`${origin}/api${route}`, { headers: { Authorization: `Bearer ${fullKey}` } });
        assert.equal(response.status, 401);
      }
    });

    await t.test('eight-field imports return reusable absolute short links and five-field export lines', async () => {
      const result = await external(fullKey, 'POST', '/accounts/import', { content: [line('primary'), line('second')].join('\n') });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, 2);
      assert.equal(result.data.skipped, 0);
      assert.deepEqual(result.data.errors, []);
      assert.equal(result.data.accounts.length, 2);
      importedAccount = result.data.accounts.find((item: any) => item.game_account === data('primary').game_account);
      importedPath = importedAccount.share_path;
      assert.match(importedPath, /^\/s\/[A-Za-z0-9_-]{8,64}$/);
      assert.equal(importedAccount.share_url, origin + importedPath);
      assert.equal(importedAccount.share_link_enabled, true);
      assert.equal(importedAccount.share_link_last_accessed_at, null);
      const expected = result.data.accounts.map((item: any) => [item.game_account, item.game_password, item.real_name, item.id_last_six, item.share_url].join('----')).join('\n');
      assert.equal(result.data.export_content, expected);
      assert.equal(result.data.export_content.includes('mail-pass-'), false);
      const stored = db.prepare('SELECT * FROM accounts WHERE id=?').get(importedAccount.id) as any;
      assert.equal(stored.owner_user_id, adminRecord.id);
      assert.equal(stored.admin_imported, 1);
      assert.equal(stored.inventory_admin_id, adminRecord.id);
      const page = await call(browser(), 'GET', `/share/${importedPath.slice(3)}`);
      assert.equal(page.status, 200, page.message);
      for (const [field, value] of Object.entries(data('primary'))) assert.equal(page.data[field], value, field);
    });

    await t.test('malformed JSON returns a fixed message without logging request credentials', async () => {
      const secret = 'malformed-body-refresh-secret-009911';
      const querySecret = 'malformed-url-api-key-secret-882211';
      for (const prefix of ['/api', '/API']) {
        const response = await fetch(`${origin}${prefix}/external/v1/accounts/import?api_key=${querySecret}`, {
          method: 'POST', headers: { Authorization: `Bearer ${fullKey}`, 'Content-Type': 'application/json' },
          body: `{"content":${secret}}`,
        });
        assert.equal(response.status, 400);
        const result = await response.json() as any;
        assert.equal(result.message, 'JSON 格式错误');
        for (const credential of [secret, querySecret]) {
          assert.equal(JSON.stringify(result).includes(credential), false);
          assert.equal(JSON.stringify(logs).includes(credential), false);
        }
      }
    });

    await t.test('read endpoints support search and expose credentials, link URL, and visit status to the key', async () => {
      const found = await external(fullKey, 'GET', '/accounts?search=api_game_primary&page=1&pageSize=10');
      assert.equal(found.status, 200, found.message);
      assert.equal(found.data.total, 1);
      assert.equal(found.data.list[0].id, importedAccount.id);
      assert.equal(found.data.list[0].share_url, origin + importedPath);
      assert.ok(found.data.list[0].share_link_last_accessed_at);
      for (const field of ['password', 'client_id', 'refresh_token']) assert.equal(field in found.data.list[0], false);
      const paged = await external(fullKey, 'GET', '/accounts?page=2&pageSize=1');
      assert.equal(paged.data.total, 2);
      assert.equal(paged.data.list.length, 1);
      const details = await external(fullKey, 'GET', `/accounts/${importedAccount.id}`);
      assert.equal(details.status, 200, details.message);
      for (const [field, value] of Object.entries(data('primary'))) assert.equal(details.data[field], value, field);
      assert.equal(details.data.share_url, origin + importedPath);
      const link = await external(fullKey, 'GET', `/accounts/${importedAccount.id}/share-link`);
      assert.equal(link.data.path, importedPath);
      assert.equal(link.data.url, origin + importedPath);
      assert.equal(link.data.enabled, true);
      assert.ok(link.data.last_accessed_at);
      assert.equal((await external(fullKey, 'GET', '/accounts/999999')).status, 404);
    });

    await t.test('duplicate exact imports keep the existing URL and changed duplicates do not disclose or replace it', async () => {
      const before = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(importedAccount.id);
      const exact = await external(fullKey, 'POST', '/accounts/import', { content: line('primary') });
      assert.equal(exact.status, 200, exact.message);
      assert.equal(exact.data.imported, 0);
      assert.equal(exact.data.skipped, 1);
      assert.equal(exact.data.accounts[0].share_path, importedPath);
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(importedAccount.id), before);
      const changed = await external(fullKey, 'POST', '/accounts/import', { content: line('primary', { game_password: 'incorrect-password' }) });
      assert.equal(changed.status, 200, changed.message);
      assert.equal(changed.data.imported, 0);
      assert.equal(changed.data.skipped, 1);
      assert.equal(changed.data.errors.length, 1);
      assert.deepEqual(changed.data.accounts, []);
      assert.equal(changed.data.export_content, '');
      assert.equal((db.prepare('SELECT game_password FROM accounts WHERE id=?').get(importedAccount.id) as any).game_password, data('primary').game_password);
      const sameEmail = await external(fullKey, 'POST', '/accounts/import', { content: line('primary', { game_account: 'another-game-account' }) });
      assert.equal(sameEmail.status, 200, sameEmail.message);
      assert.equal(sameEmail.data.imported, 0);
      assert.equal(sameEmail.data.skipped, 1);
      assert.equal(sameEmail.data.errors.length, 1);
      assert.deepEqual(sameEmail.data.accounts, []);
      assert.equal(sameEmail.data.export_content, '');
      assert.equal(JSON.stringify(sameEmail.data).includes(importedPath), false);
      assert.equal((db.prepare('SELECT game_account FROM accounts WHERE id=?').get(importedAccount.id) as any).game_account, data('primary').game_account);
      assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(importedAccount.id), before);
    });

    await t.test('absolute links use the configured public site origin for reverse-proxy deployments', async () => {
      const { config } = await import('../src/config');
      const previous = config.appOrigin;
      config.appOrigin = 'https://accounts.example.test';
      try {
        const details = await external(fullKey, 'GET', `/accounts/${importedAccount.id}`);
        assert.equal(details.status, 200);
        assert.equal(details.data.share_url, `https://accounts.example.test${importedPath}`);
        const share = await external(fullKey, 'GET', `/accounts/${importedAccount.id}/share-link`);
        assert.equal(share.data.url, details.data.share_url);
      } finally { config.appOrigin = previous; }
    });

    await t.test('imported delivery files work with user import and claimed accounts cannot be overwritten by a key', async () => {
      const delivery = [importedAccount.game_account, importedAccount.game_password, importedAccount.real_name, importedAccount.id_last_six, origin + importedPath].join('----');
      const claim = await call(alice, 'POST', '/accounts/import', { content: delivery });
      assert.equal(claim.status, 200, claim.message);
      assert.equal(claim.data.imported, 1);
      assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(importedAccount.id) as any).owner_user_id, aliceRecord.id);
      const before = db.prepare('SELECT * FROM accounts WHERE id=?').get(importedAccount.id);
      const blocked = await external(fullKey, 'POST', '/accounts/import', { content: line('primary'), mode: 'overwrite' });
      assert.equal(blocked.status, 409, blocked.message);
      assert.deepEqual(db.prepare('SELECT * FROM accounts WHERE id=?').get(importedAccount.id), before);
      const stillVisible = await call(browser(), 'GET', `/share/${importedPath.slice(3)}`);
      assert.equal(stillVisible.status, 200);
      const userList = await call(alice, 'GET', '/accounts');
      assert.equal('share_link_last_accessed_at' in userList.data.list[0], false);
    });

    await t.test('each scope grants only its matching endpoints', async () => {
      const readOnly = await makeKey(['accounts:read']);
      assert.equal((await external(readOnly.key, 'GET', '/accounts')).status, 200);
      assert.equal((await external(readOnly.key, 'GET', `/accounts/${importedAccount.id}`)).status, 200);
      assert.equal((await external(readOnly.key, 'POST', '/accounts/import', { content: line('denied') })).status, 403);
      assert.equal((await external(readOnly.key, 'POST', `/accounts/${importedAccount.id}/share-link`, {})).status, 403);
      assert.equal((await external(readOnly.key, 'DELETE', `/accounts/${importedAccount.id}/share-link`)).status, 403);
      assert.equal((await external(readOnly.key, 'POST', `/accounts/${importedAccount.id}/verification-code`, {})).status, 403);
      const importOnly = await makeKey(['accounts:import'], otherAdmin);
      assert.equal((await external(importOnly.key, 'GET', '/accounts')).status, 403);
      assert.equal((await external(importOnly.key, 'GET', `/accounts/${importedAccount.id}/share-link`)).status, 403);
      const delivered = await external(importOnly.key, 'POST', '/accounts/import', { content: line('import_only') });
      assert.equal(delivered.status, 200, delivered.message);
      assert.equal(delivered.data.imported, 1);
      assert.match(delivered.data.accounts[0].share_url, /^http:\/\/127\.0\.0\.1:\d+\/s\//);
    });

    await t.test('pool imports and explicit overwrite retain ownership and never replace another administrators records', async () => {
      const ownedKey = await makeKey(scopes, otherAdmin);
      const added = await external(ownedKey.key, 'POST', '/accounts/import', { content: line('pool'), placement: 'pool' });
      assert.equal(added.status, 200, added.message);
      assert.equal(added.data.imported, 1);
      assert.equal(added.data.claim_codes.length, 1);
      const account = added.data.accounts[0];
      assert.equal(account.owner_user_id, otherAdminRecord.id);
      assert.equal(account.claim_status, 'available');
      const originalPath = account.share_path;
      const overwritten = await external(ownedKey.key, 'POST', '/accounts/import', { content: line('pool', { game_password: 'changed-game-pass' }), mode: 'overwrite' });
      assert.equal(overwritten.status, 200, overwritten.message);
      assert.equal(overwritten.data.imported, 1);
      assert.equal(overwritten.data.accounts[0].game_password, 'changed-game-pass');
      assert.equal(overwritten.data.accounts[0].share_path, originalPath, 'updating credentials retains the previously delivered link');
      const before = db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);
      const crossOwner = await external(fullKey, 'POST', '/accounts/import', { content: line('pool', { game_password: 'hijack' }), mode: 'overwrite' });
      assert.equal(crossOwner.status, 409);
      assert.deepEqual(db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id), before);
    });

    await t.test('link reset and revocation work without session CSRF and reset visit tracking', async () => {
      const reset = await external(fullKey, 'POST', `/accounts/${importedAccount.id}/share-link`, { expires_in_days: 7 });
      assert.equal(reset.status, 200, reset.message);
      assert.equal(reset.data.url, origin + reset.data.path);
      assert.notEqual(reset.data.path, importedPath);
      assert.ok(Date.parse(reset.data.expires_at) > Date.now() + 6 * 86400_000);
      const old = await call(browser(), 'GET', `/share/${importedPath.slice(3)}`);
      assert.equal(old.status, 404);
      const info = await external(fullKey, 'GET', `/accounts/${importedAccount.id}/share-link`);
      assert.equal(info.data.last_accessed_at, null);
      assert.equal((await external(fullKey, 'DELETE', `/accounts/${importedAccount.id}/share-link`)).status, 200);
      assert.equal((await external(fullKey, 'GET', `/accounts/${importedAccount.id}/share-link`)).data.enabled, false);
      assert.equal((await call(browser(), 'GET', `/share/${reset.data.path.slice(3)}`)).status, 404);
    });

    await t.test('mail scope fetches the chosen account from all folders and rejects resource injection', async () => {
      const mailKey = await makeKey(['mail:read']);
      const mailRequests: unknown[][] = [];
      const mailMock = t.mock.method(MailService.prototype, 'fetchVerificationMails', async (...args: unknown[]) => {
        mailRequests.push(args);
        return { mails: [{ mail_id: 'external-code', subject: '游戏验证码 008899', sender: 'game@example.test', mail_date: new Date().toISOString(), mailbox: 'Junk' }], total: 1, cached: false, protocol: 'graph' };
      });
      try {
        const result = await external(mailKey.key, 'POST', `/accounts/${importedAccount.id}/verification-code`, {});
        assert.equal(result.status, 200, result.message);
        assert.equal(result.data.mailbox, 'ALL');
        assert.deepEqual(result.data.mailboxes, ['INBOX', 'Junk']);
        assert.equal(result.data.candidates[0].code, '008899');
        assert.equal(mailRequests[0][1], importedAccount.id);
        assert.equal(mailRequests[0][2], undefined);
        assert.equal((await external(mailKey.key, 'POST', `/accounts/${importedAccount.id}/verification-code`, { proxy_id: 123, account_id: 999 })).status, 400);
        assert.equal(mailRequests.length, 1);
      } finally { mailMock.mock.restore(); }
    });

    await t.test('import validation rejects unrecognized options and non-eight-field formats', async () => {
      const validationKey = await makeKey(['accounts:import'], otherAdmin);
      for (const body of [{}, { content: '' }, { content: 1 }, { content: line('invalid'), owner_user_id: aliceRecord.id }, { content: line('invalid'), mode: 'merge' }, { content: line('invalid'), placement: 'unknown' }]) {
        assert.equal((await external(validationKey.key, 'POST', '/accounts/import', body)).status, 400, JSON.stringify(body));
      }
      const invalidLine = await external(validationKey.key, 'POST', '/accounts/import', { content: 'mail@example.test----password----client----refresh' });
      assert.equal(invalidLine.status, 200);
      assert.equal(invalidLine.data.imported, 0);
      assert.equal(invalidLine.data.errors.length, 1);
      assert.deepEqual(invalidLine.data.accounts, []);
      assert.equal((await external(fullKey, 'POST', `/accounts/${importedAccount.id}/share-link`, { expires_in_days: 1 })).status, 400);
    });

    await t.test('pending mailbox reads recheck a revoked key before returning any verification code', async () => {
      const pendingKey = await makeKey(['mail:read']);
      let entered!: () => void, finish!: (value: any) => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const waiting = new Promise<any>(resolve => { finish = resolve; });
      const mailMock = t.mock.method(MailService.prototype, 'fetchVerificationMails', async () => { entered(); return waiting; });
      try {
        const request = external(pendingKey.key, 'POST', `/accounts/${importedAccount.id}/verification-code`, {});
        await started;
        assert.equal((await call(admin, 'DELETE', `/api-keys/${pendingKey.api_key.id}`)).status, 200);
        finish({ mails: [{ mail_id: 'revoked-key', subject: '验证码 009977' }], total: 1, cached: false, protocol: 'graph' });
        const result = await request;
        assert.equal(result.status, 401);
        assert.equal(JSON.stringify(result).includes('009977'), false);
      } finally { finish?.({ mails: [], total: 0, cached: false, protocol: 'graph' }); mailMock.mock.restore(); }
    });

    await t.test('revoked and expired keys and inactive or demoted creators lose authorization immediately', async () => {
      const made = await makeKey(['accounts:read'], otherAdmin, { expires_in_days: 7 });
      assert.ok(Date.parse(made.api_key.expires_at) > Date.now() + 6 * 86400_000);
      for (const update of ["status='disabled'", "status='deleted'", "role='user'", 'must_change_password=1']) {
        db.prepare(`UPDATE users SET ${update} WHERE id=?`).run(otherAdminRecord.id);
        assert.equal((await external(made.key, 'GET', '/accounts')).status, 401, update);
        db.prepare("UPDATE users SET role='admin',status='active',must_change_password=0 WHERE id=?").run(otherAdminRecord.id);
      }
      db.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(Date.now() - 1, made.api_key.id);
      assert.equal((await external(made.key, 'GET', '/accounts')).status, 401);
      db.prepare('UPDATE api_keys SET expires_at=NULL WHERE id=?').run(made.api_key.id);
      assert.equal((await external(made.key, 'GET', '/accounts')).status, 200);
      assert.equal((await call(admin, 'DELETE', `/api-keys/${made.api_key.id}`, undefined, false)).status, 403);
      assert.equal((await call(alice, 'DELETE', `/api-keys/${made.api_key.id}`)).status, 403);
      assert.equal((await call(admin, 'DELETE', `/api-keys/${made.api_key.id}`)).status, 200);
      assert.equal((await external(made.key, 'GET', '/accounts')).status, 401);
    });

    await t.test('backup download and restore do not reactivate previously revoked keys', async () => {
      const keyBefore = await makeKey(['accounts:read']);
      const snapshot = await raw(admin, 'POST', '/backup/download', { password });
      assert.equal(snapshot.status, 200);
      const fileContent = Buffer.from(await snapshot.arrayBuffer()).toString('base64');
      assert.equal((await call(admin, 'DELETE', `/api-keys/${keyBefore.api_key.id}`)).status, 200);
      const restored = await call(admin, 'POST', '/backup/restore', { password, fileContent });
      assert.equal(restored.status, 200, restored.message);
      assert.equal((await external(keyBefore.key, 'GET', '/accounts')).status, 401);
      assert.equal((await external(fullKey, 'GET', '/accounts')).status, 401);
      assert.equal((await call(admin, 'GET', '/auth/me')).status, 401);
      await login(admin, adminRecord.username);
      const listed = await call(admin, 'GET', '/api-keys');
      assert.equal(listed.data.list.every((item: any) => item.revoked_at !== null), true);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });

    await t.test('HTTP and audit logs omit key values, passwords, refresh tokens, and verification codes', () => {
      const recorded = JSON.stringify(logs) + JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
      for (const secret of [...keys, 'game-pass-primary', 'mail-pass-primary', 'refresh-primary', '008899', '009977']) assert.equal(recorded.includes(secret), false, 'an API secret leaked into logging');
    });
  } finally {
    t.mock.restoreAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
