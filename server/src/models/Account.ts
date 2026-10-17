import db from '../database';
import { createHash, randomBytes } from 'crypto';
import { Account, ClaimCode, PaginatedResponse, ImportRequest, ImportResult, ImportShareExport } from '../types';
import { AuthUser } from '../types/auth';
import { TagModel } from './Tag';
import { assertResourcesIdle, createOwner, idList, ownerScope, ownerWhere, requireActiveOwner, requireResource, resourceError } from '../services/resourceAccess';
import { generateUniqueShareToken, SHARE_TOKEN_PATTERN } from '../services/shareLinks';

const tagModel = new TagModel();
const legacyImportFields = ['email', 'password', 'client_id', 'refresh_token'];
const importFields = ['game_account', 'game_password', 'real_name', 'id_last_six', ...legacyImportFields];
const exportFields = [...importFields, 'remark', 'status'];
const gameFields = ['game_account', 'game_password', 'real_name', 'id_last_six'] as const;
const claimDurationMs = 7 * 24 * 60 * 60 * 1000;
const clearClaimSql = "claim_status = 'assigned', claim_code_hash = NULL, claim_code_expires_at = NULL";

function transferImportedShareLink(accountId: number, previousOwnerId: number | null, ownerId: number) {
  // Importing delivered account details keeps the delivered URL and its expiry.
  // A revoked, expired or unrelated owner's link must never become valid again.
  if (previousOwnerId === null) {
    db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(accountId);
    return;
  }
  db.prepare('DELETE FROM account_share_links WHERE account_id=? AND (owner_user_id<>? OR (expires_at IS NOT NULL AND expires_at<=?))')
    .run(accountId, previousOwnerId, Date.now());
  db.prepare('UPDATE account_share_links SET owner_user_id=? WHERE account_id=? AND owner_user_id=?')
    .run(ownerId, accountId, previousOwnerId);
}

function inventoryAdministrator(user: AuthUser, ownerId: number): number {
  return db.prepare("SELECT id FROM users WHERE id=? AND role='admin'").get(ownerId) ? ownerId : user.id;
}

function returnAdministrator(sourceId: number | null): number {
  const available = "role='admin' AND status='active' AND must_change_password=0";
  const original = sourceId === null ? undefined : db.prepare(`SELECT id FROM users WHERE id=? AND ${available}`).get(sourceId) as { id: number } | undefined;
  const administrator = original || db.prepare(`SELECT id FROM users WHERE ${available} ORDER BY id ASC LIMIT 1`).get() as { id: number } | undefined;
  if (!administrator) return resourceError(409, '没有可接收账号的管理员，请联系管理员处理后重试');
  return administrator.id;
}

function withoutClaimHash(account: Account): Account {
  const { claim_code_hash: _hash, ...safe } = account as Account & { claim_code_hash?: string };
  return safe;
}

export function publicAccount(account: Account): Account {
  return { ...withoutClaimHash(account), password: '', refresh_token: '', has_password: !!account.password, has_refresh_token: !!account.refresh_token };
}

function accountInput(data: Partial<Account> & { email_password?: string }, creating = false): Partial<Account> {
  const result: Partial<Account> = {};
  const source = { ...data, ...(data.email_password !== undefined && data.password === undefined ? { password: data.email_password } : {}) };
  for (const key of [...gameFields, 'email', 'password', 'client_id', 'refresh_token', 'remark'] as const) {
    if (source[key] !== undefined) {
      const max = key === 'refresh_token' ? 20000 : key === 'game_account' ? 200 : key === 'real_name' ? 100 : 2000;
      if (typeof source[key] !== 'string' || source[key]!.length > max || /[\r\n\0]/.test(source[key]!)) resourceError(400, `${key} 格式错误或过长`);
      const value = source[key]!;
      result[key] = key === 'email' ? value.trim().toLowerCase() : ['game_account', 'real_name', 'id_last_six'].includes(key) ? value.trim() : value;
    }
  }
  if ((creating || result.email !== undefined) && (!result.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))) resourceError(400, '邮箱地址格式错误');
  for (const key of ['client_id', 'refresh_token'] as const) {
    if ((creating || result[key] !== undefined) && !result[key]?.trim()) resourceError(400, `${key} 不能为空`);
  }
  const hasGame = gameFields.some(key => result[key] !== undefined);
  for (const key of gameFields) {
    if (((creating && hasGame) || result[key] !== undefined) && !result[key]?.trim()) resourceError(400, `${key} 不能为空`);
  }
  if (result.id_last_six !== undefined) {
    if (!/^\d{5}[\dXx]$/.test(result.id_last_six)) resourceError(400, '身份证后六位应为 6 位数字，末位可以为 X');
    result.id_last_six = result.id_last_six.toUpperCase();
  }
  if (result.game_account?.includes('----')) resourceError(400, '游戏账号不能包含导入分隔符');
  if (data.status !== undefined) {
    if (!['active', 'inactive', 'error'].includes(data.status)) resourceError(400, '账号状态无效');
    result.status = data.status;
  }
  return result;
}

