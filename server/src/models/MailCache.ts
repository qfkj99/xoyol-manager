import db from '../database';
import { Account, MailMessage } from '../types';
import { AuthUser } from '../types/auth';
import { ownerScope, ownerWhere, requireResource } from '../services/resourceAccess';

export class MailCacheModel {
  getByAccount(user: AuthUser, accountId: number, mailbox: string, page = 1, pageSize = 50) {
    requireResource<Account>('accounts', accountId, user);
    const total = (db.prepare('SELECT COUNT(*) AS c FROM mail_cache WHERE account_id = ? AND mailbox = ?').get(accountId, mailbox) as any).c;
    const list = db.prepare('SELECT * FROM mail_cache WHERE account_id = ? AND mailbox = ? ORDER BY mail_date DESC LIMIT ? OFFSET ?').all(accountId, mailbox, pageSize, (page - 1) * pageSize) as MailMessage[];
    return { list, total, page, pageSize };
  }
  upsert(accountId: number, mailbox: string, mails: Partial<MailMessage>[]) {
    const find = db.prepare('SELECT id FROM mail_cache WHERE account_id = ? AND mailbox = ? AND mail_id = ? LIMIT 1');
    const insert = db.prepare('INSERT INTO mail_cache (account_id, mailbox, mail_id, sender, sender_name, subject, text_content, html_content, mail_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const update = db.prepare('UPDATE mail_cache SET sender = ?, sender_name = ?, subject = ?, text_content = ?, html_content = ?, mail_date = ?, cached_at = CURRENT_TIMESTAMP WHERE id = ?');
    db.transaction(() => {
      for (const mail of mails) {
        // IMAP may not provide a stable message id. Hashing content avoids duplicate fallback caches.
        const mailId = mail.mail_id || require('crypto').createHash('sha256').update(JSON.stringify([mail.sender, mail.subject, mail.mail_date, mail.text_content])).digest('hex');
        const values = [mail.sender || '', mail.sender_name || '', mail.subject || '', mail.text_content || '', mail.html_content || '', mail.mail_date || null];
        const existing = find.get(accountId, mailbox, mailId) as { id: number } | undefined;
        if (existing) update.run(...values, existing.id);
        else insert.run(accountId, mailbox, mailId, ...values);
      }
    })();
  }
  clearByAccount(user: AuthUser, accountId: number, mailbox: string) {
    requireResource<Account>('accounts', accountId, user);
    db.prepare('DELETE FROM mail_cache WHERE account_id = ? AND mailbox = ?').run(accountId, mailbox);
  }
  getRecent(user: AuthUser, limit = 5, requestedOwner?: unknown): MailMessage[] {
    const scope = ownerWhere(ownerScope(user, requestedOwner), 'a');
    return db.prepare(`SELECT mc.*, a.email AS account_email FROM mail_cache mc JOIN accounts a ON mc.account_id = a.id WHERE ${scope.sql} ORDER BY mc.mail_date DESC LIMIT ?`).all(...scope.params, limit) as MailMessage[];
  }
  countByAccount(user: AuthUser, accountId: number, mailbox: string): number {
    requireResource<Account>('accounts', accountId, user);
    return (db.prepare('SELECT COUNT(*) AS c FROM mail_cache WHERE account_id = ? AND mailbox = ?').get(accountId, mailbox) as any).c;
  }
  countAll(user: AuthUser, mailbox: string, requestedOwner?: unknown): number {
    const scope = ownerWhere(ownerScope(user, requestedOwner), 'a');
    return (db.prepare(`SELECT COUNT(*) AS c FROM mail_cache mc JOIN accounts a ON mc.account_id = a.id WHERE mailbox = ? AND ${scope.sql}`).get(mailbox, ...scope.params) as any).c;
  }
}
