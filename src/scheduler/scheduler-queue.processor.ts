import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RunWorkflowService } from './run-workflow.service';

@Processor('scheduler-queue', { concurrency: 1 })
@Injectable()
export class SchedulerQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(SchedulerQueueProcessor.name);

  constructor(private readonly runWorkflow: RunWorkflowService) {
    super();
  }

  async process(job: Job) {
    const data = job.data?.data || job.data;
    this.logger.log(`[scheduler] job id=${job.id} workflowId=${data?.workflowId} workflowExecutionId=${data?.workflowExecutionId} nodes=${data?.nodes?.length ?? 0}`);
    if (!data?.workflowId || !data?.userId) {
      throw new Error('workflowId and userId required');
    }
    const result = await this.runWorkflow.runWorkflow({
      workflowId: data.workflowId,
      userId: data.userId,
      workflowExecutionId: data.workflowExecutionId,
      nodes: data.nodes,
      input: data.input || [],
      startNodeId: data.startNodeId,
      previousExecutionId: data.previousExecutionId,
      previousVariables: data.previousVariables || {},
    });
    this.logger.log(`[scheduler] job id=${job.id} completed result=${JSON.stringify(result)}`);
    return result;
  }
}
