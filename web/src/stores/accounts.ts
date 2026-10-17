import { create } from 'zustand';
import type { Account, PaginatedResponse, ImportRequest, ImportResult, ExportRequest } from '../types';
import { accountApi, getSessionGeneration } from '../lib/api';

let accountRequestSequence = 0;
interface AccountStore {
  accounts: Account[];
  loading: boolean;
  error: string;
  selectedIds: number[];
  searchQuery: string;
  ownerUserId: number | undefined;
  claimStatus: 'all' | 'assigned' | 'available';
  pagination: { page: number; pageSize: number; total: number };
  fetchAccounts: () => Promise<void>;
  refreshAccountsSilent: () => Promise<void>;
  createAccount: (data: Partial<Account>) => Promise<void>;
  updateAccount: (id: number, data: Partial<Account>) => Promise<void>;
  deleteAccount: (id: number) => Promise<void>;
  batchDelete: (ids: number[]) => Promise<void>;
  importAccounts: (req: ImportRequest) => Promise<ImportResult>;
  exportAccounts: (req: ExportRequest) => Promise<string>;
  setSelectedIds: (ids: number[]) => void;
  setSearchQuery: (q: string) => void;
  setOwnerUserId: (id: number | undefined) => void;
  setClaimStatus: (status: 'all' | 'assigned' | 'available') => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  accounts: [],
  loading: false,
  error: '',
  selectedIds: [],
  searchQuery: '',
  ownerUserId: undefined,
  claimStatus: 'all',
  pagination: { page: 1, pageSize: 20, total: 0 },

  fetchAccounts: async () => {
    const generation = getSessionGeneration();
    const sequence = ++accountRequestSequence;
    set({ loading: true, error: '' });
    try {
      const { page, pageSize } = get().pagination;
      const data = await accountApi.list({ page, pageSize, search: get().searchQuery, owner_user_id: get().ownerUserId, claim_status: get().claimStatus === 'all' ? undefined : get().claimStatus as 'assigned' | 'available' });
      if (generation === getSessionGeneration() && sequence === accountRequestSequence) set({ accounts: data.list, pagination: { page: data.page, pageSize: data.pageSize, total: data.total } });
    } catch (error) {
      if (generation === getSessionGeneration() && sequence === accountRequestSequence) set(state => ({ accounts: [], selectedIds: [], pagination: { ...state.pagination, total: 0 }, error: error instanceof Error ? error.message : '加载游戏账号失败' }));
      throw error;
    } finally {
      if (generation === getSessionGeneration() && sequence === accountRequestSequence) set({ loading: false });
    }
  },

  refreshAccountsSilent: async () => {
    const generation = getSessionGeneration();
    const sequence = accountRequestSequence;
    try {
      const { page, pageSize } = get().pagination;
      const data = await accountApi.list({ page, pageSize, search: get().searchQuery, owner_user_id: get().ownerUserId, claim_status: get().claimStatus === 'all' ? undefined : get().claimStatus as 'assigned' | 'available' });
      if (generation !== getSessionGeneration() || sequence !== accountRequestSequence) return;
      set(state => ({
        accounts: data.list,
        selectedIds: state.selectedIds.filter(id => data.list.some(account => account.id === id)),
        pagination: { page: data.page, pageSize: data.pageSize, total: data.total },
      }));
    } catch {
      // 静默失败，不影响用户操作
    }
  },

  createAccount: async (data) => {
    await accountApi.create(data);
    await get().fetchAccounts();
  },

  updateAccount: async (id, data) => {
    await accountApi.update(id, data);
    await get().fetchAccounts();
  },

  deleteAccount: async (id) => {
    await accountApi.delete(id);
    await get().fetchAccounts();
  },

  batchDelete: async (ids) => {
    await accountApi.batchDelete(ids);
    set({ selectedIds: [] });
    await get().fetchAccounts();
  },

  importAccounts: async (req) => {
    const result = await accountApi.import(req);
    await get().fetchAccounts().catch(() => {});
    return result;
  },

  exportAccounts: async (req) => {
    const result = await accountApi.export(req);
    return result.content;
  },

  setSelectedIds: (ids) => set({ selectedIds: ids }),
  setSearchQuery: (q) => { set(s => ({ searchQuery: q, selectedIds: [], pagination: { ...s.pagination, page: 1 } })); get().fetchAccounts().catch(() => {}); },
  setOwnerUserId: (id) => { set(s => ({ ownerUserId: id, selectedIds: [], pagination: { ...s.pagination, page: 1 } })); get().fetchAccounts().catch(() => {}); },
  setClaimStatus: (claimStatus) => { set(s => ({ claimStatus, selectedIds: [], pagination: { ...s.pagination, page: 1 } })); get().fetchAccounts().catch(() => {}); },
  setPage: (page) => { set(s => ({ selectedIds: [], pagination: { ...s.pagination, page } })); get().fetchAccounts().catch(() => {}); },
  setPageSize: (size) => { set(s => ({ selectedIds: [], pagination: { ...s.pagination, pageSize: size, page: 1 } })); get().fetchAccounts().catch(() => {}); },
}));
