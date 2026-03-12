import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BullModule } from '@nestjs/bullmq';
import { WorkflowController, ExecutionController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { SCHEDULER_QUEUE_NAME } from './workflow.service';
import { Workflow, WorkflowSchema } from '../schemas/workflow.schema';
import { Node, NodeSchema } from '../schemas/node.schema';
import { WorkflowExecution, WorkflowExecutionSchema } from '../schemas/workflow-execution.schema';
import { NodeExecution, NodeExecutionSchema } from '../schemas/node-execution.schema';
import { NodeMaster, NodeMasterSchema } from '../schemas/node-master.schema';

@Module({
  imports: [
    BullModule.registerQueue({ name: SCHEDULER_QUEUE_NAME }),
    MongooseModule.forFeature([
      { name: Workflow.name, schema: WorkflowSchema },
      { name: Node.name, schema: NodeSchema },
      { name: WorkflowExecution.name, schema: WorkflowExecutionSchema },
      { name: NodeExecution.name, schema: NodeExecutionSchema },
      { name: NodeMaster.name, schema: NodeMasterSchema },
    ]),
  ],
  controllers: [WorkflowController, ExecutionController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
