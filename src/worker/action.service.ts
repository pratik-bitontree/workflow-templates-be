import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { Types } from 'mongoose';
import { UserSecrets, UserSecretsDocument } from '../schemas/user-secrets.schema';
import { GmailService } from './services/gmail.service';
import { ToolsService } from './services/tools.service';
import { InstantlyService } from './services/instantly.service';
import { VercelService } from './services/vercel.service';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { RateLimiter } from './rate-limitting/rate-limiter.service';

/**
 * Action service for workflow node execution.
 * Mirrors GrowStack monorepo apps/worker ActionService.executeWorkflowFunction pattern:
 * each node has a functionToExecute (from NodeMaster); this service routes to the
 * correct handler and returns { [variableName]: value } for caching.
 *
 * Includes: processSendEmail, processTextPerplexity, processTextGroq, processTextAnthropic, convertTextToPdf.
 */
const DATE_TIME_SUBNODE_MASTER_ID = '67ac322921b9f7b634cdd16b';

@Injectable()
export class ActionService {
  private readonly logger = new Logger(ActionService.name);
  public openai: OpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly gmailService: GmailService,
    private readonly toolsService: ToolsService,
    private readonly instantlyService: InstantlyService,
    private readonly vercelService: VercelService,
    private readonly rateLimiter: RateLimiter,
    @InjectModel(UserSecrets.name) private userSecretsModel: Model<UserSecretsDocument>,
  ) {
    const initialKey = this.configService.get<string>('OPEN_AI_SECRET_KEY_1') ?? this.configService.get<string>('OPEN_AI_SECRET_KEY') ?? '';
    this.openai = new OpenAI({ apiKey: initialKey || 'placeholder' });
  }

  async processInput(workflowInput: Record<string, unknown>, inputVariableName: string): Promise<unknown> {
    try {
      return workflowInput?.[inputVariableName];
    } catch (err) {
      this.logger.error(`processInput failed: ${(err as Error)?.message}`, (err as Error)?.stack);
      throw err;
    }
  }

  async processOutput({ value }: { value: unknown }): Promise<unknown> {
    return value;
  }

  async processAIChat({
    workflowInput,
    variableName,
  }: {
    workflowInput: Record<string, unknown>;
    variableName?: string;
  }): Promise<Record<string, unknown>> {
    const output: Record<string, unknown> = {};
    if (variableName) {
      const nodeOutput = await this.processInput(workflowInput, variableName);
      output[variableName] = nodeOutput;
    }
    return output;
  }

  /**
   * Format date/time. Uses native Date; for more formats add moment or dayjs.
   */
  async processDateTime({
    format,
    timezone,
    variableName,
    value,
    defaultDate,
    defaultTime,
  }: {
    format?: string;
    timezone?: string;
    variableName?: string;
    value?: unknown;
    defaultDate?: string;
    defaultTime?: string;
  }): Promise<string> {
    const tz = timezone || 'UTC';
    let date = new Date();

    if (defaultDate || defaultTime) {
      if (defaultDate) {
        const d = new Date(date);
        switch (defaultDate) {
          case 'tomorrow':
            d.setDate(d.getDate() + 1);
            date = d;
            break;
          case '2_days_later':
            d.setDate(d.getDate() + 2);
            date = d;
            break;
          case '1_week_later':
            d.setDate(d.getDate() + 7);
            date = d;
            break;
          case 'yesterday':
            d.setDate(d.getDate() - 1);
            date = d;
            break;
          case '2_days_ago':
            d.setDate(d.getDate() - 2);
            date = d;
            break;
          case '1_week_ago':
            d.setDate(d.getDate() - 7);
            date = d;
            break;
          default:
            break;
        }
      }
      if (defaultTime) {
        const d = new Date(date);
        switch (defaultTime) {
          case '1_hr_later':
            d.setHours(d.getHours() + 1);
            date = d;
            break;
          case '2_hrs_later':
            d.setHours(d.getHours() + 2);
            date = d;
            break;
          case '1_hr_ago':
            d.setHours(d.getHours() - 1);
            date = d;
            break;
          default:
            break;
        }
      }
    } else if (value != null && value !== '') {
      const parsed = new Date(value as string | number);
      if (!isNaN(parsed.getTime())) date = parsed;
    }

    const pad = (n: number) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());

    switch (format) {
      case 'YYYY-MM-DD':
        return `${y}-${m}-${d}`;
      case 'YYYY-MM-DD HH:mm:ss':
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
      case 'HH:mm (24 hours)':
        return `${h}:${min}`;
      case 'HH:mm:ss (24 hours)':
        return `${h}:${min}:${s}`;
      case 'ISO 8601 - YYYY-MM-DDTHH:mm:ssZ':
        return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
      default:
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    }
  }

  /**
   * Resolve ${variableName} in a string using input (workflow variables).
   */
  private resolvePlaceholder(val: unknown, input: Record<string, unknown> | undefined): unknown {
    if (typeof val !== 'string' || !input || typeof input !== 'object') return val;
    const match = val.match(/^\$\{(.+)\}$/);
    if (!match) return val;
    const key = match[1].trim().split('.')[0];
    const v = input[key];
    return v === undefined || v === null ? '' : v;
  }

  /**
   * Evaluate conditions (all_conditions / any_condition / custom_logic).
   * Resolves ${variableName} in condition subject/value from input before evaluation.
   */
  async processConditional({
    conditions,
    conditionMode,
    customLogic,
    input,
  }: {
    conditions: { subject: unknown; logic: string; value: unknown }[];
    conditionMode: 'all_conditions' | 'any_condition' | 'custom_logic';
    customLogic?: string;
    input?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!conditions?.length) return false;

    const resolvedConditions = conditions.map((c) => ({
      subject: this.resolvePlaceholder(c.subject, input),
      logic: c.logic,
      value: this.resolvePlaceholder(c.value, input),
    }));

    const evaluateSingleCondition = (condition: {
      subject: unknown;
      logic: string;
      value: unknown;
    }): boolean => {
      const fieldValue = condition.subject;
      const comparisionValue = condition.value;
      const logic = condition.logic;

      switch (logic) {
        case 'exists':
          return fieldValue !== undefined && fieldValue !== null;
        case 'does_not_exist':
          return fieldValue === undefined || fieldValue === null;
        case 'equal_to':
          return fieldValue === comparisionValue;
        case 'equal_to_insensitive':
          return String(fieldValue).toLowerCase() === String(comparisionValue).toLowerCase();
        case 'not_equal_to':
          return fieldValue !== comparisionValue;
        case 'not_equal_to_insensitive':
          return String(fieldValue).toLowerCase() !== String(comparisionValue).toLowerCase();
        case 'contains':
          return String(fieldValue).includes(String(comparisionValue));
        case 'contains_insensitive':
          return String(fieldValue).toLowerCase().includes(String(comparisionValue).toLowerCase());
        case 'does_not_contain':
          return !String(fieldValue).includes(String(comparisionValue));
        case 'starts_with':
          return String(fieldValue).startsWith(String(comparisionValue));
        case 'ends_with':
          return String(fieldValue).endsWith(String(comparisionValue));
        case 'greater_than':
          return Number(fieldValue) > Number(comparisionValue);
        case 'less_than':
          return Number(fieldValue) < Number(comparisionValue);
        case 'greater_than_equal':
          return Number(fieldValue) >= Number(comparisionValue);
        case 'less_than_equal':
          return Number(fieldValue) <= Number(comparisionValue);
        case 'is_true':
          return Boolean(fieldValue) === true;
        case 'is_false':
          return Boolean(fieldValue) === false;
        case 'is_empty':
          return !fieldValue || (Array.isArray(fieldValue) && fieldValue.length === 0);
        case 'is_not_empty':
          return !!fieldValue && (!Array.isArray(fieldValue) || fieldValue.length > 0);
        case 'contains (list)':
          return Array.isArray(fieldValue) && fieldValue.includes(comparisionValue);
        case 'Does not contain (list)':
          return Array.isArray(fieldValue) && !fieldValue.includes(comparisionValue);
        case 'Is empty (list)':
          return Array.isArray(fieldValue) && fieldValue.length === 0;
        case 'Is not empty (list)':
          return Array.isArray(fieldValue) && fieldValue.length !== 0;
        default:
          throw new Error(`Unsupported logic operator: ${logic}`);
      }
    };

    const evaluateAllConditions = (): boolean => {
      for (const condition of resolvedConditions) {
        if (!evaluateSingleCondition(condition)) return false;
      }
      return true;
    };

    const evaluateAnyCondition = (): boolean => {
      for (const condition of resolvedConditions) {
        if (evaluateSingleCondition(condition)) return true;
      }
      return false;
    };

    const evaluateCustomLogic = (): boolean => {
      if (!customLogic) throw new Error('Custom logic is required for custom_logic mode');
      const conditionResults = resolvedConditions.map((c) => evaluateSingleCondition(c));
      let logicExpression = customLogic;
      for (let i = 0; i < conditions.length; i++) {
        const regex = new RegExp(`\\b${i + 1}\\b`, 'g');
        logicExpression = logicExpression.replace(regex, String(conditionResults[i]));
      }
      logicExpression = logicExpression.replace(/AND/g, '&&').replace(/OR/g, '||').replace(/\s+/g, ' ');
      const sanitized = logicExpression
        .replace(/true|false/g, '')
        .replace(/&&|\|\|/g, '')
        .replace(/\(|\)/g, '')
        .replace(/\s+/g, '');
      if (sanitized.length > 0) throw new Error('Custom logic contains invalid tokens');
      try {
        return eval(logicExpression) as boolean;
      } catch {
        throw new Error(`Invalid custom logic expression: ${customLogic}`);
      }
    };

    switch (conditionMode) {
      case 'all_conditions':
        return evaluateAllConditions();
      case 'any_condition':
        return evaluateAnyCondition();
      case 'custom_logic':
        return evaluateCustomLogic();
      default:
        throw new Error(`Unsupported condition mode: ${conditionMode}`);
    }
  }

  async processSendEmail({
    to,
    cc,
    bcc,
    subject,
    message,
    attachments,
    user_id,
  }: {
    to: any;
    cc?: any;
    bcc?: any;
    subject: string;
    message: string;
    attachments?: any;
    inputs?: any;
    user_id?: string;
  }): Promise<{ messageId?: string }> {
    if (!user_id) {
      throw new BadRequestException(
        'user_id is required for sending email via Gmail. Connect Gmail in Integration Hub and run the workflow as a connected user.',
      );
    }
    const response = await this.gmailService.sendEmail({
      to: Array.isArray(to) ? to : to ? [to] : to,
      cc,
      bcc,
      subject: subject ?? '',
      message: message ?? '',
      attachments,
      user_id,
    });
    return { messageId: response.message_id };
  }

  async processTextPerplexity({
    systemPrompt,
    inputPrompt,
    modelSelection,
    responseLength,
    creativityLevel = 0.2,
    language,
    userId,
    topP = 0.9,
  }: {
    systemPrompt?: string;
    inputPrompt: string;
    modelSelection?: string;
    responseLength?: number;
    creativityLevel?: number;
    language?: string;
    userId?: string;
    brandVoiceId?: string;
    topP?: number;
  }): Promise<{ content: string; citations?: string[]; usage?: unknown }> {
    if (!inputPrompt) throw new BadRequestException('Input Prompt is required');
    if (!modelSelection) throw new BadRequestException('Model is required');

    let modifiedInputPrompt = inputPrompt;
    if (language) {
      modifiedInputPrompt = `Please provide the response in ${language}. ${inputPrompt}`;
    }

    const apiKeys: string[] = [];
    if (userId) {
      try {
        const userSecrets = await this.userSecretsModel
          .findOne({ user_id: new Types.ObjectId(userId) })
          .select('perplexity')
          .lean();
        const accounts = (userSecrets as any)?.perplexity;
        const primary = Array.isArray(accounts)
          ? accounts.find((a: any) => a?.isPrimary && a?.api_key)
          : null;
        if (primary?.api_key) apiKeys.push(primary.api_key);
      } catch (e) {
        this.logger.warn(`[processTextPerplexity] could not load user Perplexity key: ${(e as Error)?.message}`);
      }
    }
    for (const key of ['PERPLEXITY_API_KEY', 'PERPLEXITY_API_KEY_1', 'PERPLEXITY_API_KEY_2', 'PERPLEXITY_API_KEY_3']) {
      const envKey = this.configService.get<string>(key);
      if (envKey && !apiKeys.includes(envKey)) apiKeys.push(envKey);
    }
    if (apiKeys.length === 0) {
      throw new BadRequestException(
        'Perplexity API key not found. Set PERPLEXITY_API_KEY in env or connect Perplexity in Integration Hub.',
      );
    }

    const base = (this.configService.get<string>('PERPLEXITY_BASE_URL') || 'https://api.perplexity.ai').replace(/\/+$/, '');
    const endpoint = /\/chat\/completions\b/.test(base) ? base : `${base}/chat/completions`;

    const payload = {
      model: modelSelection,
      messages: [
        { role: 'system', content: systemPrompt || 'Be precise and concise.' },
        { role: 'user', content: modifiedInputPrompt },
      ],
      temperature: creativityLevel,
      top_p: topP,
      ...(responseLength && responseLength > 0 ? { max_tokens: responseLength } : {}),
    };

    let lastError: string | null = null;
    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[i];
      try {
        const response = await axios.post(endpoint, payload, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });
        const data = response.data;
        const content = data?.choices?.[0]?.message?.content ?? '';
        const citations = (data?.citations ?? []).map((link: string, idx: number) => `[${idx + 1}] ${link}`);
        return { content, citations, usage: data?.usage };
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        lastError = msg;
        const isRetryable = status === 401 || status === 429 || (status && status >= 500);
        if (isRetryable && i < apiKeys.length - 1) {
          this.logger.warn(
            `[processTextPerplexity] key ${i + 1}/${apiKeys.length} failed (${status}): ${msg}. Trying next key.`,
          );
          continue;
        }
        if (status === 401) {
          throw new BadRequestException(
            `Perplexity API returned 401 Unauthorized. Check that your API key is valid (env or Integration Hub). ${msg}`,
          );
        }
        throw new BadRequestException(`Perplexity API error: ${msg}`);
      }
    }
    throw new BadRequestException(`Perplexity API error (all keys failed): ${lastError ?? 'Unknown error'}`);
  }

  async processTextGpt({
    systemPrompt,
    inputPrompt,
    modelSelection,
    responseLength,
    creativityLevel = 0.7,
    language,
    userId,
    brandVoiceId
}: {
    systemPrompt?: string;
    inputPrompt: string;
    modelSelection: string;
    responseLength?: number | string;
    creativityLevel?: number;
    language?: string;
    userId: string;
    brandVoiceId?: string;
}) {
    try {
        if (modelSelection === 'o3' || modelSelection === 'o3-deep-research') {
            creativityLevel = 0;
            systemPrompt = '';
            responseLength = '';
            brandVoiceId = '';
        }

        if (!inputPrompt) {
            throw new BadRequestException('Input Prompt is required');
        }

        if (!modelSelection) {
            throw new BadRequestException('Model is required');
        }

        let parsedResponseLength: number | undefined;
        if (responseLength !== undefined && responseLength !== '') {
            parsedResponseLength = Number(responseLength);
            if (isNaN(parsedResponseLength)) {
                throw new BadRequestException('Response Length must be a valid number');
            }
        }

        if (creativityLevel < 0 || creativityLevel > 1) {
            throw new BadRequestException('Creativity Level must be between 0 and 1');
        }

        let brandVoice;
        if (brandVoiceId) {
            brandVoice = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).select('brand_voice').lean();
            brandVoice = brandVoice?.brand_voice;
            if (!brandVoice) {
                throw new BadRequestException('Brand Voice is required');
            }
            brandVoice = brandVoice.find((b: any) => b.id === brandVoiceId);
            if (!brandVoice) {
                throw new BadRequestException('Brand Voice is not found');
            }
        }

        let messages;
        const isGpt4Model = modelSelection == 'gpt-4';

        const format = JSON.stringify({
            output: 'your_response',
        });

        let modifiedInputPrompt = inputPrompt;
        let modifiedSystemPrompt = systemPrompt || 'You are a helpful assistant.'; // Fixed: Add default value

        if (language) {
            modifiedInputPrompt = `Please provide the response in ${language}. ${inputPrompt}`;
        }

        // Add token limit if needed
        if (parsedResponseLength) {
            modifiedInputPrompt += ` (It is essential that the response does not exceed ${parsedResponseLength} tokens. Please ensure the content is concise and strictly limited to this token count, providing only relevant and focused information within this constraint.)`;
        }

        if (brandVoice && brandVoiceId) {
            modifiedSystemPrompt = `create a response aligning the brand voice: ${brandVoice.brand_voice} ` + (systemPrompt || 'You are a helpful assistant.');
        }

        if (!messages || messages?.length <= 0) {
            messages = [
                {
                    role: 'system',
                    content: modifiedSystemPrompt
                },
                {
                    role: 'assistant',
                    content: `${systemPrompt || 'You are a helpful assistant.'}${!isGpt4Model
                        ? `, generate response in JSON format with format: ${format}, but if the modelSelection is o1-mini return in plain string.`
                        : ''
                        } NOTE: Please don't generate an array of string response or any response except string.`,
                },
                {
                    role: 'user',
                    content: modifiedInputPrompt,
                },
            ];
        }

        // Resolve user secrets for Integration Hub keys (when userId provided)
        let userSecrets: Record<string, any> | undefined;
        if (userId) {
          try {
            const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).select('openai').lean();
            const openaiAccounts = (doc as any)?.openai;
            if (Array.isArray(openaiAccounts) && openaiAccounts.length > 0) {
              userSecrets = { openai: openaiAccounts };
            }
          } catch (_) {
            // ignore
          }
        }

        const result = await this.rateLimiter.execute({
          provider: 'openai',
          userSecrets,
          requestFn: async (apiKey: string) => {
            this.openai.apiKey = apiKey;
            return this.chatGptProcess(messages, modelSelection, 'original', {
              type: isGpt4Model ? 'text' : 'json_object',
            });
          },
        });
        return result;
    } catch (error: any) {
        this.logger.error(
            `Error in processTextGpt: ${error?.message ?? error}`,
            error?.stack,
            { gptResponse: error?.response?.data ?? error },
        );
        throw error;
    }
  }

  /**
   * Internal OpenAI chat completion (used by processTextGpt with rate limiter).
   * Supports standard models and o3-deep-research via /v1/responses.
   */
  async chatGptProcess(
    messages: Array<{ role: string; content: string }>,
    model = 'gpt-4o',
    creativity: string,
    responseFormat: { type?: string },
  ): Promise<{ content: string; usage?: any }> {
    try {
      if (model === 'o3-deep-research') {
        let userMessage = messages.find((m) => m.role === 'user')?.content ?? '';
        let systemMessage = messages.find((m) => m.role === 'system')?.content ?? '';
        if (responseFormat?.type === 'json_object') {
          userMessage = `${userMessage} Please provide the response in JSON format.`;
        }
        const apiUrl = 'https://api.openai.com/v1/responses';
        const headers = {
          Authorization: `Bearer ${this.openai.apiKey}`,
          'Content-Type': 'application/json',
        };
        const requestBody = {
          model,
          instructions: systemMessage,
          input: userMessage,
          tools: [{ type: 'web_search_preview' }],
        };
        const axiosResponse = await axios.post(apiUrl, requestBody, { headers });
        const { data } = axiosResponse;
        const output = data?.output ?? [];
        const usage = data?.usage ?? {};
        const getContent = output.find((r: any) => r.role === 'assistant')?.content?.[0];
        let content = '';
        if (getContent?.type === 'output_text' && getContent?.text) {
          const rawText = getContent.text;
          if (rawText.includes('```json')) {
            const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch?.[1]) {
              try {
                const parsed = JSON.parse(jsonMatch[1]);
                content = parsed.output ?? parsed.text ?? parsed.content ?? jsonMatch[1];
                if (typeof content === 'object') content = JSON.stringify(content);
              } catch {
                content = jsonMatch[1].trim();
              }
            } else content = rawText;
          } else if (rawText.startsWith('{') && rawText.endsWith('}')) {
            try {
              const parsed = JSON.parse(rawText);
              content = parsed.output ?? parsed.text ?? parsed.content ?? JSON.stringify(parsed);
              if (typeof content === 'object') content = JSON.stringify(content);
            } catch {
              content = rawText;
            }
          } else {
            content = rawText;
          }
        } else if (getContent?.text) {
          content = getContent.text;
        }
        content = (content ?? '').replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        if (typeof content !== 'string') content = String(content);
        return { usage, content };
      }

      const creativitySettings: Record<string, { temperature: number; frequency_penalty: number }> = {
        repetitive: { temperature: 0.0, frequency_penalty: 1.0 },
        deterministic: { temperature: 0.3, frequency_penalty: 0.5 },
        original: { temperature: 0.7, frequency_penalty: 0.2 },
        creative: { temperature: 1.0, frequency_penalty: 0.0 },
        imaginative: { temperature: 1.2, frequency_penalty: -0.2 },
      };
      let payload: any = {
        model,
        messages,
        response_format: responseFormat,
      };
      if (model !== 'o3') {
        const settings = model === 'o1-mini' ? creativitySettings['creative'] : (creativitySettings[creativity] ?? creativitySettings['original']);
        payload.temperature = settings.temperature;
        payload.frequency_penalty = settings.frequency_penalty;
      }
      if (model !== 'o1-mini') {
        payload = { ...payload, response_format: responseFormat };
      }
      const { choices, usage } = await this.openai.chat.completions.create(payload);
      const rawContent = choices[0]?.message?.content;
      let content = rawContent ?? '';
      if (responseFormat?.type === 'json_object' && typeof rawContent === 'string') {
        const jsonBlockMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonCandidate = jsonBlockMatch ? jsonBlockMatch[1] : rawContent;
        try {
          const parsed = JSON.parse(jsonCandidate);
          const extracted = parsed.output ?? parsed.text ?? parsed.content;
          if (typeof extracted === 'string') content = extracted;
          else if (extracted !== undefined) content = JSON.stringify(extracted);
        } catch {
          // keep content as rawContent
        }
      }
      return { usage, content };
    } catch (error: any) {
      this.logger.error(`Error in chatGptProcess: ${error?.message}`, error?.stack);
      const message = error?.response?.data?.error?.message ?? error?.message ?? 'An error occurred while processing the request';
      throw new BadRequestException(message);
    }
  }

  // async processTextAnthropic({
  //   systemPrompt,
  //   inputPrompt,
  //   modelSelection,
  //   responseLength,
  //   creativityLevel = 0.7,
  //   language,
  //   userId,
  //   webSearch,
  // }: {
  //   systemPrompt?: string;
  //   inputPrompt: string;
  //   modelSelection: string;
  //   responseLength: number | string;
  //   creativityLevel?: number;
  //   language?: string;
  //   brandVoiceId?: string;
  //   userId?: string;
  //   webSearch?: boolean;
  // }): Promise<{ content: string; usage?: unknown }> {
  
  //   if (!inputPrompt) throw new BadRequestException('Input Prompt is required');
  //   if (!modelSelection) throw new BadRequestException('Model is required');
  //   if (!responseLength) throw new BadRequestException('Response Length is required');
  
  //   const apiKey = process.env.ANTHROPIC_API_KEY;
  //   if (!apiKey) throw new BadRequestException('ANTHROPIC_API_KEY is not configured');
  
  //   const maxTokens = Number(responseLength);
  //   const temperature = Number(creativityLevel) || 0.7;
  
  //   if (temperature < 0 || temperature > 1) {
  //     throw new BadRequestException('Creativity Level must be between 0 and 1');
  //   }
  
  //   let modifiedInputPrompt = inputPrompt;
  //   let modifiedSystemPrompt = systemPrompt ?? '';
  
  //   if (language) {
  //     modifiedInputPrompt = `Please provide the response in ${language}. ${inputPrompt}`;
  //   }
  
  //   const anthropic = new Anthropic({
  //     apiKey: apiKey,
  //   });
  
  //   const request: any = {
  //     model: modelSelection,
  //     system: modifiedSystemPrompt,
  //     messages: [
  //       {
  //         role: 'user',
  //         content: modifiedInputPrompt,
  //       },
  //     ],
  //     max_tokens: maxTokens,
  //     temperature: temperature,
  //   };
  
  //   if (webSearch) {
  //     request.tools = [
  //       {
  //         type: "web_search_20250305",
  //         name: "web_search",
  //         max_uses: 5,
  //       },
  //     ];
  //   }
  
  //   const stream = await anthropic.messages.stream(request);
  
  //   let finalText = '';
  //   let usage: unknown;
  
  //   for await (const event of stream) {
  
  //     if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
  //       finalText += event.delta.text ?? '';
  //     }
  
  //     if (event.type === 'message_delta' && (event as any).usage) {
  //       usage = (event as any).usage;
  //     }
  //   }
  
  //   return {
  //     content: finalText,
  //     usage,
  //   };
  // }

  /**
   * Text generation using Groq API (OpenAI-compatible chat completions at api.groq.com).
   * Same signature as processTextAnthropic for consistent workflow node usage.
   */
  async processTextAnthropic({
    systemPrompt,
    inputPrompt,
    modelSelection,
    responseLength,
    creativityLevel = 0.7,
    language,
    userId,
    webSearch,
  }: {
    systemPrompt?: string;
    inputPrompt: string;
    modelSelection: string;
    responseLength: number | string;
    creativityLevel?: number;
    language?: string;
    brandVoiceId?: string;
    userId?: string;
    webSearch?: boolean;
  }): Promise<{ content: string; usage?: unknown }> {
    if (!inputPrompt) throw new BadRequestException('Input Prompt is required');
    if (!modelSelection) throw new BadRequestException('Model is required');
    if (!responseLength) throw new BadRequestException('Response Length is required');

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new BadRequestException('GROQ_API_KEY is not configured');

    const maxTokens = Number(responseLength);
    const temperature = Number(creativityLevel) || 0.7;

    if (temperature < 0 || temperature > 1) {
      throw new BadRequestException('Creativity Level must be between 0 and 1');
    }

    let modifiedInputPrompt = inputPrompt;
    const modifiedSystemPrompt = systemPrompt ?? '';

    if (language) {
      modifiedInputPrompt = `Please provide the response in ${language}. ${inputPrompt}`;
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (modifiedSystemPrompt) {
      messages.push({ role: 'system', content: modifiedSystemPrompt });
    }
    messages.push({ role: 'user', content: modifiedInputPrompt });

    const payload: Record<string, unknown> = {
      model: "openai/gpt-oss-120b",
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (webSearch) {
      payload.tools = [{ type: 'web_search', name: 'web_search', max_uses: 5 }];
    }

    const { data } = await axios.post<{
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }>(
      'https://api.groq.com/openai/v1/chat/completions',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    const content = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage;

    return {
      content,
      usage,
    };
  }

 
  async convertTextToPdf(
    {
      textInput,
      outputFileName,
      deletePdf = true,
    }: {
      textInput: string | null | undefined;
      deletePdf?: boolean;
      outputFileName?: string;
    },
    context?: {
      workflowExecutionId?: string;
      nodeExecutionId?: string;
      workflowInput?: Record<string, unknown>;
    },
  ): Promise<string> {
  
    const sanitizePdfText = (text: string): string => {
      return text
        .replace(/\u2011/g, '-') // non-breaking hyphen
        .replace(/\u2013/g, '-') // en dash
        .replace(/\u2014/g, '-') // em dash
        .replace(/[\u2018\u2019]/g, "'") // smart quotes
        .replace(/[\u201C\u201D]/g, '"') // smart double quotes
        .replace(/\u00A0/g, ' '); // non-breaking space
    };
  
    let effectiveText = textInput ?? '';
  
    // Prefer research-paper content from workflow variables if input is small
    if (!effectiveText || (typeof effectiveText === 'string' && effectiveText.trim().length < 100)) {
      const vars = context?.workflowInput ?? {};
      const paperKeys = [
        'apa_research_paper_generation',
        'mla_research_paper_generation',
        'chicago_research_paper_generation',
        'ieee_research_paper_generation',
        'harvard_research_paper_generation',
        'asa_research_paper_generation',
      ];
  
      for (const key of paperKeys) {
        const val = vars[key];
  
        const content =
          typeof val === 'string'
            ? val
            : val && typeof val === 'object' && 'content' in val && typeof (val as any).content === 'string'
            ? (val as any).content
            : '';
  
        if (content && content.length > 100) {
          effectiveText = content;
          this.logger.log(
            `[convertTextToPdf] using research paper from variable ${key} (length=${content.length})`,
          );
          break;
        }
      }
    }
  
    const cleanedText = sanitizePdfText(effectiveText || textInput || '');
  
    return this.toolsService.convertTextToPdf({
      textInput: cleanedText,
      outputFileName,
      workflowExecutionId: context?.workflowExecutionId,
      nodeExecutionId: context?.nodeExecutionId,
      deletePdf,
    });
  }

  /**
   * Get a valid Google access token for Sheets (refreshes if expired). Uses same OAuth client as orchestration.
   */
  private async getSheetsAccessToken(userId: string): Promise<string> {
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const gsheets = (doc as any)?.gsheets;
    const accounts = Array.isArray(gsheets) ? gsheets : [];
    const primary = accounts.find((a: any) => a.isPrimary) ?? accounts[0];
    if (!primary) {
      throw new BadRequestException('Google Sheets not connected. Connect in Integration Hub.');
    }
    const refreshToken = primary?.refresh_token;
    if (!refreshToken) {
      throw new BadRequestException('Google Sheets token expired or missing. Reconnect in Integration Hub.');
    }
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri = this.configService.get<string>('GOOGLE_REDIRECT_URI');
    if (!clientId || !clientSecret || !redirectUri) {
      this.logger.warn('Google OAuth not configured (GOOGLE_*). Using stored access_token only.');
      const accessToken = primary?.access_token;
      if (!accessToken) {
        throw new BadRequestException('Google Sheets not connected. Connect in Integration Hub.');
      }
      return accessToken;
    }
    const oauth2 = new OAuth2Client(clientId, clientSecret, redirectUri);
    oauth2.setCredentials({
      access_token: primary?.access_token || undefined,
      refresh_token: refreshToken,
    });
    const { credentials } = await oauth2.refreshAccessToken();
    const accessToken = credentials.access_token;
    if (!accessToken) {
      throw new BadRequestException('Failed to refresh Google Sheets token. Reconnect in Integration Hub.');
    }
    const gsheetsAccounts = (doc as any)?.gsheets || [];
    const updated = gsheetsAccounts.map((acc: any) =>
      acc?.refresh_token === refreshToken
        ? {
            ...acc,
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token ?? acc.refresh_token,
          }
        : acc,
    );
    await this.userSecretsModel.updateOne(
      { user_id: new Types.ObjectId(userId) },
      { $set: { gsheets: updated } },
    );
    return accessToken;
  }

  /**
   * Read Google Sheet data; returns { GridData: { headers, data } } for use in fanout/loop.
   * Params: spreadsheetUrl, userId; optional: dataRange, sheetData, rowsToRetrieve.
   */
  async readSheetData(
    params: Record<string, unknown>,
    context?: { workflowInput?: Record<string, unknown> },
  ): Promise<{ GridData: { headers: string[]; data: Record<string, unknown>[] }; Status?: string }> {
    const spreadsheetUrl = (params?.spreadsheetUrl ?? params?.spreadsheet_url) as string;
    const userId = (params?.userId ?? params?.user_id) as string;
    if (!spreadsheetUrl || !userId) {
      throw new BadRequestException('readSheetData requires spreadsheetUrl and userId');
    }
    const spreadsheetId = spreadsheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
    if (!spreadsheetId) {
      throw new BadRequestException('Invalid spreadsheet URL');
    }
    const accessToken = await this.getSheetsAccessToken(userId);
    const dataRange = ((params?.dataRange ?? params?.data_range) as string) || 'A1:Z2000';
    const range = dataRange.includes('!') ? dataRange : `Sheet1!${dataRange}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    let data: { values?: string[][] };
    try {
      const res = await axios.get<{ values?: string[][] }>(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      data = res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = body?.error?.message || body?.message || err?.message || '';
      if (status === 403) {
        throw new BadRequestException(
          'Cannot access this spreadsheet (403). Share the sheet with your connected Google account (same email as in Integration Hub), or ensure Google Sheets API is enabled in your Google Cloud project. ' + (msg ? `Detail: ${msg}` : ''),
        );
      }
      if (status === 404) {
        throw new BadRequestException('Spreadsheet not found or not shared with your Google account. Check the URL and sharing.');
      }
      throw new BadRequestException(
        msg ? `Google Sheets request failed: ${msg}` : `Google Sheets request failed (${status || 'unknown'}).`,
      );
    }
    const rawRows = data?.values ?? [];
    if (rawRows.length === 0) {
      return { GridData: { headers: [], data: [] }, Status: 'Data retrieved successfully' };
    }
    const headers = (rawRows[0] ?? []).map((h) => (h ?? '').trim());
    const dataRows = rawRows.slice(1).map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        obj[header] = row?.[index] !== undefined ? String(row[index]).trim() : '';
      });
      return obj;
    });
    return {
      GridData: { headers, data: dataRows },
      Status: 'Data retrieved successfully',
    };
  }

  /**
   * Create a lead in Instantly. Params: userId, campaignId, email, firstName, lastName, website, customVariables, etc.
   * When fanout uses batchSize, workflowInput may contain initial_instance_batch (array); creates one lead per item.
   */
  async createInstantlyLead(
    params: Record<string, unknown>,
    context?: { workflowInput?: Record<string, unknown> },
  ): Promise<unknown> {
    const userId = (params?.userId ?? params?.user_id) as string;
    if (!userId) throw new BadRequestException('createInstantlyLead requires userId');
    const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).lean();
    const instantly = (doc as any)?.instantly;
    const accounts = Array.isArray(instantly) ? instantly : [];
    const primary = accounts.find((a: any) => a.isPrimary) ?? accounts[0];
    const apiKey = primary?.api_key;
    if (!apiKey) {
      throw new BadRequestException('Instantly not connected. Add API key in Integration Hub.');
    }
    const baseUrl = (this.configService.get('INSTANTLY_API_URL') as string) || process.env.INSTANTLY_API_URL || 'https://api.instantly.ai/api/v2';
    const campaignId = (params?.campaignId ?? params?.campaign_id ?? params?.campaign) as string;
    const wi = (context?.workflowInput ?? {}) as Record<string, unknown>;
    const batchKey = Object.keys(wi).find((k) => k.endsWith('_batch') && Array.isArray(wi[k]));
    const batch = batchKey ? (wi[batchKey] as Record<string, unknown>[]) : null;
    if (batch && batch.length > 0) {
      const results: unknown[] = [];
      for (let idx = 0; idx < batch.length; idx++) {
        const item = batch[idx] as Record<string, unknown>;
        const singleResult = await this.createInstantlyLeadSingle(
          params,
          item,
          baseUrl,
          apiKey,
          campaignId,
          context,
          true,
        );
        results.push(singleResult);
      }
      this.logger.log(
        `[INSTANTLY_CALL] batch workflowExecutionId=${(context as any)?.workflowExecutionId ?? 'n/a'} nodeExecutionId=${(context as any)?.nodeExecutionId ?? 'n/a'} batchSize=${batch.length}`,
      );
      return { batch: true, count: results.length, results };
    }
    return this.createInstantlyLeadSingle(params, wi.initial_instance as Record<string, unknown> | undefined, baseUrl, apiKey, campaignId, context, false);
  }

  private async createInstantlyLeadSingle(
    params: Record<string, unknown>,
    row: Record<string, unknown> | undefined,
    baseUrl: string,
    apiKey: string,
    campaignId: string,
    context?: { workflowInput?: Record<string, unknown> },
    fromBatch = false,
  ): Promise<unknown> {
    const userId = (params?.userId ?? params?.user_id) as string;
    let email = (params?.email ?? params?.Email ?? '') as string;
    if (!email && row) {
      email = (row.Email ?? row.email ?? '') as string;
    }
    if (!email && context?.workflowInput) {
      const wi = context.workflowInput as Record<string, unknown>;
      email = (wi.email ?? wi.Email ?? (wi.initial_instance as any)?.Email ?? (wi.initial_instance as any)?.email ?? '') as string;
    }
    if (!fromBatch) {
      this.logger.log(
        `[INSTANTLY_CALL] workflowExecutionId=${(context as any)?.workflowExecutionId ?? 'n/a'} nodeExecutionId=${(context as any)?.nodeExecutionId ?? 'n/a'} email=${email ? `${String(email).slice(0, 30)}...` : '(empty)'}`,
      );
    }
    const firstName = (row?.['First Name'] ?? row?.firstName ?? row?.first_name ?? params?.firstName ?? params?.first_name ?? '') as string;
    const lastName = (row?.['Last Name'] ?? row?.lastName ?? row?.last_name ?? params?.lastName ?? params?.last_name ?? '') as string;
    const website = (row?.website ?? params?.website ?? '') as string;
    const companyName = (row?.['Company Name'] ?? row?.companyName ?? row?.company_name ?? params?.companyName ?? params?.company_name ?? '') as string;
    const phone = (row?.phone ?? params?.phone ?? '') as string;
    const personalization = (row?.personalization ?? params?.personalization ?? '') as string;
    const customVars = (params?.customVariables ?? params?.custom_variables) as Array<{ key: string; value: string }> | undefined;
    const customVariablesObj: Record<string, string> = {};
    if (Array.isArray(customVars)) {
      for (const { key, value } of customVars) {
        if (key != null && value !== undefined && value !== null) customVariablesObj[key] = String(value);
      }
    }
    const payload: Record<string, unknown> = {
      email: email || undefined,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      company_name: companyName || undefined,
      phone: phone || undefined,
      personalization: personalization || undefined,
      website: website || undefined,
      campaign: campaignId || undefined,
      skip_if_already_in_workspace: params?.skipIfInWorkspace ?? params?.skip_if_already_in_workspace ?? false,
      skip_if_already_in_campaign: params?.skipIfInCampaign ?? params?.skip_if_already_in_campaign ?? false,
      skip_if_already_in_list: params?.skipIfInList ?? params?.skip_if_already_in_list ?? false,
      verify_leads_for_lead_finder: params?.verifyLeadsForLeadFinder ?? params?.verify_leads_for_lead_finder ?? false,
      verify_leads_on_import: params?.verifyLeadsOnImport ?? params?.verify_leads_on_import ?? false,
    };
    if (Object.keys(customVariablesObj).length > 0) payload.custom_variables = customVariablesObj;
    const cleaned = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined && v !== ''));
    const url = `${baseUrl.replace(/\/$/, '')}/leads`;
    try {
      const { data } = await axios.post(url, cleaned, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return data;
    } catch (err: any) {
      const status = err?.response?.status;
      const errData = err?.response?.data;
      if (status === 404) {
        throw new BadRequestException(
          `Instantly API returned 404. Use API v2: set INSTANTLY_API_URL=https://api.instantly.ai/api/v2 in .env. If you use v1, set INSTANTLY_API_URL=https://api.instantly.ai/api/v1 and ensure the lead endpoint is correct. Tried: ${url}`,
        );
      }
      const msg = errData?.message ?? errData?.error ?? err?.message ?? 'Unknown error';
      throw new BadRequestException(`Instantly create lead failed: ${msg}`);
    }
  }

  async getInstantlyCampaignAnalytics(params: Record<string, unknown>): Promise<any> {
    const userId = (params.userId ?? params.user_id) as string;
    if (!userId) throw new BadRequestException('user_id is required for Instantly Campaign Analytics');
    let ids = params.campaignIds ?? params.campaign_ids ?? params.ids;
    if (typeof ids === 'string') ids = ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(ids)) ids = ids ? [String(ids)] : [];
    return this.instantlyService.getCampaignAnalytics(userId, {
      ids: ids as string[],
      start_date: (params.startDate ?? params.start_date) as string | undefined,
      end_date: (params.endDate ?? params.end_date) as string | undefined,
      exclude_total_leads_count: (params.excludeTotalLeadsCount ?? params.exclude_total_leads_count) as boolean | undefined,
    });
  }

  async getInstantlyDailyCampaignAnalytics(params: Record<string, unknown>): Promise<any> {
    const userId = (params.userId ?? params.user_id) as string;
    if (!userId) throw new BadRequestException('user_id is required for Instantly Daily Campaign Analytics');
    return this.instantlyService.getDailyCampaignAnalytics(userId, {
      campaign_id: (params.campaignId ?? params.campaign_id) as string,
      start_date: (params.startDate ?? params.start_date) as string | undefined,
      end_date: (params.endDate ?? params.end_date) as string | undefined,
      campaign_status: (params.status ?? params.campaign_status) as number | undefined,
    });
  }

  async processTextOpenAI(params: Record<string, unknown>): Promise<{ content: string; usage?: unknown }> {
    const userId = (params.userId ?? params.user_id) as string | undefined;
    const systemPrompt = (params.systemPrompt ?? params.system_prompt ?? '') as string;
    const inputPrompt = (params.inputPrompt ?? params.input_prompt) as string;
    const modelSelection = (params.modelSelection ?? params.model_selection ?? 'gpt-4o') as string;
    const creativityLevel = Number(params.creativityLevel ?? params.creativity_level ?? 0.7);
    if (!inputPrompt) throw new BadRequestException('Input Prompt is required');

    let userSecrets: Record<string, any> | undefined;
    if (userId) {
      try {
        const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).select('openai').lean();
        const arr = (doc as any)?.openai;
        if (Array.isArray(arr) && arr.length > 0) userSecrets = { openai: arr };
      } catch (_) {
        // ignore
      }
    }

    const result = await this.rateLimiter.execute({
      provider: 'openai',
      userSecrets,
      requestFn: async (apiKey: string) => {
        const openai = new OpenAI({ apiKey });
        const completion = await openai.chat.completions.create({
          model: modelSelection,
          messages: [
            ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
            { role: 'user' as const, content: inputPrompt },
          ],
          temperature: creativityLevel,
        });
        const content = completion.choices?.[0]?.message?.content ?? '';
        const usage = (completion as any).usage;
        return { content, usage };
      },
    });
    return { content: result.content, usage: result.usage };
  }

  async processTextGemini(params: Record<string, unknown>): Promise<{ content: string; usage?: unknown }> {
    const userId = (params.userId ?? params.user_id) as string | undefined;
    const systemPrompt = (params.systemPrompt ?? params.system_prompt ?? '') as string;
    const inputPrompt = (params.inputPrompt ?? params.input_prompt) as string;
    const modelSelection = (params.modelSelection ?? params.model_selection ?? 'gemini-2.0-flash') as string;
    const creativityLevel = Number(params.creativityLevel ?? params.creativity_level ?? 0.7);
    if (!inputPrompt) throw new BadRequestException('Input Prompt is required');

    let userSecrets: Record<string, any> | undefined;
    if (userId) {
      try {
        const doc = await this.userSecretsModel.findOne({ user_id: new Types.ObjectId(userId) }).select('gemini').lean();
        const arr = (doc as any)?.gemini;
        if (Array.isArray(arr) && arr.length > 0) userSecrets = { gemini: arr };
      } catch (_) {
        // ignore
      }
    }

    const result = await this.rateLimiter.execute({
      provider: 'gemini',
      userSecrets,
      requestFn: async (apiKey: string) => {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelSelection });
        const prompt = systemPrompt ? `${systemPrompt}\n\n${inputPrompt}` : inputPrompt;
        const genResult = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: creativityLevel },
        });
        const text = genResult.response?.text?.() ?? '';
        const usage = (genResult.response as any)?.usageMetadata ?? null;
        return { content: text, usage };
      },
    });
    return { content: result.content, usage: result.usage };
  }

  async processVercelDeploy(params: Record<string, unknown>): Promise<string> {
    const userId = (params.userId ?? params.user_id) as string;
    if (!userId) throw new BadRequestException('user_id is required for Vercel Deployment');
    const name = (params.name ?? params.project ?? 'project') as string;
    const html = (params.html ?? '') as string;
    const slug = (params.slug ?? 'page') as string;
    if (!html) throw new BadRequestException('HTML content is required for Vercel deploy');
    return this.vercelService.deployCompanyPages({ userId, name, html, slug });
  }

  /**
   * Generic entry point: execute the function for a node and return output map
   * { [variableName]: value } for the worker to cache.
   */
  async executeWorkflowFunction(
    {
      fn,
      params,
      workflowInput = {},
      subNodes = [],
    }: {
      fn: string;
      params: Record<string, unknown>;
      workflowInput?: Record<string, unknown>;
      subNodes?: { parameters?: Record<string, unknown>; nodeMasterId?: string }[];
    },
    _context?: {
      nodeExecutionId?: string;
      workflowExecutionId?: string;
      fanoutExecutionId?: string;
      fanoutIterationKey?: string | number;
      nodeId?: string;
      nodeMasterId?: string;
    },
  ): Promise<Record<string, unknown>> {
    const outputMap: Record<string, unknown> = {};
    const variableName = (params?.['variableName'] ?? params?.variableName) as string | undefined;

    if (fn === 'processInput') {
      if (Array.isArray(subNodes) && subNodes.length > 0) {
        for (let i = 0; i < subNodes.length; i++) {
          const subNode = subNodes[i];
          const subParams = subNode?.parameters ?? {};
          const subNodeMasterId = subNode?.nodeMasterId ?? (subNode as any)?.nodeMasterId?._id?.toString?.();
          const subVarName = (subParams['variableName'] ?? subParams.variableName) as string | undefined;
          if (!subVarName) {
            this.logger.warn(`[executeWorkflowFunction] Skipping subNode ${i + 1}: no variableName`);
            continue;
          }
          let subOutput: unknown;
          if (String(subNodeMasterId) === DATE_TIME_SUBNODE_MASTER_ID) {
            const dateTimeInput = workflowInput?.[subVarName]?.toString() ?? '';
            subOutput = await this.processDateTime({
              format: subParams['format'] as string,
              timezone: subParams['timezone'] as string,
              variableName: subVarName,
              value: dateTimeInput,
              defaultDate: subParams['defaultDate'] as string,
              defaultTime: subParams['defaultTime'] as string,
            });
          } else {
            subOutput = await this.processInput(workflowInput, subVarName);
          }
          outputMap[subVarName] = subOutput;
        }
      }
      if (variableName) {
        const mainOutput = await this.processInput(workflowInput, variableName);
        outputMap[variableName] = mainOutput;
      }
      if (workflowInput && typeof workflowInput === 'object') {
        const processed = new Set(Object.keys(outputMap));
        for (const key of Object.keys(workflowInput)) {
          if (!processed.has(key)) outputMap[key] = workflowInput[key];
        }
      }
      return outputMap;
    }

    if (fn === 'processAIChat') {
      if (variableName) {
        return await this.processAIChat({ workflowInput, variableName });
      }
      this.logger.warn('[executeWorkflowFunction] processAIChat: no variableName');
      return {};
    }

    if (fn === 'processDateTime') {
      if (variableName) {
        const dateTimeValue = workflowInput?.[variableName] ?? params?.value;
        const dateResult = await this.processDateTime({
          format: params?.format as string,
          timezone: params?.timezone as string,
          variableName,
          value: dateTimeValue,
          defaultDate: params?.defaultDate as string,
          defaultTime: params?.defaultTime as string,
        });
        outputMap[variableName] = dateResult;
      }
      return outputMap;
    }

    if (fn === 'processConditional') {
      const conditions = (params?.conditions as { subject: unknown; logic: string; value: unknown }[]) ?? [];
      const conditionMode = (params?.conditionMode as 'all_conditions' | 'any_condition' | 'custom_logic') ?? 'all_conditions';
      const customLogic = params?.customLogic as string | undefined;
      const conditionMet = await this.processConditional({
        conditions: conditions.map((c) => ({ subject: c.subject, logic: c.logic, value: c.value })),
        conditionMode,
        customLogic,
        input: { ...workflowInput, ...params },
      });
      return {
        __isConditional: true,
        conditionalMetadata: {
          conditions,
          conditionMode,
          customLogic: customLogic ?? null,
          evaluationResult: conditionMet,
          evaluatedAt: new Date().toISOString(),
          subType: params?.subType ?? 'if',
          nextNodeId: params?.nextNodeId ?? null,
        },
        evaluationResult: conditionMet,
      };
    }

    if (fn === 'processOutput') {
      const value = params?.value ?? workflowInput?.[variableName as string];
      if (variableName) outputMap[variableName] = value;
      return outputMap;
    }

    if (fn === 'processFanout' || fn === 'fanout') {
      const inputArrayPath = (params?.inputArray ?? params?.input_array) as string;
      if (!inputArrayPath || !variableName) {
        this.logger.warn('[executeWorkflowFunction] processFanout: missing inputArray or variableName');
        return outputMap;
      }
      const pathStr = inputArrayPath.replace(/^\$\{|\}$/g, '').trim();
      const keys = pathStr.split('.');
      let value: unknown = workflowInput?.[keys[0]];
      for (let i = 1; i < keys.length && value != null && typeof value === 'object'; i++) {
        value = (value as Record<string, unknown>)[keys[i]];
      }
      let arr = Array.isArray(value) ? value : [];
      if (arr.length === 0 && pathStr.includes('GridData') && workflowInput && typeof workflowInput === 'object') {
        for (const v of Object.values(workflowInput)) {
          if (v && typeof v === 'object' && Array.isArray((v as any).GridData?.data)) {
            arr = (v as any).GridData.data;
            this.logger.log(`[processFanout] resolved array from GridData.data (${arr.length} items)`);
            break;
          }
        }
      }
      outputMap[variableName] = arr;
      return outputMap;
    }

    const handler = (this as any)[fn];
    if (typeof handler === 'function') {
      const result = await handler.call(this, params, {
        workflowInput,
        nodeExecutionId: _context?.nodeExecutionId,
        workflowExecutionId: _context?.workflowExecutionId,
      });
      if (variableName) outputMap[variableName] = result;
      return outputMap;
    }

    this.logger.warn(`[executeWorkflowFunction] Unknown functionToExecute: ${fn}`);
    throw new BadRequestException(`Unknown functionToExecute: ${fn}`);
  }
}
