# OAuth client ID & secret setup guide

Step-by-step instructions to create your own OAuth apps and get **Client ID** and **Client Secret** for each integration used in templates. Use these values in your `.env` in **templates-workflow-BE** (this repo runs the Connect flow on port 8000; no separate user service).

**Redirect URI rule:** Use your actual backend base URL. This repo has no separate user service — the backend runs on **localhost:8000** only. Examples: production `https://api.yourdomain.com`, local `http://localhost:8000`.

---

## 1. Google (Gmail, Calendar, Sheets, Slides)

One OAuth app covers Gmail, Google Calendar, Google Sheets, and Google Slides.

### Steps

1. **Open Google Cloud Console**  
   - Go to [https://console.cloud.google.com](https://console.cloud.google.com)

2. **Create or select a project**  
   - Top bar: click the project dropdown → **New Project** (e.g. "Workflow Integrations") → Create  
   - Or select an existing project.

3. **Enable APIs**  
   - **APIs & Services** → **Library**  
   - Enable:
     - **Gmail API**
     - **Google Calendar API**
     - **Google Sheets API**
     - **Google Slides API** (if you use Slides)
     - **Google Drive API** (often needed for Sheets/Drive)

4. **Configure OAuth consent screen**  
   - **APIs & Services** → **OAuth consent screen**  
   - **User Type:** External (for multiple users) or Internal (Google Workspace only)  
   - **App name:** e.g. "My Workflow App"  
   - **User support email:** your email  
   - **Developer contact:** your email  
   - **Scopes:** Add (or add later when testing):
     - `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`, `https://www.googleapis.com/auth/calendar.events`
     - `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive.file`
     - `https://www.googleapis.com/auth/presentations` (if using Slides)  
   - Save.

5. **Create OAuth client credentials**  
   - **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**  
   - **Application type:** Web application  
   - **Name:** e.g. "Workflow Backend"  

   **Authorized JavaScript origins** (for use with requests from a browser — no path, no trailing slash):
   | Environment | URI to add |
   |-------------|------------|
   | Local       | `http://localhost:3000` *(or the port where your frontend runs)* |
   | Local (backend) | `http://localhost:8000` *(backend that serves OAuth)* |
   | Production  | `https://app.yourdomain.com` *(your frontend domain)* |
   | Production  | `https://api.yourdomain.com` *(if the page that starts OAuth is on the API)* |

   **Authorized redirect URIs** (for use with requests from a web server — full callback URL):
   | Environment | URI to add |
   |-------------|------------|
   | Local       | `http://localhost:8000/orchestration/google/callback` |
   | Production  | `https://api.yourdomain.com/orchestration/google/callback` |

   Add at least one JavaScript origin (e.g. `http://localhost:3000` and `http://localhost:8000` for local) and both redirect URIs above. Then Create → copy **Client ID** and **Client secret**.

6. **Add to `.env`**

```env
GOOGLE_CLIENT_ID=your-xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/orchestration/google/callback
```

Use **exactly** the same redirect URI in `.env` as in Google Cloud Console (no trailing slash).

---

### Fixing "Access blocked: Authorization Error" (400 invalid_request)

If Google shows **"Access blocked: Authorization Error"** or **"Error 400: invalid_request"** and says the app doesn't comply with OAuth 2.0 policy:

1. **Redirect URI must match exactly**
   - In **Google Cloud Console** → **APIs & Services** → **Credentials** → your OAuth 2.0 Client ID → **Authorized redirect URIs** add:
     - `http://localhost:8000/orchestration/google/callback` (no trailing slash, exact path).
   - In **templates-workflow-BE** `.env` set:
     - `GOOGLE_REDIRECT_URI=http://localhost:8000/orchestration/google/callback` (same string).
   - If your backend runs on a different port or host, use that base (e.g. `http://127.0.0.1:8000/...`) in **both** places.

2. **OAuth consent screen: Testing mode**
   - **APIs & Services** → **OAuth consent screen**.
   - For local development leave **Publishing status** as **Testing**.
   - Under **Test users** add the Google account(s) you use to sign in. Only these accounts can sign in while the app is in Testing.

3. **Application type**
   - Credentials must be **Web application** (not Desktop or other).
   - **Authorized JavaScript origins** should include `http://localhost:8000` and `http://localhost:3000` if the frontend opens the popup from 3000.

4. **Save and wait**
   - After changing redirect URIs or test users in Google Cloud Console, wait a minute and try again.

---

## 2. HubSpot

### Steps

1. **Go to HubSpot Developer**  
   - [https://developers.hubspot.com](https://developers.hubspot.com)  
   - Sign in with a HubSpot account (or create one).

2. **Create an app**  
   - **Apps** → **Create app** → **Create private app** (or **Create app** for a custom app)  
   - **Name:** e.g. "Workflow Integration"

3. **Configure OAuth (for custom/public app)**  
   - In the app: **Auth** tab  
   - **Redirect URL:**  
     - Production: `https://api.yourdomain.com/orchestration/hubspot/auth/callback`  
     - Local: `http://localhost:8000/orchestration/hubspot/auth/callback`  
   - **Scopes:** select what you need, e.g.  
     - `crm.objects.contacts.read`, `crm.objects.contacts.write`  
     - `crm.objects.deals.read`, `crm.objects.deals.write`  
     - `calendar`, `sales-email-read`, `tickets`  
   - Save.

4. **Get credentials**  
   - **Auth** tab: copy **Client ID** and **Client secret**  
   - **App ID** is in the app URL or app settings (e.g. `12345678`).

5. **Add to `.env`**

```env
HUBSPOT_CLIENT_ID=your-client-id
HUBSPOT_CLIENT_SECRET=your-client-secret
HUBSPOT_APP_ID=your-app-id
HUBSPOT_API_URL=https://api.hubapi.com
HUBSPOT_APP_URL=https://app.hubspot.com
```

**Note:** For **private apps**, HubSpot uses an **access token** only (no OAuth flow). If you use a private app, store the token per user in UserSecrets and you don’t need client ID/secret for that flow.

---

## 3. Calendly

### Steps

1. **Go to Calendly Developer**  
   - [https://developer.calendly.com](https://developer.calendly.com)  
   - Sign in.

2. **Create an application**  
   - **My applications** → **Create application**  
   - **Application name:** e.g. "Workflow Integration"  
   - **Redirect URI:**  
     - Production: `https://api.yourdomain.com/orchestration/calendly/callback`  
     - Local: `http://localhost:8000/orchestration/calendly/callback`  
   - **Organization URI:** your site or company URL  
   - Create.

3. **Get credentials**  
   - On the app page you’ll see **Client ID** and **Client secret**  
   - Copy both.

4. **Add to `.env`**

```env
CALENDLY_CLIENT_ID=your-client-id
CALENDLY_CLIENT_SECRET=your-client-secret
```

---

## 4. Zoho

Zoho uses different OAuth servers per region (US, EU, IN, etc.). Use the one that matches your Zoho data center.

### Steps

1. **Go to Zoho API Console**  
   - [https://api-console.zoho.com](https://api-console.zoho.com) (or `.zoho.eu`, `.zoho.in`, etc. for your region)

2. **Add a client**  
   - **Add Client** → **Server-based Applications**  
   - **Client Name:** e.g. "Workflow Integration"  
   - **Homepage URL:** your app URL, e.g. `https://app.yourdomain.com`  
   - **Authorized Redirect URIs:**  
     - Production: `https://api.yourdomain.com/orchestration/zoho/callback`  
     - Local: `http://localhost:8000/orchestration/zoho/callback`  
   - Create.

3. **Get credentials**  
   - You’ll get **Client ID** and **Client Secret**  
   - Copy both.

4. **Add to `.env`**

```env
ZOHO_CLIENT_ID=your-client-id
ZOHO_CLIENT_SECRET=your-client-secret
```

**Note:** Your backend must use the same Zoho region (e.g. `accounts.zoho.com`, `accounts.zoho.eu`) in the auth/token URLs; the monorepo `server.config` already defines these per region.

---

## 5. Vercel

Vercel supports both OAuth (for “Login with Vercel”) and **API tokens** (for deployment/project APIs). For workflow integrations you usually use an **API token** or OAuth depending on whether users connect their own Vercel account.

### Option A: OAuth (user connects their Vercel account)

1. **Go to Vercel Integrations**  
   - [https://vercel.com/account/integrations](https://vercel.com/account/integrations)  
   - Or **Dashboard** → **Settings** → **Integrations** → create an OAuth app if available.

2. **Create OAuth application**  
   - Vercel’s OAuth is often done via “Integrations” or developer docs: [https://vercel.com/docs/rest-api](https://vercel.com/docs/rest-api)  
   - **Callback URL:**  
     - Production: `https://api.yourdomain.com/orchestration/vercel/callback`  
     - Local: `http://localhost:8000/orchestration/vercel/callback`  
   - Copy **Client ID** and **Client Secret** if the flow is OAuth.

3. **Add to `.env`** (if using OAuth)

```env
VERCEL_CLIENT_ID=your-client-id
VERCEL_CLIENT_SECRET=your-client-secret
VERCEL_API_URL=https://api.vercel.com
```

### Option B: API token only (single account / server-to-server)

1. **Vercel Dashboard** → **Settings** → **Tokens**  
2. **Create** → name e.g. "Workflow" → copy the token.  
3. Store the token in UserSecrets (per user) or in a single env var if one Vercel account is used for all:

```env
VERCEL_API_TOKEN=your-token
VERCEL_API_URL=https://api.vercel.com
```

Use whichever (OAuth or token) matches your backend implementation.

---

## Redirect URI quick reference

Use the **exact** redirect URIs you register in each provider. For local dev use `http://localhost:8000` (this repo has no separate user service). Production: your API base (e.g. `https://api.yourdomain.com`).

| Provider | Redirect URI (local) |
|----------|------------------------|
| Google | `http://localhost:8000/orchestration/google/callback` |
| HubSpot | `http://localhost:8000/orchestration/hubspot/auth/callback` |
| Calendly | `http://localhost:8000/orchestration/calendly/callback` |
| Zoho | `http://localhost:8000/orchestration/zoho/callback` |
| Vercel | `http://localhost:8000/orchestration/vercel/callback` (if OAuth) |

---

## Checklist after setup

- [ ] Google: Client ID, Client secret, redirect URI added in Google Cloud Console and in `.env`
- [ ] HubSpot: Client ID, Client secret, App ID, API URL, App URL in `.env`
- [ ] Calendly: Client ID, Client secret in `.env`
- [ ] Zoho: Client ID, Client secret in `.env` (and backend region matches)
- [ ] Vercel: OAuth client ID/secret or API token in `.env` / UserSecrets

Put these in the **same app that serves the “Connect account” endpoints** (usually UserMicroService `.env`). If your templates-workflow-BE runs the Connect flow itself, put them in templates-workflow-BE `.env` instead.
