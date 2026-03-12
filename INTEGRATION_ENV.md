# Integration env vars for template nodes

This doc lists what to add in `.env` for **integrations used in templates** (OAuth + API keys for LLMs and others).

**→ Step-by-step OAuth setup (how to generate Client ID & Secret for each provider):** see [docs/OAUTH_SETUP_GUIDE.md](docs/OAUTH_SETUP_GUIDE.md).

## Integrations used in templates (from Integration Hub)

| Integration   | Auth type | Env vars to add |
|---------------|-----------|------------------|
| **Gmail**     | OAuth     | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, redirect URI |
| **Google Calendar** | OAuth | Same Google app: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Google Sheets**   | OAuth | Same Google app: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **HubSpot**   | OAuth     | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`, `HUBSPOT_API_URL`, `HUBSPOT_APP_URL` |
| **Instantly** | API key  | Per-user in UserSecrets, or system `INSTANTLY_API_KEY` if you support it |
| **Calendly**  | OAuth     | `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET` |
| **Zoho**      | OAuth     | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` |
| **Vercel**    | OAuth/API | `VERCEL_API_URL` (and token from OAuth or env if needed) |
| **OpenAI**    | API key  | `OPEN_AI_SECRET_KEY` (or per-user in UserSecrets) |
| **Anthropic** | API key  | `ANTHROPIC_API_KEY` |
| **Gemini**    | API key  | `GEMINI_API_KEY` |
| **Firecrawl** | API key  | `FIRECRAWL_API_KEY` |

## Where to put them

- **OAuth (client ID + secret)**  
  Add in the app that runs the “Connect account” flow. If users connect Gmail/HubSpot/etc. from **templates-workflow-BE** `.env`. This repo runs the Connect flow on port 8000 (no separate user service).

- **API keys (LLMs and others)**  
  - **System default:** add in the app that **executes** the node (e.g. `OPEN_AI_SECRET_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `FIRECRAWL_API_KEY` in templates-workflow-BE or in the monorepo worker, depending on where template jobs run).  
  - **Per-user:** store in UserSecrets (no env needed for the key itself; only for the service that writes/reads UserSecrets).

- **This repo (templates-workflow-BE)**  
  There is no separate user service. The backend runs on **localhost:8000** only. Put OAuth credentials and API keys in this repo's `.env` (see `.env.example`).

## Quick checklist for “nodes used in templates only”

1. **OAuth (only for integrations you use in templates)**  
   - Google (Gmail, Calendar, Sheets): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (+ redirect URI).  
   - HubSpot: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`, `HUBSPOT_API_URL`, `HUBSPOT_APP_URL`.  
   - Calendly: `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`.  
   - Zoho: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`.  
   - Vercel: `VERCEL_API_URL` (and token/OAuth as per your flow).

2. **API keys – LLMs**  
   - `OPEN_AI_SECRET_KEY`  
   - `ANTHROPIC_API_KEY`  
   - `GEMINI_API_KEY`

3. **API keys – other**  
   - `FIRECRAWL_API_KEY`  
   - Instantly: per-user in UserSecrets or `INSTANTLY_API_KEY` if you use a system key.

Use `.env.example` in this repo as the reference; copy to `.env` and fill only what you need for the template nodes you actually use.
