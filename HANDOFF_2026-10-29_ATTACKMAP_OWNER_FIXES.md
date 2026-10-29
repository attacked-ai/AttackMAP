# Handoff — Attack Map "owner fixes" (requested 27 Oct, built and tested 27–29 Oct 2026)

Written 29 Oct 2026 by the Claude chat that built these changes. That chat was mainly a
job-search chat, and the owner asked for this work there by mistake. Continue the work in
the Attack Map / WorkOS chat. This file is everything that chat needs.

---

## 0. READ THIS FIRST — current live status (checked 29 Oct, about 14:25 IST)

**The code for all 6 changes is finished, reviewed and tested, but the live site is NOT
showing it right now.**

- On 29 Oct at about 12:40 IST the owner deployed it to production as **attackedmap-q843j58wi**
  (commit 92c252a). I checked the live site then: all new screens were there.
- At about **14:05 IST** the production address `attackedmap.vercel.app` was moved back to
  **attackedmap-7fpqnk5ti**, the 22 Oct deployment that was the planned rollback target.
  No new deployment was made; the alias was simply re-pointed (`vercel rollback` or `vercel promote`).
  - `vercel inspect attackedmap.vercel.app` currently gives attackedmap-7fpqnk5ti.
  - The live HTML currently loads `assets/index-QKX99bWl.js`, the old bundle. It still has the
    "One last step" box and none of the 6 changes.
- At 14:07 IST, two minutes later, someone committed `7f7e74c "main = the live product:
  owner-fixes-2026-10-27 (92c252a, deployed 29 Oct)"` on main. That may have been your chat.
- **Who rolled it back, and why, is unknown.** Ask the owner before changing anything.

