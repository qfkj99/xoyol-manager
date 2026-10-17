import dotenv from 'dotenv';
import path from 'path';

// 尝试加载根目录和 server 目录的 .env
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.DB_PATH === ':memory:' ? ':memory:' : path.resolve(__dirname, '../..', process.env.DB_PATH || './data/outlook.db'),
  sessionHours: Math.max(1, Number(process.env.SESSION_HOURS) || 12),
  rememberDays: Math.max(1, Number(process.env.REMEMBER_DAYS) || 7),
  cookieSecure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  appOrigin: process.env.APP_ORIGIN || '',
};
