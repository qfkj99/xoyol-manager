import db from '../database';
import { Account, Tag } from '../types';
import { AuthUser } from '../types/auth';
import { createOwner, idList, ownerScope, ownerWhere, requireResource, resourceError } from '../services/resourceAccess';

function validateTag(data: { name?: string; color?: string }) {
  if (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100)) resourceError(400, '标签名称须为 1 至 100 字符');
  if (data.color !== undefined && (typeof data.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.color))) resourceError(400, '标签颜色格式错误');
}

export class TagModel {
  list(user: AuthUser, requestedOwner?: unknown): Tag[] {
    const scope = ownerWhere(ownerScope(user, requestedOwner));
    return db.prepare(`SELECT * FROM tags WHERE ${scope.sql} ORDER BY name`).all(...scope.params) as Tag[];
  }
  getById(user: AuthUser, id: number): Tag { return requireResource<Tag>('tags', id, user); }
  create(user: AuthUser, name: string, color = '#3B82F6', requestedOwner?: unknown): Tag {
    validateTag({ name, color });
    if (!name) resourceError(400, '标签名称不能为空');
    const owner = createOwner(user, requestedOwner);
    if (db.prepare('SELECT id FROM tags WHERE owner_user_id = ? AND name = ?').get(owner, name.trim())) resourceError(409, '该用户已有同名标签');
    const result = db.prepare('INSERT INTO tags (name, color, owner_user_id) VALUES (?, ?, ?)').run(name.trim(), color, owner);
    return this.getById(user, Number(result.lastInsertRowid));
  }
  update(user: AuthUser, id: number, data: { name?: string; color?: string; owner_user_id?: number }): Tag {
    const tag = this.getById(user, id);
    validateTag(data);
    if (data.owner_user_id !== undefined) resourceError(400, '标签归属只能通过资源移交修改');
    if (data.name && db.prepare('SELECT id FROM tags WHERE owner_user_id IS ? AND name = ? AND id <> ?').get(tag.owner_user_id, data.name.trim(), id)) resourceError(409, '该用户已有同名标签');
    const fields: string[] = [], values: string[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name.trim()); }
    if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color); }
    if (fields.length) db.prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getById(user, id);
  }
  delete(user: AuthUser, id: number): boolean {
    this.getById(user, id);
    return db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes > 0;
  }
  getTagsByAccountId(user: AuthUser, accountId: number): Tag[] {
    const account = requireResource<Account>('accounts', accountId, user);
    return db.prepare('SELECT t.* FROM tags t JOIN account_tags at ON t.id = at.tag_id WHERE at.account_id = ? AND t.owner_user_id IS ? ORDER BY t.name').all(accountId, account.owner_user_id) as Tag[];
  }
  setAccountTags(user: AuthUser, accountId: number, rawTagIds: unknown): void {
    const tagIds = idList(rawTagIds, 'tag_ids', true);
    db.transaction(() => {
      const account = requireResource<Account>('accounts', accountId, user);
      const tags = tagIds.map(id => this.getById(user, id));
      if (tags.some(tag => tag.owner_user_id !== account.owner_user_id)) resourceError(400, '邮箱与标签必须属于同一用户');
      db.prepare('DELETE FROM account_tags WHERE account_id = ?').run(accountId);
      const insert = db.prepare('INSERT INTO account_tags (account_id, tag_id) VALUES (?, ?)');
      tagIds.forEach(id => insert.run(accountId, id));
    })();
  }
}