**To put the 6 changes live again**, after the owner says yes: the owner runs this
(Claude's own production deploys are blocked by auto mode):

```
vercel.cmd promote https://attackedmap-q843j58wi-mohiawrai2609s-projects.vercel.app --yes
```

Then check it worked. Grep the live bundle for strings, not for a file name: Vercel's build
has a different hash from the local `dist`, which was built without WorkOS on.

```
curl -s https://attackedmap.vercel.app/ | grep -o 'assets/index-[^"]*\.js'
# fetch that file, then:
grep -c "One last step"                                  # must be 0
grep -c "Make this dashboard yours"                      # must be 1
grep -c "Set up two-step verification for your account"  # must be 1
grep -c "Okta Verify Mobile App"                         # must be 1
grep -c "Work and industry"                              # must be 1
```

Rollback, if needed again: `vercel.cmd promote https://attackedmap-7fpqnk5ti-mohiawrai2609s-projects.vercel.app --yes`

---

## 1. Where the code is

| What | Where |
|---|---|
| Work tree | `D:/attacked-dev/wt-cards` |
| Branch | `owner-fixes-2026-10-27` (also pushed to origin) |
| Base before this work | `a57abd1` (one-page sign-up) |
| Commits | `a3587ad` build · `2212715` review round 1 fixes · `92c252a` review round 2 fixes (final) |
| Merged? | **Yes.** 92c252a is in `cards-only-on-live`, `main` (7f7e74c, now 619da16) and their origin copies |
| Deploy work tree | `D:/attacked-dev/wt-deploy`, detached at 92c252a. It holds the git-ignored `public/reports` (314), `public/reports-full` (311) and `reports-pdf`. `npm install` was needed because node_modules had been a junction |
| Vercel deployment | attackedmap-q843j58wi = 92c252a (Ready, Production, currently NOT holding the alias) |
| Backend | Supabase live project `ovenyjguhkgiceddzwna`. **No database or edge-function change was made for this work.** Front-end only |

Files changed (13): `src/main.jsx`, `src/auth/SecurityNudge.jsx`, `src/auth/ProfilePage.jsx`,
`src/styles/profile.css` (new), `src/auth/SecurityPanel.jsx`, `src/auth/security/TwoStepCard.jsx`,
`src/auth/security/icons.jsx`, `src/responsive.css`, `src/dashboard/Dashboard.jsx`,
`src/dashboard/dashboard.css`, `src/Globe3D.jsx`, `docs/MFA-PASSKEYS.md`,
`review/security-nudge-preview.html`.

---

## 2. The owner's 6 requests: what was built and the status of each

Status key. CODE = done in 92c252a. TESTED = covered by the two review/test rounds.
LIVE = currently on attackedmap.vercel.app.

### 1. No questions after sign-in (remove "One last step") — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **What the owner saw:** after sign-in, a "One last step" box asked for job title, company
  and industry. The cause: accounts made before /?signup existed (for example khufracoc@gmail.com,
  created 20 Oct) had no industry saved.
- **Built:**
  - `src/main.jsx` no longer shows the CompleteProfile box. `ProfileStep` now returns nothing.
    It only silently copies answers given on /?signup (user_metadata) into an empty profile, once.
    It skips ?signup, ?legal and ?unsubscribe.
  - `src/dashboard/Dashboard.jsx`: a user with no industry is not blocked. The dashboard opens
    on "Automotive & EV", labelled **"Example industry"**, with an optional gold
    **"Make this dashboard yours"** picker.
  - Picking an industry saves it, and stamps `onboarded_at` on the first pick, which sends the
    welcome email. If the save fails, the dashboard goes back to the example, resets the picker
    and shows a red "! Could not save your industry. Please try again." toast.
- **Live data check (29 Oct):** khufracoc@gmail.com has a profile with industry = null and no
  metadata industry. With the new code it will open on the example industry with the picker,
  and no box.
- **Side effect to know:** the old box also asked for marketing consent. A user who signs in on
  the WorkOS hosted page and never used /?signup is now never asked for consent, and gets no
  welcome email until they pick an industry.

### 2. MongoDB-style two-step prompt after sign-in — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **Built** in `src/auth/SecurityNudge.jsx`, mounted in `src/main.jsx`. It replaced the old
  small corner card with a 7/14/30-day snooze.
  - **Layout:** a full-screen dialog titled "Set up two-step verification for your account",
    tagged "Recommended · optional". On desktop a dark brand panel sits on the left, with the logo
    and "Attacked.ai"; it is hidden under 820 px. The screen lists Passkey, Okta Verify and
    Authenticator app.
  - **Buttons:** **Set up now** goes to `/?profile#security`. **Remind me later** closes the
    dialog, which leaves the user on the dashboard.
  - **When it shows:** once per sign-in. localStorage `atk.securityPrompt[userId]` stores the
    sign-in time in milliseconds, from `last_sign_in_at` or `app_metadata.signed_in_at`.
  - **When it doesn't show:**
    - two-step is already on;
    - the sign-in used a passkey or SSO;
    - the WorkOS bridge is unreachable;
    - quiet pages: profile, admin, map, legal, unsubscribe, subscribe, pricing, activate,
      signin, signin_error, signup, preview.
  - **Accessibility:** the dialog traps focus on its two buttons, Esc = Remind me later,
    and the page underneath doesn't scroll while it's open.
- **Two-step stays OPTIONAL.** Never set MFA to "Required" in WorkOS without the owner's yes.
- **Live checks (29 Oct):**
  - The bridge route the prompt needs works: `GET .../functions/v1/workos-auth/security`
    without a session returns 401 `{"code":"reauth"}`.
  - khufracoc@gmail.com last signed in with a password and has no two-step factor, so the
    prompt WILL show for it once the code is live again.

### 3. Profile page enhanced and sectioned — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **Built:** `src/auth/ProfilePage.jsx` was rewritten, and `src/styles/profile.css` is new.
  - **Hero:** a dark band with the photo and upload, name, email, plan and industry tags,
    "Member since", and "Open my dashboard" / "Live map" buttons.
  - **Section menu:** on the left, sticky, and it follows the scroll. It turns into a row of
    chips on tablet.
  - **Account checklist:** name, job title, company, industry and photo. Hidden on phones.
  - **Sections:** Personal details · **Work and industry** (industry is editable here) ·
    Email briefings (daily-brief switch, `profiles.email_subscribed`) · Plan ·
    Login and security (SecurityPanel; shown only when WorkOS is on) · Sign out.
  - **Saving:** each section saves on its own. Unsaved edits in other sections are kept.
    `onboarded_at` is stamped only on the first industry.
  - **Links:** `/?profile#work` and the other section anchors scroll to their section; the
    dashboard's "Change industry →" uses #work.

### 4. Okta Verify mobile app in the two-step options — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **Built** in `src/auth/security/TwoStepCard.jsx`, `SecurityPanel.jsx` and `icons.jsx` (ring
  icon), plus `responsive.css` (rows stack on phones).
  - **The list:** three rows in MongoDB's order: Passkey · **Okta Verify Mobile App** ·
    Authenticator app.
  - **How it works, honestly:** Okta Verify uses the same WorkOS code factor (TOTP) as the
    Authenticator app. Only the wording changes: "In Okta Verify, tap + (Add account), choose
    Other, then scan this code", or "enter the key below" when there is no QR.
  - **Limits:** **No Okta push.** WorkOS can't do it, and a footnote on the page says so.
    Once two-step is on, the Okta row shows "Uses your code", and turning it off is done on
    the Authenticator app row.
