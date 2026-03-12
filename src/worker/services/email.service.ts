import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  message: string;
  user_id?: string;
  attachments?: Array<{ filename: string; content: string | Buffer }>;
}

/**
 * Email service for workflow send-email action.
 * Uses SMTP from config (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).
 * For per-user OAuth (e.g. Gmail) you would need a separate integration.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');
    if (host && port) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: port === 465,
        auth: user && pass ? { user, pass } : undefined,
      });
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<{ messageId?: string }> {
    if (!this.transporter) {
      throw new BadRequestException(
        'Email not configured. Set SMTP_HOST, SMTP_PORT, and optionally SMTP_USER, SMTP_PASS, SMTP_FROM.',
      );
    }

    const to = Array.isArray(options.to) ? options.to : [options.to].filter(Boolean);
    if (!to.length) {
      throw new BadRequestException('At least one recipient (to) is required');
    }

    const from = this.configService.get<string>('SMTP_FROM') || this.configService.get<string>('SMTP_USER') || 'noreply@localhost';

    const mailOptions: nodemailer.SendMailOptions = {
      from,
      to: to.join(', '),
      cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : undefined,
      bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : undefined,
      subject: options.subject || '(No subject)',
      text: options.message,
      html: options.message?.includes('<') ? options.message : undefined,
      attachments: options.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      this.logger.log(`Email sent: ${info.messageId}`);
      return { messageId: info.messageId };
    } catch (error: any) {
      this.logger.error(`Send email failed: ${error?.message}`, error?.stack);
      throw new BadRequestException(`Failed to send email: ${error?.message}`);
    }
  }
}
