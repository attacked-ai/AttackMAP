-- 20261022_sessions.sql — the reader's signed-in devices.
--
-- Profile > Login and security lists every browser and phone where the reader
-- is signed in (one row per Supabase session) and can sign out any one of
-- them. The sessions live in auth.sessions, which PostgREST cannot read, so
-- the sign-in bridge (supabase/functions/workos-auth, /security/devices,
-- service role) goes through these two functions and nothing else. Only the
-- service role can call them; the bridge passes the id of the signed-in reader
-- (from the checked access token), never one typed by the page, so nobody can
-- see or end another reader's sessions. The raw user agent and the address
-- stop at the bridge: the page gets only "Mac · Safari" and the times.

-- The live sessions of one reader, newest activity first (at most 50).
-- last_active = the latest of updated_at (a token refresh), refreshed_at and
-- created_at (the sign-in); greatest() skips nulls. Expired sessions
-- (not_after in the past) are left out: the device cannot use them any more.
-- auth.sessions.refreshed_at is a timestamp WITHOUT time zone (the auth
-- server writes it in UTC); greatest() promotes it to timestamptz in the
-- session's time zone, so the function pins its time zone to UTC and the
-- answer does not depend on the connection. search_path is empty: every
-- name in the body is schema-qualified or built in.
create or replace function public._sessions_for(p_user uuid)
returns table(id uuid, created_at timestamptz, last_active timestamptz, user_agent text, ip text)
language sql security definer stable set search_path = '' set timezone = 'UTC' as $$
  select s.id, s.created_at,
         greatest(s.updated_at, s.refreshed_at, s.created_at) as last_active,
         s.user_agent, s.ip::text
  from auth.sessions s
  where s.user_id = p_user and (s.not_after is null or s.not_after > now())
  order by last_active desc nulls last, s.created_at desc
  limit 50
$$;
revoke all on function public._sessions_for(uuid) from public, anon, authenticated;
grant execute on function public._sessions_for(uuid) to service_role;

-- End ONE session of this reader: 1 when it was theirs and is now gone, 0 when
-- the id is nobody's or another reader's (nothing is touched then). The
-- session's refresh tokens are deleted explicitly, whether or not the foreign
-- key cascades, so that device cannot get a new access token; the access token
-- it already holds lapses on its own (up to an hour). Both deletes run in the
-- one call (one transaction), so a half-ended session is not possible.
create or replace function public._end_session(p_user uuid, p_session uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  delete from auth.refresh_tokens t
   using auth.sessions s
   where t.session_id = s.id and s.id = p_session and s.user_id = p_user;
  delete from auth.sessions where id = p_session and user_id = p_user;
  get diagnostics v = row_count;
  return v;
end $$;
revoke all on function public._end_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public._end_session(uuid, uuid) to service_role;
