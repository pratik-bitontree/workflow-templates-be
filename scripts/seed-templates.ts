/**
 * Seed workflows and nodes from templates.json.
 * Usage: TEMPLATES_PATH=path/to/templates.json npm run seed
 * Default: data/templates.json
 */
/// <reference types="node" />
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/templates-workflow';
const TEMPLATES_PATH = process.env.TEMPLATES_PATH || path.join(__dirname, '../data/templates.json');

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  let raw!: string;
  try {
    raw = fs.readFileSync(TEMPLATES_PATH, 'utf-8');
  } catch {
    console.error('Could not read templates file at', TEMPLATES_PATH);
    console.error('Set TEMPLATES_PATH or place templates.json in data/');
    process.exit(1);
  }

  const templates = JSON.parse(raw) as any[];
  const db = mongoose.connection.db;
  if (!db) throw new Error('No db');
  const workflowsCol = db.collection('workflows');
  const nodesCol = db.collection('nodes');

  let workflowCount = 0;
  let nodeCount = 0;

  for (const wf of templates) {
    const workflowId = wf._id?.toString?.() || new mongoose.Types.ObjectId().toString();
    const nodeIds: mongoose.Types.ObjectId[] = [];
    const nodes = wf.nodes || [];

    for (const n of nodes) {
      const nodeId = n._id?.toString?.() || new mongoose.Types.ObjectId().toString();
      const depIds = (n.dependencies || []).map((d: any) =>
        typeof d === 'string' ? new mongoose.Types.ObjectId(d) : d,
      );
      await nodesCol.updateOne(
        { _id: new mongoose.Types.ObjectId(nodeId) },
        {
          $set: {
            _id: new mongoose.Types.ObjectId(nodeId),
            workflowId: new mongoose.Types.ObjectId(workflowId),
            parentFanoutNodeId: n.parentFanoutNodeId ? new mongoose.Types.ObjectId(n.parentFanoutNodeId) : null,
            name: n.name,
            description: n.description || '',
            isFanoutNode: n.isFanoutNode || false,
            type: n.type || 'action',
            position: n.position || { x: 0, y: 0 },
            nodeMasterId: new mongoose.Types.ObjectId(n.nodeMasterId?.toString?.() || '674021051cbd6d2a82e939f5'),
            parameters: n.parameters || {},
            dependencies: depIds,
            nextNodeId: n.nextNodeId ? new mongoose.Types.ObjectId(n.nextNodeId) : null,
            subNodes: n.subNodes || [],
            version: n.version ?? 0,
          },
        },
        { upsert: true },
      );
      nodeIds.push(new mongoose.Types.ObjectId(nodeId));
      nodeCount++;
    }

    await workflowsCol.updateOne(
      { _id: new mongoose.Types.ObjectId(workflowId) },
      {
        $set: {
          _id: new mongoose.Types.ObjectId(workflowId),
          userId: wf.userId ? new mongoose.Types.ObjectId(wf.userId) : null,
          name: wf.name,
          description: wf.description || '',
          nodes: nodeIds,
          status: wf.status || 'draft',
          isPrebuilt: wf.isPrebuilt ?? true,
          image: wf.image,
        },
      },
      { upsert: true },
    );
    workflowCount++;
  }

  console.log(`Seeded ${workflowCount} workflows and ${nodeCount} nodes`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
