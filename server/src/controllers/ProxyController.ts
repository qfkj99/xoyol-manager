import { Context } from 'koa';
import { ProxyModel } from '../models/Proxy';
import { ProxyService, validateProxyEndpoint } from '../services/ProxyService';
import { success } from '../utils/response';
import { getUser } from '../middlewares/auth';
import { limitResourceAction, lockResources, positiveId } from '../services/resourceAccess';
import { recordAudit } from '../services/audit';

const model = new ProxyModel(), proxyService = new ProxyService();
export class ProxyController {
  async list(ctx: Context) { success(ctx, model.list(getUser(ctx), ctx.query.owner_user_id)); }
  async credentials(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id), proxy = model.getById(user, id);
    recordAudit(user.id, 'proxy.credentials', 'proxy', id, ctx.ip);
    success(ctx, { ...proxy, is_default: !!proxy.is_default });
  }
  async create(ctx: Context) {
    const user = getUser(ctx), body = (ctx.request.body || {}) as any;
    limitResourceAction(user.id, 'proxy-change', 20, 60000);
    await validateProxyEndpoint(body);
    const proxy = model.create(getUser(ctx), body);
    recordAudit(user.id, 'proxy.create', 'proxy', proxy.id, ctx.ip);
    success(ctx, proxy);
  }
  async update(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id), body = (ctx.request.body || {}) as any;
    const existing = model.getById(user, id);
    limitResourceAction(user.id, 'proxy-change', 20, 60000);
    await validateProxyEndpoint({ ...existing, ...body });
    const proxy = model.update(getUser(ctx), id, body);
    recordAudit(user.id, 'proxy.update', 'proxy', id, ctx.ip);
    success(ctx, proxy);
  }
  async delete(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    model.delete(user, id);
    recordAudit(user.id, 'proxy.delete', 'proxy', id, ctx.ip);
    success(ctx, { deleted: true });
  }
  async test(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id), proxy = model.getById(user, id);
    limitResourceAction(user.id, 'proxy-test', 10, 60000);
    const release = lockResources([], [id]);
    try {
      const result = await proxyService.testProxy(proxy);
      model.getById(getUser(ctx), id);
      model.updateTestResult(id, result.ip, result.status);
      recordAudit(user.id, 'proxy.test', 'proxy', id, ctx.ip, result.status);
      success(ctx, result);
    } finally { release(); }
  }
  async setDefault(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    const proxy = model.setDefault(user, id);
    recordAudit(user.id, 'proxy.default', 'proxy', id, ctx.ip);
    success(ctx, proxy);
  }
}
