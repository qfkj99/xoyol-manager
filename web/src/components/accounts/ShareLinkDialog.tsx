import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { accountApi } from '../../lib/api';
import type { Account, AccountShareLink } from '../../types';
import { FormError, Modal } from '../auth/FormControls';

function dateLabel(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

export default function ShareLinkDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const [link, setLink] = useState<AccountShareLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expiresIn, setExpiresIn] = useState<'never' | '7' | '30'>('never');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setLink(null);
    accountApi.shareLink(account.id, controller.signal)
      .then(data => { if (!controller.signal.aborted) setLink(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '加载短链失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [account.id, retry]);

  const url = link?.enabled && link.path ? new URL(link.path, window.location.origin).href : '';
  const update = async (close = false) => {
    if (busy) return;
    if (link?.enabled && !window.confirm(close ? '关闭后，此链接将立即失效，持有人无法继续查看账号或获取验证码。确定关闭？' : '重置后，旧链接将立即失效。需要向持有人发送新链接，确定重置？')) return;
    setBusy(true); setError('');
    try {
      const data = close ? await accountApi.closeShareLink(account.id) : await accountApi.createShareLink(account.id, expiresIn === 'never' ? null : Number(expiresIn) as 7 | 30);
      setLink(close ? { enabled: false } : data);
      toast.success(close ? '短链已关闭' : link?.enabled ? '短链已重置，旧链接已失效' : '短链已生成');
    } catch (err) { setError(err instanceof Error ? err.message : '短链操作失败'); }
    finally { setBusy(false); }
  };

  return <Modal title="账号短链" description={`${account.game_account || '游戏资料待补充'} · ${account.email}`} onClose={onClose} busy={busy}>
    <div className="space-y-5">
      <p className="rounded-md border border-border bg-secondary p-3 text-sm leading-6">持有短链的人无需登录，即可查看游戏账号和绑定邮箱的全部八项信息，包括密码与刷新令牌，并获取该邮箱的验证码。请仅分享给接收账号的人。</p>
      <FormError message={error} />
      {loading ? <p className="py-5 text-center text-sm text-muted-foreground" role="status">正在加载短链…</p> : link ? <>
        {url ? <section className="space-y-3" aria-label="当前短链">
          <p className="text-sm font-medium">当前短链</p>
          <p className="select-all whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-sm [overflow-wrap:anywhere]">{url}</p>
          <div className="flex flex-wrap gap-2">
            <button className="button-secondary" disabled={busy} onClick={async () => { try { await navigator.clipboard.writeText(url); toast.success('短链已复制'); } catch { toast.error('复制失败，请手动选择链接复制'); } }}><Copy size={16} aria-hidden="true" />复制短链</button>
            <a className="button-secondary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ExternalLink size={16} aria-hidden="true" />打开短链</a>
          </div>
          <p className="text-xs leading-6 text-muted-foreground">{link.created_at && <>生成时间：{dateLabel(link.created_at)}<br /></>}{link.expires_at ? `有效期至：${dateLabel(link.expires_at)}` : '有效期：长期有效，直至关闭或重置'}</p>
        </section> : <p className="text-sm leading-6 text-muted-foreground">当前没有有效短链。生成后即可复制分享。</p>}
        <div className="space-y-2"><label htmlFor={`share-expiry-${account.id}`} className="form-label">{url ? '新链接有效期' : '链接有效期'}</label><select id={`share-expiry-${account.id}`} className="form-input" value={expiresIn} disabled={busy} onChange={event => setExpiresIn(event.target.value as typeof expiresIn)}><option value="never">长期有效</option><option value="7">7 天</option><option value="30">30 天</option></select></div>
        <div className="flex flex-wrap gap-3"><button className="button-primary flex-1" disabled={busy} onClick={() => void update()}>{busy ? <RefreshCw size={16} className="animate-spin" aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{busy ? '处理中…' : url ? '重置链接' : '生成短链'}</button>{url && <button className="button-secondary text-destructive" disabled={busy} onClick={() => void update(true)}><Unlink size={16} aria-hidden="true" />关闭短链</button>}</div>
      </> : <button className="button-secondary w-full" onClick={() => setRetry(value => value + 1)}>重新加载</button>}
    </div>
  </Modal>;
}
