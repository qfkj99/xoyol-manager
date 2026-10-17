import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';

test('proxy transport and remote operation completion', async t => {
  const { ProxyService, validateProxyEndpoint } = await import('../src/services/ProxyService');
  const { GraphApiService } = await import('../src/services/GraphApiService');
  const { ImapService } = await import('../src/services/ImapService');
  const { closeDatabase } = await import('../src/database');
  t.after(closeDatabase);
  const service = new ProxyService();

  await t.test('private targets require deployment allowlisting and metadata aliases never qualify', async () => {
    const previous = process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
    try {
      delete process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
      for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1']) {
        await assert.rejects(validateProxyEndpoint({ host, port: 8080 }), { status: 400 });
      }
      assert.equal(await validateProxyEndpoint({ host: '8.8.8.8', port: 8080 }), '8.8.8.8');
      const metadata = ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fd00:0ec2:0000:0000:0000:0000:0000:0254'];
      process.env.PROXY_PRIVATE_HOST_ALLOWLIST = ['127.0.0.1', ...metadata].join(',');
      assert.equal(await validateProxyEndpoint({ host: '127.0.0.1', port: 8080 }), '127.0.0.1');
      for (const host of metadata) await assert.rejects(validateProxyEndpoint({ host, port: 8080 }), { status: 400 });
    } finally {
      if (previous === undefined) delete process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
      else process.env.PROXY_PRIVATE_HOST_ALLOWLIST = previous;
    }
  });

  await t.test('HTTP CONNECT authenticates to the selected proxy for the fixed Microsoft IMAP destination', async () => {
    const previous = process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
    process.env.PROXY_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
    const server = http.createServer();
    const sockets = new Set<net.Socket>();
    let destination = '', authorization = '';
    server.on('connect', (request, socket) => {
      destination = request.url || '';
      authorization = request.headers['proxy-authorization'] || '';
      sockets.add(socket);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let tunnel: net.Socket | undefined;
    try {
      tunnel = await service.createImapTunnel({ type: 'http', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, username: 'proxy-user', password: 'proxy-pass' } as any);
      assert.ok(tunnel);
      assert.equal(destination, 'outlook.office365.com:993');
      assert.equal(authorization, `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`);
    } finally {
      tunnel?.destroy(); sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
      else process.env.PROXY_PRIVATE_HOST_ALLOWLIST = previous;
    }
  });

  await t.test('SOCKS5 connects through the selected proxy to the fixed IMAP destination', async () => {
    const previous = process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
    process.env.PROXY_PRIVATE_HOST_ALLOWLIST = '127.0.0.1';
    let destination = '', destinationPort = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket);
      let stage = 0, pending = Buffer.alloc(0);
      socket.on('data', data => {
        pending = Buffer.concat([pending, data]);
        if (stage === 0 && pending.length >= 2 + pending[1]) {
          pending = pending.subarray(2 + pending[1]); stage = 1; socket.write(Buffer.from([5, 0]));
        }
        if (stage === 1 && pending.length >= 5 && pending.length >= 7 + pending[4]) {
          assert.equal(pending[3], 3);
          destination = pending.subarray(5, 5 + pending[4]).toString();
          destinationPort = pending.readUInt16BE(5 + pending[4]); stage = 2;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
        }
      });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let tunnel: net.Socket | undefined;
    try {
      tunnel = await service.createImapTunnel({ type: 'socks5', host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, username: '', password: '' } as any);
      assert.ok(tunnel);
      assert.equal(destination, 'outlook.office365.com'); assert.equal(destinationPort, 993);
    } finally {
      tunnel?.destroy(); sockets.forEach(socket => socket.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.PROXY_PRIVATE_HOST_ALLOWLIST;
      else process.env.PROXY_PRIVATE_HOST_ALLOWLIST = previous;
    }
  });

  await t.test('IMAP reuses its tunnel, verifies TLS, and completes OAuth mailbox commands', async () => {
    const commands: string[] = [];
    let reconnects = 0, tlsVerified = false, pending = '';
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        pending += chunk.toString();
        for (let end; (end = pending.indexOf('\r\n')) >= 0;) {
          const command = pending.slice(0, end); pending = pending.slice(end + 2);
          commands.push(command);
          const [tag] = command.split(' ');
          const extra = command.includes(' CAPABILITY') ? '* CAPABILITY IMAP4rev1 AUTH=XOAUTH2\r\n'
            : / (EXAMINE|SELECT) /.test(command) ? '* FLAGS (\\Seen \\Deleted)\r\n* 0 EXISTS\r\n'
              : command.includes(' SEARCH ') ? '* SEARCH\r\n' : '';
          queueMicrotask(() => socket.push(`${extra}${tag} OK complete\r\n`));
        }
        callback();
      },
    }) as Duplex & { connect: (...args: any[]) => any; setKeepAlive: () => any; setTimeout: () => any };
    socket.connect = () => { reconnects++; throw new Error('Tunnel must never reconnect directly'); };
    socket.setKeepAlive = socket.setTimeout = () => socket;
    const tunnelMock = t.mock.method(ProxyService.prototype, 'createImapTunnel', async () => socket as any);
    const tlsMock = t.mock.method(tls, 'connect', ((options: tls.ConnectionOptions, connected: () => void) => {
      tlsVerified = options.rejectUnauthorized === true && options.servername === 'outlook.office365.com';
      assert.equal(options.socket, socket);
      queueMicrotask(() => { connected(); socket.push('* OK fake Microsoft IMAP ready\r\n'); });
      return socket;
    }) as any);
    try {
      const imap = new ImapService();
      await imap.clearMailbox('isolated@example.test', imap.generateAuthString('isolated@example.test', 'fake-token'), 'INBOX', {} as any);
      assert.equal(reconnects, 0); assert.equal(tlsVerified, true);
      assert.ok(commands.some(command => command.includes(' AUTHENTICATE XOAUTH2 ')));
      assert.ok(commands.some(command => command.includes(' SELECT ')));
      assert.ok(commands.some(command => command.includes(' UID SEARCH ALL')));
      await setImmediate();
    } finally { socket.destroy(); tunnelMock.mock.restore(); tlsMock.mock.restore(); }
  });

  await t.test('a failed Graph delete waits for other deletions before allowing fallback or releasing locks', async () => {
    const graph = new GraphApiService();
    let finishSlow: () => void;
    const slow = new Promise<void>(resolve => { finishSlow = resolve; });
    const fetchMock = t.mock.method(graph, 'fetchMails', async () => [{ mail_id: 'failed' }, { mail_id: 'slow' }]);
    const deleteMock = t.mock.method(graph, 'deleteMail', async (_token, id) => {
      if (id === 'failed') throw new Error('deletion failed');
      await slow;
    });
    let settled = false;
    const operation = graph.deleteAllMails('fake', 'INBOX').finally(() => { settled = true; });
    const checked = assert.rejects(operation, /deletion failed/);
    try {
      await setImmediate(); assert.equal(settled, false);
      finishSlow!(); await checked; assert.equal(settled, true);
    } finally { finishSlow!(); fetchMock.mock.restore(); deleteMock.mock.restore(); }
  });
});
