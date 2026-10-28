# Two-step verification & passkeys — Attacked.ai (17 Oct 2026)

## In plain words

- **Two-step verification:** after the usual sign-in, the WorkOS sign-in page asks for a 6-digit code from an authenticator app on the reader's phone (Google Authenticator, Microsoft Authenticator, 1Password…). Readers turn it on themselves in **Profile → Login and security** (§7).
- **Passkeys:** sign in with a fingerprint, face or phone instead of typing. They're created on the WorkOS sign-in page and count as both steps.

## What exists now

| Part | State |
|---|---|
| WorkOS **Staging** (what the site uses today) | Passkeys ON with "offer a passkey" after password sign-in. Two-step **Optional** (someone set it to "Required" by 19 Oct, which forced every sign-in through the authenticator screen; set back to Optional on 19 Oct at the owner's request: **never forced, only suggested**). Email verification required. Google, Microsoft, email code and password sign-in. |
| **Reminder card** (`src/auth/SecurityNudge.jsx`, 19 Oct) | A polite card once per visit for readers without two-step: "Set it up" (→ Profile → Login and security) or "Remind me later" (7, then 14, then 30 days). Hidden after passkey/SSO sign-ins, on profile/admin/map/checkout/legal pages, and while the bridge can't answer, so it **appears only once the bridge below is deployed**. Preview: `review/security-nudge-preview.html`. |
| WorkOS **Production** | **Not set up.** Two-step off, passkeys off, no sign-in methods. Mohini's WorkOS role is read-only there, so a WorkOS **admin** must do it (§4). |
| **Profile → Login and security** (`src/auth/SecurityPanel.jsx`, `src/auth/security/`) | Rebuilt on 22 Oct as a MongoDB-style page (§7): a **Login** card (email, set or change the password in-page, linked accounts, last sign-in, sign out everywhere else) and a **Two-step verification** card (Passkey, Okta Verify Mobile App and Authenticator app rows, each with "Set up"; since 27 Oct Okta Verify uses the same 6-digit code factor, because WorkOS cannot send Okta push). Turns two-step on (scan QR, confirm one code) and off (current code). Tested with a simulated session (`review/security-preview.html`). Needs bridge **v8** for the password and linked-account rows; with an older bridge it says they are "being updated". |
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

**If sign-in breaks:** redeploy the v4 backup file (step 2 with the backup's code). Once the new site (with `/?signup`) is live, a v4 bridge makes its sign-up page fall back to WorkOS's hosted sign-up (v4 does not say `signup_form`), so the site can stay; nothing else on it needs v5 except Profile → Login and security.

## 2. Test it on http://localhost:5173 (about 10 minutes, your own account)

1. **Sign in** on the WorkOS page, then go to **Profile → Login and security**. If it asks you to "sign in again", do so (changes need a recent sign-in).
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
   - Profile → Login and security: the Passkey row shows "Used last time" and Last sign-in says "With a passkey".
5. **Turn off:** Profile → Login and security → **Turn off**, then type the current code.

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
- **Reader asks to "unlink" Google or Microsoft:** there is no unlink in WorkOS (not in the API, the SDK, the dashboard or the widgets). The only way by hand is to **delete the whole WorkOS user** (WorkOS → Users → the person → Delete), which also drops their TOTP factor, password and passkeys. Then in Supabase SQL:
  `update auth.users set raw_app_meta_data = raw_app_meta_data - 'workos_user_id' - 'mfa_factor_id' - 'mfa_since' - 'methods_used' - 'password_set_at' where email = '<their email>';`
  so the next sign-in creates a fresh WorkOS user. Only do this once the reader knows two-step, the password and any passkey must be set up again. The Linked accounts row tells readers a linked account "can't be removed on its own".
- **Reader says the Password row shows "Set password" although they have one:** the page can only tell from the bridge's `password_set_at` stamp (written by the in-page form) or a last sign-in by password; a password set on the hosted page's "Forgot password?" leaves no stamp. Harmless: the form is "Set or change your password" either way. The WorkOS dashboard (or the MCP `users` query) shows `hasPassword` if you need to check.

## 7. Login and security page (22 Oct 2026)

**Profile → Login and security** (`/?profile#security`; `src/auth/SecurityPanel.jsx` owns the state, `src/auth/security/LoginCard.jsx`, `TwoStepCard.jsx`, `icons.jsx`, `tokens.js` render) follows the shape of MongoDB's "Login and Security" page: a **Login** card and a **Two-step verification** card. Two-step stays **Optional** in WorkOS (nothing here touches the setting); every method row only offers "Set up". Plain words throughout: "two-step verification", "authenticator app", "passkey", "linked accounts".

**Login card**

| Row | What it shows | Where it comes from |
|---|---|---|
| Email address | a read-only box and "To change it, contact the Attacked.ai team." | the Supabase session |
| Password | "Set password" or "Change password" → an in-page form (new password twice, plus the authenticator code when two-step is on) | `POST /security/password` (bridge v8) |
| Linked accounts | one row per sign-in provider the reader has used; pill **Linked** when WorkOS lists the identity, else **Used last time** / **Used before**. No unlink. | `GET /security?full=1` → `login.methods` (accumulated at each sign-in) ∪ `login.identities` |
| Last sign-in | "With Google · 22 Oct 2026, 09:41" (any device) | `method` + `signed_in_at` |
| Signed-in devices | one row per device where the reader is signed in ("Mac · Safari", **This device**, "Last active 2 hours ago · Signed in 22 Oct 2026"), a "Sign out" on every other row, then "Sign out everywhere else" with its inline confirm (left out once only this device is listed). See *Signed-in devices* below. | `GET /security/devices` and `POST /security/devices/signout` (the bridge after v8); "everywhere else" stays Supabase `signOut({ scope: "others" })`. An older bridge (404 / 405): the plain row as before |

**Two-step card:** a Passkey row (its "Set up" opens an explainer: set a password, sign out, sign in with it on the Attacked.ai sign-in page, accept the offer) an Okta Verify Mobile App row (27 Oct: the same QR code set-up with Okta-specific wording; no button once codes are on) and an Authenticator app row (QR set-up and turn-off, unchanged), then four footnotes (set up both; Okta Verify works as a code app, no push; why no email/SMS codes; lost phone) and the live status line. An admin without two-step or a passkey still sees the reminder line.

**What the page cannot do, and why**
- **Unlink a Google or Microsoft account.** WorkOS has no unlink anywhere (API, SDK, dashboard, widgets). The row says "A linked account can't be removed on its own." See the runbook (§6) for the only by-hand option.
- **Recovery codes.** None exist in AuthKit (MongoDB has none either). A lost phone means the team deletes the factor (§6).
- **Passkeys in-app.** No REST endpoint lists, creates or deletes a passkey; enrolment happens only on the hosted page, after a password sign-in (the two-weekly "offer a passkey" reminder, which the reader can decline for good). WorkOS also offers a `<UserSecurity />` widget (`@workos-inc/widgets` 1.20.x: set or change the password, configure and reset two-step; token from `POST /widgets/token {user_id}` minted by a backend, 1-hour expiry, or the AuthKit access token; peer deps `@radix-ui/themes ^3`, `@tanstack/react-query ^5`, React 18). It is not used here: it would bypass the bridge's recent-sign-in gate and wrong-code counter, duplicate the existing two-step routes, and ship WorkOS's UI kit. Passkey operations are not documented for the widget or the Widgets API either, so in-app passkey management stays out.
- **Change the email address.** No flow in WorkOS or the bridge; the helper says to contact the team.
- **A list of WorkOS sessions.** `GET /user_management/users/{id}/sessions` exists, but the bridge revokes every WorkOS session 0.6–2 s after sign-in (observed on Staging), so it would list only revoked sessions. The devices list below therefore comes from the reader's **Supabase** sessions instead. "Sign out everywhere else" is Supabase-only: other devices' refresh tokens are revoked at once and their access tokens lapse within the hour. Supabase fires no `SIGNED_OUT` event for `scope: "others"`, so the page reads the returned `{ error }` only.
- **Know for certain whether a password exists.** The REST User object has no flag. The page guesses from the bridge's `password_set_at` stamp or a last sign-in by password; the form heading "Set or change your password" covers both cases. The dashboard / MCP `users` query exposes `hasPassword` to check a label.

**The password route.** `POST /security/password {password, code?}` → WorkOS `PUT /user_management/users/{id} {password}`. Gates, in this order: a sign-in through the Attacked.ai sign-in page within 20 minutes (403 `reauth`, before any WorkOS call); the strict WorkOS-id lookup (409 `no_workos`); 10–128 characters and no email address inside (400 `weak_password`); and, when two-step is on, the current authenticator code, checked by WorkOS through the shared wrong-code counter (400 `code_required`; 429 after 5 wrong codes in 10 minutes). A WorkOS 400/422 on the write (its own strength policy) comes back as "too easy to guess". One change a minute per account (429 "Too many changes in a short time", checked on the bridge's own `password_set_at` stamp before the code check and before any WorkOS call): every change is a WorkOS write and an email from the shared sender, so a signed-in script cannot run either dry for everyone. WorkOS has no current-password check; the gates above are the substitute, with two mitigations: the "Your Attacked.ai password was changed" email, and the "Sign out everywhere else" offer under the success message. The password is never logged or echoed. If two-step was switched on in another tab after the page loaded, the first save answers `code_required` and the form simply gains its code field. The in-page set-up at WorkOS is now verified too: after creating the authenticator factor the bridge runs a WorkOS challenge + verify with the reader's code and deletes the factor if that fails, so no half-made factor is left and the factor counts as verified on WorkOS's side (a code the bridge itself accepted costs no attempt when WorkOS's clock refuses it). Should that delete fail as well, the factor is live whatever we say, so the bridge notes it on the account, emails "turned on" and answers "already on" (`state_changed`): the page reloads and shows On, and the reader can turn it off with the same app entry. The function log says `unverified factor not deleted` with the factor id.

**Signed-in devices.** Under the Login card's "Signed-in devices" row the page lists every browser and phone where the reader is signed in: one row per Supabase session, named from what the browser says about itself ("Mac · Safari", "Windows · Chrome", "iPhone · Safari"; a laptop, phone or tablet glyph), with a green **This device** pill on the current one (the session named in the reader's own access token), "Last active 2 hours ago" (just now / minutes / hours / yesterday / days, then a date) and "Signed in 22 Oct 2026". Every *other* row has its own **Sign out**; "Sign out everywhere else" keeps its place at the bottom (gone once only this device is listed, back as soon as another appears). The list loads with `GET /security/devices` right after the status, shows "Checking…" meanwhile, "We couldn't list your devices just now." + "Try again" on a failure, and reloads after a successful "Sign out everywhere else". A row's **Sign out** calls `POST /security/devices/signout {id}`; the row disappears and the line under the list says "Signed out that device. It may stay signed in for up to an hour." — ending a session deletes its refresh token, so that device cannot get a new access token, and the auth server refuses the access token it already holds on every auth call at once (it checks the token's session row: `session_not_found`); only data reads through PostgREST and storage, which check the signature alone, run on until that token expires (up to an hour); this is the same caveat as "everywhere else". Focus then moves to the next row's button or, with none left, to the list heading. After "Sign out everywhere else" the page trims the list to this device straight away and refreshes it behind that (no "Checking…", no button flashing back), and the "Sign out others" confirm waits while a row's own Sign out is still running. The bridge answers 400 `not_found` for an id that is not a session of this reader (the page drops that row too: it is gone already) and 409 `current` for the reader's own session (the page never offers that button; the current row has no Sign out). The page never receives the raw browser string or the IP address: the bridge parses the user agent itself (Edge before Chrome; CriOS / FxiOS are Chrome / Firefox on iPhone; an iPad on iPadOS reports as a Mac, accepted) and sends only `os`, `browser`, `last_active`, `signed_in`, `current`. Neither route needs a recent sign-in: listing and ending the reader's *own other* sessions only ever reduces where the account is signed in, which is what someone who suspects a stolen session needs to do quickly, and the recent-sign-in gate exists to protect changes that widen access (password, two-step). Both routes are braked per reader instead: more than 60 calls a minute from one account (counted in the function's isolate, so a brake on request loops rather than a quota) answer 429 "Too many requests. Wait a minute, then try again." (`code: "slow_down"`); the status route and other readers are unaffected. Each ended session is logged with the reader's id and the session id (uuids only). Data: PostgREST cannot read `auth.sessions`, so migration `supabase/migrations/20261022_sessions.sql` adds two `SECURITY DEFINER` functions in `public`, both revoked from public / anon / authenticated and granted to **service_role only** (the bridge), both with an empty `search_path` (every name in them is schema-qualified): `_sessions_for(p_user uuid)` → the reader's live sessions (`not_after` null or in the future) with `last_active = greatest(updated_at, refreshed_at, created_at)`, newest first, 50 at most (`refreshed_at` is a timestamp without time zone, so the function pins its time zone to UTC and the answer does not depend on the connection); `_end_session(p_user uuid, p_session uuid)` → deletes that one session *of that user* and its rows in `auth.refresh_tokens` (explicitly, whatever the cascade does) and returns the count (0 = not found). The migration is applied by hand on the live project with the bridge deploy, as `20261017_mfa_attempts.sql` was.

**Feature detection.** The page makes one status request, `GET /security?full=1`. If the answer has no `signed_in_at` key the bridge is still v7: the page hides the Password button and the Linked accounts list ("Password and linked-account settings are being updated. Check back shortly.") and never calls `/security/password`, and it does not ask for the devices list either. With a v8 status it asks `GET /security/devices` once: a 404 (no such route) or 405 (v8's router allows GET only for the exact `/security` path) means the bridge has no devices routes yet, and the plain "This one, plus any other browser or phone where you signed in." row with "Sign out everywhere else" stays exactly as before (`securityApi` now puts the HTTP status on the error it throws, so the page can tell that apart from a failure). The two-step rows and the "Sign out everywhere else" row work with either bridge. The reminder card keeps calling the plain `GET /security`, which makes no extra WorkOS call.

**Deploy order.** Bridge **v8** first (as in §1: `verify_jwt = false`, migration `20261017_mfa_attempts.sql` applied — without it every confirm, turn-off and password change with two-step on fails closed with 502), then the site. Site first only shows the "being updated" line until the bridge follows; bridge first changes nothing visible. The devices list needs the bridge **after v8** and migration `20261022_sessions.sql` (without it `GET /security/devices` answers 502 and the row says "We couldn't list your devices just now." with "Try again"; the plain "Sign out everywhere else" still works); site first keeps the plain row until that bridge follows.

**Previews.** `review/security-preview.html?state=google | google-linked | nolinked | idfail | idfail-magic | passkey | oldbridge | off | on | noworkos | reauth | expired | down` (`reauth`: the status loads but every change answers "sign in again"; `expired` / `down`: the status itself fails with 401 / 502, so the alert shows), with `&pw=429` / `&pw=502` for the password route's errors, `&pw=code_required` for two-step switched on elsewhere after the page loaded (the first save answers `code_required`, then the form shows the code field), and `&others=fail` for a failed "Sign out everywhere else". The devices list: `&devices=many` (default: Mac · Safari as this device, Windows · Chrome, iPhone · Safari), `one` (this device only), `fail` (502), `404` (an older bridge: the plain row); `&signout=current` makes a row's Sign out answer 409, `&signout=fail` 502. Code 123456 passes every simulated check.


## 27 Oct 2026 — security prompt after sign-in

The old corner card (`SecurityNudge.jsx`) is now a full-screen MongoDB-style screen: "Set up two-step verification for your account" with **Set up now** (→ `/?profile#security`) and **Remind me later**. It shows once per sign-in (localStorage `atk.securityPrompt`, keyed by the sign-in time in milliseconds), never when two-step is on, after a Passkey/SSO sign-in, on quiet pages, or when the bridge can't answer. Tab/Shift+Tab stay inside it and Esc = Remind me later. Preview: `review/security-nudge-preview.html?state=off|on|passkey|down`.
