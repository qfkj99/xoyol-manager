import { Context } from 'koa';

const attempts = new Map<string, { count: number; expires: number }>();
let lastCleanup = 0;

/** Fixed windows limit both guessing and expensive password hashing work. */
export function rateLimit(ctx: Context, key: string, maximum: number, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  if (now - lastCleanup > 60_000) {
    for (const [k, value] of attempts) if (value.expires <= now) attempts.delete(k);
    lastCleanup = now;
  }
  let value = attempts.get(key);
  if (!value || value.expires <= now) value = { count: 0, expires: now + windowMs };
  value.count += 1;
  attempts.set(key, value);
  if (value.count > maximum) {
    ctx.set('Retry-After', String(Math.ceil((value.expires - now) / 1000)));
    ctx.throw(429, '操作过于频繁，请稍后再试');
  }
}
