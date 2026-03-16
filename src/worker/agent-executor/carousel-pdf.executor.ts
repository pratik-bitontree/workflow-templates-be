/**
 * In-process Carousel PDF Generator agent (nodeMasterId 69468d152f2a9d0c3beee92b).
 * Creates a carousel-style PDF from image URLs and uploads to S3.
 * Logic moved from GrowStack AI-Agent api.service.generateCarouselPdf + action.service.generateCarouselPdf.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

function normalizeImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

@Injectable()
export class CarouselPdfExecutor {
  private readonly logger = new Logger(CarouselPdfExecutor.name);

  constructor(private readonly config: ConfigService) {}

  async execute(params: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
    let imageWidth = params.imageWidth ?? params.image_width;
    let imageHeight = params.imageHeight ?? params.image_height;
    let imageUrls = params.imageUrls ?? params.image_urls;

    const width = typeof imageWidth === 'number' && imageWidth > 0
      ? imageWidth
      : typeof imageWidth === 'string' && parseInt(imageWidth, 10) > 0
        ? parseInt(imageWidth, 10)
        : 1200;
    const height = typeof imageHeight === 'number' && imageHeight > 0
      ? imageHeight
      : typeof imageHeight === 'string' && parseInt(imageHeight, 10) > 0
        ? parseInt(imageHeight, 10)
        : 1200;

    const urls = normalizeImageUrls(imageUrls);
    if (urls.length === 0) {
      return { success: false, error: 'imageUrls is required and must be a non-empty array or comma-separated string.' };
    }

    try {
      const PDFDocument = await this.loadPdfKit();
      if (!PDFDocument) {
        throw new Error('pdfkit is not installed. Install with: npm install pdfkit @types/pdfkit');
      }

      const doc = new (PDFDocument as any)({ autoFirstPage: false });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));

      let processedImages = 0;
      for (const url of urls) {
        try {
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 15 * 1024 * 1024,
          });
          const imageBuffer = Buffer.from(response.data);
          doc.addPage({ size: [width, height] });
          doc.image(imageBuffer, 0, 0, { width, height });
          processedImages++;
        } catch (err: any) {
          this.logger.warn(`Skipping image: ${url}`, err?.message);
        }
      }

      if (processedImages === 0) {
        throw new Error('No images could be processed');
      }

      doc.end();

      const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });

      const s3Bucket = this.config.get<string>('AWS_BUCKET_NAME');
      const s3Region = this.config.get<string>('AWS_REGION') || 'us-east-1';
      if (!s3Bucket) {
        this.logger.warn('AWS_BUCKET_NAME not set; cannot upload carousel PDF to S3.');
        return {
          success: false,
          error: 'AWS_BUCKET_NAME is required to upload the carousel PDF.',
        };
      }

      let S3Client: any;
      let PutObjectCommand: any;
      try {
        const s3 = await import('@aws-sdk/client-s3');
        S3Client = s3.S3Client;
        PutObjectCommand = s3.PutObjectCommand;
      } catch {
        return {
          success: false,
          error: '@aws-sdk/client-s3 is required for Carousel PDF upload.',
        };
      }

      const key = `carousel/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.pdf`;
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
          Body: pdfBuffer,
          ContentType: 'application/pdf',
        }),
      );
      const uploadedUrl = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${key}`;

      return {
        success: true,
        data: {
          result: uploadedUrl,
        },
      };
    } catch (err: any) {
      this.logger.error(`CarouselPdfExecutor failed: ${err?.message}`);
      return {
        success: false,
        error: err?.message ?? 'Failed to generate carousel PDF',
      };
    }
  }

  private async loadPdfKit(): Promise<any> {
    try {
      const pdfkit = await import('pdfkit');
      return (pdfkit as any).default ?? pdfkit;
    } catch {
      return null;
    }
  }
}
