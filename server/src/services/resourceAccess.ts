import db from '../database';
import { AuthUser } from '../types/auth';

export function resourceError(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export function positiveId(value: unknown, name = 'id'): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    return resourceError(400, `${name} 必须为正整数`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return resourceError(400, `${name} 必须为正整数`);
  return id;
}

export function idList(value: unknown, name = 'ids', allowEmpty = false): number[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 5000) {
    return resourceError(400, `${name} 必须为${allowEmpty ? '最多' : '1 至'} 5000 个 ID 的数组`);
  }
  return [...new Set(value.map(id => positiveId(id, name)))];
}

export function pageNumber(value: unknown, fallback: number, maximum = 1000000): number {
  if (value === undefined) return fallback;
  const result = positiveId(value, '分页参数');
  if (result > maximum) return resourceError(400, `分页参数不能超过 ${maximum}`);
  return result;
}

export function ownerScope(user: AuthUser, requested?: unknown): number | undefined {
  if (user.role !== 'admin') {
    if (requested !== undefined && positiveId(requested, 'owner_user_id') !== user.id) {
      return resourceError(403, '无权访问其他用户的数据');
    }
    return user.id;
  }
  return requested === undefined || requested === '' ? undefined : positiveId(requested, 'owner_user_id');
}

export function ownerWhere(ownerId: number | undefined, alias = ''): { sql: string; params: number[] } {
  return ownerId === undefined
    ? { sql: '1 = 1', params: [] }
    : { sql: `${alias ? `${alias}.` : ''}owner_user_id = ?`, params: [ownerId] };
}

export function requireActiveOwner(id: unknown): number {
  const ownerId = positiveId(id, 'owner_user_id');
  const owner = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").get(ownerId);
  if (!owner) return resourceError(400, '目标用户不存在或未启用');
  return ownerId;
}

export function createOwner(user: AuthUser, requested?: unknown): number {
  const scope = ownerScope(user, requested);
  return requireActiveOwner(scope ?? user.id);
}

export function requireResource<T extends { id: number; owner_user_id: number | null }>(
  table: 'accounts' | 'tags' | 'proxies', id: number, user: AuthUser,
): T {
  const scope = ownerWhere(ownerScope(user));
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${scope.sql}`).get(id, ...scope.params) as T | undefined;
  if (!row) return resourceError(404, '资源不存在或无权访问');
  return row;
}

const busyAccounts = new Set<number>();
const busyProxies = new Set<number>();

export function assertResourcesIdle(accountIds: number[] = [], proxyIds: number[] = []): void {
  if (accountIds.some(id => busyAccounts.has(id)) || proxyIds.some(id => busyProxies.has(id))) {
    resourceError(409, '资源正在收信、清空或检测中，请稍后重试');
  }
}

export function hasBusyResources(): boolean {
  return busyAccounts.size > 0 || busyProxies.size > 0;
}

export function lockResources(accountIds: number[] = [], proxyIds: number[] = []): () => void {
  assertResourcesIdle(accountIds, proxyIds);
  accountIds.forEach(id => busyAccounts.add(id));
  proxyIds.forEach(id => busyProxies.add(id));
  return () => {
    accountIds.forEach(id => busyAccounts.delete(id));
    proxyIds.forEach(id => busyProxies.delete(id));
  };
}

const attempts = new Map<string, number[]>();
export function limitResourceAction(userId: number, action: string, maximum: number, windowMs: number): void {
  const now = Date.now();
  const key = `${userId}:${action}`;
  const timestamps = (attempts.get(key) || []).filter(value => value > now - windowMs);
  if (timestamps.length >= maximum) resourceError(429, '操作过于频繁，请稍后重试');
  timestamps.push(now);
  attempts.set(key, timestamps);
  if (attempts.size > 10000) {
    for (const [entry, values] of attempts) if (values.every(value => value < now - 3600000)) attempts.delete(entry);
  }
}
