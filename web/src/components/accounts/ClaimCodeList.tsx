import { Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import type { ClaimCode } from '../../types';

export default function ClaimCodeList({ codes }: { codes: ClaimCode[] }) {
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); toast.success('已复制认领码'); }
    catch { toast.error('复制失败，请手动选择认领码'); }
  };
  return <section className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4">
    <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound size={17} />保存一次性认领码</h3>
    <p className="text-xs leading-6 text-muted-foreground">将此码及<a href="/accounts?action=claim" className="text-primary underline underline-offset-2">账号导入码入口</a>交给接收用户。对方登录后输入一次性码，即可导入游戏账号和绑定邮箱。每个码只能使用一次，请现在复制保存。</p>
    <div className="max-h-60 space-y-2 overflow-y-auto">{codes.map(item => <div key={item.account_id} className="rounded-md bg-background p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><span className="min-w-24 flex-1 break-all font-medium">{item.game_account || `账号 #${item.account_id}`}</span><code className="break-all text-primary">{item.code}</code><button type="button" className="button-secondary !min-h-9 !px-2" aria-label={`复制 ${item.game_account} 的认领码`} onClick={() => void copy(item.code)}><Copy size={15} /></button></div><p className="mt-1 text-xs text-muted-foreground">有效期至：{new Date(item.expires_at).toLocaleString()}</p></div>)}</div>
    <button type="button" className="button-secondary w-full" onClick={() => void copy(codes.map(item => `${item.game_account}----${item.code}`).join('\n'))}><Copy size={15} />复制全部账号与认领码</button>
  </section>;
}
