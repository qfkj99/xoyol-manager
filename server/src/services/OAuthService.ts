import { Proxy } from '../types';
import { microsoftRequest } from './MicrosoftTransport';

interface TokenResult { access_token: string; refresh_token?: string; has_mail_scope?: boolean; expires_in: number; }

export class OAuthService {
  private async refresh(clientId: string, refreshToken: string, scope: string, proxy?: Proxy): Promise<TokenResult> {
    const data = await microsoftRequest('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope }).toString(),
    }, proxy);
    if (typeof data.access_token !== 'string') throw new Error('Microsoft token response is invalid');
    return { access_token: data.access_token, refresh_token: data.refresh_token, has_mail_scope: String(data.scope || '').includes('Mail.Read'), expires_in: data.expires_in };
  }
  refreshGraphToken(clientId: string, refreshToken: string, proxy?: Proxy): Promise<TokenResult> { return this.refresh(clientId, refreshToken, 'https://graph.microsoft.com/.default offline_access', proxy); }
  refreshImapToken(clientId: string, refreshToken: string, proxy?: Proxy): Promise<TokenResult> { return this.refresh(clientId, refreshToken, 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All', proxy); }
}
