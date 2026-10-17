export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled' | 'deleted';

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  must_change_password: boolean;
  source: 'self' | 'admin';
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  account_count?: number;
  proxy_count?: number;
  tag_count?: number;
}
