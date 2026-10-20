# Migrations already applied on live

These SQL files were run on the live project (ovenyjguhkgiceddzwna) by hand, in the
Supabase SQL editor, between 2026-09-21 and 2026-09-30. They are kept for history.

They are NOT in `supabase/migrations/` because the local Docker stack applies that
folder to an EMPTY database: the first file here alters `identity.profiles`, which
only exists once the full schema is in. The full schema arrives as
`supabase/migrations/<timestamp>_baseline_live.sql` from `npm run local:dump`, and
that baseline already contains everything these files did.

`scripts/docker-local.mjs start` / `dump` move any such pre-baseline file here on
their own. Do not move them back.
