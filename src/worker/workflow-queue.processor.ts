import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WorkflowCacheService } from '../workflow-cache/workflow-cache.service';
import { ActionService } from './action.service';
import {
  requiresPolling,
  isAgentRunCompletedFromOutput,
  resolveDynamicParams,
} from './workflow-processor.utils';

/**
 * Processes workflow node jobs from workflowQueue (aligned with GrowStack monorepo worker).
 * - Job payload must include functionToExecute (from NodeMaster).
 * - workflowInput is built from cache variables so actions receive a variable map.
 * - Resolves dynamic params (${...}) from cache before execution.
 * - Handles conditional nodes (no cache write; status skipped/completed + conditionalMetadata).
 * - On error, stores error in cache under variableName when present.
 * - For polling job types, sends status waiting_for_webhook with returnvalue.
 */
@Processor('workflowQueue', { concurrency: 5 })
@Injectable()
export class WorkflowQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowQueueProcessor.name);

  constructor(
    private readonly cache: WorkflowCacheService,
    private readonly actionService: ActionService,
    @InjectQueue('nodeCompletionQueue') private nodeCompletionQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as any;
    const {
      workflowId,
      workflowExecutionId,
      nodeExecutionId,
      parameters = {},
      userId,
      workflowInput: jobWorkflowInput,
      functionToExecute,
      subNodes = [],
      nodeId,
      nodeMasterId,
      dynamicParams,
      type: jobType,
    } = data;

    const fn = functionToExecute ?? data.fn;
    if (!fn) {
      this.logger.warn(
        `[worker] job id=${job.id} missing functionToExecute, using processInput`,
      );
    }

    const fanoutIndex = data.fanoutIndex;
    const fanoutTotal = data.fanoutTotal;
    if (fanoutIndex != null && fanoutTotal != null) {
      this.logger.log(
        `[FANOUT_ITERATION] workflowExecutionId=${workflowExecutionId} nodeExecutionId=${nodeExecutionId} iteration=${fanoutIndex + 1}/${fanoutTotal}`,
      );
    }

    this.logger.log(
      `[worker] job id=${job.id} type=${data.type} fn=${fn} nodeExecutionId=${nodeExecutionId} workflowExecutionId=${workflowExecutionId}`,
    );

    let status: 'completed' | 'failed' | 'skipped' | 'waiting_for_webhook' =
      'completed';
    let returnvalue: Record<string, unknown> = {};
    let conditionalMetadata: Record<string, unknown> | undefined;

    try {
      const variables = this.cache.getVariables(workflowExecutionId);
      const jobInput =
        jobWorkflowInput && typeof jobWorkflowInput === 'object' ? jobWorkflowInput : {};
      const workflowInput: Record<string, unknown> = {
        ...variables,
        ...(Object.keys(jobInput).length > 0 ? jobInput : {}),
      };

      let params = { ...parameters } as Record<string, unknown>;
      if (userId !== undefined) {
        params.userId = userId;
        params.user_id = userId;
      }

      // Resolve dynamic params (${...}) from merged workflowInput so fanout row (e.g. initial_instance) is available
      const dynamicParamKeys =
        Array.isArray(dynamicParams) && dynamicParams.length > 0
          ? dynamicParams
          : undefined;
      params = resolveDynamicParams(params, workflowInput, dynamicParamKeys) as Record<string, unknown>;

      // Agents nodes: run Candidate Profile Analyzer in-process (no webhook)
      const isAgentsJob = (jobType ?? data?.type ?? '').toString().toLowerCase() === 'agents';
      const resolvedFn =
        isAgentsJob
          ? 'runAgent'
          : fn === 'executeNode'
            ? 'processInput'
            : (fn || 'processInput');

      // nodeMasterId can be lost in Bull serialization; fallback to params.nodeMasterId (scheduler sets both)
      const resolvedNodeMasterId =
        nodeMasterId != null && String(nodeMasterId).trim() !== ''
          ? String(nodeMasterId).trim()
          : (params?.nodeMasterId != null ? String(params.nodeMasterId).trim() : undefined) || undefined;

      returnvalue = await this.actionService.executeWorkflowFunction(
        {
          fn: resolvedFn,
          params,
          workflowInput,
          subNodes,
        },
        {
          nodeExecutionId,
          workflowExecutionId,
          workflowId,
          nodeId,
          nodeMasterId: resolvedNodeMasterId,
        },
      );

      // Conditional node: do not save to cache; send status + conditionalMetadata
      if (
        returnvalue &&
        typeof returnvalue === 'object' &&
        (returnvalue as any).__isConditional === true
      ) {
        conditionalMetadata = (returnvalue as any).conditionalMetadata;
        const evaluationResult = (returnvalue as any).evaluationResult;
        status = evaluationResult ? 'completed' : 'skipped';
        await this.nodeCompletionQueue.add(
          'node-completion',
          {
            workflowExecutionId,
            workflowId,
            nodeExecutionId,
            status,
            returnvalue: {},
            conditionalMetadata,
          },
          { removeOnComplete: true },
        );
        this.logger.log(
          `[worker] nodeExecutionId=${nodeExecutionId} conditional status=${status}`,
        );
        return;
      }

      // Non-conditional: save outputs to cache (skip __ keys)
      if (
        returnvalue &&
        typeof returnvalue === 'object' &&
        Object.keys(returnvalue).length > 0
      ) {
        // Store per-fanout iteration so scheduler can build loop[] with each row's result
        if (
          workflowExecutionId &&
          nodeExecutionId &&
          fanoutIndex != null &&
          typeof fanoutIndex === 'number'
        ) {
          await this.cache.addFanoutIterationResult(
            workflowExecutionId,
            nodeExecutionId,
            fanoutIndex,
            returnvalue as Record<string, unknown>,
          );
        }
        for (const [k, v] of Object.entries(returnvalue)) {
          if (k.startsWith('__')) continue;
          if (v === null || v === undefined) continue;
          await this.cache.addOutputAsCache(workflowExecutionId, k, v);
        }
      }

      const type = jobType ?? data.type;
      const nodeMasterIdStr =
        nodeMasterId != null ? String(nodeMasterId) : 'unknown';
      let shouldPoll = requiresPolling(type, nodeMasterIdStr);
      const isAgentJob = (type || '').toLowerCase() === 'agents';
      if (isAgentJob && isAgentRunCompletedFromOutput(returnvalue)) {
        shouldPoll = false;
      }

      if (shouldPoll) {
        status = 'waiting_for_webhook';
      }

      this.logger.log(
        `[worker] nodeExecutionId=${nodeExecutionId} completed status=${status}`,
      );

      await this.nodeCompletionQueue.add(
        'node-completion',
        {
          workflowExecutionId,
          workflowId,
          nodeExecutionId,
          status,
          returnvalue,
          ...(conditionalMetadata && { conditionalMetadata }),
        },
        { removeOnComplete: true },
      );
    } catch (err: any) {
      status = 'failed';
      const errorMessage = err?.message ?? String(err);
      returnvalue = { error: errorMessage };

      const variableName = (parameters?.variableName ??
        (parameters as any)?.variableName) as string | undefined;
      if (
        workflowExecutionId &&
        variableName &&
        String(variableName).length > 0
      ) {
        try {
          await this.cache.addOutputAsCache(
            workflowExecutionId,
            String(variableName),
            errorMessage,
          );
        } catch (cacheErr: any) {
          this.logger.warn(
            `[worker] failed to store error in cache: ${cacheErr?.message}`,
          );
        }
      }

      this.logger.warn(
        `[worker] nodeExecutionId=${nodeExecutionId} failed: ${errorMessage}`,
      );

      await this.nodeCompletionQueue.add(
        'node-completion',
        {
          workflowExecutionId,
          workflowId,
          nodeExecutionId,
          status: 'failed',
          returnvalue,
        },
        { removeOnComplete: true },
      );
    }
  }
}
