import { createHash, randomBytes } from 'crypto';
import db from '../database';

export const API_KEY_SCOPES = ['accounts:read', 'accounts:import', 'share-links:write', 'mail:read'] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

interface ApiKeyRecord {
  id: number;
  name: string;
  key_hash: string;
  prefix: string;
  created_by: number;
  creator_username: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: string;
}

/** The only representation allowed in API responses and request state. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  created_by: number;
  creator_username: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

function timestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function keyInfo(row: ApiKeyRecord): ApiKeyInfo {
  let scopes: ApiKeyScope[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed) && parsed.every(scope => API_KEY_SCOPES.includes(scope))) scopes = parsed;
  } catch { /* Invalid stored permissions authorize nothing. */ }
  return {
    id: row.id, name: row.name, prefix: row.prefix, scopes,
    created_by: row.created_by, creator_username: row.creator_username,
    created_at: row.created_at, expires_at: timestamp(row.expires_at),
    revoked_at: timestamp(row.revoked_at), last_used_at: timestamp(row.last_used_at),
  };
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

const keySelect = 'SELECT k.*,u.username AS creator_username FROM api_keys k JOIN users u ON u.id=k.created_by';

export class ApiKeyModel {
  list(): ApiKeyInfo[] {
    return (db.prepare(`${keySelect} ORDER BY k.id DESC`).all() as ApiKeyRecord[]).map(keyInfo);
  }

  getById(id: number): ApiKeyInfo | undefined {
    const row = db.prepare(`${keySelect} WHERE k.id=?`).get(id) as ApiKeyRecord | undefined;
    return row ? keyInfo(row) : undefined;
  }

  create(data: { name: string; scopes: ApiKeyScope[]; expires_in_days: number | null; created_by: number }): { key: string; api_key: ApiKeyInfo } {
    const key = `xoyol_${randomBytes(32).toString('hex')}`;
    const expiresAt = data.expires_in_days === null ? null : Date.now() + data.expires_in_days * 86_400_000;
    const result = db.prepare('INSERT INTO api_keys(name,key_hash,prefix,created_by,scopes,expires_at) VALUES(?,?,?,?,?,?)')
      .run(data.name, hashKey(key), key.slice(0, 14), data.created_by, JSON.stringify(data.scopes), expiresAt);
    return { key, api_key: this.getById(Number(result.lastInsertRowid))! };
  }

  findByKey(key: string): ApiKeyInfo | undefined {
    if (!/^xoyol_[a-f0-9]{64}$/.test(key)) return undefined;
    const row = db.prepare(`${keySelect} WHERE k.key_hash=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?)`)
      .get(hashKey(key), Date.now()) as ApiKeyRecord | undefined;
    return row ? keyInfo(row) : undefined;
  }

  revoke(id: number): ApiKeyInfo | undefined {
    db.prepare('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(Date.now(), id);
    return this.getById(id);
  }

  markUsed(id: number): void {
    db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), id);
  }
}

export const apiKeyModel = new ApiKeyModel();
