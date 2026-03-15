# Zoho OAuth Setup (Fix "You are not a part of any org" / "You do not have permission to share your data")

The consent screen messages mean:

1. **"You are not a part of any org. So CRM permission(s) will not be granted."**  
   The Zoho **account** you’re signing in with is **not** in a Zoho **organization** that has **Zoho CRM**. Only orgs with CRM can grant CRM scopes.

2. **"You do not have permission to share your data with templates_workflow."**  
   The **OAuth app** (e.g. named "templates_workflow" in Zoho) is either not allowed for this user/org, or the app configuration (redirect URI, client type, products) is wrong.

## What to change

### 1. Use a Zoho account that has Zoho CRM

- Sign in with a Zoho account that is **part of an organization that has Zoho CRM** (trial or paid).
- A plain Zoho Mail / personal account often has **no** org and **no** CRM, so it will always show "You are not a part of any org."
- Either:
  - Use an account that’s already in a Zoho org with CRM, or  
  - Create/sign up for **Zoho CRM** (e.g. [Zoho CRM Free](https://www.zoho.com/crm/) or trial) so your account is in an org with CRM.

### 2. Configure the app in Zoho API Console

Use the console for your **region**:

- **India:** https://api-console.zoho.in  
- **US:** https://api-console.zoho.com  
- **EU:** https://api-console.zoho.eu  

1. **Create (or edit) a "Server-based Applications" client.**
2. **Authorized Redirect URIs**  
   Add **exactly** (no trailing slash):
   - Production: `https://your-domain.com/orchestration/zoho/callback`
   - Local: `http://localhost:8000/orchestration/zoho/callback`  
   Must match your backend `ZOHO_REDIRECT_URI` / `BASE_URL`.
3. **Scope**  
   Add the scopes your app requests, for example:
   ```text
   ZohoCRM.users.READ,ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.settings.workflow_rules.ALL,ZohoCRM.settings.automation_actions.CREATE
   ```
   (Or the minimal set you need; see "Optional: reduce scopes" below.)
4. **Client ID & Client Secret**  
   Copy them into your backend `.env` as `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET`.
5. **Products**  
   Ensure **Zoho CRM** is enabled/selected for this client in the API Console.

### 3. Optional: reduce scopes (if you only need basic CRM)

If you only need basic read/write (e.g. Contacts, Leads) and want to request fewer permissions, you can use a smaller scope set. The backend can be configured to request minimal scope; the trade-off is some advanced features (e.g. workflow rules, automation actions) may not work until you add those scopes back.

---

## Checklist

- [ ] Zoho account is in an **organization that has Zoho CRM** (not only Zoho Mail).
- [ ] In API Console: **Server-based Applications** client with **Zoho CRM** product.
- [ ] **Redirect URI** matches exactly (e.g. `http://localhost:8000/orchestration/zoho/callback`).
- [ ] **Scope** includes the CRM scopes your app uses.
- [ ] `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REDIRECT_URI` (or `BASE_URL`) set correctly in backend `.env`.

After these changes, try connecting again from your app; use the same Zoho account that has CRM access.
