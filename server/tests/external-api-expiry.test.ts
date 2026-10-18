import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-api-link-expiry-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

const day = 86_400_000;
const fields = (label: string) => ({
  game_account: `expiry_game_${label}`, game_password: `game-pass-${label}`,
  real_name: '有效期测试', id_last_six: '00123X', email: `${label}@expiry.test`,
  password: `mail-pass-${label}`, client_id: `client-${label}`, refresh_token: `refresh-${label}`,
});
const line = (label: string, overrides: Record<string, string> = {}) => Object.values({ ...fields(label), ...overrides }).join('----');

test('external account imports apply short-link lifetimes without exposing or extending existing deliveries', { timeout: 30_000 }, async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { apiKeyModel } = await import('../src/models/ApiKey');
  const { hashPassword } = await import('../src/services/password');
  logger.silent = true;
  await runMigrations();
  const password = 'link-expiry-password-2026';
  const hash = await hashPassword(password);
  let fixtureNumber = 0;
  function fixture() {
    const label = `scenario_${++fixtureNumber}`;
    const admin = userModel.create({ username: `expiry_admin_${fixtureNumber}`, display_name: '有效期管理员', password_hash: hash, role: 'admin', source: 'admin', must_change_password: false });
    const { key } = apiKeyModel.create({ name: label, scopes: ['accounts:import', 'accounts:read', 'share-links:write'], expires_in_days: null, created_by: admin.id });
    return { label, admin, key };
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function external(key: string, method: string, route: string, body?: unknown) {
    const response = await fetch(`${origin}/api/external/v1${route}`, {
      method, headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() as any };
  }
  async function imported(key: string, content: string, options: Record<string, unknown> = {}) {
    const result = await external(key, 'POST', '/accounts/import', { content, ...options });
    assert.equal(result.status, 200, result.message);
    assert.deepEqual(result.data.errors, []);
    return result.data as any;
  }
  const storedLink = (id: number) => db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(id) as any;
  function lifetime(account: any, days: number | null, before: number, after = Date.now()) {
    const stored = storedLink(account.id);
    assert.equal(account.share_link_enabled, true);
    assert.equal(account.share_url, origin + account.share_path);
    if (days === null) {
      assert.equal(account.share_link_expires_at, null);
      assert.equal(stored.expires_at, null);
    } else {
      const expiry = Date.parse(account.share_link_expires_at);
      assert.ok(expiry >= before + days * day && expiry <= after + days * day, `expected ${days} days, got ${account.share_link_expires_at}`);
      assert.equal(stored.expires_at, expiry);
    }
  }
  async function publicRead(shortPath: string) {
    const response = await fetch(`${origin}/api/share/${shortPath.slice(3)}`);
    return { status: response.status, ...await response.json() as any };
  }
  try {
    await t.test('new links support omitted or explicit permanent expiry and integer boundary lifetimes', async () => {
      const { key, label } = fixture();
      for (const [suffix, options, days] of [
        ['default', {}, null], ['permanent', { expires_in_days: null }, null],
        ['one_day', { expires_in_days: 1 }, 1], ['maximum', { expires_in_days: 3650 }, 3650],
      ] as const) {
        const before = Date.now();
        const result = await imported(key, line(`${label}_${suffix}`), options);
        assert.equal(result.imported, 1);
        assert.equal(result.skipped, 0);
        lifetime(result.accounts[0], days, before);
        assert.equal(result.export_content.split('----')[4], result.accounts[0].share_url);
      }
    });

    await t.test('a batch applies its custom expiry to every generated delivery and pool import', async () => {
      const { key, label } = fixture();
      const before = Date.now();
      const result = await imported(key, [line(`${label}_a`), line(`${label}_b`), line(`${label}_c`)].join('\n'), { expires_in_days: 14, placement: 'pool' });
      assert.equal(result.imported, 3);
      assert.equal(result.accounts.length, 3);
      assert.equal(result.claim_codes.length, 3);
      assert.equal(result.export_content.split('\n').length, 3);
      for (const account of result.accounts) lifetime(account, 14, before);
      assert.equal(new Set(result.accounts.map((account: any) => account.share_path)).size, 3);
    });

    await t.test('skip retries preserve token, expiry, creation date and visit history despite new expiry options', async () => {
      const { key, label } = fixture();
      const account = (await imported(key, line(label), { expires_in_days: 7 })).accounts[0];
      db.prepare('UPDATE account_share_links SET created_at=?,last_accessed_at=? WHERE account_id=?').run('2026-01-01 01:02:03', Date.now() - 60_000, account.id);
      const before = storedLink(account.id);
      for (const options of [{ expires_in_days: 30 }, { expires_in_days: null }, {}]) {
        const result = await imported(key, line(label), options);
        assert.equal(result.imported, 0);
        assert.equal(result.skipped, 1);
        assert.equal(result.accounts[0].share_path, account.share_path);
        assert.equal(result.accounts[0].share_link_expires_at, account.share_link_expires_at);
        assert.deepEqual(storedLink(account.id), before);
      }
    });

    await t.test('overwrite updates lifetime while retaining a valid URL and its visit history', async () => {
      const { key, label } = fixture();
      const account = (await imported(key, line(label), { expires_in_days: 7 })).accounts[0];
      db.prepare('UPDATE account_share_links SET created_at=?,last_accessed_at=? WHERE account_id=?').run('2026-01-01 01:02:03', Date.now() - 30_000, account.id);
      const original = storedLink(account.id);
      let before = Date.now();
      const changed = await imported(key, line(label, { game_password: 'new-game-password' }), { mode: 'overwrite', expires_in_days: 1 });
      assert.equal(changed.imported, 1);
      assert.equal(changed.accounts[0].game_password, 'new-game-password');
      assert.equal(changed.accounts[0].share_path, account.share_path);
      lifetime(changed.accounts[0], 1, before);
      assert.deepEqual(storedLink(account.id), { ...original, expires_at: Date.parse(changed.accounts[0].share_link_expires_at) });
      for (const options of [{ expires_in_days: null }, {}]) {
        before = Date.now();
        const permanent = await imported(key, line(label), { mode: 'overwrite', ...options });
        lifetime(permanent.accounts[0], null, before);
        assert.deepEqual(storedLink(account.id), { ...original, expires_at: null });
      }
      db.prepare('UPDATE account_share_links SET expires_at=? WHERE account_id=?').run(Date.now() - 1, account.id);
      before = Date.now();
      const replacement = (await imported(key, line(label), { mode: 'overwrite', expires_in_days: 3650 })).accounts[0];
      lifetime(replacement, 3650, before);
      assert.notEqual(replacement.share_path, account.share_path);
      assert.equal(storedLink(account.id).last_accessed_at, null);
      assert.equal((await publicRead(account.share_path)).status, 404);
    });

    await t.test('skip recreates absent or expired links using the requested expiry', async () => {
      const { key, label } = fixture();
      let account = (await imported(key, line(label), { expires_in_days: 7 })).accounts[0];
      const firstPath = account.share_path;
      db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(account.id);
      let before = Date.now();
      let result = await imported(key, line(label), { expires_in_days: 4 });
      assert.equal(result.imported, 0);
      assert.equal(result.skipped, 1);
      account = result.accounts[0];
      lifetime(account, 4, before);
      assert.notEqual(account.share_path, firstPath);
      for (const options of [{ expires_in_days: 2 }, { expires_in_days: null }, {}]) {
        const previousPath = account.share_path;
        db.prepare('UPDATE account_share_links SET expires_at=?,last_accessed_at=? WHERE account_id=?').run(Date.now() - 1, Date.now() - 30_000, account.id);
        before = Date.now();
        result = await imported(key, line(label), options);
        account = result.accounts[0];
        lifetime(account, 'expires_in_days' in options ? options.expires_in_days : null, before);
        assert.notEqual(account.share_path, previousPath);
        assert.equal(storedLink(account.id).last_accessed_at, null);
        assert.equal((await publicRead(previousPath)).status, 404);
      }
    });

    await t.test('expired imported links stop serving credentials and verification codes', async () => {
      const { key, label } = fixture();
      const account = (await imported(key, line(label), { expires_in_days: 1 })).accounts[0];
      assert.equal((await publicRead(account.share_path)).status, 200);
      db.prepare('UPDATE account_share_links SET expires_at=? WHERE account_id=?').run(Date.now() - 1, account.id);
      const denied = await publicRead(account.share_path);
      assert.equal(denied.status, 404);
      assert.equal(JSON.stringify(denied).includes(fields(label).game_password), false);
      const response = await fetch(`${origin}/api/share/${account.share_path.slice(3)}/verification-code`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 404);
      assert.equal(JSON.stringify(await response.json()).includes(fields(label).refresh_token), false);
      const info = await external(key, 'GET', `/accounts/${account.id}/share-link`);
      assert.equal(info.data.enabled, false);
    });

    await t.test('invalid expiry types and ranges reject an overwrite batch before any account or link changes', async () => {
      const invalid: unknown[] = ['7', '', true, false, 1.5, 0, -1, 3651, [], {}, Number.MAX_SAFE_INTEGER];
      for (let offset = 0; offset < invalid.length; offset += 6) {
        const { key, label } = fixture();
        await imported(key, line(`${label}_existing`), { expires_in_days: 7 });
        const content = [line(`${label}_existing`, { game_password: 'must-not-change' }), line(`${label}_new`)].join('\n');
        const accountsBefore = db.prepare('SELECT * FROM accounts ORDER BY id').all();
        const linksBefore = db.prepare('SELECT * FROM account_share_links ORDER BY id').all();
        for (const expires_in_days of invalid.slice(offset, offset + 6)) {
          const rejected = await external(key, 'POST', '/accounts/import', { content, mode: 'overwrite', expires_in_days });
          assert.equal(rejected.status, 400, `invalid expiry ${JSON.stringify(expires_in_days)}`);
          assert.deepEqual(db.prepare('SELECT * FROM accounts ORDER BY id').all(), accountsBefore);
          assert.deepEqual(db.prepare('SELECT * FROM account_share_links ORDER BY id').all(), linksBefore);
        }
      }
    });

    await t.test('mismatched duplicate credentials cannot reveal or alter a link using the expiry option', async () => {
      const { key, label } = fixture();
      const account = (await imported(key, line(label), { expires_in_days: 7 })).accounts[0];
      const before = storedLink(account.id);
      for (const overrides of [{ game_password: 'wrong-password' }, { refresh_token: 'wrong-refresh-token' }]) {
        const result = await external(key, 'POST', '/accounts/import', { content: line(label, overrides), expires_in_days: null });
        assert.equal(result.status, 200, result.message);
        assert.equal(result.data.imported, 0);
        assert.equal(result.data.skipped, 1);
        assert.equal(result.data.errors.length, 1);
        assert.deepEqual(result.data.accounts, []);
        assert.equal(result.data.export_content, '');
        assert.equal(JSON.stringify(result.data).includes(account.share_path), false);
        assert.deepEqual(storedLink(account.id), before);
      }
    });

    await t.test('short-link reset accepts the same custom lifetime range and explicit permanent links', async () => {
      const { key, label } = fixture();
      const account = (await imported(key, line(label))).accounts[0];
      let previousPath = account.share_path;
      for (const days of [1, 3650, null]) {
        const before = Date.now();
        const result = await external(key, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: days });
        assert.equal(result.status, 200, result.message);
        assert.notEqual(result.data.path, previousPath);
        const stored = storedLink(account.id);
        if (days === null) {
          assert.equal(result.data.expires_at, null);
          assert.equal(stored.expires_at, null);
        } else {
          const expiry = Date.parse(result.data.expires_at);
          assert.ok(expiry >= before + days * day && expiry <= Date.now() + days * day);
          assert.equal(stored.expires_at, expiry);
        }
        assert.equal((await publicRead(previousPath)).status, 404);
        previousPath = result.data.path;
      }
    });

    await t.test('ordinary-user import cannot set expiry and claiming or returning preserves an existing lifetime', async () => {
      const { key, label, admin } = fixture();
      const account = (await imported(key, line(label), { expires_in_days: 14 })).accounts[0];
      db.prepare('UPDATE account_share_links SET last_accessed_at=? WHERE account_id=?').run(Date.now() - 60_000, account.id);
      const original = storedLink(account.id);
      const user = userModel.create({ username: 'expiry_user', display_name: '有效期用户', password_hash: hash, role: 'user', source: 'self', must_change_password: false });
      const cookies = new Map<string, string>();
      let csrf = '';
      async function browser(method: string, route: string, body?: unknown) {
        const response = await fetch(`${origin}/api${route}`, {
          method, headers: { Origin: origin, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';')[0], split = pair.indexOf('=');
          cookies.set(pair.slice(0, split), pair.slice(split + 1));
        }
        const json = await response.json() as any;
        if (json.data?.csrfToken) csrf = json.data.csrfToken;
        return { status: response.status, ...json };
      }
      await browser('GET', '/auth/config');
      assert.equal((await browser('POST', '/auth/login', { username: user.username, password })).status, 200);
      const delivery = [account.game_account, account.game_password, account.real_name, account.id_last_six, account.share_url].join('----');
      for (const route of ['/accounts/import', '/accounts/import-preview', '/accounts/import-confirm']) {
        const rejected = await browser('POST', route, { content: delivery, mode: 'skip', share_link_expires_in_days: null });
        assert.equal(rejected.status, 403, `${route}: ${rejected.message}`);
        assert.deepEqual(storedLink(account.id), original);
        assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(account.id) as any).owner_user_id, admin.id);
      }
      const claimed = await browser('POST', '/accounts/import', { content: delivery });
      assert.equal(claimed.status, 200, claimed.message);
      assert.equal(claimed.data.imported, 1);
      assert.deepEqual(storedLink(account.id), { ...original, owner_user_id: user.id });
      assert.equal((await publicRead(account.share_path)).status, 200);
      const beforeReturn = storedLink(account.id);
      assert.equal((await browser('DELETE', `/accounts/${account.id}`)).status, 200);
      assert.deepEqual(storedLink(account.id), { ...beforeReturn, owner_user_id: admin.id });
      assert.equal(storedLink(account.id).expires_at, Date.parse(account.share_link_expires_at));
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
