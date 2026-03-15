# Local Testing: Calendly to Zoho CRM Automated Contact & Meeting Sync

Steps to run and test the **Calendly to Zoho CRM** template locally with `templates-workflow-BE`.

---

## 1. Prerequisites

- **Node 18+**
- **MongoDB** (e.g. `mongodb://localhost:27017`)
- **Redis** (for BullMQ; e.g. `localhost:6379`)

---

## 2. Environment setup

```bash
cd templates-workflow-BE
cp .env.example .env
```

Edit `.env` and set at least:

```env
# Required for app + queues
MONGODB_URI=mongodb://localhost:27017/templates-workflow
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
PORT=8000

# OAuth base URL (used for redirects and webhook URL)
CONNECT_BASE_URL=http://localhost:8000

# Calendly (create app at https://developer.calendly.com/)
CALENDLY_CLIENT_ID=your_calendly_client_id
CALENDLY_CLIENT_SECRET=your_calendly_client_secret
CALENDLY_REDIRECT_URI=http://localhost:8000/orchestration/calendly/callback

# Zoho CRM (create client at https://api-console.zoho.com/)
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REDIRECT_URI=http://localhost:8000/orchestration/zoho/callback
```

**Calendly:** In the Calendly app settings, set **Redirect URI** to exactly  
`http://localhost:8000/orchestration/calendly/callback`.

**Zoho:** In the Zoho API Console, set the redirect URI to exactly  
`http://localhost:8000/orchestration/zoho/callback`.

---

## 3. Install and seed

```bash
npm install
npm run seed:nodemaster
npm run seed:templates
```

This loads `data/nodemaster.json` and `data/templates.json` (including the Calendly → Zoho template). The template workflow ID is **`6985c684f6f284b9838ea296`**; the trigger node ID is **`6985c684f6f284b9838ea298`**.

---

## 4. Start the backend

```bash
npm run start:dev
```

Server runs at **http://localhost:8000**.  
- API: `http://localhost:8000/api/...`  
- Orchestration (OAuth + webhooks): `http://localhost:8000/orchestration/...`

---

## 5. Connect Calendly and Zoho (test user)

The app uses a default test user when `userId` is omitted: **`000000000000000000000001`**.

### Calendly

1. Open:  
   `http://localhost:8000/orchestration/calendly/login?userId=000000000000000000000001`
2. Sign in with Calendly and authorize. The callback will store tokens in the `usersecrets` collection for that `userId`.

### Zoho

1. Open:  
   `http://localhost:8000/orchestration/zoho/login?userId=000000000000000000000001`
2. Sign in with Zoho and authorize. Tokens are stored for the same test user.

---

## 6. Trigger the workflow

You have two options: **real Calendly webhook** (needs public URL) or **simulated POST** (no Calendly account needed after setup).

### Option A: Simulate Calendly (no public URL)

Send a Calendly-like payload to the trigger endpoint:

```bash
curl -X POST "http://localhost:8000/orchestration/workflow/calendly/trigger-webhook?workflowId=6985c684f6f284b9838ea296&nodeId=6985c684f6f284b9838ea298&userId=000000000000000000000001" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "email": "attendee@example.com",
      "name": "Jane Doe",
      "scheduled_event": {
        "start_time": "2026-03-15T10:00:00Z",
        "end_time": "2026-03-15T10:30:00Z",
        "location": {
          "join_url": "https://meet.example.com/abc123"
        }
      }
    }
  }'
```

Use an **email that exists in your Zoho Contacts** to test the “update” path, or a new email to test the “create” path.

### Option B: Real Calendly webhook (ngrok)

Calendly only sends webhooks to **HTTPS** URLs. To test with real bookings:

1. Install and start [ngrok](https://ngrok.com/):  
   `ngrok http 8000`
2. Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`).
3. In `.env` set:  
   `CONNECT_BASE_URL=https://abc123.ngrok.io`  
   (and optionally `BASE_URL=https://abc123.ngrok.io`).
4. In your Calendly app settings, set redirect URI to:  
   `https://abc123.ngrok.io/orchestration/calendly/callback`  
   and re-do the Calendly login step if needed.
5. Register the webhook with Calendly (e.g. from your frontend or a script that calls the worker’s `registerWebhookForCalendly`) with:  
   `workflowURL = https://abc123.ngrok.io/orchestration/workflow/calendly/trigger-webhook?workflowId=6985c684f6f284b9838ea296&nodeId=6985c684f6f284b9838ea298&userId=000000000000000000000001`  
   and events e.g. `["invitee.created"]`.
6. Create a test event in Calendly and book it; Calendly will POST to that URL and trigger the workflow.

---

## 7. Zoho CRM custom fields

For the template to map meeting data correctly, create these custom fields in Zoho CRM **Contacts** (exact names):

- **Meeting_URL** (single line text)
- **Start_date_Time** (single line text or date-time)
- **End_date_Time** (single line text or date-time)

If these are missing or named differently, create/update contact may fail or skip these fields.

---

## 8. Check execution

- **Logs:** Watch the terminal where `npm run start:dev` is running for scheduler and worker logs.
- **Execution status:** Use your frontend or the relevant API (e.g. execution status/result endpoints) with the `workflowExecutionId` returned by the trigger-webhook response.

---

## Quick reference

| Item        | Value |
|------------|--------|
| Workflow ID | `6985c684f6f284b9838ea296` |
| Trigger node ID | `6985c684f6f284b9838ea298` |
| Test userId | `000000000000000000000001` |
| Trigger URL (local) | `POST http://localhost:8000/orchestration/workflow/calendly/trigger-webhook?workflowId=...&nodeId=...&userId=...` |
| Calendly login | `GET http://localhost:8000/orchestration/calendly/login?userId=000000000000000000000001` |
| Zoho login | `GET http://localhost:8000/orchestration/zoho/login?userId=000000000000000000000001` |
