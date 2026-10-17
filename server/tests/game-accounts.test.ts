import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each node:test file runs in its own process; never open the deployment database.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-game-accounts-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('game account imports, ownership, and single-use claims', async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations, SCHEMA_VERSION } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel } = await import('../src/models/User');
  const { hashPassword } = await import('../src/services/password');
  const { lockResources } = await import('../src/services/resourceAccess');
  const { default: Database } = await import('better-sqlite3');
  logger.silent = true;
  await runMigrations();
  const password = 'game-platform-pass-1234';
  const administrator = userModel.create({ username: 'game_admin', display_name: '游戏管理员', password_hash: await hashPassword(password), role: 'admin', source: 'admin', must_change_password: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function raw(b: Browser, method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = {
      Cookie: [...b.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      Origin: base.replace('/api', ''),
    };
    if (b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      b.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  async function call(b: Browser, method: string, url: string, body?: unknown) {
    const response = await raw(b, method, url, body);
    const json = await response.json() as any;
    if (json.data?.csrfToken) b.csrf = json.data.csrfToken;
    return { status: response.status, ...json };
  }
  const account = (label: string, extra: Record<string, unknown> = {}) => ({
    game_account: `game_${label}`, game_password: `game-secret-${label}`, real_name: '测试姓名',
    id_last_six: '01234X', email: `${label}@example.test`, password: `mail-secret-${label}`,
    client_id: 'test-client-id', refresh_token: `refresh-secret-${label}`, ...extra,
  });
  const accountLine = (label: string) => {
    const data = account(label);
    return [data.game_account, data.game_password, data.real_name, data.id_last_six, data.email, data.password, data.client_id, data.refresh_token].join('----');
  };
  async function create(b: Browser, label: string, extra: Record<string, unknown> = {}) {
    const owner_user_id = b === alice ? aliceId : b === bob ? bobId : administrator.id;
    const result = await call(admin, 'POST', '/accounts', account(label, { owner_user_id, ...extra }));
    assert.equal(result.status, 200, result.message);
    return result.data;
  }
  async function publish(ids: number[]) {
    const result = await call(admin, 'POST', '/accounts/claim-pool', { ids });
    assert.equal(result.status, 200, result.message);
    assert.equal(result.data.claim_codes.length, ids.length);
    return result.data.claim_codes as { account_id: number; game_account: string; code: string; expires_at: string }[];
  }
  function assertUnavailable(response: any) {
    assert.ok([400, 404, 409].includes(response.status), `expected invalid or unavailable claim, received ${response.status}: ${response.message}`);
  }
  const admin = browser(), alice = browser(), bob = browser();
  let aliceId = 0, bobId = 0;
  try {
    await t.test('existing mailbox records migrate without changing mailbox credentials', async () => {
      const legacy = new Database(':memory:');
      try {
        legacy.exec(`CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,password TEXT DEFAULT '',
          client_id TEXT NOT NULL,refresh_token TEXT NOT NULL,status TEXT DEFAULT 'active',last_synced_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
          INSERT INTO accounts(email,password,client_id,refresh_token) VALUES('legacy@example.test','legacy-password','legacy-client','legacy-token');`);
        await runMigrations(legacy, ':memory:');
        await runMigrations(legacy, ':memory:');
        const row = legacy.prepare('SELECT * FROM accounts WHERE id=1').get() as any;
        assert.equal(row.email, 'legacy@example.test');
        assert.equal(row.password, 'legacy-password');
        assert.equal(row.refresh_token, 'legacy-token');
        assert.equal(row.game_account, '');
        assert.equal(row.game_password, '');
        assert.equal(row.real_name, '');
        assert.equal(row.id_last_six, '');
        assert.equal(row.claim_status, 'assigned');
        assert.equal(row.claim_code_hash, null);
        assert.equal((legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version, SCHEMA_VERSION);
        assert.deepEqual(legacy.pragma('foreign_key_check'), []);
      } finally { legacy.close(); }
    });

    await t.test('authenticated users can only see their own plaintext game credentials', async () => {
      await call(admin, 'GET', '/auth/config');
      assert.equal((await call(admin, 'POST', '/auth/login', { username: administrator.username, password })).status, 200);
      for (const [b, username] of [[alice, 'game_alice'], [bob, 'game_bob']] as const) {
        await call(b, 'GET', '/auth/config');
        const registration = await call(b, 'POST', '/auth/register', { username, password });
        assert.equal(registration.status, 200, registration.message);
        if (b === alice) aliceId = registration.data.user.id; else bobId = registration.data.user.id;
      }
      const owned = await create(alice, 'owned');
      const list = await call(alice, 'GET', '/accounts');
      const row = list.data.list.find((item: any) => item.id === owned.id);
      assert.equal(row.game_account, 'game_owned');
      assert.equal(row.game_password, 'game-secret-owned');
      assert.equal(row.real_name, '测试姓名');
      assert.equal(row.id_last_six, '01234X');
      assert.equal(row.email, 'owned@example.test');
      assert.equal(row.password, '');
      assert.equal(row.refresh_token, '');
      assert.equal('claim_code_hash' in row, false);
      assert.equal((await call(bob, 'GET', '/accounts')).data.total, 0);
      assert.equal((await call(bob, 'GET', `/accounts/${owned.id}/credentials`)).status, 404);
      assert.equal((await call(browser(), 'GET', '/accounts')).status, 401);
      const credentials = await call(alice, 'GET', `/accounts/${owned.id}/credentials`);
      assert.equal(credentials.data.password, 'mail-secret-owned');
      assert.equal(credentials.data.refresh_token, 'refresh-secret-owned');
      assert.equal((await call(bob, 'PUT', `/accounts/${owned.id}`, { game_password: 'hijacked' })).status, 404);
      const updated = await call(alice, 'PUT', `/accounts/${owned.id}`, { game_password: 'new-game-password', real_name: '更新姓名', id_last_six: '00123x' });
      assert.equal(updated.status, 200, updated.message);
      assert.equal(updated.data.game_password, 'new-game-password');
      assert.equal(updated.data.id_last_six, '00123X');
    });

    await t.test('eight-column imports preserve ID suffixes, accept mixed valid rows, and preview safely', async () => {
      const preview = await call(admin, 'POST', '/accounts/import-preview', { content: accountLine('imported'), owner_user_id: aliceId });
      assert.equal(preview.status, 200, preview.message);
      assert.equal(preview.data.newItems.length, 1);
      assert.equal(preview.data.errors.length, 0);
      assert.equal(JSON.stringify(preview.data).includes('refresh-secret-imported'), false);
      assert.equal(JSON.stringify(preview.data).includes('mail-secret-imported'), false);
      const imported = await call(admin, 'POST', '/accounts/import-confirm', { content: `${accountLine('imported')}\nnot----enough----columns`, mode: 'skip', owner_user_id: aliceId });
      assert.equal(imported.status, 200, imported.message);
      assert.equal(imported.data.imported, 1);
      assert.equal(imported.data.errors.length, 1);
      const row = (await call(alice, 'GET', '/accounts?search=game_imported')).data.list[0];
      assert.equal(row.game_account, 'game_imported');
      assert.equal(row.real_name, '测试姓名');
      assert.equal(row.id_last_six, '01234X');
      assert.equal(row.game_password, 'game-secret-imported');
      const oldFormat = await call(admin, 'POST', '/accounts/import', { content: 'legacy-import@example.test----mail-pass----client----token', owner_user_id: aliceId });
      assert.equal(oldFormat.status, 200, oldFormat.message);
      assert.equal(oldFormat.data.imported, 1);
    });

    await t.test('legacy mailbox exports round trip through eight columns alongside complete game accounts', async () => {
      const legacy = await call(admin, 'POST', '/accounts', {
        email: 'legacy-roundtrip@example.test', password: 'legacy-roundtrip-password',
        client_id: 'legacy-roundtrip-client', refresh_token: 'legacy-roundtrip-token', owner_user_id: aliceId,
      });
      assert.equal(legacy.status, 200, legacy.message);
      const exported = await call(alice, 'POST', '/accounts/export', { ids: [legacy.data.id] });
      assert.equal(exported.status, 200, exported.message);
      const columns = exported.data.content.split('----');
      assert.equal(columns.length, 8);
      assert.deepEqual(columns.slice(0, 4), ['', '', '', '']);
      assert.equal((await call(admin, 'DELETE', `/accounts/${legacy.data.id}`)).status, 200);

      const partial = account('roundtrip_partial', { game_password: '' });
      const partialLine = [partial.game_account, partial.game_password, partial.real_name, partial.id_last_six, partial.email, partial.password, partial.client_id, partial.refresh_token].join('----');
      const imported = await call(admin, 'POST', '/accounts/import-confirm', {
        content: `${exported.data.content}\n${accountLine('roundtrip_complete')}\n${partialLine}`, mode: 'skip', owner_user_id: aliceId,
      });
      assert.equal(imported.status, 200, imported.message);
      assert.equal(imported.data.imported, 2);
      assert.equal(imported.data.errors.length, 1, 'partly completed game fields must remain invalid');
      assert.equal((await call(alice, 'GET', '/accounts?search=game_roundtrip_partial')).data.total, 0);
      const roundtrip = (await call(alice, 'GET', '/accounts?search=legacy-roundtrip@example.test')).data.list[0];
      assert.ok(roundtrip?.id);
      assert.equal(roundtrip.game_account, '');
      assert.equal(roundtrip.game_password, '');
      assert.equal(roundtrip.real_name, '');
      assert.equal(roundtrip.id_last_six, '');
      const credentials = (await call(alice, 'GET', `/accounts/${roundtrip.id}/credentials`)).data;
      assert.equal(credentials.password, 'legacy-roundtrip-password');
      assert.equal(credentials.client_id, 'legacy-roundtrip-client');
      assert.equal(credentials.refresh_token, 'legacy-roundtrip-token');
      assert.equal((await call(alice, 'GET', '/accounts?search=game_roundtrip_complete')).data.list[0].game_password, 'game-secret-roundtrip_complete');

      const poolLegacyLine = exported.data.content.replace('legacy-roundtrip@example.test', 'pool-legacy-roundtrip@example.test');
      const pool = await call(admin, 'POST', '/accounts/import-confirm', {
        content: `${poolLegacyLine}\n${accountLine('pool_roundtrip_complete')}`, mode: 'skip', placement: 'pool',
      });
      assert.equal(pool.status, 400, 'legacy mailbox rows may not enter the claim pool');
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE email IN (?,?)').get('pool-legacy-roundtrip@example.test', 'pool_roundtrip_complete@example.test') as any).count, 0);
    });

    await t.test('invalid fields and global duplicate identifiers are rejected without partial overwrite', async () => {
      assert.equal((await call(admin, 'POST', '/accounts', account('invalid_id', { id_last_six: '12345', owner_user_id: aliceId }))).status, 400);
      assert.equal((await call(admin, 'POST', '/accounts', account('invalid_id_char', { id_last_six: '12345Q', owner_user_id: aliceId }))).status, 400);
      const injected = await create(alice, 'injected_pool', { claim_status: 'available', claim_code_hash: 'attacker-controlled', claim_code_expires_at: Date.now() + 100000 });
      const stored = db.prepare('SELECT claim_status,claim_code_hash FROM accounts WHERE id=?').get(injected.id) as any;
      assert.equal(stored.claim_status, 'assigned');
      assert.equal(stored.claim_code_hash, null);
      const target = await create(bob, 'collision');
      assert.equal((await call(admin, 'POST', '/accounts', account('duplicate_game', { game_account: 'GAME_COLLISION', owner_user_id: aliceId }))).status, 409);
      assert.equal((await call(admin, 'POST', '/accounts', account('duplicate_mail', { email: 'COLLISION@EXAMPLE.TEST', owner_user_id: aliceId }))).status, 409);
      const before = (await call(alice, 'GET', '/accounts')).data.total;
      const response = await call(admin, 'POST', '/accounts/import-confirm', {
        content: `${accountLine('atomic_new')}\n${accountLine('collision')}`, mode: 'overwrite', owner_user_id: aliceId,
      });
      assert.equal(response.status, 409);
      assert.equal((await call(alice, 'GET', '/accounts')).data.total, before);
      assert.equal((await call(bob, 'GET', `/accounts/${target.id}/credentials`)).data.game_password, 'game-secret-collision');
      const left = await create(alice, 'binding_left'), right = await create(alice, 'binding_right');
      const ambiguous = account('binding_left', { email: 'binding_right@example.test' });
      const content = [ambiguous.game_account, ambiguous.game_password, ambiguous.real_name, ambiguous.id_last_six, ambiguous.email, ambiguous.password, ambiguous.client_id, ambiguous.refresh_token].join('----');
      const conflict = await call(admin, 'POST', '/accounts/import-confirm', { content, mode: 'overwrite', owner_user_id: aliceId });
      assert.equal(conflict.status, 409, 'one row cannot join the game identity of one record to the mailbox of another');
      assert.equal((await call(alice, 'GET', `/accounts/${left.id}/credentials`)).data.email, 'binding_left@example.test');
      assert.equal((await call(alice, 'GET', `/accounts/${right.id}/credentials`)).data.game_account, 'game_binding_right');
    });

    await t.test('imports preserve exact passwords and leading zeroes instead of trimming secrets', async () => {
      const data = account('whitespace', { game_password: ' game password ', password: ' mailbox password ', refresh_token: ' token with trailing space ' });
      const content = [data.game_account, data.game_password, data.real_name, data.id_last_six, data.email, data.password, data.client_id, data.refresh_token].join('----');
      const result = await call(admin, 'POST', '/accounts/import', { content, owner_user_id: aliceId });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, 1);
      const id = (db.prepare('SELECT id FROM accounts WHERE email=?').get(data.email) as any).id;
      const credentials = (await call(alice, 'GET', `/accounts/${id}/credentials`)).data;
      assert.equal(credentials.game_password, data.game_password);
      assert.equal(credentials.password, data.password);
      assert.equal(credentials.refresh_token, data.refresh_token);
      assert.equal(credentials.id_last_six, '01234X');
    });

    await t.test('changing mailbox credentials clears old cache while game-only edits preserve it', async () => {
      const rebinding = await create(alice, 'rebinding');
      const cache = () => {
        db.prepare(`INSERT INTO mail_cache(account_id,mailbox,mail_id,subject,text_content,mail_date)
          VALUES(?,'INBOX','previous-mailbox','旧邮箱验证码','验证码 654321',CURRENT_TIMESTAMP)`).run(rebinding.id);
        db.prepare('UPDATE accounts SET last_synced_at=CURRENT_TIMESTAMP WHERE id=?').run(rebinding.id);
      };
      cache();
      assert.equal((await call(alice, 'PUT', `/accounts/${rebinding.id}`, { real_name: '修改游戏姓名', game_password: 'updated-game-password' })).status, 200);
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${rebinding.id}`)).data.total, 1);
      assert.equal((await call(alice, 'PUT', `/accounts/${rebinding.id}`, { email: 'new-rebinding@example.test' })).status, 200);
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${rebinding.id}`)).data.total, 0);
      assert.equal((db.prepare('SELECT last_synced_at FROM accounts WHERE id=?').get(rebinding.id) as any).last_synced_at, null);
      cache();
      const data = account('rebinding', { email: 'new-rebinding@example.test', refresh_token: 'rebound-refresh-token' });
      const content = [data.game_account, data.game_password, data.real_name, data.id_last_six, data.email, data.password, data.client_id, data.refresh_token].join('----');
      const result = await call(admin, 'POST', '/accounts/import-confirm', { content, mode: 'overwrite', owner_user_id: aliceId });
      assert.equal(result.status, 200, result.message);
      assert.equal(result.data.imported, 1);
      assert.equal((await call(alice, 'GET', `/mails/cached?account_id=${rebinding.id}`)).data.total, 0);
      assert.equal((db.prepare('SELECT last_synced_at FROM accounts WHERE id=?').get(rebinding.id) as any).last_synced_at, null);
    });

    await t.test('only administrators publish claim codes and pool imports stay private until claimed', async () => {
      const response = await call(admin, 'POST', '/accounts/import', { content: accountLine('pool_import'), placement: 'pool' });
      assert.equal(response.status, 200, response.message);
      assert.equal(response.data.imported, 1);
      assert.equal(response.data.claim_codes.length, 1);
      const entry = response.data.claim_codes[0];
      const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(entry.account_id) as any;
      assert.equal(row.owner_user_id, administrator.id);
      assert.equal(row.claim_status, 'available');
      assert.ok(entry.code.length >= 20);
      assert.equal(row.claim_code_hash, createHash('sha256').update(entry.code).digest('hex'));
      assert.notEqual(row.claim_code_hash, entry.code);
      assert.ok(row.claim_code_expires_at > Date.now() + 6 * 86_400_000);
      assert.equal((await call(alice, 'GET', '/accounts?search=pool_import')).data.total, 0);
      assert.equal((await call(alice, 'GET', `/accounts/${row.id}/credentials`)).status, 404);
      const visible = (await call(admin, 'GET', '/accounts?search=pool_import')).data.list[0];
      assert.equal('claim_code_hash' in visible, false);
      assert.equal(JSON.stringify(visible).includes(entry.code), false);
      assert.equal((await call(alice, 'POST', '/accounts/claim-pool', { ids: [row.id] })).status, 403);
      assert.equal((await call(alice, 'POST', '/accounts/import', { content: accountLine('unauthorized_pool'), placement: 'pool' })).status, 403);
      assert.equal((await call(browser(), 'POST', '/accounts/claim', { code: entry.code })).status, 401);
    });

    await t.test('batch publication is atomic and cannot republish another user\'s account', async () => {
      const own = await create(admin, 'batch_publish'), other = await create(bob, 'batch_other'), busy = await create(admin, 'batch_busy');
      const rejected = await call(admin, 'POST', '/accounts/claim-pool', { ids: [own.id, other.id] });
      assert.equal(rejected.status, 400, rejected.message);
      assert.equal((db.prepare('SELECT claim_code_hash FROM accounts WHERE id=?').get(own.id) as any).claim_code_hash, null);
      assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(other.id) as any).owner_user_id, bobId);
      const release = lockResources([busy.id]);
      try {
        assert.equal((await call(admin, 'POST', '/accounts/claim-pool', { ids: [own.id, busy.id] })).status, 409);
        for (const id of [own.id, busy.id]) {
          const row = db.prepare('SELECT claim_status,claim_code_hash FROM accounts WHERE id=?').get(id) as any;
          assert.equal(row.claim_status, 'assigned');
          assert.equal(row.claim_code_hash, null);
        }
      } finally { release(); }
    });

    await t.test('concurrent claims have exactly one winner and move cached mail with the account', async () => {
      const published = await create(admin, 'race');
      const tag = await call(admin, 'POST', '/tags', { name: '发布前标签', color: '#123456' });
      assert.equal(tag.status, 200);
      await call(admin, 'POST', `/accounts/${published.id}/tags`, { tag_ids: [tag.data.id] });
      db.prepare(`INSERT INTO mail_cache(account_id,mailbox,mail_id,subject,text_content,mail_date)
        VALUES(?,'INBOX','claim-test-mail','游戏验证码','验证码 123456',CURRENT_TIMESTAMP)`).run(published.id);
      const [entry] = await publish([published.id]);
      const responses = await Promise.all([call(alice, 'POST', '/accounts/claim', { code: entry.code }), call(bob, 'POST', '/accounts/claim', { code: entry.code })]);
      assert.equal(responses.filter(response => response.status === 200).length, 1);
      assertUnavailable(responses.find(response => response.status !== 200));
      const winnerIndex = responses[0].status === 200 ? 0 : 1;
      const winner = winnerIndex === 0 ? alice : bob, loser = winnerIndex === 0 ? bob : alice;
      const winnerId = winnerIndex === 0 ? aliceId : bobId;
      const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(published.id) as any;
      assert.equal(row.owner_user_id, winnerId);
      assert.equal(row.claim_status, 'assigned');
      assert.equal(row.claim_code_hash, null);
      assert.ok(row.claimed_at);
      assert.equal((await call(winner, 'GET', `/mails/cached?account_id=${published.id}`)).data.total, 1);
      assert.equal((await call(loser, 'GET', `/mails/cached?account_id=${published.id}`)).status, 404);
      const claimed = (await call(winner, 'GET', `/accounts/${published.id}/credentials`)).data;
      assert.equal(claimed.game_password, 'game-secret-race');
      assert.equal(claimed.tags.length, 0);
      assertUnavailable(await call(winner, 'POST', '/accounts/claim', { code: entry.code }));
      // Revoking an already-consumed code never takes ownership away from its claimant.
      assert.equal((await call(admin, 'POST', '/accounts/claim-pool/revoke', { ids: [published.id] })).status, 200);
      assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(published.id) as any).owner_user_id, winnerId);
    });

    await t.test('expired, revoked, replaced, and edited claim codes cannot be reused', async () => {
      const expired = await create(admin, 'expired');
      const [expiredCode] = await publish([expired.id]);
      db.prepare('UPDATE accounts SET claim_code_expires_at=? WHERE id=?').run(Date.now() - 1000, expired.id);
      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: expiredCode.code }));
      assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(expired.id) as any).owner_user_id, administrator.id);

      const revoked = await create(admin, 'revoked');
      const [revokedCode] = await publish([revoked.id]);
      const revocation = await call(admin, 'POST', '/accounts/claim-pool/revoke', { ids: [revoked.id] });
      assert.equal(revocation.status, 200, revocation.message);
      assert.equal(revocation.data.revoked, 1);
      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: revokedCode.code }));

      const replaced = await create(admin, 'replaced');
      const [first] = await publish([replaced.id]), [second] = await publish([replaced.id]);
      assert.notEqual(first.code, second.code);
      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: first.code }));
      assert.equal((await call(alice, 'POST', '/accounts/claim', { code: second.code })).status, 200);

      const edited = await create(admin, 'edited');
      const [editedCode] = await publish([edited.id]);
      assert.equal((await call(admin, 'PUT', `/accounts/${edited.id}`, { game_password: 'changed-after-publication' })).status, 200);
      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: editedCode.code }));
    });

    await t.test('busy resource locks and ownership transfers invalidate outstanding claim codes', async () => {
      const transferring = await create(admin, 'transferring');
      const [entry] = await publish([transferring.id]);
      const release = lockResources([transferring.id]);
      try {
        assert.equal((await call(alice, 'POST', '/accounts/claim', { code: entry.code })).status, 409);
        assert.equal((db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(transferring.id) as any).owner_user_id, administrator.id);
      } finally { release(); }
      assert.equal((await call(admin, 'POST', '/accounts/transfer', { ids: [transferring.id], target_user_id: bobId })).status, 200);
      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: entry.code }));
      assert.equal((await call(bob, 'GET', `/accounts/${transferring.id}/credentials`)).data.game_account, 'game_transferring');
      const audit = await call(admin, 'GET', '/audit?pageSize=500');
      assert.equal(audit.status, 200);
      assert.equal(JSON.stringify(audit).includes(entry.code), false);
      assert.equal(JSON.stringify(audit).includes('game-secret'), false);
      assert.equal(JSON.stringify(audit).includes('refresh-secret'), false);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });

    await t.test('restoring a backup revokes unused claim codes instead of resurrecting consumed codes', async () => {
      const restoredAccount = await create(admin, 'restore_claim');
      const [entry] = await publish([restoredAccount.id]);
      const snapshot = await raw(admin, 'POST', '/backup/download', { password });
      assert.equal(snapshot.status, 200);
      const fileContent = Buffer.from(await snapshot.arrayBuffer()).toString('base64');
      const claimed = await call(alice, 'POST', '/accounts/claim', { code: entry.code });
      assert.equal(claimed.status, 200, claimed.message);
      assert.equal(claimed.data.owner_user_id, aliceId);

      const restored = await call(admin, 'POST', '/backup/restore', { password, fileContent });
      assert.equal(restored.status, 200, restored.message);
      assert.equal((await call(admin, 'GET', '/auth/me')).status, 401);
      assert.equal((await call(alice, 'GET', '/auth/me')).status, 401);
      for (const [b, username] of [[admin, administrator.username], [alice, 'game_alice']] as const) {
        await call(b, 'GET', '/auth/config');
        const login = await call(b, 'POST', '/auth/login', { username, password });
        assert.equal(login.status, 200, login.message);
      }

      assertUnavailable(await call(alice, 'POST', '/accounts/claim', { code: entry.code }));
      const row = db.prepare('SELECT owner_user_id,claim_status,claim_code_hash,claim_code_expires_at FROM accounts WHERE id=?').get(restoredAccount.id) as any;
      assert.equal(row.owner_user_id, administrator.id);
      assert.equal(row.claim_status, 'assigned');
      assert.equal(row.claim_code_hash, null);
      assert.equal(row.claim_code_expires_at, null);
      assert.equal((await call(admin, 'GET', '/accounts?search=game_restore_claim')).data.list[0].claim_status, 'assigned');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
