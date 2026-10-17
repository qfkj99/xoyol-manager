import { AccountModel } from '../models/Account';
import { MailCacheModel } from '../models/MailCache';
import { ProxyModel } from '../models/Proxy';
import { OAuthService } from './OAuthService';
import { GraphApiService } from './GraphApiService';
import { ImapService } from './ImapService';
import { FetchMailsResult, FetchVerificationMailsResult, MailMessage, Proxy, VerificationMail } from '../types';
import { AuthUser } from '../types/auth';
import { limitResourceAction, lockResources, resourceError } from './resourceAccess';
import { validateProxyEndpoint } from './ProxyService';

const accountModel = new AccountModel(), cacheModel = new MailCacheModel(), proxyModel = new ProxyModel();
const oauthService = new OAuthService(), graphService = new GraphApiService(), imapService = new ImapService();

export function validMailbox(value: unknown): 'INBOX' | 'Junk' {
  if (value !== 'INBOX' && value !== 'Junk') resourceError(400, '邮箱文件夹无效');
  return value;
}

// Older clients may still send their last folder choice. Verification always
// searches both folders, while ordinary mail browsing keeps its folder choice.
export function validVerificationMailbox(value: unknown): void {
  if (value !== undefined && value !== 'ALL' && value !== 'INBOX' && value !== 'Junk') resourceError(400, '邮箱文件夹无效');
}

export class MailService {
  private selectProxy(user: AuthUser, ownerId: number | null, proxyId?: number): Proxy | undefined {
    return proxyId ? proxyModel.getById(user, proxyId) : proxyModel.getDefault(user, ownerId);
  }

  async fetchVerificationMails(user: AuthUser, accountId: number, proxyId?: number, top = 20, validateAccess?: (refreshedToken?: string) => void): Promise<FetchVerificationMailsResult> {
    validateAccess?.();
    const account = accountModel.getById(user, accountId);
    const proxy = this.selectProxy(user, account.owner_user_id, proxyId);
    // Both folders form one user operation, sharing the lock and rate budget.
    limitResourceAction(user.id, 'mail', 30, 60000);
    limitResourceAction(accountId, 'mail-account', 1, 3000);
    const release = lockResources([accountId], proxy ? [proxy.id] : []);
    try {
      if (proxy) await validateProxyEndpoint(proxy);
      validateAccess?.();
      let graphToken: string | undefined;
      try {
        const token = await oauthService.refreshGraphToken(account.client_id, account.refresh_token, proxy);
        validateAccess?.();
        accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
        validateAccess?.(token.refresh_token || undefined);
        if (token.has_mail_scope) graphToken = token.access_token;
      } catch (error: any) { if (error.status) throw error; validateAccess?.(); }

      let imapAttempted = false, imapAuth: string | undefined;
      const imapAuthorization = async (): Promise<string | undefined> => {
        if (imapAttempted) return imapAuth;
        imapAttempted = true;
        validateAccess?.();
        try {
          const fresh = accountModel.getById(user, accountId);
          const token = await oauthService.refreshImapToken(fresh.client_id, fresh.refresh_token, proxy);
          validateAccess?.();
          accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
          validateAccess?.(token.refresh_token || undefined);
          imapAuth = imapService.generateAuthString(fresh.email, token.access_token);
        } catch (error: any) { if (error.status) throw error; validateAccess?.(); }
        return imapAuth;
      };
      const mails: VerificationMail[] = [], protocols = new Set<'graph' | 'imap'>();
      const freshFolders: { mailbox: 'INBOX' | 'Junk'; mails: Partial<MailMessage>[] }[] = [];
      const warnings: string[] = [];
      for (const mailbox of ['INBOX', 'Junk'] as const) {
        let received: Partial<MailMessage>[] | undefined;
        validateAccess?.();
        if (graphToken) {
          try {
            received = await graphService.fetchMails(graphToken, mailbox, top, proxy);
            validateAccess?.();
            protocols.add('graph');
          } catch (error: any) { if (error.status) throw error; validateAccess?.(); }
        }
        if (received === undefined) {
          const authString = await imapAuthorization();
          validateAccess?.();
          if (authString) {
            try {
              received = await imapService.fetchMails(account.email, authString, mailbox, top, proxy);
              validateAccess?.();
              protocols.add('imap');
            } catch (error: any) { if (error.status) throw error; validateAccess?.(); }
          }
        }
        if (received !== undefined) {
          freshFolders.push({ mailbox, mails: received });
          mails.push(...received.map(mail => ({ ...mail, mailbox, cached: false })));
        } else {
          const cached = cacheModel.getByAccount(user, accountId, mailbox, 1, top);
          mails.push(...cached.list.map(mail => ({ ...mail, mailbox, cached: true })));
          warnings.push(`${mailbox === 'INBOX' ? '收件箱' : '垃圾箱'}实时读取失败${cached.list.length ? '，已显示历史缓存' : '，暂无历史缓存'}`);
        }
      }
      validateAccess?.();
      if (!freshFolders.length && !mails.length) {
        accountModel.markError(accountId);
        return resourceError(502, '收信失败，请检查邮箱授权或代理配置');
      }
      // Do not publish/cache a half-finished operation if its share was revoked
      // while the other folder was being read.
      for (const fresh of freshFolders) cacheModel.upsert(accountId, fresh.mailbox, fresh.mails);
      if (freshFolders.length) accountModel.updateSyncTime(accountId);
      else accountModel.markError(accountId);
      mails.sort((a, b) => (Date.parse(b.mail_date || '') || 0) - (Date.parse(a.mail_date || '') || 0));
      return {
        mails, total: mails.length, protocol: protocols.size > 1 ? 'mixed' : protocols.values().next().value || 'graph',
        cached: mails.some(mail => mail.cached), partial: warnings.length > 0,
        ...(warnings.length ? { warning: warnings.join('；') } : {}),
      };
    } finally { release(); }
  }

