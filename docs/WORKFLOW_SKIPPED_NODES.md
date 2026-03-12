# Why Some Nodes Show as "Skipped" (e.g. Send Email, Convert Text to PDF)

## What "skipped" means

A node is marked **skipped** when:

1. It was never enqueued (never ran), and  
2. All of its **dependency** nodes have already reached a terminal status (`completed`, `skipped`, or `failed`).

So "skipped" = "this node was on a path that was never taken" or "this node was never triggered because the graph didn’t lead to it."

## Why Send Email (and Convert Text to PDF) are skipped on the APA branch

In **Student Research Automation** with citation style **APA**:

- **Form** → **If (APA)** → **Perplexity (APA)** run and complete.
- **Convert Text to PDF** and **Send Email** show as **skipped**.

That happens because the executor only runs a node when **all of its dependencies have finished**. The next node is chosen by:

- Finding all nodes whose `dependencies` array **includes the ID of the node that just completed**.

So after the **APA Perplexity** node completes, only nodes that list that Perplexity node as a dependency will be enqueued. If **Convert Text to PDF** and **Send Email** do **not** have the APA Perplexity node in their `dependencies`, they are never enqueued. They stay `pending` until the run finishes, then they are marked **skipped** as “pending nodes whose dependencies are all terminal.”

So the issue is **workflow graph / template design**: the APA branch is not wired so that Convert PDF and Send Email depend on the APA Perplexity node.

## How to fix it

In your **workflow/template editor** (where you define nodes and edges):

1. For the **APA** path, ensure the chain is:
   - **Perplexity (APA)** → **Convert Text to PDF** → **Send Email**
2. So that:
   - **Convert Text to PDF** has the **APA Perplexity** node as a dependency.
   - **Send Email** has **Convert Text to PDF** (or the appropriate node before it) as a dependency.

Same idea for other citation branches (MLA, Chicago, etc.): the “Convert Text to PDF” and “Send Email” nodes for that branch must have the correct **Perplexity** (or previous) node in their `dependencies` so they get enqueued after the LLM step completes.

The backend logic that marks nodes as skipped lives in `src/scheduler/run-workflow.service.ts` (see "Mark any pending node whose all dependencies have terminal status as skipped").

## Convert Text to PDF must run after the research-paper LLM, not after Anthropic

**Problem:** If the workflow had Convert Text to PDF depending on Anthropic, it would run after Anthropic and could receive the wrong (short) content instead of the full research paper from Perplexity.

**Backend fix (already in place):**

1. **`run-workflow.service.ts`** — When the completed node is **Anthropic** (`processTextAnthropic`), the scheduler does **not** enqueue **Convert Text to PDF** as a dependent. So Convert Text to PDF is never triggered by Anthropic completing; it only runs when a different upstream node (e.g. Perplexity) completes.

2. **`action.service.ts` (convertTextToPdf)** — If the resolved `textInput` is empty or very short (< 100 chars), the action service tries to use the first available research-paper variable (`apa_research_paper_generation`, `mla_research_paper_generation`, etc.) from the workflow cache so the PDF is generated from the correct content.

**Template requirement:** In the workflow graph, **Convert Text to PDF** must have the **paper-generating node** (e.g. Perplexity for APA) in its `dependencies`, and its `textInput` param should reference that node's output (e.g. `${apa_research_paper_generation.content}`). Then Convert Text to PDF runs after that LLM and receives the right content. “Mark any pending node whose all dependencies have terminal status as skipped”).