function parseImport(req: ImportRequest) {
  const { content, separator = '----' } = req;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2 * 1024 * 1024) resourceError(400, '导入内容为空或超过 2 MB');
  if (typeof separator !== 'string' || !separator.length || separator.length > 20 || /[\r\n]/.test(separator)) resourceError(400, '分隔符无效');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  // Existing four-column mailbox imports remain usable while records are completed.
  const format = req.format ?? (lines[0].split(separator).length === 4 ? legacyImportFields : importFields);
  if (!Array.isArray(format) || format.length > 8 || new Set(format).size !== format.length || format.some(field => !importFields.includes(field)) || !['email', 'client_id', 'refresh_token'].every(field => format.includes(field))) resourceError(400, '导入字段必须包含 email、client_id 和 refresh_token，且不能重复');
  if (gameFields.some(field => format.includes(field)) && !gameFields.every(field => format.includes(field))) resourceError(400, '游戏账号导入必须包含游戏账号、游戏密码、姓名和身份证后六位');
  if (lines.length > 5000) resourceError(400, '单次最多导入 5000 条账号');
  const records: { line: number; data: Partial<Account> }[] = [], errors: string[] = [];
  const seenEmails = new Set<string>(), seenGames = new Set<string>();
  lines.forEach((line, index) => {
    const parts = line.split(separator);
    if (parts.length !== format.length) { errors.push(`第 ${index + 1} 行：字段数量不匹配，应为 ${format.length} 列`); return; }
    try {
      const values = Object.fromEntries(format.map((field, i) => [field, parts[i]]));
      // Eight-column exports retain empty game columns for historical mailbox records.
      // Treat only a wholly empty game section as legacy; incomplete game data is invalid.
      if (gameFields.every(field => typeof values[field] === 'string' && !values[field].trim())) {
        for (const field of gameFields) delete values[field];
      }
      const data = accountInput(values, true);
      if (seenEmails.has(data.email!) || (data.game_account && seenGames.has(data.game_account.toLowerCase()))) { errors.push(`第 ${index + 1} 行：同一文件中游戏账号或邮箱重复`); return; }
      seenEmails.add(data.email!);
      if (data.game_account) seenGames.add(data.game_account.toLowerCase());
      records.push({ line: index + 1, data });
    } catch (error: any) { errors.push(`第 ${index + 1} 行：${error.message || '账号或邮箱凭据格式错误'}`); }
  });
  return { records, errors };
}

function matchingAccount(data: Partial<Account>): Account | undefined {
  const matches = db.prepare("SELECT * FROM accounts WHERE lower(email) = ? OR (? <> '' AND lower(game_account) = lower(?))").all(data.email, data.game_account || '', data.game_account || '') as Account[];
  if (matches.length > 1) resourceError(409, '游戏账号与邮箱分别属于不同记录，请先核对数据；未写入任何数据');
  return matches[0];
}

