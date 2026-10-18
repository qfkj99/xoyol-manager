import logo from '../assets/logo.webp';
import { cn } from '../lib/utils';

export function BrandLogo({ className, alt = '小师妹账号管理平台' }: { className?: string; alt?: string }) {
  return <img src={logo} alt={alt} width={40} height={40} decoding="async" className={cn('h-10 w-10 shrink-0 rounded-xl object-cover', className)} />;
}
