import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { Workflow, WorkflowDocument } from '../schemas/workflow.schema';
import { WorkflowExecution, WorkflowExecutionDocument } from '../schemas/workflow-execution.schema';
import { Node, NodeDocument } from '../schemas/node.schema';
import { NodeExecution, NodeExecutionDocument } from '../schemas/node-execution.schema';
import { NodeMaster, NodeMasterDocument } from '../schemas/node-master.schema';

export const SCHEDULER_QUEUE_NAME = 'scheduler-queue';

/** Node types that use webhook trigger URL (Calendly, Cal.com, Instantly). */
const WEBHOOK_TRIGGER_TYPES = new Set(['calendly', 'cal', 'instantly']);

function isWebhookTriggerType(type: string | undefined): boolean {
  return type != null && WEBHOOK_TRIGGER_TYPES.has((type || '').toLowerCase());
}

/**
 * Unwrap node result when it's a single-key map (e.g. { variableName: output }).
 * So the API returns the actual agent/output content for display instead of the wrapper.
 */
function unwrapNodeResult(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result !== 'object' || Array.isArray(result)) return result;
  const keys = Object.keys(result as object);
  if (keys.length !== 1) return result;
  return (result as Record<string, unknown>)[keys[0]];
}

@Injectable()
export class WorkflowService {
  constructor(
    @InjectModel(Workflow.name) private workflowModel: Model<WorkflowDocument>,
    @InjectModel(Node.name) private nodeModel: Model<NodeDocument>,
    @InjectModel(WorkflowExecution.name) private workflowExecutionModel: Model<WorkflowExecutionDocument>,
    @InjectModel(NodeExecution.name) private nodeExecutionModel: Model<NodeExecutionDocument>,
    @InjectModel(NodeMaster.name) private nodeMasterModel: Model<NodeMasterDocument>,
    @InjectQueue(SCHEDULER_QUEUE_NAME) private schedulerQueue: Queue,
  ) {}

  async listWorkflows(userId?: string, isPrebuilt?: boolean) {
    const filter: Record<string, unknown> = {};
    if (userId) filter.userId = new Types.ObjectId(userId);
    if (isPrebuilt !== undefined) filter.isPrebuilt = isPrebuilt;
    const workflows = await this.workflowModel
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    return workflows;
  }

  /** Backend base URL for webhook trigger links (Calendly, Cal.com, Instantly). */
  private getBackendBaseUrl(): string {
    const url = (
      process.env.BACKEND_BASE_URL ||
      process.env.CONNECT_BASE_URL ||
      process.env.BASE_URL ||
      'http://localhost:8000'
    ).trim().replace(/\/+$/, '');
    return url;
  }

  /** Build webhook trigger URL for trigger nodes. Format: {baseUrl}/orchestration/workflow/{node}/trigger-webhook?workflowId=...&nodeId=...&userId=... */
  getTriggerWebhookUrl(nodeType: string, workflowId: string, nodeId: string, userId: string): string {
    const base = this.getBackendBaseUrl();
    const node = (nodeType || '').toLowerCase();
    const normalized = node === 'cal.com' ? 'cal' : node;
    if (!WEBHOOK_TRIGGER_TYPES.has(normalized)) {
      return '';
    }
    const params = new URLSearchParams({
      workflowId: String(workflowId),
      nodeId: String(nodeId),
      userId: String(userId),
    });
    return `${base}/orchestration/workflow/${normalized}/trigger-webhook?${params.toString()}`;
  }

