/**
 * Seed node masters from nodemaster.json.
 * Usage: NODEMASTER_PATH=path/to/nodemaster.json npm run seed:nodemaster
 * Default: data/nodemaster.json
 */
/// <reference types="node" />
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/templates-workflow';
const NODEMASTER_PATH = process.env.NODEMASTER_PATH || path.join(__dirname, '../data/nodemaster.json');

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  let raw!: string;
  try {
    raw = fs.readFileSync(NODEMASTER_PATH, 'utf-8');
  } catch {
    console.error('Could not read nodemaster file at', NODEMASTER_PATH);
    console.error('Set NODEMASTER_PATH or place nodemaster.json in data/');
    process.exit(1);
  }

  const items = JSON.parse(raw) as any[];
  const db = mongoose.connection.db;
  if (!db) throw new Error('No db');
  const col = db.collection('nodemasters');

  let count = 0;
  for (const item of items) {
    const _id = item._id ? new mongoose.Types.ObjectId(item._id.toString()) : new mongoose.Types.ObjectId();
    const metaData: Record<string, unknown> = {
      ...(item.parameters && { parameters: item.parameters }),
      ...(item.inputType != null && { inputType: item.inputType }),
      ...(item.version != null && { version: item.version }),
      ...(item.isDeleted != null && { isDeleted: item.isDeleted }),
    };
    await col.updateOne(
      { _id },
      {
        $set: {
          _id,
          name: item.name ?? '',
          description: item.description ?? '',
          type: item.type ?? 'action',
          subType: item.subType ?? undefined,
          category: item.category ?? 'General',
          subCategory: item.subCategory ?? '',
          functionToExecute: item.functionToExecute ?? '',
          logoUrl: item.logoUrl ?? undefined,
          dynamicParams: Array.isArray(item.dynamicParams) ? item.dynamicParams : [],
          metaData: Object.keys(metaData).length ? metaData : {},
          isVisible: item.isVisible !== false,
        },
      },
      { upsert: true },
    );
    count++;
  }

  console.log(`Seeded ${count} node masters`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
