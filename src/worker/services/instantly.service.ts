import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

// Instantly campaign analytics endpoints exist in v2; v1 returns 404
const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';

@Injectable()
export class InstantlyService {
  private readonly logger = new Logger(InstantlyService.name);
  private readonly baseUrl: string;
  private readonly axiosInstance: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.baseUrl =
      this.configService.get<string>('INSTANTLY_BASE_URL') ||
      this.configService.get<string>('INSTANTLY_API_URL') ||
      INSTANTLY_API_BASE;
    this.axiosInstance = axios.create({ baseURL: this.baseUrl, timeout: 30000 });
  }

  private async getPrimaryAccount(userId: string): Promise<{ api_key: string }> {
    if (!userId) throw new BadRequestException('User ID is required for Instantly');
    const doc = await this.userSecretsModel
      .findOne({ user_id: new Types.ObjectId(userId) })
      .lean();
    const arr = (doc as any)?.instantly;
    const primary = Array.isArray(arr) ? arr.find((a: any) => a.isPrimary === true) : null;
    if (!primary?.api_key) {
      throw new BadRequestException('Instantly API key not found. Connect Instantly in Integration Hub.');
    }
    return primary;
  }

  async getCampaignAnalytics(
    userId: string,
    query: { ids?: string[]; start_date?: string; end_date?: string; exclude_total_leads_count?: boolean },
  ): Promise<any> {
    const params = new URLSearchParams();
    if (query.ids?.length) query.ids.forEach((id) => params.append('ids', id));
    if (query.start_date) params.append('start_date', query.start_date);
    if (query.end_date) params.append('end_date', query.end_date);
    if (query.exclude_total_leads_count !== undefined) {
      params.append('exclude_total_leads_count', String(query.exclude_total_leads_count));
    }
    const endpoint = params.toString() ? `/campaigns/analytics?${params.toString()}` : '/campaigns/analytics';
    const { api_key } = await this.getPrimaryAccount(userId);
    const { data } = await this.axiosInstance.get(endpoint, {
      headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
    });
    return data;
  }

  async getDailyCampaignAnalytics(userId: string, query: 
    { campaign_id: string; start_date?: string; end_date?: string; campaign_status?: number },
  ): Promise<any> {
    try {
      const queryParams = new URLSearchParams();
      
      const isValidValue = (value: any) => value !== undefined && value !== null && value !== '';
      
      if (isValidValue(query.campaign_id)) queryParams.append('campaign_id', query.campaign_id);
      if (isValidValue(query.start_date)) queryParams.append('start_date', query.start_date as string);
      if (isValidValue(query.end_date)) queryParams.append('end_date', query.end_date as string);
      if (isValidValue(query.campaign_status) && query.campaign_status !== undefined) {
        queryParams.append('campaign_status', query.campaign_status.toString());
      }

      const queryString = queryParams.toString();
      const endpoint = `/campaigns/analytics/daily?${queryString}`;
      
      const { api_key } = await this.getPrimaryAccount(userId);
      const { data } = await this.axiosInstance.get(endpoint, {
        headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      });
      return data;
    } catch (error) {
      this.logger.error(`[getDailyCampaignAnalytics] Error getting daily campaign analytics: ${error.message}`);
      throw new BadRequestException(`Failed to get daily campaign analytics: ${error.message}`);
    }
  }

  /**
   * Reply to an email in Instantly (Instantly API v2 POST /emails/reply).
   * Used by Campaign Reply Alert & Auto-Responder workflow.
   */
  async replyToInstantlyEmail(
    userId: string,
    payload: {
      reply_to_uuid: string;
      eaccount: string;
      body: { text?: string; html?: string };
      subject: string;
      cc_address_email_list?: string | string[];
      bcc_address_email_list?: string | string[];
      reminder_ts?: string;
    },
  ): Promise<any> {
    const { api_key } = await this.getPrimaryAccount(userId);
    const body = {
      reply_to_uuid: payload.reply_to_uuid,
      eaccount: payload.eaccount,
      body: payload.body,
      subject: payload.subject,
      ...(payload.cc_address_email_list != null ? { cc_address_email_list: payload.cc_address_email_list } : {}),
      ...(payload.bcc_address_email_list != null ? { bcc_address_email_list: payload.bcc_address_email_list } : {}),
      ...(payload.reminder_ts != null ? { reminder_ts: payload.reminder_ts } : {}),
    };
    try {
      const { data } = await this.axiosInstance.post('/emails/reply', body, {
        headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      });
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        this.logger.warn(
          `[replyToInstantlyEmail] Instantly API 404. reply_to_uuid and eaccount must be real values from an Instantly webhook (e.g. real email_id and email_account). Got reply_to_uuid=${payload.reply_to_uuid} eaccount=${payload.eaccount}`,
        );
        throw new BadRequestException(
          'Instantly returned 404: the email or account was not found. For real runs use email_id and email_account from the Instantly reply webhook. Test payloads like "test-email-uuid-123" / "your-instantly-account-id" are not valid.',
        );
      }
      throw err;
    }
  }

  /**
   * Create an Instantly webhook (mirrors monorepo InstantlyService.createWebhook).
   * Payload: campaign, name, target_hook_url, event_type.
   */
  async createWebhook(
    userId: string,
    payload: { campaign?: string; name: string; target_hook_url: string; event_type: string },
  ): Promise<any> {
    const { api_key } = await this.getPrimaryAccount(userId);
    const body = {
      ...(payload.campaign != null && payload.campaign !== '' ? { campaign: payload.campaign } : {}),
      name: payload.name,
      target_hook_url: payload.target_hook_url,
      event_type: payload.event_type,
    };
    const { data } = await this.axiosInstance.post('/webhooks', body, {
      headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
    });
    return data;
  }

  /**
   * Create an Instantly campaign (Instantly API v2 POST /campaigns).
   * Used by Automated Email Outreach Campaign template.
   */
  async createCampaign(
    userId: string,
    campaignData: {
      name: string;
      campaign_schedule: {
        schedules: Array<{
          name: string;
          timing: { from: string; to: string };
          timezone: string;
          days: Record<string, boolean>;
        }>;
        start_date?: string;
        end_date?: string;
      };
      allow_risky_contacts?: boolean;
      is_evergreen?: boolean;
      pl_value?: number;
      sequences?: Array<{ steps: Array<{ type: string; delay?: number; variants: Array<{ subject: string; body: string }> }> }>;
      email_gap?: number;
      random_wait_max?: number;
      text_only?: boolean;
      email_list?: string[];
      daily_limit?: number;
      stop_on_reply?: boolean;
      link_tracking?: boolean;
      open_tracking?: boolean;
      daily_max_leads?: number;
      prioritize_new_leads?: boolean;
      email_tag_list?: string[];
    },
  ): Promise<any> {
    const { api_key } = await this.getPrimaryAccount(userId);
    try {
      const { data } = await this.axiosInstance.post('/campaigns', campaignData, {
        headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      });
      if (data?.id) {
        await this.axiosInstance.post(
          `/campaigns/${data.id}/activate`,
          { campaignId: data.id },
          { headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' } },
        );
      }
      return data;
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to create campaign';
      this.logger.error(`[createCampaign] ${msg}`);
      throw new BadRequestException(msg);
    }
  }

  /**
   * List Instantly custom tags. Used to resolve sender email tags for campaigns.
   * Tries API v2 path first (GET /customtag/listcustomtag), then v1-style GET /custom-tags on 400/404.
   */
  async listCustomTags(
    userId: string,
    options?: { limit?: number; search?: string; starting_after?: string },
  ): Promise<any> {
    const { api_key } = await this.getPrimaryAccount(userId);
    const headers = { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' };

    // Only include params with valid values (avoid sending empty string or 0 if API is strict)
    const queryParams = new URLSearchParams();
    if (options?.limit != null && options.limit > 0) queryParams.append('limit', String(options.limit));
    if (options?.search != null && String(options.search).trim() !== '') queryParams.append('search', String(options.search).trim());
    if (options?.starting_after != null && String(options.starting_after).trim() !== '') queryParams.append('starting_after', String(options.starting_after).trim());
    const queryString = queryParams.toString();

    // Try v2 path first: GET /customtag/listcustomtag (Instantly API v2)
    const v2Endpoint = queryString ? `/customtag/listcustomtag?${queryString}` : '/customtag/listcustomtag';
    try {
      const { data } = await this.axiosInstance.get(v2Endpoint, { headers });
      return this.normalizeListCustomTagsResponse(data);
    } catch (err: any) {
      const status = err?.response?.status;
      const errData = err?.response?.data;

      // If v2 returns 400/404, try v1-style GET /custom-tags (some keys or regions may still use v1)
      if (status === 400 || status === 404) {
        this.logger.warn(
          `[listCustomTags] v2 path returned ${status}, trying v1 /custom-tags. Response: ${JSON.stringify(errData ?? err?.message)}`,
        );
        try {
          const v1Endpoint = queryString ? `/custom-tags?${queryString}` : '/custom-tags';
          const { data } = await this.axiosInstance.get(v1Endpoint, { headers });
          return this.normalizeListCustomTagsResponse(data);
        } catch (v1Err: any) {
          const v1Status = v1Err?.response?.status;
          const v1Data = v1Err?.response?.data;
          const msg =
            v1Data?.message ?? v1Data?.error ?? v1Err?.message ?? 'Failed to list custom tags';
          this.logger.error(`[listCustomTags] v1 also failed: ${v1Status} - ${JSON.stringify(v1Data ?? msg)}`);
          throw new BadRequestException(
            `Instantly list custom tags failed (${v1Status ?? 'error'}): ${msg}. Ensure your API key is for the correct Instantly API version (v1 vs v2).`,
          );
        }
      }

      const msg = errData?.message ?? errData?.error ?? err?.message ?? 'Failed to list custom tags';
      this.logger.error(`[listCustomTags] ${status ?? 'error'} - ${JSON.stringify(errData ?? msg)}`);
      throw new BadRequestException(`Instantly list custom tags failed: ${msg}`);
    }
  }

  private normalizeListCustomTagsResponse(data: any): any {
    if (data?.items && Array.isArray(data.items)) {
      data.items = data.items.map((item: any) => ({ ...item, value: item.id }));
    }
    return data;
  }
}
