import { useEffect, useState } from 'react';
import { Copy, Mail, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { Account, VerificationCodeResult } from '../../types';
import { mailApi } from '../../lib/api';
import { FormError, Modal } from '../auth/FormControls';

function mailTime(value: string) { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '邮件时间未知'; }

export default function VerificationCodeDialog({ account, onClose, onViewMail }: { account: Account; onClose: () => void; onViewMail: (mailbox: 'INBOX' | 'Junk') => void }) {
  const [result, setResult] = useState<VerificationCodeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await mailApi.verificationCode(account.id)); }
    catch (err) { setError(err instanceof Error ? err.message : '获取验证码失败'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [account.id]);
  return <Modal title="获取邮箱验证码" description={`${account.game_account || '游戏账号'} · ${account.email}`} onClose={onClose} busy={busy}>
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">同时检查收件箱和垃圾箱</p><button className="button-secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={16} className={busy ? 'animate-spin' : ''} />{busy ? '收取中…' : '重新获取'}</button></div>
      <FormError message={error} />
      {busy && <p role="status" className="py-8 text-center text-sm text-muted-foreground">正在检查收件箱和垃圾箱并查找验证码…</p>}
      {result && <><p className="text-xs leading-6 text-muted-foreground">{result.cached ? '当前显示缓存邮件中的候选验证码。' : '已检查最新邮件。'}请核对发件人和邮件时间，验证码可能已经过期。</p>{result.warning && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900 dark:bg-amber-950 dark:text-amber-200">{result.warning}</p>}
        {result.candidates.length ? <div className="max-h-80 space-y-3 overflow-y-auto">{result.candidates.map((candidate, index) => <article key={`${candidate.mailbox}-${candidate.mail_id}-${candidate.code}-${index}`} className="rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-4"><code className="break-all text-2xl font-semibold tracking-widest text-primary">{candidate.code}</code><button className="button-secondary shrink-0" onClick={async () => { try { await navigator.clipboard.writeText(candidate.code); toast.success('验证码已复制'); } catch { toast.error('复制失败，请手动复制'); } }}><Copy size={15} />复制</button></div><p className="mt-3 break-all text-sm font-medium">{candidate.subject}</p><p className="mt-1 break-all text-xs leading-6 text-muted-foreground">{candidate.mailbox === 'Junk' ? '垃圾箱' : '收件箱'}{candidate.cached ? ' · 缓存邮件' : ''}<br />{candidate.sender}<br />{mailTime(candidate.mail_date)}</p><span className={`mt-2 inline-block rounded-full px-2 py-1 text-xs ${candidate.recent ? 'bg-secondary text-primary' : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200'}`}>{candidate.recent ? '15 分钟内的邮件' : '较早邮件，请检查是否过期'}</span></article>)}</div> : <div className="rounded-lg bg-secondary p-5 text-sm leading-7 text-muted-foreground">没有找到候选验证码。请先在游戏中发送验证码，稍等片刻后重新获取；也可查看完整邮件。</div>}
      </>}
      <button className="button-secondary w-full" disabled={busy} onClick={() => onViewMail('INBOX')}><Mail size={16} />查看完整邮件</button>
    </div>
  </Modal>;
}
