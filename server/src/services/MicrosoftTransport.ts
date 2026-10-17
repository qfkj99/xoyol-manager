import { Proxy } from '../types';
import { ProxyService } from './ProxyService';

const proxyService = new ProxyService();

export async function microsoftRequest(url: string, options: Record<string, any>, proxy?: Proxy): Promise<any> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !['login.microsoftonline.com', 'graph.microsoft.com'].includes(endpoint.hostname)) throw new Error('Invalid Microsoft endpoint');
  const { agent, dispatcher, type } = await proxyService.getAgent(proxy);
  try {
    const response = type === 'socks5'
      ? await require('node-fetch')(url, { ...options, agent, timeout: 20000, redirect: 'error' })
      : await require('undici').fetch(url, { ...options, dispatcher, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) {
      await response.text();
      throw new Error(`Microsoft request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    return await response.json();
  } finally { agent?.destroy(); if (dispatcher) await dispatcher.close(); }
}
