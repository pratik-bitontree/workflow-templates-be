import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type NodeDocument = Node & Document;

@Schema({ _id: true })
export class SubNode {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'NodeMaster', required: true })
  nodeMasterId: mongoose.Types.ObjectId;
  @Prop({ type: Object, required: true })
  parameters: Record<string, unknown>;
  @Prop()
  name: string;
}

@Schema()
export class Node {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'Workflow', required: true })
  workflowId: mongoose.Types.ObjectId;
  @Prop({ type: mongoose.Types.ObjectId, ref: 'Node', required: false })
  parentFanoutNodeId: mongoose.Types.ObjectId | null;
  @Prop()
  name: string;
  @Prop()
  description: string;
  @Prop({ default: false })
  isFanoutNode: boolean;
  @Prop()
  type: string;
  @Prop({ type: Object })
  position: { x: number; y: number };
  @Prop({ type: mongoose.Types.ObjectId, ref: 'NodeMaster', required: true })
  nodeMasterId: mongoose.Types.ObjectId;
  @Prop({ type: Object })
  parameters: Record<string, unknown>;
  @Prop({ type: [mongoose.Types.ObjectId], default: [] })
  dependencies: mongoose.Types.ObjectId[];
  @Prop({ type: mongoose.Types.ObjectId, ref: 'Node', default: null })
  nextNodeId: mongoose.Types.ObjectId | null;
  @Prop({ type: [Object], default: [] })
  subNodes: SubNode[];
  @Prop({ default: 0 })
  version: number;
}

export const NodeSchema = SchemaFactory.createForClass(Node);
NodeSchema.index({ workflowId: 1 });
