import { create } from 'zustand';
import { ApiError, authApi, resetSession, setCsrfToken } from '../lib/api';
import type { AuthConfig, AuthSession, User } from '../types';

interface AuthStore {
  user: User | null;
  config: AuthConfig | null;
  checking: boolean;
  error: string;
  initialize: () => Promise<void>;
  refreshConfig: () => Promise<AuthConfig>;
  acceptSession: (session: AuthSession) => void;
  signOut: () => Promise<void>;
}

let initialization: Promise<void> | null = null;
export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null, config: null, checking: true, error: '',
  refreshConfig: async () => {
    const config = await authApi.config();
    setCsrfToken(config.csrfToken);
    set({ config });
    return config;
  },
  initialize: () => {
    if (initialization) return initialization;
    initialization = (async () => {
      set({ checking: true, error: '' });
      localStorage.removeItem('auth_token');
      try {
        const config = await get().refreshConfig();
        if (!config.initialized) return;
        try {
          const session = await authApi.me();
          setCsrfToken(session.csrfToken);
          set({ user: session.user });
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
          set({ user: null });
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : '无法连接服务，请重试' });
      } finally { set({ checking: false }); initialization = null; }
    })();
    return initialization;
  },
  acceptSession: (session) => {
    resetSession();
    setCsrfToken(session.csrfToken);
    set({ user: session.user, error: '' });
    localStorage.setItem('session-change', `${Date.now()}`);
  },
  signOut: async () => {
    await authApi.logout();
    resetSession();
    localStorage.setItem('session-change', `${Date.now()}`);
  },
}));

window.addEventListener('session-reset', () => useAuthStore.setState({ user: null }));
window.addEventListener('password-change-required', () => {
  const user = useAuthStore.getState().user;
  if (user) useAuthStore.setState({ user: { ...user, must_change_password: true } });
});
window.addEventListener('storage', (event) => {
  if (event.key === 'session-change') {
    resetSession();
    void useAuthStore.getState().initialize();
  }
});
