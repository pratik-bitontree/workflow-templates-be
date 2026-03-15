import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { Workflow, WorkflowDocument } from '../schemas/workflow.schema';
import { Node, NodeDocument } from '../schemas/node.schema';
import { WorkflowExecution, WorkflowExecutionDocument } from '../schemas/workflow-execution.schema';
import { NodeExecution, NodeExecutionDocument } from '../schemas/node-execution.schema';
import { WorkflowCacheService } from '../workflow-cache/workflow-cache.service';
import { DynamicQueueManager } from './dynamic-queue.manager';

@Injectable()
export class RunWorkflowService {
  private readonly logger = new Logger(RunWorkflowService.name);

  constructor(
    @InjectModel(Workflow.name) private workflowModel: Model<WorkflowDocument>,
    @InjectModel(Node.name) private nodeModel: Model<NodeDocument>,
    @InjectModel(WorkflowExecution.name) private workflowExecutionModel: Model<WorkflowExecutionDocument>,
    @InjectModel(NodeExecution.name) private nodeExecutionModel: Model<NodeExecutionDocument>,
    private readonly workflowCache: WorkflowCacheService,
    @InjectQueue('workflowQueue') private workflowQueue: Queue,
    @Inject(forwardRef(() => DynamicQueueManager)) private readonly dynamicQueueManager: DynamicQueueManager,
  ) {}

  async runWorkflow(payload: {
    workflowId: string;
    userId: string;
    workflowExecutionId: string;
    nodes: any[];
    input: any[];
    startNodeId?: string;
    previousExecutionId?: string;
    previousVariables?: Record<string, unknown>;
  }) {
    const { workflowId, userId, workflowExecutionId, nodes: payloadNodes, input, previousVariables = {} } = payload;

    this.logger.log(`[runWorkflow] start workflowExecutionId=${workflowExecutionId} workflowId=${workflowId} payloadNodes=${payloadNodes?.length ?? 0}`);

    let nodes = payloadNodes;
    if (!nodes || nodes.length === 0) {
      this.logger.log(`[runWorkflow] no nodes in payload, loading from DB`);
      const workflow = await this.workflowModel.findById(workflowId).lean();
      if (!workflow) return { error: 'Workflow not found' };
      const nodeIds = (workflow as any).nodes?.map((n: any) => n._id || n) || [];
      const nodeDocs = await this.nodeModel
        .find({ _id: { $in: nodeIds } })
        .populate({ path: 'nodeMasterId', select: 'type functionToExecute dynamicParams' })
        .lean();
      nodes = (nodeDocs as any[]).map((n: any) => ({
        ...n,
        functionToExecute: n.functionToExecute ?? n.nodeMasterId?.functionToExecute ?? 'processInput',
      }));
      this.logger.log(`[runWorkflow] loaded ${nodes.length} nodes from DB`);
    }

    await this.workflowExecutionModel.updateOne(
      { _id: workflowExecutionId },
      { $set: { status: 'in-progress', input } },
    );

    await this.workflowCache.createExecutionTable(workflowExecutionId);
    await this.dynamicQueueManager.createQueueForExecution(workflowExecutionId);

    const executionIdObj = new Types.ObjectId(workflowExecutionId);
    const variables: Record<string, unknown> = { ...previousVariables };

    for (const inp of input || []) {
      const name = inp.variableName ?? inp.name;
      const val = inp.variableValue ?? inp.value;
      if (name) {
        variables[name] = val;
        await this.workflowCache.addOutputAsCache(workflowExecutionId, name, val);
      }
    }

    if (nodes.length === 0) {
      this.logger.log(`[runWorkflow] no nodes -> marking workflow completed`);
      await this.workflowExecutionModel.updateOne(
        { _id: workflowExecutionId },
        { $set: { status: 'completed', endTimestamp: new Date(), variables } },
      );
      return { executionId: workflowExecutionId };
    }

    const nodeExecutions: { node: any; nodeExecutionId: string }[] = [];
    for (const node of nodes) {
      const deps = node.dependencies || [];
      const status = deps.length === 0 ? 'ready' : 'pending';
      const nodeIdRaw = node._id ?? node.id;
      const nodeIdObj = nodeIdRaw instanceof Types.ObjectId ? nodeIdRaw : new Types.ObjectId(String(nodeIdRaw));
      const ne = await this.nodeExecutionModel.create({
        nodeId: nodeIdObj,
        workflowExecutionId: executionIdObj,
        parameters: node.parameters || {},
        dependencies: deps,
        subNodes: node.subNodes || [],
        status,
      });
      nodeExecutions.push({ node, nodeExecutionId: ne._id.toString() });
    }

    this.logger.log(`[runWorkflow] created ${nodeExecutions.length} node executions; enqueueing nodes with no deps`);

    await this.workflowExecutionModel.updateOne(
      { _id: workflowExecutionId },
      {
        $set: {
          nodeExecutions: nodeExecutions.map((n) => new Types.ObjectId(n.nodeExecutionId)),
          variables,
        },
      },
    );

    let enqueuedCount = 0;
    for (const { node, nodeExecutionId } of nodeExecutions) {
      const deps = node.dependencies ?? [];
      const isFanout = (node as any)?.isFanoutNode === true;
      if (deps.length === 0 && !isFanout) {
        this.logger.log(`[runWorkflow] enqueue node nodeId=${(node._id ?? node.id)?.toString?.()} type=${node.type} nodeExecutionId=${nodeExecutionId}`);
        await this.enqueueNode(workflowId, workflowExecutionId, userId, node, nodeExecutionId, variables, payload.nodes);
        enqueuedCount++;
      }
    }
    this.logger.log(`[runWorkflow] enqueued ${enqueuedCount} initial node(s)`);

    return { executionId: workflowExecutionId };
  }

