import { Database } from 'better-sqlite3';

interface Column { name: string; type: string; pk: number }
interface Index { name: string; unique: number; partial: number }
interface IndexColumn { name: string | null; coll: string; key: number }
interface ForeignKey { table: string; from: string; to: string; on_delete: string }

const requiredColumns: Record<string, string[]> = {
  accounts: ['id', 'email', 'password', 'client_id', 'refresh_token', 'status', 'last_synced_at', 'created_at', 'updated_at', 'token_refreshed_at', 'remark', 'owner_user_id', 'game_account', 'game_password', 'real_name', 'id_last_six', 'claim_status', 'claim_code_hash', 'claim_code_expires_at', 'claimed_at', 'admin_imported', 'inventory_admin_id'],
  proxies: ['id', 'name', 'type', 'host', 'port', 'username', 'password', 'is_default', 'last_tested_at', 'last_test_ip', 'status', 'created_at', 'owner_user_id'],
  mail_cache: ['id', 'account_id', 'mailbox', 'mail_id', 'sender', 'sender_name', 'subject', 'text_content', 'html_content', 'mail_date', 'is_read', 'cached_at'],
  tags: ['id', 'name', 'color', 'created_at', 'owner_user_id'],
  account_tags: ['account_id', 'tag_id'],
  account_share_links: ['id', 'account_id', 'token', 'owner_user_id', 'created_at', 'expires_at', 'last_accessed_at'],
  users: ['id', 'username', 'display_name', 'password_hash', 'role', 'status', 'must_change_password', 'source', 'last_login_at', 'created_at', 'updated_at'],
  sessions: ['id', 'user_id', 'token_hash', 'csrf_token', 'expires_at', 'created_at'],
  api_keys: ['id', 'name', 'key_hash', 'prefix', 'created_by', 'scopes', 'expires_at', 'revoked_at', 'last_used_at', 'created_at'],
  settings: ['key', 'value'],
  audit_logs: ['id', 'actor_id', 'action', 'target_type', 'target_id', 'result', 'ip', 'created_at'],
  schema_migrations: ['version', 'applied_at'],
};

function schemaError(detail: string): never {
  throw Object.assign(new Error(`数据库结构校验失败：${detail}`), { status: 400 });
}

