import { Context } from 'koa';
import { MailService, validMailbox, validVerificationMailbox } from '../services/MailService';
import { MailCacheModel } from '../models/MailCache';
import { success } from '../utils/response';
import { getUser } from '../middlewares/auth';
import { pageNumber, positiveId } from '../services/resourceAccess';
import { recordAudit } from '../services/audit';
import { AccountModel } from '../models/Account';
import { ProxyModel } from '../models/Proxy';
import { verificationCodeCandidates } from '../services/VerificationCodeService';

const mailService = new MailService(), cacheModel = new MailCacheModel(), accountModel = new AccountModel(), proxyModel = new ProxyModel();
function mailInput(ctx: Context) {
  const body = (ctx.request.body || {}) as any;
  return { accountId: positiveId(body.account_id, 'account_id'), mailbox: validMailbox(body.mailbox ?? 'INBOX'), proxyId: body.proxy_id === undefined ? undefined : positiveId(body.proxy_id, 'proxy_id') };
}
function revalidateAccess(ctx: Context, accountId: number, proxyId?: number) {
  const current = getUser(ctx);
  accountModel.getById(current, accountId);
  if (proxyId) proxyModel.getById(current, proxyId);
}
export class MailController {
  async verificationCode(ctx: Context) {
    const user = getUser(ctx), body = (ctx.request.body || {}) as any;
    validVerificationMailbox(body.mailbox);
    const accountId = positiveId(body.account_id, 'account_id');
    const proxyId = body.proxy_id === undefined ? undefined : positiveId(body.proxy_id, 'proxy_id');
    const result = await mailService.fetchVerificationMails(user, accountId, proxyId, 20, () => revalidateAccess(ctx, accountId, proxyId));
    revalidateAccess(ctx, accountId, proxyId);
    const account = accountModel.getById(getUser(ctx), accountId);
    recordAudit(user.id, 'mail.verification-code', 'account', accountId, ctx.ip);
    success(ctx, {
      account_id: accountId, email: account.email, mailbox: 'ALL', mailboxes: ['INBOX', 'Junk'],
      candidates: verificationCodeCandidates(result.mails),
      cached: result.cached, protocol: result.protocol, partial: result.partial, warning: result.warning, fetched_at: new Date().toISOString(),
    });
  }
  async fetch(ctx: Context) {
    const user = getUser(ctx), { accountId, mailbox, proxyId } = mailInput(ctx);
    const result = await mailService.fetchMails(user, accountId, mailbox, proxyId);
    revalidateAccess(ctx, accountId, proxyId);
    recordAudit(user.id, 'mail.fetch', 'account', accountId, ctx.ip);
    success(ctx, result);
  }
  async fetchNew(ctx: Context) {
    const user = getUser(ctx), { accountId, mailbox, proxyId } = mailInput(ctx);
    const result = await mailService.fetchMails(user, accountId, mailbox, proxyId, 1);
    revalidateAccess(ctx, accountId, proxyId);
    recordAudit(user.id, 'mail.fetch-new', 'account', accountId, ctx.ip);
    success(ctx, result.mails[0] || null);
  }
  async clear(ctx: Context) {
    const user = getUser(ctx), { accountId, mailbox, proxyId } = mailInput(ctx);
    await mailService.clearMailbox(user, accountId, mailbox, proxyId);
    revalidateAccess(ctx, accountId, proxyId);
    recordAudit(user.id, 'mail.clear', 'account', accountId, ctx.ip);
    success(ctx, { message: '邮件已清空' });
  }
  async cached(ctx: Context) {
    const { account_id, mailbox = 'INBOX', page, pageSize } = ctx.query;
    success(ctx, cacheModel.getByAccount(getUser(ctx), positiveId(account_id, 'account_id'), validMailbox(mailbox), pageNumber(page, 1), pageNumber(pageSize, 50, 500)));
  }
}
