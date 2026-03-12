import { Controller, Get, Query, Res, Req } from '@nestjs/common';
import { Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { IntegrationHubService } from './integration-hub.service';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const AIRTABLE_AUTH_URL = 'https://airtable.com/oauth2/v1/authorize';
const AIRTABLE_TOKEN_URL = 'https://airtable.com/oauth2/v1/token';
const AIRTABLE_SCOPES = 'data.records:read data.records:write schema.bases:read schema.bases:write';

/** PKCE code_verifier (and redirect_uri used) per state; cleaned after use or TTL. */
const airtablePkceStore = new Map<string, { code_verifier: string; redirect_uri: string }>();
const PKCE_TTL_MS = 10 * 60 * 1000;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAirtableCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier, 'utf8').digest());
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const SERVICE_TO_GOOGLE_SCOPE: Record<string, string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  gsheets: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
  gcalendar: 'https://www.googleapis.com/auth/calendar.events',
  gdrive: 'https://www.googleapis.com/auth/drive',
  googledrive: 'https://www.googleapis.com/auth/drive',
};

/**
 * Served at /orchestration (excluded from /api prefix) so the popup can load
 * http://localhost:8000/orchestration/gsheets/connect and get a real redirect to Google.
 */
@Controller('orchestration')
export class OrchestrationController {
  constructor(private readonly integrationHub: IntegrationHubService) {}

  /** Default Airtable redirect path: use /auth/callback so Airtable app redirect URI matches (avoids 404). */
  private getAirtableRedirectUri(): string {
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return (process.env.AIRTABLE_REDIRECT_URI || '').trim() || `${baseUrl}/orchestration/airtable/auth/callback`;
  }

  /** Airtable OAuth: return auth URL with PKCE for frontend to open in popup (GET /orchestration/airtable/auth/login). */
  @Get('airtable/auth/login')
  airtableLogin(@Query('userId') userId: string, @Res() res: Response) {
    const uid = userId || '000000000000000000000001';
    const clientId = (process.env.AIRTABLE_CLIENT_ID || '').trim();
    const redirectUri = this.getAirtableRedirectUri();
    if (!clientId) {
      res.status(500).json({
        authUrl: '',
        url: '',
        error: 'AIRTABLE_CLIENT_ID not set in backend .env. Create an OAuth app at https://airtable.com/create/oauth',
        });
      return;
    }
    const state = `${uid}|airtable`;
    const code_verifier = base64UrlEncode(randomBytes(32));
    const code_challenge = buildAirtableCodeChallenge(code_verifier);
    airtablePkceStore.set(state, { code_verifier, redirect_uri: redirectUri });
    setTimeout(() => airtablePkceStore.delete(state), PKCE_TTL_MS);
    const authUrl = `${AIRTABLE_AUTH_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(AIRTABLE_SCOPES)}&state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(code_challenge)}&code_challenge_method=S256`;
    res.json({ authUrl, url: authUrl });
  }