- **Passkeys** (the owner sent a MongoDB Touch ID screenshot): WorkOS has no passkey API, so a
  passkey can only be added on the WorkOS hosted sign-in page after a password sign-in. The
  in-page "Set up" explains the steps; there is no in-page Touch ID prompt. Removing a lost
  passkey is a manual team action.

### 5. Attack-map incident dots visible — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **Cause found:** the markers were canvas billboards, and they did not draw on the Cesium
  globe at all. Checked with a test point entity, which does draw.
- **Built** in `src/Globe3D.jsx`: each incident is now Cesium **point** entities:
  - a soft halo in its severity colour;
  - a solid core with a white rim (`CORE_PX` = 18/16/14/12/12 px for severity 5 to 1);
  - a pulse ring for CRITICAL incidents;
  - `NearFarScalar` keeps them readable at every zoom;
  - `onNearSide()` with `HORIZON_MARGIN = 0.12` hides a dot just past the edge of the globe,
    so there are no half dots against space.
  - Clicking a dot opens its incident; hovering shows a tooltip.
- **Known issue, from before this work, NOT fixed:** on first open the globe stays black for a
  few seconds while the satellite tiles load, and dots can show over a black globe. That is
  probably what the owner's black-map screenshot caught. A possible follow-up is a placeholder
  earth while tiles load.
- Incidents without coordinates or a known country still get no dot.

### 6. Dashboard without the dark sidebar — CODE ✅ TESTED ✅ LIVE ❌ (rolled back)
- **Removed:** the whole dark left sidebar (Your Industry, Blast Radius, GUARD Controls, Peer
  Watchlist, Subscription, LOCKED/ON tags, upgrade card, phone drawer), and the old full-screen
  "Which industry…" gate.
- **Built**, after the desktop dashboard prototypes (`dashboard-industry/`):
  - **Layout:** full-width page up to 1440 px, with the topbar centred.
  - **Figures strip:** five tiles: this week, High or Critical, in your archive, hardest-hit
    category, and the dark **Live Attack Map** tile. Long names wrap to 2 lines (3 on phones)
    instead of being cut.
  - **Right rail:** a dark Attack Map card at the top.
  - **Profile menu:** opens under its chip, with "Login and security" shown only with WorkOS.
  - **Industry links:** "Change industry →" goes to /?profile#work and is hidden in preview.
    The "Make this dashboard yours" picker appears for users with no industry.
- **Gap the owner may notice:** subscribers lost the in-dashboard links to Blast Radius, GUARD
  Controls, Peer Watchlist and Subscription, and nothing replaced them. Subscribe is now
  reachable only from the profile menu and the article view.

---

## 3. How it was tested (before the 29 Oct deploy)

- **Local stack:** Docker Supabase at 127.0.0.1:54321 with a copy of the live DB. Preview config
  "cards-docker" serves on :5176 (`vite --mode docker`).
  - `wt-cards/.env.docker.local` (git-ignored) sets `VITE_AUTH_PROVIDER=workos` for local tests only.
  - **Local DB only:** 4 triggers that post to the LIVE project were switched off:
    `trg_welcome_on_onboarded`, `trg_notify_application`, `trg_notify_on_new_sweep` and
    `trg_notify_after_incidents_insert`. **Switch them off again after any fresh live-DB copy.**
