import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercise the real HTTP middleware and restore path against an isolated database.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-short-links-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('account short links expose only the selected account and remain revocable', { timeout: 30_000 }, async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { MailService } = await import('../src/services/MailService');
  const { OAuthService } = await import('../src/services/OAuthService');
  const { GraphApiService } = await import('../src/services/GraphApiService');
  logger.silent = true;
  const requestLogs: string[] = [];
  t.mock.method(logger, 'info', (...args: unknown[]) => { requestLogs.push(JSON.stringify(args)); return logger; });
  t.mock.method(logger, 'error', (...args: unknown[]) => { requestLogs.push(JSON.stringify(args)); return logger; });
  await runMigrations();
  const password = 'short-links-password-2026';
  const hash = await hashPassword(password);
  const adminRecord = userModel.create({ username: 'share_admin', display_name: '管理员', password_hash: hash, role: 'admin', source: 'admin', must_change_password: false });
  const aliceRecord = userModel.create({ username: 'share_alice', display_name: '用户甲', password_hash: hash, role: 'user', source: 'self', must_change_password: false });
  const bobRecord = userModel.create({ username: 'share_bob', display_name: '用户乙', password_hash: hash, role: 'user', source: 'self', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function raw(b: Browser, method: string, url: string, body?: unknown, csrf = true) {
    const headers: Record<string, string> = { Origin: origin, Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (csrf && b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  async function call(b: Browser, method: string, url: string, body?: unknown, csrf = true) {
    const response = await raw(b, method, url, body, csrf);
    const json = await response.json() as any;
    if (json.data?.csrfToken) b.csrf = json.data.csrfToken;
    return { status: response.status, headers: response.headers, ...json };
  }
  const admin = browser(), alice = browser(), bob = browser();
  const accountData = (label: string) => ({
    game_account: `share_game_${label}`, game_password: `game-password-${label}`, real_name: '测试姓名',
    id_last_six: '00123X', email: `${label}@example.test`, password: `mail-password-${label}`,
    client_id: `client-${label}`, refresh_token: `refresh-${label}`, remark: `账号备注 ${label}`,
  });
  async function login(b: Browser, username: string) {
    await call(b, 'GET', '/auth/config');
    const response = await call(b, 'POST', '/auth/login', { username, password });
    assert.equal(response.status, 200, response.message);
  }
  async function create(b: Browser, label: string) {
    const ownerId = b === alice ? aliceRecord.id : b === bob ? bobRecord.id : adminRecord.id;
    const response = await call(admin, 'POST', '/accounts', { ...accountData(label), owner_user_id: ownerId });
    assert.equal(response.status, 200, response.message);
    return response.data as { id: number };
  }
  const tokens: string[] = [];
  async function publish(b: Browser, id: number, expires_in_days?: 7 | 30 | null) {
    const response = await call(b, 'POST', `/accounts/${id}/share-link`, expires_in_days === undefined ? {} : { expires_in_days });
    assert.equal(response.status, 200, response.message);
    assert.equal(response.data.enabled, true);
    assert.match(response.data.path, /^\/s\/[A-Za-z0-9_-]{22,}$/);
    const token = response.data.path.slice('/s/'.length) as string;
    tokens.push(token);
    return { ...response.data, token } as { enabled: boolean; path: string; token: string; created_at: string; expires_at: string | null };
  }
  const shared = (token: string) => `/share/${token}`;
  async function unavailable(token: string) {
    const result = await call(browser(), 'GET', shared(token));
    assert.equal(result.status, 404, result.message);
    assert.equal(JSON.stringify(result).includes('game-password-'), false);
    return result.message;
  }
  try {
    await login(admin, adminRecord.username);
    await login(alice, aliceRecord.username);
    await login(bob, bobRecord.username);

    await t.test('only the owner or administrator can manage a link and writes retain CSRF protection', async () => {
      const account = await create(alice, 'permissions');
      assert.equal((await call(browser(), 'GET', `/accounts/${account.id}/share-link`)).status, 401);
      for (const method of ['GET', 'POST', 'DELETE']) {
        assert.equal((await call(bob, method, `/accounts/${account.id}/share-link`, method === 'POST' ? {} : undefined)).status, 404);
      }
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).data.enabled, false);
      assert.equal((await call(alice, 'POST', `/accounts/${account.id}/share-link`, {}, false)).status, 403);
      assert.equal((await call(alice, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: 0 })).status, 400);
      assert.equal((await call(alice, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: 365 })).status, 400);
      const link = await publish(alice, account.id, 7);
      assert.ok(Date.parse(link.expires_at!) > Date.now() + 6 * 86400_000);
      assert.equal((await call(admin, 'GET', `/accounts/${account.id}/share-link`)).data.path, link.path);
      assert.equal((await call(alice, 'DELETE', `/accounts/${account.id}/share-link`, undefined, false)).status, 403);
      assert.equal((await call(admin, 'DELETE', `/accounts/${account.id}/share-link`)).status, 200);
      await unavailable(link.token);
    });

    await t.test('anonymous visitors receive the eight plaintext fields without internal or unrelated data', async () => {
      const account = await create(alice, 'plaintext');
      await create(bob, 'private_other');
      const link = await publish(alice, account.id);
      assert.equal(link.expires_at, null);
      const response = await call(browser(), 'GET', shared(link.token));
      assert.equal(response.status, 200, response.message);
      for (const [field, value] of Object.entries(accountData('plaintext'))) assert.equal(response.data[field], value, field);
      assert.equal(response.data.status, 'active');
      assert.equal(response.data.expires_at, null);
      for (const field of ['id', 'owner_user_id', 'owner_username', 'owner_display_name', 'tags', 'claim_code_hash', 'claim_code_expires_at', 'share_token', 'created_at']) {
        assert.equal(field in response.data, false, `${field} must not be public`);
      }
      assert.equal(JSON.stringify(response.data).includes('private_other'), false);
      assert.match(response.headers.get('cache-control') || '', /no-store/i);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('x-robots-tag') || '', /noindex/i);
      assert.equal((await call(browser(), 'GET', '/accounts')).status, 401);
      assert.equal((await call(browser(), 'GET', `/accounts/${account.id}/credentials`)).status, 401);
      assert.equal((await call(browser(), 'DELETE', shared(link.token))).status, 401);
      const page = await fetch(origin + link.path);
      if (fs.existsSync(path.resolve(__dirname, '../../web/dist/index.html'))) assert.equal(page.status, 200);
      assert.match(page.headers.get('cache-control') || '', /no-store/i);
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(page.headers.get('x-robots-tag') || '', /noindex/i);
    });

    await t.test('public verification works without session or CSRF and cannot select another account or proxy', async () => {
      const account = await create(alice, 'verification');
      const other = await create(bob, 'verification_other');
      const link = await publish(alice, account.id);
      const mailRequests: unknown[][] = [];
      const mailMock = t.mock.method(MailService.prototype, 'fetchVerificationMails', async (...args: unknown[]) => {
        mailRequests.push(args);
        return { mails: [{ mail_id: 'mail-one', subject: '游戏验证码 001234', sender: 'game@example.test', mail_date: new Date().toISOString(), mailbox: 'Junk', cached: false }], total: 1, cached: false, protocol: 'graph', partial: false };
      });
      try {
        for (const headers of [
          { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
          { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
        ]) {
          const blocked = await fetch(`${origin}/api${shared(link.token)}/verification-code`, { method: 'POST', headers, body: '{}' });
          assert.equal(blocked.status, 403);
        }
        const nonJson = await fetch(`${origin}/api${shared(link.token)}/verification-code`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' });
        assert.equal(nonJson.status, 415);
        assert.equal(mailRequests.length, 0, 'invalid request sources must not trigger Microsoft access');
        const result = await call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'Junk' }, false);
        assert.equal(result.status, 200, result.message);
        assert.equal(result.data.email, 'verification@example.test');
        assert.equal(result.data.mailbox, 'ALL');
        assert.deepEqual(result.data.mailboxes, ['INBOX', 'Junk']);
        assert.equal(result.data.candidates[0].mailbox, 'Junk');
        assert.equal(result.data.candidates[0].code, '001234');
        assert.equal(result.data.cached, false);
        assert.equal((mailRequests[0][0] as any).id, aliceRecord.id);
        assert.equal(mailRequests[0][1], account.id);
        assert.equal(mailRequests[0][2], undefined);
        assert.equal(mailRequests[0][3], 20);
        assert.equal(typeof mailRequests[0][4], 'function');
        assert.match(result.headers.get('cache-control') || '', /no-store/i);
        assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
        const injected = await call(browser(), 'POST', `${shared(link.token)}/verification-code`, { account_id: other.id, proxy_id: 123, mailbox: 'INBOX' }, false);
        assert.equal(injected.status, 400, 'resource-selection fields must be rejected');
        assert.equal(mailRequests.length, 1, 'injected resource identifiers must not trigger a mailbox request');
        assert.equal((await call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'Other' }, false)).status, 400);
        assert.equal((await call(browser(), 'POST', `/accounts/${account.id}/share-link`, {}, false)).status, 401);
        assert.equal((await call(alice, 'POST', `/accounts/${account.id}/share-link`, {}, false)).status, 403);
      } finally { mailMock.mock.restore(); }
    });

    await t.test('reset, expiry, revocation, account deletion, and disabled owners all hide links uniformly', async () => {
      const invalidMessage = await unavailable('invalid-token');
      const account = await create(alice, 'lifecycle');
      const first = await publish(alice, account.id, 30);
      const second = await publish(alice, account.id, null);
      assert.notEqual(first.token, second.token);
      assert.equal(await unavailable(first.token), invalidMessage);
      db.prepare('UPDATE account_share_links SET expires_at=? WHERE account_id=?').run(Date.now() - 1, account.id);
      assert.equal(await unavailable(second.token), invalidMessage);
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).data.enabled, false);
      const third = await publish(alice, account.id);
      assert.equal((await call(alice, 'DELETE', `/accounts/${account.id}/share-link`)).status, 200);
      assert.equal(await unavailable(third.token), invalidMessage);
      const fourth = await publish(alice, account.id);
      assert.equal((await call(admin, 'DELETE', `/accounts/${account.id}`)).status, 200);
      assert.equal(await unavailable(fourth.token), invalidMessage);
      const disabled = await create(bob, 'disabled_owner');
      const disabledLink = await publish(bob, disabled.id);
      assert.equal((await call(admin, 'PATCH', `/users/${bobRecord.id}`, { status: 'disabled' })).status, 200);
      assert.equal(await unavailable(disabledLink.token), invalidMessage);
      assert.equal((await call(admin, 'PATCH', `/users/${bobRecord.id}`, { status: 'active' })).status, 200);
      await login(bob, bobRecord.username);
    });

    await t.test('manual transfer revokes links while code import preserves the delivered link', async () => {
      const account = await create(alice, 'transferring');
      const link = await publish(alice, account.id);
      assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [account.id], target_user_id: bobRecord.id })).status, 200);
      await unavailable(link.token);
      assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [account.id], target_user_id: aliceRecord.id })).status, 200);
      await unavailable(link.token);
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).data.enabled, false);
      const claimable = await create(admin, 'claimable');
      const claimLink = await publish(admin, claimable.id);
      const pool = await call(admin, 'POST', '/accounts/claim-pool', { ids: [claimable.id] });
      assert.equal(pool.status, 200, pool.message);
      const claimed = await call(alice, 'POST', '/accounts/claim', { code: pool.data.claim_codes[0].code });
      assert.equal(claimed.status, 200, claimed.message);
      const inherited = await call(alice, 'GET', `/accounts/${claimable.id}/share-link`);
      assert.equal(inherited.status, 200, inherited.message);
      assert.equal(inherited.data.enabled, true);
      assert.equal(inherited.data.path, claimLink.path);
      assert.equal(inherited.data.created_at, claimLink.created_at);
      assert.equal(inherited.data.expires_at, claimLink.expires_at);
      const publicAccount = await call(browser(), 'GET', shared(claimLink.token));
      assert.equal(publicAccount.status, 200, publicAccount.message);
      assert.equal(publicAccount.data.game_account, accountData('claimable').game_account);
    });

    await t.test('a pending mail response is withheld after revocation, reset, or mailbox credential changes', async () => {
      for (const operation of ['revoke', 'reset', 'rebind'] as const) {
        const account = await create(alice, `pending_${operation}`);
        const link = await publish(alice, account.id);
        let entered!: () => void, resolveMail!: (value: any) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const result = new Promise<any>(resolve => { resolveMail = resolve; });
        const mailMock = t.mock.method(MailService.prototype, 'fetchVerificationMails', async () => { entered(); return result; });
        try {
          const pending = call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'INBOX' }, false);
          await started;
          if (operation === 'revoke') assert.equal((await call(alice, 'DELETE', `/accounts/${account.id}/share-link`)).status, 200);
          else if (operation === 'reset') await publish(alice, account.id);
          else db.prepare('UPDATE accounts SET refresh_token=? WHERE id=?').run('different-mailbox-authorization', account.id);
          resolveMail({ mails: [{ subject: '验证码 009988', mail_id: operation }], total: 1, cached: false, protocol: 'graph' });
          const response = await pending;
          assert.equal(response.status, 404, response.message);
          assert.equal(JSON.stringify(response).includes('009988'), false);
        } finally { resolveMail?.({ mails: [], total: 0, cached: false, protocol: 'graph' }); mailMock.mock.restore(); }
      }
    });

    await t.test('real mail awaits revalidate links before storing rotated credentials or cached messages', async () => {
      for (const phase of ['oauth', 'graph', 'junk'] as const) {
        const account = await create(alice, `await_${phase}`);
        const link = await publish(alice, account.id);
        let entered!: () => void, resolveOperation!: (value: any) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const operation = new Promise<any>(resolve => { resolveOperation = resolve; });
        let graphCalls = 0;
        const oauthMock = t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => {
          if (phase === 'oauth') { entered(); return operation; }
          return { access_token: 'stub-access', has_mail_scope: true, refresh_token: 'valid-rotated-refresh', expires_in: 3600 };
        });
        const graphMock = t.mock.method(GraphApiService.prototype, 'fetchMails', async () => {
          graphCalls++;
          if (phase === 'graph' || (phase === 'junk' && graphCalls === 2)) { entered(); return operation; }
          return [{ mail_id: 'should-not-fetch', subject: '验证码 004455' }];
        });
        try {
          const pending = call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'INBOX' }, false);
          await started;
          assert.equal((await call(alice, 'DELETE', `/accounts/${account.id}/share-link`)).status, 200);
          resolveOperation(phase === 'oauth'
            ? { access_token: 'stub-access', has_mail_scope: true, refresh_token: 'unauthorized-rotated-refresh', expires_in: 3600 }
            : [{ mail_id: 'revoked-mail', subject: '验证码 004455' }]);
          const response = await pending;
          assert.equal(response.status, 404, response.message);
          assert.equal(JSON.stringify(response).includes('004455'), false);
          const stored = db.prepare('SELECT refresh_token,last_synced_at FROM accounts WHERE id=?').get(account.id) as any;
          assert.equal(stored.refresh_token, phase === 'oauth' ? `refresh-await_${phase}` : 'valid-rotated-refresh');
          assert.equal(stored.last_synced_at, null);
          assert.equal((db.prepare('SELECT COUNT(*) AS total FROM mail_cache WHERE account_id=?').get(account.id) as any).total, 0);
          assert.equal(graphCalls, phase === 'oauth' ? 0 : phase === 'junk' ? 2 : 1);
        } finally { resolveOperation?.([]); oauthMock.mock.restore(); graphMock.mock.restore(); }
      }
    });

    await t.test('real mail fetching keeps mailbox authorization scoped and enforces repeated-fetch limits', async () => {
      const account = await create(alice, 'real_fetch');
      const link = await publish(alice, account.id);
      const tokenRequests: unknown[][] = [];
      const graphRequests: unknown[][] = [];
      const oauthMock = t.mock.method(OAuthService.prototype, 'refreshGraphToken', async (...args: unknown[]) => {
        tokenRequests.push(args);
        return { access_token: 'short-link-graph-token', has_mail_scope: true, expires_in: 3600 };
      });
      const graphMock = t.mock.method(GraphApiService.prototype, 'fetchMails', async (...args: unknown[]) => {
        graphRequests.push(args);
        return [{ mail_id: 'scoped', subject: '验证码 007788', mail_date: new Date().toISOString() }];
      });
      try {
        const response = await call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'INBOX' }, false);
        assert.equal(response.status, 200, response.message);
        assert.equal(response.data.candidates[0].code, '007788');
        assert.deepEqual(tokenRequests[0].slice(0, 2), ['client-real_fetch', 'refresh-real_fetch']);
        assert.deepEqual(graphRequests[0].slice(0, 3), ['short-link-graph-token', 'INBOX', 20]);
        assert.deepEqual(graphRequests[1].slice(0, 3), ['short-link-graph-token', 'Junk', 20]);
        assert.equal(graphRequests.length, 2);
        assert.equal(response.data.candidates.length, 2, 'identical IDs from different folders must retain their source');
        assert.equal((await call(browser(), 'POST', `${shared(link.token)}/verification-code`, { mailbox: 'Junk' }, false)).status, 429);
        assert.equal(tokenRequests.length, 1);
      } finally { oauthMock.mock.restore(); graphMock.mock.restore(); }
    });

    await t.test('backup restoration cannot resurrect a revoked short link', async () => {
      const account = await create(alice, 'backup_restore');
      const link = await publish(alice, account.id);
      const snapshot = await raw(admin, 'POST', '/backup/download', { password });
      assert.equal(snapshot.status, 200);
      const fileContent = Buffer.from(await snapshot.arrayBuffer()).toString('base64');
      assert.equal((await call(alice, 'DELETE', `/accounts/${account.id}/share-link`)).status, 200);
      const restored = await call(admin, 'POST', '/backup/restore', { password, fileContent });
      assert.equal(restored.status, 200, restored.message);
      await unavailable(link.token);
      assert.equal((await call(admin, 'GET', '/auth/me')).status, 401);
      await login(admin, adminRecord.username);
      await login(alice, aliceRecord.username);
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).data.enabled, false);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });

    await t.test('anonymous guessing and verification requests have an IP budget', async () => {
      for (const [method, suffix, maximum] of [['POST', '/verification-code', 35], ['GET', '', 125]] as const) {
        let limited = false;
        for (let attempt = 0; attempt < maximum; attempt++) {
          const response = await call(browser(), method, `${shared('unavailable-token')}${suffix}`, method === 'POST' ? {} : undefined, false);
          if (response.status === 429) { limited = true; break; }
          assert.equal(response.status, 404, response.message);
        }
        assert.equal(limited, true, `${method} requests were never rate limited`);
      }
    });

    await t.test('request and audit logs contain no share token, passwords, or verification codes', async () => {
      const logs = JSON.stringify(requestLogs) + JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
      for (const token of tokens) assert.equal(logs.includes(token), false, 'short-link bearer token leaked into a log');
      for (const secret of ['game-password-', 'mail-password-', 'refresh-real_fetch', '001234', '007788', '009988', '004455']) {
        assert.equal(logs.includes(secret), false, `secret ${secret} leaked into a log`);
      }
    });
  } finally {
    t.mock.restoreAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
