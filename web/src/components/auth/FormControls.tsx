import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';

export function PasswordField({ label, id, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: string }) {
  const [visible, setVisible] = useState(false);
  return <div className="space-y-2">
    <label className="form-label" htmlFor={id}>{label}</label>
    <div className="relative">
      <input {...props} id={id} type={visible ? 'text' : 'password'} className="form-input pr-12" aria-describedby={hint ? `${id}-hint` : undefined} />
      <button type="button" className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-muted-foreground hover:text-foreground" aria-label={visible ? `隐藏${label}` : `显示${label}`} aria-pressed={visible} onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </div>
    {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
  </div>;
}

export function FormError({ message }: { message: string }) {
  return message ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{message}</p> : null;
}

export function Modal({ title, description, children, onClose, busy = false }: { title: string; description: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="pr-8 text-xl font-semibold">{title}</Dialog.Title>
        <Dialog.Description className="mb-6 mt-2 text-sm leading-relaxed text-muted-foreground">{description}</Dialog.Description>
        <Dialog.Close disabled={busy} className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-md hover:bg-secondary" aria-label="关闭"><X size={18} /></Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function Pagination({ page, total, pageSize, onPage, disabled = false }: { page: number; total: number; pageSize: number; onPage: (page: number) => void; disabled?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
    <p>共 {total} 条 · 第 {page} / {pages} 页</p>
    <div className="flex gap-2"><button className="button-secondary" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>上一页</button><button className="button-secondary" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>下一页</button></div>
  </div>;
}
