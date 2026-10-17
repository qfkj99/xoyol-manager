import { Context } from 'koa';
import { createHash } from 'crypto';
import { config } from '../config';
import { getUser } from '../middlewares/auth';
import { invalidShareLink, ShareLinkModel } from '../models/ShareLink';
import { recordAudit } from '../services/audit';
import { MailService, validVerificationMailbox } from '../services/MailService';
import { rateLimit } from '../services/rateLimit';
import { limitResourceAction, positiveId } from '../services/resourceAccess';
import { verificationCodeCandidates } from '../services/VerificationCodeService';
import { success } from '../utils/response';

const model = new ShareLinkModel(), mailService = new MailService();

function assertPublicRequest(ctx: Context) {
  // The unpredictable URL token authorizes this single account. The public page
  // works independently of any login session or its CSRF cookie.
  const expectedOrigin = config.appOrigin ? new URL(config.appOrigin).origin : `${ctx.protocol}://${ctx.host}`;
  const origin = ctx.get('Origin');
  if ((origin && origin !== expectedOrigin) || ctx.get('Sec-Fetch-Site') === 'cross-site') {
    ctx.throw(403, '请求来源不受信任');
  }
  if (!ctx.is('application/json')) ctx.throw(415, '请使用 JSON 请求');
}

export class ShareLinkController {
  async get(ctx: Context) {
    success(ctx, model.get(getUser(ctx), positiveId(ctx.params.id)));
  }

  async create(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    limitResourceAction(user.id, 'account-share-create', 30, 60_000);
    const result = model.create(user, id, (ctx.request.body as any)?.expires_in_days);
    recordAudit(user.id, 'account.share-create', 'account', id, ctx.ip);
    success(ctx, result);
  }

  async revoke(ctx: Context) {
    const user = getUser(ctx), id = positiveId(ctx.params.id);
    const result = model.revoke(user, id);
    recordAudit(user.id, 'account.share-revoke', 'account', id, ctx.ip);
    success(ctx, result);
  }

  async details(ctx: Context) {
    rateLimit(ctx, `share-read:${ctx.ip}`, 120, 60_000);
    const { account, link } = model.resolve(ctx.params.token);
    // Explicitly enumerate fields: owner IDs, claim codes and unrelated data
    // must never become visible when the account model gains new fields.
    success(ctx, {
      game_account: account.game_account, game_password: account.game_password,
      real_name: account.real_name, id_last_six: account.id_last_six,
      email: account.email, password: account.password, client_id: account.client_id,
      refresh_token: account.refresh_token, remark: account.remark, status: account.status,
      expires_at: link.expires_at === null ? null : new Date(link.expires_at).toISOString(),
    });
  }

  async verificationCode(ctx: Context) {
    assertPublicRequest(ctx);
    rateLimit(ctx, `share-code-ip:${ctx.ip}`, 30, 60_000);
    const token = ctx.params.token;
    const initial = model.resolve(token);
    const tokenKey = createHash('sha256').update(token).digest('hex');
    rateLimit(ctx, `share-code-token:${tokenKey}`, 20, 60_000);
    const body = (ctx.request.body || {}) as any;
    if (body.account_id !== undefined || body.proxy_id !== undefined) ctx.throw(400, '短链收信仅支持当前账号');
    validVerificationMailbox(body.mailbox);
    let expectedRefreshToken = initial.account.refresh_token;
    const assertAccess = (refreshedToken?: string) => {
      const current = model.resolve(token);
      if (current.link.id !== initial.link.id || current.account.id !== initial.account.id ||
          current.account.owner_user_id !== initial.account.owner_user_id ||
          current.account.email !== initial.account.email || current.account.client_id !== initial.account.client_id ||
          current.account.refresh_token !== (refreshedToken ?? expectedRefreshToken)) {
        invalidShareLink();
      }
      // Only the OAuth refresh completed by this operation may advance the
      // expected binding. Unrelated refresh-token edits invalidate the response.
      if (refreshedToken !== undefined) expectedRefreshToken = refreshedToken;
    };
    const result = await mailService.fetchVerificationMails(initial.user, initial.account.id, undefined, 20, assertAccess);
    assertAccess();
    recordAudit(null, 'account.share-verification-code', 'account', initial.account.id, ctx.ip);
    success(ctx, {
      account_id: initial.account.id, email: initial.account.email, mailbox: 'ALL', mailboxes: ['INBOX', 'Junk'],
      candidates: verificationCodeCandidates(result.mails), cached: result.cached,
      protocol: result.protocol, partial: result.partial, warning: result.warning, fetched_at: new Date().toISOString(),
    });
  }
}
