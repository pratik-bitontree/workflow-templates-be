import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import mongoose, { Document } from 'mongoose';

export type UserSecretsDocument = UserSecrets & Document;

const ConnectedAccountSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
  connectionType: { type: String, enum: ['oauth', 'apikey'], required: true },
  email: String,
  user_name: String,
  isPrimary: { type: Boolean, default: false },
  access_token: String,
  refresh_token: String,
  created_at: Date,
  refresh_token_expire_at: Date,
  api_key: String,
  profile_id: String,
  useOurKey: { type: Boolean, default: false },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

@Schema({ timestamps: true, strict: false })
export class UserSecrets {
  @Prop({ type: mongoose.Types.ObjectId, ref: 'User', unique: true, required: true })
  user_id: mongoose.Types.ObjectId;
  // Dynamic keys for each integration (instantly, hubspot, gmail, gsheets, etc.) as arrays of ConnectedAccount
  [key: string]: unknown;
}

export const UserSecretsSchema = SchemaFactory.createForClass(UserSecrets);
UserSecretsSchema.index({ user_id: 1 });
