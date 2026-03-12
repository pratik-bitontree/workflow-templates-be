import { Injectable, Logger } from '@nestjs/common';
import { ApiKeyManager } from './api-key-manager.service';

export interface RateLimitConfig {
  provider: string;
  requestFn: (apiKey: string) => Promise<any>;
  fallback?: () => Promise<any>;
  /** Optional user secrets from Integration Hub - used when present instead of env */
  userSecrets?: Record<string, any>;
}

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(private apiKeyManager: ApiKeyManager) {}

  async execute(config: RateLimitConfig): Promise<any> {
    let attempts = 0;
    const maxAttempts = 6;
    let apiKey: string | undefined;

    while (attempts < maxAttempts) {
      try {
        apiKey = await this.apiKeyManager.getNextAvailableKey(config.provider, config.userSecrets);
        const result = await config.requestFn(apiKey);

        if (result && result.usage) {
          const totalTokens = this.calculateTotalTokens(result.usage);
          await this.apiKeyManager.updateTokenUsage(config.provider, apiKey, totalTokens);
        }
        return result;
      } catch (error: any) {
        attempts++;
        // Auth errors (invalid/expired key) are not retriable — fail fast with real message
        if (this.isAuthError(error)) {
          throw error;
        }
        if (this.isRateLimitError(error)) {
          if (apiKey) {
            await this.apiKeyManager.markKeyAsRateLimited(config.provider, apiKey);
          }
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `All API keys failed for ${config.provider}. Max attempts reached. Please try again later.`,
    );
  }

  /** Auth errors (401, invalid key) are not retriable — caller should see the real error. */
  private isAuthError(error: any): boolean {
    if (error.response?.status === 401) return true;
    if (error.status === 401) return true;
    const code = error.response?.data?.error?.code ?? error.code;
    if (code === 'invalid_api_key' || code === 'authentication_error') return true;
    const msg = (error.message ?? error.response?.data?.error?.message ?? '').toLowerCase();
    return (
      msg.includes('incorrect api key') ||
      msg.includes('invalid api key') ||
      msg.includes('invalid_api_key') ||
      msg.includes('authentication failed')
    );
  }

  private isRateLimitError(error: any): boolean {
    if (error.response?.status === 429) return true;
    if (error.response?.data?.error?.type === 'rate_limit_exceeded') return true;
    if (error.response?.data?.error?.type === 'insufficient_quota') return true;
    if (error.response?.data?.error?.code === 'billing_hard_limit_reached') return true;
    if (error.code === 'insufficient_quota' || error.code === 'billing_hard_limit_reached') return true;
    if (error.response?.status === 400 &&
      (error.message?.toLowerCase().includes('exceeded your current quota') ||
        error.response?.data?.message?.toLowerCase?.().includes('exceeded your current quota') ||
        error.response?.data?.error?.code === 'billing_hard_limit_reached')) return true;

    const msg = (error.message ?? '').toLowerCase();
    return (
      msg.includes('rate limit') ||
      msg.includes('quota exceeded') ||
      msg.includes('exceeded your current quota') ||
      msg.includes('too many requests') ||
      msg.includes('insufficient_quota') ||
      msg.includes('billing hard limit') ||
      msg.includes('billing_hard_limit_reached') ||
      msg.includes('429')
    );
  }

  private calculateTotalTokens(usage: any): number {
    if (!usage) return 0;
    if (usage.prompt_tokens != null && usage.completion_tokens != null) {
      return usage.prompt_tokens + usage.completion_tokens;
    }
    if (usage.input_tokens != null && usage.output_tokens != null) {
      return usage.input_tokens + usage.output_tokens;
    }
    return usage.total_tokens ?? 0;
  }
}
