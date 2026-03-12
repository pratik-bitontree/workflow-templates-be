import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

const VERCEL_API_BASE = 'https://api.vercel.com';

function replaceSpaceWithHyphen(str: string): string {
  return (str || '').replace(/\s+/g, '-');
}

@Injectable()
export class VercelService {
  private readonly logger = new Logger(VercelService.name);
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.baseUrl = this.configService.get<string>('VERCEL_API_URL') || VERCEL_API_BASE;
  }

  private async getPrimaryAccount(userId: string): Promise<{ api_key: string }> {
    if (!userId) throw new BadRequestException('User ID is required for Vercel');
    const doc = await this.userSecretsModel
      .findOne({ user_id: new Types.ObjectId(userId) })
      .lean();
    const arr = (doc as any)?.vercel;
    const primary = Array.isArray(arr) ? arr.find((a: any) => a.isPrimary === true) : null;
    if (!primary?.api_key) {
      throw new BadRequestException('Vercel API key not found. Connect Vercel in Integration Hub.');
    }
    return primary;
  }

  private isBase64(str: string): boolean {
    try {
      return Buffer.from(str, 'base64').toString('base64') === str;
    } catch {
      return false;
    }
  }

  /**
   * Deploy HTML to Vercel. Returns the deployed URL.
   * Matches monorepo CompanyPagesService.deployCompanyPages behavior (single deployment with slug/index.html).
   */
  async deployCompanyPages({
    userId,
    name,
    html,
    slug,
  }: {
    userId: string;
    name: string;
    html: string;
    slug: string;
  }): Promise<string> {
    const { api_key } = await this.getPrimaryAccount(userId);
    const htmlBuffer = !this.isBase64(html) ? Buffer.from(html).toString('base64') : html;
    const safeSlug = replaceSpaceWithHyphen(slug);
    const files = [{ file: `${safeSlug}/index.html`, data: htmlBuffer, encoding: 'base64' as const }];

    const { data: deployment } = await axios.post(
      `${this.baseUrl}/v13/deployments`,
      {
        name: (name || 'project').toLowerCase(),
        files,
        projectSettings: {
          outputDirectory: '.',
          framework: 'vite',
          buildCommand: '',
          devCommand: '',
          installCommand: '',
        },
        target: 'production',
      },
      {
        headers: {
          Authorization: `Bearer ${api_key}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      },
    );

    const projectId = deployment?.project?.id;
    if (!projectId) {
      throw new BadRequestException('Vercel deployment succeeded but project ID not returned.');
    }

    const { data: domainsData } = await axios.get(
      `${this.baseUrl}/v9/projects/${projectId}/domains`,
      {
        headers: {
          Authorization: `Bearer ${api_key}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const domain = domainsData?.domains?.[0]?.name;
    if (!domain) {
      throw new BadRequestException('Vercel deployment succeeded but no domain found.');
    }

    return `https://${domain}/${safeSlug}`;
  }
}
