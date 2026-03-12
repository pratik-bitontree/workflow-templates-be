# Why the OAuth popup was blank (and how it was fixed)

## Root cause

1. **Frontend** opens a popup and navigates it to:  
   `{NEXT_PUBLIC_CONNECT_BASE_URL}/orchestration/{service}/connect?userId=...`  
   With your `.env` that was:  
   `http://localhost:8000/orchestration/gsheets/connect?userId=...`

2. **Backend** (templates-workflow-BE) had **no route** for `/orchestration/...`.  
   All routes were under the global prefix `/api` (e.g. `/api/integration-hub/...`).  
   So `GET http://localhost:8000/orchestration/gsheets/connect` did **not** hit any controller and returned 404 or an empty response → **blank popup**.

3. **Backend .env**: `CONNECT_BASE_URL` was only used by `GET /api/integration-hub/oauth/login` to *return* a URL string. It does not create a route. So even with `CONNECT_BASE_URL=http://localhost:8000`, the backend never served the page the popup was loading.

## Fix

- **New routes** (without `/api` prefix) were added so the same backend serves the OAuth flow:
  - `GET /orchestration/:service/connect` → redirects to Google OAuth (or shows config error).
  - `GET /orchestration/google/callback` → exchanges code, saves tokens to UserSecrets, returns HTML that closes the popup.

- **Global prefix** in `main.ts` was updated to **exclude** `orchestration/(.*)` so these routes are available at:
  - `http://localhost:8000/orchestration/gsheets/connect`
  - `http://localhost:8000/orchestration/google/callback`

- **Backend .env** must have:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI=http://localhost:8000/orchestration/google/callback` (or `${BASE_URL}/orchestration/google/callback` with `BASE_URL=http://localhost:8000`)
  - `CONNECT_BASE_URL=http://localhost:8000` (optional; used if the frontend calls the backend for the login URL)

- **Frontend .env**:  
  `NEXT_PUBLIC_CONNECT_BASE_URL=http://localhost:8000` so the popup URL is `http://localhost:8000/orchestration/...`. No change to the frontend code was required once the backend served these routes.

## Summary

| Before | After |
|--------|--------|
| Popup loaded `localhost:8000/orchestration/...` → no route → blank | Same URL is handled by `OrchestrationController` → redirect to Google → sign-in page |
