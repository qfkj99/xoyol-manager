import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';

const serverDirectory = path.resolve(__dirname, '..');

test('service stop drains requests, checkpoints SQLite, and preserves data across restart', { timeout: 20_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xoyol-shutdown-'));
  const dbPath = path.join(directory, 'data', 'outlook.db');
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      return new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      });
    }));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function start() {
    // Run the real service entry point; only add an isolated delayed request and
    // IPC signal delivery for Windows, where child.kill() cannot send SIGTERM.
    const script = `
      const app = require('./src/app.ts').default;
      const db = require('./src/database/index.ts').default;
      app.middleware.unshift(async (ctx, next) => {
        if (ctx.path !== '/__shutdown-test') return next();
        process.send({ event: 'active' });
        await new Promise(resolve => setTimeout(resolve, 300));
        db.prepare("INSERT INTO settings(key,value) VALUES('shutdown_test','persisted') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
        ctx.body = 'request completed';
      });
      const listen = app.listen.bind(app);
      app.listen = (...args) => {
        const server = listen(...args);
        server.once('listening', () => process.send({ event: 'listening', port: server.address().port }));
        return server;
      };
      process.on('message', message => {
        if (message.signal) process.emit(message.signal);
      });
      for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => setImmediate(() => process.send({ event: 'stopping' })));
      }
      require('./src/server.ts');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: serverDirectory,
      env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath, PORT: '0', LOG_LEVEL: 'info', COOKIE_SECURE: 'false', APP_ORIGIN: '', TRUST_PROXY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let output = '';
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { output += data.toString(); });
    const messages: any[] = [];
    child.on('message', message => { messages.push(message); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    async function event(name: string) {
      const existing = messages.find(message => message.event === name);
      if (existing) return existing;
      return new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${name}: ${output}`)); }, 7_000);
        const onMessage = (message: any) => { if (message.event === name) { cleanup(); resolve(message); } };
        const onExit = () => { cleanup(); reject(new Error(`Service exited before ${name}: ${output}`)); };
        function cleanup() { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); }
        child.on('message', onMessage); child.once('exit', onExit);
      });
    }
    function stop(signal: 'SIGTERM' | 'SIGINT') {
      if (process.platform === 'win32') child.send({ signal });
      else child.kill(signal);
    }
    return { child, event, exited, stop, output: () => output };
  }

  function request(port: number, pathname: string) {
    return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode, body }));
        response.once('error', reject);
      });
      req.once('error', reject);
    });
  }

  const first = start();
  const { port } = await first.event('listening');
  const config = await request(port, '/api/auth/config');
  assert.equal(config.status, 200);
  const active = request(port, '/__shutdown-test');
  await first.event('active');
  first.stop('SIGTERM');
  await first.event('stopping');
  await assert.rejects(request(port, '/api/auth/config'), { code: 'ECONNREFUSED' });
  assert.deepEqual(await active, { status: 200, body: 'request completed' });
  assert.deepEqual(await first.exited, { code: 0, signal: null }, first.output());
  assert.match(first.output(), /SIGTERM received/);
  assert.match(first.output(), /Shutdown completed; database closed/);
  await assert.rejects(request(port, '/api/auth/config'), { code: 'ECONNREFUSED' });
  assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.statSync(`${dbPath}-wal`).size === 0);
  const db = new Database(dbPath);
  try {
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='shutdown_test'").get() as { value: string }).value, 'persisted');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version, 7);
  } finally { db.close(); }

  const second = start();
  const ready = await second.event('listening');
  assert.equal((await request(ready.port, '/api/auth/config')).status, 200);
  second.stop('SIGINT');
  assert.deepEqual(await second.exited, { code: 0, signal: null }, second.output());
  assert.match(second.output(), /SIGINT received/);
  assert.match(second.output(), /Shutdown completed; database closed/);
});
