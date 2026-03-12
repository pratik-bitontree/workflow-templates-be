import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Types } from 'mongoose';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { marked } from 'marked';
import { UserSecrets, UserSecretsDocument } from '../../schemas/user-secrets.schema';
import { generateQueryForGmail, validateEmails } from '../utils/gmail.utils';

const GMAIL_API_BASE = 'https://gmail.googleapis.com';
const GMAIL_TOKEN_EXPIRY_SEC = 3600;

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);
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
      throw new Error(
        'Missing Google OAuth config: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
      );
    }
    this.clientId = cid;
    this.clientSecret = csec;
    this.redirectUri = ruri;
  }

  private async getAuthToken(userId: string): Promise<string> {
    if (!userId) {
      throw new BadRequestException('User ID is required for Gmail');
    }
    const userSecrets = await this.userSecretsModel
      .findOne({
        user_id: new Types.ObjectId(userId),
        'gmail.isPrimary': true,
      })
      .select({ gmail: { $elemMatch: { isPrimary: true } } })
      .lean();
    const primary = (userSecrets as any)?.gmail?.[0];
    if (!primary) {
      throw new BadRequestException('No primary Gmail account found. Connect Gmail in Integration Hub.');
    }
    const { access_token, refresh_token, created_at, accountId } = primary;
    if (!refresh_token) {
      throw new BadRequestException('Gmail token missing. Please re-authenticate Gmail.');
    }
    const tokenAge = created_at
      ? (Date.now() - new Date(created_at).getTime()) / 1000
      : Infinity;
    let accessToken: string = access_token || '';
    if (!access_token || tokenAge >= GMAIL_TOKEN_EXPIRY_SEC) {
      const oauth2 = new OAuth2Client(
        this.clientId,
        this.clientSecret,
        this.redirectUri,
      );
      oauth2.setCredentials({
        access_token: access_token || undefined,
        refresh_token,
      });
      const { credentials } = await oauth2.refreshAccessToken();
      accessToken = credentials.access_token!;
      const gmailAccounts = (userSecrets as any)?.gmail || [];
      const updated = gmailAccounts.map((acc: any) =>
        acc.accountId?.toString() === accountId?.toString()
          ? {
              ...acc,
              access_token: credentials.access_token,
              refresh_token: credentials.refresh_token || acc.refresh_token,
              created_at: new Date(),
            }
          : acc,
      );
      await this.userSecretsModel.updateOne(
        { user_id: new Types.ObjectId(userId) },
        { $set: { gmail: updated } },
      );
    }
    if (!accessToken || typeof accessToken !== 'string') {
      throw new BadRequestException('Invalid Gmail access token');
    }
    return accessToken;
  }

  async searchEmails(params: {
    queryType: string;
    query: string;
    folder?: string;
    dateRange?: { afterDate?: string; beforeDate?: string };
    user_id: string;
  }): Promise<any[]> {
    const { queryType, query, folder, dateRange, user_id } = params;
    if (!query) {
      this.logger.warn('Query is undefined or invalid');
      throw new BadRequestException('Query is undefined or invalid');
    }
    const token = await this.getAuthToken(user_id);
    let baseQuery = queryType ? generateQueryForGmail(query, queryType) : query;
    const folderQuery = folder ? `${baseQuery} in:${folder}` : baseQuery;
    const dateRangeQuery = dateRange
      ? `${folderQuery}${dateRange?.afterDate ? ` after:${dateRange.afterDate}` : ''}${dateRange?.beforeDate ? ` before:${dateRange.beforeDate}` : ''}`
      : folderQuery;
    const q = dateRangeQuery.trim();
    const res = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/messages?format=full&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res?.data?.messages) {
      this.logger.log('No messages found for query/folder/date range');
      throw new BadRequestException(
        'No messages found with that query or in the folder or date range',
      );
    }
    const emails = await this.getEmailsById({
      messages: res.data.messages,
      token,
    });
    return emails.map((email: any) => ({
      message_id: email.messageId,
      threadId: email.threadId,
      id: email.id,
      sender_email_id: email.from,
      recipients: {
        to: Array.isArray(email.to) ? email.to : email.to?.split(',') || [],
        cc: Array.isArray(email.cc) ? email.cc : email.cc?.split(',') || [],
        bcc: Array.isArray(email.bcc) ? email.bcc : email.bcc?.split(',') || [],
      },
      subject: email.subject || '',
      body: email.body || '',
      attachments: email.attachments || [],
      userEmailId: email.userEmailId,
    }));
  }

  async getEmailsById(params: {
    messages: Array<{ id: string }>;
    token: string;
  }): Promise<any[]> {
    const { messages, token } = params;
    if (!messages?.length) {
      throw new BadRequestException('No messages found');
    }
    let userEmailId: string | undefined;
    try {
      const profile = await axios.get(
        `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      userEmailId = profile.data?.emailAddress;
    } catch {
      // continue without userEmailId
    }
    const results = await Promise.allSettled(
      messages.map(async (msg) => {
        if (!msg.id) throw new Error("Message missing 'id'");
        const res = await axios.get(
          `${GMAIL_API_BASE}/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = res?.data?.payload;
        if (!body) return null;
        let to: string[] = [];
        let cc: string[] = [];
        let bcc: string[] = [];
        let from = '';
        body?.headers?.forEach((h: { name?: string; value?: string }) => {
          if (h.name?.toLowerCase() === 'from') {
            const m = h.value?.match(/<([^>]+)>/);
            from = m ? m[1] : h.value || '';
          }
          if (h.value) {
            const recipients = h.value.split(',').map((e: string) => {
              const m = e.match(/<([^>]+)>/);
              return m ? m[1].trim() : e.trim();
            });
            switch (h.name?.toLowerCase()) {
              case 'to':
                to = recipients.filter((r) => r !== userEmailId);
                break;
              case 'cc':
                cc = recipients.filter((r) => r !== userEmailId);
                break;
              case 'bcc':
                bcc = recipients.filter((r) => r !== userEmailId);
                break;
            }
          }
        });
        const subject =
          body?.headers?.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
        const messageId =
          body?.headers?.find((h: any) => h.name?.toLowerCase() === 'message-id')?.value;
        const date =
          body?.headers?.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
        const attachments = body?.parts
          ? body.parts
              .filter((p: any) => p.filename && p.body?.attachmentId)
              .map((p: any) => ({
                filename: p.filename,
                attachmentId: p.body.attachmentId,
              }))
          : [];
        let emailBody = '';
        if (body?.body?.data) {
          emailBody = Buffer.from(body.body.data, 'base64').toString('utf-8');
        } else if (body?.parts) {
          const extract = (parts: any[]): string => {
            for (const part of parts) {
              if (
                part.mimeType === 'text/plain' ||
                part.mimeType === 'text/html'
              ) {
                if (part.body?.data) {
                  return Buffer.from(part.body.data, 'base64').toString('utf-8');
                }
              }
              if (part.parts) {
                const n = extract(part.parts);
                if (n) return n;
              }
            }
            return '';
          };
          emailBody = extract(body.parts);
        }
        return {
          to,
          from,
          cc,
          bcc,
          subject,
          messageId,
          attachments,
          body: emailBody,
          id: res?.data?.id,
          threadId: res?.data?.threadId,
          historyId: res?.data?.historyId,
          date,
          userEmailId,
        };
      }),
    );
    const list = results
      .filter((r) => (r as any).status === 'fulfilled' && (r as any).value)
      .map((r) => (r as any).value);
    if (!list.length) {
      throw new BadRequestException('Error while fetching email details');
    }
    return list;
  }

  private cleanAttachments(attachments: any): string[] {
    if (!attachments) return [];
    const raw =
      typeof attachments === 'string'
        ? attachments
            .replace(/!\[.*?\]/g, '')
            .replace(/\[|\]|\(|\)/g, '')
            .replace(/[@"]/g, '')
            .replace(/\s+/g, '')
            .split(',')
            .map((u: string) => u.trim())
            .filter((url: string) => {
              try {
                new URL(url);
                return url.startsWith('http');
              } catch {
                return false;
              }
            })
        : Array.isArray(attachments)
          ? attachments
          : [attachments];
    return raw;
  }

  private async fetchAttachmentAsBase64(url: string): Promise<{
    fileName: string;
    base64File: string;
  }> {
    const response = await axios.get(url.trim(), { responseType: 'arraybuffer' });
    const base64File = Buffer.from(response.data, 'binary').toString('base64');
    const fileName = url.trim().split('/').pop() || 'attachment';
    return { fileName, base64File };
  }

  async sendEmail(params: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    message: string;
    attachments?: any;
    user_id: string;
  }): Promise<{
    Status: string;
    message_id: string;
    sender_email_id: string;
    recipients: { to: string[]; cc: string[]; bcc: string[] };
    subject: string;
    Body: string;
    Attachments: string[];
  }> {
    const { to, cc, bcc, subject, message, attachments, user_id } = params;
    const token = await this.getAuthToken(user_id);
    if (!to || (Array.isArray(to) && !to.length) || !subject) {
      throw new BadRequestException('To and Subject are required');
    }
    validateEmails('to', to);
    if (cc?.length) validateEmails('cc', cc);
    if (bcc?.length) validateEmails('bcc', bcc);

    let processedMessage = message;
    let processedSubject = subject;
    try {
      if (
        typeof message === 'string' &&
        (message.startsWith('[') || message.startsWith('"'))
      ) {
        try {
          const parsed = JSON.parse(message);
          processedMessage = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
          processedMessage = message;
        }
      }
      if (
        typeof subject === 'string' &&
        (subject.startsWith('[') || subject.startsWith('"'))
      ) {
        try {
          const parsed = JSON.parse(subject);
          processedSubject = Array.isArray(parsed) ? parsed[0] : parsed;
        } catch {
          processedSubject = subject;
        }
      }
      processedMessage =
        '<!DOCTYPE html><html><body>' +
        (await marked(processedMessage, { gfm: true, breaks: true, silent: true })) +
        '</body></html>';
      processedSubject = (await marked(processedSubject))
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
    } catch (err) {
      this.logger.warn('Markdown processing failed, using raw', err);
    }

    const boundary =
      '----boundary_string_' + Math.random().toString(36).substring(7);
    const headers = [
      `To: ${Array.isArray(to) ? to.join(', ') : to}`,
      cc?.length ? `Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}` : '',
      bcc?.length ? `Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}` : '',
      `Subject: ${processedSubject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      'MIME-Version: 1.0',
    ].filter((l) => l.trim() !== '');
    const bodyLines = [
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      processedMessage,
    ];
    const mailAttachments: string[] = [];
    const cleanAtt = this.cleanAttachments(attachments);
    if (cleanAtt.length > 0) {
      const resolved = await Promise.all(
        cleanAtt.map((url) => this.fetchAttachmentAsBase64(url)),
      );
      resolved.forEach(({ fileName, base64File }) => {
        mailAttachments.push(
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${fileName}"`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64File,
        );
      });
    }
    const emailContent = [
      ...headers,
      ...bodyLines,
      ...mailAttachments,
      `--${boundary}--`,
    ].join('\r\n');
    const raw = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await axios.post(
      `${GMAIL_API_BASE}/gmail/v1/users/me/messages/send`,
      { raw },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new BadRequestException('Failed to send email');
    }
    const emailDetails = await this.getEmailsById({
      messages: res.data?.id ? [{ id: res.data.id }] : [],
      token,
    });
    const profile = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const senderEmailId = profile.data?.emailAddress || '';
    return {
      Status: 'Email sent successfully',
      message_id: emailDetails.length > 0 ? emailDetails[0].messageId : '',
      sender_email_id: senderEmailId,
      recipients: {
        to: Array.isArray(to) ? to : to ? to.split(',') : [],
        cc: cc ? (Array.isArray(cc) ? cc : cc.split(',')) : [],
        bcc: bcc ? (Array.isArray(bcc) ? bcc : bcc.split(',')) : [],
      },
      subject: subject || '',
      Body: message || '',
      Attachments: attachments
        ? Array.isArray(attachments)
          ? attachments
          : String(attachments)
              .split(',')
              .map((u: string) => u.trim())
        : [],
    };
  }

  async createDraft(params: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    message: string;
    attachments?: any;
    user_id: string;
  }): Promise<any> {
    const { to, cc, bcc, subject, message, attachments, user_id } = params;
    const token = await this.getAuthToken(user_id);
    if (!to || !subject) {
      throw new BadRequestException('To and Subject are required');
    }
    validateEmails('to', to);
    if (cc?.length) validateEmails('cc', cc);
    if (bcc?.length) validateEmails('bcc', bcc);

    const boundary =
      '----boundary_string_' + Math.random().toString(36).substring(7);
    const headers = [
      `To: ${Array.isArray(to) ? to.join(', ') : to}`,
      cc?.length ? `Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}` : '',
      bcc?.length ? `Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}` : '',
      `Subject: ${subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      'MIME-Version: 1.0',
    ].filter((l) => l.trim() !== '');
    const bodyLines = [
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      message,
    ];
    const mailAttachments: string[] = [];
    const cleanAtt = this.cleanAttachments(attachments);
    if (cleanAtt.length > 0) {
      const resolved = await Promise.all(
        cleanAtt.map((url) => this.fetchAttachmentAsBase64(url)),
      );
      resolved.forEach(({ fileName, base64File }) => {
        mailAttachments.push(
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${fileName}"`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64File,
        );
      });
    }
    const emailContent = [
      ...headers,
      ...bodyLines,
      ...mailAttachments,
      `--${boundary}--`,
    ].join('\r\n');
    const raw = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await axios.post(
      `${GMAIL_API_BASE}/gmail/v1/users/me/drafts`,
      { message: { raw } },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new BadRequestException('Failed to create draft');
    }
    const profile = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return {
      draft_id: res.data?.id,
      sender_email_id: profile.data?.emailAddress,
      recipients: {
        to: Array.isArray(to) ? to : to ? to.split(',') : [],
        cc: cc ? (Array.isArray(cc) ? cc : cc.split(',')) : [],
        bcc: bcc ? (Array.isArray(bcc) ? bcc : bcc.split(',')) : [],
      },
      subject,
      body: message,
      attachments: this.cleanAttachments(attachments),
    };
  }

  async draftReply(params: {
    messageId: string;
    readyMessageBody: string;
    attachments?: any;
    user_id: string;
  }): Promise<any> {
    const { messageId, readyMessageBody, attachments, user_id } = params;
    const token = await this.getAuthToken(user_id);
    if (!messageId || !readyMessageBody) {
      throw new BadRequestException('Message ID and Message are required');
    }
    const searchRes = await this.searchEmails({
      queryType: 'messageId',
      query: messageId,
      user_id,
      folder: '',
      dateRange: {},
    });
    const first = searchRes[0];
    const { sender_email_id, recipients, subject, threadId, userEmailId } = first;
    let to = first.recipients?.to || [];
    let cc = first.recipients?.cc || [];
    let bcc = first.recipients?.bcc || [];
    if (sender_email_id && sender_email_id !== userEmailId) {
      to = Array.isArray(to) ? [...to, sender_email_id] : [sender_email_id];
    }
    const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
    const boundary =
      '----boundary_string_' + Math.random().toString(36).substring(7);
    const headers = [
      `To: ${to.join(', ')}`,
      cc?.length ? `Cc: ${cc.join(', ')}` : '',
      bcc?.length ? `Bcc: ${bcc.join(', ')}` : '',
      `Subject: ${replySubject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${threadId}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      'MIME-Version: 1.0',
    ].filter((l) => l.trim() !== '');
    const bodyLines = [
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      readyMessageBody,
    ];
    const mailAttachments: string[] = [];
    const cleanAtt = this.cleanAttachments(attachments);
    if (cleanAtt.length > 0) {
      const resolved = await Promise.all(
        cleanAtt.map((url) => this.fetchAttachmentAsBase64(url)),
      );
      resolved.forEach(({ fileName, base64File }) => {
        mailAttachments.push(
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${fileName}"`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64File,
        );
      });
    }
    const emailContent = [
      ...headers,
      ...bodyLines,
      ...mailAttachments,
      `--${boundary}--`,
    ].join('\r\n');
    const raw = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await axios.post(
      `${GMAIL_API_BASE}/gmail/v1/users/me/drafts`,
      { message: { raw, threadId } },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new BadRequestException('Failed to create draft reply');
    }
    const profile = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return {
      draft_id: res.data?.id,
      message_id: messageId,
      sender_email_id: profile.data?.emailAddress,
      recipients: { to, cc, bcc },
      body: readyMessageBody,
      attachments: this.cleanAttachments(attachments),
    };
  }

  async sendReply(params: {
    messageId: string;
    readyMessageBody: string;
    attachments?: any;
    user_id: string;
  }): Promise<any> {
    const { messageId, readyMessageBody, attachments, user_id } = params;
    const token = await this.getAuthToken(user_id);
    if (!messageId || !readyMessageBody) {
      throw new BadRequestException('Message ID and Message are required');
    }
    const searchRes = await this.searchEmails({
      queryType: 'messageId',
      query: messageId,
      user_id,
      folder: '',
      dateRange: {},
    });
    const first = searchRes[0];
    const { recipients, sender_email_id, subject, threadId, userEmailId } = first;
    const toList = Array.isArray(recipients.to) ? [...recipients.to] : [];
    if (sender_email_id && sender_email_id !== userEmailId) {
      toList.push(sender_email_id);
    }
    const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
    const boundary =
      '----boundary_string_' + Math.random().toString(36).substring(7);
    const headers = [
      `To: ${toList.join(', ')}`,
      recipients.cc?.length
        ? `Cc: ${Array.isArray(recipients.cc) ? recipients.cc.join(', ') : recipients.cc}`
        : '',
      recipients.bcc?.length
        ? `Bcc: ${Array.isArray(recipients.bcc) ? recipients.bcc.join(', ') : recipients.bcc}`
        : '',
      `Subject: ${replySubject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${threadId}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      'MIME-Version: 1.0',
    ].filter((l) => l.trim() !== '');
    const bodyLines = [
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      readyMessageBody,
      `--${boundary}--`,
    ];
    const mailAttachments: string[] = [];
    const cleanAtt = this.cleanAttachments(attachments);
    if (cleanAtt.length > 0) {
      const resolved = await Promise.all(
        cleanAtt.map((url) => this.fetchAttachmentAsBase64(url)),
      );
      resolved.forEach(({ fileName, base64File }) => {
        mailAttachments.push(
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${fileName}"`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          'Content-Transfer-Encoding: base64',
          '',
          base64File,
        );
      });
    }
    const emailContent = [
      ...headers,
      ...bodyLines,
      ...mailAttachments,
      `--${boundary}--`,
    ].join('\r\n');
    const raw = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await axios.post(
      `${GMAIL_API_BASE}/gmail/v1/users/me/messages/send`,
      { raw, threadId },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new BadRequestException('Failed to send reply');
    }
    const profile = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return {
      reply_message_id: res.data?.id,
      message_id: messageId,
      sender_email_id: profile.data?.emailAddress,
      recipients: {
        to: toList,
        cc: recipients.cc || [],
        bcc: recipients.bcc || [],
      },
      body: readyMessageBody,
      attachments: this.cleanAttachments(attachments),
      time: new Date().toISOString(),
    };
  }

  async deleteEmail(params: { messageId: string; user_id: string }): Promise<any> {
    const { messageId, user_id } = params;
    const token = await this.getAuthToken(user_id);
    if (!messageId) {
      throw new BadRequestException('Message ID is required');
    }
    const searchRes = await this.searchEmails({
      queryType: 'messageId',
      query: messageId,
      user_id,
      folder: '',
      dateRange: {},
    });
    if (!searchRes?.length) {
      throw new BadRequestException(`No email found with Id: ${messageId}`);
    }
    const emailDetails = searchRes[0];
    const id = emailDetails?.id;
    if (!id) {
      throw new BadRequestException('Email ID required to delete');
    }
    await axios.post(
      `${GMAIL_API_BASE}/gmail/v1/users/me/messages/${id}/trash`,
      {},
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const profile = await axios.get(
      `${GMAIL_API_BASE}/gmail/v1/users/me/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return {
      message_id: messageId,
      sender_email_id: profile.data?.emailAddress,
      recipients: {
        to: emailDetails.recipients?.to || [],
        cc: emailDetails.recipients?.cc || [],
        bcc: emailDetails.recipients?.bcc || [],
      },
      body: emailDetails.body || '',
      attachments: emailDetails.attachments || [],
      time: new Date().toISOString(),
      status: 'Email deleted successfully',
    };
  }
}
