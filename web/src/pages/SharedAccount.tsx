import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Copy, Gamepad2, KeyRound, Link2Off, Mail, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, shareApi } from '../lib/api';
import { GAME_FIELD_LABELS, GAME_IMPORT_FORMAT } from '../lib/gameAccounts';
import { FormError } from '../components/auth/FormControls';
import type { SharedAccount, VerificationCodeResult } from '../types';

function dateLabel(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '时间未知';
}

async function copy(value: string, label: string) {
  try { await navigator.clipboard.writeText(value); toast.success(`${label}已复制`); }
  catch { toast.error('复制失败，请手动选择内容复制'); }
}

function InfoFields({ account, fields }: { account: SharedAccount; fields: (keyof SharedAccount)[] }) {
  return <dl className="divide-y divide-border">{fields.map(field => <div key={field} className="grid min-w-0 grid-cols-[1fr_auto] items-start gap-x-3 gap-y-2 py-4 sm:grid-cols-[8rem_1fr_auto]">
    <dt className="text-sm leading-6 text-muted-foreground">{GAME_FIELD_LABELS[field] || field}</dt>
    <dd className="col-start-1 row-start-2 min-w-0 whitespace-pre-wrap font-mono text-sm leading-7 [overflow-wrap:anywhere] sm:col-start-2 sm:row-start-1">{account[field] || <span className="font-sans text-muted-foreground">未填写</span>}</dd>
    <dd className="col-start-2 row-span-2 row-start-1 sm:col-start-3 sm:row-span-1"><button className="flex h-11 w-11 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40" aria-label={`复制${GAME_FIELD_LABELS[field] || field}`} disabled={!account[field]} onClick={() => void copy(String(account[field]), GAME_FIELD_LABELS[field] || field)}><Copy size={16} aria-hidden="true" /></button></dd>
  </div>)}</dl>;
}

