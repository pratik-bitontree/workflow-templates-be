import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { RunWorkflowService } from './run-workflow.service';
import { NodeCompletionProcessor } from './node-completion.processor';

const getRedisConnection = (config: ConfigService) => ({
  host: config.get('REDIS_HOST', 'localhost'),
  port: config.get('REDIS_PORT', 6379),
  password: config.get('REDIS_PASSWORD') || undefined,
  db: config.get('REDIS_DB', 0),
  maxRetriesPerRequest: null,
});

@Injectable()
export class DynamicQueueManager {
  private readonly queues = new Map<string, { queue: Queue; worker: Worker }>();
  private readonly connectionOptions: ReturnType<typeof getRedisConnection>;

  constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => RunWorkflowService)) private readonly runWorkflow: RunWorkflowService,
    @Inject(forwardRef(() => NodeCompletionProcessor)) private readonly nodeCompletion: NodeCompletionProcessor,
  ) {
    this.connectionOptions = getRedisConnection(config);
  }

  async createQueueForExecution(workflowExecutionId: string) {
    if (this.queues.has(workflowExecutionId)) return;
    const name = `nodeCompletionQueue-${workflowExecutionId}`;
    const queue = new Queue(name, { connection: this.connectionOptions });
    const worker = new Worker(
      name,
      async (job) => {
        await this.nodeCompletion.processCompletion(job.data);
      },
      { connection: this.connectionOptions, concurrency: 1 },
    );
    this.queues.set(workflowExecutionId, { queue, worker });
  }

  async enqueueCompletion(workflowExecutionId: string, data: any) {
    let entry = this.queues.get(workflowExecutionId);
    if (!entry) {
      await this.createQueueForExecution(workflowExecutionId);
      entry = this.queues.get(workflowExecutionId);
    }
    if (entry) {
      await entry.queue.add('node-completion', { ...data, source: 'dynamic' }, { removeOnComplete: true });
    }
  }

  closeQueue(workflowExecutionId: string) {
    const entry = this.queues.get(workflowExecutionId);
    if (entry) {
      entry.worker.close();
      this.queues.delete(workflowExecutionId);
    }
  }
}
