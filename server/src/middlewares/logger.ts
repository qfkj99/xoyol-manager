import { Context, Next } from 'koa';
import logger from '../utils/logger';

/** Capability URLs must not appear in application access or error logs. */
export function requestUrlForLog(ctx: Context): string {
  if (/^\/api\/share(?:\/|$)/.test(ctx.path)) return '/api/share/[redacted]';
  if (/^\/s(?:\/|$)/.test(ctx.path)) return '/s/[redacted]';
  return ctx.url;
}

export async function loggerMiddleware(ctx: Context, next: Next) {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info(`${ctx.method} ${requestUrlForLog(ctx)} ${ctx.status} - ${ms}ms`);
}
