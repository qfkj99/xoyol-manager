import { Context } from 'koa';
import db from '../database';
import { config } from '../config';
import { assertApiKey } from '../middlewares/apiKey';
import { AccountModel } from '../models/Account';
import { ShareLinkModel } from '../models/ShareLink';
import { Account } from '../types';
import { recordAudit } from '../services/audit';
import { MailService, validVerificationMailbox } from '../services/MailService';
import { limitResourceAction, pageNumber, positiveId, resourceError } from '../services/resourceAccess';
import { verificationCodeCandidates } from '../services/VerificationCodeService';
import { success } from '../utils/response';

const accounts = new AccountModel(), links = new ShareLinkModel(), mail = new MailService();
const importFields = ['game_account', 'game_password', 'real_name', 'id_last_six', 'email', 'password', 'client_id', 'refresh_token'];

function jsonBody(ctx: Context, allowed: string[]): Record<string, any> {
  if (!ctx.is('application/json')) ctx.throw(415, '请使用 application/json 请求');
  const body = ctx.request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) ctx.throw(400, '请求内容必须是 JSON 对象');
  if (Object.keys(body).some(key => !allowed.includes(key))) ctx.throw(400, `请求仅支持以下字段：${allowed.join('、')}`);
  return body as Record<string, any>;
}