function importOwner(user: AuthUser, req: ImportRequest & { owner_user_id?: number }): number {
  if (req.placement !== undefined && !['owned', 'pool'].includes(req.placement)) resourceError(400, '导入归属无效');
  if (req.placement === 'pool') {
    if (user.role !== 'admin') resourceError(403, '仅管理员可导入待认领账号');
    if (req.owner_user_id !== undefined && req.owner_user_id !== user.id) resourceError(400, '待认领账号须归发布管理员持有');
    return user.id;
  }
  return createOwner(user, req.owner_user_id);
}

function validateImportOptions(user: AuthUser, req: ImportRequest & { owner_user_id?: number; mode?: string }) {
  if (req.generate_share_links !== undefined && typeof req.generate_share_links !== 'boolean') resourceError(400, '生成短链选项无效');
  if (user.role !== 'admin') {
    if (req.owner_user_id !== undefined || req.placement !== undefined || req.generate_share_links !== undefined) resourceError(403, '仅支持导入管理员已录入的账号');
    if (req.mode === 'overwrite') resourceError(400, '用户导入不会覆盖账号，请使用跳过重复项模式');
  }
}

interface ClaimImportRecord { line: number; data: Partial<Account>; token?: string }

function parseClaimImport(req: ImportRequest): { records: ClaimImportRecord[]; errors: string[] } {
  const { content, separator = '----' } = req;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 2 * 1024 * 1024) resourceError(400, '导入内容为空或超过 2 MB');
  if (typeof separator !== 'string' || !separator.length || separator.length > 20 || /[\r\n]/.test(separator)) resourceError(400, '分隔符无效');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > 5000) resourceError(400, '单次最多导入 5000 条账号');
  const format = req.format ?? (lines[0].split(separator).length === 5 ? [...gameFields, 'share_link'] : importFields);
  const isShared = Array.isArray(format) && format.length === 5 && [...gameFields, 'share_link'].every(field => format.includes(field));
  const isFull = Array.isArray(format) && format.length === 8 && importFields.every(field => format.includes(field));
  if (!isShared && !isFull) resourceError(400, '导入仅支持五字段短链格式或八字段完整账号格式');
  const records: ClaimImportRecord[] = [], errors: string[] = [], seen = new Set<string>();
  lines.forEach((line, index) => {
    const parts = line.split(separator);
    if (parts.length !== format.length) { errors.push(`第 ${index + 1} 行：字段数量不匹配，应为 ${format.length} 列`); return; }
    try {
      const values = Object.fromEntries(format.map((field, i) => [field, parts[i]]));
      const data = accountInput(values, isFull);
      if (gameFields.some(field => !data[field]?.trim())) resourceError(400, '导入必须包含完整游戏账号信息');
      const key = data.game_account!.toLowerCase();
      if (seen.has(key)) resourceError(400, '同一文件中游戏账号重复');
      let token: string | undefined;
      if (isShared) {
        let pathname = values.share_link.trim();
        if (!pathname.startsWith('/')) {
          let parsed: URL;
          try { parsed = new URL(pathname); } catch { return resourceError(400, '短链格式无效'); }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) resourceError(400, '短链格式无效');
          pathname = parsed.pathname;
        }
        const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
        if (!match || !SHARE_TOKEN_PATTERN.test(match[1])) resourceError(400, '短链格式无效');
        token = match[1];
      }
      seen.add(key);
      records.push({ line: index + 1, data, ...(token ? { token } : {}) });
    } catch (error: any) { errors.push(`第 ${index + 1} 行：${error.message || '导入资料格式错误'}`); }
  });
  return { records, errors };
}

function claimImportAccount(user: AuthUser, record: ClaimImportRecord): Account {
  const account = db.prepare('SELECT * FROM accounts WHERE lower(game_account)=lower(?)').get(record.data.game_account) as (Account & { admin_imported: number }) | undefined;
  const fields = record.token ? gameFields : importFields;
  if (!account || fields.some(field => field === 'game_account'
    ? account.game_account.toLowerCase() !== record.data.game_account!.toLowerCase()
    : (account as any)[field] !== (record.data as any)[field])) resourceError(400, '账号不存在、导入资料不匹配或已分配给其他用户，请联系管理员');
  // Reimporting an already-owned record is harmless and never overwrites credentials.
  if (account.owner_user_id === user.id) return account;
  const owner = db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND status='active' AND must_change_password=0").get(account.owner_user_id);
  if (!owner || account.admin_imported !== 1) resourceError(400, '账号不存在、导入资料不匹配或已分配给其他用户，请联系管理员');
  if (record.token && !db.prepare('SELECT id FROM account_share_links WHERE token=? AND account_id=? AND owner_user_id=? AND (expires_at IS NULL OR expires_at>?)').get(record.token, account.id, account.owner_user_id, Date.now())) resourceError(400, '短链无效或已失效，请联系管理员');
  return account;
}

