import { Context } from 'koa';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import db from '../database';
import { config } from '../config';
import { publicUser, userModel } from '../models/User';

export const SESSION_COOKIE = 'xoyol_session';
const CSRF_COOKIE = 'xoyol_csrf';
export interface SessionRecord { id: number; user_id: number; token_hash: string; csrf_token: string; expires_at: number }

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(ctx: Context) {
  return { httpOnly: true, secure: config.cookieSecure || ctx.secure, sameSite: 'lax' as const, path: '/', overwrite: true };
}

export function readSession(ctx: Context): SessionRecord | undefined {
  const token = ctx.cookies.get(SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now()) as SessionRecord | undefined;
}

export function createSession(ctx: Context, userId: number, remember = false) {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const maxAge = remember ? config.rememberDays * 86_400_000 : config.sessionHours * 3_600_000;
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  // Rotate a previously authenticated browser session rather than leaving it live.
  const existing = readSession(ctx);
  if (existing) db.prepare('DELETE FROM sessions WHERE id=?').run(existing.id);
  db.prepare('INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES (?,?,?,?)')
    .run(userId, tokenHash(token), csrfToken, Date.now() + maxAge);
  ctx.cookies.set(SESSION_COOKIE, token, { ...cookieOptions(ctx), maxAge });
  ctx.cookies.set(CSRF_COOKIE, null, cookieOptions(ctx));
  return csrfToken;
}

export function clearSessionCookie(ctx: Context) {
  ctx.cookies.set(SESSION_COOKIE, null, cookieOptions(ctx));
  ctx.cookies.set(CSRF_COOKIE, null, cookieOptions(ctx));
}

export function revokeUserSessions(userId: number) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

export function csrfForBrowser(ctx: Context): string {
  const session = readSession(ctx);
  if (session) {
    const user = userModel.getById(session.user_id);
    if (user?.status === 'active') return session.csrf_token;
  }
  let token = ctx.cookies.get(CSRF_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) token = randomBytes(32).toString('hex');
  ctx.cookies.set(CSRF_COOKIE, token, { ...cookieOptions(ctx), maxAge: 3_600_000 });
  return token;
}

export function assertCsrf(ctx: Context) {
  // Koa 3's ctx.origin reads the untrusted Origin header, not the server URL.
  const configuredOrigin = config.appOrigin ? new URL(config.appOrigin).origin : `${ctx.protocol}://${ctx.host}`;
  const origin = ctx.get('Origin');
  const fetchSite = ctx.get('Sec-Fetch-Site');
  if ((origin && origin !== configuredOrigin) || fetchSite === 'cross-site') ctx.throw(403, '请求来源不受信任');
  const expected = readSession(ctx)?.csrf_token || ctx.cookies.get(CSRF_COOKIE);
  const received = ctx.get('X-CSRF-Token');
  if (!expected || !/^[a-f0-9]{64}$/.test(received) || expected.length !== received.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) ctx.throw(403, '安全校验失败，请刷新页面后重试');
}

export function sessionUser(ctx: Context) {
  const session = readSession(ctx);
  if (!session) return undefined;
  const record = userModel.getById(session.user_id);
  if (!record || record.status !== 'active') return undefined;
  return { user: publicUser(record), session };
}
