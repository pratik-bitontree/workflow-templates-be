/**
 * In-process Reddit Search agent (Reddit Topic Trend Summary).
 * Uses Serper to search Reddit, then OpenAI to structure into template result shape.
 * Requires SERPER_API_KEY in .env.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';

const REDDIT_SEARCH_SYSTEM = `You are a summarizer. Given raw search results about a topic from Reddit, output a single JSON object with exactly these keys (all strings or arrays of strings):
- topicOrKeyword: the main topic or keyword
- introduction: 2-3 sentence overview of what people are discussing
- keyThemesAndTopics: array of 5-8 main themes
- communitySentiment: object with key "positive" (string summary of positive sentiment)
- popularOpinionsAndArguments: array of 4-6 popular opinions or arguments
- actionableInsights: array of 3-5 actionable takeaways

Output only valid JSON, no markdown or extra text.`;

@Injectable()
export class RedditSearchExecutor {
  private readonly logger = new Logger(RedditSearchExecutor.name);

  constructor(private readonly config: ConfigService) {}

  async execute(params: Record<string, any>): Promise<{ success: boolean; data?: any; error?: string }> {
    const searchQuery = params.searchQuery ?? params.topic ?? '';
    const timeFilter = params.timeFilter ?? 'Past year';
    const sortBy = params.sortBy ?? 'New';
    const numberOfPosts = Math.min(Number(params.numberOfPosts) || 10, 20);
    if (!searchQuery || String(searchQuery).trim() === '') {
      return { success: false, error: 'searchQuery (or topic) is required for Reddit Search.' };
    }

    const serperKey = this.config.get<string>('SERPER_API_KEY');
    if (!serperKey) {
      this.logger.warn('SERPER_API_KEY not set; returning placeholder Reddit summary.');
      return {
        success: true,
        data: {
          topicOrKeyword: String(searchQuery).trim(),
          introduction: `Discussion summary for "${searchQuery}" (configure SERPER_API_KEY for live Reddit search).`,
          keyThemesAndTopics: [],
          communitySentiment: { positive: '' },
          popularOpinionsAndArguments: [],
          actionableInsights: [],
        },
      };
    }

    try {
      const q = `site:reddit.com ${searchQuery}`;
      const res = await axios.post(
        'https://google.serper.dev/search',
        { q, num: numberOfPosts },
        {
          headers: {
            'X-API-KEY': serperKey,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      const organic = res.data?.organic ?? [];
      const snippets = organic
        .slice(0, numberOfPosts)
        .map((o: any) => `${o.title || ''}\n${o.snippet || ''}`)
        .filter(Boolean)
        .join('\n\n');
      if (!snippets.trim()) {
        return {
          success: true,
          data: {
            topicOrKeyword: String(searchQuery).trim(),
            introduction: `No Reddit results found for "${searchQuery}".`,
            keyThemesAndTopics: [],
            communitySentiment: { positive: '' },
            popularOpinionsAndArguments: [],
            actionableInsights: [],
          },
        };
      }

      const apiKey = this.config.get<string>('OPEN_AI_SECRET_KEY') ?? this.config.get<string>('OPEN_AI_SECRET_KEY_1') ?? '';
      const client = new OpenAI({ apiKey: apiKey || 'placeholder' });
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: REDDIT_SEARCH_SYSTEM },
          { role: 'user', content: `Topic: ${searchQuery}\n\nReddit results:\n${snippets.slice(0, 12000)}` },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      });
      const text = completion.choices?.[0]?.message?.content?.trim() ?? '{}';
      let data: any = {};
      try {
        const jsonMatch = text.replace(/^```json?\s*|\s*```$/g, '').match(/\{[\s\S]*\}/);
        if (jsonMatch) data = JSON.parse(jsonMatch[0]);
      } catch {
        data = {
          topicOrKeyword: String(searchQuery).trim(),
          introduction: text.slice(0, 500),
          keyThemesAndTopics: [],
          communitySentiment: { positive: '' },
          popularOpinionsAndArguments: [],
          actionableInsights: [],
        };
      }
      return { success: true, data };
    } catch (err: any) {
      this.logger.warn(`RedditSearchExecutor failed: ${err?.message}`);
      return {
        success: false,
        error: err?.message ?? 'Reddit search failed.',
      };
    }
  }
}
