# Candidate Profile Analyzer – How It Works & Integration Status

## What the Candidate Profile Analyzer Does

The **Candidate Profile Analyzer** is an **agents**-type workflow node that:

1. **Inputs**: For each loop row (candidate), it receives:
   - Resume (URL to PDF/DOCX or text)
   - Job description
   - Company name
   - (Optional) LLM preference (openai, anthropic, perplexity, gemini)

2. **Processing**: It:
   - Extracts text and email from the resume (PDF/DOCX or URL)
   - Calls an LLM with an ATS (Applicant Tracking System) prompt to evaluate fit
   - Produces structured output: `atsResult` (isMatch, matchedSkills, missingSkills, reason) and `email` (to, subject, body for shortlist/rejection)

3. **Output**: Downstream nodes (e.g. “Add a New Column”) expect variables like:
   - `candidate_profile_analyzer.result.atsResult.isMatch`
   - `candidate_profile_analyzer.result.atsResult.matchedSkills`
   - `candidate_profile_analyzer.result.email.to`, `.subject`, `.body`

---

## How It Works in the Monorepo (GrowStack-ai-GrowStackAI-Backend-WorkFlow-Monorepo)

1. **Worker** (`apps/worker`):
   - When the agents node runs, the worker checks **CandidateProfileExecutor.canHandle(inputs)** (inputs have CandidateProfile/Resume + JobDescription + CompanyName).
   - If yes: runs **in-process** via `CandidateProfileExecutor.execute()` (resume extraction + LLM call inside the worker). Returns `{ success, data: { atsResult, email }, status: 'COMPLETED' }` and the node completes with real results.
   - If no: **fallback** – calls the external **GrowStack AI Agent** service (`runAgentUrl`), passing a **webhook** URL. The AI Agent runs the agent and when done POSTs the result to that webhook.

2. **Orchestrator** (`apps/orchestrator`):
   - Exposes **POST /workflow/agent** (public). The AI Agent calls this when an agent run completes.
   - Body must include `data.extras.nodeExecutionId` and `data.extras.workflowExecutionId`.
   - Orchestrator enqueues an **agent-webhook** job.

3. **Scheduler** (`apps/scheduler`):
   - Processes **agent-webhook** jobs: calls `processAgentWebhook(jobData)`.
   - Updates the node execution with the agent result and continues the workflow (enqueues dependents).

4. **GrowStack AI Agent** (`GrowStackAI-Backend-AI-Agent`):
   - Runs the actual agent (e.g. resume parsing + ATS prompt).
   - On completion, calls the **webhook** URL provided in `ctaActions` (orchestrator’s `/workflow/agent`) with payload `{ data: { agentRunData, extras: { nodeExecutionId, workflowExecutionId, webhook } } }`.

So in the monorepo the Candidate Profile Analyzer **either** runs in-process in the worker **or** runs in the AI-Agent service and the result is sent back via webhook.

---

## Current State in templates-workflow-BE (after in-process port)

| Piece | Monorepo | templates-workflow-BE |
|-------|-----------|------------------------|
| **In-process executor** | Yes – `CandidateProfileExecutor` in worker | **Yes** – ported in `src/worker/agent-executor/` |
| **Agent webhook route** | Yes – POST /workflow/agent → enqueueAgentWebhook | **No** – not needed for Candidate Profile Analyzer |
| **Trigger external AI Agent** | Yes – worker calls runAgentUrl with webhook | **No** – not used; agent runs in-process |
| **Agents node behavior** | Runs executor or triggers AI Agent; node gets real result | **Runs executor** – agents nodes use `runAgent` and execute Candidate Profile Analyzer in-process |

So in **templates-workflow-BE** (after port):

- For **agents**-type nodes, the worker resolves to `runAgent` and runs **CandidateProfileExecutor** in-process when inputs have Resume/CandidateProfile + job_description or company_name.
- Resume text is extracted from PDF/DOCX URL via `candidate-profile.extract.ts`; the ATS prompt and LLM call use the worker’s RateLimiter and user/API keys (OpenAI, Anthropic, Perplexity, Gemini).
- The node completes with `result: { atsResult, email }` so downstream nodes (e.g. “Add a New Column”) can resolve `${loop.candidate_profile_analyzer.result.atsResult.isMatch}` etc.
- No webhook or external AI-Agent service is required.

**Dependencies**: `mammoth` and `pdfjs-dist` are used for resume extraction; ensure they are installed (`npm install`).

---

## Alternative: Full webhook integration (not used for Candidate Profile Analyzer)

**Option B – Full webhook integration**  
- Add **POST /orchestration/workflow/agent** (or similar) in templates-workflow-BE that accepts the same payload as the monorepo (`data.extras.nodeExecutionId`, `workflowExecutionId`) and either:
  - Updates the node execution and triggers the scheduler’s “node completed” flow, or
  - Enqueues a job that does the same.
- Ensure the worker, when it does **not** run in-process, calls the **GrowStack AI Agent** with a webhook URL pointing to this templates-workflow-BE endpoint (and that the AI Agent is configured to run the Candidate Profile Analyzer and call that webhook).
- More moving parts (AI-Agent deploy, auth, webhook URL, scheduler/queue for agent-webhook).
