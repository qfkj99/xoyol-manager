import { randomBytes } from 'crypto';
import db from '../database';
import { resourceError } from './resourceAccess';

export const DEFAULT_SHORT_LINK_LENGTH = 22;
export const MIN_SHORT_LINK_LENGTH = 8;
export const MAX_SHORT_LINK_LENGTH = 64;
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function shareLinkExpiresAt(expiresInDays: unknown, now = Date.now()): number | null {
  if (expiresInDays === undefined || expiresInDays === null) return null;
  if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
    return resourceError(400, '短链有效期必须为 1 至 3650 的整数天数，或 null 表示永久有效');
  }
  return now + expiresInDays * 86_400_000;
}

export function getShortLinkLength(): number {
  const setting = db.prepare("SELECT value FROM settings WHERE key='short_link_length'").get() as { value: string } | undefined;
  const length = setting ? Number(setting.value) : DEFAULT_SHORT_LINK_LENGTH;
  return Number.isInteger(length) && length >= MIN_SHORT_LINK_LENGTH && length <= MAX_SHORT_LINK_LENGTH
    ? length : DEFAULT_SHORT_LINK_LENGTH;
}

/** Generate within the write transaction, before removing the previous link. */
export function generateUniqueShareToken(): string {
  const length = getShortLinkLength();
  const existing = db.prepare('SELECT 1 FROM account_share_links WHERE token=?');
  for (let attempt = 0; attempt < 10; attempt++) {
    const token = randomBytes(Math.ceil(length * 3 / 4)).toString('base64url').slice(0, length);
    if (!existing.get(token)) return token;
  }
  return resourceError(409, '短链生成冲突，请重试');
}
