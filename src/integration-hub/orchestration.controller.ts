import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { IntegrationHubService } from './integration-hub.service';
import { WorkflowService } from '../workflow/workflow.service';
import { RunWorkflowService } from '../scheduler/run-workflow.service';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const AIRTABLE_AUTH_URL = 'https://airtable.com/oauth2/v1/authorize';
const AIRTABLE_TOKEN_URL = 'https://airtable.com/oauth2/v1/token';
const AIRTABLE_SCOPES = 'data.records:read data.records:write schema.bases:read schema.bases:write';

/** PKCE code_verifier (and redirect_uri used) per state; cleaned after use or TTL. */
const airtablePkceStore = new Map<string, { code_verifier: string; redirect_uri: string }>();
const calendlyPkceStore = new Map<string, string>(); // state -> code_verifier
const twitterPkceStore = new Map<string, string>(); // state -> code_verifier
const linkedinPkceStore = new Map<string, string>(); // state -> code_verifier
const PKCE_TTL_MS = 10 * 60 * 1000;

const TWITTER_SCOPE = 'tweet.read users.read offline.access tweet.write';
const LINKEDIN_SCOPE = [
  'openid', 'profile', 'email', 'w_member_social', 'r_basicprofile',
  'rw_ads', 'r_ads', 'r_ads_reporting', 'rw_organization_admin', 'w_organization_social', 'r_organization_social',
].join(' ');
const WORDPRESS_SCOPE = 'auth sites posts users';

const CALENDLY_AUTH_URL = 'https://auth.calendly.com/oauth';

const ZOHO_SCOPE = 'ZohoCRM.users.READ,ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.settings.workflow_rules.ALL,ZohoCRM.settings.automation_actions.CREATE';

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

/** OAuth token response (error or access_token). */
interface OAuthTokenResponse {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  organization?: string;
}

interface GoogleUserInfo {
  email?: string;
  id?: string;
}

interface HubSpotTokenInfo {
  user?: string;
}

interface TwitterMeData {
  id?: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  description?: string;
}

interface TwitterMeResponse {
  data?: TwitterMeData;
  id?: string;
  name?: string;
  username?: string;
}

interface LinkedInMeResponse {
  id?: string;
  localizedFirstName?: string;
  localizedLastName?: string;
}

interface WordPressMeResponse {
  email?: string;
  display_name?: string;
}

interface CalendlyUserResource {
  uri?: string;
  name?: string;
  email?: string;
}

interface CalendlyUserData {
  resource?: CalendlyUserResource;
}

interface ZohoUser {
  full_name?: string;
  email?: string;
}

interface ZohoUsersData {
  users?: ZohoUser[];
}

/**
 * Served at /orchestration (excluded from /api prefix) so the popup can load
 * http://localhost:8000/orchestration/gsheets/connect and get a real redirect to Google.
 */
@Controller('orchestration')
export class OrchestrationController {
  constructor(
    private readonly integrationHub: IntegrationHubService,
    private readonly workflowService: WorkflowService,
    private readonly runWorkflowService: RunWorkflowService,
  ) {}

  /**
   * Agent webhook: called by external AI-Agent service when an agent run completes.
   * Payload: { data: { extras: { nodeExecutionId, workflowExecutionId }, agentRunData: { result, status: 'COMPLETED'|'FAILED' } } }
   * Enqueues node completion so the workflow continues.
   */
  @Post('workflow/agent')
  async agentWebhook(@Body() body: any) {
    const result = await this.runWorkflowService.processAgentWebhook(body);
    return result;
  }

