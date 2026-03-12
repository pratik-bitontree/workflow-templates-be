import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type NodeExecutionDocument = NodeExecution & Document;

@Schema()
export class NodeExecution {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'Node', required: true })
  nodeId: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Types.ObjectId, ref: 'WorkflowExecution', required: true })
  workflowExecutionId: mongoose.Types.ObjectId;
  @Prop()
  startTimeStamp: Date;
  @Prop()
  endTimeStamp: Date;
  @Prop({ type: Object })
  parameters: Record<string, unknown>;
  @Prop({
    enum: [
      'pending',
      'ready',
      'completed',
      'rejected',
      'skipped',
      'failed',
      'waiting_for_webhook',
    ],
    default: 'pending',
  })
  status: string;
  @Prop({ default: false })
  isFanoutNode: boolean;
  @Prop({ type: [mongoose.Types.ObjectId] })
  dependencies: mongoose.Types.ObjectId[];
  @Prop({ type: [Object] })
  subNodes: Record<string, unknown>[];
  @Prop()
  errorMessage: string;
  @Prop({ type: Object })
  result: Record<string, unknown>;
}

export const NodeExecutionSchema = SchemaFactory.createForClass(NodeExecution);
NodeExecutionSchema.index({ workflowExecutionId: 1 });
NodeExecutionSchema.index({ status: 1 });
