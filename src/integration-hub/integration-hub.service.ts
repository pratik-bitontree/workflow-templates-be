import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OAuth2Client } from 'google-auth-library';
import { UserSecrets, UserSecretsDocument } from '../schemas/user-secrets.schema';
import { ActivityLog, ActivityLogDocument } from '../schemas/activity-log.schema';
import { NodeMaster, NodeMasterDocument } from '../schemas/node-master.schema';

const userSecretKeyMap: Record<string, string> = {
  gmail: 'gmail',
  googlecalendar: 'gcalendar',
  googlesheets: 'gsheets',
  googledrive: 'gdrive',
  gdrive: 'gdrive',
  hubspot: 'hubspot',
  instantly: 'instantly',
  calendly: 'calendly',
  cal: 'cal',
  zoho: 'zoho',
  vercel: 'vercel',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  firecrawl: 'firecrawl',
  airtable: 'airtable',
  perplexity: 'perplexity',
  twitter: 'twitter',
  linkedin: 'linkedin',
  'linkedin-marketing': 'linkedin',
  wordpress: 'wordpress',
};

const connectionMethodMap: Record<string, { apiKey: boolean; oauth: boolean }> = {
  gmail: { apiKey: false, oauth: true },
  gsheets: { apiKey: false, oauth: true },
  gcalendar: { apiKey: false, oauth: true },
  hubspot: { apiKey: false, oauth: true },
  calendly: { apiKey: false, oauth: true },
  cal: { apiKey: true, oauth: false },
  zoho: { apiKey: false, oauth: true },
  vercel: { apiKey: true, oauth: false },
  openai: { apiKey: true, oauth: false },
  anthropic: { apiKey: true, oauth: false },
  gemini: { apiKey: true, oauth: false },
  firecrawl: { apiKey: true, oauth: false },
  instantly: { apiKey: true, oauth: false },
  airtable: { apiKey: false, oauth: true },
  perplexity: { apiKey: true, oauth: false },
  twitter: { apiKey: false, oauth: true },
  linkedin: { apiKey: false, oauth: true },
  wordpress: { apiKey: false, oauth: true },
};

@Injectable()
export class IntegrationHubService {
  constructor(
    private readonly config: ConfigService,
    @InjectModel(UserSecrets.name) private userSecretsModel: Model<UserSecretsDocument>,
    @InjectModel(ActivityLog.name) private activityLogModel: Model<ActivityLogDocument>,
    @InjectModel(NodeMaster.name) private nodeMasterModel: Model<NodeMasterDocument>,
  ) {}

  async getCategories() {
    const records = await this.nodeMasterModel
      .find({ category: 'Integration', isVisible: true }, { subCategory: 1, type: 1, category: 1, name: 1 })
      .lean();
    const grouped: Record<string, { label: string; value: string; types: { label: string; value: string }[] }> = {};
    for (const r of records) {
      const sub = (r as any).subCategory?.trim() || 'Other';
      const value = sub.toLowerCase().replace(/\s+/g, '-');
      if (!grouped[value]) grouped[value] = { label: sub, value, types: [] };
      const typeVal = (r as any).type?.trim().toLowerCase().replace(/\s+/g, '-');
      if (typeVal && !grouped[value].types.some((t) => t.value === typeVal)) {
        grouped[value].types.push({ label: (r as any).type, value: typeVal });
      }
    }
    return Object.values(grouped);
  }

  /**
   * Load integrations from DB the same way as GrowStack: one card per integration type.
   * Nodemasters are grouped by `type` (e.g. gmail, googlesheets) so we show Gmail, Google Sheets, etc.,
   * not one card per action (Delete Email, Send Email, ...).
   */
  async getIntegrationDetails(userId: string) {
    const aggregated = await this.nodeMasterModel
      .aggregate([
        { $match: { category: 'Integration', isVisible: true } },
        { $sort: { type: 1, _id: 1 } },
        {
          $group: {
            _id: '$type',
            firstDoc: { $first: '$$ROOT' },
          },
        },
        {
          $project: {
            type: '$_id',
            name: { $ifNull: ['$firstDoc.name', '$_id'] },
            logoUrl: '$firstDoc.logoUrl',
            subCategory: '$firstDoc.subCategory',
            category: '$firstDoc.category',
            description: '$firstDoc.description',
          },
        },
      ])
      .exec();

    const user = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();

    return aggregated.map((r: any) => {
      const rawType = r.type?.trim() || '';
      const typeKey = rawType.toLowerCase().replace(/[\s_-]/g, '') || '';
      const userSecretKey = userSecretKeyMap[typeKey] || typeKey;
      const accounts = user?.[userSecretKey] || [];
      const primary = Array.isArray(accounts) ? accounts.find((a: any) => a.isPrimary) : null;
      let status = 'disconnected';
      if (primary?.access_token || primary?.api_key) status = 'connected';
      const connectionMethods = connectionMethodMap[userSecretKey] || { apiKey: false, oauth: true };
      const displayName = rawType.charAt(0).toUpperCase() + rawType.slice(1).replace(/[-_]/g, ' ');
      return {
        userId,
        category: r.category || 'Integration',
        subCategory: r.subCategory || r.category || 'Integration',
        type: typeKey,
        userSecretKey,
        name: displayName,
        logo: r.logoUrl,
        description: r.description || '',
        status,
        email: primary?.email || null,
        connectionMethods,
      };
    });
  }