  /** Airtable OAuth callback: exchange code for token and save (with PKCE). */
  @Get('airtable/callback')
  async airtableCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    return this.handleAirtableCallback(code, state, error, res);
  }

  /** Same handler at /airtable/auth/callback so Airtable redirect URI can be .../airtable/auth/callback (fixes 404). */
  @Get('airtable/auth/callback')
  async airtableAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    return this.handleAirtableCallback(code, state, error, res);
  }
  

  private async handleAirtableCallback(
    code: string,
    state: string,
    error: string,
    res: Response,
  ): Promise<void> {
    if (error) {
      res.send(this.closePopupHtml(`Airtable OAuth error: ${error}`));
      return;
    }
    const [userId] = (state || '').split('|');
    const uid = userId || '000000000000000000000001';
    if (!code) {
      res.send(this.closePopupHtml('Missing authorization code. Try connecting again.'));
      return;
    }
    const pkce = airtablePkceStore.get(state);
    airtablePkceStore.delete(state);
    const redirectUri = pkce?.redirect_uri ?? this.getAirtableRedirectUri();
    const code_verifier = pkce?.code_verifier;
    const clientId = (process.env.AIRTABLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.AIRTABLE_CLIENT_SECRET || '').trim();
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('Airtable OAuth not configured. Set AIRTABLE_CLIENT_ID and AIRTABLE_CLIENT_SECRET in .env'));
      return;
    }
    try {
      // Airtable expects client credentials in Authorization header (Basic), not in body.
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
      const tokenBody: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      };
      if (code_verifier) {
        tokenBody.code_verifier = code_verifier;
      }
      const tokenRes = await fetch(AIRTABLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams(tokenBody),
      });
      const tokens = await tokenRes.json();
      if (tokens.error) {
        res.send(this.closePopupHtml(`Airtable token error: ${tokens.error_description || tokens.error}`));
        return;
      }
      const accessToken = tokens.access_token;
      const accountId = await this.integrationHub.saveGoogleOAuthAccount(uid, 'airtable', {
        access_token: accessToken,
        refresh_token: tokens.refresh_token || undefined,
        email: undefined,
        user_name: undefined,
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete Airtable sign-in.'));
    }
  }

  @Get(':service/connect')
  connect(@Query('userId') userId: string, @Query('state') state: string, @Res() res: Response, @Req() req: any) {
    const service = (req.params?.service || '').toLowerCase();
    if (service === 'airtable') {
      const uid = userId || state?.split('|')[0] || '000000000000000000000001';
      const clientId = (process.env.AIRTABLE_CLIENT_ID || '').trim();
      const redirectUri = this.getAirtableRedirectUri();
      if (!clientId) {
        res.status(500).send('<p>Airtable OAuth not configured. Set AIRTABLE_CLIENT_ID in backend .env.</p>');
        return;
      }
      const stateParam = `${uid}|airtable`;
      const code_verifier = base64UrlEncode(randomBytes(32));
      const code_challenge = buildAirtableCodeChallenge(code_verifier);
      airtablePkceStore.set(stateParam, { code_verifier, redirect_uri: redirectUri });
      setTimeout(() => airtablePkceStore.delete(stateParam), PKCE_TTL_MS);
      const url = `${AIRTABLE_AUTH_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(AIRTABLE_SCOPES)}&state=${encodeURIComponent(stateParam)}&code_challenge=${encodeURIComponent(code_challenge)}&code_challenge_method=S256`;
      res.redirect(302, url);
      return;
    }
    const uid = userId || state?.split('|')[0] || '000000000000000000000001';
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    // Normalize: no trailing slash — must match Google Cloud Console exactly
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim().replace(/\/+$/, '') || undefined;
    if (!clientId || !redirectUri) {
      res.status(500).send(
        '<p>OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI in backend .env. GOOGLE_REDIRECT_URI must be this server, e.g. http://localhost:8000/orchestration/google/callback</p>',
      );
      return;
    }
    const scope = SERVICE_TO_GOOGLE_SCOPE[service] ? `${GOOGLE_SCOPES} ${SERVICE_TO_GOOGLE_SCOPE[service]}` : GOOGLE_SCOPES;
    const stateParam = `${uid}|${service}`;
    const url = `${GOOGLE_AUTH_URL}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(stateParam)}&access_type=offline&prompt=consent`;
    res.redirect(302, url);
  }

  @Get('google/callback')
  async googleCallback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    if (error) {
      res.send(this.closePopupHtml(`OAuth error: ${error}`));
      return;
    }
    const [userId, service] = (state || '').split('|');
    if (!userId || !code) {
      res.send(this.closePopupHtml('Missing state or code. Try connecting again.'));
      return;
    }
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (!clientId || !clientSecret || !redirectUri) {
      res.send(this.closePopupHtml('Server OAuth config missing.'));
      return;
    }
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (tokens.error) {
        res.send(this.closePopupHtml(`Token error: ${tokens.error_description || tokens.error}`));
        return;
      }
      const accessToken = tokens.access_token;
      const refreshToken = tokens.refresh_token || null;
      let email = '';
      try {
        const userRes = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const user = await userRes.json();
        email = user?.email || user?.id || '';
      } catch {
        // continue without email
      }
      const svc = (service || 'gmail').toLowerCase();
      const storageKey = svc === 'googledrive' ? 'gdrive' : svc;
      await this.integrationHub.saveGoogleOAuthAccount(userId, storageKey, {
        access_token: accessToken,
        refresh_token: refreshToken || undefined,
        email: email || undefined,
        user_name: email || undefined,
      });
      res.send(this.closePopupHtml(null));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete sign-in.'));
    }
  }

  private getHubSpotRedirectUri(): string {
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return (process.env.HUBSPOT_REDIRECT_URI || '').trim() || `${baseUrl}/orchestration/hubspot/auth/callback`;
  }

  /** HubSpot OAuth: return auth URL for frontend to open in popup (GET /orchestration/hubspot/auth/login). */
  @Get('hubspot/auth/login')
  hubspotLogin(@Query('userId') userId: string, @Res() res: Response) {
    try {
      const uid = (userId || '').trim() || '000000000000000000000001';
      const clientId = (process.env.HUBSPOT_CLIENT_ID || '').trim();
      if (!clientId) {
        res.status(200).json({
          authUrl: '',
          url: '',
          error: 'HUBSPOT_CLIENT_ID not set in backend .env. Create an OAuth app in HubSpot Developer.',
        });
        return;
      }
      const redirectUri = this.getHubSpotRedirectUri();
      const appUrl = (process.env.HUBSPOT_APP_URL || 'https://app.hubspot.com').replace(/\/+$/, '');
      const state = `${uid}|hubspot`;
      // Full scope set required by HubSpot app (contacts, companies, deals, leads, orders, quotes, etc.)
      const scopes = [
        'crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.schemas.contacts.read', 'crm.schemas.contacts.write',
        'crm.objects.companies.read', 'crm.objects.companies.write', 'crm.schemas.companies.read', 'crm.schemas.companies.write',
        'crm.objects.deals.read', 'crm.objects.deals.write', 'crm.schemas.deals.read', 'crm.schemas.deals.write',
        'crm.objects.leads.read', 'crm.objects.leads.write',
        'crm.objects.owners.read', 'crm.lists.read', 'crm.lists.write',
        'crm.objects.custom.read', 'crm.objects.custom.write', 'crm.schemas.custom.read',
        'crm.objects.quotes.read', 'crm.objects.quotes.write', 'crm.schemas.quotes.read', 'crm.schemas.quotes.write',
        'crm.objects.orders.read', 'crm.objects.orders.write', 'crm.schemas.orders.read', 'crm.schemas.orders.write', 'crm.pipelines.orders.read', 'crm.pipelines.orders.write',
        'crm.objects.line_items.read', 'crm.objects.line_items.write', 'crm.schemas.line_items.read',
        'crm.objects.invoices.read', 'crm.objects.invoices.write', 'crm.schemas.invoices.read', 'crm.schemas.invoices.write',
        'crm.objects.carts.read', 'crm.objects.carts.write', 'crm.schemas.carts.read', 'crm.schemas.carts.write',
        'crm.objects.products.read', 'crm.objects.products.write',
        'crm.objects.subscriptions.read', 'crm.objects.subscriptions.write', 'crm.schemas.subscriptions.read', 'crm.schemas.subscriptions.write',
        'crm.objects.commercepayments.read', 'crm.objects.commercepayments.write', 'crm.schemas.commercepayments.read', 'crm.schemas.commercepayments.write',
        'crm.objects.listings.read', 'crm.objects.listings.write', 'crm.schemas.listings.read', 'crm.schemas.listings.write',
        'crm.objects.projects.read', 'crm.objects.projects.write', 'crm.schemas.projects.read', 'crm.schemas.projects.write',
        'crm.objects.services.read', 'crm.objects.services.write', 'crm.schemas.services.read', 'crm.schemas.services.write',
        'crm.objects.appointments.read', 'crm.objects.appointments.write', 'crm.schemas.appointments.read', 'crm.schemas.appointments.write',
        'crm.objects.courses.read', 'crm.objects.courses.write', 'crm.schemas.courses.read', 'crm.schemas.courses.write',
        'crm.objects.goals.read', 'crm.objects.goals.write',
        'crm.objects.forecasts.read', 'crm.schemas.forecasts.read',
        'crm.objects.users.read', 'crm.objects.users.write',
        'crm.objects.marketing_events.read', 'crm.objects.marketing_events.write',
        'crm.objects.partner-services.read', 'crm.objects.partner-services.write',
        'crm.objects.partner-clients.read', 'crm.objects.partner-clients.write',
        'crm.objects.feedback_submissions.read',
        'crm.dealsplits.read_write',
        'crm.extensions_calling_transcripts.read', 'crm.extensions_calling_transcripts.write',
        'crm.export', 'crm.import',
        'tickets', 'automation', 'sales-email-read',
      ].join(' ');
      const authUrl = `${appUrl}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}`;
      res.json({ authUrl, url: authUrl });
    } catch (e: any) {
      res.status(200).json({
        authUrl: '',
        url: '',
        error: e?.message || 'HubSpot auth URL failed. Check server logs.',
      });
    }
  }

  /** HubSpot OAuth callback: exchange code for token and save. */
  @Get('hubspot/auth/callback')
  async hubspotCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`HubSpot OAuth error: ${error}`));
      return;
    }
    const [userId] = (state || '').split('|');
    const uid = userId || '000000000000000000000001';
    if (!code) {
      res.send(this.closePopupHtml('Missing authorization code. Try connecting again.'));
      return;
    }
    const clientId = (process.env.HUBSPOT_CLIENT_ID || '').trim();
    const clientSecret = (process.env.HUBSPOT_CLIENT_SECRET || '').trim();
    const redirectUri = this.getHubSpotRedirectUri();
    const baseUrl = (process.env.HUBSPOT_API_URL || 'https://api.hubapi.com').replace(/\/+$/, '');
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('HubSpot OAuth not configured. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET in .env'));
      return;
    }
    try {
      const tokenRes = await fetch(`${baseUrl}/oauth/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
      });
      const tokens = await tokenRes.json();
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`HubSpot token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 21600;
      const expireAt = new Date(Date.now() + expiresIn * 1000);
      let email: string | undefined;
      try {
        const infoRes = await fetch(`${baseUrl}/oauth/v1/access-tokens/${accessToken}`);
        const info = await infoRes.json();
        email = info.user;
      } catch {
        // continue without email
      }
      const accountId = await this.integrationHub.saveHubspotOAuthAccount(uid, {
        access_token: accessToken,
        refresh_token: refreshToken,
        email,
        meta: { expireAt },
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete HubSpot sign-in.'));
    }
  }

  private closePopupHtml(error: string | null, accountId?: string): string {
    const errEsc = error ? error.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '&lt;') : '';
    const accountIdEsc = (accountId || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const msg = error
      ? `window.opener && window.opener.postMessage && window.opener.postMessage({ type: 'OAUTH_ERROR', error: '${errEsc}' }, '*');`
      : accountIdEsc
        ? `window.opener && window.opener.postMessage && window.opener.postMessage({ type: 'OAUTH_SUCCESS', accountId: '${accountIdEsc}' }, '*');`
        : "window.opener && window.opener.postMessage && window.opener.postMessage({ type: 'OAUTH_SUCCESS' }, '*');";
    const bodyMsg = error ? `Error: ${error.replace(/</g, '&lt;')}` : 'Connected. Closing...';
    return `<!DOCTYPE html><html><head><title>Connected</title></head><body><p>${bodyMsg}</p><script>${msg}; setTimeout(function(){ window.close(); }, 500);</script></body></html>`;
  }
}