  async enqueueNode(
    workflowId: string,
    workflowExecutionId: string,
    userId: string,
    node: any,
    nodeExecutionId: string,
    variables: Record<string, unknown>,
    allNodes?: any[],
    jobIdSuffix?: string,
    fanoutTotal?: number,
    fanoutIndex?: number,
  ) {
    const functionToExecute = node.functionToExecute || 'executeNode';
    const jobId = jobIdSuffix ? `${nodeExecutionId}${jobIdSuffix}` : nodeExecutionId;
    const parameters = { ...(node.parameters || {}) };
    if ((node as any).nextNodeId != null) {
      parameters.nextNodeId = (node as any).nextNodeId?.toString?.() ?? String((node as any).nextNodeId);
    }
    const payload: Record<string, unknown> = {
      type: node.type || 'action',
      workflowId,
      workflowExecutionId,
      nodeId: node._id?.toString?.() || node.id,
      nodeExecutionId,
      parameters,
      userId,
      functionToExecute,
      workflowInput: variables && Object.keys(variables).length > 0 ? variables : [],
      nodeMasterId: node.nodeMasterId?._id?.toString?.() || node.nodeMasterId,
      subNodes: node.subNodes || [],
      dynamicParams: node.dynamicParams || [],
    };
    if (fanoutTotal != null && fanoutIndex != null) {
      payload.fanoutTotal = fanoutTotal;
      payload.fanoutIndex = fanoutIndex;
    }
    await this.workflowQueue.add('executeNode', payload, { jobId, removeOnComplete: true });
  }

