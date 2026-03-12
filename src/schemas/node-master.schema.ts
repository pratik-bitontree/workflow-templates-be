import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NodeMasterDocument = NodeMaster & Document;

@Schema()
export class NodeMaster {
  @Prop({ required: true })
  name: string;
  @Prop()
  description: string;
  @Prop({ required: true })
  type: string;
  @Prop()
  subType: string;
  @Prop({ required: true })
  category: string;
  @Prop()
  subCategory: string;
  @Prop({ required: true })
  functionToExecute: string;
  @Prop()
  logoUrl: string;
  @Prop({ type: [String] })
  dynamicParams: string[];
  @Prop({ type: Object })
  metaData: Record<string, unknown>;
  @Prop({ default: true })
  isVisible: boolean;
}

export const NodeMasterSchema = SchemaFactory.createForClass(NodeMaster);
NodeMasterSchema.index({ type: 1 });
NodeMasterSchema.index({ category: 1 });
