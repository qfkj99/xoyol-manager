import Router from 'koa-router';
import db from '../database';
import { assertAdmin } from '../middlewares/auth';
import { apiKeyModel, API_KEY_SCOPES, ApiKeyScope } from '../models/ApiKey';
import { recordAudit } from '../services/audit';
import { rateLimit } from '../services/rateLimit';
import { positiveId } from '../services/resourceAccess';
import { success } from '../utils/response';

export const apiKeyRoutes = new Router();

apiKeyRoutes.get('/', ctx => {
  assertAdmin(ctx);
  success(ctx, { list: apiKeyModel.list() });
});

apiKeyRoutes.post('/', ctx => {
  const actor = assertAdmin(ctx);
  const body = ctx.request.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['name', 'scopes', 'expires_in_days'].includes(key))) return ctx.throw(400, 'API Key 参数无效');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(body.name)) return ctx.throw(400, '密钥名称须为 1 至 80 个字符');
  if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.length > API_KEY_SCOPES.length
      || body.scopes.some(scope => !API_KEY_SCOPES.includes(scope))) ctx.throw(400, '请选择有效的 API 权限');
  if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== 7 && body.expires_in_days !== 30
      && body.expires_in_days !== 90 && body.expires_in_days !== 365) ctx.throw(400, '有效期须为 7、30、90、365 天或长期有效');
  rateLimit(ctx, `api-key-create:${actor.id}`, 30, 60_000);
  const name = body.name.trim(), scopes = [...new Set(body.scopes as ApiKeyScope[])];
  const expiresInDays = (body.expires_in_days ?? null) as number | null;
  const result = db.transaction(() => {
    const result = apiKeyModel.create({ name, scopes, expires_in_days: expiresInDays, created_by: actor.id });
    recordAudit(actor.id, 'api-key.create', 'api-key', result.api_key.id, ctx.ip);
    return result;
  }).immediate();
  success(ctx, result);
});

apiKeyRoutes.delete('/:id', ctx => {
  const actor = assertAdmin(ctx), id = positiveId(ctx.params.id);
  const result = db.transaction(() => {
    const current = apiKeyModel.getById(id);
    if (!current) return ctx.throw(404, 'API Key 不存在');
    const revoked = apiKeyModel.revoke(id)!;
    if (current.revoked_at === null) recordAudit(actor.id, 'api-key.revoke', 'api-key', id, ctx.ip);
    return revoked;
  }).immediate();
  success(ctx, { revoked: true, api_key: result });
});