  async fetchMails(user: AuthUser, accountId: number, mailbox: string, proxyId?: number, top = 50, validateAccess?: (refreshedToken?: string) => void): Promise<FetchMailsResult> {
    validMailbox(mailbox);
    validateAccess?.();
    const account = accountModel.getById(user, accountId);
    const proxy = this.selectProxy(user, account.owner_user_id, proxyId);
    limitResourceAction(user.id, 'mail', 30, 60000);
    limitResourceAction(accountId, 'mail-account', 1, 3000);
    const release = lockResources([accountId], proxy ? [proxy.id] : []);
    try {
      if (proxy) await validateProxyEndpoint(proxy); // Reject forbidden network targets before any Microsoft request.
      validateAccess?.();
      try {
        const token = await oauthService.refreshGraphToken(account.client_id, account.refresh_token, proxy);
        validateAccess?.();
        accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
        validateAccess?.(token.refresh_token || undefined);
        if (token.has_mail_scope) {
          const mails = await graphService.fetchMails(token.access_token, mailbox, top, proxy);
          validateAccess?.();
          cacheModel.upsert(accountId, mailbox, mails);
          accountModel.updateSyncTime(accountId);
          return { mails: mails as any, total: mails.length, protocol: 'graph', cached: false };
        }
      } catch (error: any) { if (error.status) throw error; }
      try {
        validateAccess?.();
        const fresh = accountModel.getById(user, accountId);
        const token = await oauthService.refreshImapToken(fresh.client_id, fresh.refresh_token, proxy);
        validateAccess?.();
        accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
        validateAccess?.(token.refresh_token || undefined);
        const mails = await imapService.fetchMails(fresh.email, imapService.generateAuthString(fresh.email, token.access_token), mailbox, top, proxy);
        validateAccess?.();
        cacheModel.upsert(accountId, mailbox, mails);
        accountModel.updateSyncTime(accountId);
        return { mails: mails as any, total: mails.length, protocol: 'imap', cached: false };
      } catch (error: any) {
        if (error.status) throw error;
        validateAccess?.();
        accountModel.markError(accountId);
        const cached = cacheModel.getByAccount(user, accountId, mailbox, 1, top);
        if (cached.list.length) return { mails: cached.list, total: cached.total, protocol: 'graph', cached: true };
        return resourceError(502, '收信失败，请检查邮箱授权或代理配置');
      }
    } finally { release(); }
  }

  async clearMailbox(user: AuthUser, accountId: number, mailbox: string, proxyId?: number): Promise<void> {
    validMailbox(mailbox);
    const account = accountModel.getById(user, accountId);
    const proxy = this.selectProxy(user, account.owner_user_id, proxyId);
    limitResourceAction(user.id, 'mail-clear', 5, 60000);
    const release = lockResources([accountId], proxy ? [proxy.id] : []);
    try {
      if (proxy) await validateProxyEndpoint(proxy);
      let cleared = false;
      try {
        const token = await oauthService.refreshGraphToken(account.client_id, account.refresh_token, proxy);
        accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
        if (token.has_mail_scope) { await graphService.deleteAllMails(token.access_token, mailbox, proxy); cleared = true; }
      } catch (error: any) { if (error.status) throw error; }
      if (!cleared) {
        try {
          const fresh = accountModel.getById(user, accountId);
          const token = await oauthService.refreshImapToken(fresh.client_id, fresh.refresh_token, proxy);
          accountModel.updateTokenRefreshTime(accountId, token.refresh_token);
          await imapService.clearMailbox(fresh.email, imapService.generateAuthString(fresh.email, token.access_token), mailbox, proxy);
        } catch (error: any) { if (error.status) throw error; return resourceError(502, '清空邮件失败，请检查邮箱授权或代理配置'); }
      }
      cacheModel.clearByAccount(user, accountId, mailbox);
    } finally { release(); }
  }
}
