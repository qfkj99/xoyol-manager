import Router from 'koa-router';
import db from '../database';
import { assertAdmin } from '../middlewares/auth';
import { registrationEnabled } from '../controllers/AuthController';
import { recordAudit } from '../services/audit';
import { success } from '../utils/response';
import { getShortLinkLength, MIN_SHORT_LINK_LENGTH, MAX_SHORT_LINK_LENGTH } from '../services/shareLinks';

function currentSettings() {
  return { registration_enabled: registrationEnabled(), short_link_length: getShortLinkLength() };
}

export const settingsRoutes = new Router();
settingsRoutes.get('/', ctx => {
  assertAdmin(ctx);
  success(ctx, currentSettings());
});
settingsRoutes.patch('/', ctx => {
  const actor = assertAdmin(ctx);
  const body = ctx.request.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ctx.throw(400, '设置参数无效');
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !['registration_enabled', 'short_link_length'].includes(key))) ctx.throw(400, '设置参数无效');
  const updateRegistration = keys.includes('registration_enabled'), updateLength = keys.includes('short_link_length');
  if (updateRegistration && typeof body.registration_enabled !== 'boolean') ctx.throw(400, '注册开关必须为布尔值');
  if (updateLength && (typeof body.short_link_length !== 'number' || !Number.isInteger(body.short_link_length)
    || body.short_link_length < MIN_SHORT_LINK_LENGTH || body.short_link_length > MAX_SHORT_LINK_LENGTH)) {
    ctx.throw(400, `短链长度必须为 ${MIN_SHORT_LINK_LENGTH} 至 ${MAX_SHORT_LINK_LENGTH} 的整数`);
  }
  db.transaction(() => {
    const update = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    if (updateRegistration) {
      update.run('registration_enabled', String(body.registration_enabled));
      recordAudit(actor.id, body.registration_enabled ? 'settings.registration_open' : 'settings.registration_close', 'settings', 'registration_enabled', ctx.ip);
    }
    if (updateLength) {
      update.run('short_link_length', String(body.short_link_length));
      recordAudit(actor.id, 'settings.short_link_length_update', 'settings', 'short_link_length', ctx.ip);
    }
  }).immediate();
  success(ctx, currentSettings());
});