  /**
   * Instantly (and other) webhook trigger: POST /orchestration/workflow/instantly/trigger-webhook?workflowId=...&nodeId=...&userId=...
   * Body is passed as the trigger payload (variableName "trigger" for Campaign Reply Auto-Responder template).
   */
  @Post('workflow/:node/trigger-webhook')
  async handleWorkflowTriggerWebhook(
    @Param('node') node: string,
    @Query('workflowId') workflowId: string,
    @Query('nodeId') nodeId: string,
    @Query('userId') userId: string,
    @Body() payload: any,
  ) {
    if (!workflowId) {
      throw new BadRequestException('workflowId is required in query parameters');
    }
    if (!userId) {
      throw new BadRequestException('userId is required in query parameters');
    }
    const nodeLower = (node || '').toLowerCase();
    if (nodeLower !== 'instantly' && nodeLower !== 'calendly' && nodeLower !== 'cal') {
      throw new BadRequestException(`Unsupported webhook node: ${node}`);
    }
    const triggerVariableName = 'trigger';
    const input = [{ variableName: triggerVariableName, variableValue: payload ?? {} }];
    const executionPayload = await this.workflowService.createWorkflowExecutionPayload(workflowId, userId);
    const finalPayload = { ...executionPayload, input };
    const messageId = await this.workflowService.enqueueWorkflowExecutionPayload(finalPayload);
    return { workflowExecutionId: executionPayload.workflowExecutionId, messageId, accepted: true };
  }

  /** Default Airtable redirect path: use /auth/callback so Airtable app redirect URI matches (avoids 404). */
  private getAirtableRedirectUri(): string {
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return (process.env.AIRTABLE_REDIRECT_URI || '').trim() || `${baseUrl}/orchestration/airtable/auth/callback`;
  }

  /**
   * Calendly redirect URI must exactly match the value registered in your Calendly app (developer.calendly.com).
   * No trailing slash; use CALENDLY_REDIRECT_URI in .env to avoid mismatch (e.g. when behind proxy or different port).
   */
  private getCalendlyRedirectUri(): string {
    const explicit = (process.env.CALENDLY_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) {
      return explicit;
    }
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return `${baseUrl}/orchestration/calendly/callback`;
  }

  /** Zoho OAuth redirect URI; must match the value registered in Zoho API Console. */
  private getZohoRedirectUri(): string {
    const explicit = (process.env.ZOHO_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) {
      return explicit;
    }
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return `${baseUrl}/orchestration/zoho/callback`;
  }

  /** Twitter (X) OAuth 2.0 redirect URI; register this in developer.twitter.com. */
  private getTwitterRedirectUri(): string {
    const explicit = (process.env.TWITTER_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) return explicit;
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return `${baseUrl}/orchestration/twitter/callback`;
  }

  /** LinkedIn OAuth 2.0 redirect URI; register this in LinkedIn Developer Portal. */
  private getLinkedInRedirectUri(): string {
    const explicit = (process.env.LINKEDIN_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) return explicit;
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return `${baseUrl}/orchestration/linkedin/callback`;
  }

  /** WordPress.com OAuth redirect URI; register this in WordPress.com Application Passwords / OAuth. */
  private getWordPressRedirectUri(): string {
    const explicit = (process.env.WORDPRESS_REDIRECT_URI || '').trim().replace(/\/+$/, '');
    if (explicit && (explicit.startsWith('http://') || explicit.startsWith('https://'))) return explicit;
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');
    return `${baseUrl}/orchestration/wordpress/callback`;
  }