  /**
   * Get all node ids that are downstream of the given node (dependents, transitive).
   * Used to mark only the failed branch when a node fails.
   */
  private getDownstreamNodeIds(failedNodeId: string, allNodes: any[]): Set<string> {
    const idStr = (n: any) => (n._id ?? n.id)?.toString?.();
    const downstream = new Set<string>();
    const stack = [failedNodeId];
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      for (const n of allNodes) {
        const nodeId = idStr(n);
        if (!nodeId || downstream.has(nodeId)) continue;
        const deps = n.dependencies || [];
        const hasCurrent = deps.some((d: any) => (d?.toString?.() ?? String(d)) === currentId);
        if (hasCurrent) {
          downstream.add(nodeId);
          stack.push(nodeId);
        }
      }
    }
    return downstream;
  }

  /**
   * Resolve fanout array from variables using path like "${read_data_from_sheet.GridData.data}" or "read_data_from_sheet.GridData.data".
   * Aligned with monorepo: scheduler resolves from cache (variables) instead of running fanout in worker.
   */
  private resolveFanoutArrayFromVariables(
    variables: Record<string, unknown>,
    inputArrayPath: string | undefined,
  ): unknown[] {
    if (!inputArrayPath || typeof inputArrayPath !== 'string') return [];
    const pathStr = inputArrayPath.replace(/^\$\{|\}$/g, '').trim();
    const keys = pathStr.split('.');
    let value: unknown = variables?.[keys[0]];
    for (let i = 1; i < keys.length && value != null && typeof value === 'object'; i++) {
      value = (value as Record<string, unknown>)[keys[i]];
    }
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray((value as any).GridData?.data)) {
      return (value as any).GridData.data;
    }
    for (const v of Object.values(variables || {})) {
      if (v && typeof v === 'object' && Array.isArray((v as any).GridData?.data)) {
        return (v as any).GridData.data;
      }
    }
    return [];
  }

  async onNodeCompleted(data: {
    workflowExecutionId: string;
    workflowId: string;
    nodeExecutionId: string;
    status: string;
    returnvalue?: Record<string, unknown>;
    conditionalMetadata?: Record<string, unknown>;
  }) {
    const {
      workflowExecutionId,
      nodeExecutionId,
      status,
      returnvalue = {},
      conditionalMetadata,
    } = data;

    this.logger.log(
      `[onNodeCompleted] nodeExecutionId=${nodeExecutionId} status=${status} workflowExecutionId=${workflowExecutionId}`,
    );

    const nodeExecution = await this.nodeExecutionModel.findById(nodeExecutionId);
    if (!nodeExecution) {
      this.logger.warn(
        `[onNodeCompleted] node execution not found: ${nodeExecutionId}`,
      );
      return;
    }

    const nodeStatus =
      status === 'failed'
        ? 'failed'
        : status === 'skipped'
          ? 'skipped'
          : status === 'waiting_for_webhook'
            ? 'waiting_for_webhook'
            : 'completed';

    const resultPayload =
      conditionalMetadata != null
        ? { ...returnvalue, conditionalMetadata }
        : returnvalue;

    await this.nodeExecutionModel.updateOne(
      { _id: nodeExecutionId },
      {
        $set: {
          status: nodeStatus,
          endTimeStamp: new Date(),
          result: resultPayload,
        },
      },
    );

    // Do not write to cache for skipped (conditional) or when no output
    if (nodeStatus === 'skipped') {
      // Conditional branch skipped – nothing to cache
    } else {
      const variableName = (nodeExecution.parameters as any)?.variableName;
      if (
        variableName &&
        returnvalue &&
        typeof returnvalue === 'object' &&
        Object.keys(returnvalue).length > 0
      ) {
        const value = returnvalue[variableName] ?? returnvalue;
        await this.workflowCache.addOutputAsCache(
          workflowExecutionId,
          variableName,
          value,
        );
      } else if (returnvalue && typeof returnvalue === 'object') {
        for (const [k, v] of Object.entries(returnvalue)) {
          if (k.startsWith('__')) continue;
          await this.workflowCache.addOutputAsCache(
            workflowExecutionId,
            k,
            v,
          );
        }
      }
    }

    const execution = await this.workflowExecutionModel.findById(workflowExecutionId).lean();
    if (!execution) return;

    const executionIdObj = new Types.ObjectId(workflowExecutionId);
    const wfId = (execution.workflowId as any)?._id ?? execution.workflowId;
    const allNodesRaw = await this.nodeModel
      .find({ workflowId: wfId })
      .populate({ path: 'nodeMasterId', select: 'type functionToExecute dynamicParams metaData' })
      .lean();
    const allNodes = (allNodesRaw as any[]).map((n: any) => ({
      ...n,
      functionToExecute: n.functionToExecute ?? n.nodeMasterId?.functionToExecute ?? 'processInput',
    }));
    let variables = this.workflowCache.getVariables(workflowExecutionId);

    const completedNodeId = (nodeExecution.nodeId as any)?.toString?.() ?? String(nodeExecution.nodeId);
    const completedNodeIdObj = nodeExecution.nodeId instanceof Types.ObjectId ? nodeExecution.nodeId : new Types.ObjectId(completedNodeId);
    const completedNode = allNodes.find(
      (n: any) => (n._id ?? n.id)?.toString?.() === completedNodeId || (n._id && completedNodeIdObj.equals(n._id)),
    );
    const dependents = allNodes.filter((n: any) =>
      (n.dependencies || []).some((d: any) => {
        const depStr = (d?.toString?.() ?? String(d))?.toString?.();
        const same = depStr === completedNodeId;
        if (!same && d && completedNodeIdObj.equals) {
          try {
            const dObj = d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d));
            return completedNodeIdObj.equals(dObj);
          } catch {
            return false;
          }
        }
        return same;
      }),
    );

    this.logger.log(`[onNodeCompleted] completedNodeId=${completedNodeId} allNodes=${allNodes.length} dependents=${dependents.length} depIds=${dependents.map((d: any) => (d._id ?? d.id)?.toString?.()).join(',')}`);

    // Resolve Else branch nextNodeId (monorepo: from conditionalMetadata, nodeExecution, or node definition)
    const conditionalNextNodeId = (data as any).conditionalMetadata?.nextNodeId != null
      ? ((data as any).conditionalMetadata.nextNodeId?.toString?.() ?? String((data as any).conditionalMetadata.nextNodeId))
      : null;
    const nodeDefNextNodeId = (completedNode as any)?.nextNodeId != null
      ? ((completedNode as any).nextNodeId?.toString?.() ?? String((completedNode as any).nextNodeId))
      : null;
    const actualNextNodeId = conditionalNextNodeId ?? (nodeExecution as any)?.nextNodeId?.toString?.() ?? nodeDefNextNodeId;

    // When an If (conditional) node completes: match monorepo behavior.
    // If TRUE: enqueue dependents excluding Else. If FALSE: do NOT enqueue Else; mark Else completed and enqueue Else's dependents only.
    const ifSubType = (completedNode as any)?.nodeMasterId?.metaData?.subType ?? (completedNode as any)?.metaData?.subType;
    const isCompletedIf = completedNode?.type === 'conditional_node' && (completedNode?.name === 'If' || ifSubType === 'if');
    const conditionTrue = nodeStatus === 'completed'; // for If nodes: completed => condition true, skipped => condition false
    let dependentsToConsider = dependents;
    if (isCompletedIf && dependents.length > 0) {
      if (!conditionTrue && actualNextNodeId) {
        // IF FALSE (monorepo): mark Else node execution as completed, then enqueue only Else's dependents (e.g. Create ZOHO). Do not enqueue Else itself.
        const elseNode = allNodes.find((n: any) => (n._id ?? n.id)?.toString?.() === actualNextNodeId);
        if (elseNode) {
          const elseNodeIdObj = elseNode._id ?? elseNode.id;
          const elseNe = await this.nodeExecutionModel.findOne({
            workflowExecutionId: executionIdObj,
            nodeId: elseNodeIdObj instanceof Types.ObjectId ? elseNodeIdObj : new Types.ObjectId(String(elseNodeIdObj)),
          });
          if (elseNe) {
            await this.nodeExecutionModel.updateOne(
              { _id: elseNe._id },
              { $set: { status: 'completed', endTimeStamp: new Date() } },
            );
            this.logger.log(`[onNodeCompleted] If condition false: marked Else node as completed nodeExecutionId=${elseNe._id} nextNodeId=${actualNextNodeId}`);
            const elseDependents = allNodes.filter((n: any) =>
              (n.dependencies || []).some((d: any) => (d?.toString?.() ?? String(d)) === (actualNextNodeId?.toString?.() ?? actualNextNodeId)),
            );
            for (const child of elseDependents) {
              const childNe = await this.nodeExecutionModel.findOne({
                workflowExecutionId: executionIdObj,
                nodeId: child._id ?? child.id,
              });
              if (!childNe || (childNe.status !== 'pending' && childNe.status !== 'ready')) continue;
              const childDeps = child.dependencies || [];
              const allChildDepsDone = await Promise.all(
                childDeps.map((d: any) => {
                  const dObj = d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d));
                  return this.nodeExecutionModel.findOne({
                    workflowExecutionId: executionIdObj,
                    nodeId: dObj,
                    status: { $in: ['completed', 'skipped'] },
                  });
                }),
              );
              if (!allChildDepsDone.every(Boolean)) continue;
              this.logger.log(`[onNodeCompleted] If condition false: enqueueing Else dependent nodeId=${(child._id ?? child.id)?.toString?.()} nodeExecutionId=${childNe._id}`);
              await this.enqueueNode(
                (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
                workflowExecutionId,
                (execution.userId as any)?.toString?.() ?? execution.userId,
                child,
                childNe._id.toString(),
                variables,
                allNodes,
              );
              if (childNe.status === 'pending') {
                await this.nodeExecutionModel.updateOne(
                  { _id: childNe._id },
                  { $set: { status: 'ready', startTimeStamp: new Date() } },
                );
              }
            }
          }
        }
        dependentsToConsider = [];
      } else if (conditionTrue && actualNextNodeId) {
        dependentsToConsider = dependents.filter((dep: any) => (dep._id ?? dep.id)?.toString?.() !== actualNextNodeId);
        this.logger.log(`[onNodeCompleted] If condition true: enqueueing then-branch only, excluding nextNodeId=${actualNextNodeId} count=${dependentsToConsider.length}`);
      } else {
        const isElse = (dep: any) => dep?.name === 'Else' || (dep?.type === 'conditional_node' && ((dep as any)?.nodeMasterId?.metaData?.subType === 'else' || (dep as any)?.metaData?.subType === 'else'));
        if (conditionTrue) {
          dependentsToConsider = dependents.filter((dep: any) => !isElse(dep));
        } else {
          dependentsToConsider = dependents.filter(isElse);
          if (dependentsToConsider.length > 0) {
            const elseNode = dependentsToConsider[0];
            const elseNodeIdStr = (elseNode._id ?? elseNode.id)?.toString?.();
            const elseNe = await this.nodeExecutionModel.findOne({
              workflowExecutionId: executionIdObj,
              nodeId: elseNodeIdStr ? new Types.ObjectId(elseNodeIdStr) : (elseNode._id ?? elseNode.id),
            });
            if (elseNe) {
              await this.nodeExecutionModel.updateOne({ _id: elseNe._id }, { $set: { status: 'completed', endTimeStamp: new Date() } });
              const elseDependents = allNodes.filter((n: any) => (n.dependencies || []).some((d: any) => (d?.toString?.() ?? String(d)) === elseNodeIdStr));
              for (const child of elseDependents) {
                const childNe = await this.nodeExecutionModel.findOne({ workflowExecutionId: executionIdObj, nodeId: child._id ?? child.id });
                if (!childNe || (childNe.status !== 'pending' && childNe.status !== 'ready')) continue;
                const childDeps = child.dependencies || [];
                const allChildDepsDone = await Promise.all(childDeps.map((d: any) => this.nodeExecutionModel.findOne({ workflowExecutionId: executionIdObj, nodeId: d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d)), status: { $in: ['completed', 'skipped'] } })));
                if (!allChildDepsDone.every(Boolean)) continue;
                await this.enqueueNode((wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId, workflowExecutionId, (execution.userId as any)?.toString?.() ?? execution.userId, child, childNe._id.toString(), variables, allNodes);
                if (childNe.status === 'pending') await this.nodeExecutionModel.updateOne({ _id: childNe._id }, { $set: { status: 'ready', startTimeStamp: new Date() } });
              }
            }
            dependentsToConsider = [];
          }
        }
      }
    }

    // Only enqueue dependents when this node actually completed or was skipped (not failed / waiting_for_webhook)
    const canProgress = nodeStatus === 'completed' || nodeStatus === 'skipped';
    if (canProgress) {
      const fanoutTotal = this.workflowCache.getFanoutTotal(workflowExecutionId, nodeExecutionId);
      if (fanoutTotal != null) {
        const completed = this.workflowCache.incrementFanoutCompleted(workflowExecutionId, nodeExecutionId);
        if (completed < fanoutTotal) {
          this.logger.log(
            `[onNodeCompleted] fanout child nodeExecutionId=${nodeExecutionId} ${completed}/${fanoutTotal} - not enqueueing dependents yet`,
          );
          return;
        }
        if (completed === fanoutTotal) {
          const batches = this.workflowCache.getFanoutBatches(workflowExecutionId, nodeExecutionId);
          const results = this.workflowCache.getFanoutResults(workflowExecutionId, nodeExecutionId);
          if (batches?.length && results.length) {
            const variableName = (completedNode as any)?.parameters?.variableName ?? 'result';
            const merged: unknown[] = [];
            for (let bi = 0; bi < batches.length; bi++) {
              const batch = (batches[bi] ?? []) as Record<string, unknown>[];
              const iterResult = (results[bi] ?? {}) as Record<string, unknown>;
              for (const row of batch) {
                merged.push({ ...(row as object), [variableName]: iterResult });
              }
            }
            await this.workflowCache.addOutputAsCache(workflowExecutionId, 'loop', merged);
            variables = this.workflowCache.getVariables(workflowExecutionId);
            this.logger.log(
              `[onNodeCompleted] fanout merge complete nodeExecutionId=${nodeExecutionId} loop.length=${merged.length} variableName=${variableName}`,
            );
          }
        }
      }

      // Re-enqueue nodes stuck in 'ready' (job was lost or never added) so they get processed
      const staleReadyThresholdMs = 5_000; // 5 seconds – recover quickly so dependents run soon after LLM
      const staleReadyCutoff = new Date(Date.now() - staleReadyThresholdMs);
      const stuckReady = await this.nodeExecutionModel
        .find({
          workflowExecutionId: executionIdObj,
          status: 'ready',
          startTimeStamp: { $lt: staleReadyCutoff },
        })
        .lean();
      for (const ne of stuckReady as any[]) {
        const node = allNodes.find((n: any) => (n._id ?? n.id)?.toString() === ne.nodeId?.toString());
        if (!node) continue;
        try {
          this.logger.log(
            `[onNodeCompleted] re-enqueueing stuck ready node nodeExecutionId=${ne._id} nodeId=${ne.nodeId} workflowExecutionId=${workflowExecutionId}`,
          );
          await this.enqueueNode(
            (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
            workflowExecutionId,
            (execution.userId as any)?.toString?.() ?? execution.userId,
            node,
            ne._id.toString(),
            variables,
            allNodes,
          );
        } catch (err: any) {
          this.logger.warn(
            `[onNodeCompleted] re-enqueue stuck ready failed nodeExecutionId=${ne._id}: ${err?.message ?? err}`,
          );
        }
      }

      for (const dep of dependentsToConsider) {
        const depsOfDep = dep.dependencies || [];
        const otherDepsOfDep = depsOfDep.filter((d: any) => (d?.toString?.() ?? String(d)) !== completedNodeId);
        const otherCompletedOfDep = await Promise.all(
          otherDepsOfDep.map((d: any) => {
            const dObj = d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d));
            return this.nodeExecutionModel.findOne({
              workflowExecutionId: executionIdObj,
              nodeId: dObj,
              status: { $in: ['completed', 'skipped'] },
            });
          }),
        );
        const allDepsOfDepCompleted = otherCompletedOfDep.every(Boolean);
        if (!allDepsOfDepCompleted) {
          this.logger.debug(`[onNodeCompleted] skip dependent dep._id=${(dep._id ?? dep.id)?.toString?.()} - not all deps completed`);
          continue;
        }

        const depId = dep._id ?? dep.id;
        const depNodeIdObj = depId instanceof Types.ObjectId ? depId : new Types.ObjectId(String(depId));
        const existingNe = await this.nodeExecutionModel.findOne({
          workflowExecutionId: executionIdObj,
          nodeId: depNodeIdObj,
        });
        if (!existingNe) {
          this.logger.warn(`[onNodeCompleted] no node execution for dependent node ${(depId as any)?.toString?.()}`);
          continue;
        }
        // Enqueue when pending (first time) OR ready (stuck – ensure job is in queue after dependency completed)
        const canEnqueueDep = existingNe.status === 'pending' || existingNe.status === 'ready';
        if (!canEnqueueDep) {
          this.logger.debug(`[onNodeCompleted] skip dependent nodeExecutionId=${existingNe._id} status=${existingNe.status}`);
          continue;
        }

        if ((dep as any)?.type === 'fanout') {
          const inputArrayPath = ((dep as any).parameters?.inputArray ?? (dep as any).parameters?.input_array) as string;
          const initialInstanceName = ((dep as any).parameters?.initialInstanceName ?? (dep as any).parameters?.initial_instance_name) as string || 'initial_instance';
          const batchSize = Math.max(0, parseInt(String((dep as any).parameters?.batchSize ?? (dep as any).parameters?.batch_size ?? 0), 10) || 0);
          const fanoutArray = this.resolveFanoutArrayFromVariables(variables, inputArrayPath);
          this.logger.log(
            `[FANOUT_EXECUTED] workflowExecutionId=${workflowExecutionId} fanoutNodeId=${(depId as any)?.toString?.()} iterations=${fanoutArray.length} batchSize=${batchSize || 'none'} path=${inputArrayPath}`,
          );
          this.logger.log(`[onNodeCompleted] fanout node (scheduler-side): resolved array length=${fanoutArray.length} from path=${inputArrayPath}`);

          await this.nodeExecutionModel.updateOne(
            { _id: existingNe._id },
            { $set: { status: 'completed', endTimeStamp: new Date(), result: { fanout: fanoutArray } } },
          );
          await this.workflowCache.addOutputAsCache(workflowExecutionId, (dep as any).parameters?.variableName ?? 'fanout', fanoutArray);

          const fanoutChildren = allNodes.filter((n: any) =>
            (n.dependencies || []).some((d: any) => (d?.toString?.() ?? String(d)) === (depId as any)?.toString?.()),
          );
          for (const child of fanoutChildren) {
            const isFanoutChild = (child as any)?.isFanoutNode === true;
            if (!isFanoutChild) {
              const childNe = await this.nodeExecutionModel.findOne({
                workflowExecutionId: executionIdObj,
                nodeId: child._id ?? child.id,
              });
              const isPendingOrReady = childNe?.status === 'pending' || childNe?.status === 'ready';
              if (isPendingOrReady) {
                // Only enqueue if ALL dependencies of this child are completed (e.g. Gemini may depend on LOOP + OpenAI)
                const childDeps = child.dependencies || [];
                const allChildDepsCompleted = await Promise.all(
                  childDeps.map((d: any) => {
                    const dObj = d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d));
                    return this.nodeExecutionModel.findOne({
                      workflowExecutionId: executionIdObj,
                      nodeId: dObj,
                      status: { $in: ['completed', 'skipped'] },
                    });
                  }),
                );
                if (!allChildDepsCompleted.every(Boolean)) {
                  this.logger.debug(
                    `[onNodeCompleted] skip fanout child nodeId=${(child._id ?? child.id)?.toString?.()} - not all deps completed`,
                  );
                  continue;
                }
                await this.enqueueNode(
                  (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
                  workflowExecutionId,
                  (execution.userId as any)?.toString?.() ?? execution.userId,
                  child,
                  childNe._id.toString(),
                  variables,
                  allNodes,
                );
                if (childNe.status === 'pending') {
                  await this.nodeExecutionModel.updateOne(
                    { _id: childNe._id },
                    { $set: { status: 'ready', startTimeStamp: new Date() } },
                  );
                }
              }
              continue;
            }
            const childNe = await this.nodeExecutionModel.findOne({
              workflowExecutionId: executionIdObj,
              nodeId: child._id ?? child.id,
            });
            if (!childNe) continue;
            if (fanoutArray.length === 0) {
              this.logger.log(`[onNodeCompleted] fanout array empty: marking fanout child nodeExecutionId=${childNe._id} as skipped`);
              await this.nodeExecutionModel.updateOne(
                { _id: childNe._id },
                { $set: { status: 'skipped', endTimeStamp: new Date(), result: {} } },
              );
              await this.onNodeCompleted({
                workflowExecutionId,
                workflowId: (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
                nodeExecutionId: childNe._id.toString(),
                status: 'skipped',
                returnvalue: {},
              });
              continue;
            }
            const useBatching = batchSize >= 2;
            const batches: unknown[][] = useBatching
              ? (() => {
                  const chunks: unknown[][] = [];
                  for (let s = 0; s < fanoutArray.length; s += batchSize) {
                    chunks.push(fanoutArray.slice(s, s + batchSize));
                  }
                  return chunks;
                })()
              : fanoutArray.map((item) => [item]);
            const totalBatches = batches.length;
            this.workflowCache.setFanoutTotal(workflowExecutionId, childNe._id.toString(), totalBatches);
            await this.workflowCache.setFanoutBatches(workflowExecutionId, childNe._id.toString(), batches);
            for (let bi = 0; bi < batches.length; bi++) {
              const batch = batches[bi] as Record<string, unknown>[];
              const firstItem = batch[0];
              const fanoutVariables: Record<string, unknown> = {
                ...variables,
                [initialInstanceName]: firstItem,
                [`${initialInstanceName}_batch`]: batch,
              };
              await this.enqueueNode(
                (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
                workflowExecutionId,
                (execution.userId as any)?.toString?.() ?? execution.userId,
                child,
                childNe._id.toString(),
                fanoutVariables,
                allNodes,
                `-${bi}`,
                totalBatches,
                bi,
              );
            }
            await this.nodeExecutionModel.updateOne(
              { _id: childNe._id },
              { $set: { status: 'ready', startTimeStamp: new Date() } },
            );
          }
          continue;
        }

        this.logger.log(
          `[onNodeCompleted] enqueue dependent nodeId=${(depId as any)?.toString?.()} type=${dep.type} nodeExecutionId=${existingNe._id} (was ${existingNe.status})`,
        );
        await this.enqueueNode(
          (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
          workflowExecutionId,
          (execution.userId as any)?.toString?.() ?? execution.userId,
          dep,
          existingNe._id.toString(),
          variables,
          allNodes,
        );
        if (existingNe.status === 'pending') {
          await this.nodeExecutionModel.updateOne(
            { _id: existingNe._id },
            { $set: { status: 'ready', startTimeStamp: new Date() } },
          );
        }
      }

      // When an LLM node (e.g. OpenAI) completes, immediately re-enqueue any dependent still 'ready'
      // so the worker picks it up without waiting for the 5s stuck-ready recovery (fixes Gemini running ~1 min late)
      const completedNodeType = (completedNode as any)?.type;
      if (completedNodeType === 'llms' && dependentsToConsider.length > 0) {
        for (const dep of dependentsToConsider) {
          const depId = dep._id ?? dep.id;
          const depNodeIdObj = depId instanceof Types.ObjectId ? depId : new Types.ObjectId(String(depId));
          const ne = await this.nodeExecutionModel.findOne({
            workflowExecutionId: executionIdObj,
            nodeId: depNodeIdObj,
            status: 'ready',
          });
          if (ne) {
            try {
              this.logger.log(
                `[onNodeCompleted] LLM completed: re-enqueue ready dependent nodeId=${(depId as any)?.toString?.()} nodeExecutionId=${ne._id}`,
              );
              await this.enqueueNode(
                (wfId as any)?.toString?.() ?? execution.workflowId?.toString?.() ?? data.workflowId,
                workflowExecutionId,
                (execution.userId as any)?.toString?.() ?? execution.userId,
                dep,
                ne._id.toString(),
                variables,
                allNodes,
              );
            } catch (err: any) {
              this.logger.warn(`[onNodeCompleted] re-enqueue ready dependent failed: ${err?.message ?? err}`);
            }
          }
        }
      }
    }

    // When a node fails, mark only its branch (the failed node + all downstream dependents) as failed; other branches continue.
    if (nodeStatus === 'failed') {
      const downstreamIds = this.getDownstreamNodeIds(completedNodeId, allNodes);
      const branchNodeIdObjs: Types.ObjectId[] = [];
      for (const id of downstreamIds) {
        try {
          branchNodeIdObjs.push(new Types.ObjectId(id));
        } catch {
          // skip invalid id
        }
      }
      const pendingOrReadyInBranch = await this.nodeExecutionModel.find({
        workflowExecutionId: executionIdObj,
        status: { $in: ['pending', 'ready'] },
        nodeId: branchNodeIdObjs.length > 0 ? { $in: branchNodeIdObjs } : { $in: [] },
      });
      for (const ne of pendingOrReadyInBranch) {
        await this.nodeExecutionModel.updateOne(
          { _id: ne._id },
          { $set: { status: 'failed', endTimeStamp: new Date() } },
        );
      }
      this.logger.log(
        `[onNodeCompleted] node failed; marking only branch as failed: failedNodeId=${completedNodeId} downstreamCount=${downstreamIds.size} marked=${pendingOrReadyInBranch.length} workflowExecutionId=${workflowExecutionId}`,
      );
      // Do not set workflow status here; fall through to mark dead branches as skipped and then check allCompleted.
    }

    // When nodes fail, their dependents are never enqueued and stay "pending", so the workflow never completes.
    // Mark any pending node whose all dependencies have terminal status (completed/skipped/failed) as "skipped".
    // Do NOT mark a node if any dependency has status 'completed' – that dependency's completion handler will
    // enqueue this node; marking it here would race with that handler and cause downstream nodes to never run.
    const terminalStatuses = ['completed', 'skipped', 'failed'];
    const considerForSkipStatuses = ['skipped', 'failed']; // only mark when all deps are skipped/failed (dead branch)
    let markedAny = true;
    while (markedAny) {
      markedAny = false;
      const pendingExecutions = await this.nodeExecutionModel
        .find({ workflowExecutionId: executionIdObj, status: 'pending' })
        .lean();
      for (const ne of pendingExecutions as any[]) {
        const node = allNodes.find((n: any) => (n._id ?? n.id)?.toString() === ne.nodeId?.toString());
        const deps = node?.dependencies ?? [];
        if (deps.length === 0) continue;
        const depStatuses = await Promise.all(
          deps.map((d: any) => {
            const dObj = d instanceof Types.ObjectId ? d : new Types.ObjectId(String(d));
            return this.nodeExecutionModel
              .findOne({ workflowExecutionId: executionIdObj, nodeId: dObj })
              .select('status')
              .lean();
          }),
        );
        // Else node whose single dependency is an If that completed (then-branch taken): mark Else as skipped.
        const elseSubType = (node as any)?.nodeMasterId?.metaData?.subType ?? (node as any)?.metaData?.subType;
        const isElseNode = node?.name === 'Else' || (node?.type === 'conditional_node' && elseSubType === 'else');
        if (deps.length === 1 && isElseNode && depStatuses[0] && (depStatuses[0] as any).status === 'completed') {
          await this.nodeExecutionModel.updateOne(
            { _id: ne._id },
            { $set: { status: 'skipped', endTimeStamp: new Date() } },
          );
          this.logger.log(
            `[onNodeCompleted] marked Else node nodeExecutionId=${ne._id} as skipped (If condition was true)`,
          );
          markedAny = true;
          continue;
        }
        // Do NOT mark Else as skipped when its only dependency is If with status 'skipped' (condition false).
        if (deps.length === 1 && isElseNode && depStatuses[0] && (depStatuses[0] as any).status === 'skipped') {
          continue;
        }
        const allDepsTerminal = depStatuses.every(
          (s) => s && terminalStatuses.includes((s as any).status),
        );
        const anyDepCompleted = depStatuses.some((s) => (s as any)?.status === 'completed');
        if (allDepsTerminal && !anyDepCompleted && depStatuses.every((s) => s && considerForSkipStatuses.includes((s as any).status))) {
          await this.nodeExecutionModel.updateOne(
            { _id: ne._id },
            { $set: { status: 'skipped', endTimeStamp: new Date() } },
          );
          this.logger.log(
            `[onNodeCompleted] marked pending nodeExecutionId=${ne._id} as skipped (upstream skipped/failed)`,
          );
          markedAny = true;
        }
      }
    }

    const allNodeExecutions = await this.nodeExecutionModel.find({ workflowExecutionId: executionIdObj }).lean();
    const expectedCount = Array.isArray(execution.nodeExecutions) ? execution.nodeExecutions.length : 0;
    const statusCounts = allNodeExecutions.reduce((acc: Record<string, number>, ne: any) => {
      acc[ne.status] = (acc[ne.status] ?? 0) + 1;
      return acc;
    }, {});
    const allCompleted =
      allNodeExecutions.length > 0 &&
      allNodeExecutions.length === expectedCount &&
      allNodeExecutions.every(
        (ne: any) =>
          ne.status === 'completed' ||
          ne.status === 'skipped' ||
          ne.status === 'failed',
      );
    this.logger.log(
      `[onNodeCompleted] node status counts: ${JSON.stringify(statusCounts)} total=${allNodeExecutions.length} expected=${expectedCount} allCompleted=${allCompleted}`,
    );

    if (allCompleted) {
      const hasFailedNodes = (allNodeExecutions as any[]).some((ne: any) => ne.status === 'failed');
      const finalStatus = hasFailedNodes ? 'failed' : 'completed';
      this.logger.log(
        `[onNodeCompleted] marking workflow ${finalStatus} workflowExecutionId=${workflowExecutionId}`,
      );
      await this.workflowExecutionModel.updateOne(
        { _id: workflowExecutionId },
        {
          $set: {
            status: finalStatus,
            endTimestamp: new Date(),
            variables: this.workflowCache.getVariables(workflowExecutionId),
          },
        },
      );
      this.dynamicQueueManager.closeQueue(workflowExecutionId);
    }
  }
}
