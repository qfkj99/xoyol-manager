import { useId, useState, type FormEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { FormError, Modal, PasswordField } from '../auth/FormControls';
import { apiFetch, getSessionGeneration, request, resetSession } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';

const MAX_BYTES = 50 * 1024 * 1024;

function readBackup(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择'));
    reader.onabort = () => reject(new Error('文件读取已取消'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export default function BackupRestore() {
  const user = useAuthStore((state) => state.user);
  const id = useId();
  const [mode, setMode] = useState<'download' | 'restore' | null>(null);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (user?.role !== 'admin') return null;

  const open = (next: 'download' | 'restore') => {
    setPassword(''); setFile(null); setConfirmed(false); setError(''); setMode(next);
  };
  const close = () => { setPassword(''); setFile(null); setMode(null); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'restore' && (!file || file.size > MAX_BYTES || !file.size)) {
      setError('请选择有效的备份文件，文件大小须在 50 MB 以内'); return;
    }
    if (mode === 'restore' && !confirmed) { setError('请确认已了解恢复的影响'); return; }
    setBusy(true);
    const generation = getSessionGeneration();
    try {
      if (mode === 'download') {
        const response = await apiFetch('/backup/download', { method: 'POST', body: JSON.stringify({ password }) });
        const blob = await response.blob();
        if (generation !== getSessionGeneration()) throw new Error('登录状态已改变，请重新登录后重试');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `outlook-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        close();
      } else {
        const fileContent = await readBackup(file!);
        if (generation !== getSessionGeneration()) throw new Error('登录状态已改变，请重新登录后重试');
        await request('/backup/restore', { method: 'POST', body: JSON.stringify({ password, fileContent }) });
        resetSession();
        window.location.assign('/login?restored=1');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后重试');
    } finally { setBusy(false); }
  };

  return <>
    <div className="flex flex-wrap items-center gap-2">
      <button className="button-secondary" onClick={() => open('download')}><Download size={16} aria-hidden="true" />备份数据库</button>
      <button className="button-secondary" onClick={() => open('restore')}><Upload size={16} aria-hidden="true" />恢复数据库</button>
    </div>
    {mode && <Modal title={mode === 'download' ? '备份数据库' : '恢复数据库'} description={mode === 'download'
      ? '下载包含全部用户、游戏账号、绑定邮箱和代理凭据的完整备份。请妥善保存文件。备份不包含登录会话。'
      : '恢复会覆盖当前全部用户和业务数据，并退出所有登录会话。恢复完成后，请使用备份中的用户账号登录；恢复旧版备份时使用当前管理员账号。'} onClose={close} busy={busy}>
      <form onSubmit={submit} className="space-y-5">
        {mode === 'restore' && <>
          <div className="space-y-2">
            <label className="form-label" htmlFor={`${id}-file`}>SQLite 备份文件</label>
            <input id={`${id}-file`} type="file" accept=".db,.sqlite,.sqlite3" disabled={busy} required className="form-input h-auto py-3" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            <p className="text-xs text-muted-foreground">最大 50 MB。替换前会校验文件并自动保留当前数据库副本。</p>
          </div>
          <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required disabled={busy} className="mt-1 h-4 w-4 shrink-0 accent-primary" /><span>我确认用该备份覆盖所有用户及其数据，并已保存需要保留的数据。</span></label>
        </>}
        <PasswordField id={`${id}-password`} label="当前管理员密码" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} maxLength={128} />
        <FormError message={error} />
        <div className="flex justify-end gap-3">
          <button type="button" className="button-secondary" disabled={busy} onClick={close}>取消</button>
          <button className="button-primary" disabled={busy}>{busy ? (mode === 'restore' ? '正在校验并恢复…' : '正在生成备份…') : (mode === 'restore' ? '确认恢复' : '下载备份')}</button>
        </div>
      </form>
    </Modal>}
  </>;
}
