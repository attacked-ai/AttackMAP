# Moving Attacked.ai to Google Cloud: your checklist

Written 2026-10-10. These are the steps only you can do, because they need your accounts, your billing card or your passwords. Claude handles everything else: the code, the setup script, copying the data, and switching the site over.

The full technical runbook is in `deploy/gcp/README.md`. You don't need to read it.

## Already done ✅
- **Resend:** `attacked.ai` is verified, and all its DNS records are live. Emails can be sent from an attacked.ai address.
- **Code:** a `gcp-production` branch is being prepared. It keeps the live design and adds the Google Cloud backend, with email through Resend.

## Your steps (in this order)

### 1. Resend: make a fresh key and remove the old ones (5 minutes)
1. Open resend.com → **API Keys** → **Create API key**.
   - Name: `gcp-production` · Permission: **Sending access** · Domain: `attacked.ai`.
2. Copy the key (it starts with `re_`) and keep it somewhere safe for step 6. Resend shows it only once.
3. Delete the two old keys both named **"Onboarding"** (made 5 Aug). One of them was exposed earlier.

### 2. Google Cloud project with billing (10 minutes)
1. Go to console.cloud.google.com → **New project** → name it `attacked-ai-prod`.
2. **Billing** → link a billing account (this needs your card).
3. Tell Claude the **project ID**, which appears under the project name.

Rough running cost: about **US$40–70 a month** at today's size, mostly the database.

### 3. Google sign-in screen (15 minutes, then Google reviews it for a few days)
In the same project: **APIs & Services → OAuth consent screen → External**.
- App name **Attacked.ai**, support email, logo, home page.
- **Privacy policy** and **Terms** links: these must be live pages on your site.
- Then **Credentials → Create credentials → OAuth client ID → Web application**.
  - Redirect URI: `https://attacked-ai-prod.web.app/api/auth/google/callback`
- Keep the **client ID** and **client secret** for step 6.

Sign-in by emailed code works right away. "Sign in with Google" for everyone works once Google approves the screen.

### 4. Firebase (2 minutes)
console.firebase.google.com → **Add project** → choose the existing **attacked-ai-prod** → **Hosting → Get started**.

### 5. Make the GitHub repo private (1 minute)
GitHub → the repo → **Settings → Change visibility → Private**. An old access key is in the repo's history, so it must be private before Google Cloud connects to it.

### 6. Paste the secrets (Claude gives you the exact commands)
In Google Cloud Shell, which is a terminal inside your browser, you paste:
- the Resend key (step 1),
- the Google client ID and secret (step 3),
- the Supabase database connection string. To get it: Supabase dashboard → Project Settings → Database → Connection string → **Session pooler**.

Claude never sees or types these values. You paste them yourself.

## What Claude does after that
1. Runs the setup: the database, the storage buckets, the timers and the services.
2. Does a **practice copy** of the data first, and shows you a table of row counts (old vs new) so you can confirm nothing is missing.
3. Puts the site up at `attacked-ai-prod.web.app` and checks every page.
4. With your OK: the final data copy, then pointing `attacked.ai` at Google Cloud.
5. Keeps Supabase read-only for two weeks as a safety net, then pauses it.

## Good to know
- **Everyone signs in once more** after the move. Accounts, tiers and profiles are kept.
- **Supabase is still locked** (data-allowance error 402) even though it was upgraded to Pro. The data copy in step 6 needs it unlocked. Check Supabase → Billing → Usage, or contact Supabase support if it stays locked.
