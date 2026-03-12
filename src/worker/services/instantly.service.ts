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
}
