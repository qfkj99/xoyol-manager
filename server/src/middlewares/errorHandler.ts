import { Context, Next } from 'koa';
import logger from '../utils/logger';
import { requestUrlForLog } from './logger';

export async function errorHandler(ctx: Context, next: Next) {
  try {
    await next();
  } catch (err: any) {
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    logger.error(`[${status}] ${ctx.method} ${requestUrlForLog(ctx)} - ${message}`);
    ctx.status = status;
    ctx.body = { code: status, data: null, message };
  }
}
