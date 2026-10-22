# Two-step verification & passkeys — Attacked.ai (17 Oct 2026)

## In plain words

- **Two-step verification:** after the usual sign-in, the WorkOS sign-in page asks for a 6-digit code from an authenticator app on the reader's phone (Google Authenticator, Microsoft Authenticator, 1Password…). Readers turn it on themselves in **Profile → Security**.
- **Passkeys:** sign in with a fingerprint, face or phone instead of typing. They're created on the WorkOS sign-in page and count as both steps.

## What exists now

| Part | State |
|---|---|
| WorkOS **Staging** (what the site uses today) | Passkeys ON with "offer a passkey" after password sign-in. Two-step **Optional** (someone set it to "Required" by 19 Oct, which forced every sign-in through the authenticator screen; set back to Optional on 19 Oct at the owner's request: **never forced, only suggested**). Email verification required. Google, Microsoft, email code and password sign-in. |
| **Reminder card** (`src/auth/SecurityNudge.jsx`, 19 Oct) | A polite card once per visit for readers without two-step: "Set it up" (→ Profile → Security) or "Remind me later" (7, then 14, then 30 days). Hidden after passkey/SSO sign-ins, on profile/admin/map/checkout/legal pages, and while the bridge can't answer, so it **appears only once the bridge below is deployed**. Preview: `review/security-nudge-preview.html`. |
| WorkOS **Production** | **Not set up.** Two-step off, passkeys off, no sign-in methods. Mohini's WorkOS role is read-only there, so a WorkOS **admin** must do it (§4). |
| **Profile → Security** panel (`src/auth/SecurityPanel.jsx`) | Built, tested with a simulated session (`review/security-preview.html`). It turns two-step on (scan QR, confirm one code) and off (current code), explains passkeys, and shows how the last sign-in was made. |
| Sign-in bridge `supabase/functions/workos-auth` | **Updated, NOT deployed** (the Supabase connector tools were switched off). Adds the `/security` routes and records `auth_method` at each sign-in. Since 22 Oct it also serves the one-page sign-up (`/?signup`, WORKOS-SIGNIN.md): its email-code and direct Google / Microsoft routes refuse any account with a factor (409 `use_hosted`, or a second trip to the hosted sign-in); `BRIDGE_SIGNUP_FORM=off` closes them. Backup of the live version (v4): `D:\attacked-dev\backups\workos-auth-v4-2026-10-17.ts`. |
| Database migration `supabase/migrations/20261017_mfa_attempts.sql` | **Written, NOT applied.** A private wrong-code counter (5 tries per 10 minutes, safe against parallel requests). |
| Admin console | Shows a reminder banner until the admin has two-step on or signs in with a passkey. **A reminder only, not an access check yet** (§5). |

**How it stays safe:**
- **No half-finished setups.** The bridge makes the secret and checks the first code itself (RFC 6238; tested against the official test values). Only then does it register the factor with WorkOS, so no half-made factor is ever left behind.
- **Changes are guarded.** Turning two-step on or off needs a sign-in within the last 20 minutes and a correct code. The reader is emailed when it changes.
- **No one else's settings.** Everything works from the reader's own verified session; nobody can see or change another reader's setting.
- **"Recent sign-in" means this session came through the Attacked.ai sign-in page** in the last 20 minutes (the bridge stamps the time; Supabase's own MFA, password or email-code sessions don't count). Signing in on a second device makes the first device's session not recent; it just asks to sign in again before a change.

## 1. Switch it on (two steps)

**Option A (easiest):** re-enable the Supabase connector tools for this project in Claude's connector settings ("Sweeper DB"). Then tell Claude "deploy the two-step bridge", and it applies the migration, deploys the bridge **with verify_jwt = false** and tests it. (The deploy tool defaults to verify_jwt = true, which would make Supabase refuse every sign-in before the bridge runs.)

**Option B (by hand, in the Supabase dashboard of project `ovenyjguhkgiceddzwna`):**
1. **SQL Editor:** paste the whole of `supabase/migrations/20261017_mfa_attempts.sql` and click **Run**.
2. **Edge Functions → `workos-auth`:**
   - Replace the code with `supabase/functions/workos-auth/index.ts` and click **Deploy**.
   - Keep **"Verify JWT" OFF**, as it is today.
3. Check: `https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/workos-auth/providers` still shows `"configured":true` (a 401 means "Verify JWT" got switched on: switch it off again).

**Sign-in works only from exact addresses:** the live site and localhost:5173 / :5180. Vercel preview links no longer sign in (a pattern for them could be claimed by someone else's Vercel project and catch a sign-in). To test a preview, add its exact address to the `WORKOS_ALLOWED_ORIGINS` secret (comma-separated).

**If sign-in breaks:** redeploy the v4 backup file (step 2 with the backup's code). Once the new site (with `/?signup`) is live, a v4 bridge makes its sign-up page fall back to WorkOS's hosted sign-up (v4 does not say `signup_form`), so the site can stay; nothing else on it needs v5 except Profile → Security.

## 2. Test it on http://localhost:5173 (about 10 minutes, your own account)

1. **Sign in** on the WorkOS page, then go to **Profile → Security**. If it asks you to "sign in again", do so (changes need a recent sign-in).
2. **Turn on two-step verification:** scan the QR code with Google or Microsoft Authenticator, then type the code and **Confirm**. The pill shows **On**, and an email arrives.
3. **Sign out, then sign in again with each method**, and note whether WorkOS asks for the 6-digit code:
   - email + password
   - email code
   - Google
   - Microsoft

   *This is the one thing the documentation doesn't settle for the "Optional" setting, so it must be checked by hand.* Tell Claude the results; if some methods don't ask, the fix is to set two-step to **Required** for those users (§4).
4. **Passkey:**
   - Sign in with email + password, accept the passkey offer, sign out.
   - Sign in choosing **"Sign in with passkey"**.
   - Profile → Security shows "Passkeys · Used last time".
5. **Turn off:** Profile → Security → **Turn off**, then type the current code.

## 3. The gap to close before calling it "production" (important)

Supabase's own email-code sign-in still works directly, with the public key, and it never goes through WorkOS. So someone who controls a reader's **email inbox** could skip two-step entirely. It isn't new; it was there before two-step existed.

**The plan** (needs care, because a mistake here can block every sign-in):
1. **Supabase Auth settings:** switch off "Allow new users to sign up" and every Supabase OAuth provider. The bridge creates accounts with the admin API, which ignores that setting.
2. **Add a Send Email hook** that refuses Supabase's own sign-in code emails (types magiclink, email, signup). The bridge's admin token never sends mail, so it keeps working.
3. **Add a Custom Access Token hook:**
   - Supabase only issues a session that the bridge pre-approved a moment earlier. Password, OAuth and other direct routes are refused.
   - The bridge's own sign-up routes (`/email/*`, direct Google / Microsoft, used by `/?signup`) already refuse any account with a factor: those sign in on the hosted page (WORKOS-SIGNIN.md).
   - This also makes "signed in with a passkey or code" belong to **each session**, which the admin-console rule (§5) needs.
4. **Test it first:** on a separate test Supabase project (branching needs a paid plan), then on live with the dashboard toggle ready to switch it back off.

## 4. WorkOS Production checklist (needs a WorkOS **Admin**)

Do these in this order:
1. **Custom sign-in domain**, e.g. `auth.attacked.ai`: WorkOS → Domains, plus a DNS CNAME. **Do this before turning passkeys on.** Passkeys are tied to the domain they're made on; ones made on a temporary address stop working when the domain changes.
2. **Sign-in methods:**
   - Google, with the company's own Google Cloud OAuth client.
   - Microsoft, with the company's own Azure app registration.
   - Email + password, and email code.
   - GitHub and Apple stay off.
3. **Password rules:** minimum 10–12 characters, strength 3, **"block breached passwords" ON**.
4. **Two-step verification:** Optional for customers, **Required for staff**. Create a WorkOS organization "Attacked.ai team", set its MFA policy to Required, and add the admins.
5. **Passkeys:** ON, plus "offer a passkey" (progressive enrollment) ON.
6. **Bridge details:**
   - Redirect URI `https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/workos-auth/callback`.
   - Email sender on the attacked.ai domain.
   - Radar (bot protection) on.
7. **Keys:**
   - Create a Production API key.
   - In Supabase → Edge Functions → Secrets, set `WORKOS_API_KEY` to it and `WORKOS_CLIENT_ID` to `client_01M4APWMDPZ0XA5DFQDWCVZWW5`. Set them yourself; never paste keys into a chat.
   - Then **rotate the Staging key** that was once pasted in a chat.

## 5. Later: make the admin console require it

Once every admin has two-step on (or uses a passkey) **and** §3 step 3 is in place, change `public._is_admin()` to also require a strong session claim. Until then the banner is only a reminder. Turning it into a rule earlier would be easy to get around and could lock admins out.

## 6. Runbook

- **Reader lost their phone (two-step):**
  1. Check it's really them.
  2. In WorkOS → Users → the person → authentication methods, delete the TOTP factor.
  3. In Supabase SQL:
     `update auth.users set raw_app_meta_data = raw_app_meta_data - 'mfa_factor_id' - 'mfa_since' where email = '<their email>';`
- **Reader lost a device with a passkey:** WorkOS → Users → the person → **Delete passkey**. They then sign in another way.
- **Too many wrong codes:** it clears itself after 10 minutes. To clear it at once:
  `delete from public.mfa_attempts where user_id = '<their user id>';`
