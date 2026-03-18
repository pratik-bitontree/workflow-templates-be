/**
 * In-process SEO Keywords agent (Generate SEO Keywords by Topic).
 * Uses Serper for suggestions when SERPER_API_KEY is set; otherwise uses OpenAI to suggest one keyword.
 * Template expects result.HIGH_TREND.keyword and data.result.
 * Accepts topic or keywords param (and workflowInput.topic/keywords via action.service).
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
    // Accept both topic and keywords (templates may use either; action.service merges workflowInput)
    const rawTopic = params.topic ?? params.keywords ?? '';
    const topic = typeof rawTopic === 'string' ? rawTopic.trim() : String(rawTopic ?? '').trim();
    const region = (params.region ?? 'US').toString().trim() || 'US';
    const timeRange = (params.timeRange ?? '1m').toString().trim() || '1m';

    if (!topic) {
      this.logger.warn('[SeoKeywordsExecutor] Missing topic/keywords in params');
      return { success: false, error: 'topic or keywords is required for SEO Keywords agent.' };
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
        const first = Array.isArray(suggestions) && suggestions.length > 0 ? suggestions[0] : null;
        keyword = this.toReadableKeyword(first);
      } catch (err: any) {
        this.logger.warn(`Serper autocomplete failed: ${err?.message}`);
      }
    }

    if (!keyword) {
      const apiKey =
        this.config.get<string>('OPEN_AI_SECRET_KEY') ??
        this.config.get<string>('OPEN_AI_SECRET_KEY_1') ??
        this.config.get<string>('OPENAI_API_KEY') ??
        '';
      if (!apiKey || apiKey === 'placeholder') {
        this.logger.warn('[SeoKeywordsExecutor] No OpenAI key (OPEN_AI_SECRET_KEY_1 or OPENAI_API_KEY); using topic as keyword');
        keyword = topic;
      } else {
        try {
          const client = new OpenAI({ apiKey });
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
        } catch (err: any) {
          this.logger.error(`[SeoKeywordsExecutor] OpenAI failed: ${err?.message}`);
          return {
            success: false,
            error: `SEO keyword generation failed: ${err?.message ?? 'OpenAI error'}. Check OPENAI_API_KEY or OPEN_AI_SECRET_KEY_1.`,
          };
        }
      }
    }

    if (!keyword) keyword = topic;

    const keywordStr = this.toReadableKeyword(keyword) || String(topic).trim();
    const result = {
      HIGH_TREND: { keyword: keywordStr },
      MEDIUM_TREND: { keyword: keywordStr },
    };
    return {
      success: true,
      data: {
        result,
        data: { result, status: 'COMPLETED' }, // status so worker marks node completed (no waiting_for_webhook)
      },
    };
  }

  /** Always return a readable string; avoid "[object Object]" when value is an object. */
  private toReadableKeyword(value: any): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value !== 'object') return String(value).trim();
    const o = value as Record<string, unknown>;
    const s =
      (typeof o.query === 'string' && o.query.trim()) ||
      (typeof o.suggestion === 'string' && (o.suggestion as string).trim()) ||
      (typeof o.keyword === 'string' && (o.keyword as string).trim()) ||
      (typeof o.text === 'string' && (o.text as string).trim());
    if (s) return s.trim();
    const firstStr = Object.values(o).find((v) => typeof v === 'string' && (v as string).trim());
    if (firstStr) return String(firstStr).trim();
    return JSON.stringify(o);
  }
}
