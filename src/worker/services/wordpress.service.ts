import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

function convertToHTML(content: string): string {
  return content
    .replace(/(#{1,6})\s*(.*)/g, (_m, p1, p2) => `<h${p1.length}>${p2}</h${p1.length}>`)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((.*?)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br/>');
}

function extractImageUrlFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/!\[.*?\]\((.*?)\)/);
  return match ? match[1] : null;
}

function formatMediaUrlsAsHTML(mediaImage?: string[]): string {
  if (!mediaImage?.length) return '';
  return mediaImage
    .map((url) => `<img src="${url}" style="max-width: 100%; height: auto; display: block;" />`)
    .join('\n');
}

@Injectable()
export class WordPressService {
  private readonly logger = new Logger(WordPressService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {}

  private async getAccessToken(userId: string): Promise<string> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.wordpress;
    const primary = Array.isArray(accounts) ? accounts.find((a: any) => a.isPrimary) : null;
    if (!primary?.access_token) {
      throw new BadRequestException('WordPress not connected. Connect in Integration Hub.');
    }
    return primary.access_token;
  }

  async getSites(userId: string, domain: string): Promise<string> {
    const accessToken = await this.getAccessToken(userId);
    let cleanDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    try {
      const { data } = await axios.get(`https://public-api.wordpress.com/rest/v1.1/sites/${cleanDomain}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!data?.ID) throw new BadRequestException('Failed to get site ID.');
      return data.ID;
    } catch (error: any) {
      this.logger.error(`WordPress getSites: ${error?.message}`);
      if (error?.response?.status === 404) {
        throw new BadRequestException(`WordPress site not found: ${cleanDomain}. Please check the domain.`);
      }
      if (error?.response?.status === 401) {
        throw new BadRequestException('WordPress authentication failed. Please reconnect in Integration Hub.');
      }
      if (error?.response?.status === 403) {
        throw new BadRequestException('Access denied to this WordPress site.');
      }
      throw new BadRequestException(error?.response?.data?.message || error?.message || 'Error getting site ID.');
    }
  }

  async createBlogPost(params: {
    userId: string;
    domain: string;
    title: string;
    content: string;
    status?: string;
    featuredImageUrl?: any;
    media_urls?: any;
    slug?: string;
    categories?: string[];
    tags?: string[];
    author?: string;
    publishDate?: string;
    sticky?: boolean;
    discussion?: string[];
    likesEnabled?: boolean;
  }): Promise<any> {
    const { userId, domain, title, content, status } = params;
    if (!title?.trim()) throw new BadRequestException('Title is required.');
    if (!content?.trim()) throw new BadRequestException('Content is required.');
    if (!domain?.trim()) throw new BadRequestException('Domain is required.');
    const siteId = await this.getSites(userId, domain);
    const accessToken = await this.getAccessToken(userId);
    const image: string[] = [];
    const mediaImage: string[] = [];
    let featuredImageUrl = params.featuredImageUrl;
    let media_urls = params.media_urls;
    if (featuredImageUrl) {
      if (typeof featuredImageUrl === 'string' && featuredImageUrl.startsWith('[')) {
        try {
          featuredImageUrl = JSON.parse(featuredImageUrl);
        } catch {
          featuredImageUrl = [];
        }
      }
      if (Array.isArray(featuredImageUrl)) {
        const first = featuredImageUrl.map((u: string) => u.trim()).find((u: string) => u.startsWith('http'));
        if (first) image.push(first);
      } else if (typeof featuredImageUrl === 'string') {
        const u = extractImageUrlFromMarkdown(featuredImageUrl) || featuredImageUrl.trim();
        if (u.startsWith('http')) image.push(u);
      } else if (featuredImageUrl?.thumbnail?.trim()?.startsWith('http')) {
        image.push(featuredImageUrl.thumbnail.trim());
      }
    }
    if (media_urls) {
      if (typeof media_urls === 'string' && media_urls.startsWith('[')) {
        try {
          media_urls = JSON.parse(media_urls);
        } catch {
          // ignore
        }
      }
      if (Array.isArray(media_urls)) {
        const first = media_urls.map((u: string) => u.trim()).find((u: string) => u.startsWith('http'));
        if (first) mediaImage.push(first);
      } else if (typeof media_urls === 'string') {
        const u = extractImageUrlFromMarkdown(media_urls) || media_urls.trim();
        if (u.startsWith('http')) mediaImage.push(u);
      } else if (media_urls?.thumbnail?.trim()?.startsWith('http')) {
        mediaImage.push(media_urls.thumbnail.trim());
      }
    }
    const requestData: any = {
      title,
      content: `${formatMediaUrlsAsHTML(mediaImage)}\n${convertToHTML(content)}`,
      status: status || 'publish',
      sticky: params.sticky ?? false,
      likes_enabled: params.likesEnabled !== false,
      format: 'gallery',
    };
    if (image[0]) requestData.featured_image = image[0];
    if (params.slug) requestData.slug = params.slug;
    if (params.categories?.length) requestData.categories = params.categories;
    if (params.tags?.length) requestData.tags = params.tags;
    if (params.author) requestData.author = params.author;
    if (params.publishDate) requestData.date = params.publishDate;
    if (params.discussion?.length) {
      requestData.discussion = {
        comments_open: params.discussion.includes('comments_open'),
        pings_open: params.discussion.includes('pings_open'),
      };
    }
    try {
      const { data } = await axios.post(
        `https://public-api.wordpress.com/rest/v1.1/sites/${siteId}/posts/new`,
        requestData,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          timeout: 120000,
        },
      );
      if (!data?.ID) throw new BadRequestException('Failed to create blog post.');
      if (data?.status === 408) {
        throw new BadRequestException('The request timed out while creating the blog post. Please try again.');
      }
      return {
        status_of_post: 'Blog post created successfully',
        postId: data.ID,
        title: data.title || title,
        url: data.URL,
        shortUrl: data.short_URL,
        author: data.author?.name,
        status: data.status,
        categories: data.categories ?? null,
        tags: data.tags ?? null,
        featuredImage: data.featured_image ?? null,
        mediaUrl: mediaImage.length ? mediaImage : null,
        discussion: data.discussion ?? null,
        likesEnabled: data.likes_enabled,
        publishDate: data.date ?? null,
      };
    } catch (error: any) {
      this.logger.error(`WordPress createBlogPost: ${error?.message}`);
      if (error?.response?.status === 403) {
        const msg = error?.response?.data?.output?.message;
        if (msg?.includes('API calls to this endpoint have been disabled')) {
          throw new BadRequestException('This WordPress feature is currently disabled.');
        }
        if (msg?.includes('User cannot publish posts')) {
          throw new BadRequestException('You do not have permission to publish posts on this WordPress site.');
        }
        throw new BadRequestException(msg || 'Access denied.');
      }
      throw new BadRequestException(error?.response?.data?.message || error?.message || 'Error creating blog post.');
    }
  }

  async createPage(params: {
    userId: string;
    domain: string;
    title: string;
    content: string;
    status?: string;
    featuredImageUrl?: any;
    media_urls?: any;
    slug?: string;
    parent?: number;
    template?: string;
    order?: number;
    author?: string;
    publishDate?: string;
    likesEnabled?: boolean;
    isHTML?: boolean;
  }): Promise<any> {
    const { userId, domain, title, content, status } = params;
    if (!title?.trim()) throw new BadRequestException('Title is required.');
    if (!content?.trim()) throw new BadRequestException('Content is required.');
    if (!domain?.trim()) throw new BadRequestException('Domain is required.');
    const siteId = await this.getSites(userId, domain);
    const accessToken = await this.getAccessToken(userId);
    const image: string[] = [];
    const mediaImage: string[] = [];
    let featuredImageUrl = params.featuredImageUrl;
    let media_urls = params.media_urls;
    if (featuredImageUrl) {
      if (typeof featuredImageUrl === 'string' && featuredImageUrl.startsWith('[')) {
        try {
          featuredImageUrl = JSON.parse(featuredImageUrl);
        } catch {
          featuredImageUrl = [];
        }
      }
      if (Array.isArray(featuredImageUrl)) {
        featuredImageUrl.map((u: string) => u.trim()).filter((u: string) => u.startsWith('http')).forEach((u: string) => image.push(u));
      } else if (typeof featuredImageUrl === 'string') {
        const u = extractImageUrlFromMarkdown(featuredImageUrl) || featuredImageUrl.trim();
        if (u.startsWith('http')) image.push(u);
      } else if (featuredImageUrl?.thumbnail?.trim()?.startsWith('http')) {
        image.push(featuredImageUrl.thumbnail.trim());
      }
    }
    if (media_urls) {
      if (typeof media_urls === 'string' && media_urls.startsWith('[')) {
        try {
          media_urls = JSON.parse(media_urls);
        } catch {
          // ignore
        }
      }
      if (Array.isArray(media_urls)) {
        media_urls.map((u: string) => u.trim()).filter((u: string) => u.startsWith('http')).forEach((u: string) => mediaImage.push(u));
      } else if (typeof media_urls === 'string') {
        const u = extractImageUrlFromMarkdown(media_urls) || media_urls.trim();
        if (u.includes(',')) u.split(',').map((p: string) => p.trim()).filter((p: string) => p.startsWith('http')).forEach((p: string) => mediaImage.push(p));
        else if (u.startsWith('http')) mediaImage.push(u);
      } else if (media_urls?.thumbnail?.trim()?.startsWith('http')) {
        mediaImage.push(media_urls.thumbnail.trim());
      }
    }
    const isHTML = params.isHTML !== false;
    const requestData: any = {
      title,
      content: `${formatMediaUrlsAsHTML(mediaImage)}\n${isHTML ? content : convertToHTML(content)}`,
      status: status || 'publish',
      likes_enabled: params.likesEnabled !== false,
      type: 'page',
      format: isHTML ? 'html' : 'standard',
    };
    if (image[0]) requestData.featured_image = image[0];
    if (params.slug) requestData.slug = params.slug;
    if (typeof params.parent === 'number') requestData.parent = params.parent;
    if (typeof params.order === 'number') requestData.menu_order = params.order;
    if (params.template) requestData.template = params.template;
    if (params.author) requestData.author = params.author;
    if (params.publishDate) requestData.date = params.publishDate;
    try {
      const { data } = await axios.post(
        `https://public-api.wordpress.com/rest/v1.1/sites/${siteId}/posts/new`,
        requestData,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          timeout: 120000,
        },
      );
      if (!data?.ID) throw new BadRequestException('Failed to create page.');
      return {
        status_of_page: 'Page created successfully',
        pageId: data.ID,
        title: data.title || title,
        url: data.URL,
        shortUrl: data.short_URL,
        author: data.author?.name,
        status: data.status,
        featuredImage: data.featured_image ?? null,
        publishDate: data.date ?? null,
      };
    } catch (error: any) {
      this.logger.error(`WordPress createPage: ${error?.message}`);
      if (error?.response?.status === 403) {
        throw new BadRequestException(error?.response?.data?.output?.message || 'Access denied.');
      }
      throw new BadRequestException(error?.response?.data?.message || error?.message || 'Error creating page.');
    }
  }
}
