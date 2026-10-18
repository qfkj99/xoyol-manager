import { Fragment, type ReactNode, useEffect } from 'react';
import { BookOpen, Copy, KeyRound } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import source from '../../../docs/external-api.md?raw';

type DocBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] };

interface DocSection { id: string; title: string; blocks: DocBlock[] }

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

// Render the paragraphs, fenced examples and tables used by our bundled guide.
// Content stays React text nodes; documentation never injects HTML into the page.
function parseBlocks(lines: string[]): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(), code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index++;
      blocks.push({ type: 'code', language, text: code.join('\n') });
    } else if (line.startsWith('|') && /^\|[\s:|\-]+\|$/.test(lines[index + 1] || '')) {
      const headers = tableCells(line), rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].startsWith('|')) rows.push(tableCells(lines[index++]));
      blocks.push({ type: 'table', headers, rows });
    } else {
      const paragraph = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !lines[index].startsWith('```') && !lines[index].startsWith('|')) paragraph.push(lines[index++]);
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    }
  }
  return blocks;
}

function parseGuide(markdown: string) {
  const sections: DocSection[] = [], introduction: string[] = [];
  let section: { title: string; lines: string[] } | undefined;
  const finishSection = () => {
    if (section) sections.push({ id: `api-docs-section-${sections.length + 1}`, title: section.title, blocks: parseBlocks(section.lines) });
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('# ')) continue;
    if (line.startsWith('## ')) {
      finishSection();
      section = { title: line.slice(3), lines: [] };
    } else if (section) section.lines.push(line);
    else introduction.push(line);
  }
  finishSection();
  return { introduction: parseBlocks(introduction), sections };
}

function inlineText(value: string): ReactNode {
  return value.split(/(`[^`]+`)/g).map((part, index) => part.startsWith('`') && part.endsWith('`')
    ? <code key={index} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]">{part.slice(1, -1)}</code>
    : <Fragment key={index}>{part}</Fragment>);
}

async function copyText(value: string, label: string) {
  try { await navigator.clipboard.writeText(value); toast.success(`${label}已复制`); }
  catch { toast.error('复制失败，请选择文本后手动复制'); }
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const label = ({ json: 'JSON', http: 'HTTP', bash: 'Bash / curl', python: 'Python', text: '文本' } as Record<string, string>)[language] || language || '代码';
  return <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-secondary">
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1">
      <span className="font-mono text-xs font-medium text-muted-foreground">{label}</span>
      <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-foreground transition-colors hover:bg-card" aria-label={`复制${label}代码`} onClick={() => void copyText(text, '代码')}><Copy size={16} aria-hidden="true" />复制</button>
    </div>
    <pre className="min-w-0 whitespace-pre-wrap p-4 font-mono text-xs leading-7 text-foreground [overflow-wrap:anywhere] sm:text-sm"><code>{text}</code></pre>
  </div>;
}

function Blocks({ blocks }: { blocks: DocBlock[] }) {
  return <>{blocks.map((block, index) => {
    if (block.type === 'code') return <CodeBlock key={index} language={block.language} text={block.text} />;
    if (block.type === 'table') return <div key={index} className="min-w-0 overflow-x-auto rounded-lg border border-border focus-visible:outline-offset-2" role="region" aria-label={`${block.headers.join('、')}说明表`} tabIndex={0}>
      <table className="w-full min-w-[36rem] text-left text-sm leading-7">
        <thead className="bg-secondary"><tr>{block.headers.map((header, column) => <th key={column} scope="col" className="px-4 py-3 align-top font-semibold">{inlineText(header)}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} className="px-4 py-3 align-top [overflow-wrap:anywhere]">{inlineText(cell)}</td>)}</tr>)}</tbody>
      </table>
    </div>;
    return <p key={index} className="whitespace-pre-line text-sm leading-8 text-foreground [overflow-wrap:anywhere]">{inlineText(block.text)}</p>;
  })}</>;
}

export default function ApiDocs() {
  const { hash } = useLocation();
  const origin = window.location.origin;
  const root = `${origin}/api/external/v1`;
  const guide = parseGuide(source.split('https://game.example.com').join(origin).split('https://你的域名').join(origin));

  useEffect(() => {
    if (/^#api-docs-section-\d+$/.test(hash)) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return <div className="mx-auto max-w-6xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2"><h1 className="flex items-center gap-3 text-2xl font-semibold"><BookOpen size={24} aria-hidden="true" />API 文档<span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">v1</span></h1><p className="text-sm leading-7 text-muted-foreground">查看外部接口、请求参数和响应示例，接入你的发号程序。</p></div>
      <Link to="/settings#api-key-heading" className="button-secondary"><KeyRound size={16} aria-hidden="true" />管理 API Key</Link>
    </div>

    <section className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6" aria-labelledby="api-docs-address">
      <h2 id="api-docs-address" className="text-base font-semibold">接口根地址</h2>
      <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center"><code className="min-w-0 rounded-md bg-secondary px-3 py-3 text-sm leading-7 [overflow-wrap:anywhere] sm:flex-1">{root}</code><button type="button" className="button-secondary self-start sm:self-auto" onClick={() => void copyText(root, '接口根地址')}><Copy size={16} aria-hidden="true" />复制地址</button></div>
      <Blocks blocks={guide.introduction} />
    </section>

    <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="API 文档目录" className="min-w-0 rounded-lg border border-border bg-card p-3 lg:sticky lg:top-0">
        <p className="px-3 pb-2 pt-1 text-sm font-semibold">文档目录</p>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">{guide.sections.map(section => <a key={section.id} href={`#${section.id}`} aria-current={hash === `#${section.id}` ? 'location' : undefined} className={`flex min-h-11 items-center rounded-md px-3 py-2 text-sm leading-6 transition-colors ${hash === `#${section.id}` ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>{section.title}</a>)}</div>
      </nav>
      <div className="min-w-0 space-y-6">{guide.sections.map(section => <section key={section.id} aria-labelledby={section.id} className="min-w-0 space-y-5 rounded-lg border border-border bg-card p-4 sm:p-6">
        <h2 id={section.id} tabIndex={-1} className="scroll-mt-4 text-lg font-semibold">{section.title}</h2>
        <Blocks blocks={section.blocks} />
      </section>)}</div>
    </div>
  </div>;
}
