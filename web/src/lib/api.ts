import type { ApiResponse, PaginatedResponse, Account, MailMessage, Proxy, ImportRequest, ImportResult, ExportRequest, DashboardStats, ProxyTestResult, FetchMailsResult, Tag, ImportPreviewResult } from '../types';
import type { AuthConfig, AuthSession, User, AuditLog, ClaimCode, VerificationCodeResult, AccountShareLink, SharedAccount } from '../types';
import type { ApiKeyInfo, CreateApiKeyRequest } from '../types';

const API_BASE = '/api';
let csrfToken = '';
let sessionGeneration = 0;
export const getSessionGeneration = () => sessionGeneration;
export const setCsrfToken = (token: string) => { csrfToken = token; };
export function resetSession() {
  sessionGeneration += 1;
  csrfToken = '';
  localStorage.removeItem('auth_token');
  window.dispatchEvent(new Event('session-reset'));
}
export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown) { super(message); }
}

function qs(params?: Record<string, any>): string {
  if (!params) return '';
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const generation = sessionGeneration;
  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options?.method || 'GET').toUpperCase()) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const res = await fetch(`${API_BASE}${url}`, { ...options, credentials: 'same-origin', headers });
  if (generation !== sessionGeneration) throw new ApiError('登录状态已改变，请重试', 0);
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    if (generation !== sessionGeneration) throw new ApiError('登录状态已改变，请重试', 0);
    if (res.status === 401 && !['/auth/login', '/auth/register', '/auth/me'].includes(url)) {
      resetSession();
      window.dispatchEvent(new Event('auth-required'));
    }
    if (res.status === 403 && ['PASSWORD_CHANGE_REQUIRED', 'password_change_required'].includes(json?.data?.reason)) {
      window.dispatchEvent(new Event('password-change-required'));
    }
    throw new ApiError(json?.message || `请求失败 (${res.status})`, res.status, json?.data);
  }
  return res;
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const generation = sessionGeneration;
  const res = await apiFetch(url, options);
  const json: ApiResponse<T> = await res.json();
  if (generation !== sessionGeneration) throw new ApiError('登录状态已改变，请重试', 0);
  if (json.code !== 200) throw new ApiError(json.message || `请求失败 (${json.code})`, json.code, json.data);
  return json.data;
}

export const accountApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; owner_user_id?: number; claim_status?: 'assigned' | 'available' }) =>
    request<PaginatedResponse<Account>>(`/accounts?${qs(params)}`),
  create: (data: Partial<Account>) =>
    request<Account>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  credentials: (id: number) => request<Account>(`/accounts/${id}/credentials`),
  update: (id: number, data: Partial<Account>) =>
    request<Account>(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean; action: 'returned' | 'deleted' }>(`/accounts/${id}`, { method: 'DELETE' }),
  batchDelete: (ids: number[]) =>
    request<{ deleted: number; action: 'returned' | 'deleted' }>('/accounts/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  import: (data: ImportRequest) =>
    request<ImportResult>('/accounts/import', { method: 'POST', body: JSON.stringify(data) }),
  importPreview: (data: ImportRequest) =>
    request<ImportPreviewResult>('/accounts/import-preview', { method: 'POST', body: JSON.stringify(data) }),
  importConfirm: (data: ImportRequest & { mode: 'skip' | 'overwrite' }) =>
    request<ImportResult>('/accounts/import-confirm', { method: 'POST', body: JSON.stringify(data) }),
  export: (data: ExportRequest) =>
    request<{ content: string; count: number }>('/accounts/export', { method: 'POST', body: JSON.stringify(data) }),
  transfer: (ids: number[], target_user_id: number) => request('/accounts/transfer', { method: 'POST', body: JSON.stringify({ ids, target_user_id }) }),
  transferResources: (source_user_id: number, target_user_id: number) => request('/accounts/transfer-resources', { method: 'POST', body: JSON.stringify({ source_user_id, target_user_id }) }),
  publishClaims: (ids: number[]) => request<{ claim_codes: ClaimCode[] }>('/accounts/claim-pool', { method: 'POST', body: JSON.stringify({ ids }) }),
  revokeClaims: (ids: number[]) => request('/accounts/claim-pool/revoke', { method: 'POST', body: JSON.stringify({ ids }) }),
  claim: (code: string) => request<Account>('/accounts/claim', { method: 'POST', body: JSON.stringify({ code }) }),
  shareLink: (id: number, signal?: AbortSignal) => request<AccountShareLink>(`/accounts/${id}/share-link`, { cache: 'no-store', signal }),
  createShareLink: (id: number, expires_in_days: 7 | 30 | null) => request<AccountShareLink>(`/accounts/${id}/share-link`, { method: 'POST', body: JSON.stringify({ expires_in_days }) }),
  closeShareLink: (id: number) => request<AccountShareLink>(`/accounts/${id}/share-link`, { method: 'DELETE' }),
};