  async getConnectedAccounts(userId: string, service: string) {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts)) return [];
    return accounts.map((a: any) => ({
      accountId: a.accountId?.toString?.() ?? a.accountId,
      email: a.email,
      userName: a.user_name,
      isPrimary: a.isPrimary || false,
      api_key: a.api_key ? '••••••••••••' : undefined,
      name: a.user_name || a.email || (a.api_key ? 'API Key' : ''),
      meta: a.meta,
    }));
  }

  /** Returns meta.user_id values for OAuth accounts (for duplicate check by external id). */
  async getOAuthAccountMetaIds(userId: string, service: string): Promise<string[]> {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts)) return [];
    return accounts.map((a: any) => a?.meta?.user_id).filter(Boolean);
  }

  async setPrimaryAccount(userId: string, service: string, accountId: string) {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts)) throw new Error(`No connected accounts for ${service}`);
    const updates = accounts.map((a: any) => ({
      ...a,
      isPrimary: a.accountId?.toString() === accountId,
    }));
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: updates } },
    );
    return 'Primary account updated';
  }

  async logActivity(data: { userId: string; action: string; integration: string; accountEmail?: string; accountId?: string; details?: string }) {
    const log = await this.activityLogModel.create(data);
    return { success: true, message: 'Activity logged successfully', id: log._id };
  }

  async getActivityLogs(userId: string, limit = 30) {
    return this.activityLogModel.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  }

  async saveApiKey(userId: string, service: string, apiKey: string, user_name?: string) {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    let doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccount = {
      accountId: new Types.ObjectId(),
      connectionType: 'apikey',
      email: null,
      user_name: user_name || null,
      isPrimary: accounts.length === 0,
      api_key: apiKey,
      created_at: new Date(),
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return { accountId: newAccount.accountId.toString(), success: true };
  }

  async updateApiKey(userId: string, service: string, accountId: string, apiKey: string, user_name?: string) {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts)) throw new Error('No accounts found');
    const id = new Types.ObjectId(accountId);
    const idx = accounts.findIndex((a: any) => a.accountId?.toString?.() === id.toString());
    if (idx < 0) throw new Error('Account not found');
    accounts[idx] = { ...accounts[idx], api_key: apiKey, user_name: user_name ?? accounts[idx].user_name };
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
    );
    return { success: true };
  }

  async disconnectAccount(userId: string, service: string, accountId: string) {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts)) return { success: true };
    const idStr = accountId.toString();
    const filtered = accounts.filter((a: any) => a.accountId?.toString?.() !== idStr);
    if (filtered.length === 0) {
      await this.userSecretsModel.updateOne(
        { user_id: new Types.ObjectId(userId) },
        { $unset: { [key]: 1 } },
      );
    } else {
      if (filtered.every((a: any) => !a.isPrimary) && filtered.length > 0) filtered[0].isPrimary = true;
      await this.userSecretsModel.updateOne(
        { user_id: new Types.ObjectId(userId) },
        { $set: { [key]: filtered } },
      );
    }
    return { success: true };
  }

  async saveGoogleOAuthAccount(
    userId: string,
    service: string,
    data: { access_token: string; refresh_token?: string; email?: string; user_name?: string },
  ): Promise<string> {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    let doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: data.email ?? null,
      user_name: data.user_name ?? data.email ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      created_at: new Date(),
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async saveHubspotOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token: string;
      email?: string;
      meta?: { hub_domain?: string; hub_id?: string; user_id?: string; app_id?: string; expireAt?: Date };
    },
  ): Promise<string> {
    const key = 'hubspot';
    let doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: data.email ?? null,
      user_name: data.email ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      created_at: new Date(),
      meta: data.meta ?? {},
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async saveCalendlyOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token: string;
      email?: string;
      user_name?: string;
      meta?: { user_uri?: string; organization_uri?: string };
    },
  ): Promise<string> {
    const key = 'calendly';
    let doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: data.email ?? null,
      user_name: data.user_name ?? data.email ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      created_at: new Date(),
      meta: data.meta ?? {},
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async getZohoAccounts(userId: string): Promise<{ email?: string }[]> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.zoho;
    return Array.isArray(accounts) ? accounts : [];
  }

  async saveTwitterOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token: string;
      user_name?: string;
      meta?: { user_id?: string };
      refresh_token_expire_at?: Date;
    },
  ): Promise<string> {
    const key = 'twitter';
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: null,
      user_name: data.user_name ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      created_at: new Date(),
      refresh_token_expire_at: data.refresh_token_expire_at ?? null,
      meta: data.meta ?? {},
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async saveLinkedInOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token: string;
      user_name?: string;
      meta?: { user_id?: string };
      refresh_token_expire_at?: Date;
    },
  ): Promise<string> {
    const key = 'linkedin';
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: null,
      user_name: data.user_name ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      created_at: new Date(),
      refresh_token_expire_at: data.refresh_token_expire_at ?? null,
      meta: data.meta ?? {},
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async saveWordPressOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token?: string;
      email?: string;
      user_name?: string;
    },
  ): Promise<string> {
    const key = 'wordpress';
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: data.email ?? null,
      user_name: data.user_name ?? data.email ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      created_at: new Date(),
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  async saveZohoOAuthAccount(
    userId: string,
    data: {
      access_token: string;
      refresh_token: string;
      email?: string;
      user_name?: string;
      location?: string;
    },
  ): Promise<string> {
    const key = 'zoho';
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.[key]) ? [...(doc as any)[key]] : [];
    const newAccountId = new Types.ObjectId();
    const newAccount = {
      accountId: newAccountId,
      connectionType: 'oauth',
      email: data.email ?? null,
      user_name: data.user_name ?? data.email ?? null,
      isPrimary: accounts.length === 0,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      created_at: new Date(),
      location: data.location ?? null,
    };
    accounts.push(newAccount);
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { [key]: accounts } },
      { upsert: true },
    );
    return newAccountId.toString();
  }

  /**
   * Update the primary Calendly account's access_token and refresh_token (e.g. after refresh).
   * Calendly uses single-use refresh tokens; always persist the new refresh_token from the response.
   */
  async updateCalendlyTokens(
    userId: string,
    data: { access_token: string; refresh_token: string },
  ): Promise<void> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = Array.isArray((doc as any)?.calendly) ? [...(doc as any).calendly] : [];
    const primaryIndex = accounts.findIndex((a: any) => a.isPrimary);
    const idx = primaryIndex >= 0 ? primaryIndex : 0;
    if (accounts.length === 0) {
      throw new Error('Calendly not connected. Connect Calendly in Integration Hub first.');
    }
    accounts[idx] = { ...accounts[idx], access_token: data.access_token, refresh_token: data.refresh_token };
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { calendly: accounts } },
    );
  }

  getOAuthLoginUrl(service: string, userId: string): string {
    const connectBase = process.env.CONNECT_BASE_URL || process.env.NEXT_PUBLIC_CONNECT_BASE_URL || '';
    const base = (connectBase || '').replace(/\/$/, '');
    if (!base) {
      console.warn('[IntegrationHub] OAuth login URL is empty: set CONNECT_BASE_URL (or NEXT_PUBLIC_CONNECT_BASE_URL) in backend .env to your orchestration server base URL (e.g. https://api.yourapp.com).');
      return '';
    }
    const path = `/orchestration/${encodeURIComponent(service)}/connect`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${path}${sep}userId=${encodeURIComponent(userId)}`;
  }

  async getOAuthAuthCheck(userId: string, service: string): Promise<{ success: boolean; email?: string; userName?: string; tokenCreatedAt?: string }> {
    const key = userSecretKeyMap[service?.toLowerCase()] || service;
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.[key];
    if (!Array.isArray(accounts) || accounts.length === 0) return { success: false };
    const withToken = accounts.find((a: any) => a.access_token || a.api_key);
    if (!withToken) return { success: false };
    return {
      success: true,
      email: withToken.email ?? undefined,
      userName: withToken.user_name ?? undefined,
      tokenCreatedAt: withToken.created_at ? new Date(withToken.created_at).toISOString() : undefined,
    };
  }

  /**
   * Returns a short-lived access token for Google Drive Picker (for frontend use only).
   * Refreshes the token if needed using the user's stored refresh_token.
   */
  async getDrivePickerToken(userId: string): Promise<{ success: true; accessToken: string } | { success: false; message?: string }> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.gdrive;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { success: false, message: 'Google Drive not connected.' };
    }
    const primary = accounts.find((a: any) => a.isPrimary) ?? accounts[0];
    const refreshToken = primary?.refresh_token;
    if (!refreshToken) {
      return { success: false, message: 'Google Drive token missing. Please reconnect in Integration Hub.' };
    }
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.config.get<string>('GOOGLE_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) {
      return { success: false, message: 'Google OAuth not configured on server.' };
    }
    try {
      const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
      oauth2.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await oauth2.refreshAccessToken();
      const accessToken = credentials.access_token;
      if (!accessToken) return { success: false, message: 'Failed to refresh token.' };
      return { success: true, accessToken };
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Failed to get Drive token.' };
    }
  }
}
