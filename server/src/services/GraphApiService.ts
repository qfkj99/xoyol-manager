import { MailMessage, Proxy } from '../types';
import { microsoftRequest } from './MicrosoftTransport';

export class GraphApiService {
  async fetchMails(accessToken: string, mailbox: string, top = 50, proxy?: Proxy): Promise<Partial<MailMessage>[]> {
    const folder = mailbox === 'Junk' ? 'junkemail' : 'inbox';
    const data = await microsoftRequest(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${Math.min(top, 1000)}&$orderby=receivedDateTime%20desc`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    }, proxy);
    return (data.value || []).map((item: any) => ({
      mail_id: item.id, sender: item.from?.emailAddress?.address || '', sender_name: item.from?.emailAddress?.name || '',
      subject: item.subject || '', text_content: item.bodyPreview || '', html_content: item.body?.content || '', mail_date: item.receivedDateTime || item.createdDateTime || '',
    }));
  }
  async deleteMail(accessToken: string, mailId: string, proxy?: Proxy): Promise<void> {
    await microsoftRequest(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(mailId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }, proxy);
  }
  async deleteAllMails(accessToken: string, mailbox: string, proxy?: Proxy): Promise<void> {
    for (;;) {
      const mails = await this.fetchMails(accessToken, mailbox, 100, proxy);
      if (!mails.length) return;
      // Complete each batch before reporting success. Failed deletions must not silently disappear.
      for (let i = 0; i < mails.length; i += 10) {
        const results = await Promise.allSettled(mails.slice(i, i + 10).map(mail => this.deleteMail(accessToken, mail.mail_id!, proxy)));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
    }
  }
}
