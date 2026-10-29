---
description: Build the Attacked.ai app and deploy it to production on Vercel
allowed-tools: Bash(npm run build:*), Bash(vercel:*), Bash(git status:*), Bash(git branch:*)
---

Deploy Attacked.ai to production (https://attackedmap.vercel.app).

1. Show the current git branch and `git status --short`. Production is built from whatever is checked out, so say which branch is about to go live. If it is not the branch the handoff notes name as the live line, stop and ask before deploying.
2. Run `npm run build`. If it fails, stop and explain the error in plain English.
3. Run `vercel --prod --yes`.
4. Report the deployment URL. Remind the owner that changed images in `public/` only show up in sent emails after this deploy.

Do not start a local dev or preview server. To check the result, use the `live-site-verifier` agent against the live URL.

Extra notes from the user: $ARGUMENTS
