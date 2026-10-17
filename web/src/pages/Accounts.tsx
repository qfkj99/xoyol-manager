import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAccountStore } from '../stores/accounts';
import { useTagStore } from '../stores/tags';
import type { Account, ClaimCode, User } from '../types';
import { accountApi, userApi } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { Modal, FormError } from '../components/auth/FormControls';
import AccountToolbar from '../components/accounts/AccountToolbar';
import AccountTable, { getDefaultVisibleColumns, COLUMN_STORAGE_KEY } from '../components/accounts/AccountTable';
import EditAccountDialog from '../components/accounts/EditAccountDialog';
import ImportDialog from '../components/accounts/ImportDialog';
import PasteImportDialog from '../components/accounts/PasteImportDialog';
import { MailViewerDialog } from '../components/accounts/MailViewerDialog';
import BackupRestore from '../components/accounts/BackupRestore';
import VerificationCodeDialog from '../components/accounts/VerificationCodeDialog';
import ClaimCodeList from '../components/accounts/ClaimCodeList';
import ShareLinkDialog from '../components/accounts/ShareLinkDialog';
import { GAME_IMPORT_FORMAT } from '../lib/gameAccounts';
import { FileInput, KeyRound } from 'lucide-react';

export default function Accounts() {
  const user = useAuthStore(s => s.user);
  const [params, setParams] = useSearchParams();
  const {
    accounts, loading, error, selectedIds, searchQuery, pagination,
    fetchAccounts, createAccount, updateAccount, importAccounts,
    exportAccounts, setSelectedIds, setSearchQuery, setPage, setPageSize, ownerUserId, setOwnerUserId, claimStatus, setClaimStatus,
  } = useAccountStore();

  const { tags, fetchTags, createTag, deleteTag, setAccountTags } = useTagStore();

  const [editOpen, setEditOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [mailViewAccount, setMailViewAccount] = useState<Account | null>(null);
  const [mailViewMailbox, setMailViewMailbox] = useState<'INBOX' | 'Junk'>('INBOX');
  const [mailViewOpen, setMailViewOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(getDefaultVisibleColumns);
  const [users, setUsers] = useState<User[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [verificationAccount, setVerificationAccount] = useState<Account | null>(null);
  const [shareAccount, setShareAccount] = useState<Account | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [claimCodes, setClaimCodes] = useState<ClaimCode[]>([]);

  const handleColumnsChange = (cols: string[]) => {
    setVisibleColumns(cols);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(cols));
  };

  useEffect(() => { fetchAccounts().catch(e => toast.error(e.message)); fetchTags().catch(e => toast.error(e.message)); }, []);
  useEffect(() => {
    if (params.get('action') === 'add') { if (user?.role === 'admin') { setEditAccount(null); setEditOpen(true); } else setImportOpen(true); setParams({}, { replace: true }); }
    if (params.get('action') === 'import') { setImportOpen(true); setParams({}, { replace: true }); }
    if (params.get('action') === 'claim') { setClaimCode(''); setClaimError(''); setClaimOpen(true); setParams({}, { replace: true }); }
  }, [params, setParams, user?.role]);
  useEffect(() => {
    if (user?.role !== 'admin') return;
    let active = true;
    (async () => {
      const all: User[] = []; let page = 1; let total = 0;
      do { const data = await userApi.list({ page: page++, pageSize: 100 }); all.push(...data.list); total = data.total; if (!data.list.length) break; } while (all.length < total);
      if (active) setUsers(all);
    })().catch(e => toast.error(e.message));
    return () => { active = false; };
  }, [user?.role]);

  const handleEdit = async (account: Account) => {
    try { const detail = await accountApi.credentials(account.id); setEditAccount(detail); setEditOpen(true); }
    catch (error) { toast.error(error instanceof Error ? error.message : '加载账号凭据失败，无法编辑'); }
  };

  const handleSave = async (data: Partial<Account>) => {
    try {
      if (editAccount) {
        await updateAccount(editAccount.id, data);
        toast.success('游戏账号已更新');
      } else {
        await createAccount(data);
        toast.success('游戏账号已添加');
      }
    } catch (e: any) {
      toast.error(e.message || '操作失败');
      throw e;
    }
  };

  const confirmAccountRemoval = (target: string) => confirm(user?.role === 'admin'
    ? `确定永久删除${target}吗？\n\n游戏账号、绑定邮箱、邮件缓存和短链将一并删除，用户将无法再次导入被删除的账号。此操作无法撤销。`
    : `确定将${target}从“我的账号”列表移除并退回管理员库存吗？\n\n账号及邮箱资料、邮件缓存和有效短链将保留，可使用管理员提供的账号资料重新导入。`);

  const finishAccountRemoval = async (ids: number[], count: number, action: 'returned' | 'deleted') => {
    if (count > 0) {
      toast.success(action === 'returned'
        ? `已将 ${count} 个游戏账号从我的列表移除并退回管理员`
        : `已永久删除 ${count} 个游戏账号`, {
        description: action === 'returned'
          ? '账号及邮箱资料、邮件缓存和有效短链已保留，可使用管理员提供的资料重新导入。'
          : '绑定邮箱、邮件缓存和短链已一并删除，用户无法再次导入被删除的账号。',
        duration: 6000,
      });
    } else {
      toast.info('没有账号被移除，请刷新列表后重试。');
    }
    const removedIds = new Set(ids);
    setSelectedIds(useAccountStore.getState().selectedIds.filter(id => !removedIds.has(id)));
    await fetchAccounts().catch(() => toast.error('操作已完成，账号列表刷新失败，请重新加载。'));
  };

  const handleDelete = async (id: number) => {
    if (!confirmAccountRemoval('该游戏账号')) return;
    try {
      const result = await accountApi.delete(id);
      await finishAccountRemoval([id], Number(result.deleted), result.action);
    } catch (e: any) {
      toast.error(e.message || '删除失败');
    }
  };

  const handleDeleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length || !confirmAccountRemoval(`选中的 ${ids.length} 个游戏账号`)) return;
    try {
      const result = await accountApi.batchDelete(ids);
      await finishAccountRemoval(ids, result.deleted, result.action);
    } catch (e: any) {
      toast.error(e.message || '批量删除失败');
    }
  };

  const handleDeleteAll = async () => {
    const ids = accounts.map(account => account.id);
    if (!ids.length || !confirmAccountRemoval(`当前页全部 ${ids.length} 个游戏账号`)) return;
    try {
      const result = await accountApi.batchDelete(ids);
      await finishAccountRemoval(ids, result.deleted, result.action);
    } catch (e: any) {
      toast.error(e.message || '删除失败');
    }
  };


  const handleExport = async (ids?: number[]) => {
    try {
      const content = await exportAccounts({ ids, owner_user_id: ownerUserId, separator: '----', format: GAME_IMPORT_FORMAT });
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `accounts_${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('导出成功');
    } catch (e: any) {
      toast.error(e.message || '导出失败');
    }
  };

  const handleViewMail = (account: Account, mailbox: 'INBOX' | 'Junk') => {
    setMailViewAccount(account);
    setMailViewMailbox(mailbox);
    setMailViewOpen(true);
  };

  const handleToggleTag = async (accountId: number, tagId: number) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;
    const currentTagIds = (account.tags || []).map(t => t.id);
    const newTagIds = currentTagIds.includes(tagId)
      ? currentTagIds.filter(id => id !== tagId)
      : [...currentTagIds, tagId];
    try {
      await setAccountTags(accountId, newTagIds);
      await fetchAccounts();
    } catch (e: any) {
      toast.error(e.message || '标签操作失败');
    }
  };

  const handleCreateTag = async (name: string, color?: string) => {
    try {
      await createTag(name, color, editAccount?.owner_user_id);
    } catch (e: any) {
      toast.error(e.message || '创建标签失败');
    }
  };

  const handleDeleteTag = async (tagId: number) => {
    try {
      await deleteTag(tagId);
      await fetchAccounts();
    } catch (e: any) {
      toast.error(e.message || '删除标签失败');
    }
  };

  const totalPages = Math.ceil(pagination.total / pagination.pageSize);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">账号管理</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">共 {pagination.total} 个游戏账号 · 统一管理登录信息与绑定微软邮箱</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {user?.role === 'admin'
            ? <button className="button-secondary" onClick={() => { setClaimCode(''); setClaimError(''); setClaimOpen(true); }}><KeyRound size={16} aria-hidden="true" />认领账号</button>
            : <button className="button-primary" onClick={() => setImportOpen(true)}><FileInput size={16} aria-hidden="true" />导入账号</button>}
          {user?.role === 'admin' && <BackupRestore />}
          {user?.role === 'admin' && <button
            onClick={() => { setEditAccount(null); setEditOpen(true); }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新增游戏账号
          </button>}
        </div>
      </div>

      {user?.role === 'admin' && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"><label htmlFor="account-owner" className="text-sm font-medium">账号归属</label><select id="account-owner" className="form-input !w-auto max-w-full" value={ownerUserId ?? ''} onChange={e => setOwnerUserId(e.target.value ? Number(e.target.value) : undefined)}><option value="">全部用户</option>{users.filter(u => u.status !== 'deleted').map(u => <option key={u.id} value={u.id}>{u.display_name || u.username} ({u.username})</option>)}</select><div className="ml-auto flex flex-wrap gap-2"><button className="button-secondary" disabled={!selectedIds.length} onClick={() => { setClaimCodes([]); setPublishError(''); setPublishOpen(true); }}>生成认领码 ({selectedIds.length})</button><button className="button-secondary" disabled={!selectedIds.length} onClick={() => { setTargetId(''); setTransferError(''); setTransferOpen(true); }}>移交账号 ({selectedIds.length})</button></div></div>}

      {/* Toolbar */}
      {user?.role === 'admin' && <div className="flex flex-wrap items-center gap-2" aria-label="认领状态筛选">{([['all', '全部账号'], ['assigned', '已归属'], ['available', '待认领']] as const).map(([value, label]) => <button key={value} className={`min-h-10 rounded-lg px-4 text-sm ${claimStatus === value ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`} aria-pressed={claimStatus === value} onClick={() => setClaimStatus(value)}>{label}</button>)}</div>}
      <AccountToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCount={selectedIds.length}
        onFileImport={() => setImportOpen(true)}
        onPasteImport={() => setPasteOpen(true)}
        onExportSelected={() => handleExport(selectedIds)}
        onExportAll={() => handleExport()}
        onDeleteSelected={handleDeleteSelected}
        onDeleteAll={handleDeleteAll}
        visibleColumns={visibleColumns}
        onColumnsChange={handleColumnsChange}
        showClaimStatus={user?.role === 'admin'}
      />

      {/* Table */}
      {error && <div className="flex items-center justify-between gap-3"><FormError message={error} /><button className="button-secondary shrink-0" onClick={() => fetchAccounts().catch(() => {})}>重新加载</button></div>}
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <AccountTable
          accounts={accounts.map(account => ({ ...account, owner_username: account.owner_username || users.find(owner => owner.id === account.owner_user_id)?.username }))}
          selectedIds={selectedIds}
          onSelectIds={setSelectedIds}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onViewMail={handleViewMail}
          onVerificationCode={setVerificationAccount}
          onShareLink={setShareAccount}
          loading={loading}
          visibleColumns={visibleColumns}
          tags={tags}
          showOwner={user?.role === 'admin'}
          onToggleTag={handleToggleTag}
        />
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span>每页</span>
            <select
              value={pagination.pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
              className="px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {[10, 20, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>条</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              上一页
            </button>
            <span className="px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400">
              {pagination.page} / {totalPages}
            </span>
            <button
              onClick={() => setPage(pagination.page + 1)}
              disabled={pagination.page >= totalPages}
              className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <EditAccountDialog
        open={editOpen}
        account={editAccount}
        onClose={() => setEditOpen(false)}
        onSave={handleSave}
        tags={tags.filter(tag => tag.owner_user_id === (editAccount?.owner_user_id ?? user?.id))}
        accountTagIds={editAccount ? (accounts.find(account => account.id === editAccount.id)?.tags || editAccount.tags || []).map(t => t.id) : []}
        onTagToggle={editAccount ? (tagId) => handleToggleTag(editAccount.id, tagId) : undefined}
        onCreateTag={handleCreateTag}
        onDeleteTag={handleDeleteTag}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={() => fetchAccounts()} />
      <PasteImportDialog open={pasteOpen} onClose={() => setPasteOpen(false)} onImport={importAccounts} />
      {transferOpen && <Modal title="移交游戏账号" description={`将选中的 ${selectedIds.length} 个游戏账号、绑定邮箱及邮件缓存移交给接收用户；原标签关联将解除，原用户将失去访问权限。`} onClose={() => setTransferOpen(false)} busy={transferBusy}><form className="space-y-5" onSubmit={async e => { e.preventDefault(); setTransferBusy(true); setTransferError(''); try { await accountApi.transfer(selectedIds, Number(targetId)); setSelectedIds([]); setTransferOpen(false); await fetchAccounts(); toast.success('账号归属已移交'); } catch (err) { setTransferError(err instanceof Error ? err.message : '移交失败'); } finally { setTransferBusy(false); } }}><div className="space-y-2"><label htmlFor="account-transfer-target" className="form-label">接收用户</label><select id="account-transfer-target" className="form-input" value={targetId} onChange={e => setTargetId(e.target.value)} required disabled={transferBusy}><option value="">选择接收用户</option>{users.filter(u => u.status === 'active').map(u => <option key={u.id} value={u.id}>{u.display_name || u.username} ({u.username})</option>)}</select></div><FormError message={transferError} /><div className="flex justify-end gap-3"><button type="button" className="button-secondary" onClick={() => setTransferOpen(false)} disabled={transferBusy}>取消</button><button className="button-primary" disabled={transferBusy || !targetId}>{transferBusy ? '移交中…' : '确认移交'}</button></div></form></Modal>}
      {claimOpen && <Modal
        title={user?.role === 'admin' ? '认领游戏账号' : '导入账号'}
        description={user?.role === 'admin' ? '输入管理员提供的一次性认领码。认领成功后，可查看游戏登录信息并获取绑定邮箱验证码。' : '输入管理员提供的一次性导入码，即可管理游戏账号并获取绑定邮箱验证码。'}
        onClose={() => setClaimOpen(false)} busy={claimBusy}>
        <form className="space-y-5" onSubmit={async e => {
          e.preventDefault(); if (!claimCode.trim() || claimBusy) return;
          setClaimBusy(true); setClaimError('');
          try {
            const account = await accountApi.claim(claimCode.trim());
            setClaimOpen(false); setClaimCode(''); await fetchAccounts(); await fetchTags();
            toast.success(`已${user?.role === 'admin' ? '认领' : '导入'} ${account.game_account || '游戏账号'}`);
          } catch (err) { setClaimError(err instanceof Error ? err.message : '操作失败，请稍后重试'); }
          finally { setClaimBusy(false); }
        }}>
          <div className="space-y-2">
            <label htmlFor="claim-code" className="form-label">{user?.role === 'admin' ? '一次性认领码' : '一次性导入码'}</label>
            <input id="claim-code" className="form-input font-mono" value={claimCode} onChange={e => setClaimCode(e.target.value)} autoComplete="off" required disabled={claimBusy} placeholder={user?.role === 'admin' ? '粘贴管理员提供的认领码' : '粘贴管理员提供的导入码'} />
          </div>
          <FormError message={user?.role === 'admin' ? claimError : claimError.replace(/认领/g, '导入')} />
          <button className="button-primary w-full" disabled={claimBusy || !claimCode.trim()}>{claimBusy ? '处理中…' : user?.role === 'admin' ? '确认认领' : '确认导入'}</button>
        </form>
      </Modal>}
      {publishOpen && <Modal title={claimCodes.length ? '保存一次性认领码' : '发布账号认领'} description={claimCodes.length ? '请复制保存后再关闭此窗口。' : `为选中的 ${selectedIds.length} 个账号生成一次性认领码。重新生成会立即使旧码失效。尚未认领的账号仍由管理员管理。`} onClose={() => { setPublishOpen(false); setClaimCodes([]); }} busy={publishBusy}>{claimCodes.length ? <><ClaimCodeList codes={claimCodes} /><button className="button-secondary mt-5 w-full" onClick={() => { setPublishOpen(false); setClaimCodes([]); }}>已保存，完成</button></> : <div className="space-y-5"><FormError message={publishError} /><button className="button-primary w-full" disabled={publishBusy} onClick={async () => { setPublishBusy(true); setPublishError(''); try { const data = await accountApi.publishClaims(selectedIds); setClaimCodes(data.claim_codes); await fetchAccounts(); } catch (err) { setPublishError(err instanceof Error ? err.message : '生成认领码失败'); } finally { setPublishBusy(false); } }}>{publishBusy ? '生成中…' : '生成一次性认领码'}</button><button className="button-secondary w-full" disabled={publishBusy} onClick={async () => { setPublishBusy(true); setPublishError(''); try { await accountApi.revokeClaims(selectedIds); setPublishOpen(false); await fetchAccounts(); toast.success('已撤销尚未使用的认领码'); } catch (err) { setPublishError(err instanceof Error ? err.message : '撤销失败'); } finally { setPublishBusy(false); } }}>撤销选中账号尚未使用的认领码</button><p className="text-xs leading-6 text-muted-foreground">撤销只取消待认领资格；已被用户认领的账号需要使用“移交账号”调整归属。</p></div>}</Modal>}
      {verificationAccount && <VerificationCodeDialog account={verificationAccount} onClose={() => setVerificationAccount(null)} onViewMail={mailbox => { handleViewMail(verificationAccount, mailbox); setVerificationAccount(null); }} />}
      {shareAccount && <ShareLinkDialog key={shareAccount.id} account={shareAccount} onClose={() => setShareAccount(null)} />}
      {mailViewAccount && (
        <MailViewerDialog
          open={mailViewOpen}
          accountId={mailViewAccount.id}
          accountEmail={mailViewAccount.email}
          initialMailbox={mailViewMailbox}
          onClose={() => setMailViewOpen(false)}
        />
      )}
    </div>
  );
}