  /** Zoho region-specific auth and CRM base URLs (in, com, eu). */
  private getZohoRegionUrls(region?: string): { authUrl: string; baseUrl: string } {
    const r = (region || '').toLowerCase();
    if (r === 'com' || r === 'us') {
      return {
        authUrl: (process.env.ZOHO_AUTH_URL_US || process.env.ZOHO_AUTH_URL_COM || 'https://accounts.zoho.com/oauth/v2').replace(/\/+$/, ''),
        baseUrl: (process.env.ZOHO_CRM_BASE_US || process.env.ZOHO_CRM_BASE_COM || 'https://www.zohoapis.com').replace(/\/+$/, ''),
      };
    }
    if (r === 'eu') {
      return {
        authUrl: (process.env.ZOHO_AUTH_URL_EU || 'https://accounts.zoho.eu/oauth/v2').replace(/\/+$/, ''),
        baseUrl: (process.env.ZOHO_CRM_BASE_EU || 'https://www.zohoapis.eu').replace(/\/+$/, ''),
      };
    }
    return {
      authUrl: (process.env.ZOHO_AUTH_URL || 'https://accounts.zoho.in/oauth/v2').replace(/\/+$/, ''),
      baseUrl: (process.env.ZOHO_CRM_BASE || 'https://www.zohoapis.in').replace(/\/+$/, ''),
    };
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
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
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
  connect(@Query('userId') userId: string, @Query('state') state: string, @Query('region') region: string, @Res() res: Response, @Req() req: any) {
    const service = (req.params?.service || '').toLowerCase();
    if (service === 'zoho') {
      const uid = (userId || state?.split('|')[0] || '').trim() || '000000000000000000000001';
      const clientId = (process.env.ZOHO_CLIENT_ID || '').trim();
      const clientSecret = (process.env.ZOHO_CLIENT_SECRET || '').trim();
      const redirectUri = this.getZohoRedirectUri();
      if (!clientId || !clientSecret) {
        res.status(500).send('<p>Zoho OAuth not configured. Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in backend .env.</p>');
        return;
      }
      const { authUrl: zohoAuthBase } = this.getZohoRegionUrls(region);
      const stateParam = Buffer.from(JSON.stringify({ userId: uid })).toString('base64');
      const params = new URLSearchParams({
        scope: ZOHO_SCOPE,
        client_id: clientId,
        response_type: 'code',
        access_type: 'offline',
        redirect_uri: redirectUri,
        state: stateParam,
      });
      const authUrl = `${zohoAuthBase}/auth?${params.toString()}`;
      res.redirect(302, authUrl);
      return;
    }
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
    if (service === 'twitter') {
      const uid = (userId || state?.split('|')[0] || '').trim() || '000000000000000000000001';
      const clientId = (process.env.TWITTER_CLIENT_ID || '').trim();
      const redirectUri = this.getTwitterRedirectUri();
      const authBase = (process.env.TWITTER_OAUTH_URL || 'https://twitter.com/i/oauth2').replace(/\/+$/, '');
      if (!clientId) {
        res.status(500).send('<p>Twitter (X) OAuth not configured. Set TWITTER_CLIENT_ID in backend .env.</p>');
        return;
      }
      const codeVerifier = randomBytes(32).toString('hex');
      const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const stateParam = Buffer.from(JSON.stringify({ userId: uid, codeVerifier })).toString('base64');
      twitterPkceStore.set(stateParam, codeVerifier);
      setTimeout(() => twitterPkceStore.delete(stateParam), PKCE_TTL_MS);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: TWITTER_SCOPE,
        state: stateParam,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      res.redirect(302, `${authBase}/authorize?${params.toString()}`);
      return;
    }
    if (service === 'linkedin') {
      const uid = (userId || state?.split('|')[0] || '').trim() || '000000000000000000000001';
      const clientId = (process.env.LINKEDIN_CLIENT_ID || '').trim();
      const redirectUri = this.getLinkedInRedirectUri();
      const authBase = (process.env.LINKEDIN_AUTH_URL || 'https://www.linkedin.com/oauth').replace(/\/+$/, '');
      if (!clientId) {
        res.status(500).send('<p>LinkedIn OAuth not configured. Set LINKEDIN_CLIENT_ID in backend .env.</p>');
        return;
      }
      const codeVerifier = randomBytes(32).toString('hex');
      const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const stateParam = Buffer.from(JSON.stringify({ userId: uid, codeVerifier })).toString('base64');
      linkedinPkceStore.set(stateParam, codeVerifier);
      setTimeout(() => linkedinPkceStore.delete(stateParam), PKCE_TTL_MS);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: LINKEDIN_SCOPE,
        state: stateParam,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });
      res.redirect(302, `${authBase}/v2/authorization?${params.toString()}`);
      return;
    }
    if (service === 'wordpress') {
      const uid = (userId || state?.split('|')[0] || '').trim() || '000000000000000000000001';
      const clientId = (process.env.WORDPRESS_CLIENT_ID || '').trim();
      const redirectUri = this.getWordPressRedirectUri();
      const authUrl = (process.env.WORDPRESS_AUTH_URL || 'https://public-api.wordpress.com/oauth2/authorize').replace(/\/+$/, '');
      if (!clientId) {
        res.status(500).send('<p>WordPress OAuth not configured. Set WORDPRESS_CLIENT_ID in backend .env.</p>');
        return;
      }
      const stateParam = Buffer.from(JSON.stringify({ userId: uid })).toString('base64');
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: stateParam,
        scope: WORDPRESS_SCOPE,
      });
      res.redirect(302, `${authUrl}?${params.toString()}`);
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
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
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
        const user = (await userRes.json()) as GoogleUserInfo;
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

  /** Twitter (X) OAuth 2.0 callback: exchange code for token and save. */
  @Get('twitter/callback')
  async twitterCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`Twitter OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.send(this.closePopupHtml('Missing code or state. Try connecting again.'));
      return;
    }
    let userId: string;
    let codeVerifier: string;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      userId = (decoded?.userId || '').trim() || '000000000000000000000001';
      codeVerifier = twitterPkceStore.get(state) || decoded?.codeVerifier;
    } catch {
      res.send(this.closePopupHtml('Invalid state. Try connecting again.'));
      return;
    }
    twitterPkceStore.delete(state);
    const clientId = (process.env.TWITTER_CLIENT_ID || '').trim();
    const clientSecret = (process.env.TWITTER_CLIENT_SECRET || '').trim();
    const redirectUri = this.getTwitterRedirectUri();
    const apiUrl = (process.env.TWITTER_API_URL || 'https://api.twitter.com').replace(/\/+$/, '');
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('Twitter OAuth not configured. Set TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET in .env'));
      return;
    }
    try {
      const tokenRes = await fetch(`${apiUrl}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`Twitter token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const userRes = await fetch(`${apiUrl}/2/users/me?user.fields=id,name,username,profile_image_url,description`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userJson = (await userRes.json()) as TwitterMeResponse;
      const userData = userJson?.data || userJson;
      const existingIds = await this.integrationHub.getOAuthAccountMetaIds(userId, 'twitter');
      if (userData?.id && existingIds.includes(userData.id)) {
        res.send(this.closePopupHtml('This Twitter account is already connected.'));
        return;
      }
      const refreshExpireAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000); // 180 days
      const accountId = await this.integrationHub.saveTwitterOAuthAccount(userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        user_name: userData?.name ?? undefined,
        meta: userData?.id ? { user_id: userData.id } : undefined,
        refresh_token_expire_at: refreshExpireAt,
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete Twitter sign-in.'));
    }
  }

  /** LinkedIn OAuth 2.0 callback: exchange code for token and save. */
  @Get('linkedin/callback')
  async linkedinCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`LinkedIn OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.send(this.closePopupHtml('Missing code or state. Try connecting again.'));
      return;
    }
    let userId: string;
    let codeVerifier: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      userId = (decoded?.userId || '').trim() || '000000000000000000000001';
      codeVerifier = linkedinPkceStore.get(state) || decoded?.codeVerifier;
    } catch {
      res.send(this.closePopupHtml('Invalid state. Try connecting again.'));
      return;
    }
    linkedinPkceStore.delete(state);
    const clientId = (process.env.LINKEDIN_CLIENT_ID || '').trim();
    const clientSecret = (process.env.LINKEDIN_CLIENT_SECRET || '').trim();
    const redirectUri = this.getLinkedInRedirectUri();
    const authBase = (process.env.LINKEDIN_AUTH_URL || 'https://www.linkedin.com/oauth').replace(/\/+$/, '');
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('LinkedIn OAuth not configured. Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env'));
      return;
    }
    try {
      const tokenBody: Record<string, string> = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      };
      if (codeVerifier) tokenBody.code_verifier = codeVerifier;
      const tokenRes = await fetch(`${authBase}/v2/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenBody),
      });
      const tokens = (await tokenRes.json()) as OAuthTokenResponse & { refresh_token_expires_in?: number };
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`LinkedIn token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const userRes = await fetch('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      });
      const me = (await userRes.json()) as LinkedInMeResponse;
      const linkedinId = me?.id;
      const firstName = me?.localizedFirstName ?? '';
      const lastName = me?.localizedLastName ?? '';
      const existingIds = await this.integrationHub.getOAuthAccountMetaIds(userId, 'linkedin');
      if (linkedinId && existingIds.includes(linkedinId)) {
        res.send(this.closePopupHtml('This LinkedIn account is already connected.'));
        return;
      }
      const refreshExpireAt = tokens.refresh_token_expires_in
        ? new Date(Date.now() + tokens.refresh_token_expires_in * 1000)
        : undefined;
      const accountId = await this.integrationHub.saveLinkedInOAuthAccount(userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        user_name: `${firstName} ${lastName}`.trim() || undefined,
        meta: linkedinId ? { user_id: linkedinId } : undefined,
        refresh_token_expire_at: refreshExpireAt,
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete LinkedIn sign-in.'));
    }
  }

  /** WordPress.com OAuth callback: exchange code for token and save. */
  @Get('wordpress/callback')
  async wordpressCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`WordPress OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.send(this.closePopupHtml('Missing code or state. Try connecting again.'));
      return;
    }
    let userId: string;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      userId = (decoded?.userId || '').trim() || '000000000000000000000001';
    } catch {
      res.send(this.closePopupHtml('Invalid state. Try connecting again.'));
      return;
    }
    const clientId = (process.env.WORDPRESS_CLIENT_ID || '').trim();
    const clientSecret = (process.env.WORDPRESS_CLIENT_SECRET || '').trim();
    const redirectUri = this.getWordPressRedirectUri();
    const tokenUrl = (process.env.WORDPRESS_TOKEN_URL || 'https://public-api.wordpress.com/oauth2/token').replace(/\/+$/, '');
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('WordPress OAuth not configured. Set WORDPRESS_CLIENT_ID and WORDPRESS_CLIENT_SECRET in .env'));
      return;
    }
    try {
      const tokenRes = await fetch(tokenUrl, {
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
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`WordPress token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const userRes = await fetch('https://public-api.wordpress.com/rest/v1.1/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const wpUser = (await userRes.json()) as WordPressMeResponse;
      const email = wpUser?.email ?? '';
      const displayName = wpUser?.display_name ?? '';
      const existing = await this.integrationHub.getConnectedAccounts(userId, 'wordpress');
      const existingEmails = (existing as any[]).map((a: any) => a.email).filter(Boolean);
      if (email && existingEmails.includes(email)) {
        res.send(this.closePopupHtml('This WordPress account is already connected.'));
        return;
      }
      const accountId = await this.integrationHub.saveWordPressOAuthAccount(userId, {
        access_token: accessToken,
        refresh_token: refreshToken || undefined,
        email: email || undefined,
        user_name: displayName || email || undefined,
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete WordPress sign-in.'));
    }
  }

  private getHubSpotRedirectUri(): string {
    const baseUrl = (process.env.BASE_URL || process.env.CONNECT_BASE_URL || 'http://localhost:8000').trim().replace(/\/+$/, '');
    const fromEnv = (process.env.HUBSPOT_REDIRECT_URI || '').trim();
    if (fromEnv) {
      // Expand ${BASE_URL} / ${CONNECT_BASE_URL} so .env can use HUBSPOT_REDIRECT_URI=${BASE_URL}/orchestration/hubspot/auth/callback
      const expanded = fromEnv
        .replace(/\$\{BASE_URL\}/g, baseUrl)
        .replace(/\$\{CONNECT_BASE_URL\}/g, baseUrl);
      return expanded.replace(/\/+$/, '');
    }
    return `${baseUrl}/orchestration/hubspot/callback`;
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
      // Scopes must include everything required by the HubSpot app (Developer Portal). If you get "missing scopes"
      // errors, add the scope names from the error message here. CRM scopes + app-required scopes below.
      const scopes = [
        // CRM (contacts, companies, deals, etc.)
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
        // App-required scopes (add any scope HubSpot says is "required for the app to function")
        'content', 'tax_rates.read', 'social', 'actions', 'timeline',
        'collector.graphql_schema.read', 'business-intelligence', 'collector.graphql_query.execute',
        'forms', 'files', 'hubdb', 'transactional-email',
        'account-info.security.read', 'record_images.signed_urls.read',
        'integration-sync', 'cms.performance.read', 'e-commerce',
        'integrations.zoom-app.playbooks.read', 'settings.currencies.read', 'settings.currencies.write',
        'accounting', 'external_integrations.forms.access', 'business_units_view.read', 'forms-uploaded-files',
        'communication_preferences.read_write', 'data_integration.data_source.file.read', 'data_integration.data_source.file.write',
        // Do NOT add analytics.behavioral_event.s.send or analytics.behavioral_events.send - HubSpot reports them as invalid.
        'ctas.read', 'behavioral_events.event_definitions.read_write', 'marketing-email',
        'communication_preferences.read', 'communication_preferences.write', 'settings.users.write',
        'conversations.visitor_identification.tokens.create', 'settings.security.security_health.read', 'files.ui_hidden.read',
        'settings.users.read', 'cms.domains.read', 'cms.domains.write', 'cms.functions.read', 'cms.functions.write',
        'media_bridge.read', 'media_bridge.write', 'settings.billing.write',
        'conversations.custom_channels.read', 'conversations.custom_channels.write',
        'marketing.campaigns.read', 'marketing.campaigns.write', 'marketing.campaigns.revenue.read',
        'automation.sequences.enrollments.write', 'automation.sequences.read',
        'communication_preferences.statuses.batch.read', 'communication_preferences.statuses.batch.write',
        'cms.knowledge_base.articles.publish', 'cms.knowledge_base.articles.write', 'cms.knowledge_base.articles.read',
        'cms.knowledge_base.settings.read', 'cms.knowledge_base.settings.write', 'cms.membership.access_groups.read',
        'settings.users.teams.write', 'cms.membership.access_groups.write', 'settings.users.teams.read',
        'conversations.read', 'conversations.write', 'scheduler.meetings.meeting-link.read',
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
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
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
        const info = (await infoRes.json()) as HubSpotTokenInfo;
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

  /** Calendly OAuth: return auth URL for frontend to open in popup (GET /orchestration/calendly/login). */
  @Get('calendly/login')
  calendlyLogin(@Query('userId') userId: string, @Res() res: Response) {
    const uid = (userId || '').trim() || '000000000000000000000001';
    const clientId = (process.env.CALENDLY_CLIENT_ID || '').trim();
    const redirectUri = this.getCalendlyRedirectUri();
    if (!clientId || !redirectUri) {
      res.status(200).json({
        authUrl: '',
        url: '',
        error: 'CALENDLY_CLIENT_ID and redirect URI not set. Set CALENDLY_CLIENT_ID in backend .env and ensure BASE_URL or CALENDLY_REDIRECT_URI is set. See OAUTH_SETUP_GUIDE.md.',
      });
      return;
    }
    const codeVerifier = randomBytes(32).toString('hex');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const state = Buffer.from(JSON.stringify({ userId: uid, codeVerifier, timestamp: Date.now(), nonce: randomBytes(16).toString('hex') })).toString('base64');
    calendlyPkceStore.set(state, codeVerifier);
    setTimeout(() => calendlyPkceStore.delete(state), PKCE_TTL_MS);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const authUrl = `${CALENDLY_AUTH_URL}/authorize?${params.toString()}`;
    res.json({ authUrl, url: authUrl, redirectUri });
  }

  /** Calendly OAuth callback: exchange code for token and save. */
  @Get('calendly/callback')
  async calendlyCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`Calendly OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.send(this.closePopupHtml('Missing code or state. Try connecting again.'));
      return;
    }
    let userId: string;
    let codeVerifier: string;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      userId = decoded?.userId || '000000000000000000000001';
      codeVerifier = calendlyPkceStore.get(state) || decoded?.codeVerifier;
    } catch {
      res.send(this.closePopupHtml('Invalid state. Try connecting again.'));
      return;
    }
    calendlyPkceStore.delete(state);
    const clientId = (process.env.CALENDLY_CLIENT_ID || '').trim();
    const clientSecret = (process.env.CALENDLY_CLIENT_SECRET || '').trim();
    const redirectUri = this.getCalendlyRedirectUri();
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('Calendly OAuth not configured. Set CALENDLY_CLIENT_ID and CALENDLY_CLIENT_SECRET in .env'));
      return;
    }
    try {
      const tokenRes = await fetch(`${CALENDLY_AUTH_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }),
      });
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`Calendly token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const organization = tokens.organization as string | undefined;
      const userRes = await fetch('https://api.calendly.com/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = (await userRes.json()) as CalendlyUserData;
      const resource = userData?.resource || {};
      const userUri = resource.uri;
      const userName = resource.name;
      const userEmail = resource.email;
      const accountId = await this.integrationHub.saveCalendlyOAuthAccount(userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        email: userEmail,
        user_name: userName,
        meta: { user_uri: userUri, organization_uri: organization },
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete Calendly sign-in.'));
    }
  }

  /** Zoho OAuth: return auth URL for frontend (GET /orchestration/zoho/login). Frontend uses response.data as URL. */
  @Get('zoho/login')
  zohoLogin(@Query('userId') userId: string, @Query('region') region: string, @Res() res: Response) {
    const uid = (userId || '').trim() || '000000000000000000000001';
    const clientId = (process.env.ZOHO_CLIENT_ID || '').trim();
    const clientSecret = (process.env.ZOHO_CLIENT_SECRET || '').trim();
    const redirectUri = this.getZohoRedirectUri();
    if (!clientId || !clientSecret) {
      res.status(500).send('Zoho OAuth not configured. Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in backend .env.');
      return;
    }
    const { authUrl: zohoAuthBase } = this.getZohoRegionUrls(region);
    const state = Buffer.from(JSON.stringify({ userId: uid })).toString('base64');
    const params = new URLSearchParams({
      scope: ZOHO_SCOPE,
      client_id: clientId,
      response_type: 'code',
      access_type: 'offline',
      redirect_uri: redirectUri,
      state,
    });
    const authUrl = `${zohoAuthBase}/auth?${params.toString()}`;
    res.send(authUrl);
  }

  /** Zoho OAuth callback: exchange code for token and save (GET /orchestration/zoho/callback). */
  @Get('zoho/callback')
  async zohoCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('location') location: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      res.send(this.closePopupHtml(`Zoho OAuth error: ${error}`));
      return;
    }
    if (!code || !state) {
      res.send(this.closePopupHtml('Missing code or state. Try connecting again.'));
      return;
    }
    let userId: string;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      userId = (decoded?.userId || '').trim() || '000000000000000000000001';
    } catch {
      res.send(this.closePopupHtml('Invalid state. Try connecting again.'));
      return;
    }
    const clientId = (process.env.ZOHO_CLIENT_ID || '').trim();
    const clientSecret = (process.env.ZOHO_CLIENT_SECRET || '').trim();
    const redirectUri = this.getZohoRedirectUri();
    if (!clientId || !clientSecret) {
      res.send(this.closePopupHtml('Zoho OAuth not configured.'));
      return;
    }
    const { authUrl: zohoAuthBase, baseUrl: zohoCrmBase } = this.getZohoRegionUrls(location);
    try {
      const tokenRes = await fetch(`${zohoAuthBase}/token`, {
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
      const tokens = (await tokenRes.json()) as OAuthTokenResponse;
      if (tokens.error || !tokens.access_token) {
        res.send(this.closePopupHtml(`Zoho token error: ${tokens.error_description || tokens.error || 'Unknown'}`));
        return;
      }
      const accessToken = tokens.access_token as string;
      const refreshToken = (tokens.refresh_token as string) || '';
      const userRes = await fetch(`${zohoCrmBase}/crm/v8/users?type=CurrentUser`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      const userData = (await userRes.json()) as ZohoUsersData;
      const users = userData?.users || [];
      const fullName = users[0]?.full_name ?? '';
      const email = users[0]?.email ?? '';
      const existing = await this.integrationHub.getZohoAccounts(userId);
      if (existing.some((a: any) => a.email === email)) {
        res.send(
          `<!DOCTYPE html><html><body><script>window.opener && window.opener.postMessage({ type: 'OAUTH_ERROR', error: 'Email already connected' }, '*');</script><p>This email is already connected to Zoho.</p></body></html>`,
        );
        return;
      }
      const accountId = await this.integrationHub.saveZohoOAuthAccount(userId, {
        access_token: accessToken,
        refresh_token: refreshToken,
        email: email || undefined,
        user_name: fullName || email || undefined,
        location: location || undefined,
      });
      res.send(this.closePopupHtml(null, accountId));
    } catch (e: any) {
      res.send(this.closePopupHtml(e?.message || 'Failed to complete Zoho sign-in.'));
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
