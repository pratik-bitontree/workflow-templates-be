import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_ROWS = 2000;

function extractSpreadsheetId(spreadsheetUrl: string): string | null {
  if (!spreadsheetUrl || typeof spreadsheetUrl !== 'string') return null;
  const m = spreadsheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function transformGridData(gridData: any[][]): { headers: string[]; data: any[] } {
  if (!gridData || gridData.length === 0) return { headers: [], data: [] };
  if (Array.isArray(gridData[0]) && Array.isArray(gridData[0][0])) gridData = gridData[0];
  if (!Array.isArray(gridData[0]) || typeof gridData[0][0] === 'object') return { headers: [], data: [] };
  const headers = gridData[0]?.map((h: any) => String(h || '').trim()) || [];
  const rows = gridData.slice(1);
  const data = rows.map((row: any[]) =>
    headers.reduce((obj: any, header, index) => {
      obj[header] = row[index] !== undefined ? String(row[index]).trim() : '';
      return obj;
    }, {}),
  );
  return { headers, data };
}

@Injectable()
export class GsheetsService {
  private readonly logger = new Logger(GsheetsService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    const cid = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const csec = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const ruri = this.configService.get<string>('GOOGLE_REDIRECT_URI');
    if (!cid || !csec || !ruri) {
      throw new Error('Missing Google OAuth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI');
    }
    this.clientId = cid;
    this.clientSecret = csec;
    this.redirectUri = ruri;
  }

  private async getAccessToken(userId: string): Promise<string> {
    if (!userId) throw new BadRequestException('User ID is required for Google Sheets');
    const doc = await this.userSecretsModel
      .findOne({ user_id: new Types.ObjectId(userId), 'gsheets.isPrimary': true })
      .select({ gsheets: { $elemMatch: { isPrimary: true } } })
      .lean();
    const primary = (doc as any)?.gsheets?.[0];
    if (!primary?.refresh_token) {
      throw new BadRequestException('Google Sheets not connected. Connect Google Sheets in Integration Hub.');
    }
    const oauth2Client = new OAuth2Client(this.clientId, this.clientSecret, this.redirectUri);
    oauth2Client.setCredentials({
      refresh_token: primary.refresh_token,
      access_token: primary.access_token,
    });
    const { credentials } = await oauth2Client.refreshAccessToken();
    return credentials.access_token!;
  }

  /**
   * Read sheet data and return shape compatible with workflow (GridData.data for fanout).
   */
  async readSheetData({
    spreadsheetUrl,
    dataRange,
    rowsToRetrieve,
    userId,
  }: {
    spreadsheetUrl: string;
    dataRange?: string;
    rowsToRetrieve?: number | string;
    userId: string;
  }): Promise<{ GridData: { headers: string[]; data: any[] }; Status: string; spreadsheetId: string }> {
    if (!spreadsheetUrl) throw new BadRequestException('Spreadsheet URL is required.');
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
    if (!spreadsheetId) throw new BadRequestException('Invalid spreadsheet URL.');
    const token = await this.getAccessToken(userId);
    const limit = Math.min(
      typeof rowsToRetrieve === 'number' ? rowsToRetrieve : parseInt(String(rowsToRetrieve || MAX_ROWS), 10) || MAX_ROWS,
      MAX_ROWS,
    );
    const range = dataRange && String(dataRange).trim() ? String(dataRange).trim() : `A1:Z${Math.min(limit + 1, 2001)}`;
    try {
      const { data } = await axios.get(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        {
          params: { valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' },
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const values = data?.values || [];
      const gridData = transformGridData(values);
      return {
        Status: 'Data retrieved successfully',
        spreadsheetId,
        GridData: gridData,
      };
    } catch (err: any) {
      const status = err.response?.status;
      const message = err.response?.data?.error?.message || err.message;
      this.logger.warn(`readSheetData error: ${message}`);
      if (status === 403) {
        throw new BadRequestException(
          "You don't have permission to access this spreadsheet. Share it with your Google account.",
        );
      }
      if (status === 404) {
        throw new BadRequestException('Spreadsheet not found. Check the URL.');
      }
      throw new BadRequestException(message || 'Error fetching sheet data');
    }
  }
}
