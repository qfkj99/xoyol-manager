import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { KeyRound, UserRound, ShieldCheck } from 'lucide-react';
import { authApi, resetSession } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { FormError, PasswordField } from '../components/auth/FormControls';

export default function Profile() {
  const { user, config } = useAuthStore();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.display_name || '');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  if (!user) return null;
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setSaving('profile'); setError('');
    try { const updated = await authApi.profile(name.trim()); useAuthStore.setState({ user: updated }); toast.success('个人资料已保存'); }
    catch (err) { setError(err instanceof Error ? err.message : '保存失败'); }
    finally { setSaving(''); }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (password !== confirmation) { setError('两次输入的新密码不一致。'); return; }
    if (password === current) { setError('新密码必须与当前密码不同。'); return; }
    setSaving('password');
    try {
      await authApi.password(current, password);
      resetSession(); localStorage.setItem('session-change', `${Date.now()}`);
      toast.success('密码已更新，请使用新密码登录'); navigate('/login', { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : '修改密码失败'); }
    finally { setSaving(''); }
  };
  return <div className="mx-auto max-w-4xl space-y-6">
    <div><h1 className="text-2xl font-semibold">个人中心</h1><p className="mt-2 text-sm text-muted-foreground">管理个人资料与账号安全。</p></div>
    {user.must_change_password && <div role="status" className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-7 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"><ShieldCheck className="mt-1 shrink-0" size={20} /><p>为保护账号，请先修改初始密码。完成后重新登录，即可进入工作台。</p></div>}
    <FormError message={error} />
    <div className="grid items-start gap-6 md:grid-cols-2">
      <section className="rounded-lg border border-border bg-card p-6"><h2 className="mb-6 flex items-center gap-2 text-lg font-semibold"><UserRound size={19} aria-hidden="true" />个人资料</h2><form onSubmit={saveProfile} className="space-y-5"><div className="space-y-2"><label className="form-label">用户名</label><p className="rounded-md bg-secondary px-3 py-3 text-sm">{user.username}</p></div><div className="space-y-2"><label className="form-label" htmlFor="profile-name">显示名称</label><input id="profile-name" className="form-input" maxLength={50} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} disabled={!!saving || user.must_change_password} /></div><div className="flex justify-between text-sm"><span className="text-muted-foreground">账号角色</span><span>{user.role === 'admin' ? '管理员' : '普通用户'}</span></div><button className="button-secondary w-full" disabled={!!saving || user.must_change_password}>{saving === 'profile' ? '保存中…' : '保存资料'}</button></form></section>
      <section className="rounded-lg border border-border bg-card p-6"><h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><KeyRound size={19} aria-hidden="true" />修改密码</h2><p className="mb-6 text-sm leading-6 text-muted-foreground">修改后将退出所有设备，需要重新登录。</p><form onSubmit={changePassword} className="space-y-5"><fieldset disabled={!!saving} className="space-y-5"><PasswordField id="current-password" label={user.must_change_password ? '初始密码' : '当前密码'} value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required maxLength={128} /><PasswordField id="new-password" label="新密码" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={config?.password_min_length || 12} maxLength={config?.password_max_length || 128} hint={`${config?.password_min_length || 12}–${config?.password_max_length || 128} 个字符，支持粘贴与密码管理器。`} /><PasswordField id="new-password-confirm" label="确认新密码" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" required maxLength={128} /></fieldset><button className="button-primary w-full" disabled={!!saving}>{saving === 'password' ? '更新中…' : '更新密码并重新登录'}</button></form></section>
    </div>
  </div>;
}
