-- Subscriber self-service switch (2026-09-21).
--
-- The Design Partner application flow is retired. "Subscribe" now means the
-- signed-in user opts into the subscriber tier themselves. The DB value is the
-- pre-existing 'enterprise' tier: it is already in the profiles.tier CHECK
-- constraint, and sync_subscription_tier() already promotes to it when a paid
-- plan goes active, so no constraint change is needed and a future Stripe
-- hookup lands on the same row. Admins are never touched.
--
-- Apply once in the Supabase SQL editor (project ovenyjguhkgiceddzwna).
-- The front end calls:  supabase.rpc('set_own_subscription', { p_on: true })
--
-- NOTE while you are here: identity.profiles has an own-row UPDATE policy
-- with no column restriction, so a signed-in user can already write their own
-- `tier` through PostgREST. This RPC is the sanctioned path; consider a
-- column-level revoke on tier for anon/authenticated afterwards.

create or replace function public.set_own_subscription(p_on boolean)
returns text
language plpgsql
security definer
set search_path to 'public', 'identity'
as $$
declare
  cur text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select tier into cur from identity.profiles where id = auth.uid();
  if cur is null then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  if cur = 'admin' then
    return cur;  -- admins already see everything; never demote
  end if;
  if p_on and cur = 'free' then
    update identity.profiles
       set tier = 'enterprise', approved_at = coalesce(approved_at, now()), updated_at = now()
     where id = auth.uid();
    return 'enterprise';
  elsif not p_on and cur = 'enterprise' then
    update identity.profiles
       set tier = 'free', updated_at = now()
     where id = auth.uid();
    return 'free';
  end if;
  return cur;
end;
$$;

revoke all on function public.set_own_subscription(boolean) from public, anon;
grant execute on function public.set_own_subscription(boolean) to authenticated;