- **Two multi-agent review and headless-Chrome test rounds**, with the WorkOS bridge mocked over CDP:
  - **Round 1** found 1 blocker and 4 majors, all fixed in 2212715:
    - the phone prompt panel never hid;
    - the dashboard stuck on "Loading your dashboard…" when a user had no profile row;
    - profile edits were wiped by another section's save;
    - the sign-in time lost precision, so the prompt came back after a token refresh.
  - **Round 2** found no blockers or majors; the minors were fixed in 92c252a.
- **Live check right after the owner's deploy (12:40 IST):**
  - the bundle had all the new strings, and "One last step" was gone;
  - the dashboard had no sidebar;
  - the globe showed dots, and clicking one opened the incident.

**Never tested end to end**, because each needs a real sign-in:
- the prompt firing once per sign-in against live WorkOS;
- Okta Verify enrolling a real factor;
- the Email briefings switch saving under row security;
- the picker's error path;
- the welcome email firing exactly once.

---

## 4. Owner test plan (after the changes are live again)

1. Sign in with an older account with no industry, such as khufracoc@gmail.com.
   - There should be **no "One last step" box**.
   - The dashboard should show "Example industry" and "Make this dashboard yours".
2. The full-screen **"Set up two-step verification"** screen should appear.
   - **Remind me later** closes it onto the dashboard. Reload: it must not come back.
     Sign out and in again: it should come back.
   - **Set up now** opens Profile → Login and security.
   - Esc acts like Remind me later.
3. On **Profile**, check the six sections, the sticky menu, and that saving one section keeps
   unsaved edits in another.
   - Check that the Okta Verify row is there.
   - Optional: set up Okta Verify with a real phone.
4. On **Dashboard**: no dark sidebar, the five-tile strip, the map card, and that "Change industry"
   scrolls Profile to Work.
5. On the **Map** (`/?map`): wait 3–5 s for the imagery. Dots should be visible, CRITICAL dots
   should pulse, and clicking a dot should open the incident.
6. On **phone width** (about 375 px): the prompt has no dark side panel, the two-step rows stack,
   and the KPI names wrap.
7. In **WorkOS dashboard → Multi-factor**: it must still say **Optional**.

To reset the prompt for re-testing: DevTools → Application → Local Storage → delete
`atk.securityPrompt`.

---

## 5. Loose ends and follow-ups (none of these was requested)

1. **The production rollback at 14:05 IST**: find out who did it and why, then re-promote
   q843j58wi if the owner agrees (see §0).
2. **Stale data?** The live welcome popup says the latest incidents landed **Thu, 24 Sep 2026**,
   more than a month before 29 Oct. This is not from this work, but new incidents may not be
   reaching the site. Worth checking the ingest and sweep.
3. **Dead code to delete:**
   - `src/auth/CompleteProfile.jsx` (unused);
   - the "One last step" comment at `src/auth/AuthProvider.jsx:261`;
   - old sidebar CSS in `src/dashboard/dashboard.css` (lines 12–33, 226, 250–253, 397–402, 432);
   - `ICONS.sidebar` at `Dashboard.jsx:69`.
4. **Out-of-date doc text:** `docs/MFA-PASSKEYS.md` still describes the old corner card with
   the snooze in its 19 Oct row.
5. **Consent and welcome email** for hosted-page sign-ins that skip /?signup (see request 1,
   side effect).
6. **Globe imagery** black for a few seconds on first load (see request 5).
7. **Subscriber links** lost with the sidebar (see request 6).
8. **Prompt edge case:** a session with neither sign-in time gets the key "-". After one
   "Remind me later" it is never asked again on that browser.

## 6. Rules to keep

- The owner runs `vercel deploy --prod` and `vercel promote`. Claude's production deploys are
  blocked by auto mode. Always give the rollback command with a deploy.
- Two-step / MFA stays OPTIONAL in WorkOS.
- Never label Mohini as Founder; Aman Sehgal is the founder.
- Reply to the owner in plain English. The owner writes Hinglish but wants English replies.
