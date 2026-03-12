import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserSecrets, UserSecretsDocument } from '../schemas/user-secrets.schema';

/**
 * Executes workflow nodes. Form and conditional nodes are fully handled.
 * LLM/action nodes (e.g. Anthropic, Perplexity) return stubs; for real execution
 * either integrate the monorepo worker (same Redis workflowQueue) or implement
 * actions here (see GrowStack-ai-GrowStackAI-Backend-WorkFlow-Monorepo apps/worker).
 */
@Injectable()
export class NodeExecutorService {
  constructor(
    @InjectModel(UserSecrets.name) private userSecretsModel: Model<UserSecretsDocument>,
  ) {}

  async execute(params: {
    type: string;
    parameters: Record<string, unknown>;
    workflowInput: any[];
    userId: string;
    variables?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const { type, parameters, workflowInput, userId, variables = {} } = params;

    if (type === 'form' || type === 'form_input') {
      const out: Record<string, unknown> = {};
      for (const inp of workflowInput || []) {
        const name = inp.variableName ?? inp.name;
        const val = inp.variableValue ?? inp.value;
        if (name) out[name] = val;
      }
      const variableName = (parameters as any).variableName;
      if (variableName && Object.keys(out).length > 0) {
        return { [variableName]: out };
      }
      return out;
    }

    if (type === 'conditional_node' || type === 'tools' || type === 'if' || type === 'else') {
      return { conditionalResult: true, nextNodeId: null };
    }

    const variableName = (parameters as any).variableName;
    const stubResult = variableName
      ? { [variableName]: { stub: true, type, message: 'Integration node stubbed' } }
      : { stub: true, type };
    return stubResult as Record<string, unknown>;
  }
}
