import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-link-length-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('administrator short-link length applies across generation, delivery, import and public access', async t => {
  const { default: db, closeDatabase, reopenDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { MailService } = await import('../src/services/MailService');
  logger.silent = true;
  await runMigrations();
  const password = 'short-length-password-2026', password_hash = await hashPassword(password);
  const administrator = userModel.create({ username: 'length_admin', display_name: '管理员', password_hash, role: 'admin', source: 'admin', must_change_password: false });
  const owner = userModel.create({ username: 'length_user', display_name: '用户', password_hash, role: 'user', source: 'admin', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function call(b: Browser, method: string, route: string, body?: unknown, csrf = true) {
    const headers: Record<string, string> = { Origin: origin, Cookie: [...b.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (csrf && b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const result = await response.json() as any;
    if (result.data?.csrfToken) b.csrf = result.data.csrfToken;
    return { status: response.status, ...result };
  }
  const admin = browser(), user = browser();
  const data = (label: string) => ({ game_account: `length_${label}`, game_password: `game-pass-${label}`, real_name: '测试姓名', id_last_six: '00123X', email: `${label}@length.test`, password: `mail-pass-${label}`, client_id: `client-${label}`, refresh_token: `refresh-${label}` });
  const line = (label: string) => Object.values(data(label)).join('----');
  const delivery = (label: string, link: string) => [...Object.values(data(label)).slice(0, 4), origin + link].join('----');
  const settings = () => call(admin, 'GET', '/settings');
  async function setLength(length: number) {
    const result = await call(admin, 'PATCH', '/settings', { short_link_length: length });
    assert.equal(result.status, 200, result.message);
    assert.equal(result.data.short_link_length, length);
  }
  async function stock(label: string) {
    const result = await call(admin, 'POST', '/accounts/import-confirm', { content: line(label), mode: 'skip', generate_share_links: true });
    assert.equal(result.status, 200, result.message);
    assert.equal(result.data.imported, 1);
    return { id: (db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data(label).game_account) as any).id as number, path: result.data.share_exports[0].path as string };
  }
  const tokenLength = (value: string) => value.slice('/s/'.length).length;
  const publicDetails = (value: string) => call(browser(), 'GET', '/share/' + value.slice('/s/'.length));
  let legacy: { id: number; path: string }, short: { id: number; path: string }, manualId: number;
  try {
    for (const [b, username] of [[admin, administrator.username], [user, owner.username]] as const) {
      await call(b, 'GET', '/auth/config');
      assert.equal((await call(b, 'POST', '/auth/login', { username, password })).status, 200);
    }
    await t.test('default length remains 22 and only administrators can read or change settings', async () => {
      assert.deepEqual((await settings()).data, { registration_enabled: true, short_link_length: 22 });
      for (const b of [browser(), user]) {
        const expected = b === user ? 403 : 401;
        assert.equal((await call(b, 'GET', '/settings')).status, expected);
        assert.equal((await call(b, 'PATCH', '/settings', { short_link_length: 8 })).status, expected);
      }
      assert.equal((await call(admin, 'PATCH', '/settings', { short_link_length: 8 }, false)).status, 403);
      legacy = await stock('legacy');
      assert.equal(tokenLength(legacy.path), 22);
    });
    await t.test('invalid settings never partially update registration or record a successful change', async () => {
      const before = (await settings()).data;
      const auditCount = () => (db.prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE target_type=?').get('settings') as any).c;
      const beforeAudits = auditCount();
      for (const body of [{}, { unknown: 8 }, { short_link_length: '8' }, { short_link_length: 7 }, { short_link_length: 65 }, { short_link_length: 8.5 }, { short_link_length: null }, { short_link_length: true }, { registration_enabled: false, short_link_length: 7 }, { registration_enabled: 'false', short_link_length: 8 }]) {
        const result = await call(admin, 'PATCH', '/settings', body);
        assert.equal(result.status, 400, JSON.stringify(body));
        assert.deepEqual((await settings()).data, before);
      }
      assert.equal(auditCount(), beforeAudits);
      const registration = await call(admin, 'PATCH', '/settings', { registration_enabled: false });
      assert.deepEqual(registration.data, { registration_enabled: false, short_link_length: 22 });
      const combined = await call(admin, 'PATCH', '/settings', { registration_enabled: true, short_link_length: 8 });
      assert.deepEqual(combined.data, { registration_enabled: true, short_link_length: 8 });
    });
    await t.test('minimum length applies to batch exports and user generation while delivered links remain importable', async () => {
      short = await stock('short');
      assert.equal(tokenLength(short.path), 8);
      const manual = await call(admin, 'POST', '/accounts', { ...data('manual'), owner_user_id: owner.id });
      manualId = manual.data.id;
      const link = await call(user, 'POST', `/accounts/${manualId}/share-link`, { expires_in_days: 7, short_link_length: 1 });
      assert.equal(link.status, 200, link.message);
      assert.equal(tokenLength(link.data.path), 8);
      assert.ok(Date.parse(link.data.expires_at) > Date.now());
      assert.equal((await publicDetails(short.path)).status, 200);
      assert.equal((await settings()).data.short_link_length, 8);
    });
    await t.test('changing length preserves old URLs and valid exported links while new links use the maximum', async () => {
      const snapshots = [legacy.id, short.id].map(id => db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(id));
      await setLength(64);
      assert.equal((await settings()).data.registration_enabled, true);
      assert.equal((await publicDetails(legacy.path)).status, 200);
      assert.equal((await publicDetails(short.path)).status, 200);
      assert.deepEqual([legacy.id, short.id].map(id => db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(id)), snapshots);
      const overwrite = await call(admin, 'POST', '/accounts/import-confirm', { content: line('short'), mode: 'overwrite', generate_share_links: true });
      assert.equal(overwrite.data.share_exports[0].path, short.path);
      const longest = await stock('long');
      assert.equal(tokenLength(longest.path), 64);
      assert.match(longest.path, /^\/s\/[A-Za-z0-9_-]{64}$/);
      for (const [label, record] of [['legacy', legacy], ['short', short], ['long', longest]] as const) {
        const imported = await call(user, 'POST', '/accounts/import', { content: delivery(label, record.path) });
        assert.equal(imported.data.imported, 1, imported.data.errors.join('; '));
        assert.equal((await call(user, 'GET', `/accounts/${record.id}/share-link`)).data.path, record.path);
        assert.equal((await publicDetails(record.path)).status, 200);
      }
      assert.equal((await call(user, 'DELETE', `/accounts/${longest.id}`)).data.action, 'returned');
      assert.equal((await call(user, 'POST', '/accounts/import', { content: delivery('long', longest.path) })).data.imported, 1);
      const mock = t.mock.method(MailService.prototype, 'fetchVerificationMails', async () => ({ mails: [{ mail_id: 'length-code', subject: '游戏验证码 001234', sender: 'game@example.test', mailbox: 'Junk', mail_date: new Date().toISOString(), cached: false }], total: 1, cached: false, partial: false, protocol: 'graph' }));
      try {
        for (const record of [short, longest]) {
          const codes = await call(browser(), 'POST', `/share/${record.path.slice(3)}/verification-code`, {});
          assert.equal(codes.status, 200, codes.message);
          assert.equal(codes.data.mailbox, 'ALL');
          assert.equal(codes.data.candidates[0].code, '001234');
        }
      } finally { mock.mock.restore(); }
    });
    await t.test('resetting uses the new length, revokes the old URL, and configuration survives reconnecting the database', async () => {
      const previous = await call(user, 'GET', `/accounts/${manualId}/share-link`);
      const reset = await call(user, 'POST', `/accounts/${manualId}/share-link`, { expires_in_days: 30 });
      assert.equal(reset.status, 200, reset.message);
      assert.equal(tokenLength(reset.data.path), 64);
      assert.equal((await publicDetails(previous.data.path)).status, 404);
      assert.equal((await publicDetails(reset.data.path)).status, 200);
      await setLength(13);
      closeDatabase(); reopenDatabase();
      assert.equal((await settings()).data.short_link_length, 13);
      const next = await call(user, 'POST', `/accounts/${manualId}/share-link`, {});
      assert.equal(tokenLength(next.data.path), 13);
      assert.equal((await publicDetails(next.data.path)).status, 200);
      assert.ok(db.prepare("SELECT id FROM audit_logs WHERE action='settings.short_link_length_update' AND target_id='short_link_length'").get());
    });
    await t.test('random collisions retry and exhausted generation preserves existing links and batch atomicity', async () => {
      await setLength(8);
      const crypto = await import('crypto');
      const existingToken = 'AAAAAAAA';
      db.prepare('UPDATE account_share_links SET token=? WHERE account_id=?').run(existingToken, legacy.id);
      const manualBefore = db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(manualId);
      let attempts = 0;
      const collision = t.mock.method(crypto.default, 'randomBytes', (size: number) => { attempts++; return Buffer.alloc(size); });
      try {
        const result = await call(user, 'POST', `/accounts/${manualId}/share-link`, {});
        assert.equal(result.status, 409, result.message);
        assert.ok(attempts > 1);
        assert.deepEqual(db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(manualId), manualBefore);
        const batch = await call(admin, 'POST', '/accounts/import-confirm', { content: line('collision'), mode: 'skip', generate_share_links: true });
        assert.equal(batch.status, 409, batch.message);
        assert.equal(db.prepare('SELECT id FROM accounts WHERE game_account=?').get(data('collision').game_account), undefined);
      } finally { collision.mock.restore(); }
      attempts = 0;
      const retry = t.mock.method(crypto.default, 'randomBytes', (size: number) => Buffer.alloc(size, attempts++ === 0 ? 0 : 255));
      try {
        const generated = await call(user, 'POST', `/accounts/${manualId}/share-link`, {});
        assert.equal(generated.status, 200, generated.message);
        assert.equal(tokenLength(generated.data.path), 8);
        assert.notEqual(generated.data.path, '/s/' + existingToken);
        assert.ok(attempts >= 2);
      } finally { retry.mock.restore(); }
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
