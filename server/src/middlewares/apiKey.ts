import { Context, Next } from 'koa';
import { apiKeyModel, ApiKeyScope } from '../models/ApiKey';
import { publicUser, userModel } from '../models/User';
import { rateLimit } from '../services/rateLimit';
import { AuthUser } from '../types/auth';

export function isExternalApiPath(path: string): boolean {
  return path === '/api/external/v1' || path.startsWith('/api/external/v1/');
}

/** Recheck the key and its issuing administrator after asynchronous operations. */
export function assertApiKey(ctx: Context, scope?: ApiKeyScope): AuthUser {
  if (!isExternalApiPath(ctx.path)) ctx.throw(401, 'API Key 仅支持外部 API 接口');
  const match = /^Bearer (xoyol_[a-f0-9]{64})$/i.exec(ctx.get('Authorization'));
  // Accept a case-insensitive authentication scheme, but keep the key exact.
  const key = match && apiKeyModel.findByKey(match[1]);
  if (!key) {
    ctx.set('WWW-Authenticate', 'Bearer');
    ctx.throw(401, 'API Key 无效、已撤销或已过期');
  }
  const creator = userModel.getById(key.created_by);
  if (!creator || creator.role !== 'admin' || creator.status !== 'active' || creator.must_change_password) {
    ctx.throw(401, 'API Key 所属管理员当前不可用');
  }
  if (scope && !key.scopes.includes(scope)) ctx.throw(403, 'API Key 缺少所需权限');
  ctx.state.apiKey = key;
  ctx.state.apiUser = publicUser(creator);
  return ctx.state.apiUser;
}

export async function externalApiAuth(ctx: Context, next: Next) {
  rateLimit(ctx, `external-auth-ip:${ctx.ip}`, 240, 60_000);
  assertApiKey(ctx);
  const keyId = ctx.state.apiKey.id;
  rateLimit(ctx, `external-key:${keyId}`, 120, 60_000);
  apiKeyModel.markUsed(keyId);
  return next();
}