function SharedAccountView({ token }: { token: string }) {
  const [account, setAccount] = useState<SharedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [reload, setReload] = useState(0);
  const [codes, setCodes] = useState<VerificationCodeResult | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  const [mailError, setMailError] = useState('');
  const codeRequest = useRef(0);
  const codeController = useRef<AbortController | null>(null);
  const invalidated = useRef(false);

  const invalidate = (message: string) => {
    invalidated.current = true;
    codeRequest.current += 1;
    codeController.current?.abort();
    setAccount(null); setCodes(null); setMailError(''); setMailBusy(false);
    setInvalid(true); setError(message);
  };

  useEffect(() => {
    const previousTitle = document.title;
    document.title = '账号资料';
    const restore: (() => void)[] = [];
    for (const [name, content] of [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer']]) {
      let element = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (element) {
        const previous = element.content;
        restore.push(() => { element!.content = previous; });
      } else {
        element = document.createElement('meta'); element.name = name;
        document.head.append(element);
        restore.push(() => element!.remove());
      }
      element.content = content;
    }
    return () => { document.title = previousTitle; restore.forEach(fn => fn()); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    invalidated.current = false;
    setLoading(true); setError(''); setInvalid(false); setAccount(null); setCodes(null);
    shareApi.account(token, controller.signal)
      .then(data => { if (!controller.signal.aborted && !invalidated.current) setAccount(data); })
      .catch(err => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && [404, 410].includes(err.status)) invalidate('此短链不存在、已过期或已关闭，请向提供账号的人获取新链接。');
        else setError(err instanceof Error ? err.message : '暂时无法加载账号资料，请重试。');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); codeRequest.current += 1; codeController.current?.abort(); };
  }, [token, reload]);

  useEffect(() => {
    if (!account?.expires_at) return;
    const expires = Date.parse(account.expires_at);
    if (!Number.isFinite(expires)) return;
    const check = () => { if (Date.now() >= expires) invalidate('此短链已过期，请向提供账号的人获取新链接。'); };
    check();
    const interval = window.setInterval(check, 1000);
    return () => window.clearInterval(interval);
  }, [account?.expires_at]);

  const loadCode = async () => {
    if (mailBusy || !account || invalidated.current) return;
    const request = ++codeRequest.current;
    codeController.current?.abort();
    const controller = new AbortController();
    codeController.current = controller;
    setMailBusy(true); setMailError(''); setCodes(null);
    let received = false;
    try {
      const result = await shareApi.verificationCode(token, controller.signal);
      if (request !== codeRequest.current || controller.signal.aborted || invalidated.current) return;
      setCodes(result); received = true;
      // Microsoft can rotate the refresh token while receiving mail.
      const latest = await shareApi.account(token, controller.signal);
      if (request === codeRequest.current && !controller.signal.aborted && !invalidated.current) setAccount(latest);
    } catch (err) {
      if (request !== codeRequest.current || controller.signal.aborted) return;
      if (err instanceof ApiError && [404, 410].includes(err.status)) invalidate('此短链已失效，请向提供账号的人获取新链接。');
      else if (received) {
        setAccount(null); setCodes(null); setMailError('');
        setError('收取邮件后无法确认最新账号资料，请重新加载后再获取验证码。');
      } else setMailError(err instanceof ApiError && err.status === 429 ? `${err.message} 请稍后再获取。` : err instanceof Error ? err.message : '获取验证码失败，请稍后重试。');
    } finally { if (request === codeRequest.current && !controller.signal.aborted) setMailBusy(false); }
  };

  return <main className="mx-auto min-h-dvh w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
    <header className="mb-8 flex items-center gap-3 border-b border-border pb-6"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-secondary text-primary"><Gamepad2 size={24} aria-hidden="true" /></div><div className="min-w-0"><h1 className="text-xl font-semibold sm:text-2xl">账号资料</h1><p className="mt-1 text-sm text-muted-foreground">账号信息与绑定邮箱验证码</p></div></header>
    {loading ? <p className="py-16 text-center text-muted-foreground" role="status">正在加载账号资料…</p> : !account ? <section className="mx-auto max-w-lg space-y-5 rounded-lg border border-border bg-card p-6 sm:p-8">{invalid && <Link2Off className="text-muted-foreground" size={28} aria-hidden="true" />}<h2 className="text-lg font-semibold">{invalid ? '短链已失效' : '暂时无法加载'}</h2><FormError message={error} />{!invalid && <button className="button-secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />重新加载</button>}</section> : <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h2 className="font-mono text-xl font-semibold [overflow-wrap:anywhere]">{account.game_account || account.email}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{account.expires_at ? `链接有效期至 ${dateLabel(account.expires_at)}` : '链接长期有效，由账号提供者管理。'}</p></div><button className="button-secondary" onClick={() => void copy(GAME_IMPORT_FORMAT.map(field => String(account[field as keyof SharedAccount] ?? '')).join('----'), '完整八项信息')}><Copy size={16} aria-hidden="true" />复制完整八项</button></div>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-lg border border-border bg-card p-5 sm:p-6 lg:col-start-1 lg:row-start-1" aria-labelledby="game-info-title"><h2 id="game-info-title" className="flex items-center gap-2 text-lg font-semibold"><Gamepad2 size={20} aria-hidden="true" />游戏登录资料</h2><InfoFields account={account} fields={['game_account', 'game_password', 'real_name', 'id_last_six']} /></section>
        <section className="min-w-0 space-y-5 rounded-lg border border-border bg-card p-5 sm:p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-labelledby="verification-title">
          <div><h2 id="verification-title" className="flex items-center gap-2 text-lg font-semibold"><KeyRound size={20} aria-hidden="true" />获取邮箱验证码</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">先在游戏中发送验证码，再点击下方按钮收取该邮箱的邮件。</p></div>
          <p className="text-xs leading-6 text-muted-foreground">默认同时检查收件箱和垃圾箱，按邮件时间展示候选验证码。</p>
          <button className="button-primary w-full" disabled={mailBusy} onClick={() => void loadCode()}><RefreshCw size={17} className={mailBusy ? 'animate-spin' : ''} aria-hidden="true" />{mailBusy ? '正在收取邮件…' : codes ? '重新获取验证码' : '获取验证码'}</button>
          <FormError message={mailError} />
          {mailBusy && <p role="status" className="text-sm leading-7 text-muted-foreground">正在检查收件箱和垃圾箱，请稍候…</p>}
          {codes && <div className="space-y-4"><p className={`rounded-md p-3 text-sm leading-7 ${codes.cached ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200' : 'bg-secondary text-muted-foreground'}`}>{codes.cached ? '当前显示缓存邮件中的候选验证码，可能不是最新邮件。' : '已检查最新邮件。'}请核对发件人和邮件时间，候选验证码可能已过期。<span className="mt-1 block text-xs">获取时间：{dateLabel(codes.fetched_at)}</span></p>{codes.warning && <p role="status" className="rounded-md bg-secondary p-3 text-sm leading-6 text-muted-foreground">{codes.warning}</p>}
            {codes.candidates.length ? codes.candidates.map((candidate, index) => <article key={`${candidate.mailbox}-${candidate.mail_id}-${candidate.code}-${index}`} className="min-w-0 rounded-md border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><code className="text-2xl font-semibold tracking-widest text-primary [overflow-wrap:anywhere]">{candidate.code}</code><button className="button-secondary" onClick={() => void copy(candidate.code, '验证码')}><Copy size={15} aria-hidden="true" />复制</button></div><p className="mt-3 text-sm font-medium [overflow-wrap:anywhere]">{candidate.subject}</p><p className="mt-2 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">来源：{candidate.mailbox === 'Junk' ? '垃圾箱' : '收件箱'}{candidate.cached ? ' · 缓存邮件' : ''}<br />发件人：{candidate.sender}<br />邮件时间：{dateLabel(candidate.mail_date)}</p><p className={`mt-3 text-xs leading-6 ${candidate.recent ? 'text-muted-foreground' : 'text-amber-800 dark:text-amber-200'}`}>{candidate.recent ? '15 分钟内的邮件，仍请核对有效期。' : '较早邮件，请检查验证码是否已过期。'}</p></article>) : <p role="status" className="rounded-md border border-dashed border-border p-4 text-sm leading-7 text-muted-foreground">没有找到候选验证码。请确认已在游戏中发送验证码，稍等片刻后重新获取。</p>}
          </div>}
        </section>
        <section className="min-w-0 rounded-lg border border-border bg-card p-5 sm:p-6 lg:col-start-1 lg:row-start-2" aria-labelledby="email-info-title"><h2 id="email-info-title" className="flex items-center gap-2 text-lg font-semibold"><Mail size={20} aria-hidden="true" />绑定微软邮箱</h2><InfoFields account={account} fields={['email', 'password', 'client_id', 'refresh_token']} />{account.remark && <div className="border-t border-border pt-4 text-sm leading-7"><h3 className="font-medium">备注</h3><p className="mt-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{account.remark}</p></div>}</section>
      </div>
    </>}
  </main>;
}

export default function SharedAccountPage() {
  const { token = '' } = useParams();
  return <SharedAccountView key={token} token={token} />;
}
