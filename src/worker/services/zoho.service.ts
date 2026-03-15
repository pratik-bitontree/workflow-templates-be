import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

function removeEmptyValues<T extends Record<string, any>>(obj: T): Partial<T> {
  if (obj == null || typeof obj !== 'object') return obj;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const nested = removeEmptyValues(v as Record<string, any>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

export interface SearchRecordsZohoDto {
  ModuleName: string;
  SearchType: string;
  RecordIds?: string[];
  Filters?: { fieldName?: string; field?: string; operator: string; value: any }[];
  FilterLogic?: string;
  CustomLogicExpression?: string;
}

export interface CreateZohoContactDto {
  First_Name?: string;
  Last_Name: string;
  Email?: string;
  Phone?: string;
  Title?: string;
  Department?: string;
  Home_Phone?: string;
  Other_Phone?: string;
  Mobile?: string;
  Fax?: string;
  Assistant?: string;
  Asst_Phone?: string;
  Skype_ID?: string;
  Secondary_Email?: string;
  Twitter?: string;
  Date_of_Birth?: string;
  Lead_Source?: string;
  Account_Name?: string;
  additionalFields?: Record<string, string>;
}

export interface UpdateZohoContactDto extends CreateZohoContactDto {
  recordId: string;
}

@Injectable()
export class ZohoService {
  private readonly logger = new Logger(ZohoService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly axios: AxiosInstance = axios.create({ timeout: 30000 });

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.clientId = (this.configService.get<string>('ZOHO_CLIENT_ID') || '').trim();
    this.clientSecret = (this.configService.get<string>('ZOHO_CLIENT_SECRET') || '').trim();
    this.redirectUri = (this.configService.get<string>('ZOHO_REDIRECT_URI') || '').trim();
  }

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

  private async getValidAccessToken(userId: string): Promise<{ accessToken: string; baseUrl: string; authUrl: string }> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.zoho;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new BadRequestException('Zoho not connected. Please connect Zoho in Integration Hub first.');
    }
    const primary = accounts.find((a: any) => a.isPrimary) || accounts[0];
    const region = primary?.location;
    const { authUrl, baseUrl } = this.getZohoRegionUrls(region);
    let accessToken = primary?.access_token;
    const refreshToken = primary?.refresh_token;
    if (!accessToken && refreshToken && this.clientId && this.clientSecret) {
      const tokenRes = await this.axios.post(
        `${authUrl}/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      const data = tokenRes.data;
      accessToken = data.access_token;
      if (data.refresh_token) {
        const idx = accounts.findIndex((a: any) => a.isPrimary || a === primary);
        const acc = idx >= 0 ? accounts[idx] : accounts[0];
        const updated = [...accounts];
        updated[idx >= 0 ? idx : 0] = { ...acc, access_token: accessToken, refresh_token: data.refresh_token };
        await this.userSecretsModel.updateOne(
          { user_id: new Types.ObjectId(userId) },
          { $set: { zoho: updated } },
        );
      }
    }
    if (!accessToken) {
      throw new BadRequestException('Zoho not connected. Please reconnect Zoho in Integration Hub.');
    }
    return { accessToken, baseUrl, authUrl };
  }

  async makeZohoRequest(userId: string, method: string, endpoint: string, data?: any): Promise<any> {
    const { accessToken, baseUrl } = await this.getValidAccessToken(userId);
    const response = await this.axios.request({
      method,
      url: `${baseUrl}${endpoint}`,
      data,
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (response.data?.data && Array.isArray(response.data.data)) {
      const invalid = response.data.data.find((item: any) => item?.code === 'INVALID_DATA');
      if (invalid) {
        const msg = invalid.message || 'Invalid data provided';
        const details = invalid.details ? ` (${invalid.details.api_name}: ${invalid.details.expected_data_type})` : '';
        throw new BadRequestException(msg + details);
      }
    }
    return response.data;
  }

  private buildCriteriaString(filters: any[], filterLogic: string, customLogicExpression?: string): string {
    const parts = (filters || []).map((f) => {
      const fieldName = f.fieldName || f.field;
      const operator = (f.operator || 'equals').toLowerCase().replace(/\s/g, '_');
      const operatorMap: Record<string, string> = {
        equals: 'equals',
        not_equal: 'not_equal',
        starts_with: 'starts_with',
        in: 'in',
        greater_than: 'greater_than',
        greater_equal: 'greater_equal',
        greater_than_or_equal: 'greater_equal',
        less_than: 'less_than',
        less_equal: 'less_equal',
        less_than_or_equal: 'less_equal',
        between: 'between',
      };
      const zohoOp = operatorMap[operator] || operator;
      const value = f.value;
      return `${fieldName}:${zohoOp}:${value}`;
    });
    const logic = (filterLogic || 'and').toLowerCase();
    return parts.join(logic === 'or' ? ')or(' : ')and(');
  }

  async searchRecordsZohoCRM(userId: string, dto: SearchRecordsZohoDto): Promise<any> {
    const { ModuleName, SearchType, RecordIds, Filters, FilterLogic, CustomLogicExpression } = dto;
    if (SearchType === 'record') {
      const ids = Array.isArray(RecordIds) ? RecordIds : (RecordIds ? String(RecordIds).split(',').map((s) => s.trim()) : []);
      if (ids.length === 0) {
        throw new BadRequestException('RecordIds are required for record search');
      }
      if (ids.length === 1) {
        return this.makeZohoRequest(userId, 'GET', `/crm/v2/${ModuleName}/${ids[0]}`);
      }
      return this.makeZohoRequest(userId, 'GET', `/crm/v2/${ModuleName}?ids=${ids.join(',')}`);
    }
    if (SearchType === 'filter') {
      if (!Array.isArray(Filters) || Filters.length === 0) {
        throw new BadRequestException('Filters are required');
      }
      const criteriaString = this.buildCriteriaString(Filters, FilterLogic || 'and', CustomLogicExpression);
      const params = new URLSearchParams({ criteria: criteriaString });
      const response = await this.makeZohoRequest(userId, 'GET', `/crm/v8/${ModuleName}/search?${params.toString()}`);
      if (!response?.data || (Array.isArray(response.data) && response.data.length === 0)) {
        return { data: [{ message: 'No records found' }] };
      }
      return response;
    }
    throw new BadRequestException('Invalid searchType');
  }

  async createContactRecordZohoCRM(userId: string, dto: CreateZohoContactDto): Promise<any> {
    if (!dto.Last_Name) {
      throw new BadRequestException('Last Name is required');
    }
    const { additionalFields, ...base } = dto;
    const merged = { ...removeEmptyValues(base), ...(additionalFields || {}) };
    return this.makeZohoRequest(userId, 'POST', '/crm/v2/Contacts', { data: [merged] });
  }

  async updateContactRecordZohoCRM(userId: string, dto: UpdateZohoContactDto): Promise<any> {
    const { recordId, additionalFields, ...base } = dto;
    if (!recordId) {
      throw new BadRequestException('Record ID is required');
    }
    const merged = { ...removeEmptyValues(base), ...(additionalFields || {}) };
    return this.makeZohoRequest(userId, 'PUT', `/crm/v2/Contacts/${recordId}`, { data: [merged] });
  }
}
