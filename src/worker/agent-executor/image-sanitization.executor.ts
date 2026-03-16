/**
 * In-process Image Sanitization agent (metadata cleaner for LinkedIn/blog).
 * Re-encodes image to JPEG to strip metadata. Requires sourceImageUrl (or s3Links).
 * Optional: AWS S3 to upload sanitized image and return URL; else returns original URL.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class ImageSanitizationExecutor {
  private readonly logger = new Logger(ImageSanitizationExecutor.name);

  constructor(private readonly config: ConfigService) {}

  async execute(params: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
    let sourceImageUrl = params.sourceImageUrl ?? params.s3Links;
    if (Array.isArray(sourceImageUrl)) sourceImageUrl = sourceImageUrl[0];
    if (typeof sourceImageUrl !== 'string' || !sourceImageUrl.trim()) {
      return { success: false, error: 'sourceImageUrl (or s3Links) is required for Image Sanitization.' };
    }
    sourceImageUrl = sourceImageUrl.trim();

    try {
      const sharp = await this.loadSharp();
      if (!sharp) {
        this.logger.warn('sharp not installed; returning original URL (no sanitization).');
        return { success: true, data: sourceImageUrl };
      }

      const response = await axios.get(sourceImageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024,
      });
      const buffer = Buffer.from(response.data);
      const sharpInstance = (sharp as any)(buffer);
      const jpegBuffer = await sharpInstance
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer();

      const s3Bucket = this.config.get<string>('AWS_BUCKET_NAME');
      const s3Region = this.config.get<string>('AWS_REGION') || 'us-east-1';
      if (s3Bucket) {
        let S3Client: any;
        let PutObjectCommand: any;
        try {
          const s3 = await import('@aws-sdk/client-s3');
          S3Client = s3.S3Client;
          PutObjectCommand = s3.PutObjectCommand;
        } catch {
          this.logger.warn('@aws-sdk/client-s3 not installed; returning original URL.');
          return { success: true, data: sourceImageUrl };
        }
        const key = `sanitized/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
        const client = new S3Client({
          region: s3Region,
          credentials: {
            accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID') ?? '',
            secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY') ?? '',
          },
        });
        await client.send(
          new PutObjectCommand({
            Bucket: s3Bucket,
            Key: key,
            Body: jpegBuffer,
            ContentType: 'image/jpeg',
          }),
        );
        const url = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${key}`;
        return { success: true, data: url };
      }

      return { success: true, data: sourceImageUrl };
    } catch (err: any) {
      this.logger.warn(`ImageSanitizationExecutor failed: ${err?.message}`);
      return {
        success: false,
        error: err?.message ?? 'Image sanitization failed.',
      };
    }
  }

  private async loadSharp(): Promise<any> {
    try {
      const sharp = await import('sharp');
      return sharp.default ?? sharp;
    } catch {
      return null;
    }
  }
}
