import { Context } from 'koa';
import { TagModel } from '../models/Tag';
import { success } from '../utils/response';
import { getUser } from '../middlewares/auth';
import { positiveId } from '../services/resourceAccess';
import { recordAudit } from '../services/audit';

const model = new TagModel();
export class TagController {
  async list(ctx: Context) { success(ctx, model.list(getUser(ctx), ctx.query.owner_user_id)); }
  async create(ctx: Context) {
    const user = getUser(ctx), body = (ctx.request.body || {}) as any;
    const tag = model.create(user, body.name, body.color, body.owner_user_id);
    recordAudit(user.id, 'tag.create', 'tag', tag.id, ctx.ip);
    success(ctx, tag);
  }
  async update(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    const tag = model.update(user, id, (ctx.request.body || {}) as any);
    recordAudit(user.id, 'tag.update', 'tag', id, ctx.ip);
    success(ctx, tag);
  }
  async delete(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    model.delete(user, id);
    recordAudit(user.id, 'tag.delete', 'tag', id, ctx.ip);
    success(ctx, { deleted: true });
  }
}
