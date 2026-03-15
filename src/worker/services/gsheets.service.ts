import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_ROWS = 2000;

function indexToColumnLetter(index: number): string {
  let columnLetter = '';
  let dividend = index + 1;
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnLetter = String.fromCharCode(modulo + 65) + columnLetter;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return columnLetter;
}

function flattenValue(value: any): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const num = parseFloat(trimmed);
      return Number.isFinite(num) ? num : trimmed;
    }
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        return flattenValue(parsed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) return value.map(flattenValue).join(', ');
  if (typeof value === 'object') {
    try {
      const entries = Object.entries(value);
      if (entries.length === 0) return '';
      return entries
        .map(([k, v]) => `${k}: ${flattenValue(v)}`)
        .join(', ');
    } catch {
      return JSON.stringify(value);
    }
  }
  // Symbol, function, bigint, etc. – coerce to string so we never write [object Object]
  return String(value);
}

/** Ensures a value is safe for a sheet cell (string, number, or boolean). Never returns an object. */
function toSheetCell(value: any): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return flattenValue(value);
  return String(value);
}

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

  /** Get list of sheets in a spreadsheet (sheetId, sheetTitle) for batchUpdate. */
  async getListOfSheets({
    spreadsheetUrl,
    userId,
  }: {
    spreadsheetUrl: string;
    userId: string;
  }): Promise<{ sheetId: number; sheetTitle: string }[]> {
    if (!spreadsheetUrl?.trim()) throw new BadRequestException('Spreadsheet URL is required.');
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
    if (!spreadsheetId) throw new BadRequestException('Invalid spreadsheet URL.');
    const token = await this.getAccessToken(userId);
    const { data } = await axios.get(`${SHEETS_API_BASE}/${spreadsheetId}`, {
      params: { fields: 'sheets.properties.sheetId,sheets.properties.title' },
      headers: { Authorization: `Bearer ${token}` },
    });
    const sheets = data?.sheets;
    if (!Array.isArray(sheets) || sheets.length === 0) {
      throw new BadRequestException('No sheets found in spreadsheet.');
    }
    return sheets.map((s: any) => ({
      sheetId: s.properties?.sheetId ?? 0,
      sheetTitle: s.properties?.title ?? 'Sheet1',
    }));
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

  /**
   * Append one or more columns to a sheet (mirrors monorepo appendColumnToSheet).
   */
  async appendColumnToSheet({
    spreadsheetUrl,
    sheetData,
    newValues,
    userId,
  }: {
    spreadsheetUrl: string;
    sheetData?: { sheetId: number; sheetTitle: string };
    newValues?: { columnName: string; values?: any[] }[];
    userId: string;
  }): Promise<Record<string, unknown>> {
    if (!spreadsheetUrl?.trim()) throw new BadRequestException('Spreadsheet URL is required.');
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
    if (!spreadsheetId) throw new BadRequestException('Invalid spreadsheet URL.');
    let sheet = sheetData;
    if (!sheet || sheet.sheetId == null) {
      const list = await this.getListOfSheets({ spreadsheetUrl, userId });
      if (list.length === 0) throw new BadRequestException('No sheets found.');
      sheet = list[0];
    }
    const sheetId = sheet!.sheetId;
    const sheetTitle = sheet!.sheetTitle;
    const token = await this.getAccessToken(userId);
    const { GridData } = await this.readSheetData({
      spreadsheetUrl,
      dataRange: 'A1:Z',
      userId,
    });
    const colCount = GridData.headers.length;
    let startIndex = colCount;
    if (!Array.isArray(newValues) || newValues.length === 0) {
      throw new BadRequestException('newValues are required.');
    }
    const requests: any[] = [];
    newValues.forEach((_col, index) => {
      const currentIndex = startIndex + index;
      requests.push({
        insertDimension: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: currentIndex,
            endIndex: currentIndex + 1,
          },
          inheritFromBefore: currentIndex !== 0,
        },
      });
    });
    await axios.post(
      `${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`,
      { requests },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const failedRecords: any[] = [];
    const validateValue = (value: any, columnName = '', recordIndex = -1): any => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && value.length > 50000) {
        failedRecords.push({ columnName, recordIndex, originalLength: value.length });
        return '';
      }
      return value;
    };
    const batchSize = 20;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const headersConfig = { headers: { Authorization: `Bearer ${token}` } };
    const batchResponses: any[] = [];

    for (let idx = 0; idx < newValues.length; idx++) {
      const col = newValues[idx];
      const columnLetter = indexToColumnLetter(startIndex + idx);
      let filledColumnValues: any[];
      if (col.values?.length) {
        const value = col.values[0];
        try {
          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (Array.isArray(parsed)) {
            filledColumnValues = parsed.map((item: any, recordIndex: number) =>
              validateValue(toSheetCell(flattenValue(item)), col.columnName, recordIndex),
            );
          } else {
            filledColumnValues = [validateValue(toSheetCell(flattenValue(parsed)), col.columnName, 0)];
          }
        } catch {
          filledColumnValues = [validateValue(toSheetCell(flattenValue(value)), col.columnName, 0)];
        }
      } else {
        filledColumnValues = Array.from({ length: Math.max(0, GridData.data.length) }, () => '');
      }
      const totalRows = filledColumnValues.length;
      const firstChunkLen = Math.min(batchSize, totalRows);
      const firstBatch = {
        data: [
          {
            range: `${sheetTitle}!${columnLetter}1:${columnLetter}${firstChunkLen + 1}`,
            majorDimension: 'ROWS' as const,
            values: [
              [validateValue(toSheetCell(col.columnName), `${col.columnName}_header`, -1)],
              ...filledColumnValues.slice(0, firstChunkLen).map((v) => [validateValue(toSheetCell(v))]),
            ],
          },
        ],
        valueInputOption: 'RAW' as const,
      };
      const firstResp = await axios.post(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        firstBatch,
        headersConfig,
      );
      if (firstResp.status !== 200) throw new BadRequestException('Failed to append column.');
      batchResponses.push(firstResp.data?.responses);
      await sleep(1100);
      for (let start = firstChunkLen; start < totalRows; start += batchSize) {
        const end = Math.min(start + batchSize, totalRows);
        const startRow = 2 + start;
        const endRow = 1 + end;
        const batchBody = {
          data: [
            {
              range: `${sheetTitle}!${columnLetter}${startRow}:${columnLetter}${endRow}`,
              majorDimension: 'ROWS' as const,
              values: filledColumnValues.slice(start, end).map((v) => [validateValue(toSheetCell(v))]),
            },
          ],
          valueInputOption: 'RAW' as const,
        };
        const resp = await axios.post(
          `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
          batchBody,
          headersConfig,
        );
        if (resp.status !== 200) throw new BadRequestException('Failed to append column.');
        batchResponses.push(resp.data?.responses);
        await sleep(1100);
      }
    }

    // Return Data with values as flattened primitives so response never shows [object Object]
    const dataWithFlattenedValues = newValues.map((col) => ({
      columnName: col.columnName,
      values: Array.isArray(col.values) ? col.values.map((v: any) => toSheetCell(flattenValue(v))) : [],
    }));

    return {
      Status: 'New column is inserted successfully',
      SpreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
      SpreadsheetId: spreadsheetId,
      Data: dataWithFlattenedValues,
      details: batchResponses,
      failedRecords: failedRecords.length > 0 ? failedRecords : null,
      totalFailedRecords: failedRecords.length,
    };
  }
}
