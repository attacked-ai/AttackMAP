---
description: Safely deploy a Supabase edge function (pull deployed source, diff, deploy inline)
argument-hint: <function-name>
---

Deploy the Supabase edge function `$1` to project `ovenyjguhkgiceddzwna`.

There is no Supabase CLI or access token on this machine. The only deploy path is the Supabase MCP `deploy_edge_function` tool with the full source passed inline. Use the `supabase-attacked` MCP server from this plugin if it is connected. Otherwise use a Supabase MCP server that points at `ovenyjguhkgiceddzwna`, and confirm the project ref before you write anything.

1. Pull the currently deployed source with `get_edge_function`. Treat it as the source of truth, because local files under `supabase/functions/$1/` often drift from it.
2. Diff the deployed source against the local file. Summarize the differences and confirm which version the change should start from.
3. Make the change. Escape non-ASCII characters as `\uXXXX`.
4. Deploy with `verify_jwt: false` and every file passed inline.
5. Save what was deployed to `supabase/functions/$1/deployed.index.ts` and report the new version number.
6. If the function sends email, verify with a dry run where one exists (for example, POST `{"dryRun":true}` to daily-digest). Never send real mail as a test.
