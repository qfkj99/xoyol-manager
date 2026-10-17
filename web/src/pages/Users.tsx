import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Search, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { accountApi, userApi } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import type { User } from '../types';
import { FormError, Modal, Pagination, PasswordField } from '../components/auth/FormControls';

const statuses = { active: '正常', disabled: '已停用', deleted: '已注销' };
export default function Users() {
  const currentUser = useAuthStore(s => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<{ type: 'create' | 'edit' | 'reset' | 'transfer'; user?: User } | null>(null);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [editRole, setEditRole] = useState<'admin' | 'user'>('user');
  const [password, setPassword] = useState('');
  const [targets, setTargets] = useState<User[]>([]);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current; setLoading(true); setError('');
    try { const data = await userApi.list({ page, pageSize: 20, search, role, status }); if (requestId.current === id) { setUsers(data.list); setTotal(data.total); } }
    catch (err) { if (requestId.current === id) setError(err instanceof Error ? err.message : '用户列表加载失败'); }
    finally { if (requestId.current === id) setLoading(false); }
  }, [page, search, role, status]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 200); return () => { window.clearTimeout(timer); requestId.current++; }; }, [load]);
  const open = async (type: 'create' | 'edit' | 'reset' | 'transfer', user?: User) => {
    setUsername(''); setName(user?.display_name || ''); setEditRole(user?.role || 'user'); setPassword(''); setModalError(''); setTargetId(''); setTargets([]); setModal({ type, user });
    if (type === 'transfer') {
      setBusy(true);
      try {
        const all: User[] = []; let targetPage = 1; let targetTotal = 0;
        do { const data = await userApi.list({ status: 'active', page: targetPage++, pageSize: 100 }); all.push(...data.list); targetTotal = data.total; if (!data.list.length) break; } while (all.length < targetTotal);
        setTargets(all.filter(u => u.id !== user?.id));
      } catch (err) { setModalError(err instanceof Error ? err.message : '加载接收用户失败'); }
      finally { setBusy(false); }
    }
  };
  const action = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true); setError('');
    try { await fn(); toast.success(message); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!modal || busy) return; setBusy(true); setModalError('');
    try {
      if (modal.type === 'create') await userApi.create({ username: username.trim(), display_name: name.trim(), role: editRole, password });
      if (modal.type === 'edit') await userApi.update(modal.user!.id, { display_name: name.trim(), role: editRole });
      if (modal.type === 'reset') await userApi.resetPassword(modal.user!.id, password);
      if (modal.type === 'transfer') await accountApi.transferResources(modal.user!.id, Number(targetId));
      setModal(null); setPassword(''); toast.success(modal.type === 'reset' ? '密码已重置，用户下次登录需修改密码' : modal.type === 'transfer' ? '全部资源已移交' : '用户已保存'); await load();
    } catch (err) { setModalError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">用户管理</h1><p className="mt-2 text-sm text-muted-foreground">管理平台账号、访问权限与资源归属。</p></div><button className="button-primary" onClick={() => void open('create')}><Plus size={17} aria-hidden="true" />创建用户</button></div>
    <FormError message={error} />
    <div className="flex flex-wrap gap-3"><div className="relative min-w-48 flex-1"><Search size={18} aria-hidden="true" className="absolute left-3 top-3.5 text-muted-foreground" /><input className="form-input !pl-10" aria-label="搜索用户名或显示名称" placeholder="搜索用户名或显示名称" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} /></div><select className="form-input !w-auto" aria-label="筛选角色" value={role} onChange={e => { setRole(e.target.value); setPage(1); }}><option value="">全部角色</option><option value="admin">管理员</option><option value="user">普通用户</option></select><select className="form-input !w-auto" aria-label="筛选状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b border-border bg-secondary text-muted-foreground"><tr>{['用户', '角色 / 状态', '资源', '最后登录', '创建时间', '操作'].map(label => <th key={label} className="px-4 py-4 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-border">
      {loading ? <tr><td colSpan={6} className="p-12 text-center text-muted-foreground" role="status">正在加载用户…</td></tr> : users.length === 0 ? <tr><td colSpan={6} className="p-12 text-center text-muted-foreground"><UsersRound size={28} className="mx-auto mb-3" aria-hidden="true" />没有匹配的用户，请调整筛选条件。</td></tr> : users.map(user => <tr key={user.id} className="hover:bg-secondary"><td className="px-4 py-4"><p className="font-medium">{user.display_name || user.username}{user.id === currentUser?.id && <span className="ml-2 text-xs text-primary">当前用户</span>}</p><p className="mt-1 text-xs text-muted-foreground">{user.username}</p></td><td className="px-4 py-4"><p>{user.role === 'admin' ? '管理员' : '普通用户'}</p><p className={`mt-1 text-xs ${user.status === 'active' ? 'text-primary' : 'text-muted-foreground'}`}>{statuses[user.status]}{user.must_change_password ? ' · 待改密' : ''}</p></td><td className="px-4 py-4 text-xs leading-6 text-muted-foreground">游戏账号 {user.account_count || 0}<br />代理 {user.proxy_count || 0} · 标签 {user.tag_count || 0}</td><td className="px-4 py-4 text-xs text-muted-foreground">{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '尚未登录'}</td><td className="px-4 py-4 text-xs text-muted-foreground">{new Date(user.created_at).toLocaleDateString()}</td><td className="px-3 py-3"><div className="flex max-w-xs flex-wrap gap-1">
        {user.status !== 'deleted' && <><button className="button-secondary !px-2 !text-xs" disabled={busy} onClick={() => void open('edit', user)}>编辑</button><button className="button-secondary !px-2 !text-xs" disabled={busy} onClick={() => void open('reset', user)}>重置密码</button><button className="button-secondary !px-2 !text-xs" disabled={busy || user.id === currentUser?.id} onClick={() => { if (confirm(`将撤销 ${user.username} 的全部登录会话，确定继续？`)) void action(() => userApi.revokeSessions(user.id), '已撤销全部会话'); }}>强制退出</button><button className="button-secondary !px-2 !text-xs" disabled={busy || user.id === currentUser?.id} onClick={() => { if (confirm(user.status === 'active' ? `停用 ${user.username} 后将立即撤销其全部会话。确定继续？` : `确定重新启用 ${user.username}？`)) void action(() => userApi.update(user.id, { status: user.status === 'active' ? 'disabled' : 'active' }), '用户状态已更新'); }}>{user.status === 'active' ? '停用' : '启用'}</button><button className="button-secondary !px-2 !text-xs" disabled={busy} onClick={() => void open('transfer', user)}>移交资源</button><button className="button-secondary !px-2 !text-xs text-red-600 dark:text-red-400" disabled={busy || user.id === currentUser?.id} onClick={() => { if (confirm(`注销 ${user.username}？请先移交该用户全部游戏账号、绑定邮箱、代理和标签。注销后无法登录。`)) void action(() => userApi.delete(user.id), '用户已注销'); }}>注销</button></>}
      </div></td></tr>)}
    </tbody></table></div>
    <Pagination page={page} total={total} pageSize={20} onPage={setPage} disabled={loading} />
    {modal && <Modal title={{ create: '创建用户', edit: '编辑用户', reset: '重置用户密码', transfer: '移交全部资源' }[modal.type]} description={modal.type === 'create' ? '新用户首次登录必须修改初始密码。' : modal.type === 'reset' ? `重置 ${modal.user!.username} 的密码，将立即撤销全部登录会话。` : modal.type === 'transfer' ? `将 ${modal.user!.username} 的全部游戏账号、绑定邮箱、邮件缓存、代理和标签移交给指定用户，原用户将失去访问权限。请等待在途收信结束。` : `编辑 ${modal.user!.username}。角色变更后将撤销其登录会话。`} busy={busy} onClose={() => { setModal(null); setPassword(''); }}><form onSubmit={submit} className="space-y-5"><fieldset disabled={busy} className="space-y-5">
      {modal.type === 'create' && <div className="space-y-2"><label className="form-label" htmlFor="new-user-name">用户名</label><input id="new-user-name" className="form-input" autoComplete="off" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" value={username} onChange={e => setUsername(e.target.value)} /><p className="text-xs text-muted-foreground">3–32 位英文字母、数字或下划线。</p></div>}
      {['create', 'edit'].includes(modal.type) && <><div className="space-y-2"><label className="form-label" htmlFor="user-display-name">显示名称</label><input id="user-display-name" className="form-input" maxLength={50} value={name} onChange={e => setName(e.target.value)} /></div><div className="space-y-2"><label className="form-label" htmlFor="user-role">角色</label><select id="user-role" className="form-input" value={editRole} onChange={e => setEditRole(e.target.value as 'user' | 'admin')} disabled={modal.user?.id === currentUser?.id}><option value="user">普通用户</option><option value="admin">管理员</option></select><p className="text-xs leading-6 text-muted-foreground">管理员可以访问所有业务数据和用户管理功能。</p></div></>}
      {['create', 'reset'].includes(modal.type) && <PasswordField id="initial-password" label="初始密码" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} minLength={12} maxLength={128} required hint="12–128 个字符，请通过合适的方式告知用户。" />}
      {modal.type === 'transfer' && <div className="space-y-2"><label className="form-label" htmlFor="transfer-target">接收用户</label><select id="transfer-target" className="form-input" required value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">选择接收用户</option>{targets.map(u => <option key={u.id} value={u.id}>{u.display_name || u.username} ({u.username})</option>)}</select></div>}
    </fieldset><FormError message={modalError} /><div className="flex justify-end gap-3"><button type="button" className="button-secondary" disabled={busy} onClick={() => { setModal(null); setPassword(''); }}>取消</button><button type="submit" className="button-primary" disabled={busy || (modal.type === 'transfer' && !targetId)}>{busy ? '处理中…' : modal.type === 'transfer' ? '确认移交全部资源' : '保存'}</button></div></form></Modal>}
  </div>;
}
