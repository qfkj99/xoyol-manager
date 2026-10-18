import db from '../database';
import { Account } from '../types';
import { AuthUser } from '../types/auth';
import { AccountModel } from './Account';
import { publicUser, userModel } from './User';
import { requireActiveOwner, resourceError } from '../services/resourceAccess';
import { generateUniqueShareToken, SHARE_TOKEN_PATTERN } from '../services/shareLinks';

const accounts = new AccountModel();
export { SHARE_TOKEN_PATTERN } from '../services/shareLinks';

interface ShareLinkRecord {
  id: number;
  account_id: number;
  token: string;
  owner_user_id: number;
  created_at: string;
  expires_at: number | null;
  last_accessed_at: number | null;
}

export interface ShareLinkInfo {
  enabled: boolean;
  path?: string;
  created_at?: string;
  expires_at?: string | null;
}

function linkInfo(link?: ShareLinkRecord): ShareLinkInfo {
  if (!link || (link.expires_at !== null && link.expires_at <= Date.now())) return { enabled: false };
  return {
    enabled: true, path: `/s/${link.token}`, created_at: link.created_at,
    expires_at: link.expires_at === null ? null : new Date(link.expires_at).toISOString(),
  };
}

export function invalidShareLink(): never {
  return resourceError(404, '链接无效或已失效');
}

export class ShareLinkModel {
  get(user: AuthUser, accountId: number): ShareLinkInfo {
    const account = accounts.getById(user, accountId);
    const link = db.prepare('SELECT * FROM account_share_links WHERE account_id=? AND owner_user_id=?')
      .get(accountId, account.owner_user_id) as ShareLinkRecord | undefined;
    if (!account.owner_user_id || userModel.getById(account.owner_user_id)?.status !== 'active') return { enabled: false };
    return linkInfo(link);
  }

  create(user: AuthUser, accountId: number, expiresInDays?: unknown): ShareLinkInfo {
    if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== 7 && expiresInDays !== 30) {
      resourceError(400, '有效期仅支持 7 天、30 天或长期有效');
    }
    const account = accounts.getById(user, accountId);
    const ownerId = requireActiveOwner(account.owner_user_id);
    const expiresAt = expiresInDays == null ? null : Date.now() + Number(expiresInDays) * 86_400_000;
    return db.transaction(() => {
      const token = generateUniqueShareToken();
      db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(accountId);
      db.prepare('INSERT INTO account_share_links (account_id,token,owner_user_id,expires_at) VALUES (?,?,?,?)')
        .run(accountId, token, ownerId, expiresAt);
      return this.get(user, accountId);
    }).immediate();
  }

  revoke(user: AuthUser, accountId: number): ShareLinkInfo {
    accounts.getById(user, accountId);
    db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(accountId);
    return { enabled: false };
  }

  resolveAndRecordAccess(rawToken: unknown): ReturnType<ShareLinkModel['resolve']> {
    // Keep validation and the write together. Resolving a link elsewhere (for
    // example, while fetching mail) must not create a page visit.
    return db.transaction(() => {
      const resolved = this.resolve(rawToken);
      const accessedAt = Date.now();
      db.prepare('UPDATE account_share_links SET last_accessed_at=? WHERE id=?')
        .run(accessedAt, resolved.link.id);
      return { ...resolved, link: { ...resolved.link, last_accessed_at: accessedAt } };
    }).immediate();
  }

  resolve(rawToken: unknown): { link: ShareLinkRecord; account: Account; user: AuthUser } {
    if (typeof rawToken !== 'string' || !SHARE_TOKEN_PATTERN.test(rawToken)) return invalidShareLink();
    const link = db.prepare('SELECT * FROM account_share_links WHERE token=? AND (expires_at IS NULL OR expires_at>?)')
      .get(rawToken, Date.now()) as ShareLinkRecord | undefined;
    if (!link) return invalidShareLink();
    const owner = userModel.getById(link.owner_user_id);
    const account = db.prepare('SELECT * FROM accounts WHERE id=? AND owner_user_id=?')
      .get(link.account_id, link.owner_user_id) as Account | undefined;
    if (!account || !owner || owner.status !== 'active' || owner.must_change_password) return invalidShareLink();
    return { link, account, user: publicUser(owner) };
  }
}
