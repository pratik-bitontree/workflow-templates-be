import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface KeyUsage {
  key: string;
  isRateLimited: boolean;
  requestsUsed: number;
  maxRequestsPerMinute: number;
  lastUsed: Date;
  totalTokensUsed: number;
}

@Injectable()
export class ApiKeyManager {
  private keyUsage: Map<string, Map<string, KeyUsage>> = new Map();
  private keyIndexes: Map<string, number> = new Map();

  constructor(private configService: ConfigService) {}

  async getNextAvailableKey(provider: string, userSecrets?: Record<string, any>): Promise<string> {
    const keys = this.getProviderKeys(provider, userSecrets);
    if (keys.length === 0) {
      throw new Error(`No API keys found for provider: ${provider}`);
    }

    let attempts = 0;
    const maxAttempts = keys.length * 2;

    while (attempts < maxAttempts) {
      const currentIndex = this.keyIndexes.get(provider) || 0;
      const key = keys[currentIndex];
      const usage = this.getKeyUsage(provider, key);

      if (!usage.isRateLimited && usage.requestsUsed < usage.maxRequestsPerMinute) {
        return key;
      }

      const nextIndex = (currentIndex + 1) % keys.length;
      this.keyIndexes.set(provider, nextIndex);
      attempts++;

      if (attempts % keys.length === 0) {
        await this.delay(1000);
        this.resetAllKeys(provider);
      }
    }

    throw new Error(`All keys for ${provider} are rate limited after ${maxAttempts} attempts`);
  }

  async markKeyAsRateLimited(provider: string, key: string): Promise<void> {
    const usage = this.getKeyUsage(provider, key);
    usage.isRateLimited = true;
    usage.requestsUsed = usage.maxRequestsPerMinute;
    setTimeout(() => this.resetKey(provider, key), 60000);
  }

  async updateTokenUsage(provider: string, key: string, tokensUsed: number): Promise<void> {
    const usage = this.getKeyUsage(provider, key);
    usage.totalTokensUsed += tokensUsed;
    usage.requestsUsed++;
    usage.lastUsed = new Date();
  }

  private resetAllKeys(provider: string): void {
    const keys = this.getProviderKeys(provider);
    for (const key of keys) {
      this.resetKey(provider, key);
    }
  }

  private resetKey(provider: string, key: string): void {
    const usage = this.getKeyUsage(provider, key);
    usage.isRateLimited = false;
    usage.requestsUsed = 0;
  }

  private getKeyUsage(provider: string, key: string): KeyUsage {
    if (!this.keyUsage.has(provider)) {
      this.keyUsage.set(provider, new Map());
    }
    const providerKeys = this.keyUsage.get(provider)!;
    if (!providerKeys.has(key)) {
      const config = this.getProviderConfig(provider);
      providerKeys.set(key, {
        key,
        isRateLimited: false,
        requestsUsed: 0,
        maxRequestsPerMinute: config.rateLimitPerMinute,
        lastUsed: new Date(),
        totalTokensUsed: 0,
      });
    }
    return providerKeys.get(key)!;
  }

  private getProviderConfig(provider: string): { rateLimitPerMinute: number } {
    const configs: Record<string, { rateLimitPerMinute: number }> = {
      openai: { rateLimitPerMinute: 3500 },
      anthropic: { rateLimitPerMinute: 1000 },
      groq: { rateLimitPerMinute: 5000 },
      gemini: { rateLimitPerMinute: 1000 },
    };
    return configs[provider] ?? { rateLimitPerMinute: 1000 };
  }

  private getProviderKeys(provider: string, userSecrets?: Record<string, any>): string[] {
    if (provider === 'openai' && userSecrets?.openai && Array.isArray(userSecrets.openai)) {
      const accounts = userSecrets.openai as { api_key?: string }[];
      const keys = accounts
        .filter((acc) => acc && typeof acc.api_key === 'string' && acc.api_key.trim())
        .map((acc) => acc.api_key!.trim());
      if (keys.length > 0) return keys;
    }

    if (provider === 'gemini' && userSecrets?.gemini && Array.isArray(userSecrets.gemini)) {
      const accounts = userSecrets.gemini as { api_key?: string }[];
      const keys = accounts
        .filter((acc) => acc && typeof acc.api_key === 'string' && acc.api_key.trim())
        .map((acc) => acc.api_key!.trim());
      if (keys.length > 0) return keys;
    }

    if (provider === 'openai') {
      const keys: string[] = [];
      let i = 1;
      while (true) {
        const key =
          this.configService.get<string>(`OPEN_AI_SECRET_KEY_${i}`) ??
          this.configService.get<string>(`OPENAI_API_KEY_${i}`);
        if (!key) break;
        keys.push(key);
        i++;
      }
      if (keys.length === 0) {
        const singleKey =
          this.configService.get<string>('OPEN_AI_SECRET_KEY') ??
          this.configService.get<string>('OPENAI_API_KEY');
        if (singleKey) return [singleKey];
      }
      if (keys.length > 0) return keys;
    }

    if (provider === 'gemini') {
      const keys: string[] = [];
      let i = 1;
      while (true) {
        const key = this.configService.get<string>(`GEMINI_API_KEY_${i}`);
        if (!key) break;
        keys.push(key);
        i++;
      }
      if (keys.length === 0) {
        const singleKey =
          this.configService.get<string>('GEMINI_API_KEY') ??
          this.configService.get<string>('GOOGLE_AI_API_KEY');
        if (singleKey) return [singleKey];
      }
      if (keys.length > 0) return keys;
    }

    const keys: string[] = [];
    let i = 1;
    while (true) {
      const key = this.configService.get<string>(`${provider.toUpperCase()}_API_KEY_${i}`);
      if (!key) break;
      keys.push(key);
      i++;
    }
    return keys;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
