/**
 * In-process executor for Candidate Profile Analyzer agent.
 * Runs resume extraction + ATS LLM step using worker's RateLimiter and API keys.
 * Ported from GrowStack monorepo apps/worker/src/agent-executor.
 */

import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { RateLimiter } from '../rate-limitting/rate-limiter.service';
import { buildAnalyzeCandidateProfilePrompt } from './candidate-profile.prompts';
import { extractResumeTextFromUrl } from './candidate-profile.extract';

export interface CandidateProfileInputs {
  CandidateProfile?: string;
  JobDescription?: string;
  CompanyName?: string;
  job_description?: string;
  company_name?: string;
  Resume?: string;
  llm?: string;
  model?: string;
  LLM?: string;
  Model?: string;
  [key: string]: any;
}

export interface ExecuteCandidateProfileResult {
  success: boolean;
  data?: any;
  statusCode?: number;
  status?: string;
  error?: string;
}

const SUPPORTED_LLM = new Set(['openai', 'anthropic', 'perplexity', 'gemini']);

@Injectable()
export class CandidateProfileExecutor {
  private readonly logger = new Logger(CandidateProfileExecutor.name);

  constructor(private readonly rateLimiter: RateLimiter) {}

  /**
   * Returns true if the given inputs look like a Candidate Profile Analyzer run
   * (have resume + job description or company).
   */
  static canHandle(inputs: Record<string, any>): boolean {
    const cp = inputs?.CandidateProfile ?? inputs?.Resume;
    const jd = inputs?.JobDescription ?? inputs?.job_description;
    const company = inputs?.CompanyName ?? inputs?.company_name;
    return !!(cp && (jd || company));
  }

  /**
   * Execute Candidate Profile Analyzer in-process: extract resume text + email,
   * then run ATS prompt via LLM. Returns same shape as external agent run for
   * compatibility (success, data, statusCode, status: 'COMPLETED').
   */
  async execute(
    inputs: CandidateProfileInputs,
    options: { userSecrets?: Record<string, any> } = {}
  ): Promise<ExecuteCandidateProfileResult> {
    try {
      const candidateProfile = inputs.CandidateProfile ?? inputs.Resume;
      if (typeof candidateProfile === 'string') {
        const urls = candidateProfile.split(/[,\n]/).map((u) => u.trim()).filter(Boolean);
        if (urls.length > 1) {
          return {
            success: false,
            statusCode: 400,
            error:
              'Multiple candidate profiles detected. Only single candidate profile is supported. Please upload one candidate profile at a time.',
          };
        }
      }
      if (!candidateProfile) {
        return { success: false, statusCode: 400, error: 'CandidateProfile (or Resume) is required.' };
      }

      const llmProvider = (inputs.llm ?? inputs.LLM ?? 'openai').toLowerCase();
      const model = inputs.model ?? inputs.Model ?? this.getDefaultModel(llmProvider);
      if (!SUPPORTED_LLM.has(llmProvider)) {
        return {
          success: false,
          statusCode: 400,
          error: `Unsupported LLM provider: ${llmProvider}. Supported: ${[...SUPPORTED_LLM].join(', ')}`,
        };
      }

      this.logger.log(
        `Candidate Profile Executor: extracting resume text (provider=${llmProvider}, model=${model})`,
      );

      const { resumeText, candidateEmail } = await extractResumeTextFromUrl(candidateProfile);
      const rawResult = { data: { resumeText, candidateEmail } };
      const prompt = buildAnalyzeCandidateProfilePrompt(rawResult, inputs as Record<string, any>);

      const userSecrets = options.userSecrets;
      const content = await this.callLLM(llmProvider, model, prompt, userSecrets);

      let data: any = content;
      if (typeof content === 'string') {
        const cleaned = content.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            data = JSON.parse(jsonMatch[0]);
          } catch {
            data = { atsResult: {}, email: {}, raw: cleaned };
          }
        } else {
          data = { atsResult: {}, email: {}, raw: cleaned };
        }
      }

      return {
        success: true,
        data,
        statusCode: 200,
        status: 'COMPLETED',
      };
    } catch (err: any) {
      this.logger.warn(
        `Candidate Profile Executor failed: ${err?.message ?? String(err)}`,
      );
      return {
        success: false,
        statusCode: 500,
        status: 'FAILED',
        error: err?.message ?? 'Failed to run Candidate Profile Analyzer',
      };
    }
  }

  private getDefaultModel(provider: string): string {
    const defaults: Record<string, string> = {
      openai: 'gpt-4o-mini',
      anthropic: 'claude-3-haiku-20240307',
      perplexity: 'sonar',
      gemini: 'gemini-2.5-flash',
    };
    return defaults[provider] ?? 'gpt-4o-mini';
  }

  private async callLLM(
    provider: string,
    model: string,
    systemPrompt: string,
    userSecrets?: Record<string, any>
  ): Promise<string> {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: 'Analyze the resume against the job description and return only the JSON.' },
    ];

    if (provider === 'openai') {
      const response = await this.rateLimiter.execute({
        provider: 'openai',
        userSecrets,
        requestFn: async (apiKey: string) => {
          const client = new OpenAI({ apiKey });
          return await client.chat.completions.create({
            model,
            messages: messages as any,
            temperature: 0.2,
            max_tokens: 4096,
          });
        },
      });
      const raw = response.choices?.[0]?.message?.content;
      return typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    }

    if (provider === 'perplexity') {
      const axios = (await import('axios')).default;
      const response = await this.rateLimiter.execute({
        provider: 'perplexity',
        userSecrets,
        requestFn: async (apiKey: string) => {
          const res = await axios.post(
            'https://api.perplexity.ai/chat/completions',
            {
              model: model || 'sonar',
              messages: messages as any,
              temperature: 0.2,
              max_tokens: 4096,
            },
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
            }
          );
          return res.data;
        },
      });
      const raw = response.choices?.[0]?.message?.content;
      return typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    }

    if (provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const response = await this.rateLimiter.execute({
        provider: 'anthropic',
        userSecrets,
        requestFn: async (apiKey: string) => {
          const client = new Anthropic({ apiKey });
          const out = await client.messages.create({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Analyze the resume against the job description and return only the JSON.' }],
          });
          const textBlock = out.content?.find((c: any) => c.type === 'text') as { text?: string } | undefined;
          return { content: textBlock?.text ?? '', usage: out.usage };
        },
      });
      return typeof response.content === 'string' ? response.content : JSON.stringify(response.content ?? '');
    }

    if (provider === 'gemini') {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const response = await this.rateLimiter.execute({
        provider: 'gemini',
        userSecrets,
        requestFn: async (apiKey: string) => {
          const genAI = new GoogleGenerativeAI(apiKey);
          const gen = genAI.getGenerativeModel({ model: model || 'gemini-2.5-flash' });
          const result = await gen.generateContent({
            contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nAnalyze the resume against the job description and return only the JSON.` }] }],
          });
          const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          return { content: text };
        },
      });
      return typeof response.content === 'string' ? response.content : JSON.stringify(response.content ?? '');
    }

    throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