  async getWorkflow(id: string, userId?: string): Promise<Record<string, unknown>> {
    const workflow = await this.workflowModel
      .findById(id)
      .populate({ path: 'nodes', populate: { path: 'nodeMasterId', select: 'type functionToExecute dynamicParams metaData' } })
      .lean();
    if (!workflow) throw new NotFoundException('Workflow not found');
    const wfId = (workflow as any)._id?.toString?.() || id;
    const rawNodes = (workflow as any).nodes;
    if (!userId || !Array.isArray(rawNodes)) {
      return workflow;
    }
    // Build default trigger URL for Input parameters (Trigger URL): env base + path + dynamic workflowId, nodeId, userId
    const triggerNode = rawNodes.find(
      (n: any) => isWebhookTriggerType(n?.nodeMasterId?.type),
    );
    const firstNodeId = rawNodes[0]?._id?.toString?.() || '';
    const triggerType = triggerNode?.nodeMasterId?.type ?? 'calendly';
    const triggerNodeId = triggerNode?._id?.toString?.() || firstNodeId;
    const defaultTriggerUrl =
      this.getTriggerWebhookUrl(triggerType, wfId, triggerNodeId, userId) ||
      `${this.getBackendBaseUrl()}/orchestration/workflow/calendly/trigger-webhook?${new URLSearchParams({
        workflowId: wfId,
        nodeId: triggerNodeId,
        userId: String(userId),
      }).toString()}`;

    const nodes = rawNodes.map((node: any) => {
      const master = node.nodeMasterId;
      const type = master?.type;
      let parameters = node.parameters || {};
      // Inject url for webhook trigger nodes
      if (isWebhookTriggerType(type)) {
        const nodeId = node._id?.toString?.() || '';
        const url = this.getTriggerWebhookUrl(type, wfId, nodeId, userId);
        parameters = { ...parameters, url };
      }
      // Inject default value for form subNodes with variableName "trigger_url" (webhook registration templates)
      let subNodes = node.subNodes;
      if (Array.isArray(subNodes) && subNodes.some((s: any) => (s?.parameters?.variableName || '').toString().trim().toLowerCase() === 'trigger_url')) {
        subNodes = subNodes.map((sub: any) => {
          const p = sub?.parameters || {};
          const vn = (p.variableName || '').toString().trim().toLowerCase();
          if (vn === 'trigger_url') {
            return { ...sub, parameters: { ...p, defaultValue: defaultTriggerUrl } };
          }
          return sub;
        });
      }
      return { ...node, parameters, ...(subNodes !== node.subNodes ? { subNodes } : {}) };
    });
    return { ...workflow, nodes };
  }

  async createWorkflowExecutionPayload(
    workflowId: string,
    userId: string,
    previousExecutionId?: string,
    startNodeId?: string,
  ) {
    const workflow = await this.workflowModel
      .findById(workflowId)
      .populate({ path: 'nodes', populate: { path: 'nodeMasterId', select: 'type functionToExecute dynamicParams metaData' } })
      .lean();
    if (!workflow) throw new BadRequestException('Workflow not found');

    const wfIdStr = (workflow as any)._id?.toString?.() || workflowId;
    const nodes = Array.isArray(workflow.nodes) ? (workflow.nodes as any[]) : [];
    let firstTriggerWebhookUrl: string | undefined;
    let firstTriggerNodeId: string | undefined;
    const sanitizedNodes = nodes.map((node: any) => {
      const master = node.nodeMasterId;
      const type = master?.type;
      let parameters = node.parameters || {};
      if (isWebhookTriggerType(type)) {
        const nodeId = node._id?.toString?.() || '';
        const url = this.getTriggerWebhookUrl(type, wfIdStr, nodeId, userId);
        parameters = { ...parameters, url };
        if (firstTriggerWebhookUrl == null) {
          firstTriggerWebhookUrl = url;
          firstTriggerNodeId = nodeId;
        }
      }
      return {
        ...node,
        parameters,
        functionToExecute: master?.functionToExecute,
        dynamicParams: master?.dynamicParams || [],
        metaData: master?.metaData || {},
      };
    });

    const workflowExecutionId = new Types.ObjectId().toHexString();
    const traceId = require('crypto').randomBytes(16).toString('hex');

    await this.workflowExecutionModel.create({
      _id: new Types.ObjectId(workflowExecutionId),
      workflowId: new Types.ObjectId(workflowId),
      userId: new Types.ObjectId(userId),
      startTimestamp: new Date(),
      input: [],
      variables: {},
      nodeExecutions: [],
      status: 'pending',
      isScheduled: false,
      traceId,
    });

    return {
      workflowId: wfIdStr,
      userId,
      nodes: sanitizedNodes,
      workflowExecutionId,
      traceId,
      previousExecutionId: previousExecutionId || undefined,
      startNodeId: startNodeId || undefined,
      previousVariables: {},
      previousInput: [],
      triggerWebhookUrl: firstTriggerWebhookUrl,
      triggerNodeId: firstTriggerNodeId,
    };
  }

