import Database, { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config';
import path from 'path';
import fs from 'fs';

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

function openDatabase(): DatabaseType {
  const connection = new Database(config.dbPath);
  try {
    connection.pragma('journal_mode = WAL');
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    return connection;
  } catch (error) { connection.close(); throw error; }
}

let connection = openDatabase();

// Models retain this stable reference while a maintenance restore replaces the connection.
const db: DatabaseType = new Proxy({} as DatabaseType, {
  get(_target, property) {
    const value = Reflect.get(connection, property, connection);
    return typeof value === 'function' ? value.bind(connection) : value;
  },
});

export function closeDatabase(): void {
  if (connection.open) {
    const result = connection.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (result[0]?.busy) throw Object.assign(new Error('数据库正被其他进程使用，请稍后恢复'), { status: 409 });
    connection.close();
  }
}

export function reopenDatabase(): void {
  if (connection.open) throw new Error('Database connection is still open');
  connection = openDatabase();
}

export default db;