function publicOrigin(ctx: Context): string {
  try {
    const url = new URL(config.appOrigin || `${ctx.protocol}://${ctx.host}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { return resourceError(503, '站点地址配置无效，请管理员检查 APP_ORIGIN'); }
}

function audit(ctx: Context, action: string, targetType: string, targetId: number | string) {
  recordAudit(ctx.state.apiUser.id, `external.${action}`, targetType, targetId, ctx.ip);
}

function shareFields(account: Account, origin: string, path?: string, expiresAt?: number | null) {
  const enabled = account.share_link_enabled === true && !!path;
  return {
    share_link_enabled: enabled,
    share_path: enabled ? path! : null,
    share_url: enabled ? origin + path! : null,
    share_link_last_accessed_at: enabled ? account.share_link_last_accessed_at ?? null : null,
    share_link_expires_at: enabled && expiresAt != null ? new Date(expiresAt).toISOString() : null,
  };
}

function deliveryAccount(account: Account, origin: string) {
  const link = db.prepare('SELECT token,expires_at FROM account_share_links WHERE account_id=? AND owner_user_id=?')
    .get(account.id, account.owner_user_id) as { token: string; expires_at: number | null } | undefined;
  return {
    id: account.id, owner_user_id: account.owner_user_id,
    game_account: account.game_account, game_password: account.game_password,
    real_name: account.real_name, id_last_six: account.id_last_six, email: account.email,
    claim_status: account.claim_status, status: account.status, remark: account.remark,
    created_at: account.created_at, updated_at: account.updated_at,
    ...shareFields(account, origin, link ? `/s/${link.token}` : undefined, link?.expires_at),
  };
}

// Retry deliveries only when all eight credentials match. A guessed account or
// email must not turn an import-only key into a read key for existing records.
function sameImportCredentials(account: Account, values: string[]): boolean {
  return importFields.every((field, index) => {
    let value = values[index];
    if (field === 'game_account') return account.game_account.toLowerCase() === value.trim().toLowerCase();
    if (field === 'email') value = value.trim().toLowerCase();
    if (field === 'real_name') value = value.trim();
    if (field === 'id_last_six') value = value.trim().toUpperCase();
    return (account as any)[field] === value;
  });
}

export class ExternalApiController {
  async list(ctx: Context) {
    const user = assertApiKey(ctx, 'accounts:read');
    const { page, pageSize, search = '', owner_user_id, claim_status } = ctx.query;
    if (typeof search !== 'string' || search.length > 200) ctx.throw(400, '搜索内容无效');
    const origin = publicOrigin(ctx);
    const result = accounts.list(user, pageNumber(page, 1), pageNumber(pageSize, 20, 200), search, owner_user_id, claim_status);
    audit(ctx, 'account.list', 'account', 'list');
    success(ctx, { ...result, list: result.list.map(account => deliveryAccount(account, origin)) });
  }

  async details(ctx: Context) {
    const user = assertApiKey(ctx, 'accounts:read'), id = positiveId(ctx.params.id);
    const account = accounts.getById(user, id);
    audit(ctx, 'account.credentials', 'account', id);
    success(ctx, {
      ...deliveryAccount(account, publicOrigin(ctx)), password: account.password,
      client_id: account.client_id, refresh_token: account.refresh_token,
    });
  }

  async import(ctx: Context) {
    const user = assertApiKey(ctx, 'accounts:import');
    const body = jsonBody(ctx, ['content', 'placement', 'mode']);
    if (body.mode !== undefined && !['skip', 'overwrite'].includes(body.mode)) ctx.throw(400, '导入模式仅支持 skip 或 overwrite');
    const origin = publicOrigin(ctx);
    const request = {
      content: body.content, separator: '----', format: importFields,
      placement: body.placement ?? 'owned', mode: body.mode ?? 'skip', generate_share_links: true,
    } as const;
    limitResourceAction(user.id, 'account-import', 10, 60_000);
    const result = db.transaction(() => {
      const preview = accounts.importPreview(user, request);
      const imported = accounts.importConfirm(user, request);
      const delivered: ReturnType<typeof deliveryAccount>[] = [];
      const sourceLines = request.content.split(/\r?\n/).filter((line: string) => line.trim());
      const validLines = [...preview.newItems, ...preview.duplicates].sort((a, b) => a.line - b.line);
      for (const item of validLines) {
        const stored = db.prepare('SELECT id FROM accounts WHERE (lower(game_account)=lower(?) OR lower(email)=lower(?)) AND owner_user_id=?')
          .get(item.game_account, item.email, user.id) as { id: number } | undefined;
        if (!stored) continue;
        let account = accounts.getById(user, stored.id);
        if (!sameImportCredentials(account, sourceLines[item.line - 1].split('----'))) {
          imported.errors.push(`第 ${item.line} 行：已有账号的资料不一致，已跳过，未返回短链；如需更新请明确指定 mode 为 overwrite`);
          continue;
        }
        if (!account.share_link_enabled) {
          links.create(user, account.id);
          account = accounts.getById(user, account.id);
        }
        delivered.push(deliveryAccount(account, origin));
      }
      return {
        imported: imported.imported, skipped: imported.skipped, errors: imported.errors,
        accounts: delivered,
        export_content: delivered.map(account => [account.game_account, account.game_password, account.real_name, account.id_last_six, account.share_url].join('----')).join('\n'),
        ...(imported.claim_codes ? { claim_codes: imported.claim_codes } : {}),
      };
    }).immediate();
    audit(ctx, 'account.import', 'account', result.imported);
    success(ctx, result);
  }

  async shareLink(ctx: Context) {
    const user = assertApiKey(ctx, 'accounts:read'), id = positiveId(ctx.params.id);
    const account = accounts.getById(user, id);
    const link = account.share_link_enabled ? links.get(user, id) : { enabled: false };
    audit(ctx, 'account.share-read', 'account', id);
    success(ctx, {
      ...link, ...(link.enabled && link.path ? {
        url: publicOrigin(ctx) + link.path, last_accessed_at: account.share_link_last_accessed_at ?? null,
      } : {}),
    });
  }

  async createShareLink(ctx: Context) {
    const user = assertApiKey(ctx, 'share-links:write'), id = positiveId(ctx.params.id);
    const body = jsonBody(ctx, ['expires_in_days']), origin = publicOrigin(ctx);
    const account = accounts.getById(user, id);
    const owner = db.prepare('SELECT status,must_change_password FROM users WHERE id=?').get(account.owner_user_id) as { status: string; must_change_password: number } | undefined;
    if (!owner || owner.status !== 'active' || owner.must_change_password) ctx.throw(409, '账号所属用户当前无法使用短链');
    limitResourceAction(user.id, 'account-share-create', 30, 60_000);
    const link = links.create(user, id, body.expires_in_days);
    audit(ctx, 'account.share-create', 'account', id);
    success(ctx, { ...link, url: origin + link.path, last_accessed_at: null });
  }

  async revokeShareLink(ctx: Context) {
    const user = assertApiKey(ctx, 'share-links:write'), id = positiveId(ctx.params.id);
    const result = links.revoke(user, id);
    audit(ctx, 'account.share-revoke', 'account', id);
    success(ctx, result);
  }

  async verificationCode(ctx: Context) {
    const user = assertApiKey(ctx, 'mail:read'), id = positiveId(ctx.params.id);
    const body = jsonBody(ctx, ['mailbox']);
    validVerificationMailbox(body.mailbox);
    const initial = accounts.getById(user, id);
    let expectedRefreshToken = initial.refresh_token;
    const revalidate = (refreshedToken?: string) => {
      const current = accounts.getById(assertApiKey(ctx, 'mail:read'), id);
      if (current.owner_user_id !== initial.owner_user_id || current.email !== initial.email ||
          current.client_id !== initial.client_id || current.refresh_token !== (refreshedToken ?? expectedRefreshToken)) {
        ctx.throw(409, '账号归属或邮箱绑定已变化，请重新请求');
      }
      if (refreshedToken !== undefined) expectedRefreshToken = refreshedToken;
    };
    const result = await mail.fetchVerificationMails(user, id, undefined, 20, revalidate);
    revalidate();
    audit(ctx, 'mail.verification-code', 'account', id);
    success(ctx, {
      account_id: id, email: initial.email, mailbox: 'ALL', mailboxes: ['INBOX', 'Junk'],
      candidates: verificationCodeCandidates(result.mails), cached: result.cached,
      protocol: result.protocol, partial: result.partial, warning: result.warning, fetched_at: new Date().toISOString(),
    });
  }
}
