import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-account-return-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.COOKIE_SECURE = 'false';
process.env.APP_ORIGIN = '';
process.env.TRUST_PROXY = 'false';

test('user deletion returns account inventory and administrator deletion remains permanent', async t => {
  const { default: db, closeDatabase } = await import('../src/database');
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { default: logger } = await import('../src/utils/logger');
  const { userModel, publicUser } = await import('../src/models/User');
  const { AccountModel } = await import('../src/models/Account');
  const { TagModel } = await import('../src/models/Tag');
  const { hashPassword } = await import('../src/services/password');
  const { lockResources } = await import('../src/services/resourceAccess');
  logger.silent = true;
  await runMigrations();
  const password = 'return-inventory-platform-pass-1234', passwordHash = await hashPassword(password);
  function createUser(username: string, role: 'admin' | 'user') {
    return publicUser(userModel.create({ username, display_name: username, password_hash: passwordHash, role, source: 'admin', must_change_password: false }));
  }
  const earliest = createUser('return_first_admin', 'admin');
  const source = createUser('return_source_admin', 'admin');
  const otherAdmin = createUser('return_other_admin', 'admin');
  const aliceUser = createUser('return_alice', 'user');
  const bobUser = createUser('return_bob', 'user');
  const transferUser = createUser('return_transfer', 'user');
  const model = new AccountModel(), tags = new TagModel();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = () => ({ cookies: new Map<string, string>(), csrf: '' });
  type Browser = ReturnType<typeof browser>;
  async function call(b: Browser, method: string, route: string, body?: unknown) {
    const headers: Record<string, string> = { Cookie: [...b.cookies].map(([key, value]) => `${key}=${value}`).join('; '), Origin: origin };
    if (b.csrf) headers['X-CSRF-Token'] = b.csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], separator = pair.indexOf('=');
      b.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const result = await response.json() as any;
    if (result.data?.csrfToken) b.csrf = result.data.csrfToken;
    return { status: response.status, ...result };
  }
  const data = (label: string) => ({
    game_account: `return_${label}`, game_password: `game-pass-${label}`, real_name: '回收测试姓名',
    id_last_six: '00123X', email: `${label}@return.test`, password: `mail-pass-${label}`,
    client_id: `client-${label}`, refresh_token: `token-${label}`,
  });
  const line = (label: string) => Object.values(data(label)).join('----');
  const stored = (id: number) => db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as any;
  const share = (id: number) => db.prepare('SELECT * FROM account_share_links WHERE account_id=?').get(id) as any;
  function stock(label: string, administrator = source) {
    const result = model.importConfirm(administrator, { content: line(label), mode: 'skip', generate_share_links: true });
    assert.equal(result.imported, 1);
    const account = db.prepare('SELECT * FROM accounts WHERE game_account=?').get(data(label).game_account) as any;
    return { id: account.id as number, delivery: [data(label).game_account, data(label).game_password, data(label).real_name, data(label).id_last_six, origin + result.share_exports![0].path].join('----') };
  }
  function owned(label: string, user = aliceUser, administrator = source) {
    const account = stock(label, administrator);
    assert.equal(model.import(user, { content: account.delivery }).imported, 1);
    return account;
  }
  function cacheAndTag(id: number, user = aliceUser) {
    db.prepare("INSERT INTO mail_cache(account_id,mailbox,mail_id,subject,text_content) VALUES(?,'INBOX',?,'游戏验证码','001234')").run(id, `inbox-${id}`);
    db.prepare("INSERT INTO mail_cache(account_id,mailbox,mail_id,subject,text_content) VALUES(?,'Junk',?,'游戏验证码','567890')").run(id, `junk-${id}`);
    const tag = tags.create(user, `tag-${id}`);
    tags.setAccountTags(user, id, [tag.id]);
    return tag.id;
  }
  function snapshot(ids: number[]) {
    return ids.map(id => ({ account: stored(id), share: share(id),
      cache: db.prepare('SELECT * FROM mail_cache WHERE account_id=? ORDER BY id').all(id),
      tags: db.prepare('SELECT * FROM account_tags WHERE account_id=? ORDER BY tag_id').all(id),
    }));
  }
  const admin = browser(), sourceBrowser = browser(), alice = browser(), bob = browser();
  try {
    for (const [b, user] of [[admin, earliest], [sourceBrowser, source], [alice, aliceUser], [bob, bobUser]] as const) {
      await call(b, 'GET', '/auth/config');
      assert.equal((await call(b, 'POST', '/auth/login', { username: user.username, password })).status, 200);
    }

    await t.test('recording and transferring accounts preserves the correct inventory administrator', async () => {
      const administratorOwned = await call(admin, 'POST', '/accounts', { ...data('admin-created'), owner_user_id: source.id });
      assert.equal(administratorOwned.status, 200, administratorOwned.message);
      assert.equal(stored(administratorOwned.data.id).inventory_admin_id, source.id);
      const userOwned = await call(sourceBrowser, 'POST', '/accounts', { ...data('user-created'), owner_user_id: transferUser.id });
      assert.equal(userOwned.status, 200, userOwned.message);
      assert.equal(stored(userOwned.data.id).inventory_admin_id, source.id);
      const imported = model.importConfirm(earliest, { content: line('admin-destination'), mode: 'skip', owner_user_id: source.id });
      assert.equal(imported.imported, 1);
      const account = db.prepare('SELECT * FROM accounts WHERE game_account=?').get(data('admin-destination').game_account) as any;
      assert.equal(account.inventory_admin_id, source.id);
      const direct = model.importConfirm(source, { content: line('user-destination'), mode: 'skip', owner_user_id: transferUser.id });
      assert.equal(direct.imported, 1);
      const directAccount = db.prepare('SELECT * FROM accounts WHERE game_account=?').get(data('user-destination').game_account) as any;
      assert.equal(directAccount.inventory_admin_id, source.id);
      model.transfer(earliest, [account.id], aliceUser.id);
      assert.equal(stored(account.id).inventory_admin_id, source.id);
      model.transferResources(earliest, transferUser.id, bobUser.id);
      assert.equal(stored(userOwned.data.id).inventory_admin_id, source.id);
      assert.equal(stored(directAccount.id).inventory_admin_id, source.id);
    });

    await t.test('single deletion returns to the source administrator with credentials, mail, and delivered URL intact', async () => {
      const account = stock('single');
      const limited = await call(sourceBrowser, 'POST', `/accounts/${account.id}/share-link`, { expires_in_days: 7 });
      assert.equal(limited.status, 200, limited.message);
      const delivery = [...Object.values(data('single')).slice(0, 4), origin + limited.data.path].join('----');
      assert.equal((await call(alice, 'POST', '/accounts/import', { content: delivery })).data.imported, 1);
      const tagId = cacheAndTag(account.id);
      db.prepare("UPDATE accounts SET status='error',remark='保留备注',last_synced_at='2026-01-01 01:00:00',token_refreshed_at='2026-01-01 02:00:00',claim_code_hash='stale-return-code',claim_code_expires_at=? WHERE id=?").run(Date.now() + 100000, account.id);
      const before = snapshot([account.id])[0];
      const result = await call(alice, 'DELETE', `/accounts/${account.id}`);
      assert.equal(result.status, 200, result.message);
      assert.deepEqual(result.data, { deleted: true, action: 'returned' });
      const returned = stored(account.id);
      assert.deepEqual(returned, { ...before.account, owner_user_id: source.id, inventory_admin_id: source.id, admin_imported: 1, claim_status: 'available', claimed_at: null, claim_code_hash: null, claim_code_expires_at: null, updated_at: returned.updated_at });
      assert.deepEqual(share(account.id), { ...before.share, owner_user_id: source.id });
      assert.deepEqual(db.prepare('SELECT * FROM mail_cache WHERE account_id=? ORDER BY id').all(account.id), before.cache);
      assert.deepEqual(db.prepare('SELECT * FROM account_tags WHERE account_id=?').all(account.id), []);
      assert.ok(db.prepare('SELECT id FROM tags WHERE id=?').get(tagId));
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/credentials`)).status, 404);
      assert.equal((await call(alice, 'GET', `/accounts/${account.id}/share-link`)).status, 404);
      const inventory = await call(sourceBrowser, 'GET', `/accounts?owner_user_id=${source.id}&claim_status=available`);
      assert.equal(inventory.status, 200);
      assert.ok(inventory.data.list.some((item: any) => item.id === account.id));
      const publicData = await call(browser(), 'GET', '/share/' + before.share.token);
      assert.equal(publicData.status, 200);
      assert.equal(publicData.data.password, data('single').password);
      const reimport = await call(bob, 'POST', '/accounts/import', { content: delivery });
      assert.equal(reimport.data.imported, 1, reimport.message);
      assert.equal(stored(account.id).inventory_admin_id, source.id);
      assert.equal(share(account.id).token, before.share.token);
      assert.equal((await call(bob, 'DELETE', `/accounts/${account.id}`)).data.action, 'returned');
      assert.equal((await call(alice, 'POST', '/accounts/import', { content: line('single') })).data.imported, 1);
      const audit = db.prepare("SELECT action FROM audit_logs WHERE target_id=? AND action='account.return'").all(String(account.id));
      assert.equal(audit.length, 2);
    });

    await t.test('batch deletion returns each account to its own inventory administrator and supports eight-field reimport', async () => {
      const first = owned('batch-source'), second = owned('batch-earliest', aliceUser, earliest);
      cacheAndTag(first.id); cacheAndTag(second.id);
      const before = snapshot([first.id, second.id]);
      const result = await call(alice, 'POST', '/accounts/batch-delete', { ids: [first.id, second.id, first.id] });
      assert.equal(result.status, 200, result.message);
      assert.deepEqual(result.data, { deleted: 2, action: 'returned' });
      assert.equal(stored(first.id).owner_user_id, source.id);
      assert.equal(stored(second.id).owner_user_id, earliest.id);
      for (const [index, account] of [first, second].entries()) {
        assert.equal(stored(account.id).claim_status, 'available');
        assert.deepEqual(share(account.id), { ...before[index].share, owner_user_id: stored(account.id).owner_user_id });
        assert.deepEqual(db.prepare('SELECT * FROM mail_cache WHERE account_id=? ORDER BY id').all(account.id), before[index].cache);
      }
      const reimport = await call(bob, 'POST', '/accounts/import', { content: `${line('batch-source')}\n${line('batch-earliest')}` });
      assert.equal(reimport.data.imported, 2, reimport.message);
      assert.equal(stored(first.id).owner_user_id, bobUser.id);
      assert.equal(stored(second.id).owner_user_id, bobUser.id);
      assert.equal((db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action='account.batch-return'").get() as any).c, 1);
    });

    await t.test('foreign accounts and mixed batches are rejected without returning any account', async () => {
      const mine = owned('permissions-mine'), foreign = owned('permissions-foreign', bobUser);
      cacheAndTag(mine.id);
      const before = snapshot([mine.id, foreign.id]);
      assert.equal((await call(alice, 'DELETE', `/accounts/${foreign.id}`)).status, 404);
      assert.equal((await call(alice, 'POST', '/accounts/batch-delete', { ids: [mine.id, foreign.id] })).status, 404);
      assert.equal((await call(alice, 'POST', '/accounts/batch-delete', { ids: [mine.id, 9999999] })).status, 404);
      assert.deepEqual(snapshot([mine.id, foreign.id]), before);
    });

    await t.test('busy single and batch returns and administrator deletions preserve all state', async () => {
      const first = owned('busy-first'), second = owned('busy-second');
      cacheAndTag(first.id);
      const before = snapshot([first.id, second.id]), release = lockResources([second.id]);
      try {
        assert.equal((await call(alice, 'DELETE', `/accounts/${second.id}`)).status, 409);
        assert.equal((await call(alice, 'POST', '/accounts/batch-delete', { ids: [first.id, second.id] })).status, 409);
        assert.equal((await call(admin, 'DELETE', `/accounts/${second.id}`)).status, 409);
        assert.equal((await call(admin, 'POST', '/accounts/batch-delete', { ids: [first.id, second.id] })).status, 409);
        assert.deepEqual(snapshot([first.id, second.id]), before);
      } finally { release(); }
    });

    await t.test('unavailable and historical inventory sources fall back to the earliest available administrator', async () => {
      const disabled = owned('disabled-source'), forced = owned('forced-source'), historical = owned('historical-source');
      db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(source.id);
      try {
        assert.equal((await call(alice, 'DELETE', `/accounts/${disabled.id}`)).data.action, 'returned');
      } finally { db.prepare("UPDATE users SET status='active' WHERE id=?").run(source.id); }
      db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(source.id);
      try {
        assert.equal((await call(alice, 'DELETE', `/accounts/${forced.id}`)).data.action, 'returned');
      } finally { db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(source.id); }
      db.prepare('UPDATE accounts SET inventory_admin_id=NULL WHERE id=?').run(historical.id);
      assert.equal((await call(alice, 'DELETE', `/accounts/${historical.id}`)).data.action, 'returned');
      for (const account of [disabled, forced, historical]) {
        assert.equal(stored(account.id).owner_user_id, earliest.id);
        assert.equal(stored(account.id).inventory_admin_id, earliest.id);
        assert.equal(share(account.id).owner_user_id, earliest.id);
      }
    });

    await t.test('absence of a usable administrator rolls back single and batch returns', async () => {
      const first = owned('no-admin-first'), second = owned('no-admin-second');
      cacheAndTag(first.id);
      const before = snapshot([first.id, second.id]);
      // Keep active administrators so regular user authentication remains available.
      db.prepare("UPDATE users SET must_change_password=1 WHERE role='admin'").run();
      try {
        const single = await call(alice, 'DELETE', `/accounts/${first.id}`);
        assert.equal(single.status, 409, single.message);
        assert.match(single.message, /管理员/);
        assert.equal((await call(alice, 'POST', '/accounts/batch-delete', { ids: [first.id, second.id] })).status, 409);
        assert.deepEqual(snapshot([first.id, second.id]), before);
      } finally { db.prepare("UPDATE users SET must_change_password=0 WHERE role='admin'").run(); }
    });

    await t.test('returning never restores missing, expired, or unrelated share links', async () => {
      const missing = owned('link-missing'), expired = owned('link-expired'), mismatched = owned('link-mismatched');
      const accounts = [missing, expired, mismatched], tokens = accounts.map(account => share(account.id).token);
      db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(missing.id);
      db.prepare('UPDATE account_share_links SET expires_at=? WHERE account_id=?').run(Date.now() - 1, expired.id);
      db.prepare('UPDATE account_share_links SET owner_user_id=? WHERE account_id=?').run(bobUser.id, mismatched.id);
      assert.equal((await call(alice, 'POST', '/accounts/batch-delete', { ids: accounts.map(account => account.id) })).status, 200);
      for (const [index, account] of accounts.entries()) {
        assert.equal(share(account.id), undefined);
        assert.equal((await call(browser(), 'GET', '/share/' + tokens[index])).status, 404);
      }
      const short = await call(bob, 'POST', '/accounts/import', { content: accounts.map(account => account.delivery).join('\n') });
      assert.equal(short.data.imported, 0);
      assert.equal(short.data.errors.length, 3);
      const full = await call(bob, 'POST', '/accounts/import', { content: ['link-missing', 'link-expired', 'link-mismatched'].map(line).join('\n') });
      assert.equal(full.data.imported, 3);
      for (const account of accounts) assert.equal(share(account.id), undefined);
    });

    await t.test('administrator single and batch deletions permanently remove accounts and prevent reimport', async () => {
      const single = owned('permanent-single'), first = owned('permanent-first'), second = owned('permanent-second', bobUser);
      cacheAndTag(single.id); cacheAndTag(first.id); cacheAndTag(second.id, bobUser);
      const token = share(single.id).token;
      const result = await call(admin, 'DELETE', `/accounts/${single.id}`);
      assert.equal(result.status, 200, result.message);
      assert.deepEqual(result.data, { deleted: true, action: 'deleted' });
      const batch = await call(admin, 'POST', '/accounts/batch-delete', { ids: [first.id, second.id] });
      assert.equal(batch.status, 200, batch.message);
      assert.deepEqual(batch.data, { deleted: 2, action: 'deleted' });
      for (const account of [single, first, second]) {
        assert.equal(stored(account.id), undefined);
        assert.equal(share(account.id), undefined);
        assert.deepEqual(db.prepare('SELECT * FROM mail_cache WHERE account_id=?').all(account.id), []);
        assert.deepEqual(db.prepare('SELECT * FROM account_tags WHERE account_id=?').all(account.id), []);
      }
      const imported = await call(alice, 'POST', '/accounts/import', { content: line('permanent-single') });
      assert.equal(imported.data.imported, 0);
      assert.equal(imported.data.errors.length, 1);
      assert.equal((await call(browser(), 'GET', '/share/' + token)).status, 404);
      assert.ok(db.prepare("SELECT id FROM audit_logs WHERE action='account.delete' AND target_id=?").get(String(single.id)));
      assert.ok(db.prepare("SELECT id FROM audit_logs WHERE action='account.batch-delete'").get());
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
