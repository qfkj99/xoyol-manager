import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppLayout } from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Accounts from './pages/Accounts';
import ProxySettings from './pages/ProxySettings';
import AuthPage from './pages/AuthPage';
import Profile from './pages/Profile';
import Users from './pages/Users';
import Settings from './pages/Settings';
import ApiDocs from './pages/ApiDocs';
import SharedAccount from './pages/SharedAccount';
import { useAuthStore } from './stores/auth';
import { FormError } from './components/auth/FormControls';
import { useAccountStore } from './stores/accounts';
import { useMailStore } from './stores/mails';
import { useProxyStore } from './stores/proxy';
import { useTagStore } from './stores/tags';

window.addEventListener('session-reset', () => {
  useAccountStore.setState({ accounts: [], loading: false, error: '', selectedIds: [], searchQuery: '', ownerUserId: undefined, claimStatus: 'all', pagination: { page: 1, pageSize: 20, total: 0 } });
  useMailStore.setState({ currentAccountId: null, currentMailbox: 'INBOX', mails: [], selectedMail: null, loading: false, fetchResult: null });
  useProxyStore.setState({ proxies: [], loading: false, testResult: null });
  useTagStore.setState({ tags: [] });
});

function ProtectedRoute({ admin = false }: { admin?: boolean }) {
  const user = useAuthStore(s => s.user);
  const location = useLocation();
  if (!user) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (user.must_change_password && location.pathname !== '/profile') return <Navigate to="/profile" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

function AppRoutes() {
  const user = useAuthStore(s => s.user);
  return <Routes>
    <Route path="/" element={<AuthPage />} />
    <Route path="/login" element={<AuthPage />} />
    <Route path="/register" element={<AuthPage register />} />
    <Route element={<ProtectedRoute />}>
      <Route element={<AppLayout key={user?.id} />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/profile" element={<Profile />} />
        <Route element={<ProtectedRoute admin />}>
          <Route path="/proxy" element={<ProxySettings />} />
          <Route path="/users" element={<Users />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/docs/api" element={<ApiDocs />} />
        </Route>
      </Route>
    </Route>
    <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
  </Routes>;
}

function PlatformApp() {
  const { checking, error, initialize } = useAuthStore();
  useEffect(() => { void initialize(); }, [initialize]);
  if (checking) return <div className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground" role="status">正在连接工作台…</div>;
  if (error) return <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-5"><h1 className="text-2xl font-semibold">暂时无法连接</h1><FormError message={error} /><button className="button-primary" onClick={() => void initialize()}>重新连接</button></div>;
  return <AppRoutes />;
}

export default function App() {
  return <BrowserRouter><Toaster position="top-right" richColors closeButton /><Routes><Route path="/s/:token" element={<SharedAccount />} /><Route path="*" element={<PlatformApp />} /></Routes></BrowserRouter>;
}
