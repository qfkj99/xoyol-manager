import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verificationCodeCandidates } from '../src/services/VerificationCodeService';

test('verification codes require context, preserve leading zeros, and use the nearest explicit code', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const mails = [
    { mail_id: 'cn', subject: '游戏登录', text_content: '订单号：123456，您的验证码为：001234，请勿透露。', mail_date: '2026-10-17T11:59:00Z' },
    { mail_id: 'en', subject: 'Security code: AB12CD', mail_date: '2026-10-17T11:58:00Z' },
    { mail_id: 'before', subject: '876543 is your verification code', mail_date: '2026-10-17T11:40:00Z' },
    { mail_id: 'order', subject: '订单123456已完成', text_content: '身份证 123456789012345678 日期 2026-10-17' },
    { mail_id: 'date', subject: '验证码于 2026-10-17 发送', text_content: '本邮件不含号码' },
    { mail_id: 'cn', subject: '游戏登录', text_content: '验证码：001234', mail_date: '2026-10-17T11:59:00Z' },
  ];
  const result = verificationCodeCandidates(mails, now);
  assert.deepEqual(result.map(v => v.code), ['001234', 'AB12CD', '876543']);
  assert.deepEqual(result.map(v => v.recent), [true, true, false]);
  assert.equal(verificationCodeCandidates([{ subject: '验证码001234，请及时使用' }])[0].code, '001234');
});

test('HTML mail is converted to text, script/style ignored, and invalid or future dates not called recent', () => {
  const result = verificationCodeCandidates([
    { mail_id: 'html', html_content: '<style>.code1234{}</style><script>"验证码:123456"</script><p>验证码&#58;</p><strong>&#48;65432</strong>', mail_date: 'invalid' },
    { mail_id: 'future', text_content: 'Your one-time password is 765432', mail_date: '2030-01-01T00:00:00Z' },
  ], Date.parse('2026-10-17T12:00:00Z'));
  assert.deepEqual(result.map(v => v.code), ['765432', '065432']);
  assert.ok(result.every(v => !v.recent));
  assert.equal(verificationCodeCandidates([{ text_content: '验证码 123456789012345678' }]).length, 0);
});