  async enqueueWorkflowExecutionPayload(payload: any): Promise<string> {
    const jobId =
      payload.workflowExecutionId ||
      `run-${payload.workflowId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    await this.schedulerQueue.add(
      'workflow',
      { ...payload, data: payload },
      { jobId, removeOnComplete: true },
    );
    return jobId;
  }

  async getExecutionById(executionId: string): Promise<Record<string, unknown> & { nodes: Array<Record<string, unknown>> }> {
    const execution = await this.workflowExecutionModel
      .findById(executionId)
      .populate('workflowId', 'name')
      .lean();
    if (!execution) throw new NotFoundException('Execution not found');

    const nodeExecutions = await this.nodeExecutionModel
      .find({ workflowExecutionId: new Types.ObjectId(executionId) })
      .populate('nodeId', 'name type')
      .sort({ startTimeStamp: 1 })
      .lean();

    const nodes = nodeExecutions.map((ne: any) => ({
      nodeId: ne.nodeId?._id?.toString(),
      nodeName: ne.nodeId?.name,
      type: ne.nodeId?.type,
      status: ne.status,
      result: unwrapNodeResult(ne.result),
      startTime: ne.startTimeStamp,
      endTime: ne.endTimeStamp,
    }));

    return {
      ...execution,
      nodes,
    };
  }

  async listWorkflowRuns(params: {
    userId: string;
    workflowId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    runs: Array<{
      _id: string;
      workflowRunId: string;
      workflowName: string;
      status: string;
      lastUpdatedAt: string;
      startTimestamp?: string;
    }>;
    total: number;
  }> {
    const { userId, workflowId: workflowIdParam, search, limit = 20, offset = 0 } = params;
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

    if (workflowIdParam) {
      filter.workflowId = new Types.ObjectId(workflowIdParam);
    } else if (search?.trim()) {
      const workflowIds = await this.workflowModel
        .find({ name: { $regex: search.trim(), $options: 'i' } })
        .select('_id')
        .lean();
      const ids = workflowIds.map((w: any) => w._id);
      if (ids.length > 0) {
        filter.workflowId = { $in: ids };
      }
    }

    const [runs, total] = await Promise.all([
      this.workflowExecutionModel
        .find(filter)
        .populate('workflowId', 'name')
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(Math.min(limit, 100))
        .lean()
        .exec(),
      this.workflowExecutionModel.countDocuments(filter),
    ]);

    const results = (runs as any[]).map((doc) => ({
      _id: doc._id?.toString?.(),
      workflowRunId: doc._id?.toString?.(),
      workflowName: (doc.workflowId as any)?.name ?? 'Unknown',
      status: doc.status ?? 'pending',
      lastUpdatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : doc.startTimestamp ? new Date(doc.startTimestamp).toISOString() : '',
      startTimestamp: doc.startTimestamp ? new Date(doc.startTimestamp).toISOString() : undefined,
    }));

    return { runs: results, total };
  }

  async getExecutionStatus(workflowId: string, workflowExecutionId: string) {
    const execution = await this.workflowExecutionModel
      .findById(workflowExecutionId)
      .lean();
    if (!execution) throw new NotFoundException('Execution not found');
    const execWfId = (execution.workflowId as any)?.toString?.();
    if (workflowId && execWfId !== workflowId) {
      throw new NotFoundException('Execution not found for this workflow');
    }
    const nodeExecutions = await this.nodeExecutionModel
      .find({ workflowExecutionId: new Types.ObjectId(workflowExecutionId) })
      .populate('nodeId', 'name type')
      .sort({ startTimeStamp: 1 })
      .lean();
    const nodes = (nodeExecutions as any[]).map((ne) => ({
      nodeId: ne.nodeId?._id?.toString(),
      nodeName: ne.nodeId?.name,
      type: ne.nodeId?.type,
      status: ne.status,
      result: ne.result,
      startTime: ne.startTimeStamp,
      endTime: ne.endTimeStamp,
    }));
    return {
      id: workflowExecutionId,
      status: execution.status,
      workflowExecutionId,
      workflowId: execWfId || workflowId,
      nodes,
    };
  }
}
