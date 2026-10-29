---
name: attacked-project-rules
description: Hard rules and working conventions for the Attacked.ai codebase (attackedmap.vercel.app). Use for any work in the ATTACKEDMAP repo, including UI changes, Supabase SQL or edge functions, deploys, emails, the Attack Map, the landing page and the Hub.
---

# Attacked.ai project rules

## Who you're working with
The owner, Mohini, is a non-technical founder. She often writes in Hinglish or Hindi, but always reply in plain English. Do the work for her rather than handing her steps. She prefers to see a preview or mockup, approve it, and only then have it built. Abstract multiple-choice questions don't help her; concrete visuals do.

## Hard constraints (never violate)
- Keep RLS disabled on data tables. Storage-bucket policies are fine.
- Never put service-role or secret keys in browser code (`src/`, `public/`, `index.html`).
- Don't touch the landing hero "Live sample" card.
- Don't reintroduce a light or white card mode on the Attack Map. Map cards stay dark.
- Brand colors are gold `#F5B800` (use `#8A6D00` for gold text on white) with Cormorant Garamond, Inter and JetBrains Mono. Never use crimson `#C41E3A`. Read the `attacked-brand-system` skill before building UI.

## Stack and deploy
- React 18 + Vite SPA with querystring routing in `src/main.jsx` (`?map`, `?hub`, `?pricing`, `?profile`, `?admin`, `?preview=public`).
- Production backend = Supabase `ovenyjguhkgiceddzwna`. It is not on GCP, even though the GCP code exists on some branches.
- Deploy with `npm run build` and then `vercel --prod --yes` (see `/attacked-ai:deploy`).
- Edge functions deploy only through the Supabase MCP, with inline source and `verify_jwt:false` (see `/attacked-ai:deploy-edge-fn`).
- Emails load images from the live Vercel URL, so changes to `public/` assets reach inboxes only after a Vercel deploy.

## Protect the egress quota
The free plan allows 5 GB of egress per billing cycle, and automated test loops caused a 402 lockout in October 2026. Never loop-reload the Attack Map or the full incidents query against the live project. Check health with `/attacked-ai:health` first.

## Verifying
Don't spin up local dev servers just for screenshots. Verify against the live URL with headless puppeteer-core (Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`). Before landing-page shots, seed `localStorage.attacked_welcome_seen=1`. The `live-site-verifier` agent does this.