function importShareExport(id: number): ImportShareExport {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Account;
  requireActiveOwner(account.owner_user_id);
  let link = db.prepare('SELECT token,owner_user_id,expires_at FROM account_share_links WHERE account_id=?').get(id) as { token: string; owner_user_id: number; expires_at: number | null } | undefined;
  if (!link || link.owner_user_id !== account.owner_user_id || (link.expires_at !== null && link.expires_at <= Date.now())) {
    const token = generateUniqueShareToken();
    db.prepare('DELETE FROM account_share_links WHERE account_id=?').run(id);
    db.prepare('INSERT INTO account_share_links (account_id,token,owner_user_id,expires_at) VALUES (?,?,?,NULL)').run(id, token, account.owner_user_id);
    link = { token, owner_user_id: account.owner_user_id!, expires_at: null };
  } else if (link.expires_at !== null) {
    // Batch delivery always produces lasting links, preserving an existing token.
    db.prepare('UPDATE account_share_links SET expires_at=NULL WHERE account_id=?').run(id);
  }
  return { game_account: account.game_account, game_password: account.game_password, real_name: account.real_name, id_last_six: account.id_last_six, path: `/s/${link.token}` };
}

export class AccountModel {
  list(user: AuthUser, page = 1, pageSize = 20, search = '', requestedOwner?: unknown, claimStatus?: unknown): PaginatedResponse<Account> {
    const scope = ownerWhere(ownerScope(user, requestedOwner));
    if (claimStatus !== undefined && !['assigned', 'available'].includes(String(claimStatus))) resourceError(400, '认领状态无效');
    const where = `${scope.sql}${search ? ' AND (email LIKE ? OR game_account LIKE ? OR real_name LIKE ? OR remark LIKE ?)' : ''}${claimStatus ? ' AND claim_status = ?' : ''}`;
    const params: any[] = [...scope.params, ...(search ? Array(4).fill(`%${search}%`) : []), ...(claimStatus ? [claimStatus] : [])];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE ${where}`).get(...params) as any).c;
    const rows = db.prepare(`SELECT * FROM accounts WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Account[];
    return { list: rows.map(account => ({ ...publicAccount(account), tags: tagModel.getTagsByAccountId(user, account.id) })), total, page, pageSize };
  }

  getById(user: AuthUser, id: number): Account {
    const account = requireResource<Account>('accounts', id, user);
    return { ...withoutClaimHash(account), tags: tagModel.getTagsByAccountId(user, id) } as Account;
  }

