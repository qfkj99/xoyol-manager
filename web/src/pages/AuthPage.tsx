import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { FolderInput, Mail, ShieldCheck, Sun, Moon, ArrowRight, Inbox, Tags } from 'lucide-react';
import { authApi } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';
import { FormError, PasswordField } from '../components/auth/FormControls';

export function safeReturnTo(value: string | null): string {
  if (!value || !/^\/(dashboard|accounts|proxy|profile|users|settings)(\?|$)/.test(value) || value.includes('\\')) return '/dashboard';
  return value;
}

export default function AuthPage({ register = false }: { register?: boolean }) {
  const { user, config, acceptSession, refreshConfig } = useAuthStore();
  const { theme, setTheme } = useThemeStore();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);
  const minLength = config?.password_min_length || 12;
  const maxLength = config?.password_max_length || 128;
  const returnTo = safeReturnTo(params.get('returnTo'));
  const query = returnTo === '/dashboard' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect(() => { setPassword(''); setConfirmPassword(''); setError(''); }, [register]);
  useEffect(() => { void refreshConfig().catch(() => setError('无法读取登录设置，请刷新页面重试。')); }, [refreshConfig]);
  if (user) return <Navigate to={user.must_change_password ? '/profile' : (user.role !== 'admin' && /^\/(proxy|users|settings)/.test(returnTo) ? '/dashboard' : returnTo)} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (register && password !== confirmPassword) { setError('两次输入的密码不一致，请重新确认。'); return; }
    setBusy(true);
    try {
      const latestConfig = await refreshConfig();
      if (!latestConfig.initialized) throw new Error('系统尚未完成初始化，请联系管理员。');
      if (register && !latestConfig.registration_enabled) throw new Error('管理员已关闭注册，请联系管理员创建账号。');
      const session = register
        ? await authApi.register({ username: username.trim(), display_name: displayName.trim(), password })
        : await authApi.login({ username: username.trim(), password, remember });
      acceptSession(session);
    } catch (err) { setError(err instanceof Error ? err.message : '操作失败，请稍后重试。'); }
    finally { setBusy(false); }
  };

  return <div className="auth-page min-h-dvh bg-background">
    <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
      <Link to="/" className="flex items-center gap-3 font-semibold"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Mail size={21} aria-hidden="true" /></span><span>小师妹账号管理平台</span></Link>
      <button className="button-secondary h-11 w-11 !p-0" aria-label="切换明暗主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>
    </header>
    <main className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-10 pt-5 sm:px-8 lg:min-h-[calc(100dvh-112px)] lg:grid-cols-[1.1fr_1fr] lg:gap-20 lg:px-12 lg:py-10">
      <section className="order-2 lg:order-1" aria-labelledby="welcome-title">
        <div className="mb-7 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground"><Inbox size={18} aria-hidden="true" /> 游戏账号，统一管理</div>
        <h1 id="welcome-title" className="max-w-lg text-4xl font-semibold leading-[1.25] tracking-tight sm:text-5xl">账号与绑定邮箱，<br />放进一个工作台。</h1>
        <p className="mt-6 max-w-md text-base leading-8 text-muted-foreground">导入管理员提供的账号资料，清楚查看登录信息，一键获取绑定邮箱的验证码。</p>
        <div className="auth-mail-illustration my-8 rounded-lg border border-border bg-card p-5" aria-hidden="true">
          <div className="flex items-center justify-between border-b border-border pb-4"><span className="flex items-center gap-2 text-sm font-medium"><Mail size={17} className="text-primary" /> 游戏账号工作台</span><span className="text-xs text-muted-foreground">导入账号 · 登录资料 · 验证码</span></div>
          <div className="flex items-center gap-4 py-5"><div className="h-11 w-11 rounded-md bg-secondary p-3"><Inbox className="h-5 w-5 text-primary" /></div><div className="flex-1"><div className="h-2.5 w-2/3 rounded bg-muted" /><div className="mt-3 h-2 w-1/2 rounded bg-secondary" /></div><span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">收件箱</span></div>
          <div className="flex items-center gap-4 border-t border-border pt-5"><div className="h-11 w-11 rounded-md bg-secondary p-3"><Tags className="h-5 w-5 text-primary" /></div><div className="flex-1"><div className="h-2.5 w-1/2 rounded bg-muted" /><div className="mt-3 h-2 w-3/4 rounded bg-secondary" /></div><span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">按标签整理</span></div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground"><span className="flex items-center gap-2"><FolderInput size={17} aria-hidden="true" />导入账号</span><span className="flex items-center gap-2"><Inbox size={17} aria-hidden="true" />邮箱验证码</span><span className="flex items-center gap-2"><ShieldCheck size={17} aria-hidden="true" />个人工作空间</span></div>
      </section>
      <section className="order-1 w-full rounded-2xl border border-border bg-card p-6 sm:p-9 lg:order-2" aria-labelledby="auth-title">
        <h2 id="auth-title" className="text-2xl font-semibold">{register ? '创建你的账号' : '欢迎回来'}</h2>
        <p className="mb-7 mt-2 text-sm leading-6 text-muted-foreground">{register ? '注册平台用户后，即可导入账号并获取邮箱验证码。' : '登录，继续管理你的游戏账号。'}</p>
        {params.get('restored') === '1' && <p role="status" className="mb-5 rounded-md border border-border bg-secondary p-3 text-sm leading-6">恢复完成，请使用备份中的账号登录。</p>}
        {!config?.initialized ? <div role="status" className="rounded-md bg-secondary p-5 text-sm leading-7">系统尚未完成初始化，请联系管理员完成设置后再登录。</div>
          : register && !config.registration_enabled ? <div role="status" className="space-y-4 rounded-md bg-secondary p-5 text-sm leading-7"><p>注册暂未开放，请联系管理员创建账号。</p><Link className="inline-flex font-medium text-primary hover:underline" to={`/login${query}`}>已有账号，前往登录</Link></div>
          : <form onSubmit={submit} className="space-y-5">
            <fieldset disabled={busy} className="space-y-5">
              <div className="space-y-2"><label htmlFor="username" className="form-label">平台用户名</label><input id="username" name="username" className="form-input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={e => setUsername(e.target.value)} required minLength={3} maxLength={32} pattern={register ? '[A-Za-z0-9_]{3,32}' : undefined} aria-describedby="username-hint" /><p id="username-hint" className="text-xs leading-relaxed text-muted-foreground">{register ? '3–32 位英文字母、数字或下划线，用于登录平台。' : '使用平台用户名，区别于导入的游戏账号和微软邮箱。'}</p></div>
              {register && <div className="space-y-2"><label htmlFor="display-name" className="form-label">显示名称 <span className="font-normal text-muted-foreground">（选填）</span></label><input id="display-name" className="form-input" autoComplete="nickname" maxLength={50} value={displayName} onChange={e => setDisplayName(e.target.value)} /></div>}
              <PasswordField id="password" label="密码" name="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={register ? minLength : undefined} maxLength={maxLength} hint={register ? `${minLength}–${maxLength} 个字符，建议使用独立的长密码。` : undefined} />
              {register ? <PasswordField id="confirm-password" label="确认密码" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required maxLength={maxLength} /> : <div className="flex items-center justify-between gap-3 text-sm"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="h-4 w-4 accent-green-700" />保持登录</label><button type="button" className="min-h-11 text-muted-foreground hover:text-foreground hover:underline" onClick={() => setForgot(!forgot)}>忘记密码？</button></div>}
            </fieldset>
            {forgot && !register && <p role="status" className="rounded-md bg-secondary p-3 text-sm leading-6 text-muted-foreground">请联系平台管理员重置密码。重置后，首次登录需要设置新密码。</p>}
            <FormError message={error} />
            <button className="button-primary w-full" disabled={busy} type="submit">{busy ? '正在处理…' : register ? '注册并进入工作台' : '登录工作台'}{!busy && <ArrowRight size={17} aria-hidden="true" />}</button>
            <p className="text-center text-sm text-muted-foreground">{register ? <>已经有账号？ <Link to={`/login${query}`} className="font-medium text-primary hover:underline">立即登录</Link></> : config.registration_enabled ? <>还没有账号？ <Link to={`/register${query}`} className="font-medium text-primary hover:underline">创建账号</Link></> : '需要账号？请联系平台管理员。'}</p>
          </form>}
      </section>
    </main>
  </div>;
}
