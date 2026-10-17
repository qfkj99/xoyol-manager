import { Context } from 'koa';
import db from '../database';
import { publicUser, userModel } from '../models/User';
import { getUser } from '../middlewares/auth';
import { success } from '../utils/response';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validateDisplayName, validatePassword, validateUsername, verifyPassword } from '../services/password';
import { clearSessionCookie, createSession, csrfForBrowser, readSession, revokeUserSessions } from '../services/session';
import { rateLimit } from '../services/rateLimit';
import { recordAudit } from '../services/audit';

// A valid fixed-format hash ensures unknown usernames still run password derivation.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

export function registrationEnabled(): boolean {
  return (db.prepare("SELECT value FROM settings WHERE key='registration_enabled'").get() as { value: string } | undefined)?.value === 'true';
}

export class AuthController {
  async config(ctx: Context) {
    success(ctx, {
      initialized: userModel.initialized(), registration_enabled: registrationEnabled() && userModel.initialized(),
      password_min_length: PASSWORD_MIN_LENGTH, password_max_length: PASSWORD_MAX_LENGTH,
      csrfToken: csrfForBrowser(ctx),
    });
  }

  async login(ctx: Context) {
    if (!userModel.initialized()) ctx.throw(503, '系统尚未初始化，请管理员运行初始化命令');
    const body = ctx.request.body as Record<string, unknown> || {};
    rateLimit(ctx, `login-ip:${ctx.ip}`, 50);
    const name = typeof body.username === 'string' ? body.username.toLowerCase().slice(0, 128) : '';
    rateLimit(ctx, `login-user:${name}`, 15);
    const user = userModel.getByUsername(name);
    const verified = await verifyPassword(body.password, user?.password_hash || DUMMY_HASH);
    const current = user ? userModel.getById(user.id) : undefined;
    if (!verified || !current || current.password_hash !== user?.password_hash || current.status !== 'active') {
      recordAudit(user?.id || null, 'auth.login', 'user', user?.id || '', ctx.ip, 'failure');
      ctx.throw(401, '用户名或密码错误，或账号不可用');
    }
    const data = db.transaction(() => {
      const latest = userModel.getById(current.id);
      if (!latest || latest.status !== 'active' || latest.password_hash !== current.password_hash) ctx.throw(401, '账号状态已变化，请重新登录');
      const csrfToken = createSession(ctx, current.id, body.remember === true);
      db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
      recordAudit(current.id, 'auth.login', 'user', current.id, ctx.ip);
      return { user: publicUser(userModel.getById(current.id)!), csrfToken };
    })();
    success(ctx, data);
  }

  async register(ctx: Context) {
    rateLimit(ctx, `register-ip:${ctx.ip}`, 10, 60 * 60 * 1000);
    if (!userModel.initialized()) ctx.throw(503, '系统尚未初始化，请管理员运行初始化命令');
    if (!registrationEnabled()) ctx.throw(403, '当前暂未开放注册');
    const body = ctx.request.body as Record<string, unknown> || {};
    if (Object.keys(body).some(key => !['username', 'display_name', 'password'].includes(key))) ctx.throw(400, '注册请求包含不允许的字段');
    const username = validateUsername(body.username);
    const display_name = validateDisplayName(body.display_name, username);
    validatePassword(body.password);
    const password_hash = await hashPassword(body.password);
    const data = db.transaction(() => {
      if (!registrationEnabled() || !userModel.initialized()) ctx.throw(403, '当前暂未开放注册');
      const user = userModel.create({ username, display_name, password_hash, role: 'user', source: 'self', must_change_password: false });
      const csrfToken = createSession(ctx, user.id);
      db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
      recordAudit(user.id, 'auth.register', 'user', user.id, ctx.ip);
      return { user: publicUser(userModel.getById(user.id)!), csrfToken };
    }).immediate();
    success(ctx, data);
  }

  async me(ctx: Context) {
    success(ctx, { user: getUser(ctx), csrfToken: readSession(ctx)!.csrf_token });
  }

  async logout(ctx: Context) {
    const user = getUser(ctx);
    const session = readSession(ctx)!;
    db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
    clearSessionCookie(ctx);
    recordAudit(user.id, 'auth.logout', 'user', user.id, ctx.ip);
    success(ctx, null);
  }

  async profile(ctx: Context) {
    const user = getUser(ctx);
    const body = ctx.request.body as Record<string, unknown> || {};
    if (Object.keys(body).some(key => key !== 'display_name') || !('display_name' in body)) ctx.throw(400, '只允许修改显示名称');
    const displayName = validateDisplayName(body.display_name, user.username);
    db.prepare('UPDATE users SET display_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(displayName, user.id);
    recordAudit(user.id, 'user.profile', 'user', user.id, ctx.ip);
    success(ctx, publicUser(userModel.getById(user.id)!));
  }

  async password(ctx: Context) {
    const user = getUser(ctx);
    rateLimit(ctx, `password-user:${user.id}`, 10);
    const body = ctx.request.body as Record<string, unknown> || {};
    validatePassword(body.new_password);
    const record = userModel.getById(user.id)!;
    if (!await verifyPassword(body.current_password, record.password_hash)) ctx.throw(400, '当前密码不正确');
    if (body.current_password === body.new_password) ctx.throw(400, '新密码不能与当前密码相同');
    const hash = await hashPassword(body.new_password);
    db.transaction(() => {
      getUser(ctx);
      if (userModel.getById(user.id)?.password_hash !== record.password_hash) ctx.throw(409, '密码已发生变化，请重新登录');
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hash, user.id);
      revokeUserSessions(user.id);
      recordAudit(user.id, 'auth.password', 'user', user.id, ctx.ip);
    }).immediate();
    clearSessionCookie(ctx);
    success(ctx, null, '密码已修改，请重新登录');
  }
}
