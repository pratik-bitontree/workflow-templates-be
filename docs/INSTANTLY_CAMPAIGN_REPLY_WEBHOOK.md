# Instantly Campaign Reply Alert & Auto-Responder – Webhook for Local Testing

This doc describes how to trigger the **Campaign Reply Alert & Auto-Responder (Instantly)** workflow via the Instantly trigger webhook when running templates-workflow-BE locally.

## Webhook endpoint (templates-workflow-BE)

- **Method:** `POST`
- **Path:** `/orchestration/workflow/instantly/trigger-webhook`
- **Query params (required):**
  - `workflowId` – ID of the duplicated workflow (from DB / frontend after duplication)
  - `nodeId` – ID of the **Trigger Request** (campaign) node in that workflow
  - `userId` – User ID that owns the workflow and has Instantly connected

**Full URL shape (same pattern as Calendly):**

```text
{BASE_URL}/orchestration/workflow/instantly/trigger-webhook?workflowId={WORKFLOW_ID}&nodeId={NODE_ID}&userId={USER_ID}
```

**Calendly (testing) – same pattern:**

```text
https://testing.growstack.ai/orchestration/workflow/calendly/trigger-webhook?workflowId=698d7c864d474c1e5cfc89e9&nodeId=698d7c864d474c1e5cfc89eb&userId=670c9a980d60217abe9c36b0
```

**Instantly – local (same structure, different host and path segment):**

```text
http://localhost:8000/orchestration/workflow/instantly/trigger-webhook?workflowId=698d7c864d474c1e5cfc89e9&nodeId=698d7c864d474c1e5cfc89eb&userId=670c9a980d60217abe9c36b0
```

Use your real `workflowId`, `nodeId`, and `userId` from the duplicated Instantly Campaign Reply workflow. For local templates-workflow-BE, base URL is `http://localhost:8000` (or your `BASE_URL`).

- **Body:** JSON payload that Instantly sends when a lead replies (or a matching test payload). This is passed to the workflow as the `trigger` variable.

## Example payload (Instantly reply webhook)

Instantly sends a reply webhook with fields such as `email_id`, `email_account`, `reply_text_snippet`, `reply_subject`, etc. For **local testing** you can POST a minimal body that matches what the workflow nodes expect.

Minimal example for local testing:

```json
{
  "email_id": "test-email-uuid-123",
  "email_account": "your-instantly-account-id",
  "reply_subject": "Re: Your outreach",
  "reply_text_snippet": "Yes, we'd like to learn more. Can we schedule a call next week?"
}
```

The workflow uses in particular:

- `trigger.email_id` → Reply-to-email node (`emailId`)
- `trigger.email_account` → Reply-to-email node (`eaccount`)
- `trigger.reply_subject` → Reply-to-email node (`subject`)
- `trigger.reply_text_snippet` → Intent segregation + reply body generation

## cURL example (local)

Replace `YOUR_WORKFLOW_ID`, `YOUR_TRIGGER_NODE_ID`, and `YOUR_USER_ID` with the values from your duplicated workflow and user.

```bash
curl -X POST "http://localhost:8000/orchestration/workflow/instantly/trigger-webhook?workflowId=YOUR_WORKFLOW_ID&nodeId=YOUR_TRIGGER_NODE_ID&userId=YOUR_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "email_id": "test-email-uuid-123",
    "email_account": "your-instantly-account-id",
    "reply_subject": "Re: Your outreach",
    "reply_text_snippet": "Yes, we would like to schedule a call. When are you available?"
  }'
```

Expected response (200):

```json
{
  "workflowExecutionId": "...",
  "messageId": "...",
  "accepted": true
}
```

## Getting workflowId and nodeId

1. **Duplicate** the “Campaign Reply Alert & Auto-Responder (Instantly)” template in the frontend (or create execution via API).
2. **workflowId** = the duplicated workflow’s `_id`.
3. **nodeId** = the first node’s `_id` (the “Trigger Request” campaign node) from that workflow’s `nodes` array.
4. **userId** = the user who owns the workflow and has Instantly connected in Integration Hub.

## Frontend: passing the webhook URL for this template

When you use this template with **GrowStackAI-Frontend**:

1. For the **Campaign Reply** workflow, the UI treats it as a webhook workflow and stores the **Trigger URL** in `localStorage` under the key `instantly_trigger_url`.
2. The trigger URL is built as:  
   `{ORCHESTRATION_BASE_URL}/orchestration/workflow/instantly/trigger-webhook?workflowId={workflowId}&nodeId={nodeId}&userId={userId}`  
   using the duplicated workflow’s IDs and the current user.
3. To test against **local templates-workflow-BE**, set your frontend (or env) so that the orchestration API base URL is `http://localhost:8000`. The same trigger URL will then point to your local backend.
4. You can paste or edit the **Trigger URL** in the form for the **dependent (registration) workflow** that configures the Instantly webhook; that URL is what Instantly will call when a reply is received.

## Why you get 404 on "Reply to an Email"

The **Reply to an Email** node calls Instantly's `POST /api/v2/emails/reply`. Instantly looks up the email by `reply_to_uuid` (your `email_id`) and the sending account by `eaccount` (your `email_account`). If either doesn't exist in their system, the API returns **404**.

When you test with a **fake payload** (e.g. `email_id: "test-email-uuid-123"`, `email_account: "your-instantly-account-id"`), those IDs are not real in Instantly, so you will always get 404. That's expected.

To get a **successful** reply: use **real** `email_id` and `email_account` from an actual Instantly reply webhook (when a lead replies in a campaign), or run an end-to-end test with the webhook configured in Instantly so the workflow receives real IDs. Until then, the workflow will run through intent, reply body, and HTML; only the final "Reply to an Email" call fails with 404 when using test data.

## Environment (templates-workflow-BE)

- `BASE_URL` or `CONNECT_BASE_URL`: e.g. `http://localhost:8000` for local. Used when building the trigger URL in “Create Instantly Webhook” if the node does not receive an explicit URL (e.g. from the frontend).
- Instantly API key must be connected in Integration Hub for the given `userId` so that “Reply to an Email” and webhook creation work.
