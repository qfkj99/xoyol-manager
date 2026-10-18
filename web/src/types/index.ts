// ============ 账户 ============
export interface Account {
  id: number;
  owner_user_id: number;
  owner_username?: string;
  game_account: string;
  game_password: string;
  real_name: string;
  id_last_six: string;
  claim_status: 'assigned' | 'available';
  has_password?: boolean;
  has_refresh_token?: boolean;
  email: string;
  password: string;
  client_id: string;
  refresh_token: string;
  remark: string;
  status: 'active' | 'inactive' | 'error';
  last_synced_at: string | null;
  token_refreshed_at: string | null;
  /** 管理员账号列表专用：短链是否当前有效。 */
  share_link_enabled?: boolean;
  /** 管理员账号列表专用：短链最近一次被访问的时间。 */
  share_link_last_accessed_at?: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

// ============ 标签 ============
export interface Tag {
  id: number;
  owner_user_id: number;
  name: string;
  color: string;
  created_at: string;
}

// ============ 邮件 ============
export interface MailMessage {
  id: number;
  account_id: number;
  mailbox: 'INBOX' | 'Junk';
  mail_id: string;
  sender: string;
  sender_name: string;
  subject: string;
  text_content: string;
  html_content: string;
  mail_date: string;
  is_read: boolean;
  cached_at: string;
}

// ============ 代理 ============
export interface Proxy {
  id: number;
  owner_user_id: number;
  owner_username?: string;
  has_password?: boolean;
  name: string;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username: string;
  password: string;
  is_default: boolean;
  last_tested_at: string | null;
  last_test_ip: string;
  status: 'untested' | 'active' | 'failed';
  created_at: string;
}

// ============ API ============
export interface ApiResponse<T> {
  code: number;
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportRequest {
  content: string;
  separator: string;
  format: string[];
  placement?: 'owned' | 'pool';
  generate_share_links?: boolean;
}

export interface ClaimCode { account_id: number; game_account: string; code: string; expires_at: string }

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  claim_codes?: ClaimCode[];
  share_exports?: ShareExport[];
}

export interface ShareExport { game_account: string; game_password: string; real_name: string; id_last_six: string; path: string }

export interface ImportPreviewResult {
  newItems: { line: number; email: string; [key: string]: any }[];
  duplicates: { line: number; email: string; [key: string]: any }[];
  errors: string[];
}

export interface ExportRequest {
  ids?: number[];
  owner_user_id?: number;
  separator?: string;
  format?: string[];
}

export interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  totalInboxMails: number;
  totalJunkMails: number;
  totalProxies: number;
  activeProxies: number;
  recentMails: MailMessage[];
  accountStats: {
    account_id: number;
    email: string;
    inbox_count: number;
    junk_count: number;
  }[];
  expiringTokens: number;
  errorAccounts: number;
  unusedAccounts: number;
}

export interface ProxyTestResult {
  ip: string;
  latency: number;
  status: 'active' | 'failed';
}

export interface FetchMailsResult {
  mails: MailMessage[];
  total: number;
  protocol: 'graph' | 'imap';
  cached: boolean;
}

export interface VerificationCodeResult {
  candidates: { code: string; mail_id: string; subject: string; sender: string; mail_date: string; recent: boolean; mailbox: 'INBOX' | 'Junk'; cached: boolean }[];
  fetched_at: string;
  cached: boolean;
  partial: boolean;
  mailbox: 'ALL';
  mailboxes: ('INBOX' | 'Junk')[];
  protocol: 'graph' | 'imap' | 'mixed';
  warning?: string;
}

export interface AccountShareLink {
  enabled: boolean;
  path?: string;
  created_at?: string;
  expires_at?: string | null;
}

export type SharedAccount = Pick<Account, 'game_account' | 'game_password' | 'real_name' | 'id_last_six' | 'email' | 'password' | 'client_id' | 'refresh_token' | 'remark' | 'status'> & { expires_at: string | null };

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled' | 'deleted';
  must_change_password: boolean;
  source: 'self' | 'admin';
  last_login_at: string | null;
  created_at: string;
  updated_at?: string;
  account_count?: number;
  proxy_count?: number;
  tag_count?: number;
}

export interface AuthConfig {
  initialized: boolean;
  registration_enabled: boolean;
  password_min_length: number;
  password_max_length: number;
  csrfToken: string;
}

export interface AuthSession { user: User; csrfToken: string }

export interface AuditLog {
  id: number;
  actor_id?: number | null;
  actor_username?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | number | null;
  result: string;
  ip?: string;
  created_at: string;
}

export type ApiKeyScope = 'accounts:read' | 'accounts:import' | 'share-links:write' | 'mail:read';

export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  created_by: number;
  creator_username: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  expires_in_days: 7 | 30 | 90 | 365 | null;
}