test('verification endpoint enforces ownership and labels cached results without logging codes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-verification-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.COOKIE_SECURE = 'false';
  process.env.APP_ORIGIN = '';
  process.env.TRUST_PROXY = 'false';
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { OAuthService } = await import('../src/services/OAuthService');
  const { GraphApiService } = await import('../src/services/GraphApiService');
  const { ImapService } = await import('../src/services/ImapService');
  const { MailCacheModel } = await import('../src/models/MailCache');
  logger.silent = true;
  await runMigrations();
  const password = 'verification-test-123';
  const adminRecord = userModel.create({ username: 'admin', display_name: '管理员', password_hash: await hashPassword(password), role: 'admin', source: 'admin', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  async function call(b: ReturnType<typeof browser>, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { Cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: origin };
    if (b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const json = await response.json() as any;
    if (json.data?.csrfToken) b.csrf = json.data.csrfToken;
    return { status: response.status, ...json };
  }
  const admin = browser(), alice = browser();
  try {
    await call(admin, 'GET', '/auth/config');
    assert.equal((await call(admin, 'POST', '/auth/login', { username: 'admin', password })).status, 200);
    await call(alice, 'GET', '/auth/config');
    assert.equal((await call(alice, 'POST', '/auth/register', { username: 'alice', password })).status, 200);
    const account = (email: string) => ({ email, password: 'mailpw', client_id: 'client', refresh_token: 'refresh' });
    const live = (await call(admin, 'POST', '/accounts', account('live@example.test'))).data;
    const cached = (await call(admin, 'POST', '/accounts', account('cached@example.test'))).data;
    let microsoftCalls = 0;
    const mailboxes: string[] = [];
    t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => { microsoftCalls++; return { access_token: 'stub', has_mail_scope: true, expires_in: 3600 }; });
    t.mock.method(GraphApiService.prototype, 'fetchMails', async (_token, mailbox, top) => {
      mailboxes.push(mailbox); assert.equal(top, 20);
      return [{ mail_id: 'live', subject: `验证码：${mailbox === 'INBOX' ? '091827' : '004321'}`, sender: 'game@example.test', mail_date: new Date(Date.now() - (mailbox === 'INBOX' ? 60_000 : 0)).toISOString() }];
    });
    assert.equal((await call(browser(), 'POST', '/mails/verification-code', { account_id: live.id })).status, 401);
    assert.equal((await call(alice, 'POST', '/mails/verification-code', { account_id: live.id })).status, 404);
    assert.equal(microsoftCalls, 0);
    const result = await call(admin, 'POST', '/mails/verification-code', { account_id: live.id, mailbox: 'Junk' });
    assert.equal(result.status, 200); assert.equal(result.data.cached, false);
    assert.deepEqual(result.data.candidates.map((candidate: any) => candidate.code), ['004321', '091827']);
    assert.deepEqual(result.data.candidates.map((candidate: any) => candidate.mailbox), ['Junk', 'INBOX']);
    assert.equal(result.data.mailbox, 'ALL'); assert.deepEqual(result.data.mailboxes, ['INBOX', 'Junk']);
    assert.equal(result.data.partial, false); assert.equal(microsoftCalls, 1);
    assert.deepEqual(mailboxes, ['INBOX', 'Junk']);
    assert.equal(result.data.email, 'live@example.test'); assert.ok(result.data.fetched_at);
    assert.equal((await call(admin, 'POST', '/mails/verification-code', { account_id: live.id })).status, 429);
    new MailCacheModel().upsert(cached.id, 'INBOX', [{ mail_id: 'old', subject: '验证码:001199', mail_date: '2020-01-01T00:00:00Z' }]);
    t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => { throw new Error('offline'); });
    t.mock.method(OAuthService.prototype, 'refreshImapToken', async () => { throw new Error('offline'); });
    const fallback = await call(admin, 'POST', '/mails/verification-code', { account_id: cached.id });
    assert.equal(fallback.status, 200); assert.equal(fallback.data.cached, true);
    assert.equal(fallback.data.partial, true); assert.match(fallback.data.warning, /收件箱.*缓存.*垃圾箱/);
    assert.equal(fallback.data.candidates[0].code, '001199'); assert.equal(fallback.data.candidates[0].recent, false);
    assert.equal(fallback.data.candidates[0].cached, true); assert.equal(fallback.data.candidates[0].mailbox, 'INBOX');
    assert.equal((await call(admin, 'POST', '/mails/verification-code', { account_id: live.id, mailbox: 'Other' })).status, 400);
    const audits = db.prepare("SELECT * FROM audit_logs WHERE action='mail.verification-code' AND actor_id=?").all(adminRecord.id);
    assert.equal(audits.length, 2);
    assert.ok(!JSON.stringify(audits).includes('091827')); assert.ok(!JSON.stringify(audits).includes('001199'));

    await t.test('Graph and IMAP can complete different folders while sharing refreshed authorization', async () => {
      const mixed = (await call(admin, 'POST', '/accounts', account('mixed@example.test'))).data;
      let graphRefreshes = 0, imapRefreshes = 0;
      const imapFolders: string[] = [];
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => {
        graphRefreshes++;
        return { access_token: 'graph', refresh_token: 'rotated-graph', has_mail_scope: true, expires_in: 3600 };
      });
      t.mock.method(GraphApiService.prototype, 'fetchMails', async (_token, mailbox) => {
        if (mailbox === 'Junk') throw new Error('Graph folder unavailable');
        return [{ mail_id: 'inbox', subject: '验证码 000111', mail_date: '2026-10-17T11:00:00Z' }];
      });
      t.mock.method(OAuthService.prototype, 'refreshImapToken', async (_client, refresh) => {
        assert.equal(refresh, 'rotated-graph'); imapRefreshes++;
        return { access_token: 'imap', refresh_token: 'rotated-imap', expires_in: 3600 };
      });
      t.mock.method(ImapService.prototype, 'fetchMails', async (_email, _auth, mailbox) => {
        imapFolders.push(mailbox);
        return [{ mail_id: 'junk', subject: '验证码 000222', mail_date: '2026-10-17T12:00:00Z' }];
      });
      const response = await call(admin, 'POST', '/mails/verification-code', { account_id: mixed.id });
      assert.equal(response.status, 200, response.message);
      assert.equal(response.data.protocol, 'mixed'); assert.equal(response.data.partial, false);
      assert.deepEqual(response.data.candidates.map((candidate: any) => candidate.code), ['000222', '000111']);
      assert.deepEqual(imapFolders, ['Junk']); assert.equal(graphRefreshes, 1); assert.equal(imapRefreshes, 1);
      assert.equal((db.prepare('SELECT refresh_token FROM accounts WHERE id=?').get(mixed.id) as any).refresh_token, 'rotated-imap');
    });

    await t.test('a failed folder contributes clearly labeled cached candidates without hiding live codes', async () => {
      const partial = (await call(admin, 'POST', '/accounts', account('partial@example.test'))).data;
      new MailCacheModel().upsert(partial.id, 'Junk', [{ mail_id: 'cached-junk', subject: '验证码 000333', mail_date: '2020-01-01T00:00:00Z' }]);
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => ({ access_token: 'graph', has_mail_scope: true, expires_in: 3600 }));
      t.mock.method(GraphApiService.prototype, 'fetchMails', async (_token, mailbox) => {
        if (mailbox === 'Junk') throw new Error('offline');
        return [{ mail_id: 'live-inbox', subject: '验证码 000444', mail_date: new Date().toISOString() }];
      });
      t.mock.method(OAuthService.prototype, 'refreshImapToken', async () => { throw new Error('offline'); });
      const response = await call(admin, 'POST', '/mails/verification-code', { account_id: partial.id, mailbox: 'INBOX' });
      assert.equal(response.status, 200, response.message); assert.equal(response.data.partial, true); assert.equal(response.data.cached, true);
      assert.match(response.data.warning, /垃圾箱实时读取失败.*历史缓存/);
      assert.deepEqual(response.data.candidates.map((candidate: any) => [candidate.code, candidate.mailbox, candidate.cached]), [['000444', 'INBOX', false], ['000333', 'Junk', true]]);
      assert.equal((db.prepare('SELECT COUNT(*) AS total FROM mail_cache WHERE account_id=? AND mailbox=?').get(partial.id, 'INBOX') as any).total, 1);
    });

    await t.test('an empty successful folder remains usable with a warning, and total failure without cache returns 502', async () => {
      const empty = (await call(admin, 'POST', '/accounts', account('empty-folder@example.test'))).data;
      const failed = (await call(admin, 'POST', '/accounts', account('failed-folder@example.test'))).data;
      t.mock.method(GraphApiService.prototype, 'fetchMails', async (_token, mailbox) => {
        if (mailbox === 'Junk') throw new Error('offline');
        return [];
      });
      const response = await call(admin, 'POST', '/mails/verification-code', { account_id: empty.id });
      assert.equal(response.status, 200, response.message); assert.equal(response.data.partial, true); assert.equal(response.data.cached, false);
      assert.deepEqual(response.data.candidates, []); assert.match(response.data.warning, /垃圾箱.*暂无历史缓存/);
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => { throw new Error('offline'); });
      assert.equal((await call(admin, 'POST', '/mails/verification-code', { account_id: failed.id })).status, 502);
    });

    await t.test('IMAP-only accounts read both folders with a single protocol refresh and rotated token', async () => {
      const imapOnly = (await call(admin, 'POST', '/accounts', account('imap-only@example.test'))).data;
      let graphRefreshes = 0, imapRefreshes = 0;
      const imapFolders: string[] = [];
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => {
        graphRefreshes++;
        return { access_token: 'no-mail-scope', refresh_token: 'graph-scope-rotation', has_mail_scope: false, expires_in: 3600 };
      });
      t.mock.method(OAuthService.prototype, 'refreshImapToken', async (_client, refresh) => {
        assert.equal(refresh, 'graph-scope-rotation'); imapRefreshes++;
        return { access_token: 'imap', refresh_token: 'imap-scope-rotation', expires_in: 3600 };
      });
      t.mock.method(ImapService.prototype, 'fetchMails', async (_email, _auth, mailbox) => { imapFolders.push(mailbox); return []; });
      const response = await call(admin, 'POST', '/mails/verification-code', { account_id: imapOnly.id });
      assert.equal(response.status, 200, response.message); assert.equal(response.data.protocol, 'imap');
      assert.deepEqual(imapFolders, ['INBOX', 'Junk']); assert.equal(graphRefreshes, 1); assert.equal(imapRefreshes, 1);
    });

    await t.test('two-folder verification consumes exactly one user rate-budget entry per operation', async () => {
      const budgetUser = userModel.create({ username: 'budget_user', display_name: '限流测试', password_hash: await hashPassword(password), role: 'user', source: 'admin', must_change_password: false });
      const userBrowser = browser();
      await call(userBrowser, 'GET', '/auth/config');
      assert.equal((await call(userBrowser, 'POST', '/auth/login', { username: budgetUser.username, password })).status, 200);
      let oauthCalls = 0, graphCalls = 0;
      t.mock.method(OAuthService.prototype, 'refreshGraphToken', async () => {
        oauthCalls++; return { access_token: 'graph', has_mail_scope: true, expires_in: 3600 };
      });
      t.mock.method(GraphApiService.prototype, 'fetchMails', async () => { graphCalls++; return []; });
      for (let i = 0; i < 31; i++) {
        const created = await call(admin, 'POST', '/accounts', { ...account(`budget-${i}@example.test`), owner_user_id: budgetUser.id });
        assert.equal(created.status, 200, created.message);
        const response = await call(userBrowser, 'POST', '/mails/verification-code', { account_id: created.data.id });
        assert.equal(response.status, i < 30 ? 200 : 429, response.message);
      }
      assert.equal(oauthCalls, 30); assert.equal(graphCalls, 60);
    });
  } finally {
    t.mock.restoreAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
