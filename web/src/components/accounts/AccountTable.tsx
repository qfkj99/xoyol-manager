import { useState, useMemo } from 'react';
import { Mail, KeyRound, Copy, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Account, Tag } from '../../types';
import { accountApi } from '../../lib/api';
import ContextMenu from './ContextMenu';

type SortKey = 'game_account' | 'email' | 'client_id' | 'status' | 'token_refreshed_at';
type SortDir = 'asc' | 'desc' | null;

export const ALL_COLUMNS = [
  { key: 'index', label: '#', defaultVisible: true },
  { key: 'game_account', label: '游戏账号', defaultVisible: true },
  { key: 'game_password', label: '游戏密码', defaultVisible: true },
  { key: 'real_name', label: 'name / 姓名', defaultVisible: true },
  { key: 'id_last_six', label: '身份证后六位', defaultVisible: true },
  { key: 'email', label: '绑定微软邮箱', defaultVisible: true },
  { key: 'password', label: '邮箱密码', defaultVisible: false },
  { key: 'tags', label: '标签', defaultVisible: false },
  { key: 'client_id', label: '客户端 ID', defaultVisible: false },
  { key: 'refresh_token', label: '令牌', defaultVisible: false },
  { key: 'status', label: '邮箱状态', defaultVisible: true },
  { key: 'claim_status', label: '认领状态', defaultVisible: true },
  { key: 'token_status', label: '邮箱 Token', defaultVisible: false },
  { key: 'actions', label: '操作', defaultVisible: true },
] as const;

export type ColumnKey = (typeof ALL_COLUMNS)[number]['key'];

export const COLUMN_STORAGE_KEY = 'game-account-visible-columns-v1';

export function getDefaultVisibleColumns(): string[] {
  const saved = localStorage.getItem(COLUMN_STORAGE_KEY);
  if (saved) {
    try { return JSON.parse(saved); } catch { /* ignore */ }
  }
  return ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key);
}

interface Props {
  accounts: Account[];
  selectedIds: number[];
  onSelectIds: (ids: number[]) => void;
  onEdit: (account: Account) => void;
  onDelete: (id: number) => void;
  onViewMail: (account: Account, mailbox: 'INBOX' | 'Junk') => void;
  onVerificationCode: (account: Account) => void;
  onShareLink: (account: Account) => void;
  loading: boolean;
  visibleColumns: string[];
  tags: Tag[];
  onToggleTag: (accountId: number, tagId: number) => void;
  showOwner?: boolean;
}


function SortHeader({ label, sortKey: key, currentKey, currentDir, onSort, className = '' }: {
  label: string; sortKey: SortKey; currentKey: SortKey | null; currentDir: SortDir; onSort: (k: SortKey) => void; className?: string;
}) {
  return (
    <th
      className={`text-left py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400 cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors ${className}`}
      onClick={() => onSort(key)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {currentKey === key ? (
          <span className="text-xs">{currentDir === 'asc' ? '↑' : '↓'}</span>
        ) : (
          <span className="text-xs text-zinc-300 dark:text-zinc-600">↕</span>
        )}
      </span>
    </th>
  );
}

function CopyCell({ text, children, className = '' }: { text: string; children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error('复制失败，请手动选择内容'); }
  };
  return (
    <td className={`py-3 px-3 cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors ${className}`} onClick={handleClick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void handleClick(); } }} tabIndex={text ? 0 : -1} title="点击或按回车复制">
      {copied ? <span className="text-green-600 dark:text-green-400 text-xs">已复制 ✓</span> : children}
    </td>
  );
}

function CredentialCell({ account, field }: { account: Account; field: 'password' | 'refresh_token' }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reveal = async (copy = false) => {
    setBusy(true);
    try { const detail = await accountApi.credentials(account.id); const text = detail[field]; if (copy) { await navigator.clipboard.writeText(text); toast.success('已复制'); } else setValue(text); }
    catch (error) { toast.error(error instanceof Error ? error.message : '获取凭据失败'); }
    finally { setBusy(false); }
  };
  return <td className="px-3 py-3"><div className="flex items-center gap-2"><span className="max-w-40 truncate font-mono text-xs" title={value ?? undefined}>{value === null ? (account[field === 'password' ? 'has_password' : 'has_refresh_token'] ? '••••••••' : '—') : value || '—'}</span><button className="min-h-11 px-1 text-xs text-primary hover:underline" onClick={() => value === null ? void reveal() : setValue(null)} disabled={busy}>{value === null ? '显示' : '隐藏'}</button><button className="min-h-11 px-1 text-xs text-muted-foreground hover:underline" onClick={() => void reveal(true)} disabled={busy}>复制</button></div></td>;
}

function shortLinkAccessLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ShortLinkAccess({ account }: { account: Account }) {
  if (!account.share_link_enabled) {
    return <span className="inline-flex whitespace-nowrap rounded-full bg-secondary px-2 py-1 text-xs text-muted-foreground">无有效短链</span>;
  }

  if (!account.share_link_last_accessed_at) {
    return <span className="inline-flex whitespace-nowrap rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">未访问</span>;
  }

  const dateTime = account.share_link_last_accessed_at;
  const label = shortLinkAccessLabel(dateTime);
  return <div className="space-y-1"><span className="inline-flex whitespace-nowrap rounded-full bg-green-100 px-2 py-1 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400">已访问</span><time dateTime={dateTime} className="block text-xs text-muted-foreground md:whitespace-nowrap" title={`最后访问：${label}`}>最后访问：{label}</time></div>;
}

async function copyCredential(account: Account, field: 'password' | 'refresh_token') {
  try { const detail = await accountApi.credentials(account.id); await navigator.clipboard.writeText(detail[field]); toast.success('已复制'); }
  catch (error) { toast.error(error instanceof Error ? error.message : '复制失败'); }
}

export default function AccountTable({ accounts, selectedIds, onSelectIds, onEdit, onDelete, onViewMail, onVerificationCode, onShareLink, loading, visibleColumns, tags, onToggleTag, showOwner = false }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; account: Account } | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); }
    else if (sortDir === 'asc') setSortDir('desc');
    else { setSortKey(null); setSortDir(null); }
  };

  const sortedAccounts = useMemo(() => {
    if (!sortKey || !sortDir) return accounts;
    return [...accounts].sort((a, b) => {
      const va = (a as any)[sortKey] ?? '';
      const vb = (b as any)[sortKey] ?? '';
      const cmp = String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [accounts, sortKey, sortDir]);

  const isVisible = (key: string) => visibleColumns.includes(key) && (key !== 'claim_status' || showOwner);

  const allSelected = accounts.length > 0 && selectedIds.length === accounts.length;

  const toggleAll = () => {
    onSelectIds(allSelected ? [] : accounts.map(a => a.id));
  };

  const toggleOne = (id: number) => {
    onSelectIds(
      selectedIds.includes(id) ? selectedIds.filter(i => i !== id) : [...selectedIds, id]
    );
  };

  const statusBadge = (status: Account['status']) => {
    const map = {
      active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      inactive: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
      error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    };
    const label = { active: '正常', inactive: '未激活', error: '异常' };
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[status]}`}>
        {label[status]}
      </span>
    );
  };

  const tokenStatusBadge = (account: Account) => {
    if (account.status === 'error') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          异常
        </span>
      );
    }
    if (!account.token_refreshed_at) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400">
          未使用
        </span>
      );
    }
    const days = Math.floor((Date.now() - new Date(account.token_refreshed_at).getTime()) / (1000 * 60 * 60 * 24));
    if (days > 80) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" title={`${days} 天未刷新`}>
          高风险
        </span>
      );
    }
    if (days > 60) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" title={`${days} 天未刷新`}>
          即将过期
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title={`${days} 天前刷新`}>
        正常
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
        加载中...
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
        <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
        <p className="text-sm">{showOwner ? '暂无游戏账号，导入账号或输入认领码后即可开始管理' : '暂无游戏账号，导入管理员提供的账号资料后即可开始管理'}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-border md:hidden">{sortedAccounts.map(account => <article key={account.id} className="space-y-4 p-4"><div className="flex items-center gap-3"><input type="checkbox" aria-label={`选择 ${account.game_account || account.email}`} className="h-5 w-5 accent-green-700" checked={selectedIds.includes(account.id)} onChange={() => toggleOne(account.id)} /><h3 className="min-w-0 flex-1 break-all font-semibold">{account.game_account || '待补充游戏账号'}</h3>{showOwner && <span className="rounded-full bg-secondary px-2 py-1 text-xs text-muted-foreground">{account.claim_status === 'available' ? '待认领' : '已归属'}</span>}</div><dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-sm">{([['game_account', '游戏账号'], ['game_password', '游戏密码'], ['real_name', 'name / 姓名'], ['id_last_six', '身份证后六位'], ['email', '绑定微软邮箱']] as const).map(([field, label]) => <div className="contents" key={field}><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all font-mono">{account[field] || '—'}</dd></div>)}{showOwner && <div className="contents"><dt className="text-muted-foreground">短链访问</dt><dd><ShortLinkAccess account={account} /></dd></div>}</dl>{showOwner && <p className="text-xs text-muted-foreground">归属：{account.owner_username || `用户 #${account.owner_user_id}`}</p>}<div className="flex flex-wrap gap-2"><button className="button-primary !text-xs" onClick={() => onVerificationCode(account)}><KeyRound size={15} />获取验证码</button><button className="button-secondary !text-xs" onClick={() => { navigator.clipboard.writeText([account.game_account, account.game_password, account.real_name, account.id_last_six, account.email].join('----')).then(() => toast.success('游戏登录信息已复制')).catch(() => toast.error('复制失败')); }}><Copy size={15} />复制信息</button><button className="button-secondary !text-xs" onClick={() => onShareLink(account)}><Link2 size={15} aria-hidden="true" />短链</button><button className="button-secondary !text-xs" onClick={() => onEdit(account)}>编辑</button><button className="button-secondary !text-xs text-red-600" onClick={() => onDelete(account.id)}>删除</button></div></article>)}</div>
      <div className="hidden overflow-x-auto md:block"><table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-700">
            <th className="w-10 py-3 px-3">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="选择当前页全部游戏账号" className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500" />
            </th>
            {isVisible('index') && (
              <th className="w-12 text-center py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400">#</th>
            )}
            {isVisible('game_account') && <SortHeader label="游戏账号" sortKey="game_account" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="min-w-40 whitespace-nowrap" />}
            {isVisible('game_password') && <th className="min-w-32 px-3 py-3 text-left font-medium text-muted-foreground">游戏密码</th>}
            {isVisible('real_name') && <th className="min-w-28 whitespace-nowrap px-3 py-3 text-left font-medium text-muted-foreground">name / 姓名</th>}
            {isVisible('id_last_six') && <th className="min-w-28 px-3 py-3 text-left font-medium text-muted-foreground">身份证后六位</th>}
            {isVisible('email') && (
              <SortHeader label="绑定微软邮箱" sortKey="email" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="min-w-56 whitespace-nowrap" />
            )}
            {showOwner && <th className="min-w-44 px-3 py-3 text-left font-medium text-muted-foreground">短链访问</th>}
            {isVisible('password') && (
              <th className="min-w-[160px] text-left py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400">邮箱密码</th>
            )}
            {isVisible('tags') && (
              <th className="min-w-[120px] text-left py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400">标签</th>
            )}
            {isVisible('client_id') && (
              <SortHeader label="客户端 ID" sortKey="client_id" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="min-w-[160px]" />
            )}
            {isVisible('refresh_token') && (
              <th className="min-w-[160px] text-left py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400">令牌</th>
            )}
            {isVisible('status') && (
              <SortHeader label="状态" sortKey="status" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="min-w-[70px]" />
            )}
            {isVisible('token_status') && (
              <SortHeader label="Token" sortKey="token_refreshed_at" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} className="min-w-[80px]" />
            )}
            {isVisible('actions') && (
              <th className="min-w-[240px] text-right py-3 px-3 font-medium text-zinc-500 dark:text-zinc-400">操作</th>
            )}
            {isVisible('claim_status') && <th className="min-w-24 px-3 py-3 text-left font-medium text-muted-foreground">认领状态</th>}
          </tr>
        </thead>
        <tbody>
          {sortedAccounts.map((account, index) => (
            <tr
              key={account.id}
              className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
              onContextMenu={e => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, account });
              }}
            >
              <td className="py-3 px-3">
                <input type="checkbox" checked={selectedIds.includes(account.id)} onChange={() => toggleOne(account.id)} aria-label={`选择 ${account.game_account || account.email}`} className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500" />
              </td>
              {isVisible('index') && (
                <td className="py-3 px-3 text-center text-zinc-400 text-xs">{index + 1}</td>
              )}
              {(['game_account', 'game_password', 'real_name', 'id_last_six'] as const).map(field => isVisible(field) && <CopyCell key={field} text={account[field] || ''}><span className="block max-w-52 break-all font-mono text-xs">{account[field] || '—'}</span></CopyCell>)}
              {isVisible('email') && (
                <CopyCell text={account.email}>
                  <div>
                    <span className="text-zinc-900 dark:text-zinc-100 font-medium">{account.email}</span>
                    {showOwner && <p className="mt-1 text-xs text-muted-foreground">归属：{account.owner_username || `用户 #${account.owner_user_id}`}</p>}
                    {account.remark && (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5 truncate max-w-[200px]">{account.remark}</p>
                    )}
                  </div>
                </CopyCell>
              )}
              {showOwner && <td className="px-3 py-3 align-middle"><ShortLinkAccess account={account} /></td>}
              {isVisible('password') && (
                <CredentialCell key={`password-${account.updated_at}-${account.owner_user_id}`} account={account} field="password" />
              )}
              {isVisible('tags') && (
                <td className="py-3 px-3">
                  <div className="flex flex-wrap gap-1 max-w-[200px]">
                    {(account.tags || []).map(tag => (
                      <span
                        key={tag.id}
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium border"
                        style={{
                          color: tag.color,
                          borderColor: tag.color,
                          backgroundColor: tag.color + '18'
                        }}
                      >
                        {tag.name}
                      </span>
                    ))}
                    {(!account.tags || account.tags.length === 0) && (
                      <span className="text-zinc-400 text-xs">—</span>
                    )}
                  </div>
                </td>
              )}
              {isVisible('client_id') && (
                <CopyCell text={account.client_id} className="font-mono text-xs">
                  <span className="text-zinc-600 dark:text-zinc-400 truncate block max-w-[240px]">{account.client_id}</span>
                </CopyCell>
              )}
              {isVisible('refresh_token') && (
                <CredentialCell key={`token-${account.updated_at}-${account.owner_user_id}`} account={account} field="refresh_token" />
              )}
              {isVisible('status') && (
                <td className="py-3 px-3 text-center">{statusBadge(account.status)}</td>
              )}
              {isVisible('token_status') && (
                <td className="py-3 px-3 text-center">{tokenStatusBadge(account)}</td>
              )}
              {isVisible('actions') && (
                <td className="py-3 px-3">
                  <div className="flex items-center justify-end gap-1">
                    <button className="button-primary shrink-0 whitespace-nowrap !min-h-10 !px-3 !text-xs" onClick={() => onVerificationCode(account)}><KeyRound size={15} />验证码</button>
                    <button className="button-secondary shrink-0 whitespace-nowrap !px-3 !text-xs" onClick={() => onShareLink(account)}><Link2 size={15} aria-hidden="true" />短链</button>
                    <button className="min-h-10 min-w-10 rounded-lg p-2 text-muted-foreground hover:bg-secondary" title="复制游戏账号、游戏密码、name、身份证后六位和邮箱" onClick={() => { navigator.clipboard.writeText([account.game_account, account.game_password, account.real_name, account.id_last_six, account.email].join('----')).then(() => toast.success('游戏登录信息已复制')).catch(() => toast.error('复制失败')); }}><Copy size={16} /></button>
                    <button onClick={() => onEdit(account)} title="编辑" className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                    <button onClick={() => onViewMail(account, 'INBOX')} title="查看邮件" className="p-1.5 rounded-lg text-zinc-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors">
                      <Mail className="w-4 h-4" />
                    </button>
                    <button onClick={() => onDelete(account.id)} title="删除" className="p-1.5 rounded-lg text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </td>
              )}
              {isVisible('claim_status') && <td className="px-3 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-xs ${account.claim_status === 'available' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-secondary text-muted-foreground'}`}>{account.claim_status === 'available' ? '待认领' : '已归属'}</span></td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          account={contextMenu.account}
          tags={tags.filter(tag => tag.owner_user_id === contextMenu.account.owner_user_id)}
          onClose={() => setContextMenu(null)}
          onCopyEmail={() => { navigator.clipboard.writeText(contextMenu.account.email); toast.success('邮箱已复制'); }}
          onCopyPassword={() => void copyCredential(contextMenu.account, 'password')}
          onCopyToken={() => void copyCredential(contextMenu.account, 'refresh_token')}
          onEdit={() => onEdit(contextMenu.account)}
          onToggleTag={(tagId) => onToggleTag(contextMenu.account.id, tagId)}
          onViewMail={(mailbox) => onViewMail(contextMenu.account, mailbox)}
          onDelete={() => onDelete(contextMenu.account.id)}
        />
      )}
    </div>
  );
}
