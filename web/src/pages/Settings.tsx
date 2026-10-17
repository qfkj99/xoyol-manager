import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { settingsApi } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import type { AuditLog } from '../types';
import { FormError, Pagination } from '../components/auth/FormControls';
import BackupRestore from '../components/accounts/BackupRestore';

const actionLabels: Record<string, string> = {
  'auth.login': '登录', 'auth.logout': '退出登录', 'auth.register': '注册', 'auth.password': '修改密码',
  'system.initialize': '初始化管理员', 'user.recover_password': '恢复管理员密码', 'user.profile': '修改个人资料',
  'user.create': '创建用户', 'user.update': '更新用户', 'user.delete': '注销用户', 'user.reset_password': '重置密码',
  'user.revoke_sessions': '撤销会话', 'user.role.admin': '设为管理员', 'user.role.user': '设为普通用户',
  'user.status.active': '启用用户', 'user.status.disabled': '禁用用户',
  'settings.registration_open': '开放注册', 'settings.registration_close': '关闭注册',
  'settings.short_link_length_update': '修改短链长度',
  'account.credentials': '查看账号邮箱凭据', 'account.create': '添加游戏账号', 'account.update': '更新游戏账号',
  'account.delete': '删除游戏账号', 'account.batch-delete': '批量删除游戏账号', 'account.import': '导入游戏账号',
  'account.export-credentials': '导出账号凭据', 'account.tags': '修改账号标签', 'account.transfer': '移交游戏账号',
  'account.claim-publish': '生成账号认领码', 'account.claim-revoke': '撤销账号认领码', 'account.claim': '认领游戏账号',
  'resources.transfer': '交接用户资源', 'proxy.credentials': '查看代理凭据', 'proxy.create': '添加代理',
  'proxy.update': '更新代理', 'proxy.delete': '删除代理', 'proxy.test': '测试代理', 'proxy.default': '设置默认代理',
  'tag.create': '创建标签', 'tag.update': '更新标签', 'tag.delete': '删除标签',
  'mail.fetch': '获取邮件', 'mail.fetch-new': '获取最新邮件', 'mail.clear': '清空邮件', 'mail.verification-code': '获取邮箱验证码',
  'backup.reauthenticate': '备份操作密码验证', 'backup.download': '数据库备份', 'backup.restore': '数据库恢复',
};
const targetLabels: Record<string, string> = { user: '用户', account: '游戏账号', proxy: '代理', tag: '标签', system: '系统', settings: '设置' };
function validateShortLinkLength(value: string) {
  const length = Number(value);
  return value.trim() && Number.isInteger(length) && length >= 8 && length <= 64 ? '' : '请输入 8–64 之间的整数。';
}
export default function Settings() {
  const [enabled, setEnabled] = useState(false);
  const [original, setOriginal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [shortLinkLength, setShortLinkLength] = useState('22');
  const [originalShortLinkLength, setOriginalShortLinkLength] = useState(22);
  const [shortLinkBusy, setShortLinkBusy] = useState(false);
  const [shortLinkTouched, setShortLinkTouched] = useState(false);
  const [shortLinkSaveError, setShortLinkSaveError] = useState('');
  const shortLinkInput = useRef<HTMLInputElement>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setLoadError('');
    settingsApi.get().then(data => {
      if (!active) return;
      setEnabled(data.registration_enabled); setOriginal(data.registration_enabled);
      setShortLinkLength(String(data.short_link_length)); setOriginalShortLinkLength(data.short_link_length);
      setError(''); setShortLinkSaveError(''); setShortLinkTouched(false);
    }).catch(err => {
      if (active) setLoadError(err instanceof Error ? err.message : '加载系统设置失败，请重试。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loadAttempt]);
  const loadAudit = useCallback(async () => {
    setAuditLoading(true); setAuditError('');
    try { const data = await settingsApi.audit(page); setLogs(data.list); setTotal(data.total); }
    catch (err) { setAuditError(err instanceof Error ? err.message : '加载审计记录失败'); }
    finally { setAuditLoading(false); }
  }, [page]);
  useEffect(() => { void loadAudit(); }, [loadAudit]);
  const save = async () => {
    if (loading || loadError || busy || enabled === original) return;
    setBusy(true); setError('');
    try {
      const data = await settingsApi.update(enabled);
      setEnabled(data.registration_enabled); setOriginal(data.registration_enabled);
      toast.success('注册设置已保存'); void loadAudit();
      await useAuthStore.getState().refreshConfig().catch(() => toast.error('注册设置已保存，但入口状态刷新失败，请刷新页面。'));
    }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const saveShortLinkLength = async () => {
    if (loading || loadError || shortLinkBusy) return;
    setShortLinkTouched(true); setShortLinkSaveError('');
    if (validateShortLinkLength(shortLinkLength)) { shortLinkInput.current?.focus(); return; }
    if (Number(shortLinkLength) === originalShortLinkLength) return;
    setShortLinkBusy(true);
    try {
      const data = await settingsApi.updateShortLinkLength(Number(shortLinkLength));
      setShortLinkLength(String(data.short_link_length)); setOriginalShortLinkLength(data.short_link_length);
      setShortLinkTouched(false);
      toast.success('短链长度已保存', { description: '新生成和重置的短链将使用此长度，已有短链继续有效。' });
      void loadAudit();
    } catch (err) { setShortLinkSaveError(err instanceof Error ? err.message : '短链设置保存失败，请重试。'); }
    finally { setShortLinkBusy(false); }
  };
  const shortLinkValidationError = shortLinkTouched ? validateShortLinkLength(shortLinkLength) : '';
  const shortLinkError = shortLinkValidationError || shortLinkSaveError;
  return <div className="space-y-6"><div><h1 className="text-2xl font-semibold">系统设置</h1><p className="mt-2 text-sm text-muted-foreground">管理注册入口、短链长度、数据库备份与操作记录。</p></div>
    {loadError && <div className="space-y-3"><FormError message={loadError} /><button className="button-secondary" onClick={() => setLoadAttempt(attempt => attempt + 1)}>重新加载设置</button></div>}
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <section className="space-y-5 rounded-lg border border-border bg-card p-6">
        <div><h2 className="text-lg font-semibold">开放注册</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">允许访客自行创建普通用户账号。关闭后，已有账号仍可登录，管理员仍可创建用户。</p></div>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium"><input type="checkbox" className="h-5 w-5 accent-green-700" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={loading || !!loadError || busy} />允许用户注册</label>
        <FormError message={error} />
        <button className="button-primary" disabled={loading || !!loadError || busy || enabled === original} onClick={() => void save()}>{loading ? '加载中…' : busy ? '保存中…' : '保存注册设置'}</button>
      </section>
      <section className="space-y-5 rounded-lg border border-border bg-card p-6">
        <div><h2 className="text-lg font-semibold">短链设置</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">设置账号短链中 <code>/s/</code> 后的随机字符串长度，不包含域名和路径。</p></div>
        <form noValidate className="space-y-5" aria-busy={shortLinkBusy} onSubmit={event => { event.preventDefault(); void saveShortLinkLength(); }}>
          <div className="space-y-2">
            <label htmlFor="short-link-length" className="form-label">短链随机字符串长度</label>
            <input ref={shortLinkInput} id="short-link-length" type="number" inputMode="numeric" min={8} max={64} step={1} required className="form-input max-w-48" value={shortLinkLength}
              disabled={loading || !!loadError || shortLinkBusy} aria-invalid={!!shortLinkValidationError} aria-describedby={`short-link-length-hint${shortLinkError ? ' short-link-length-error' : ''}`}
              onChange={event => { setShortLinkLength(event.target.value); setShortLinkSaveError(''); }} onBlur={() => setShortLinkTouched(true)} />
            <p id="short-link-length-hint" className="text-xs leading-6 text-muted-foreground">8–64 之间的整数，默认 22。仅影响新生成和重置的短链，已有短链继续有效。</p>
            {shortLinkError && <p id="short-link-length-error" role="alert" className="text-sm leading-6 text-red-700 dark:text-red-200">{shortLinkError}</p>}
          </div>
          <button className="button-primary" disabled={loading || !!loadError || shortLinkBusy || Number(shortLinkLength) === originalShortLinkLength}>{loading ? '加载中…' : shortLinkBusy ? '保存中…' : '保存短链设置'}</button>
        </form>
      </section>
      <section className="rounded-lg border border-border bg-card p-6 lg:col-span-2"><h2 className="text-lg font-semibold">数据库备份与恢复</h2><p className="mb-6 mt-2 text-sm leading-7 text-muted-foreground">备份包含全部用户及业务数据。恢复后所有用户需要重新登录。</p><BackupRestore /></section>
    </div>
    <section className="space-y-4"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">操作审计</h2><button className="button-secondary" disabled={auditLoading} onClick={() => void loadAudit()}>刷新记录</button></div><FormError message={auditError} /><div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full min-w-[750px] text-left text-sm"><thead className="border-b border-border bg-secondary text-muted-foreground"><tr>{['时间', '操作者', '操作', '对象', '结果', '来源 IP'].map(label => <th className="px-4 py-4 font-medium" key={label}>{label}</th>)}</tr></thead><tbody className="divide-y divide-border">{auditLoading ? <tr><td colSpan={6} className="p-10 text-center text-muted-foreground" role="status">正在加载记录…</td></tr> : logs.length === 0 ? <tr><td colSpan={6} className="p-10 text-center text-muted-foreground">暂无操作记录</td></tr> : logs.map(log => <tr key={log.id}><td className="px-4 py-4 text-xs">{new Date(log.created_at).toLocaleString()}</td><td className="px-4 py-4">{log.actor_username || (log.actor_id ? `用户 #${log.actor_id}` : '访客 / 系统')}</td><td className="px-4 py-4">{actionLabels[log.action] || log.action}</td><td className="px-4 py-4 text-muted-foreground">{[log.target_type ? targetLabels[log.target_type] || log.target_type : '', log.target_id].filter(v => v != null && v !== '').join(' #') || '—'}</td><td className="px-4 py-4">{['success', 'ok', 'active'].includes(log.result) ? '成功' : ['failure', 'failed', 'error'].includes(log.result) ? '失败' : log.result}</td><td className="px-4 py-4 text-xs text-muted-foreground">{log.ip === 'local-cli' ? '本机管理工具' : log.ip || '—'}</td></tr>)}</tbody></table></div><Pagination page={page} pageSize={20} total={total} onPage={setPage} disabled={auditLoading} /></section>
  </div>;
}
