import { BadRequestException } from '@nestjs/common';

/**
 * Build Gmail search query string from query type (subject, from, to, messageId, etc.)
 */
export function generateQueryForGmail(query: string, queryType: string): string {
  switch (queryType) {
    case 'subject':
      return `subject:${query}`;
    case 'from':
      return `from:${query}`;
    case 'to':
      return `to:${query}`;
    case 'cc':
      return `cc:${query}`;
    case 'bcc':
      return `bcc:${query}`;
    case 'messageId':
      return `rfc822msgid:${query}`;
    case 'has':
      return `has:${query}`;
    case 'filename':
      return `filename:${query}`;
    case 'in':
      return `in:${query}`;
    case 'after':
      return `after:${query}`;
    case 'before':
      return `before:${query}`;
    case 'older':
      return `older:${query}`;
    case 'newer':
      return `newer:${query}`;
    case 'larger':
      return `larger:${query}`;
    case 'smaller':
      return `smaller:${query}`;
    case 'list':
      return `list:${query}`;
    default:
      return query;
  }
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmails(fieldName: string, emails: string | string[]): void {
  if (!emails) return;
  const emailList = Array.isArray(emails) ? emails : emails.split(',').map((e) => e.trim());
  const invalid = emailList.find((email) => !EMAIL_REGEX.test(String(email).trim()));
  if (invalid) {
    throw new BadRequestException(`Invalid ${fieldName} email: ${invalid}`);
  }
}
