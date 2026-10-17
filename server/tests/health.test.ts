import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'node:http';
import { Context } from 'koa';

// Secure-cookie deployments still need a plain HTTP loopback health probe.
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'true';
process.env.TRUST_PROXY = 'false';
process.env.APP_ORIGIN = '';

test('anonymous health probe checks SQLite without cookies or bypassing application access', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-health-'));
  process.env.DB_PATH = path.join(directory, 'outlook.db');
  let server: Server | undefined;
  let cleanupDatabase = () => {};
  t.after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    cleanupDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { default: db, closeDatabase, reopenDatabase } = await import('../src/database');
  cleanupDatabase = closeDatabase;
  const { runMigrations } = await import('../src/database/migrations');
  const { default: app } = await import('../src/app');
  const { beginMaintenance } = await import('../src/middlewares/maintenance');
  const { default: logger } = await import('../src/utils/logger');
  logger.silent = true;
  await runMigrations();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
  db.prepare("INSERT INTO settings(key,value) VALUES('health_test_private_setting','must-not-be-exposed')").run();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  async function call(pathname: string, method = 'GET') {
    const response = await fetch(`${origin}${pathname}`, { method });
    assert.equal(response.headers.get('set-cookie'), null, `${method} ${pathname} must not create cookies`);
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  await t.test('uninitialized secure-cookie service is healthy with a minimal public response', async () => {
    const response = await call('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.body, { code: 200, data: { status: 'ok' }, message: 'ok' });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const denied = await call('/api/health', method);
      assert.equal(denied.status, 503, `${method} must not use the GET health exception`);
      assert.equal(denied.body.data, null);
    }
    assert.equal((await call('/api/accounts')).status, 503);
    assert.equal((await call('/api/settings')).status, 503);
  });

  await t.test('maintenance makes the probe unready until normal request handling resumes', async () => {
    const endMaintenance = await beginMaintenance({} as Context);
    try {
      const response = await call('/api/health');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '5');
      assert.equal(response.body.data, null);
    } finally { endMaintenance(); }
    assert.equal((await call('/api/health')).status, 200);
  });

  await t.test('the probe fails when SQLite is unavailable and recovers after reopening it', async () => {
    closeDatabase();
    try {
      const response = await call('/api/health');
      assert.equal(response.status, 500);
      assert.equal(response.body.data, null);
      assert.ok(!JSON.stringify(response.body).includes('must-not-be-exposed'));
    } finally { reopenDatabase(); }
    assert.equal((await call('/api/health')).status, 200);
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='health_test_private_setting'").get() as { value: string }).value, 'must-not-be-exposed');
  });
});
