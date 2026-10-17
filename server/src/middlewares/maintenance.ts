import { Context, Next } from 'koa';

let maintenance = false;
const active = new Set<Context>();
const listeners = new Set<() => void>();

export async function maintenanceMiddleware(ctx: Context, next: Next) {
  if (!ctx.path.startsWith('/api/')) return next();
  if (maintenance) {
    ctx.status = 503;
    ctx.set('Retry-After', '5');
    ctx.body = { code: 503, data: null, message: '系统正在恢复数据，请稍后重试' };
    return;
  }
  active.add(ctx);
  try {
    await next();
  } finally {
    active.delete(ctx);
    for (const listener of listeners) listener();
  }
}

/** Prevent new requests and let all previous handlers finish before swapping files. */
export async function beginMaintenance(ctx: Context): Promise<() => void> {
  if (maintenance) ctx.throw(409, '已有维护操作正在执行');
  maintenance = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if ([...active].every(request => request === ctx)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(Object.assign(new Error('仍有邮件操作正在执行，请等待完成后再恢复'), { status: 409 }));
      }, 30_000);
      listeners.add(check);
      check();
    });
    return () => { maintenance = false; };
  } catch (error) {
    maintenance = false;
    throw error;
  }
}
