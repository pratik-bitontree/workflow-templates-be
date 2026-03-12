import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RunWorkflowService } from './run-workflow.service';
import { DynamicQueueManager } from './dynamic-queue.manager';

@Processor('nodeCompletionQueue', { concurrency: 10 })
@Injectable()
export class NodeCompletionProcessor extends WorkerHost {
  private readonly logger = new Logger(NodeCompletionProcessor.name);

  constructor(
    @Inject(forwardRef(() => RunWorkflowService)) private readonly runWorkflow: RunWorkflowService,
    @Inject(forwardRef(() => DynamicQueueManager)) private readonly dynamicQueueManager: DynamicQueueManager,
  ) {
    super();
  }

  async process(job: Job) {
    const data = job.data as any;
    this.logger.log(`[nodeCompletion] job id=${job.id} nodeExecutionId=${data?.nodeExecutionId} workflowExecutionId=${data?.workflowExecutionId} source=${data?.source}`);
    if (data.source === 'dynamic') {
      await this.processCompletion(data);
      return;
    }
    if (data.workflowExecutionId && data.nodeExecutionId) {
      await this.processCompletion(data);
      return;
    }
    const { workflowExecutionId } = data;
    if (workflowExecutionId) {
      await this.dynamicQueueManager.enqueueCompletion(workflowExecutionId, data);
    }
  }

  async processCompletion(data: any) {
    await this.runWorkflow.onNodeCompleted({
      workflowExecutionId: data.workflowExecutionId,
      workflowId: data.workflowId,
      nodeExecutionId: data.nodeExecutionId,
      status: data.status || 'completed',
      returnvalue: data.returnvalue,
      conditionalMetadata: data.conditionalMetadata,
    });
  }
}
