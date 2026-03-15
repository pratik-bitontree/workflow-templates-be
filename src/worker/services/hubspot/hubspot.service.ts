import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../../schemas/user-secrets.schema';
import {
  CreateContactDto,
  SearchRecordsDto,
  UpdateContactDto,
} from './hubspot.dto';
import { HUBSPOT_CONTACT_SEARCH_PROPERTIES } from './hubspot.constant';

const VALID_RECORD_TYPES = ['contacts'];

@Injectable()
export class HubspotService {
  private readonly logger = new Logger(HubspotService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.baseUrl = (this.configService.get<string>('HUBSPOT_API_URL') || 'https://api.hubapi.com').replace(/\/+$/, '');
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async getValidAccessToken(userId: string): Promise<string> {
    if (!userId) {
      throw new HttpException('HubSpot requires userId', HttpStatus.UNAUTHORIZED);
    }
    const doc = await this.userSecretsModel
      .findOne({ user_id: new Types.ObjectId(userId) })
      .lean();
    const accounts = (doc as any)?.hubspot;
    const list = Array.isArray(accounts) ? accounts : [];
    const primary = list.find((a: any) => a.isPrimary === true) || list[0];
    if (!primary?.access_token) {
      throw new HttpException('HubSpot not connected', HttpStatus.UNAUTHORIZED);
    }
    const expireAt = primary.meta?.expireAt;
    const now = new Date();
    if (expireAt && new Date(expireAt) <= now && primary.refresh_token) {
      return this.refreshAndSaveToken(userId, primary);
    }
    return primary.access_token;
  }

  private async refreshAndSaveToken(userId: string, primary: any): Promise<string> {
    const clientId = this.configService.get<string>('HUBSPOT_CLIENT_ID');
    const clientSecret = this.configService.get<string>('HUBSPOT_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new HttpException('HubSpot OAuth not configured', HttpStatus.UNAUTHORIZED);
    }
    try {
      const res = await this.axiosInstance.post(
        '/oauth/v1/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: primary.refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      const data = res.data;
      const newAccess = data.access_token;
      const newRefresh = data.refresh_token || primary.refresh_token;
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 21600;
      const expireAt = new Date(Date.now() + expiresIn * 1000);
      const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
      const accounts = Array.isArray((doc as any)?.hubspot) ? [...(doc as any).hubspot] : [];
      const idx = accounts.findIndex(
        (a: any) => (a.accountId?.toString?.() ?? a.accountId) === (primary.accountId?.toString?.() ?? primary.accountId),
      );
      if (idx >= 0) {
        accounts[idx] = {
          ...accounts[idx],
          access_token: newAccess,
          refresh_token: newRefresh,
          meta: { ...(accounts[idx].meta || {}), expireAt },
        };
        await this.userSecretsModel.updateOne(
          { user_id: new Types.ObjectId(userId) },
          { $set: { hubspot: accounts } },
        );
      }
      return newAccess;
    } catch (err: any) {
      this.logger.warn(`HubSpot token refresh failed: ${err?.message}`);
      throw new HttpException('Failed to refresh HubSpot token', HttpStatus.UNAUTHORIZED);
    }
  }

  private async makeRequest(userId: string, method: string, endpoint: string, data?: any): Promise<any> {
    const token = await this.getValidAccessToken(userId);
    try {
      const res = await this.axiosInstance.request({
        method,
        url: endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 401) {
        throw new HttpException('HubSpot authentication failed', HttpStatus.UNAUTHORIZED);
      }
      if (err?.response?.status === 404) {
        throw new HttpException('Resource not found in HubSpot', HttpStatus.NOT_FOUND);
      }
      throw new HttpException(
        err?.response?.data?.message || err?.message || 'HubSpot API request failed',
        err?.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private validateRecordType(recordType: string): void {
    if (!VALID_RECORD_TYPES.includes(recordType?.toLowerCase())) {
      throw new BadRequestException(
        `Invalid record type: ${recordType}. Valid types: ${VALID_RECORD_TYPES.join(', ')}`,
      );
    }
  }

  async getContactProperties(userId: string, recordType: string = 'contacts'): Promise<any[]> {
    const token = await this.getValidAccessToken(userId);
    const url = `${this.baseUrl}/properties/v2/${recordType}/properties`;
    const res = await this.axiosInstance.get(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = res.data || [];
    const supported = ['text', 'textarea', 'phonenumber', 'number', 'date', 'booleancheckbox', 'checkbox', 'radio', 'select', 'file'];
    const ignore = ['firstname', 'lastname', 'email', 'jobtitle', 'company', 'hubspot_owner_id', 'lifecyclestage', 'hs_lead_status', 'createdby', 'modifieddate', 'modifiedby', 'hs_object_id'];
    return data
      .filter((p: any) => !ignore.includes(p.name))
      .map((p: any) => ({
        value: p.name,
        label: p.label,
        type: p.type,
        fieldType: p.fieldType,
      }));
  }

  private convertValueByType(value: any, type: string): any {
    if (value === null || value === undefined || value === '') return null;
    switch ((type || '').toLowerCase()) {
      case 'string':
        return String(value);
      case 'number':
        const n = Number(value);
        return isNaN(n) ? null : n;
      case 'bool':
      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const v = value.toLowerCase();
          if (v === 'true' || v === '1') return true;
          if (v === 'false' || v === '0') return false;
        }
        return Boolean(value);
      case 'datetime':
      case 'date':
        return String(value);
      default:
        return String(value);
    }
  }

  async searchRecords(userId: string, recordType: string, dto: SearchRecordsDto): Promise<any> {
    this.validateRecordType(recordType);
    const properties = dto.properties?.length ? dto.properties : HUBSPOT_CONTACT_SEARCH_PROPERTIES;
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'email',
              operator: 'EQ',
              value: dto.query?.trim() || '',
            },
          ],
        },
      ],
      properties,
    };
    return this.makeRequest(userId, 'POST', `/crm/v3/objects/${recordType}/search`, body);
  }

  async createContact(userId: string, dto: CreateContactDto): Promise<any> {
    const { additionalFields, ...base } = dto.properties;
    let merged: Record<string, any> = { ...base };
    if (additionalFields && Object.keys(additionalFields).length > 0) {
      const props = await this.getContactProperties(userId);
      const map = new Map(props.map((p: any) => [p.value, p]));
      for (const [key, val] of Object.entries(additionalFields)) {
        const p = map.get(key);
        const converted = p ? this.convertValueByType(val, p.type) : val;
        if (converted != null) merged[key] = converted;
      }
    }
    return this.makeRequest(userId, 'POST', '/crm/v3/objects/contacts', { properties: merged });
  }

  async updateContact(userId: string, recordId: string, dto: UpdateContactDto): Promise<any> {
    const { additionalFields, ...base } = dto.properties;
    let merged: Record<string, any> = { ...base };
    if (additionalFields && Object.keys(additionalFields).length > 0) {
      const props = await this.getContactProperties(userId);
      const map = new Map(props.map((p: any) => [p.value, p]));
      for (const [key, val] of Object.entries(additionalFields)) {
        const p = map.get(key);
        const converted = p ? this.convertValueByType(val, p.type) : val;
        if (converted != null) merged[key] = converted;
      }
    }
    return this.makeRequest(userId, 'PATCH', `/crm/v3/objects/contacts/${recordId}`, { properties: merged });
  }
}
