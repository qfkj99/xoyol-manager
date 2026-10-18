import { Context, Next } from 'koa';
import { AuthUser } from '../types/auth';
import { userModel } from '../models/User';
import { assertCsrf, sessionUser } from '../services/session';
import { externalApiAuth, isExternalApiPath } from './apiKey';

export function getUser(ctx: Context): AuthUser {
  // Revalidate after asynchronous work as well as at the request boundary.
  const current = sessionUser(ctx);
  if (!current) ctx.throw(401, '登录已失效，请重新登录');
  ctx.state.user = current.user;
  ctx.state.session = current.session;
  return current.user;
}

export function assertAdmin(ctx: Context): AuthUser {
  const user = getUser(ctx);
  if (user.role !== 'admin') ctx.throw(403, '此操作仅限管理员');
  return user;
}

export async function authMiddleware(ctx: Context, next: Next) {
  if (!/^\/api(?:\/|$)/i.test(ctx.path)) return next();
  ctx.set('Cache-Control', 'no-store');
  // koa-router matches case-insensitively. Reject alternate prefix casing so
  // those routes cannot bypass the session, CSRF or password-change checks.
  if (!(ctx.path === '/api' || ctx.path.startsWith('/api/'))) ctx.throw(404, '接口不存在');
  if (isExternalApiPath(ctx.path)) return externalApiAuth(ctx, next);
  const publicShareRead = ctx.method === 'GET' && /^\/api\/share\/[^/]+$/.test(ctx.path);
  const publicShareCode = ctx.method === 'POST' && /^\/api\/share\/[^/]+\/verification-code$/.test(ctx.path);
  if (publicShareRead || publicShareCode) return next();
  const publicRead = ctx.method === 'GET' && ['/api/health', '/api/auth/config', '/api/auth/check'].includes(ctx.path);
  const publicWrite = ctx.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(ctx.path);
  if (publicRead) return next();
  if (publicWrite) {
    assertCsrf(ctx);
    return next();
  }
  if (!userModel.initialized()) ctx.throw(503, '系统尚未初始化，请管理员运行初始化命令');
  const user = getUser(ctx);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) assertCsrf(ctx);
  const passwordFlow = ['/api/auth/me', '/api/auth/password', '/api/auth/logout'];
  if (user.must_change_password && !passwordFlow.includes(ctx.path)) {
    ctx.status = 403;
    ctx.body = { code: 403, data: { reason: 'PASSWORD_CHANGE_REQUIRED' }, message: '请先修改初始密码' };
    return;
  }
  return next();
}
