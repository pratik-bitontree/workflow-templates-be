import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly apiVersion = 'v2';
  private readonly LINKEDIN_API_VERSION = '202503';
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(UserSecrets.name) private readonly userSecretsModel: Model<UserSecretsDocument>,
  ) {
    this.baseUrl = (
      this.configService.get<string>('LINKEDIN_BASE_URL') ||
      this.configService.get<string>('LINKEDIN_API_URL') ||
      'https://api.linkedin.com'
    ).replace(/\/+$/, '');
  }

  async getAccessToken(userId: string): Promise<string> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const accounts = (doc as any)?.linkedin;
    const primary = Array.isArray(accounts) ? accounts.find((a: any) => a.isPrimary) : null;
    if (!primary?.access_token) {
      throw new BadRequestException('LinkedIn access token not found');
    }
    return primary.access_token;
  }

  async createLinkedInPost({
    postOn,
    postType = 'Text',
    organizationUrn,
    textContent,
    mediaUrl,
    userId,
    visibility = 'PUBLIC',
    title,
  }: {
    postOn: 'personal' | 'organization';
    postType?: 'Text' | 'Image' | 'Video' | 'Document' | 'MultiImage';
    organizationUrn?: string;
    textContent?: string;
    mediaUrl?: string | string[];
    userId: string;
    visibility?: 'PUBLIC' | 'CONNECTIONS';
    title?: string;
  }) {
    try {
      const accessToken = await this.getAccessToken(userId);

      if (postOn === 'organization' && visibility === 'CONNECTIONS') {
        throw new BadRequestException('Organization posts can only have Public visibility, not Connections.');
      }

      const profileResponse = await axios.get(`${this.baseUrl}/${this.apiVersion}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      const processedText = textContent ? await this.processTextContent(textContent) : '';

      const author =
        postOn === 'personal' ? `urn:li:person:${profileResponse.data.sub}` : organizationUrn;

      if (postOn === 'organization' && !organizationUrn) {
        throw new BadRequestException('Organization URN is required for organization posts');
      }

      let postData: any = {
        author,
        commentary: processedText,
        visibility: visibility.toUpperCase(),
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      };

      if (typeof mediaUrl === 'string') {
        if (mediaUrl.startsWith('[') && mediaUrl.endsWith(']')) {
          try {
            const parsed = JSON.parse(mediaUrl);
            if (Array.isArray(parsed)) {
              mediaUrl = parsed
                .map((item: any) => {
                  if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) {
                    return item;
                  }
                  return item.toString();
                })
                .filter((url: string) => url && (url.startsWith('http://') || url.startsWith('https://')));

              if (mediaUrl.length === 0) {
                throw new BadRequestException('No valid URLs found in the provided media URL array');
              }

              if (mediaUrl.length === 1 && postType === 'Image') {
                mediaUrl = mediaUrl[0];
              } else if (mediaUrl.length > 1 && postType === 'Image') {
                postType = 'MultiImage';
              }
            }
          } catch (e) {
            this.logger.error(`Error parsing mediaUrl JSON: ${(e as any)?.message}`);
            throw new BadRequestException(
              'Invalid media URL format. Please provide a valid URL or array of URLs.',
            );
          }
        }
      }

      if (postType === 'Image' && typeof mediaUrl === 'string' && mediaUrl.includes(',')) {
        postType = 'MultiImage';
      }

      if (postType !== 'Text') {
        try {
          switch (postType) {
            case 'Image': {
              if (!mediaUrl) throw new BadRequestException('Media URL is required for Image post');

              if (Array.isArray(mediaUrl)) {
                throw new BadRequestException('Image post requires a single image URL, not an array');
              }

              const fileExtension = mediaUrl.split('.').pop()?.toLowerCase();
              if (
                fileExtension !== 'jpg' &&
                fileExtension !== 'jpeg' &&
                fileExtension !== 'png' &&
                fileExtension !== 'gif'
              ) {
                throw new BadRequestException(
                  'Invalid image format. LinkedIn only supports JPG, JPEG, PNG, and GIF images.',
                );
              }
              const mediaUrn = await this.uploadImageToLinkedIn(
                mediaUrl,
                userId,
                postOn === 'organization' ? organizationUrn : undefined,
              );

              postData.content = {
                media: {
                  id: mediaUrn,
                },
              };
              break;
            }

            case 'MultiImage': {
              if (!Array.isArray(mediaUrl)) {
                if (typeof mediaUrl === 'string') {
                  mediaUrl = mediaUrl.split(',').map((url) => url.trim()).filter((url) => url);
                } else {
                  throw new BadRequestException('Array of media URLs required for MultiImage post');
                }
              }

              if (!mediaUrl || mediaUrl.length < 2) {
                throw new BadRequestException(
                  'LinkedIn MultiImage posts require at least 2 images (maximum 20). Please provide multiple comma-separated image URLs.',
                );
              }

              if (mediaUrl.length > 20) {
                throw new BadRequestException('LinkedIn allows maximum 20 images in a MultiImage post');
              }

              for (const url of mediaUrl) {
                const fileExtension = url.split('.').pop()?.toLowerCase();
                if (
                  fileExtension !== 'jpg' &&
                  fileExtension !== 'jpeg' &&
                  fileExtension !== 'png' &&
                  fileExtension !== 'gif'
                ) {
                  throw new BadRequestException(
                    `Invalid image format for URL: ${url}. LinkedIn only supports JPG, JPEG, PNG, and GIF images.`,
                  );
                }
              }

              const mediaUrns = await Promise.all(
                mediaUrl.map((url) =>
                  this.uploadImageToLinkedIn(
                    url,
                    userId,
                    postOn === 'organization' ? organizationUrn : undefined,
                  ),
                ),
              );

              postData.content = {
                multiImage: {
                  images: mediaUrns.map((urn) => ({
                    id: urn,
                  })),
                },
              };
              break;
            }

            case 'Video': {
              if (!mediaUrl) throw new BadRequestException('Media URL is required for Video post');
              if (Array.isArray(mediaUrl)) {
                throw new BadRequestException('Video post only supports a single video URL, not an array');
              }

              const fileExtension = mediaUrl.split('.').pop()?.toLowerCase();
              if (fileExtension !== 'mp4') {
                throw new BadRequestException(
                  'Invalid video format. LinkedIn only supports MP4 videos. Video must meet these requirements:\n' +
                    '- Format: MP4\n' +
                    '- Size: Between 75KB and 500MB\n' +
                    '- Duration: Between 3 seconds and 30 minutes',
                );
              }

              try {
                const videoResponse = await axios.get(mediaUrl, {
                  responseType: 'arraybuffer',
                });

                const videoBuffer = Buffer.from(videoResponse.data);
                const fileSizeBytes = videoBuffer.length;
                const fileSizeKB = Math.round(fileSizeBytes / 1024);

                if (fileSizeBytes < 76800 || fileSizeBytes > 524288000) {
                  throw new BadRequestException(
                    `Video file size must be between 75KB and 500MB. Current size: ${fileSizeKB}KB`,
                  );
                }

                const owner =
                  postOn === 'organization'
                    ? `urn:li:organization:${organizationUrn!.replace(/^urn:li:organization:/, '')}`
                    : `urn:li:person:${profileResponse.data.sub}`;

                const initVideoUpload = await axios.post(
                  `${this.baseUrl}/rest/videos?action=initializeUpload`,
                  {
                    initializeUploadRequest: {
                      owner,
                      fileSizeBytes: Number(fileSizeBytes),
                      uploadCaptions: false,
                      uploadThumbnail: false,
                    },
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${accessToken}`,
                      'Content-Type': 'application/json',
                      'LinkedIn-Version': this.LINKEDIN_API_VERSION,
                      'X-Restli-Protocol-Version': '2.0.0',
                    },
                  },
                );

                if (!initVideoUpload?.data?.value?.video) {
                  throw new BadRequestException('Failed to initialize video upload - missing video URN');
                }

                const uploadInstructions = initVideoUpload.data.value.uploadInstructions[0];
                if (!uploadInstructions?.uploadUrl) {
                  throw new BadRequestException('Failed to get upload URL from LinkedIn');
                }

                const uploadResponse = await axios.put(uploadInstructions.uploadUrl, videoBuffer, {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/octet-stream',
                  },
                });

                const etag = uploadResponse.headers.etag || uploadResponse.headers['etag'];
                if (!etag) {
                  throw new BadRequestException('Failed to get ETag from upload response');
                }

                await axios.post(
                  `${this.baseUrl}/rest/videos?action=finalizeUpload`,
                  {
                    finalizeUploadRequest: {
                      video: initVideoUpload.data.value.video,
                      uploadToken: initVideoUpload.data.value.uploadToken || '',
                      uploadedPartIds: [etag],
                    },
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${accessToken}`,
                      'Content-Type': 'application/json',
                      'LinkedIn-Version': this.LINKEDIN_API_VERSION,
                      'X-Restli-Protocol-Version': '2.0.0',
                    },
                  },
                );

                const data = {
                  commentary: processedText || '',
                  visibility: visibility.toUpperCase(),
                  distribution: {
                    feedDistribution: 'MAIN_FEED',
                    thirdPartyDistributionChannels: [],
                  },
                  content: {
                    media: {
                      id: initVideoUpload.data.value.video,
                    },
                  },
                  lifecycleState: 'PUBLISHED',
                };

                postData = {
                  ...data,
                  author:
                    postOn === 'organization'
                      ? organizationUrn
                      : `urn:li:person:${profileResponse.data.sub}`,
                };
              } catch (error: any) {
                let errorMessage = 'LinkedIn video upload failed';

                if (error.response?.data) {
                  if (error.response.status === 401) {
                    errorMessage = 'LinkedIn authentication failed. Please reconnect your account.';
                  } else if (error.response.status === 403) {
                    errorMessage =
                      'Permission denied. You may not have access to post videos to this account.';
                  } else if (error.response.status === 413) {
                    errorMessage = 'Video file size is too large for LinkedIn to process.';
                  } else if (error.response?.status === 422) {
                    errorMessage = 'This post is a duplicate. Please modify your content and try again.';
                  }
                }

                throw new BadRequestException(errorMessage);
              }
              break;
            }

            case 'Document': {
              if (!mediaUrl) throw new BadRequestException('Media URL is required for Document post');
              if (!title) throw new BadRequestException('Title is required for Document post');

              if (Array.isArray(mediaUrl)) {
                throw new BadRequestException('Document post requires a single document URL, not an array');
              }

              const fileExtension = mediaUrl.split('.').pop()?.toLowerCase();
              const supportedFormats = ['pdf', 'doc', 'docx', 'ppt', 'pptx'];

              if (!fileExtension || !supportedFormats.includes(fileExtension)) {
                throw new BadRequestException(
                  'Invalid document format. LinkedIn only supports PPT, PPTX, DOC, DOCX, and PDF formats. ' +
                    'Files cannot exceed 100MB and 300 pages.',
                );
              }

              const docResponse = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
              });

              const fileSizeBytes = docResponse.data.length;
              const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024));

              if (fileSizeBytes > 104857600) {
                throw new BadRequestException(
                  `Document file size must be under 100MB. Current size: ${fileSizeMB}MB`,
                );
              }

              const pageCount = await this.getDocumentPageCount(
                Buffer.from(docResponse.data),
                fileExtension,
              );

              if (pageCount > 300) {
                throw new BadRequestException(
                  `${fileExtension.toUpperCase()} document exceeds LinkedIn's 300-page limit.`,
                );
              }

              const initDocUpload = await axios.post(
                `${this.baseUrl}/rest/documents?action=initializeUpload`,
                {
                  initializeUploadRequest: {
                    owner: author,
                  },
                },
                {
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'LinkedIn-Version': this.LINKEDIN_API_VERSION,
                    'X-Restli-Protocol-Version': '2.0.0',
                  },
                },
              );

              let contentType: string;
              switch (fileExtension) {
                case 'pdf':
                  contentType = 'application/pdf';
                  break;
                case 'doc':
                  contentType = 'application/msword';
                  break;
                case 'docx':
                  contentType =
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                  break;
                case 'ppt':
                  contentType = 'application/vnd.ms-powerpoint';
                  break;
                case 'pptx':
                  contentType =
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
                  break;
                default:
                  contentType = 'application/pdf';
              }

              await axios.put(initDocUpload.data.value.uploadUrl, docResponse.data, {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': contentType,
                },
              });

              postData.content = {
                media: {
                  title: title,
                  id: initDocUpload.data.value.document,
                },
              };
              break;
            }
          }
        } catch (error: any) {
          if (error.response?.data?.message?.includes('not owned by the author')) {
            throw new BadRequestException(
              'Media ownership error: The uploaded media must be owned by the posting account. ' +
                'Please ensure you have the correct permissions.',
            );
          }

          throw new BadRequestException(`Failed to upload media: ${error.message}`);
        }
      }

      const response = await axios.post(`${this.baseUrl}/rest/posts`, postData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': this.LINKEDIN_API_VERSION,
        },
      });

      const postId = response.headers['x-restli-id'];
      const postUrl = `https://www.linkedin.com/feed/update/${postId}`;

      return {
        postUrl,
        status: 'success',
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn post creation error: ${error?.message}`, error?.stack);

      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 422 && error.response?.data?.message?.includes('duplicate')) {
        throw new BadRequestException(
          'This post is a duplicate. Please modify your content and try again.',
        );
      }

      if (error.response?.status === 422 && error.response?.data?.message?.includes('visibility')) {
        throw new BadRequestException(
          'Visibility field is required. Please ensure "visibility" is set to either "PUBLIC" or "CONNECTIONS".',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          'Permission denied. Please check your LinkedIn account permissions.',
        );
      }

      if (error.response?.status === 429) {
        throw new BadRequestException(
          'LinkedIn API rate limit exceeded. Please try again later.',
        );
      }

      if (error.response?.status === 504) {
        return {
          message:
            'Post submitted successfully. It may take a few minutes to appear on LinkedIn due to high traffic.',
          status: 'success',
        };
      }

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(`Failed to create LinkedIn post: ${error.message}`);
    }
  }

  private async processTextContent(textContent: string): Promise<string> {
    let processedText = String(textContent || '').trim();
    if (!processedText) {
      throw new BadRequestException('Post text cannot be empty');
    }

    try {
      if (
        typeof processedText === 'string' &&
        (processedText.startsWith('[') || processedText.startsWith('"'))
      ) {
        try {
          const parsed = JSON.parse(processedText);
          processedText = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
          processedText = textContent;
        }
      }

      processedText = processedText.replace(/\\n/g, '\n').replace(/\\\\n/g, '\n');

      processedText = processedText
        .replace(/^### (.*$)/gm, '\n\n🔷 $1\n\n')
        .replace(/^#### (.*$)/gm, '\n\n📌 $1\n\n')
        .replace(/\*\*(.*?)\*\*/g, (_, text) => {
          return text
            .split('')
            .map((char: string) => {
              const boldMap: Record<string, string> = {
                a: '𝗮',
                b: '𝗯',
                c: '𝗰',
                d: '𝗱',
                e: '𝗲',
                f: '𝗳',
                g: '𝗴',
                h: '𝗵',
                i: '𝗶',
                j: '𝗷',
                k: '𝗸',
                l: '𝗹',
                m: '𝗺',
                n: '𝗻',
                o: '𝗼',
                p: '𝗽',
                q: '𝗾',
                r: '𝗿',
                s: '𝘀',
                t: '𝘁',
                u: '𝘂',
                v: '𝘃',
                w: '𝘄',
                x: '𝘅',
                y: '𝘆',
                z: '𝘇',
                A: '𝗔',
                B: '𝗕',
                C: '𝗖',
                D: '𝗗',
                E: '𝗘',
                F: '𝗙',
                G: '𝗚',
                H: '𝗛',
                I: '𝗜',
                J: '𝗝',
                K: '𝗞',
                L: '𝗟',
                M: '𝗠',
                N: '𝗡',
                O: '𝗢',
                P: '𝗣',
                Q: '𝗤',
                R: '𝗥',
                S: '𝗦',
                T: '𝗧',
                U: '𝗨',
                V: '𝗩',
                W: '𝗪',
                X: '𝗫',
                Y: '𝗬',
                Z: '𝗭',
                '0': '𝟬',
                '1': '𝟭',
                '2': '𝟮',
                '3': '𝟯',
                '4': '𝟰',
                '5': '𝟱',
                '6': '𝟲',
                '7': '𝟳',
                '8': '𝟴',
                '9': '𝟵',
                ' ': ' ',
                '%': '%',
              };
              return boldMap[char] || char;
            })
            .join('');
        })
        .replace(/\((.*?)\)/g, ' $1 ')
        .replace(/^- (.*$)/gm, '\n\n• $1')
        .replace(/\[(.*?)\]\((.*?)\)/g, (_, text, url) => {
          return `${text}\n${url}`;
        })
        .replace(/:([a-z]+):/g, (match, code) => {
          const emojiMap: Record<string, string> = {
            rocket: '🚀',
            star: '⭐',
            sparkles: '✨',
            check: '✅',
            link: '🔗',
          };
          return emojiMap[code] || match;
        })
        .replace(/•(.*?)(?=[\n•]|$)/g, '• $1\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const hashtags = processedText.match(/#[a-zA-Z0-9]+/g) || [];
      processedText = processedText.replace(/#[a-zA-Z0-9]+/g, '').trim();

      if (hashtags.length > 0) {
        processedText += '\n\n' + hashtags.join(' ');
      }
    } catch (error) {
      this.logger.warn(`Error processing markdown: ${(error as any)?.message}`);
      processedText = textContent;
    }

    return processedText;
  }

  async uploadImageToLinkedIn(
    imageUrl: string,
    userId: string,
    organizationUrn?: string,
  ): Promise<string> {
    try {
      const accessToken = await this.getAccessToken(userId);

      const profileResponse = await axios.get(`${this.baseUrl}/${this.apiVersion}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      const initializeUploadResponse = await axios.post(
        `${this.baseUrl}/rest/images?action=initializeUpload`,
        {
          initializeUploadRequest: {
            owner:
              organizationUrn || `urn:li:person:${profileResponse.data.sub}`,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
          },
        },
      );

      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(imageResponse.data);

      await axios.put(initializeUploadResponse.data.value.uploadUrl, imageBuffer, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
        },
      });

      return initializeUploadResponse.data.value.image;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new BadRequestException('LinkedIn authentication failed');
      }
      throw new BadRequestException(`Failed to upload image to LinkedIn: ${error.message}`);
    }
  }

  async createLinkedInArticle({
    title,
    description,
    articleUrl,
    thumbnailUrl,
    userId,
    visibility = 'PUBLIC',
  }: {
    title: string;
    description?: string;
    articleUrl: string;
    thumbnailUrl?: string;
    userId: string;
    visibility?: 'PUBLIC' | 'CONNECTIONS';
  }) {
    try {
      const accessToken = await this.getAccessToken(userId);

      const profileResponse = await axios.get(`${this.baseUrl}/${this.apiVersion}/userinfo`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      const authorId = profileResponse.data.sub;

      if (!articleUrl || typeof articleUrl !== 'string' || !articleUrl.trim()) {
        throw new BadRequestException(
          'LinkedIn article source URL is required (articleUrl cannot be empty).',
        );
      }

      const articleSource = articleUrl.trim();

      let thumbnailId: string | undefined;
      if (thumbnailUrl && thumbnailUrl !== '') {
        const uploadedImage = await this.uploadImageToLinkedIn(thumbnailUrl, userId);
        thumbnailId = uploadedImage;
      }

      const articleData = {
        author: `urn:li:person:${authorId}`,
        commentary: description ? `${title} - ${description}` : title,
        lifecycleState: 'PUBLISHED',
        visibility: visibility.toUpperCase(),
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          article: {
            title: title,
            description: description || '',
            source: articleSource,
            ...(thumbnailId && { thumbnail: thumbnailId }),
          },
        },
      };

      const response = await axios.post(`${this.baseUrl}/rest/posts`, articleData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': this.LINKEDIN_API_VERSION,
        },
      });

      return {
        postId: response.headers['x-restli-id'],
        status: 'success',
        message: 'Article posted successfully',
      };
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 422) {
        throw new BadRequestException(
          error.response.data.message || 'Invalid article data. Please check your input.',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          'Permission denied. Please check your LinkedIn account permissions.',
        );
      }

      throw new BadRequestException(`Failed to create LinkedIn article: ${error.message}`);
    }
  }

  async getLinkedInAdAccounts(userId: string) {
    try {
      const accessToken = await this.getAccessToken(userId);

      const response = await axios.get(
        `${this.baseUrl}/rest/adAccountUsers?q=authenticatedUser`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      const accountsPromises = response.data.elements.map(async (accountUser: any) => {
        const accountId = accountUser.account.split(':').pop();
        try {
          const accountDetails = await axios.get(
            `${this.baseUrl}/rest/adAccounts/${accountId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'LinkedIn-Version': this.LINKEDIN_API_VERSION,
                'X-Restli-Protocol-Version': '2.0.0',
              },
            },
          );

          return {
            id: accountId,
            name: accountDetails.data.name,
            status: accountDetails.data.status,
            role: accountUser.role,
          };
        } catch (error: any) {
          this.logger.error(`Error fetching details for account ${accountId}: ${error?.message}`);
          return null;
        }
      });

      const accountsDetails = await Promise.all(accountsPromises);

      const filteredAccounts = accountsDetails
        .filter(
          (account: any) =>
            account && (account.status === 'ACTIVE' || account.status === 'DRAFT'),
        )
        .map((account: any) => ({
          label: account.name,
          value: account.id,
        }));

      return {
        success: true,
        accounts: filteredAccounts,
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn get ad accounts error: ${error?.message}`);

      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          'Permission denied. Please check your LinkedIn account permissions for advertising.',
        );
      }

      throw new BadRequestException(
        `Failed to get LinkedIn ad accounts: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  async createCampaignGroup({
    campaignName,
    startDate,
    endDate,
    status = 'ACTIVE',
    currency,
    totalBudget,
    userId,
    accountId,
  }: {
    campaignName: string;
    startDate?: string | number;
    endDate?: string | number;
    status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'CANCELED' | 'PAUSED';
    currency?: string;
    totalBudget?: string | number;
    userId: string;
    accountId: string;
  }) {
    try {
      const accessToken = await this.getAccessToken(userId);

      if (!campaignName) {
        throw new BadRequestException('Campaign name is required');
      }

      if (!accountId) {
        throw new BadRequestException('Account ID is required');
      }

      if (!startDate) {
        throw new BadRequestException('Start Date is required');
      }

      if (status) {
        status = (status ?? 'ACTIVE').toUpperCase() as typeof status;
      }

      if (totalBudget) {
        if (!currency) {
          throw new BadRequestException('Currency is required.');
        }
      }

      const currentTimestamp = Date.now();
      const startTimestamp =
        typeof startDate === 'string' ? new Date(startDate).getTime() : startDate;
      const endTimestamp = typeof endDate === 'string' ? new Date(endDate).getTime() : endDate;

      if (startTimestamp < currentTimestamp) {
        throw new BadRequestException('Start date must be in the future.');
      }

      if (endTimestamp && endTimestamp < currentTimestamp) {
        throw new BadRequestException('End date must be in the future.');
      }

      const twentyFourHours = 24 * 60 * 60 * 1000;
      if (endTimestamp && endTimestamp - startTimestamp < twentyFourHours) {
        throw new BadRequestException(
          'End date must be at least 24 hours later than the start date',
        );
      }

      const campaignGroupData = {
        account: `urn:li:sponsoredAccount:${accountId}`,
        name: campaignName,
        status,
        runSchedule: {
          start: startTimestamp,
          end: endTimestamp,
        },
        ...(totalBudget && {
          totalBudget: {
            amount: typeof totalBudget === 'string' ? totalBudget : totalBudget.toString(),
            currencyCode: currency!.toUpperCase(),
          },
        }),
      };

      const response = await axios.post(
        `${this.baseUrl}/rest/adAccounts/${accountId}/adCampaignGroups`,
        campaignGroupData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      const campaignGroupId = response.headers['x-restli-id'];
      return {
        success: true,
        message: 'Campaign group created successfully',
        id: `urn:li:sponsoredCampaignGroup:${campaignGroupId}`,
        campaignName,
        status,
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn campaign creation error: ${error?.message}`);

      if (error?.response?.data?.code === 'STATUS_CHANGE_NOT_ALLOWED') {
        throw new BadRequestException(
          'Invalid status transition. Campaign groups can only be created with status ACTIVE or DRAFT.',
        );
      }

      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          `Permission denied: ${error.response.data.message || 'Please check your LinkedIn account permissions for advertising.'}`,
        );
      }

      if (
        error.response?.data?.message?.includes(
          '/CampaignGroup/totalBudget/currencyCode expected to match value',
        )
      ) {
        throw new BadRequestException(
          'Currency mismatch: The provided currency does not match your LinkedIn ad account settings. Please update the currency accordingly.',
        );
      }

      if (error.response?.status === 400) {
        throw new BadRequestException(
          error.response.data.message || 'Invalid campaign data. Please check your input.',
        );
      }

      throw new BadRequestException(
        `Failed to create campaign: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  async createCampaign({
    accountId,
    campaignGroupURN,
    campaignName,
    status = 'ACTIVE',
    dailyBudgetAmount,
    dailyBudgetCurrencyCode = 'USD',
    startDate,
    endDate,
    linkedInPageURN,
    userId,
    type = 'TEXT_AD',
    costType = 'CPC',
    unitCostAmount,
    unitCostCurrencyCode = 'USD',
    creativeSelection = 'OPTIMIZED',
    audienceExpansionEnabled = false,
    targetingCriteriaIncluded,
    country = 'US',
    language = 'en',
    offsiteDeliveryEnabled = false,
  }: {
    campaignName: string;
    status?: 'ACTIVE' | 'DRAFT' | 'PAUSED' | 'ARCHIVED' | 'CANCELED';
    dailyBudgetAmount: string | number;
    dailyBudgetCurrencyCode: string;
    startDate?: string | number;
    endDate?: string | number;
    campaignGroupURN: string | number;
    linkedInPageURN?: string | number;
    userId: string;
    accountId: string | number;
    type?: 'TEXT_AD' | 'SPONSORED_UPDATES' | 'SPONSORED_INMAILS';
    costType?: 'CPC' | 'CPM';
    unitCostAmount?: string | number;
    unitCostCurrencyCode?: string;
    creativeSelection?: 'OPTIMIZED' | 'ROUND_ROBIN';
    audienceExpansionEnabled?: boolean;
    targetingCriteriaIncluded?: string[];
    country: string;
    language: string;
    offsiteDeliveryEnabled?: boolean;
  }) {
    try {
      const accessToken = await this.getAccessToken(userId);

      if (!accountId) {
        throw new BadRequestException('Account ID is required');
      }

      if (!campaignGroupURN) {
        throw new BadRequestException('Campaign group URN is required');
      }

      if (!campaignName) {
        throw new BadRequestException('Campaign name is required');
      }

      if (!status) {
        throw new BadRequestException('Campaign status is required');
      }

      if (!type) {
        throw new BadRequestException('Campaign type is required');
      }

      if (!costType) {
        throw new BadRequestException('Cost type is required');
      }

      if (!dailyBudgetAmount || !dailyBudgetCurrencyCode) {
        throw new BadRequestException('Daily budget amount and currency code are required');
      }

      if (!country || !language) {
        throw new BadRequestException('Locale language and country are required');
      }

      if (!startDate || !endDate) {
        throw new BadRequestException('Start date and end date are required');
      }

      const currentTimestamp = Date.now();
      const startTimestamp = startDate
        ? typeof startDate === 'string'
          ? new Date(startDate).getTime()
          : startDate
        : undefined;
      const endTimestamp = endDate
        ? typeof endDate === 'string'
          ? new Date(endDate).getTime()
          : endDate
        : undefined;

      if (startTimestamp && endTimestamp) {
        if (startTimestamp >= endTimestamp) {
          throw new BadRequestException('End date must be after start date');
        }

        if (startTimestamp < currentTimestamp) {
          throw new BadRequestException('Start date must be in the future');
        }

        if (endTimestamp < currentTimestamp) {
          throw new BadRequestException('End date must be in the future');
        }
      }

      const upperDailyBudgetCurrency = dailyBudgetCurrencyCode.toUpperCase();
      const stringDailyBudget =
        typeof dailyBudgetAmount === 'number' ? dailyBudgetAmount.toString() : dailyBudgetAmount;

      if (status && !['ACTIVE', 'DRAFT'].includes(status.toUpperCase())) {
        throw new BadRequestException(
          'New campaigns can only be created with status "ACTIVE" or "DRAFT". ' +
            'To cancel a campaign, create it first and then update its status.',
        );
      }

      if (type === 'SPONSORED_INMAILS') {
        if (costType !== 'CPM') {
          throw new BadRequestException(
            'SPONSORED_INMAILS campaigns must use CPM cost type. Please change costType to "CPM".',
          );
        }
        if (creativeSelection !== 'ROUND_ROBIN') {
          throw new BadRequestException(
            'SPONSORED_INMAILS campaigns must use ROUND_ROBIN creative selection. Please change creativeSelection to "ROUND_ROBIN".',
          );
        }
      }

      const campaignData: any = {
        account: `urn:li:sponsoredAccount:${accountId}`,
        campaignGroup: campaignGroupURN,
        audienceExpansionEnabled,
        ...(costType && { costType }),
        ...(creativeSelection && { creativeSelection }),
        dailyBudget: {
          amount: stringDailyBudget,
          currencyCode: upperDailyBudgetCurrency,
        },
        locale: {
          country,
          language,
        },
        name: campaignName,
        offsiteDeliveryEnabled,
        ...(startTimestamp &&
          endTimestamp && {
            runSchedule: {
              start: startTimestamp,
              end: endTimestamp,
            },
          }),
        type,
        status: status.toUpperCase(),
        ...(unitCostAmount && {
          unitCost: {
            amount:
              typeof unitCostAmount === 'number' ? unitCostAmount.toString() : unitCostAmount,
            currencyCode: unitCostCurrencyCode.toUpperCase(),
          },
        }),
      };

      if (linkedInPageURN && linkedInPageURN.toString().trim() !== '') {
        campaignData.associatedEntity = linkedInPageURN;
      }

      const response = await axios.post(
        `${this.baseUrl}/rest/adAccounts/${accountId}/adCampaigns`,
        campaignData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      const campaignId = response.headers['x-restli-id'];
      return {
        success: true,
        message: 'Campaign created successfully',
        id: `urn:li:sponsoredCampaign:${campaignId}`,
        name: campaignName,
        status: status,
      };
    } catch (err: any) {
      this.logger.error(`LinkedIn campaign creation error: ${err?.message}`);

      if (err.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (err.response?.status === 404) {
        throw new BadRequestException(
          'LinkedIn Ad Account not found. Please verify your Account ID is correct and you have access to it.',
        );
      }

      if (err.response?.status === 403) {
        throw new BadRequestException(
          `Permission denied: ${err.response.data.message || 'Please check your LinkedIn account permissions for advertising.'}`,
        );
      }

      if (err.response?.status === 422) {
        throw new BadRequestException(err.response.data.message);
      }

      if (err.response?.data?.message?.includes('currencyCode expected to match value')) {
        throw new BadRequestException(
          'Currency mismatch: The provided currency does not match your LinkedIn ad account settings. Please update the currency accordingly.',
        );
      }

      if (err.response?.status === 400) {
        const errorData = err.response?.data;

        if (errorData?.message?.includes('/Campaign/status cannot be set to')) {
          throw new BadRequestException(
            'Campaign status conflict detected. Campaign and Campaign group status must match.',
          );
        }

        if (errorData?.message?.includes('/Campaign/creativeSelection cannot be set to')) {
          throw new BadRequestException(
            `Invalid creative selection for campaign type ${type}. SPONSORED_INMAILS campaigns must use ROUND_ROBIN creative selection.`,
          );
        }

        if (errorData?.message?.includes('/Campaign/costType cannot be set to')) {
          throw new BadRequestException(
            `Invalid cost type for campaign type ${type}. SPONSORED_INMAILS campaigns must use CPM cost type.`,
          );
        }

        if (
          errorData?.code === 'MULTIPLE_VALIDATIONS_FAILED' &&
          errorData?.errorDetails?.conditionalInputErrors?.length
        ) {
          const errors = errorData.errorDetails.conditionalInputErrors
            .map((e: any) => e.description)
            .filter(Boolean);
          throw new BadRequestException(errors.join('\n') || errorData.message);
        }

        throw new BadRequestException(
          err.response.data.message || 'Invalid campaign data',
        );
      }

      if (err instanceof BadRequestException) {
        throw err;
      }

      throw new BadRequestException(err.message || 'Failed to create campaign');
    }
  }

  async createTextAdCreative({
    accountId,
    campaignId,
    title,
    description,
    clickUri,
    userId,
    status = 'ACTIVE',
    mediaUrn,
  }: {
    accountId: string;
    campaignId: string;
    title: string;
    description: string;
    clickUri: string;
    userId: string;
    status?: 'ACTIVE' | 'DRAFT' | 'PAUSED' | 'ARCHIVED' | 'CANCELED';
    mediaUrn?: string;
  }) {
    try {
      const accessToken = await this.getAccessToken(userId);

      if (!accountId) {
        throw new BadRequestException('Account ID is required');
      }

      if (!campaignId) {
        throw new BadRequestException('Campaign ID is required');
      }

      if (!title) {
        throw new BadRequestException('Title (headline) is required');
      }

      if (!description) {
        throw new BadRequestException('Description is required');
      }

      if (!clickUri) {
        throw new BadRequestException('Landing URL is required');
      }

      if (title.length > 25) {
        throw new BadRequestException('Title must be 25 characters or less');
      }

      if (description.length > 75) {
        throw new BadRequestException('Description must be 75 characters or less');
      }

      const textAdData = {
        campaign: campaignId,
        content: {
          textAd: {
            landingPage: clickUri,
            headline: title,
            description,
            ...(mediaUrn && { image: mediaUrn }),
          },
        },
        intendedStatus: status.toUpperCase(),
      };

      const response = await axios.post(
        `${this.baseUrl}/rest/adAccounts/${accountId}/creatives`,
        textAdData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'LinkedIn-Version': this.LINKEDIN_API_VERSION,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      return {
        success: true,
        id: response.headers['x-restli-id'],
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn text ad creative creation error: ${error?.message}`);

      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          'Permission denied. Please check your LinkedIn account permissions.',
        );
      }

      if (error.response?.status === 400) {
        const errorMessage = error.response?.data?.message;

        if (errorMessage?.includes('/Creative/status transition is not allowed')) {
          throw new BadRequestException(
            'Invalid creative status. New ad creatives can only be set to ACTIVE or DRAFT initially. ' +
              'Other statuses like PAUSED or ARCHIVED are only allowed after the creative has been reviewed and approved.',
          );
        }

        if (errorMessage?.includes('review/reviewStatus')) {
          throw new BadRequestException(
            'Creative status change not allowed. The creative must be reviewed and approved before changing to this status.',
          );
        }

        if (errorMessage?.includes('/Creative/content')) {
          throw new BadRequestException(
            'Invalid creative content. Please check the title, description, and landing page URL requirements:\n' +
              '• Title must be 25 characters or less\n' +
              '• Description must be 75 characters or less\n' +
              '• Landing page URL must be valid and accessible',
          );
        }

        if (errorMessage?.includes('/Creative/campaign')) {
          throw new BadRequestException(
            'Invalid campaign association. Please ensure the campaign ID is valid and the campaign is active.',
          );
        }

        throw new BadRequestException(
          'Failed to create text ad creative: ' + (errorMessage || 'Invalid request'),
        );
      }

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        error.response?.data?.message ||
          'An error occurred while creating the text ad creative. Please try again or contact support.',
      );
    }
  }

  async getOrganizationPages(userId: string) {
    try {
      const accessToken = await this.getAccessToken(userId);

      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': this.LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      };

      const response = await axios.get(
        `${this.baseUrl}/v2/organizationalEntityAcls?q=roleAssignee&state=APPROVED`,
        { headers },
      );

      if (!response.data?.elements || response.data.elements.length === 0) {
        return {
          success: true,
          pages: [],
        };
      }

      const pagesPromises = response.data.elements.map(async (element: any) => {
        if (!element?.organizationalTarget) {
          this.logger.warn('Missing organizationalTarget in element');
          return null;
        }

        const organizationUrn = element.organizationalTarget;
        const organizationId = organizationUrn.split(':').pop();

        if (!organizationId) {
          this.logger.warn('Invalid organization URN');
          return null;
        }

        try {
          const orgDetails = await axios.get(
            `${this.baseUrl}/v2/organizations/${organizationId}`,
            { headers },
          );

          return {
            label: orgDetails.data.localizedName,
            value: organizationUrn,
          };
        } catch (error: any) {
          this.logger.error(
            `Error fetching details for organization ${organizationId}: ${error?.message}`,
          );
          return null;
        }
      });

      const pages = (await Promise.all(pagesPromises)).filter((page) => page !== null);
      return {
        success: true,
        pages,
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn get organization pages error: ${error?.message}`);

      if (error.response?.status === 401) {
        throw new BadRequestException(
          'LinkedIn authentication failed. Please reconnect your LinkedIn account.',
        );
      }

      if (error.response?.status === 403) {
        throw new BadRequestException(
          'Permission denied. Please check your LinkedIn account permissions.',
        );
      }

      throw new BadRequestException(
        `Failed to get LinkedIn pages: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  private async getDocumentPageCount(buffer: Buffer, fileExtension: string): Promise<number> {
    try {
      switch (fileExtension) {
        case 'pdf': {
          const pdfContent = buffer.toString('utf-8');
          return (pdfContent.match(/\/Page\b/g) || []).length;
        }
        case 'doc':
        case 'docx': {
          const docContent = buffer.toString('utf-8');
          return (docContent.match(/<w:br\s+type="page"/g) || []).length + 1;
        }
        case 'ppt':
        case 'pptx': {
          const pptContent = buffer.toString('utf-8');
          return (pptContent.match(/<p:sld/g) || []).length;
        }
        default:
          return 0;
      }
    } catch (error) {
      this.logger.error(`Error counting document pages: ${(error as any)?.message}`);
      throw new BadRequestException(
        'Unable to validate document page count. Please ensure the file is valid.',
      );
    }
  }
}
