-- 20261017_mfa_attempts.sql — a wrong-code counter for two-step verification.
--
-- The sign-in bridge (supabase/functions/workos-auth, /security routes) checks
-- authenticator-app codes when a reader turns two-step verification on or off.
-- Each check first reserves an attempt here, in one atomic statement, so
-- parallel requests cannot get past the limit (5 per 10 minutes); a correct
-- code clears the counter. Only the service role (the bridge) can call it.

create table if not exists public.mfa_attempts (
  user_id      uuid primary key,
  n            integer not null default 0,
  window_start timestamptz not null default now()
);
alter table public.mfa_attempts enable row level security;   -- no policies: no direct access
revoke all on table public.mfa_attempts from public, anon, authenticated;

-- p_ok = false: reserve one attempt, return how many were used in this window.
-- p_ok = true : a correct code — clear the counter, return 0.
create or replace function public._mfa_attempt(p_user uuid, p_ok boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  if p_ok then
    delete from public.mfa_attempts where user_id = p_user;
    return 0;
  end if;
  insert into public.mfa_attempts as a (user_id, n, window_start)
  values (p_user, 1, now())
  on conflict (user_id) do update
    set n            = case when a.window_start < now() - interval '10 minutes' then 1 else a.n + 1 end,
        window_start = case when a.window_start < now() - interval '10 minutes' then now() else a.window_start end
  returning n into v;
  return v;
end $$;
revoke all on function public._mfa_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function public._mfa_attempt(uuid, boolean) to service_role;
