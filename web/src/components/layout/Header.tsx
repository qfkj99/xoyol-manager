import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Moon, Sun, Monitor, Menu, ChevronDown, LogOut, UserRound } from 'lucide-react';
import { useThemeStore } from '../../stores/theme';
import { useAuthStore } from '../../stores/auth';
import { toast } from 'sonner';

interface Props {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: Props) {
  const { theme, setTheme } = useThemeStore();
  const { user, signOut } = useAuthStore();
  const [leaving, setLeaving] = useState(false);
  const navigate = useNavigate();
  const logout = async () => {
    setLeaving(true);
    try { await signOut(); navigate('/', { replace: true }); }
    catch (error) { toast.error(error instanceof Error ? error.message : '退出失败，请重试'); }
    finally { setLeaving(false); }
  };

  const cycleTheme = () => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(next);
  };

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 md:px-6">
      <button onClick={onMenuClick} aria-label="打开导航菜单" className="md:hidden flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-secondary transition-colors">
        <Menu className="h-4 w-4 text-muted-foreground" />
      </button>
      <div className="hidden md:block" />
      <div className="ml-auto flex items-center gap-3"><button
        onClick={cycleTheme}
        className="flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-secondary transition-colors"
        aria-label="切换明暗主题"
        title={`当前: ${theme === 'dark' ? '暗色' : theme === 'light' ? '亮色' : '跟随系统'}`}
      >
        <ThemeIcon className="h-4 w-4 text-muted-foreground" />
      </button>
      <DropdownMenu.Root><DropdownMenu.Trigger className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-secondary" aria-label="打开个人菜单"><UserRound size={17} aria-hidden="true" /><span className="max-w-28 truncate sm:max-w-48">{user?.display_name || user?.username}</span><ChevronDown size={15} aria-hidden="true" /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={8} className="z-50 min-w-52 rounded-md border border-border bg-card p-1.5 shadow-lg"><DropdownMenu.Label className="px-3 py-2 text-xs text-muted-foreground">{user?.username} · {user?.role === 'admin' ? '管理员' : '普通用户'}</DropdownMenu.Label><DropdownMenu.Item asChild><Link to="/profile" className="flex min-h-11 items-center gap-2 rounded-sm px-3 text-sm outline-none data-[highlighted]:bg-secondary"><UserRound size={16} aria-hidden="true" />个人中心</Link></DropdownMenu.Item><DropdownMenu.Separator className="my-1 border-t border-border" /><DropdownMenu.Item disabled={leaving} onSelect={() => void logout()} className="flex min-h-11 items-center gap-2 rounded-sm px-3 text-sm text-red-600 outline-none data-[highlighted]:bg-secondary dark:text-red-400"><LogOut size={16} aria-hidden="true" />{leaving ? '正在退出…' : '退出登录'}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
    </header>
  );
}
