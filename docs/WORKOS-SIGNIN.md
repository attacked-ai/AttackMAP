# WorkOS sign-in on the live site (Supabase / Vercel)

Status: 2026-10-22. WorkOS sign-in is live on attackedmap.vercel.app since 15 Oct
(bridge v4). In the repo, not deployed yet: bridge v5 (two-step, MFA-PASSKEYS.md)
plus the one-page sign-up below. **Deploy the bridge first, then the site.**

## What the reader sees

- **Sign up** (owner, 2026-10-22: every question on one page, nothing to answer
  after): every sign-up button opens **`/?signup`**, the site's own page in the
  WorkOS page's design (same two columns, same left panel, same card and gold
  button). It asks first name, surname, email, job title, company, industry and the
  email opt-in. *Continue* → WorkOS emails a 6-digit code → the reader types it on
  the same page → dashboard. Or job title, company and industry, then *Continue
  with Google / Microsoft* (name and email come from that account) → dashboard.
  WorkOS's hosted sign-up page can only ask for a name and an email, which is why
  this page is ours (`src/auth/SignUpPage.jsx`).
- **Sign in** stays on the **WorkOS-hosted page** (AuthKit: email code, password,
  passkey, Google / Microsoft, and the two-step code for accounts that have one).
  The sign-up page's *Already have an account? Sign in* goes there too.
- An account with **two-step verification** never signs in through the sign-up
  page: the bridge sends it on to the hosted sign-in (address filled in, answers
  kept for the way back).
- **"One last step"** remains only as a backstop for accounts made on WorkOS's own
  pages: the **"Sign up" link on the WorkOS sign-in page** (it opens WorkOS's own
  sign-up, name and email only), or a new person using Google / Microsoft on the
  WorkOS sign-in page. Those have answered nothing, so it asks once. Answers already
  on the account are copied to the profile instead of asked again. To send WorkOS's
  "Sign up" link to `/?signup`, see "After going live".
- The answers fill an empty profile only; an existing account keeps its own.
- If the sign-in service can't be reached, or the WorkOS key isn't set, our window
  says so ("Sign-in is unavailable right now" / "not switched on yet") instead of
  sending the reader to an error page. It always has Cancel / Escape.

No passwords.

## How it works

```
page ── /providers check ──▶ workos-auth  (authkit on? WorkOS key set?)
page ── GET /start?provider=authkit&screen_hint=…&redirect=<page>?…&wos_n=<nonce>
        └▶ workos-auth (signed cookie: state + return page) ──▶ WorkOS-hosted page
     ◀── /callback ◀── WorkOS ── Supabase admin: account if new, one-time token
     ◀── <page>?…&wos_n=<nonce>#wos_token=… ── verifyOtp ──▶ normal Supabase session
```

- The nonce (`wos_n`) is also kept in the tab's sessionStorage; the page uses a
  returned token only when the two match, so a link carrying someone else's
  token is ignored (login CSRF). The function also drops any `#fragment` from the
  return address before appending the token.
- The sign-up page uses the bridge's in-window routes: `/email/start` (WorkOS makes the
  code and emails it: its Magic Auth email is on), `/email/verify` (→ one-time token)
  and `/start?provider=GoogleOAuth|MicrosoftOAuth` (straight to the provider). These
  skip the WorkOS page and its two-step check, so the bridge never opens a session
  through them for an account that has a factor: WorkOS's own `mfa_*` answers, or any
  factor on the account, give `409 code use_hosted` (email code) or a second trip to
  the hosted sign-in (provider). If the factor check itself fails, it counts as "has
  one". Secrets: `BRIDGE_SIGNUP_FORM=off` switches these routes off (the sign-up page
  then shows the bridge's error; sign-in is untouched); `BRIDGE_CODE_EMAIL=ours` sends
  our own code email, only if WorkOS's Magic Auth email is switched off (else two
  emails). `/providers` says `signup_form: true` when the routes are on; when it
  doesn't (an older bridge, or the switch off), the sign-up page keeps the answers
  and sends the reader to WorkOS's hosted sign-up instead, so a site deployed before
  the bridge still works (two pages, nothing asked twice).