// Public links authenticate with their token and never participate in the platform session.
async function publicShareRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
  });
  const json: ApiResponse<T> | null = await response.json().catch(() => null);
  if (!response.ok || json?.code !== 200) throw new ApiError(json?.message || `请求失败 (${response.status})`, response.ok ? json?.code || 500 : response.status, json?.data);
  return json.data;
}

export const shareApi = {
  account: (token: string, signal?: AbortSignal) => publicShareRequest<SharedAccount>(`/share/${encodeURIComponent(token)}`, { signal }),
  verificationCode: (token: string, signal?: AbortSignal) => publicShareRequest<VerificationCodeResult>(`/share/${encodeURIComponent(token)}/verification-code`, { method: 'POST', body: '{}', signal }),
};

export const mailApi = {
  verificationCode: (account_id: number) => request<VerificationCodeResult>('/mails/verification-code', { method: 'POST', body: JSON.stringify({ account_id }) }),
  fetch: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<FetchMailsResult>('/mails/fetch', { method: 'POST', body: JSON.stringify(data) }),
  fetchNew: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<MailMessage | null>('/mails/fetch-new', { method: 'POST', body: JSON.stringify(data) }),
  cached: (params: { account_id: number; mailbox: string; page?: number; pageSize?: number }) =>
    request<PaginatedResponse<MailMessage>>(`/mails/cached?${qs(params)}`),
  clear: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<{ message: string }>('/mails/clear', { method: 'DELETE', body: JSON.stringify(data) }),
};

export const proxyApi = {
  list: (owner_user_id?: number) => request<Proxy[]>(`/proxies?${qs({ owner_user_id })}`),
  credentials: (id: number) => request<Proxy>(`/proxies/${id}/credentials`),
  create: (data: Partial<Proxy>) =>
    request<Proxy>('/proxies', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Proxy>) =>
    request<Proxy>(`/proxies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean }>(`/proxies/${id}`, { method: 'DELETE' }),
  test: (id: number) =>
    request<ProxyTestResult>(`/proxies/${id}/test`, { method: 'POST' }),
  setDefault: (id: number) =>
    request<Proxy>(`/proxies/${id}/default`, { method: 'PUT' }),
};

export const dashboardApi = {
  stats: () => request<DashboardStats>('/dashboard/stats'),
};

export const authApi = {
  config: () => request<AuthConfig>('/auth/config'),
  me: () => request<AuthSession>('/auth/me'),
  login: (data: { username: string; password: string; remember: boolean }) => request<AuthSession>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  register: (data: { username: string; display_name?: string; password: string }) => request<AuthSession>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  password: (current_password: string, new_password: string) => request('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password, new_password }) }),
  profile: (display_name: string) => request<User>('/auth/profile', { method: 'PATCH', body: JSON.stringify({ display_name }) }),
};

export const userApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; role?: string; status?: string }) => request<PaginatedResponse<User>>(`/users?${qs(params)}`),
  create: (data: { username: string; display_name: string; role: string; password: string }) => request<User>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Pick<User, 'display_name' | 'role' | 'status'>>) => request<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: number) => request(`/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id: number, password: string) => request(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
  revokeSessions: (id: number) => request(`/users/${id}/revoke-sessions`, { method: 'POST' }),
};

type SystemSettings = { registration_enabled: boolean; short_link_length: number };
export const settingsApi = {
  get: () => request<SystemSettings>('/settings'),
  update: (registration_enabled: boolean) => request<SystemSettings>('/settings', { method: 'PATCH', body: JSON.stringify({ registration_enabled }) }),
  updateShortLinkLength: (short_link_length: number) => request<SystemSettings>('/settings', { method: 'PATCH', body: JSON.stringify({ short_link_length }) }),
  audit: (page = 1, pageSize = 20) => request<PaginatedResponse<AuditLog>>(`/audit?${qs({ page, pageSize })}`),
};

export const apiKeyApi = {
  list: (signal?: AbortSignal) => request<{ list: ApiKeyInfo[] }>('/api-keys', { cache: 'no-store', signal }),
  create: (data: CreateApiKeyRequest) => request<{ key: string; api_key: ApiKeyInfo }>('/api-keys', { method: 'POST', body: JSON.stringify(data) }),
  revoke: (id: number) => request<{ revoked: boolean; api_key: ApiKeyInfo }>(`/api-keys/${id}`, { method: 'DELETE' }),
};

export const tagApi = {
  list: () => request<Tag[]>('/tags'),
  create: (data: { name: string; color?: string; owner_user_id?: number }) =>
    request<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { name?: string; color?: string }) =>
    request<Tag>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean }>(`/tags/${id}`, { method: 'DELETE' }),
  setAccountTags: (accountId: number, tagIds: number[]) =>
    request<{ account_id: number; tag_ids: number[] }>(
      `/accounts/${accountId}/tags`,
      { method: 'POST', body: JSON.stringify({ tag_ids: tagIds }) }
    ),
};
