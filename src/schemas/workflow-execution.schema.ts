import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type WorkflowExecutionDocument = WorkflowExecution & Document;

@Schema({ timestamps: true })
export class WorkflowExecution {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'Workflow', required: true })
  workflowId: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Types.ObjectId, required: true })
  userId: mongoose.Types.ObjectId;
  @Prop({ required: true })
  startTimestamp: Date;
  @Prop()
  endTimestamp: Date;
  @Prop({ type: [Object], default: [] })
  input: Record<string, unknown>[];
  @Prop({ type: Object, default: {} })
  variables: Record<string, unknown>;
  @Prop({ type: [mongoose.Types.ObjectId], ref: 'NodeExecution', default: [] })
  nodeExecutions: mongoose.Types.ObjectId[];
  @Prop()
  errorMessage: string;
  @Prop({
    enum: ['pending', 'in-progress', 'completed', 'failed', 'stopped', 'partially-completed'],
    default: 'pending',
  })
  status: string;
  @Prop({ default: false })
  isScheduled: boolean;
  @Prop()
  traceId: string;
}

export const WorkflowExecutionSchema = SchemaFactory.createForClass(WorkflowExecution);
WorkflowExecutionSchema.index({ userId: 1 });
WorkflowExecutionSchema.index({ workflowId: 1 });
WorkflowExecutionSchema.index({ status: 1 });
