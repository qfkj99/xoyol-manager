import Router from 'koa-router';
import db from '../database';
import { assertAdmin } from '../middlewares/auth';
import { success } from '../utils/response';

export const auditRoutes = new Router();
auditRoutes.get('/', ctx => {
  assertAdmin(ctx);
  const page = Math.max(1, Math.min(1_000_000, Number(ctx.query.page) || 1)) | 0;
  const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 20)) | 0;
  const action = typeof ctx.query.action === 'string' ? ctx.query.action.slice(0, 128) : '';
  const where = action ? 'WHERE a.action=?' : '';
  const params = action ? [action] : [];
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`).get(...params) as { total: number };
  const list = db.prepare(`SELECT a.*,u.username AS actor_username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
    ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  success(ctx, { list, total, page, pageSize });
});