  create(user: AuthUser, data: Partial<Account>): Account {
    if (user.role !== 'admin') resourceError(403, '仅管理员可新增账号，请导入管理员已录入的账号');
    const owner = createOwner(user, data.owner_user_id === null ? undefined : data.owner_user_id), input = accountInput(data, true);
    if (matchingAccount(input)) resourceError(409, '该游戏账号或邮箱已存在，请核对输入或联系管理员');
    const result = db.prepare('INSERT INTO accounts (game_account, game_password, real_name, id_last_six, email, password, client_id, refresh_token, remark, owner_user_id, inventory_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.game_account || '', input.game_password || '', input.real_name || '', input.id_last_six || '', input.email, input.password || '', input.client_id, input.refresh_token, input.remark || '', owner, inventoryAdministrator(user, owner));
    return publicAccount(this.getById(user, Number(result.lastInsertRowid)));
  }

  update(user: AuthUser, id: number, data: Partial<Account>): Account {
    const existing = this.getById(user, id); assertResourcesIdle([id]);
    if (data.owner_user_id !== undefined) resourceError(400, '请使用账号移交接口修改归属');
    const input = accountInput(data);
    if (!existing.game_account && gameFields.some(key => input[key] !== undefined)) accountInput({ ...existing, ...input }, true);
    const match = matchingAccount({ ...existing, ...input });
    if (match && match.id !== id) resourceError(409, '该游戏账号或邮箱已存在，请核对输入或联系管理员');
    const fields = Object.keys(input);
    if (fields.length) db.transaction(() => {
      const changedBinding = ['email', 'client_id', 'refresh_token'].some(key => (input as any)[key] !== undefined && (input as any)[key] !== (existing as any)[key]);
      if (changedBinding) db.prepare('DELETE FROM mail_cache WHERE account_id=?').run(id);
      db.prepare(`UPDATE accounts SET ${fields.map(field => `${field} = ?`).join(', ')}, ${clearClaimSql}, ${changedBinding ? 'last_synced_at = NULL,' : ''} updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(input), id);
    })();
    return publicAccount(this.getById(user, id));
  }

  delete(user: AuthUser, id: number): boolean {
    return this.batchDelete(user, [id]) > 0;
  }

  batchDelete(user: AuthUser, rawIds: unknown): number {
    const ids = idList(rawIds);
    return db.transaction(() => {
      const accounts = ids.map(id => this.getById(user, id)); assertResourcesIdle(ids);
      if (user.role === 'admin') return db.prepare(`DELETE FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
      const planned = accounts.map(account => ({ account, administrator: returnAdministrator(account.inventory_admin_id) }));
      const update = db.prepare("UPDATE accounts SET owner_user_id=?, inventory_admin_id=?, admin_imported=1, claim_status='available', claimed_at=NULL, claim_code_hash=NULL, claim_code_expires_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?");
      for (const { account, administrator } of planned) {
        update.run(administrator, administrator, account.id);
        db.prepare('DELETE FROM account_tags WHERE account_id=?').run(account.id);
        transferImportedShareLink(account.id, account.owner_user_id, administrator);
      }
      return planned.length;
    }).immediate();
  }

  importPreview(user: AuthUser, req: ImportRequest & { owner_user_id?: number }) {
    validateImportOptions(user, req);
    if (user.role !== 'admin') {
      const { records, errors } = parseClaimImport(req), newItems: any[] = [], duplicates: any[] = [];
      for (const record of records) {
        try {
          const account = claimImportAccount(user, record);
          const item = { ...record.data, line: record.line, password: '', refresh_token: '' };
          (account.owner_user_id === user.id ? duplicates : newItems).push(item);
        } catch (error: any) { errors.push(`第 ${record.line} 行：${error.message}`); }
      }
      return { newItems, duplicates, errors };
    }
    const owner = importOwner(user, req), { records, errors } = parseImport(req);
    if (req.generate_share_links && records.some(record => gameFields.some(field => !record.data[field]))) resourceError(400, '生成交付短链需要完整的游戏账号信息');
    const newItems: any[] = [], duplicates: any[] = [];
    for (const { line, data } of records) {
      let existing: Account | undefined;
      try { existing = matchingAccount(data); } catch { errors.push(`第 ${line} 行：游戏账号与邮箱记录冲突`); continue; }
      if (existing && existing.owner_user_id !== owner) { errors.push(`第 ${line} 行：该账号无法导入，请核对输入或联系管理员`); continue; }
      const item = { ...data, line, password: '', refresh_token: '' };
      (existing ? duplicates : newItems).push(item);
    }
    return { newItems, duplicates, errors };
  }

  importConfirm(user: AuthUser, req: ImportRequest & { mode: 'skip' | 'overwrite'; owner_user_id?: number }): ImportResult {
    if (!['skip', 'overwrite'].includes(req.mode)) resourceError(400, '导入模式无效');
    validateImportOptions(user, req);
    if (user.role !== 'admin') return this.importClaims(user, req);
    const owner = importOwner(user, req), { records, errors } = parseImport(req);
    if (req.placement === 'pool' && records.some(record => !record.data.game_account)) resourceError(400, '待认领账号必须包含完整的游戏账号信息');
    if (req.generate_share_links && records.some(record => gameFields.some(field => !record.data[field]))) resourceError(400, '生成交付短链需要完整的游戏账号信息');
    let imported = 0, skipped = 0;
    return db.transaction(() => {
      const planned = records.map(record => ({ ...record, existing: matchingAccount(record.data) }));
      if (planned.some(record => record.existing && record.existing.owner_user_id !== owner)) resourceError(409, '导入包含无法操作的账号，请核对输入或联系管理员；未写入任何数据');
      const existingIds = planned.flatMap(record => record.existing ? [record.existing.id] : []);
      if (new Set(existingIds).size !== existingIds.length) resourceError(409, '多条导入记录指向同一账号，请核对游戏账号和邮箱；未写入任何数据');
      assertResourcesIdle(planned.filter(record => record.existing && req.mode === 'overwrite').map(record => record.existing!.id));
      const importedIds: number[] = [];
      for (const { data, existing } of planned) {
        if (existing) {
          if (req.mode === 'skip') { skipped++; continue; }
          const fields = Object.keys(data);
          const changedBinding = ['email', 'client_id', 'refresh_token'].some(key => (data as any)[key] !== undefined && (data as any)[key] !== (existing as any)[key]);
          if (changedBinding) db.prepare('DELETE FROM mail_cache WHERE account_id=?').run(existing.id);
          db.prepare(`UPDATE accounts SET ${fields.map(field => `${field} = ?`).join(', ')}, admin_imported=1, inventory_admin_id=?, ${clearClaimSql}, ${changedBinding ? 'last_synced_at = NULL,' : ''} updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(data), inventoryAdministrator(user, owner), existing.id);
          importedIds.push(existing.id);
        } else {
          const result = db.prepare('INSERT INTO accounts (game_account, game_password, real_name, id_last_six, email, password, client_id, refresh_token, owner_user_id, admin_imported, inventory_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').run(data.game_account || '', data.game_password || '', data.real_name || '', data.id_last_six || '', data.email, data.password || '', data.client_id, data.refresh_token, owner, inventoryAdministrator(user, owner));
          importedIds.push(Number(result.lastInsertRowid));
        }
        imported++;
      }
      if (importedIds.length && db.prepare("SELECT id FROM users WHERE id=? AND role='admin'").get(owner)) {
        // Administrator inventory can be claimed by delivered credentials without a code.
        db.prepare(`UPDATE accounts SET claim_status='available' WHERE id IN (${importedIds.map(() => '?').join(',')})`).run(...importedIds);
      }
      return { imported, skipped, errors,
        ...(req.placement === 'pool' ? { claim_codes: importedIds.length ? this.publishClaims(user, importedIds) : [] } : {}),
        ...(req.generate_share_links ? { share_exports: importedIds.map(id => importShareExport(id)) } : {}),
      };
    }).immediate();
  }

  private importClaims(user: AuthUser, req: ImportRequest): ImportResult {
    const { records, errors } = parseClaimImport(req);
    return db.transaction(() => {
      let imported = 0, skipped = 0;
      for (const record of records) {
        try {
          const claimed = db.transaction(() => {
            const account = claimImportAccount(user, record);
            if (account.owner_user_id === user.id) return false;
            assertResourcesIdle([account.id]);
            const result = db.prepare(`UPDATE accounts SET owner_user_id=?, admin_imported=0, ${clearClaimSql}, claimed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=? AND admin_imported=1`).run(user.id, account.id, account.owner_user_id);
            if (result.changes !== 1) resourceError(409, '账号已分配给其他用户，请联系管理员');
            db.prepare('DELETE FROM account_tags WHERE account_id=?').run(account.id);
            transferImportedShareLink(account.id, account.owner_user_id, user.id);
            return true;
          })();
          if (claimed) imported++; else skipped++;
        } catch (error: any) { errors.push(`第 ${record.line} 行：${error.message}`); }
      }
      return { imported, skipped, errors };
    }).immediate();
  }

  import(user: AuthUser, req: ImportRequest & { owner_user_id?: number }): ImportResult { return this.importConfirm(user, { ...req, mode: 'skip' }); }

  export(user: AuthUser, rawIds?: unknown, separator = '----', format = importFields, requestedOwner?: unknown): string {
    if (typeof separator !== 'string' || separator.length > 20 || /[\r\n]/.test(separator)) resourceError(400, '导出分隔符无效');
    if (!Array.isArray(format) || !format.length || format.some(field => !exportFields.includes(field))) resourceError(400, '导出字段无效');
    const owner = ownerScope(user, requestedOwner), scope = ownerWhere(owner);
    let accounts: Account[];
    if (rawIds !== undefined) {
      const ids = idList(rawIds); accounts = ids.map(id => this.getById(user, id));
      if (owner !== undefined && accounts.some(account => account.owner_user_id !== owner)) resourceError(404, '资源不存在或无权访问');
    } else accounts = db.prepare(`SELECT * FROM accounts WHERE ${scope.sql}`).all(...scope.params) as Account[];
    return accounts.map(account => format.map(field => (account as any)[field] || '').join(separator)).join('\n');
  }

  publishClaims(user: AuthUser, rawIds: unknown): ClaimCode[] {
    if (user.role !== 'admin') resourceError(403, '仅管理员可发布认领码');
    const ids = idList(rawIds), expires = Date.now() + claimDurationMs;
    return db.transaction(() => {
      const accounts = ids.map(id => this.getById(user, id)); assertResourcesIdle(ids);
      if (accounts.some(account => account.owner_user_id !== user.id)) resourceError(400, '请先将账号移交到自己名下，再发布认领码');
      if (accounts.some(account => gameFields.some(key => !account[key]))) resourceError(400, '请补全游戏账号、游戏密码、姓名和身份证后六位后再发布');
      const update = db.prepare("UPDATE accounts SET claim_status='available', claim_code_hash=?, claim_code_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?");
      return accounts.map(account => {
        const code = randomBytes(18).toString('hex').toUpperCase().match(/.{1,6}/g)!.join('-');
        update.run(createHash('sha256').update(code).digest('hex'), expires, account.id);
        return { account_id: account.id, game_account: account.game_account, code, expires_at: new Date(expires).toISOString() };
      });
    }).immediate();
  }

  revokeClaims(user: AuthUser, rawIds: unknown): number {
    if (user.role !== 'admin') resourceError(403, '仅管理员可撤销认领码');
    const ids = idList(rawIds);
    return db.transaction(() => {
      ids.forEach(id => this.getById(user, id)); assertResourcesIdle(ids);
      return db.prepare(`UPDATE accounts SET ${clearClaimSql}, updated_at=CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')}) AND claim_status='available'`).run(...ids).changes;
    }).immediate();
  }

  claim(user: AuthUser, rawCode: unknown): Account {
    if (typeof rawCode !== 'string' || rawCode.length > 100) resourceError(400, '请输入有效的认领码');
    const code = rawCode.trim().toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-F0-9]{36}$/.test(code)) resourceError(400, '认领码无效、已使用或已过期');
    const normalized = code.match(/.{1,6}/g)!.join('-');
    const hash = createHash('sha256').update(normalized).digest('hex');
    return db.transaction(() => {
      const account = db.prepare("SELECT * FROM accounts WHERE claim_code_hash=? AND claim_status='available' AND claim_code_expires_at>?").get(hash, Date.now()) as Account | undefined;
      if (!account) resourceError(400, '认领码无效、已使用或已过期');
      if (account.owner_user_id === user.id) resourceError(400, '该账号已在你名下，请将认领码交给需要领取的用户');
      assertResourcesIdle([account.id]);
      const result = db.prepare(`UPDATE accounts SET owner_user_id=?, admin_imported=0, ${clearClaimSql}, claimed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND claim_code_hash=? AND claim_status='available' AND claim_code_expires_at>?`).run(user.id, account.id, hash, Date.now());
      if (result.changes !== 1) resourceError(409, '账号已被认领，请联系管理员');
      db.prepare('DELETE FROM account_tags WHERE account_id=?').run(account.id);
      transferImportedShareLink(account.id, account.owner_user_id, user.id);
      return publicAccount(this.getById(user, account.id));
    }).immediate();
  }

  updateSyncTime(id: number) { db.prepare('UPDATE accounts SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(id); }
  updateTokenRefreshTime(id: number, token?: string) { db.prepare("UPDATE accounts SET token_refreshed_at = CURRENT_TIMESTAMP, status = 'active', refresh_token = COALESCE(?, refresh_token), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(token || null, id); }
  markError(id: number) { db.prepare("UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id); }

  getAll(user: AuthUser, requestedOwner?: unknown): Account[] {
    const scope = ownerWhere(ownerScope(user, requestedOwner));
    return db.prepare(`SELECT * FROM accounts WHERE ${scope.sql} ORDER BY id DESC`).all(...scope.params) as Account[];
  }

  transfer(user: AuthUser, rawIds: unknown, targetUserId: unknown): number {
    if (user.role !== 'admin') resourceError(403, '仅管理员可移交账号');
    const ids = idList(rawIds), target = requireActiveOwner(targetUserId);
    return db.transaction(() => {
      const accounts = ids.map(id => this.getById(user, id)); assertResourcesIdle(ids);
      let transferred = 0;
      for (const account of accounts) {
        if (account.owner_user_id !== target) {
          db.prepare('DELETE FROM account_tags WHERE account_id = ?').run(account.id);
          db.prepare('DELETE FROM account_share_links WHERE account_id = ?').run(account.id);
          transferred++;
        }
        db.prepare(`UPDATE accounts SET owner_user_id = ?, ${account.owner_user_id !== target ? 'admin_imported=0,' : ''} ${clearClaimSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(target, account.id);
      }
      return transferred;
    })();
  }

  transferResources(user: AuthUser, sourceId: number, targetUserId: unknown) {
    if (user.role !== 'admin') resourceError(403, '仅管理员可移交资源');
    const target = requireActiveOwner(targetUserId);
    if (sourceId === target) resourceError(400, '来源用户与目标用户不能相同');
    if (!db.prepare("SELECT id FROM users WHERE id = ? AND status <> 'deleted'").get(sourceId)) resourceError(404, '来源用户不存在');
    return db.transaction(() => {
      const accounts = db.prepare('SELECT id FROM accounts WHERE owner_user_id = ?').all(sourceId) as { id: number }[];
      const proxies = db.prepare('SELECT id FROM proxies WHERE owner_user_id = ?').all(sourceId) as { id: number }[];
      assertResourcesIdle(accounts.map(row => row.id), proxies.map(row => row.id));
      const tags = db.prepare('SELECT id, name FROM tags WHERE owner_user_id = ?').all(sourceId) as { id: number; name: string }[];
      for (const tag of tags) {
        const existing = db.prepare('SELECT id FROM tags WHERE owner_user_id = ? AND name = ?').get(target, tag.name) as { id: number } | undefined;
        if (existing) {
          db.prepare('INSERT OR IGNORE INTO account_tags (account_id, tag_id) SELECT account_id, ? FROM account_tags WHERE tag_id = ?').run(existing.id, tag.id);
          db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
        } else db.prepare('UPDATE tags SET owner_user_id = ? WHERE id = ?').run(target, tag.id);
      }
      const targetDefault = db.prepare('SELECT id FROM proxies WHERE owner_user_id = ? AND is_default = 1').get(target);
      if (targetDefault) db.prepare('UPDATE proxies SET is_default = 0 WHERE owner_user_id = ?').run(sourceId);
      db.prepare('UPDATE proxies SET owner_user_id = ? WHERE owner_user_id = ?').run(target, sourceId);
      db.prepare('DELETE FROM account_share_links WHERE account_id IN (SELECT id FROM accounts WHERE owner_user_id=?)').run(sourceId);
      db.prepare(`UPDATE accounts SET owner_user_id = ?, admin_imported=0, ${clearClaimSql}, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ?`).run(target, sourceId);
      return { accounts: accounts.length, tags: tags.length, proxies: proxies.length };
    })();
  }
}
