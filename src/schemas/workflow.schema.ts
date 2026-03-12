import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type WorkflowDocument = Workflow & Document;

@Schema({ timestamps: true })
export class Workflow {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'User', required: false })
  userId: mongoose.Types.ObjectId | null;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ type: [mongoose.Types.ObjectId], ref: 'Node' })
  nodes: mongoose.Types.ObjectId[];

  @Prop({ enum: ['published', 'draft', 'unpublished'], default: 'draft' })
  status: string;

  @Prop({ default: false })
  isPrebuilt?: boolean;

  @Prop()
  image?: string;
}

export const WorkflowSchema = SchemaFactory.createForClass(Workflow);
WorkflowSchema.index({ userId: 1 });
WorkflowSchema.index({ isPrebuilt: 1 });
