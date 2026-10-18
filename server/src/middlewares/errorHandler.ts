import { Context, Next } from 'koa';
import logger from '../utils/logger';
import { requestUrlForLog } from './logger';

export async function errorHandler(ctx: Context, next: Next) {
  try {
    await next();
  } catch (err: any) {
    const status = err.status || 500;
    // co-body attaches the raw JSON to parsing errors. V8's message can quote
    // that body, so importing credentials must not expose it in logs or replies.
    const invalidExternalJson = /^\/api\/external\/v1(?:\/|$)/i.test(ctx.path)
      && status === 400 && typeof err.body === 'string' && err instanceof SyntaxError;
    const message = invalidExternalJson ? 'JSON 格式错误' : err.message || 'Internal Server Error';
    logger.error(`[${status}] ${ctx.method} ${requestUrlForLog(ctx)} - ${message}`);
    ctx.status = status;
    ctx.body = { code: status, data: null, message };
  }
}