function normalizedSql(sql: string): string {
  return sql.toLowerCase().replace(/[\s"`\[\]]/g, '').replace(/;$/, '');
}

/** Validate actual constraints rather than trusting a claimed migration version. */
export function validateDatabaseSchema(db: Database): void {
  // The application never creates triggers. Reject uploaded SQL that could mutate
  // validated records when the restore subsequently revokes sessions or logs it.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get()) {
    schemaError('数据库不允许包含触发器');
  }
  const columnsByTable = new Map<string, Column[]>();
  const indexesByTable = new Map<string, Index[]>();
  for (const [table, required] of Object.entries(requiredColumns)) {
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
    if (!definition || /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(definition.sql)) schemaError(`缺少普通数据表 ${table}`);
    const columns = db.prepare('SELECT name,type,pk FROM pragma_table_info(?)').all(table) as Column[];
    const missing = required.filter(name => !columns.some(column => column.name === name));
    if (missing.length) schemaError(`${table} 缺少字段 ${missing.join(', ')}`);
    columnsByTable.set(table, columns);
    indexesByTable.set(table, db.prepare('SELECT name,"unique",partial FROM pragma_index_list(?)').all(table) as Index[]);
    if (required.includes('id')) {
      const id = columns.find(column => column.name === 'id')!;
      if (id.pk !== 1 || id.type.toUpperCase() !== 'INTEGER' || columns.filter(column => column.pk > 0).length !== 1) schemaError(`${table}.id 必须是整数主键`);
    }
  }

  function requireUnique(table: string, names: string[], collations?: string[]) {
    const found = indexesByTable.get(table)!.some(index => {
      if (!index.unique || index.partial) return false;
      const keys = (db.prepare('SELECT name,coll,key FROM pragma_index_xinfo(?) ORDER BY seqno').all(index.name) as IndexColumn[]).filter(column => column.key === 1);
      return keys.length === names.length && keys.every((key, i) => key.name === names[i] && (!collations || key.coll.toUpperCase() === collations[i]));
    });
    if (!found) schemaError(`${table} 缺少唯一约束 (${names.join(', ')})`);
  }
  requireUnique('users', ['username'], ['NOCASE']);
  requireUnique('sessions', ['token_hash']);
  requireUnique('api_keys', ['key_hash']);
  requireUnique('tags', ['owner_user_id', 'name']);
  requireUnique('account_tags', ['account_id', 'tag_id']);
  requireUnique('account_share_links', ['account_id']);
  requireUnique('account_share_links', ['token']);
  requireUnique('settings', ['key']);

  // The integer primary key is represented by the rowid and may have no index_list entry.
  const version = columnsByTable.get('schema_migrations')!.find(column => column.name === 'version')!;
  if (version.pk !== 1 || version.type.toUpperCase() !== 'INTEGER' || columnsByTable.get('schema_migrations')!.filter(column => column.pk).length !== 1) schemaError('schema_migrations.version 必须是整数主键');

  const emailIndex = indexesByTable.get('accounts')!.some(index => {
    if (!index.unique || index.partial) return false;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='accounts'").get(index.name) as { sql: string | null } | undefined;
    return !!row?.sql && /onaccounts\(lower\(email\)\)$/.test(normalizedSql(row.sql));
  });
  if (!emailIndex) schemaError('accounts 缺少忽略大小写的邮箱唯一索引');
  for (const [expression, label] of [
    ["onaccounts(lower(game_account))wheregame_account<>''", '游戏账号唯一索引'],
    ['onaccounts(claim_code_hash)whereclaim_code_hashisnotnull', '认领码唯一索引'],
  ]) {
    const found = indexesByTable.get('accounts')!.some(index => {
      if (!index.unique || !index.partial) return false;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='accounts'").get(index.name) as { sql: string | null } | undefined;
      return !!row?.sql && normalizedSql(row.sql).endsWith(expression);
    });
    if (!found) schemaError(`accounts 缺少${label}`);
  }
  const defaultIndex = indexesByTable.get('proxies')!.some(index => {
    if (!index.unique || !index.partial) return false;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='proxies'").get(index.name) as { sql: string | null } | undefined;
    return !!row?.sql && /onproxies\(owner_user_id\)whereis_default=1andowner_user_idisnotnull$/.test(normalizedSql(row.sql));
  });
  if (!defaultIndex) schemaError('proxies 缺少每用户唯一默认代理索引');

  const requiredReferences: [string, string, string, string][] = [
    ['accounts', 'owner_user_id', 'users', 'RESTRICT'],
    ['accounts', 'inventory_admin_id', 'users', 'RESTRICT'],
    ['proxies', 'owner_user_id', 'users', 'RESTRICT'],
    ['tags', 'owner_user_id', 'users', 'RESTRICT'],
    ['mail_cache', 'account_id', 'accounts', 'CASCADE'],
    ['account_tags', 'account_id', 'accounts', 'CASCADE'],
    ['account_tags', 'tag_id', 'tags', 'CASCADE'],
    ['account_share_links', 'account_id', 'accounts', 'CASCADE'],
    ['account_share_links', 'owner_user_id', 'users', 'CASCADE'],
    ['sessions', 'user_id', 'users', 'CASCADE'],
    ['api_keys', 'created_by', 'users', 'CASCADE'],
    ['audit_logs', 'actor_id', 'users', 'NO ACTION'],
  ];
  for (const [table, from, referencedTable, onDelete] of requiredReferences) {
    const keys = db.prepare('SELECT "table","from","to",on_delete FROM pragma_foreign_key_list(?)').all(table) as ForeignKey[];
    if (!keys.some(key => key.from === from && key.table === referencedTable && key.to === 'id' && key.on_delete === onDelete)) {
      schemaError(`${table}.${from} 缺少正确的外键约束`);
    }
  }
  const shareDefinition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_share_links'").get() as { sql: string };
  if (!normalizedSql(shareDefinition.sql).includes('check(length(token)between8and64)')) {
    schemaError('account_share_links.token 缺少 8 至 64 位的长度约束');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) schemaError('存在无效的数据关联');
}
