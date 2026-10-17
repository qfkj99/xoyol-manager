import { MailMessage } from '../types';

export interface VerificationCodeCandidate {
  code: string;
  subject: string;
  sender: string;
  mail_date: string;
  mail_id: string;
  recent: boolean;
  mailbox?: 'INBOX' | 'Junk';
  cached?: boolean;
}

function plainText(html: string): string {
  const entities: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':' };
  return html.slice(0, 200_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
      if (entity.startsWith('#')) {
        const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
      }
      return entities[entity.toLowerCase()] ?? original;
    });
}

// Require verification context instead of treating every order number or date as a code.
function extractCode(text: string): string | undefined {
  const contexts = [...text.matchAll(/验证码|校验码|动态码|登录码|安全码|驗證碼|verification\s+code|security\s+code|one[\s-]*time\s+(?:password|code)|authentication\s+code|login\s+code|\bOTP\b/gi)].slice(0, 100);
  if (!contexts.length) return undefined;
  let best: { code: string; score: number } | undefined;
  let checkedTokens = 0;
  for (const token of text.matchAll(/(?<![a-z0-9])[a-z0-9]{4,10}(?![a-z0-9])/gi)) {
    if (++checkedTokens > 2000) break;
    const code = token[0], start = token.index!;
    if (!/^\d{4,8}$/.test(code) && !(/\d/.test(code) && /[a-z]/i.test(code))) continue;
    // A year within a date, or a segment of a long hyphenated number, is not a candidate.
    if (/\d[-/.]$/.test(text.slice(Math.max(0, start - 2), start)) || /^[-/.]\d/.test(text.slice(start + code.length))) continue;
    for (const context of contexts) {
      const after = start - (context.index! + context[0].length);
      const before = context.index! - (start + code.length);
      const gap = after >= 0 ? text.slice(start - after, start) : text.slice(start + code.length, context.index!);
      if (/\d|[。!?！？;]/.test(gap)) continue;
      const score = after >= 0 && after <= 64 ? 200 - after : before >= 0 && before <= 24 ? 100 - before : 0;
      if (score && (!best || score > best.score)) best = { code, score };
    }
  }
  return best?.code;
}

export function verificationCodeCandidates(mails: (Partial<MailMessage> & { cached?: boolean })[], now = Date.now()): VerificationCodeCandidate[] {
  const seen = new Set<string>();
  return mails.map(mail => {
    const subject = mail.subject || '';
    const body = (mail.text_content || '').slice(0, 200_000) + ' ' + plainText(mail.html_content || '');
    const code = extractCode(subject) || extractCode(body);
    if (!code) return undefined;
    const mailId = mail.mail_id || String(mail.id || '');
    const key = `${mail.mailbox || ''}\0${mailId}\0${code}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const mailDate = mail.mail_date || '';
    const timestamp = Date.parse(mailDate);
    return { code, subject, sender: mail.sender || '', mail_date: mailDate, mail_id: mailId,
      recent: Number.isFinite(timestamp) && timestamp <= now + 60_000 && now - timestamp <= 15 * 60_000,
      ...(mail.mailbox ? { mailbox: mail.mailbox } : {}), ...(mail.cached === undefined ? {} : { cached: mail.cached }) };
  }).filter((candidate): candidate is VerificationCodeCandidate => !!candidate)
    .sort((a, b) => (Date.parse(b.mail_date) || 0) - (Date.parse(a.mail_date) || 0))
    .slice(0, 10);
}