- An account that already existed in Supabase but whose address was never confirmed
  (made through Supabase's own sign-up, with a password, by anyone) is reset before
  its first WorkOS sign-in: random password, address confirmed, metadata reduced to
  WorkOS's. Without this the sign-in would confirm someone else's half-made account
  with their password on it.

- Supabase Edge Function `workos-auth` (project `ovenyjguhkgiceddzwna`, verify_jwt off).
  Only these exact sites can use it: attackedmap.vercel.app, localhost:5173 and
  localhost:5180. From bridge v5 Vercel previews are NOT allowed by pattern (another
  Vercel team could claim a matching name and receive the sign-in token). To sign in
  on a preview, add its exact origin to the `WORKOS_ALLOWED_ORIGINS` secret
  (comma-separated) and remove it after testing.
- WorkOS Staging client `client_01M4APWJ40K0B75B3ZYZJ6B0DW`. Redirect URI
  registered: `https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/workos-auth/callback`.
- The site build is switched with `VITE_AUTH_PROVIDER=workos`. Without it the site
  signs in exactly as before (Supabase codes and Supabase OAuth).
- Buttons appear only for providers WorkOS has switched on (`GET /providers`,
  rechecked every 5 minutes). LinkedIn shows up by itself once it is set up in WorkOS.

## Files

| File | What |
|---|---|
| `supabase/functions/workos-auth/index.ts` | the function: v5 + sign-up routes, NOT deployed (live = v4, backup `D:/attacked-dev/backups/workos-auth-v4-2026-10-17.ts`) |
| `src/lib/workos.js` | browser side: code, providers, return trip |
| `src/auth/AuthProvider.jsx` | WorkOS branch in signIn / verifyCode / signInWithProvider; return trip handled once |
| `src/auth/SignUpPage.jsx` + `src/styles/signup.css` | the sign-up page (`/?signup`) |
| `src/lib/signupAnswers.js` | the answers onto a new profile (fills blanks only; first save sends the welcome email) |
| `src/auth/AuthModal.jsx` | sign-up buttons → `/?signup`; sign-in → the hosted page |
| `src/auth/CompleteProfile.jsx` | "One last step" (backstop: a new person who used *Sign in* on WorkOS) |
| `src/main.jsx` | routes `/?signup`; the backstop step; friendly message when a trip fails |

## To switch on (owner)

1. **WorkOS API key in Supabase**: Dashboard → Edge Functions → Secrets → add
   `WORKOS_API_KEY` = the Staging key (`sk_test_…`). Until then the window says
   "Sign-in is not switched on yet."
2. **LinkedIn** (optional): LinkedIn developer app with *Sign In with LinkedIn using
   OpenID Connect*; redirect URL = the one WorkOS shows on its LinkedIn page; put
   the Client ID / Secret into WorkOS → Authentication → Providers → LinkedIn.
3. **Microsoft for work accounts** (optional): WorkOS's built-in Staging Microsoft
   credentials accept personal Microsoft accounts only (outlook.com, hotmail).
   For company Microsoft 365 accounts, register an Azure app (multi-tenant) and put
   its Client ID / Secret into WorkOS → Providers → Microsoft.

## How to test

| Where | Address |
|---|---|
| Local | http://localhost:5180 (run: `VITE_AUTH_PROVIDER=workos VITE_API_URL= npx vite --port 5180`) |
| Vercel preview | sign-in works only after its exact origin is added to `WORKOS_ALLOWED_ORIGINS` (bridge v5) |

1. **New account by code**: any sign-up button → `/?signup` → fill everything →
   *Continue* → **one** code email (from WorkOS) → enter it → dashboard, no "One last
   step". Profile shows job title, company and industry.
2. **New account by Google**: new browser profile or another Google account →
   `/?signup` → job title, company, industry → *Continue with Google* → dashboard,
   nothing more to fill.
3. **Existing account by code**: *Sign in* → WorkOS page → email → code → dashboard.
4. **Existing account by Google / Microsoft**: *Sign in* → provider → dashboard.
5. **Two-step account on the sign-up page**: fill the page with that address →
   code → "…signs in on the secure sign-in page" → WorkOS asks for the
   authenticator code → dashboard.
6. **Cancel**: start Google, press back or cancel → site says "Sign-in was cancelled."
7. **Wrong code**: type 000000 → "That code didn't match…"; *Resend code* works after 30 s.

Local rigs: `bridge-harness.mjs` (the real bridge against simulated WorkOS/Supabase,
104 checks) and `signup-e2e.mjs` (the page in headless Chrome against the local
Docker stack, 50 checks), both in the session scratchpad.

## After going live (bridge, then site)

1. **WorkOS's own "Sign up" link** (on its sign-in page) still opens WorkOS's sign-up.
   The Staging AuthKit application has a `signUpUrl` setting (empty today) whose effect
   WorkOS does not document. Once the new site is live: set it to
   `https://attackedmap.vercel.app/?signup`, open the WorkOS sign-in page and check where
   "Sign up" goes. Keep it if it opens `/?signup`; clear it otherwise. Never set it while
   the live site has no `/?signup` page, or while `BRIDGE_SIGNUP_FORM=off`.
2. **Supabase's own sign-up** (Authentication → Sign In / Providers → "Allow new users to
   sign up") can go off: the WorkOS build never uses it (the bridge creates accounts with
   the admin API, which that switch does not block). Keep "Confirm email" on. This is
   MFA-PASSKEYS.md §3 step 1.

## Going live and rolling back

- Live today: `attackedmap-cdwkvd778` (commit `dc7953a`, branch `cards-responsive`).
- Go live: promote the tested preview (or `vercel deploy --prod` from `workos-live`
  with `VITE_AUTH_PROVIDER=workos`). Only on the owner's go-ahead.
- Roll back: `vercel promote attackedmap-cdwkvd778-mohiawrai2609s-projects.vercel.app`
  (sign-in goes back to Supabase codes at once; the function can stay deployed).

## Later

- WorkOS **Production** environment (needs the WorkOS admin): new client ID and
  key, same redirect URI, then set `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` secrets.
- Rotate the Staging key that was pasted in chat.
- Remove the temporary `http://localhost:5180/...` redirect URI in WorkOS once the
  GCP-mode testing is finished.
- Same flow for the GCP backend (branch `workos-auth`).
