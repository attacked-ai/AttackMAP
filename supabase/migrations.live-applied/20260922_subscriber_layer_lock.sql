-- Phase 2 of the backend: the subscriber layer becomes subscriber-only IN THE
-- DATABASE. Until this runs, blast_radius / adaptive_controls / peer_watchlist /
-- historical_analogues / sources are readable with the public anon key and the
-- paywall is only a client-side hide.
--
-- Run in the Supabase SQL editor (project ovenyjguhkgiceddzwna), Part A first,
-- Part B once the frontend that reads layer_counts(*) is deployed (commit
-- "Phase 2: counts via layer_counts, JWT on the map" or later). Part A is safe
-- at any time; Part B is the switch.
--
-- After Part B:
--   • anon / free readers:   rows in the five tables → none; counts → via
--                            public.incident_layer_counts / layer_counts(*)
--   • subscriber / admin:    rows as before, when the request carries their
--                            JWT (supabase-js does; the map forwards it too)
--   • the FastAPI service:   reads with the service role and applies the tier
--                            rule itself (api/app/db.py)
--   • ?preview=subscriber:   no longer shows rows (no JWT) — use a real
--                            subscriber account; the Subscribe switch is free.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART A — helpers (safe to run any time; nothing changes for readers yet)
-- ─────────────────────────────────────────────────────────────────────────

-- True for the calling user when profiles.tier is enterprise (= Subscriber) or admin.
create or replace function public.is_subscriber() returns boolean
language sql stable security definer set search_path = public, identity as $$
  select coalesce((select p.tier in ('enterprise','admin') from identity.profiles p where p.id = auth.uid()), false)
$$;
revoke all on function public.is_subscriber() from public;
grant execute on function public.is_subscriber() to anon, authenticated, service_role;

-- Per-incident counts of the subscriber layer, readable by everyone: the free
-- tier sees the SHAPE of what is locked, never the rows. postgres owns the base
-- tables and RLS is not forced, so this security_invoker=false view bypasses the
-- row policies below. (Explicit revoke/grant: CREATE VIEW would otherwise hand
-- anon ALL privileges through the default privileges on this project.)
create or replace view public.incident_layer_counts with (security_invoker = false) as
select i.id as incident_id,
  (select count(*) from sweep.sources              s where s.incident_id = i.id)::int as sources,
  (select count(*) from sweep.blast_radius         b where b.incident_id = i.id)::int as blast,
  (select count(*) from sweep.peer_watchlist       p where p.incident_id = i.id)::int as peers,
  (select count(*) from sweep.adaptive_controls    a where a.incident_id = i.id)::int as controls,
  (select count(*) from sweep.historical_analogues h where h.incident_id = i.id)::int as analogues
from sweep.incidents i;
revoke all on public.incident_layer_counts from public, anon, authenticated;
grant select on public.incident_layer_counts to anon, authenticated, service_role;

-- PostgREST computed relationship, so the dashboard can ask
--   incidents?select=id,headline,...,layer_counts(*)
-- in the same request it already makes.
create or replace function public.layer_counts(public.incidents)
returns setof public.incident_layer_counts rows 1 language sql stable as $$
  select * from public.incident_layer_counts where incident_id = $1.id
$$;
grant execute on function public.layer_counts(public.incidents) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

-- Check: every incident has a counts row and the function embeds.
-- select count(*) from public.incident_layer_counts;
-- curl "$SUPABASE_URL/rest/v1/incidents?select=id,layer_counts(*)&limit=2" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"

-- ─────────────────────────────────────────────────────────────────────────
-- PART B — the switch (run after the frontend reading layer_counts(*) is live)
-- ─────────────────────────────────────────────────────────────────────────
-- The five subscriber tables: SELECT only for subscribers/admins. sweep.incidents,
-- control_objectives and incident_updates stay public. The app_reader and
-- guard_uploader policies are untouched.

do $$
declare t text;
begin
  foreach t in array array['blast_radius','adaptive_controls','peer_watchlist','historical_analogues','sources'] loop
    execute format('drop policy if exists "anon select" on sweep.%I', t);
    execute format('drop policy if exists "subscriber select" on sweep.%I', t);
    execute format('create policy "subscriber select" on sweep.%I for select to anon, authenticated using (public.is_subscriber())', t);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Check as the public key: expect 0 rows, and counts still present.
-- curl "$SUPABASE_URL/rest/v1/blast_radius?select=id&limit=1"        -H "apikey: $ANON" -H "Authorization: Bearer $ANON"   → []
-- curl "$SUPABASE_URL/rest/v1/incidents?select=id,layer_counts(*)&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"   → counts
-- Roll back Part B:  create policy "anon select" on sweep.<t> for select to anon, authenticated using (true);  (× 5)
