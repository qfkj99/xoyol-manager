import { create } from 'zustand';
import type { MailMessage, FetchMailsResult } from '../types';
import { mailApi, getSessionGeneration } from '../lib/api';
import { useAccountStore } from './accounts';

interface MailStore {
  currentAccountId: number | null;
  currentMailbox: 'INBOX' | 'Junk';
  mails: MailMessage[];
  selectedMail: MailMessage | null;
  loading: boolean;
  fetchResult: FetchMailsResult | null;
  setCurrentAccount: (id: number) => void;
  setMailbox: (box: 'INBOX' | 'Junk') => void;
  fetchMails: (accountId: number, mailbox: string, proxyId?: number) => Promise<void>;
  fetchCachedMails: (accountId: number, mailbox: string) => Promise<void>;
  clearMailbox: (accountId: number, mailbox: string, proxyId?: number) => Promise<void>;
  selectMail: (mail: MailMessage | null) => void;
}

let mailRequestSequence = 0;
export const useMailStore = create<MailStore>((set, get) => ({
  currentAccountId: null,
  currentMailbox: 'INBOX',
  mails: [],
  selectedMail: null,
  loading: false,
  fetchResult: null,

  setCurrentAccount: (id) => { mailRequestSequence++; set({ currentAccountId: id, mails: [], selectedMail: null, loading: false }); },
  setMailbox: (box) => { mailRequestSequence++; set({ currentMailbox: box, mails: [], selectedMail: null, loading: false }); },

  fetchMails: async (accountId, mailbox, proxyId) => {
    const generation = getSessionGeneration(); const sequence = ++mailRequestSequence;
    set({ loading: true });
    try {
      const result = await mailApi.fetch({ account_id: accountId, mailbox, proxy_id: proxyId });
      if (generation !== getSessionGeneration() || sequence !== mailRequestSequence) return;
      set({ mails: result.mails, fetchResult: result });
      // 无感刷新账户状态
      useAccountStore.getState().refreshAccountsSilent();
    } finally {
      if (generation === getSessionGeneration() && sequence === mailRequestSequence) set({ loading: false });
    }
  },

  fetchCachedMails: async (accountId, mailbox) => {
    const generation = getSessionGeneration(); const sequence = ++mailRequestSequence;
    set({ loading: true });
    try {
      const data = await mailApi.cached({ account_id: accountId, mailbox, pageSize: 100 });
      if (generation !== getSessionGeneration() || sequence !== mailRequestSequence) return;
      set({ mails: data.list });
    } finally {
      if (generation === getSessionGeneration() && sequence === mailRequestSequence) set({ loading: false });
    }
  },

  clearMailbox: async (accountId, mailbox, proxyId) => {
    await mailApi.clear({ account_id: accountId, mailbox, proxy_id: proxyId });
    if (get().currentAccountId === accountId && get().currentMailbox === mailbox) set({ mails: [], selectedMail: null });
    useAccountStore.getState().refreshAccountsSilent();
  },

  selectMail: (mail) => set({ selectedMail: mail }),
}));
