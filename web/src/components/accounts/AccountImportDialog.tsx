import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FileInput, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ImportPreviewResult, ImportRequest, ImportResult, ShareExport } from '../../types';
import { accountApi } from '../../lib/api';
import { GAME_CLAIM_FORMAT, GAME_CLAIM_HINT, GAME_FIELD_LABELS, GAME_IMPORT_FORMAT, GAME_IMPORT_HINT } from '../../lib/gameAccounts';
import { useAuthStore } from '../../stores/auth';
import { Modal } from '../auth/FormControls';
import ClaimCodeList from './ClaimCodeList';

function exportContent(items: ShareExport[]) {
  return items.map(item => [item.game_account, item.game_password, item.real_name, item.id_last_six, new URL(item.path, window.location.origin).href].join('----')).join('\r\n');
}

function download(content: string) {
  const address = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/plain;charset=utf-8' }));
  const element = document.createElement('a');
  element.href = address;
  element.download = `游戏账号短链-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.append(element); element.click(); element.remove();
  window.setTimeout(() => URL.revokeObjectURL(address), 1000);
}

export default function AccountImportDialog({ source, onClose, onImport, onImported }: {
  source: 'file' | 'paste'; onClose: () => void;
  onImport: (request: ImportRequest) => Promise<ImportResult>;
  onImported?: () => void | Promise<void>;
}) {
  const admin = useAuthStore(state => state.user?.role === 'admin');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [separator, setSeparator] = useState('----');
  const [format, setFormat] = useState<string[]>(() => admin ? [...GAME_IMPORT_FORMAT] : [...GAME_CLAIM_FORMAT]);
  const [placement, setPlacement] = useState<'owned' | 'pool'>('owned');
  const [generateLinks, setGenerateLinks] = useState(false);
  const [mode, setMode] = useState<'skip' | 'overwrite'>('skip');
  const [step, setStep] = useState<'input' | 'preview' | 'result'>('input');
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  useEffect(() => () => readerRef.current?.abort(), []);
  useEffect(() => { if (errors.length) errorRef.current?.focus(); }, [errors]);
  const id = source === 'file' ? 'file-import' : 'paste-import';
  const hint = format.includes('share_link') ? GAME_CLAIM_HINT : GAME_IMPORT_HINT;
  const exported = result?.share_exports?.length ? exportContent(result.share_exports) : '';
  const request = (): ImportRequest => ({ content, separator, format, ...(admin ? { placement, generate_share_links: generateLinks } : {}) });
  const summary = result ? `成功导入 ${result.imported} 个游戏账号，跳过 ${result.skipped} 个重复账号` : '';

  const readFile = (file?: File) => {
    if (!file) return;
    readerRef.current?.abort();
    const reader = new FileReader(); readerRef.current = reader;
    setReading(true); setErrors([]); setContent(''); setFileName(file.name);
    reader.onload = () => { setContent(String(reader.result || '')); setReading(false); };
    reader.onerror = () => { setErrors(['文件读取失败，请重新选择文本文件。']); setReading(false); };
    reader.readAsText(file);
  };
  const submit = async (previewOnly = false) => {
    if (busy || reading || !content.trim()) return;
    if (!separator) { setErrors(['请填写与内容一致的分隔符。']); return; }
    setBusy(true); setErrors([]);
    try {
      if (previewOnly) {
        setPreview(await accountApi.importPreview(request())); setStep('preview');
      } else {
        const response = source === 'file'
          ? await accountApi.importConfirm({ ...request(), ...(admin ? { mode } : { mode: 'skip' as const }) })
          : await onImport(request());
        setResult(response); setStep('result');
        if (response.share_exports?.length) {
          try { download(exportContent(response.share_exports)); }
          catch { toast.error('自动下载未完成，可点击“下载短链账号”重新下载。'); }
        }
        if (source === 'file') {
          try { await onImported?.(); }
          catch { toast.error('操作已完成，账号列表刷新失败，请稍后重新加载。'); }
        }
      }
    } catch (error) { setErrors([error instanceof Error ? error.message : '操作失败，请稍后重试。']); }
    finally { setBusy(false); }
  };

  return <Modal title={step === 'result' ? '导入结果' : step === 'preview' ? (admin ? '游戏账号导入预览' : '账号导入预览') : admin ? (source === 'file' ? '导入游戏账号文件' : '粘贴导入游戏账号') : '导入账号'}
    description={admin ? '导入游戏账号和绑定邮箱，可同时生成短链并导出交付文件。' : '导入管理员提供的账号资料，即可管理账号并获取邮箱验证码；仅支持管理员已录入且未分配给其他用户的账号。'} onClose={onClose} busy={busy}>
    {errors.length > 0 && <div ref={errorRef} tabIndex={-1} role="alert" className="mb-5 rounded-md bg-red-50 p-3 text-sm leading-7 text-red-700 dark:bg-red-950 dark:text-red-200">{errors.map((message, index) => <p key={index}>{message}</p>)}</div>}
    {step === 'input' ? <fieldset disabled={busy} className="min-w-0 space-y-5">
      {source === 'file' ? <div className="space-y-2"><label htmlFor={`${id}-file`} className="form-label">选择账号文件</label><input id={`${id}-file`} type="file" accept=".txt,.csv" className="form-input text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-foreground" onChange={event => readFile(event.target.files?.[0])} />{fileName && <p className="break-all text-xs text-muted-foreground">{reading ? '正在读取：' : '已选择：'}{fileName}</p>}</div> : <div className="space-y-2"><label htmlFor={`${id}-content`} className="form-label">粘贴内容</label><textarea id={`${id}-content`} aria-describedby={`${id}-hint`} className="form-input min-h-40 resize-y font-mono text-sm" rows={7} value={content} onChange={event => setContent(event.target.value)} placeholder={hint} /></div>}
      {!admin && <div className="space-y-2"><label htmlFor={`${id}-claim-format`} className="form-label">账号资料格式</label><select id={`${id}-claim-format`} className="form-input" value={format.includes('share_link') ? 'short-link' : 'full'} onChange={event => setFormat(event.target.value === 'short-link' ? [...GAME_CLAIM_FORMAT] : [...GAME_IMPORT_FORMAT])}><option value="short-link">五项资料（含短链）</option><option value="full">完整八项资料（含邮箱授权）</option></select></div>}
      <p id={`${id}-hint`} className="break-all text-xs leading-6 text-muted-foreground">每行一个账号，无需表头：{hint}</p>
      <div className="space-y-2"><label htmlFor={`${id}-separator`} className="form-label">分隔符</label><input id={`${id}-separator`} className="form-input" value={separator} onChange={event => setSeparator(event.target.value)} /></div>
      {admin && <>
        <div className="space-y-2"><p className="form-label">字段顺序</p>{format.map((field, index) => <div key={index} className="flex min-w-0 items-center gap-2"><span className="w-5 text-xs text-muted-foreground">{index + 1}.</span><select aria-label={`第 ${index + 1} 个字段`} className="form-input min-w-0 flex-1" value={field} onChange={event => setFormat(previous => previous.map((value, i) => i === index ? event.target.value : value))}><option value="">选择字段</option>{GAME_IMPORT_FORMAT.map(value => <option key={value} value={value}>{GAME_FIELD_LABELS[value]}</option>)}</select><button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary" aria-label={`移除第 ${index + 1} 个字段`} onClick={() => setFormat(previous => previous.filter((_, i) => i !== index))}>×</button></div>)}<button type="button" className="button-secondary text-sm" onClick={() => setFormat(previous => [...previous, ''])}>添加字段</button></div>
        <div className="space-y-2"><label htmlFor={`${id}-placement`} className="form-label">导入后归属</label><select id={`${id}-placement`} className="form-input" value={placement} onChange={event => setPlacement(event.target.value as typeof placement)}><option value="owned">归属我的账号（可由用户导入认领）</option><option value="pool">放入认领池并生成一次性认领码</option></select></div>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-secondary p-3 text-sm leading-7"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-green-600" checked={generateLinks} onChange={event => setGenerateLinks(event.target.checked)} /><span><span className="flex items-center gap-2 font-medium"><Link2 size={16} aria-hidden="true" />同时生成短链并导出</span><span className="mt-1 block text-xs leading-6 text-muted-foreground">为本次成功导入的账号生成长期短链，自动下载五项资料，每行一个账号。持有链接可查看完整资料并取码。</span></span></label>
      </>}
      {content && <div className="space-y-2"><p className="form-label">内容预览（前5行）</p><pre className="max-h-32 overflow-auto rounded-md bg-secondary p-3 text-xs leading-6">{content.split('\n').filter(Boolean).slice(0, 5).join('\n')}</pre></div>}
    </fieldset> : step === 'preview' && preview ? <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3 text-center">{[[preview.newItems.length, admin ? '可新增' : '可导入'], [preview.duplicates.length, '已存在'], [preview.errors.length, '错误行']].map(([count, label]) => <div key={label} className="rounded-md bg-secondary p-3"><p className="text-xl font-semibold">{count}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div>)}</div>
      {admin && preview.duplicates.length > 0 && <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">重复项处理方式</legend><label className="mr-4 inline-flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} checked={mode === 'skip'} onChange={() => setMode('skip')} />跳过重复项</label><label className="inline-flex items-center gap-2 text-sm"><input type="radio" name={`${id}-mode`} checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />覆盖更新</label></fieldset>}
      {preview.newItems.length > 0 && <div className="max-h-32 space-y-1 overflow-auto rounded-md border border-border p-3 text-xs leading-6">{preview.newItems.map(item => <p key={item.line}>第 {item.line} 行：{item.game_account || item.email}</p>)}</div>}
      {preview.duplicates.length > 0 && <p className="text-sm leading-7 text-muted-foreground">{admin ? '重复账号将按所选方式处理。' : '已在自己名下的账号将跳过，不会覆盖原资料。'}</p>}
      {preview.errors.length > 0 && <div role="alert" className="max-h-36 overflow-auto rounded-md bg-red-50 p-3 text-sm leading-7 text-red-700 dark:bg-red-950 dark:text-red-200">{preview.errors.map((message, index) => <p key={index}>{message}</p>)}</div>}
      {admin && generateLinks && <p className="text-sm leading-7 text-muted-foreground">已选择同时生成短链并导出；跳过的重复账号不会包含在文件中。</p>}
    </div> : result ? <div className="space-y-5">
      <p role="status" className="rounded-md bg-secondary p-3 text-sm leading-7">{summary}</p>
      {exported && <section className="space-y-3" aria-label="短链账号导出"><p className="text-sm leading-7">已准备 {result.share_exports!.length} 条短链账号，自动下载已发起，可再次下载或复制。</p><p className="break-all text-xs leading-6 text-muted-foreground">{GAME_CLAIM_HINT}</p><textarea aria-label="短链账号导出内容" className="form-input min-h-32 font-mono text-xs leading-6" value={exported} readOnly /><div className="flex flex-wrap gap-3"><button className="button-primary" onClick={() => download(exported)}><Download size={16} aria-hidden="true" />下载短链账号</button><button className="button-secondary" onClick={async () => { try { await navigator.clipboard.writeText(exported); toast.success('短链账号已复制'); } catch { toast.error('复制失败，请在文本框中手动选择复制。'); } }}><Copy size={16} aria-hidden="true" />复制短链账号</button></div></section>}
      {!!result.claim_codes?.length && <ClaimCodeList codes={result.claim_codes} />}
      {result.errors.length > 0 && <div role="alert" className="max-h-44 overflow-auto rounded-md bg-red-50 p-3 text-sm leading-7 text-red-700 dark:bg-red-950 dark:text-red-200"><p className="font-medium">以下行未导入，请检查后单独重试：</p>{result.errors.map((message, index) => <p key={index}>{message}</p>)}</div>}
    </div> : null}
    <div className="mt-6 flex flex-wrap justify-end gap-3">
      {step === 'preview' && <button className="button-secondary" disabled={busy} onClick={() => { setStep('input'); setErrors([]); }}>返回修改</button>}
      {step === 'result' && <button className="button-secondary" onClick={() => { setStep('input'); setContent(''); setFileName(''); setPreview(null); setResult(null); setErrors([]); }}><FileInput size={16} aria-hidden="true" />导入下一批</button>}
      <button className="button-secondary" disabled={busy} onClick={onClose}>{step === 'result' ? '完成' : '取消'}</button>
      {step !== 'result' && <button className="button-primary" disabled={busy || reading || !content.trim()} onClick={() => void submit(step === 'input' && source === 'file')}>{busy ? '处理中…' : step === 'input' && source === 'file' ? '预览' : step === 'preview' ? '确认导入' : '开始导入'}</button>}
    </div>
  </Modal>;
}
