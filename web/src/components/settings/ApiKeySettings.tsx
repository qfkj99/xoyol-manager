import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiKeyApi } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import type { ApiKeyInfo, ApiKeyScope, CreateApiKeyRequest } from '../../types';
import { FormError, Modal } from '../auth/FormControls';

const scopeOptions: { value: ApiKeyScope; label: string; hint: string }[] = [
  { value: 'accounts:import', label: '导入账号并生成短链', hint: '批量导入游戏账号，自动生成并返回每个账号的短链。' },
  { value: 'accounts:read', label: '查询账号与短链', hint: '查询全部游戏账号、完整账号邮箱凭据及已有短链。' },
  { value: 'share-links:write', label: '管理账号短链', hint: '为已有账号生成、重置或关闭短链；持有短链即可查看完整账号和邮箱资料。' },
  { value: 'mail:read', label: '获取邮箱验证码', hint: '获取账号绑定邮箱的验证码，包含收件箱和垃圾箱。' },
];

const endpointRows = [
  { method: 'POST', path: '/accounts/import', description: '导入账号并返回短链', scope: 'accounts:import' },
  { method: 'GET', path: '/accounts', description: '查询账号列表', scope: 'accounts:read' },
  { method: 'GET', path: '/accounts/:id', description: '查询账号详情', scope: 'accounts:read' },
  { method: 'GET', path: '/accounts/:id/share-link', description: '获取已有短链', scope: 'accounts:read' },
  { method: 'POST', path: '/accounts/:id/share-link', description: '生成或重置短链', scope: 'share-links:write' },
  { method: 'DELETE', path: '/accounts/:id/share-link', description: '关闭短链', scope: 'share-links:write' },
  { method: 'POST', path: '/accounts/:id/verification-code', description: '获取邮箱验证码', scope: 'mail:read' },
];

