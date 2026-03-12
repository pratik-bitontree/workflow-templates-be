import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ActivityLogDocument = ActivityLog & Document;

@Schema({ timestamps: true, collection: 'userIntegration-activity-logs' })
export class ActivityLog {
  @Prop({ required: true, index: true })
  userId: string;
  @Prop({ required: true, index: true })
  action: string;
  @Prop({ required: true, index: true })
  integration: string;
  @Prop()
  accountEmail: string;
  @Prop()
  accountId: string;
  @Prop()
  details: string;
  @Prop({ type: Object })
  metadata: Record<string, unknown>;
}

export const ActivityLogSchema = SchemaFactory.createForClass(ActivityLog);
ActivityLogSchema.index({ userId: 1, createdAt: -1 });
