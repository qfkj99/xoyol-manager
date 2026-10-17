import { Context } from 'koa';
import { AccountModel } from '../models/Account';
import { TagModel } from '../models/Tag';
import { success } from '../utils/response';
import { assertAdmin, getUser } from '../middlewares/auth';
import { idList, limitResourceAction, pageNumber, positiveId, resourceError } from '../services/resourceAccess';
import { recordAudit } from '../services/audit';

const model = new AccountModel(), tagModel = new TagModel();

export class AccountController {
  async list(ctx: Context) {
    const { page, pageSize, search = '', owner_user_id, claim_status } = ctx.query;
    if (typeof search !== 'string' || search.length > 200) resourceError(400, '搜索内容无效');
    success(ctx, model.list(getUser(ctx), pageNumber(page, 1), pageNumber(pageSize, 20, 500), search, owner_user_id, claim_status));
  }
  async credentials(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    const account = model.getById(user, id);
    recordAudit(user.id, 'account.credentials', 'account', id, ctx.ip);
    success(ctx, account);
  }
  async create(ctx: Context) {
    const user = getUser(ctx);
    const account = model.create(user, (ctx.request.body || {}) as any);
    recordAudit(user.id, 'account.create', 'account', account.id, ctx.ip);
    success(ctx, account);
  }
  async update(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    const account = model.update(user, id, (ctx.request.body || {}) as any);
    recordAudit(user.id, 'account.update', 'account', id, ctx.ip);
    success(ctx, account);
  }
  async delete(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    model.delete(user, id);
    recordAudit(user.id, user.role === 'admin' ? 'account.delete' : 'account.return', 'account', id, ctx.ip);
    success(ctx, { deleted: true, action: user.role === 'admin' ? 'deleted' : 'returned' });
  }
  async batchDelete(ctx: Context) {
    const user = getUser(ctx), ids = idList((ctx.request.body as any)?.ids);
    const deleted = model.batchDelete(user, ids);
    recordAudit(user.id, user.role === 'admin' ? 'account.batch-delete' : 'account.batch-return', 'account', ids.join(','), ctx.ip);
    success(ctx, { deleted, action: user.role === 'admin' ? 'deleted' : 'returned' });
  }
  async import(ctx: Context) {
    const user = getUser(ctx);
    limitResourceAction(user.id, 'account-import', 10, 60000);
    const result = model.import(user, (ctx.request.body || {}) as any);
    recordAudit(user.id, 'account.import', 'account', result.imported, ctx.ip);
    success(ctx, result);
  }
  async importPreview(ctx: Context) {
    const user = getUser(ctx);
    limitResourceAction(user.id, 'account-import-preview', 20, 60000);
    success(ctx, model.importPreview(user, (ctx.request.body || {}) as any));
  }
  async importConfirm(ctx: Context) {
    const user = getUser(ctx);
    limitResourceAction(user.id, 'account-import', 10, 60000);
    const result = model.importConfirm(user, (ctx.request.body || {}) as any);
    recordAudit(user.id, 'account.import', 'account', result.imported, ctx.ip);
    success(ctx, result);
  }
  async export(ctx: Context) {
    const user = getUser(ctx), body = (ctx.request.body || {}) as any;
    limitResourceAction(user.id, 'account-export', 10, 60000);
    const content = model.export(user, body.ids, body.separator, body.format, body.owner_user_id);
    recordAudit(user.id, 'account.export-credentials', 'account', Array.isArray(body.ids) ? body.ids.join(',') : 'scope', ctx.ip);
    success(ctx, { content, count: content.split('\n').filter(Boolean).length });
  }
  async setTags(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id), ids = idList((ctx.request.body as any)?.tag_ids, 'tag_ids', true);
    tagModel.setAccountTags(user, id, ids);
    recordAudit(user.id, 'account.tags', 'account', id, ctx.ip);
    success(ctx, { account_id: id, tag_ids: ids });
  }
  async transfer(ctx: Context) {
    const user = assertAdmin(ctx), body = (ctx.request.body || {}) as any;
    const ids = idList(body.ids), target = positiveId(body.target_user_id, 'target_user_id');
    const transferred = model.transfer(user, ids, target);
    recordAudit(user.id, 'account.transfer', 'user', target, ctx.ip);
    success(ctx, { transferred });
  }
  async publishClaims(ctx: Context) {
    const user = assertAdmin(ctx), ids = idList((ctx.request.body as any)?.ids);
    limitResourceAction(user.id, 'account-publish-claim', 30, 60000);
    const claim_codes = model.publishClaims(user, ids);
    recordAudit(user.id, 'account.claim-publish', 'account', ids.join(','), ctx.ip);
    success(ctx, { claim_codes });
  }
  async revokeClaims(ctx: Context) {
    const user = assertAdmin(ctx), ids = idList((ctx.request.body as any)?.ids);
    const revoked = model.revokeClaims(user, ids);
    recordAudit(user.id, 'account.claim-revoke', 'account', ids.join(','), ctx.ip);
    success(ctx, { revoked });
  }
  async claim(ctx: Context) {
    const user = getUser(ctx);
    limitResourceAction(user.id, 'account-claim', 30, 60000);
    const account = model.claim(user, (ctx.request.body as any)?.code);
    recordAudit(user.id, 'account.claim', 'account', account.id, ctx.ip);
    success(ctx, account);
  }
  async transferResources(ctx: Context) {
    const user = assertAdmin(ctx), body = (ctx.request.body || {}) as any;
    const source = positiveId(body.source_user_id, 'source_user_id'), target = positiveId(body.target_user_id, 'target_user_id');
    const result = model.transferResources(user, source, target);
    recordAudit(user.id, 'resources.transfer', 'user', `${source}->${target}`, ctx.ip);
    success(ctx, result);
  }
}
