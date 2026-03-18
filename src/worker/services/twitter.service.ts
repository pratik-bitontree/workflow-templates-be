import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {}

  private async getAccessToken(userId: string): Promise<string> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.twitter;
    const primary = Array.isArray(accounts) ? accounts.find((a: any) => a.isPrimary) : null;
    if (!primary?.access_token) {
      throw new BadRequestException('Twitter (X) not connected. Connect in Integration Hub.');
    }
    return primary.access_token;
  }

  async postTweet(tweetMessage: string, userId: string): Promise<{ message: string; tweet?: any; postUrl?: string }> {
    const weightedLength = this.calculateApproxTweetLength(tweetMessage ?? '');
    if (weightedLength > 280) {
      throw new BadRequestException(
        `Tweet exceeds the 280-character limit per X rules (${weightedLength}/280). See counting rules: https://docs.x.com/fundamentals/counting-characters`,
      );
    }
    const accessToken = await this.getAccessToken(userId);
    const apiUrl = (this.configService.get<string>('TWITTER_API_URL') || 'https://api.twitter.com').replace(/\/+$/, '');
    try {
      const { data } = await axios.post(
        `${apiUrl}/2/tweets`,
        { text: tweetMessage },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const postId = data?.data?.id;
      const postUrl = postId ? `https://twitter.com/i/web/status/${postId}` : undefined;
      return { message: 'Tweet posted successfully', tweet: data, postUrl };
    } catch (error: any) {
      this.logger.error(`Twitter post error: ${error?.message}`, error?.stack);
      if (error?.response?.status === 401) {
        throw new BadRequestException('Twitter authentication failed. Please reconnect your Twitter account.');
      }
      if (error?.response?.status === 429) {
        throw new BadRequestException('You have reached the rate limit for Twitter. Please try again later.');
      }
      const detail = error?.response?.data?.detail ?? error?.response?.data?.title ?? error?.message;
      throw new BadRequestException(`Failed to post tweet: ${detail}`);
    }
  }

  private calculateApproxTweetLength(text: string): number {
    if (!text) return 0;
    const urlRegex = /https?:\/\/[^\s]+/gi;
    const normalized = text.replace(urlRegex, () => 'x'.repeat(23));
    return [...normalized].length;
  }
}
