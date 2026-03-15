import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

const CAL_API_BASE = 'https://api.cal.com/v2';

export interface CreateCalWebhookDto {
  subscriberUrl: string;
  triggers: string[];
}

@Injectable()
export class CalService {
  private readonly logger = new Logger(CalService.name);
  private readonly axiosInstance: AxiosInstance;

  constructor(
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.axiosInstance = axios.create({
      baseURL: CAL_API_BASE,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getCalApiKey(userId: string): Promise<string> {
    if (!userId) throw new BadRequestException('User ID is required for Cal.com');
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.cal;
    const primary = Array.isArray(accounts) ? accounts.find((a: any) => a.isPrimary === true) : null;
    const account = primary ?? (Array.isArray(accounts) ? accounts[0] : null);
    const apiKey = account?.api_key;
    if (!apiKey) {
      throw new BadRequestException('Cal.com API key not found. Connect Cal.com in Integration Hub.');
    }
    return apiKey;
  }

  async makeCalApiCall(userId: string, url: string, method: string, data?: any): Promise<any> {
    const apiKey = await this.getCalApiKey(userId);
    try {
      const response = await this.axiosInstance.request({
        url,
        method,
        data,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Cal.com API error: ${error?.message}`,
        error?.response?.data ?? error?.stack,
      );
      if (error?.response?.status === 409) {
        throw new BadRequestException('Webhook already exists. Please delete the existing webhook and try again.');
      }
      if (error?.response?.status === 401) {
        throw new BadRequestException('Invalid Cal.com API key. Please check your API key and try again.');
      }
      throw new BadRequestException(
        error?.response?.data?.message || error?.message || 'Cal.com API request failed',
      );
    }
  }

  async createWebhook(userId: string, dto: CreateCalWebhookDto): Promise<any> {
    const payload = {
      ...dto,
      active: true,
    };
    return this.makeCalApiCall(userId, '/webhooks', 'POST', payload);
  }
}
