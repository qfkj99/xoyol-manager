import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Globe, Gamepad2, X, Settings, UserRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: '工作台', admin: false },
  { to: '/accounts', icon: Gamepad2, label: '账号管理', admin: false },
  { to: '/proxy', icon: Globe, label: '代理设置', admin: true },
  { to: '/profile', icon: UserRound, label: '个人中心', admin: false },
  { to: '/users', icon: Users, label: '用户管理', admin: true },
  { to: '/settings', icon: Settings, label: '系统设置', admin: true },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppSidebar({ open, onClose }: Props) {
  const user = useAuthStore(s => s.user);
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} />
      )}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 w-60 flex-col border-r border-border bg-card transition-transform duration-200 md:static md:translate-x-0 md:flex",
        open ? "flex translate-x-0" : "hidden -translate-x-full md:flex md:translate-x-0"
      )}>
        <div className="flex h-14 items-center justify-between px-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Gamepad2 className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-foreground">小师妹账号管理平台</span>
          </div>
          <button onClick={onClose} aria-label="关闭导航菜单" className="md:hidden flex h-11 w-11 items-center justify-center rounded-md hover:bg-secondary transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {navItems.filter(item => (!item.admin || user?.role === 'admin') && (!user?.must_change_password || item.to === '/profile')).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border">
          <p className="text-xs text-muted-foreground text-center">v1.0.0</p>
        </div>
      </aside>
    </>
  );
}
