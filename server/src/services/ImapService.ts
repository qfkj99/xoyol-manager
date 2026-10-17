import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import { MailMessage, Proxy } from '../types';
import { ProxyService } from './ProxyService';

const proxyService = new ProxyService();

export class ImapService {
  generateAuthString(email: string, accessToken: string): string { return Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64'); }

  private async withConnection<T>(email: string, authString: string, proxy: Proxy | undefined, work: (imap: Imap) => Promise<T>): Promise<T> {
    const socket = await proxyService.createImapTunnel(proxy);
    if (socket) {
      // node-imap calls connect() even for an already connected socket. Keep this
      // dedicated tunnel connected to the vetted proxy instead of dialing again.
      socket.connect = (() => socket) as typeof socket.connect;
    }
    return new Promise<T>((resolve, reject) => {
      const imap = new Imap({
        user: email, password: '', xoauth2: authString, host: 'outlook.office365.com', port: 993,
        tls: true, tlsOptions: { rejectUnauthorized: true, servername: 'outlook.office365.com' },
        connTimeout: 20000, authTimeout: 20000, socketTimeout: 30000, socket,
      } as any);
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        imap.destroy(); socket?.destroy(); reject(error);
      };
      imap.once('error', fail);
      imap.once('close', () => { if (!finished) fail(new Error('IMAP connection closed before completion')); });
      imap.once('end', () => { if (!finished) fail(new Error('IMAP connection ended before completion')); });
      imap.once('ready', () => {
        work(imap).then(result => { if (!finished) { finished = true; imap.end(); resolve(result); } }, fail);
      });
      try { imap.connect(); } catch (error) { fail(error as Error); }
    });
  }

  async fetchMails(email: string, authString: string, mailbox = 'INBOX', top = 50, proxy?: Proxy): Promise<Partial<MailMessage>[]> {
    return this.withConnection(email, authString, proxy, async imap => {
      await new Promise<void>((resolve, reject) => imap.openBox(mailbox, true, error => error ? reject(error) : resolve()));
      const ids = await new Promise<number[]>((resolve, reject) => imap.search(['ALL'], (error, results) => error ? reject(error) : resolve(results.slice(-top))));
      if (!ids.length) return [];
      return new Promise<Partial<MailMessage>[]>((resolve, reject) => {
        const parsed: Promise<Partial<MailMessage>>[] = [];
        const fetch = imap.fetch(ids, { bodies: '' });
        fetch.on('message', message => {
          message.on('body', stream => {
            const pending = simpleParser(stream as any).then(mail => ({
              mail_id: mail.messageId || '', sender: mail.from?.value?.[0]?.address || '', sender_name: mail.from?.value?.[0]?.name || '',
              subject: mail.subject || '', text_content: mail.text || '', html_content: mail.html || '', mail_date: mail.date?.toISOString() || '',
            }));
            pending.catch(reject); parsed.push(pending);
          });
        });
        fetch.once('error', reject);
        fetch.once('end', () => { Promise.all(parsed).then(mails => resolve(mails.sort((a, b) => String(b.mail_date).localeCompare(String(a.mail_date)))), reject); });
      });
    });
  }

  async clearMailbox(email: string, authString: string, mailbox = 'INBOX', proxy?: Proxy): Promise<void> {
    await this.withConnection(email, authString, proxy, async imap => {
      await new Promise<void>((resolve, reject) => imap.openBox(mailbox, false, error => error ? reject(error) : resolve()));
      const ids = await new Promise<number[]>((resolve, reject) => imap.search(['ALL'], (error, results) => error ? reject(error) : resolve(results)));
      if (!ids.length) return;
      await new Promise<void>((resolve, reject) => imap.addFlags(ids, ['\\Deleted'], error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => imap.expunge(error => error ? reject(error) : resolve()));
    });
  }
}
