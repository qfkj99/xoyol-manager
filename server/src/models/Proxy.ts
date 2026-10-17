import db from '../database';
import { Proxy } from '../types';
import { AuthUser } from '../types/auth';
import { assertResourcesIdle, createOwner, ownerScope, ownerWhere, requireResource, resourceError } from '../services/resourceAccess';

export function publicProxy(proxy: Proxy): Proxy { return { ...proxy, password: '', has_password: !!proxy.password, is_default: !!proxy.is_default }; }

function validateProxy(data: Partial<Proxy>, creating = false) {
  if ((creating || data.type !== undefined) && !['socks5', 'http'].includes(data.type!)) resourceError(400, '代理类型无效');
  if ((creating || data.host !== undefined) && (typeof data.host !== 'string' || !data.host.trim() || data.host.length > 253)) resourceError(400, '代理主机无效');
  if ((creating || data.port !== undefined) && (!Number.isInteger(data.port) || data.port! < 1 || data.port! > 65535)) resourceError(400, '代理端口须为 1 至 65535');
  for (const key of ['name', 'username', 'password'] as const) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key]!.length > 1000)) resourceError(400, `${key} 格式无效`);
  if (data.is_default !== undefined && typeof data.is_default !== 'boolean') resourceError(400, 'is_default 必须为布尔值');
}

export class ProxyModel {
  list(user: AuthUser, requestedOwner?: unknown): Proxy[] {
    const scope = ownerWhere(ownerScope(user, requestedOwner));
    return (db.prepare(`SELECT * FROM proxies WHERE ${scope.sql} ORDER BY id DESC`).all(...scope.params) as Proxy[]).map(publicProxy);
  }
  getById(user: AuthUser, id: number): Proxy { return requireResource<Proxy>('proxies', id, user); }
  getDefault(user: AuthUser, ownerId: number | null): Proxy | undefined {
    if (user.role !== 'admin' && user.id !== ownerId) resourceError(404, '资源不存在或无权访问');
    return db.prepare('SELECT * FROM proxies WHERE owner_user_id IS ? AND is_default = 1 ORDER BY id LIMIT 1').get(ownerId) as Proxy | undefined;
  }
  create(user: AuthUser, data: Partial<Proxy>): Proxy {
    validateProxy(data, true);
    const owner = createOwner(user, data.owner_user_id ?? undefined);
    return db.transaction(() => {
      if (data.is_default) {
        const ids = db.prepare('SELECT id FROM proxies WHERE owner_user_id = ?').all(owner) as { id: number }[];
        assertResourcesIdle([], ids.map(row => row.id));
        db.prepare('UPDATE proxies SET is_default = 0 WHERE owner_user_id = ?').run(owner);
      }
      const result = db.prepare('INSERT INTO proxies (name, type, host, port, username, password, is_default, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(data.name || '', data.type, data.host!.trim(), data.port, data.username || '', data.password || '', data.is_default ? 1 : 0, owner);
      return publicProxy(this.getById(user, Number(result.lastInsertRowid)));
    })();
  }
  update(user: AuthUser, id: number, data: Partial<Proxy>): Proxy {
    this.getById(user, id);
    assertResourcesIdle([], [id]);
    validateProxy(data);
    if (data.owner_user_id !== undefined) resourceError(400, '代理归属只能通过资源移交修改');
    return db.transaction(() => {
      if (data.is_default) this.setDefault(user, id);
      const fields: string[] = [], values: any[] = [];
      for (const key of ['name', 'type', 'host', 'port', 'username', 'password', 'is_default'] as const) if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(key === 'is_default' ? (data[key] ? 1 : 0) : key === 'host' ? String(data[key]).trim() : data[key]);
      }
      if (fields.length) db.prepare(`UPDATE proxies SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
      return publicProxy(this.getById(user, id));
    })();
  }
  delete(user: AuthUser, id: number): boolean {
    this.getById(user, id);
    assertResourcesIdle([], [id]);
    return db.prepare('DELETE FROM proxies WHERE id = ?').run(id).changes > 0;
  }
  setDefault(user: AuthUser, id: number): Proxy {
    const proxy = this.getById(user, id);
    const ids = db.prepare('SELECT id FROM proxies WHERE owner_user_id IS ?').all(proxy.owner_user_id) as { id: number }[];
    assertResourcesIdle([], ids.map(row => row.id));
    return db.transaction(() => {
      db.prepare('UPDATE proxies SET is_default = 0 WHERE owner_user_id IS ?').run(proxy.owner_user_id);
      db.prepare('UPDATE proxies SET is_default = 1 WHERE id = ?').run(id);
      return publicProxy(this.getById(user, id));
    })();
  }
  updateTestResult(id: number, ip: string, status: 'active' | 'failed') { db.prepare('UPDATE proxies SET last_tested_at = CURRENT_TIMESTAMP, last_test_ip = ?, status = ? WHERE id = ?').run(ip, status, id); }
}