function dateLabel(value: string | null, fallback = '—') {
  if (!value) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

function keyStatus(key: ApiKeyInfo) {
  if (key.revoked_at) return { label: '已撤销', className: 'border-border bg-secondary text-muted-foreground' };
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) return { label: '已到期', className: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200' };
  return { label: '有效', className: 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200' };
}

async function copyText(value: string, label: string) {
  try { await navigator.clipboard.writeText(value); toast.success(`${label}已复制`); }
  catch { toast.error('复制失败，请选择文本后手动复制'); }
}

export default function ApiKeySettings({ onChange }: { onChange: () => void | Promise<void> }) {
  const isAdmin = useAuthStore(state => state.user?.role === 'admin');
  const [list, setList] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['accounts:import']);
  const [scopesTouched, setScopesTouched] = useState(false);
  const [expiry, setExpiry] = useState<'never' | '7' | '30' | '90' | '365'>('30');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [created, setCreated] = useState<{ key: string; api_key: ApiKeyInfo } | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const scopesInput = useRef<HTMLInputElement>(null);
  const secretSection = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    apiKeyApi.list(controller.signal)
      .then(data => { if (!controller.signal.aborted) setList(data.list); })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '加载 API 密钥失败，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [isAdmin, loadAttempt]);

  useEffect(() => {
    if (created) secretSection.current?.focus();
  }, [created]);

  if (!isAdmin) return null;

  const nameError = nameTouched && !name.trim() ? '请输入便于辨认的密钥名称。' : '';
  const scopesError = scopesTouched && scopes.length === 0 ? '请至少选择一项权限。' : '';
  const apiRoot = `${window.location.origin}/api/external/v1`;
  const importExample = [
    `curl -X POST "${apiRoot}/accounts/import" \\`,
    '  -H "Authorization: Bearer YOUR_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  --data-raw '${JSON.stringify({ content: '游戏账号----游戏密码----name----身份证后六位----邮箱----邮箱密码----client_id----刷新令牌' })}'`,
  ].join('\n');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (loading || creating || created) return;
    setNameTouched(true); setScopesTouched(true); setCreateError('');
    if (!name.trim()) { nameInput.current?.focus(); return; }
    if (!scopes.length) { scopesInput.current?.focus(); return; }
    setCreating(true);
    try {
      const data = await apiKeyApi.create({
        name: name.trim(), scopes,
        expires_in_days: expiry === 'never' ? null : Number(expiry) as CreateApiKeyRequest['expires_in_days'],
      });
      setCreated(data);
      setList(items => [data.api_key, ...items.filter(item => item.id !== data.api_key.id)]);
      setName(''); setNameTouched(false);
      toast.success('API 密钥已生成，请立即复制保存');
      void onChange();
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : '生成 API 密钥失败，请重试。'); }
    finally { setCreating(false); }
  };

  const revoke = async (event: FormEvent) => {
    event.preventDefault();
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true); setRevokeError('');
    try {
      const result = await apiKeyApi.revoke(revoking.id);
      setList(items => items.map(item => item.id === revoking.id ? result.api_key : item));
      setCreated(item => item?.api_key.id === revoking.id ? null : item);
      setRevoking(null);
      toast.success('API 密钥已撤销');
      void onChange();
    } catch (cause) { setRevokeError(cause instanceof Error ? cause.message : '撤销 API 密钥失败，请重试。'); }
    finally { setRevokeBusy(false); }
  };

  return <section className="min-w-0 space-y-6 rounded-lg border border-border bg-card p-4 sm:p-6" aria-labelledby="api-key-heading">
    <div className="space-y-2">
      <h2 id="api-key-heading" className="flex items-center gap-2 text-lg font-semibold"><KeyRound size={20} aria-hidden="true" />外部 API</h2>
      <p className="text-sm leading-7 text-muted-foreground">生成密钥供外部程序调用账号管理接口。每把密钥独立设置权限和有效期，可以随时撤销。</p>
      <p className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm leading-6"><ShieldCheck size={18} className="mt-0.5 shrink-0" aria-hidden="true" /><span>查询、短链管理和收信权限覆盖平台内全部账号；导入账号归创建密钥的管理员持有。完整密钥只在生成后显示一次，请保存到可信的服务端。</span></p>
    </div>

    {created && <div ref={secretSection} tabIndex={-1} className="space-y-3 rounded-lg border border-green-300 bg-green-50 p-4 outline-offset-4 dark:border-green-900 dark:bg-green-950" role="region" aria-label="新生成的 API 密钥">
      <h3 className="font-semibold text-green-900 dark:text-green-100">密钥已生成，请立即保存</h3>
      <p className="text-sm leading-6 text-green-900 dark:text-green-100">{created.api_key.name} 的完整密钥仅在此处显示一次。隐藏或离开页面后无法再次查看。</p>
      <p className="select-all whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-sm [overflow-wrap:anywhere]">{created.key}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button-primary" onClick={() => void copyText(created.key, 'API 密钥')}><Copy size={16} aria-hidden="true" />复制完整密钥</button>
        <button type="button" className="button-secondary" onClick={() => { setCreated(null); nameInput.current?.focus(); }}><Check size={16} aria-hidden="true" />已保存，隐藏密钥</button>
      </div>
    </div>}

    <form className="space-y-5 rounded-lg border border-border p-4 sm:p-5" noValidate aria-busy={creating} onSubmit={event => void create(event)}>
      <h3 className="font-semibold">生成 API 密钥</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <label htmlFor="api-key-name" className="form-label">密钥名称</label>
          <input ref={nameInput} id="api-key-name" type="text" className="form-input" placeholder="例如：自动发号程序" value={name} required maxLength={80} disabled={creating || !!created}
            aria-invalid={!!nameError} aria-describedby={nameError ? 'api-key-name-error' : undefined}
            onChange={event => { setName(event.target.value); setCreateError(''); }} onBlur={() => setNameTouched(true)} />
          {nameError && <p id="api-key-name-error" role="alert" className="text-sm text-red-700 dark:text-red-200">{nameError}</p>}
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor="api-key-expiry" className="form-label">有效期</label>
          <select id="api-key-expiry" className="form-input" value={expiry} disabled={creating || !!created} onChange={event => setExpiry(event.target.value as typeof expiry)}>
            <option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option><option value="never">长期有效</option>
          </select>
        </div>
      </div>
      <fieldset className="min-w-0 space-y-3" disabled={creating || !!created} aria-describedby={`api-key-scopes-hint${scopesError ? ' api-key-scopes-error' : ''}`}>
        <legend className="form-label mb-1">接口权限</legend>
        <p id="api-key-scopes-hint" className="text-xs leading-6 text-muted-foreground">至少选择一项。仅需导入并取得短链时，选择第一项即可。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {scopeOptions.map((option, index) => <label key={option.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
            <input ref={index === 0 ? scopesInput : undefined} type="checkbox" checked={scopes.includes(option.value)} className="mt-1 h-4 w-4 shrink-0 accent-primary" onChange={event => {
              setScopes(items => event.target.checked ? [...items, option.value] : items.filter(item => item !== option.value));
              setScopesTouched(true); setCreateError('');
            }} />
            <span className="min-w-0"><span className="block font-medium leading-6">{option.label}</span><span className="mt-1 block text-xs leading-6 text-muted-foreground">{option.hint}</span></span>
          </label>)}
        </div>
        {scopesError && <p id="api-key-scopes-error" role="alert" className="text-sm text-red-700 dark:text-red-200">{scopesError}</p>}
      </fieldset>
      <FormError message={createError} />
      <div className="flex flex-wrap items-center gap-3">
        <button className="button-primary" disabled={loading || creating || !!created}>{creating ? <RefreshCw size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{creating ? '正在生成…' : '生成密钥'}</button>
        {created && <p className="text-xs leading-6 text-muted-foreground">保存并隐藏上方完整密钥后，可以继续生成。</p>}
      </div>
    </form>

    <section className="min-w-0 space-y-4" aria-labelledby="api-key-list-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="api-key-list-heading" className="font-semibold">已生成的密钥{!loading && `（${list.length}）`}</h3>
        <button type="button" className="button-secondary" disabled={loading || creating || revokeBusy} onClick={() => setLoadAttempt(attempt => attempt + 1)}><RefreshCw size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />刷新列表</button>
      </div>
      <FormError message={loadError} />
      {loading ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">正在加载 API 密钥…</p> : list.length ? <div className="grid min-w-0 gap-4 xl:grid-cols-2">{list.map(item => {
        const status = keyStatus(item);
        return <article key={item.id} className="min-w-0 space-y-4 rounded-lg border border-border p-4">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="font-medium [overflow-wrap:anywhere]">{item.name}</h4><p className="mt-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.prefix}••••••••</p></div><span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.label}</span></div>
          <div className="flex flex-wrap gap-2">{item.scopes.map(scope => <span key={scope} className="rounded-md bg-secondary px-2 py-1 text-xs leading-5 [overflow-wrap:anywhere]">{scopeOptions.find(option => option.value === scope)?.label || scope}</span>)}</div>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs leading-6 sm:grid-cols-2">
            <div className="min-w-0"><dt className="text-muted-foreground">创建人</dt><dd className="[overflow-wrap:anywhere]">{item.creator_username || `管理员 #${item.created_by}`}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">创建时间</dt><dd className="[overflow-wrap:anywhere]">{dateLabel(item.created_at)}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">最近使用</dt><dd className="[overflow-wrap:anywhere]">{dateLabel(item.last_used_at, '尚未使用')}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">到期时间</dt><dd className="[overflow-wrap:anywhere]">{dateLabel(item.expires_at, '长期有效')}</dd></div>
            {item.revoked_at && <div className="min-w-0 sm:col-span-2"><dt className="text-muted-foreground">撤销时间</dt><dd className="[overflow-wrap:anywhere]">{dateLabel(item.revoked_at)}</dd></div>}
          </dl>
          <button type="button" className="button-secondary text-destructive" disabled={!!item.revoked_at} aria-label={`撤销密钥：${item.name}`} onClick={() => { setRevoking(item); setRevokeError(''); }}><Trash2 size={16} aria-hidden="true" />{item.revoked_at ? '已撤销' : '撤销密钥'}</button>
        </article>;
      })}</div> : !loadError && <div className="space-y-2 rounded-lg border border-dashed border-border p-6 text-center"><KeyRound size={28} className="mx-auto text-muted-foreground" aria-hidden="true" /><p className="text-sm font-medium">尚未生成 API 密钥</p><p className="text-xs leading-6 text-muted-foreground">填写上方名称并选择权限，即可为外部程序生成专用密钥。</p></div>}
    </section>

    <details className="min-w-0 rounded-lg border border-border" id="external-api-guide">
      <summary className="cursor-pointer px-4 py-4 text-sm font-medium">接口地址与调用示例</summary>
      <div className="min-w-0 space-y-5 border-t border-border p-4">
        <div className="space-y-2"><p className="text-sm font-medium">API 根地址</p><p className="select-all rounded-md bg-secondary p-3 font-mono text-xs leading-6 [overflow-wrap:anywhere]">{apiRoot}</p><button type="button" className="button-secondary" onClick={() => void copyText(apiRoot, 'API 根地址')}><Copy size={16} aria-hidden="true" />复制根地址</button></div>
        <p className="text-sm leading-7 text-muted-foreground">请求头使用 <code className="[overflow-wrap:anywhere]">Authorization: Bearer YOUR_API_KEY</code>，将占位符替换为完整密钥。请求和响应均使用 JSON。</p>
        <div className="space-y-3"><h3 className="text-sm font-medium">导入并生成短链（Bash / curl）</h3><p className="text-xs leading-6 text-muted-foreground">content 按八项格式传入，一行一个账号；批量导入使用换行符分隔。成功结果包含各账号的 share_url，可直接使用。</p><pre className="min-w-0 whitespace-pre-wrap rounded-md bg-secondary p-3 text-xs leading-6 [overflow-wrap:anywhere]"><code>{importExample}</code></pre><button type="button" className="button-secondary" onClick={() => void copyText(importExample, '调用示例')}><Copy size={16} aria-hidden="true" />复制调用示例</button></div>
        <div className="space-y-3"><h3 className="text-sm font-medium">可用接口与权限</h3><ul className="divide-y divide-border rounded-md border border-border">{endpointRows.map(endpoint => <li key={`${endpoint.method} ${endpoint.path}`} className="min-w-0 space-y-1 p-3"><p className="font-mono text-xs leading-6 [overflow-wrap:anywhere]"><span className="mr-2 font-semibold">{endpoint.method}</span>{endpoint.path}</p><p className="text-xs leading-6 text-muted-foreground">{endpoint.description} · 权限：<code className="[overflow-wrap:anywhere]">{endpoint.scope}</code></p></li>)}</ul><p className="text-xs leading-6 text-muted-foreground">路径中的 :id 替换为账号 ID。重置短链后旧链接立即失效；接口遵循管理员设置的短链长度。</p></div>
      </div>
    </details>

    {revoking && <Modal title="撤销 API 密钥" description="撤销后，使用此密钥的外部程序将无法继续调用接口。此操作无法恢复，可以按需生成新密钥。" busy={revokeBusy} onClose={() => { setRevoking(null); setRevokeError(''); }}>
      <form className="space-y-5" onSubmit={event => void revoke(event)}>
        <p className="rounded-md border border-border bg-secondary p-3 text-sm leading-6 [overflow-wrap:anywhere]">确认撤销「{revoking.name}」？</p>
        <FormError message={revokeError} />
        <div className="flex flex-wrap justify-end gap-3"><button type="button" className="button-secondary" disabled={revokeBusy} onClick={() => { setRevoking(null); setRevokeError(''); }}>取消</button><button className="button-primary" disabled={revokeBusy}>{revokeBusy ? '撤销中…' : '确认撤销'}</button></div>
      </form>
    </Modal>}
  </section>;
}
