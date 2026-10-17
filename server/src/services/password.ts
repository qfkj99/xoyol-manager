import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const derive = promisify(scrypt);
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw Object.assign(new Error('密码长度必须为 12～128 个字符'), { status: 400 });
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) return false;
  const [algorithm, salt, digest] = stored.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(digest || '')) return false;
  const key = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(digest, 'hex'));
}

export function validateUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(value)) {
    throw Object.assign(new Error('用户名须为 3～32 位字母、数字或下划线'), { status: 400 });
  }
  return value.toLowerCase();
}

export function validateDisplayName(value: unknown, fallback: string): string {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
    throw Object.assign(new Error('显示名称须为 1～64 个字符'), { status: 400 });
  }
  return value.trim();
}
