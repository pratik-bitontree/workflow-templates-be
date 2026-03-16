/**
 * In-process SEO Keywords agent (Generate SEO Keywords by Topic).
 * Uses Serper for suggestions when SERPER_API_KEY is set; otherwise uses OpenAI to suggest one keyword.
 * Template expects result.HIGH_TREND.keyword and data.result.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';

@Injectable()
export class SeoKeywordsExecutor {
  private readonly logger = new Logger(SeoKeywordsExecutor.name);

  constructor(private readonly config: ConfigService) {}

  async execute(params: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
    const topic = params.topic ?? '';
    const region = params.region ?? 'US';
    const timeRange = params.timeRange ?? '1m';
    if (!topic || String(topic).trim() === '') {
      return { success: false, error: 'topic is required for SEO Keywords agent.' };
    }

    const serperKey = this.config.get<string>('SERPER_API_KEY');
    let keyword = '';

    if (serperKey) {
      try {
        const res = await axios.post(
          'https://google.serper.dev/autocomplete',
          { q: topic, gl: (region || 'us').toLowerCase().slice(0, 2) },
          {
            headers: {
              'X-API-KEY': serperKey,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          },
        );
        const suggestions = res.data?.suggestions ?? [];
        keyword = Array.isArray(suggestions) && suggestions.length > 0 ? String(suggestions[0]) : '';
      } catch (err: any) {
        this.logger.warn(`Serper autocomplete failed: ${err?.message}`);
      }
    }

    if (!keyword) {
      const apiKey = this.config.get<string>('OPEN_AI_SECRET_KEY') ?? this.config.get<string>('OPEN_AI_SECRET_KEY_1') ?? '';
      const client = new OpenAI({ apiKey: apiKey || 'placeholder' });
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `Given the topic "${topic}", reply with exactly one high-intent SEO keyword (2-5 words), nothing else.`,
          },
        ],
        temperature: 0.3,
        max_tokens: 30,
      });
      keyword = completion.choices?.[0]?.message?.content?.trim() ?? topic;
    }

    const result = {
      HIGH_TREND: { keyword },
      MEDIUM_TREND: { keyword },
    };
    return {
      success: true,
      data: {
        result,
        data: { result },
      },
    };
  }
}
