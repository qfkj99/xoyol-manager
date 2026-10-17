import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent } from 'undici';
import { lookup } from 'dns/promises';
import { BlockList, isIP, Socket } from 'net';
import http from 'http';
import { SocksClient } from 'socks';
import { Proxy, ProxyTestResult } from '../types';
import { resourceError } from './resourceAccess';

const blocked4 = new BlockList(), blocked6 = new BlockList();
const metadata4 = new BlockList(), metadata6 = new BlockList();
for (const address of ['169.254.169.254', '169.254.170.2', '169.254.170.23', '100.100.100.200', '168.63.129.16']) {
  metadata4.addAddress(address, 'ipv4');
  metadata6.addAddress(`::ffff:${address}`, 'ipv6');
}
metadata6.addAddress('fd00:ec2::254', 'ipv6');
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as [string, number][]) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as [string, number][]) blocked6.addSubnet(address, prefix, 'ipv6');

export async function validateProxyEndpoint(proxy: Pick<Proxy, 'host' | 'port'>): Promise<string> {
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) resourceError(400, '代理端口无效');
  if (typeof proxy.host !== 'string') resourceError(400, '代理主机无效');
  const host = proxy.host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host.length > 253 || (isIP(host) === 0 && !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host))) resourceError(400, '代理主机须为 IP 地址或域名');
  // Exact deployment allowlist only; callers cannot opt into private addresses through request data.
  const allowlist = (process.env.PROXY_PRIVATE_HOST_ALLOWLIST || '').split(',').map(entry => entry.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')).filter(Boolean);
  const explicitlyAllowed = allowlist.includes(host);
  if (!explicitlyAllowed && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) resourceError(400, '禁止连接本地或内网代理地址');
  let addresses: { address: string; family: number }[];
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
  catch { return resourceError(400, '无法解析代理主机'); }
  if (!addresses.length || addresses.some(({ address, family }) => {
    // Cloud metadata endpoints are never eligible, including explicit allowlist entries.
    if (family === 6 ? metadata6.check(address, 'ipv6') : metadata4.check(address, 'ipv4')) return true;
    if (explicitlyAllowed) return false;
    return (family === 6 ? blocked6.check(address, 'ipv6') : blocked4.check(address, 'ipv4')) || (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address));
  })) resourceError(400, '禁止连接本地、私网或保留代理地址；可信内网代理须由部署者配置白名单');
  // Pin the vetted address into the proxy connection so a second DNS resolution cannot rebind it.
  return addresses[0].address;
}

export class ProxyService {
  async createImapTunnel(proxy?: Proxy): Promise<Socket | undefined> {
    if (!proxy) return undefined;
    const address = await validateProxyEndpoint(proxy);
    if (proxy.type === 'socks5') {
      const result = await SocksClient.createConnection({
        proxy: { host: address, port: proxy.port, type: 5, userId: proxy.username || undefined, password: proxy.password || undefined },
        command: 'connect', destination: { host: 'outlook.office365.com', port: 993 }, timeout: 20000,
      });
      return result.socket;
    }
    return new Promise<Socket>((resolve, reject) => {
      const request = http.request({
        host: address, port: proxy.port, method: 'CONNECT', path: 'outlook.office365.com:993',
        headers: { Host: 'outlook.office365.com:993', ...(proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}` } : {}) },
      });
      const timeout = setTimeout(() => request.destroy(new Error('Proxy tunnel timed out')), 20000);
      request.once('connect', (response, socket, head) => {
        clearTimeout(timeout);
        if (response.statusCode !== 200) { socket.destroy(); reject(new Error('Proxy tunnel failed')); return; }
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      request.once('error', error => { clearTimeout(timeout); reject(error); });
      request.end();
    });
  }

  async getAgent(proxy?: Proxy): Promise<{ agent?: SocksProxyAgent; dispatcher?: ProxyAgent; type?: string }> {
    if (!proxy) return {};
    const address = await validateProxyEndpoint(proxy);
    const host = isIP(address) === 6 ? `[${address}]` : address;
    const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '';
    if (proxy.type === 'socks5') return { agent: new SocksProxyAgent(`socks5://${auth}${host}:${proxy.port}`, { timeout: 15000 }), type: 'socks5' };
    return { dispatcher: new ProxyAgent({ uri: `http://${host}:${proxy.port}`, ...(proxy.username ? { token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}` } : {}) }), type: 'http' };
  }

  async testProxy(proxy: Proxy): Promise<ProxyTestResult> {
    const start = Date.now();
    const { agent, dispatcher, type } = await this.getAgent(proxy);
    try {
      let response: any;
      if (type === 'socks5') response = await require('node-fetch')('https://httpbin.org/ip', { agent, timeout: 15000, redirect: 'error' });
      else response = await require('undici').fetch('https://httpbin.org/ip', { dispatcher, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('Proxy test failed');
      const data = await response.json();
      return { ip: String(data.origin || ''), latency: Date.now() - start, status: 'active' };
    } catch { return { ip: '', latency: Date.now() - start, status: 'failed' }; }
    finally { agent?.destroy(); if (dispatcher) await dispatcher.close(); }
  }
}
