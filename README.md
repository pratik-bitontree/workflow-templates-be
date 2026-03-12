# Templates Workflow BE (Monolithic)

Same flow as Orchestrator → Scheduler → Worker → WCS in a **single process**.

## Requirements

- Node 18+
- MongoDB (local)
- Redis (for BullMQ queues)

## Setup

```bash
cp .env.example .env
# Edit .env: MONGODB_URI, REDIS_HOST, PORT
npm install
```

## Seed templates

Copy `templates.json` (from the workflow monorepo `apps/orchestrator/data/templates.json`) into `data/templates.json`, then:

```bash
npm run seed
```

Or point to a path:

```bash
TEMPLATES_PATH=/path/to/templates.json npm run seed
```

## Run

```bash
npm run start:dev
```

Server runs on `PORT` (default 3000). Base path: `/api`.

## API

- **Workflow**: `GET /api/workflow`, `GET /api/workflow/:id`, `POST /api/workflow/create-execution`
- **Execution**: `GET /api/executions/:id` (node-wise output), `GET /api/workflow/:id/status/:workflowExecutionId`
- **Integration Hub**: `GET /api/integration-hub/integrations/categories`, `GET /api/integration-hub/integrations/details`, `GET /api/integration-hub/integrations/connectedAccounts`, `POST /api/integration-hub/integrations/setPrimaryAccount`, `POST /api/integration-hub/integrations/PostLogActivity`, `GET /api/integration-hub/integrations/getActivityLogs`
- **WCS** (internal): `POST /api/workflow-cache/execution-table`, `POST /api/workflow-cache/output`, `GET /api/workflow-cache/entries/:workflowExecutionId`

## Flow

1. FE calls `POST /api/workflow/create-execution` (workflowId, input, userId).
2. App creates WorkflowExecution and enqueues to **scheduler-queue**.
3. **Scheduler** consumes the job, runs runWorkflow: creates NodeExecutions, WCS table, dynamic node-completion queue, enqueues ready nodes to **workflowQueue**.
4. **Worker** consumes workflowQueue, executes node (form / stub integration), writes to WCS, enqueues to **nodeCompletionQueue**.
5. **Scheduler** node-completion: routes to dynamic queue, on completion updates NodeExecution, enqueues next ready nodes to workflowQueue. When all done, marks execution completed.
