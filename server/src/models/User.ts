import db from '../database';
import { AuthUser, UserRole } from '../types/auth';

export interface UserRecord extends Omit<AuthUser, 'must_change_password'> {
  password_hash: string;
  must_change_password: number;
}

export function publicUser(record: UserRecord): AuthUser {
  const { password_hash: _hash, ...user } = record;
  return { ...user, must_change_password: Boolean(user.must_change_password) };
}

export class UserModel {
  getById(id: number): UserRecord | undefined {
    return db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRecord | undefined;
  }
  getByUsername(username: string): UserRecord | undefined {
    return db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username) as UserRecord | undefined;
  }
  initialized(): boolean {
    return !!db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' LIMIT 1").get();
  }
  create(data: { username: string; display_name: string; password_hash: string; role: UserRole; source: 'self' | 'admin'; must_change_password: boolean }): UserRecord {
    try {
      const result = db.prepare('INSERT INTO users (username,display_name,password_hash,role,source,must_change_password) VALUES (?,?,?,?,?,?)')
        .run(data.username, data.display_name, data.password_hash, data.role, data.source, data.must_change_password ? 1 : 0);
      return this.getById(Number(result.lastInsertRowid))!;
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw Object.assign(new Error('该用户名已被使用'), { status: 409 });
      throw error;
    }
  }
  resourceCounts(id: number) {
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM accounts WHERE owner_user_id=?) AS account_count,
      (SELECT COUNT(*) FROM proxies WHERE owner_user_id=?) AS proxy_count,
      (SELECT COUNT(*) FROM tags WHERE owner_user_id=?) AS tag_count`).get(id, id, id) as { account_count: number; proxy_count: number; tag_count: number };
  }
}

export const userModel = new UserModel();
