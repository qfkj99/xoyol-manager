import { useEffect } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { useMailStore } from '../../stores/mails';
import { MailList } from '../mail/MailList';
import { MailContent } from '../mail/MailContent';

interface MailViewerDialogProps {
  open: boolean;
  accountId: number;
  accountEmail: string;
  initialMailbox: 'INBOX' | 'Junk';
  onClose: () => void;
}

export function MailViewerDialog({
  open,
  accountId,
  accountEmail,
  initialMailbox,
  onClose,
}: MailViewerDialogProps) {
  const { setCurrentAccount, setMailbox, fetchCachedMails, selectedMail, selectMail } = useMailStore();

  useEffect(() => {
    if (open) {
      setCurrentAccount(accountId);
      setMailbox(initialMailbox);
      fetchCachedMails(accountId, initialMailbox).catch(error => toast.error(error instanceof Error ? error.message : '加载邮件失败'));
    }
  }, [open, accountId, initialMailbox, setCurrentAccount, setMailbox, fetchCachedMails]);

  if (!open) return null;

  return (
    <Dialog.Root open onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[85dvh] w-[calc(100%_-_1rem)] max-w-5xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <Dialog.Title className="text-lg font-semibold text-foreground">绑定邮箱邮件</Dialog.Title>
            <Dialog.Description className="break-all text-sm text-muted-foreground">{accountEmail}</Dialog.Description>
          </div>
          <button
            onClick={onClose}
            className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">关闭</span>
          </button>
        </div>

        {/* Content: Two-column layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Mail list */}
          <div className={`${selectedMail ? 'hidden md:block' : 'block'} w-full shrink-0 overflow-hidden border-r border-border bg-card md:w-[320px]`}>
            <MailList accountId={accountId} />
          </div>

          {/* Right: Mail content */}
          <div className={`${selectedMail ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col overflow-hidden bg-background`}>
            <button className="flex min-h-11 items-center gap-2 border-b border-border px-4 text-sm text-muted-foreground md:hidden" onClick={() => selectMail(null)}><ArrowLeft size={16} />返回邮件列表</button>
            <div className="min-h-0 flex-1"><MailContent mail={selectedMail} /></div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  );
}
