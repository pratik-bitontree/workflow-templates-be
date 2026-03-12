import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { Workflow, WorkflowSchema } from '../schemas/workflow.schema';
import { Node, NodeSchema } from '../schemas/node.schema';
import { WorkflowExecution, WorkflowExecutionSchema } from '../schemas/workflow-execution.schema';
import { NodeExecution, NodeExecutionSchema } from '../schemas/node-execution.schema';
import { NodeMaster, NodeMasterSchema } from '../schemas/node-master.schema';
import { WorkflowCacheModule } from '../workflow-cache/workflow-cache.module';
import { RunWorkflowService } from './run-workflow.service';
import { SchedulerQueueProcessor } from './scheduler-queue.processor';
import { NodeCompletionProcessor } from './node-completion.processor';
import { DynamicQueueManager } from './dynamic-queue.manager';

@Module({
  imports: [
    WorkflowCacheModule,
    BullModule.registerQueue(
      { name: 'scheduler-queue' },
      { name: 'workflowQueue' },
      { name: 'nodeCompletionQueue' },
    ),
    MongooseModule.forFeature([
      { name: Workflow.name, schema: WorkflowSchema },
      { name: Node.name, schema: NodeSchema },
      { name: WorkflowExecution.name, schema: WorkflowExecutionSchema },
      { name: NodeExecution.name, schema: NodeExecutionSchema },
      { name: NodeMaster.name, schema: NodeMasterSchema },
    ]),
  ],
  providers: [
    RunWorkflowService,
    DynamicQueueManager,
    SchedulerQueueProcessor,
    NodeCompletionProcessor,
  ],
  exports: [RunWorkflowService],
})
export class SchedulerModule {}
