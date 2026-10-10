-- ─────────────────────────────────────────────────────────────────────────
-- 01_supabase_compat.sql: prepare a Cloud SQL (PostgreSQL 17) database to take
-- the Attacked.ai schema and data exported from Supabase, unchanged.
--
-- Supabase is PostgreSQL plus a few pieces the app's SQL relies on. This file
-- recreates those pieces on plain Postgres so the restored tables, views,
-- functions, triggers and row-level-security policies keep working:
--   roles      anon / authenticated / service_role / authenticator (PostgREST
--              switches into these per request, exactly as on Supabase)
--   auth       auth.users + auth.identities (the accounts), auth.uid() /
--              auth.role() / auth.email() / auth.jwt() read from the request JWT,
--              plus the tables our own sign-in needs (sessions, email codes,
--              OAuth states): see api/app/gcp_auth
--   net        net.http_post / net.http_get: pg_net does not exist on Cloud SQL.
--              These stand-ins QUEUE the request in outbox.requests; the API's
--              /api/jobs/outbox (Cloud Scheduler, every minute) sends them.
--   vault      vault.secrets + vault.decrypted_secrets (plain table, owner-only)
--   extensions the `extensions` schema Supabase installs pgcrypto/uuid-ossp in
--
-- Run ONCE as the Cloud SQL admin user (postgres) on the target database,
-- before the restore. Safe to run again. deploy/gcp/db/migrate.sh runs it.
-- Passwords are NOT set here: setup.sh sets them from Secret Manager.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Roles ------------------------------------------------------------------
do $$
declare r text;
begin
  -- attacked_owner owns every restored object. anon/authenticated/service_role
  -- are the PostgREST request roles. authenticator is what PostgREST logs in as.
  foreach r in array array['attacked_owner', 'anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
  -- attacked_api: the FastAPI service's own login (sign-in tables, outbox).
  if not exists (select 1 from pg_roles where rolname = 'attacked_api') then
    create role attacked_api login;
  end if;
  -- Supabase-internal roles named in the dump's GRANT lines. Created empty so
  -- those lines apply instead of failing; they can log in to nothing.
  foreach r in array array['supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
      'supabase_realtime_admin', 'supabase_replication_admin', 'supabase_read_only_user',
      'dashboard_user', 'pgbouncer', 'pgsodium_keyholder', 'pgsodium_keyiduser', 'pgsodium_keymaker'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

grant anon, authenticated, service_role to authenticator;
-- The admin user must be able to act as the owner (pg_restore --role=attacked_owner),
-- and the owner creates the schemas.
grant attacked_owner to current_user;
do $$
begin
  execute format('grant create, connect, temporary on database %I to attacked_owner', current_database());
  execute format('grant connect on database %I to authenticator, attacked_api', current_database());
end $$;
-- PostgreSQL 15+ no longer lets everyone create in public; the restore does.
grant usage, create on schema public to attacked_owner;
grant usage on schema public to anon, authenticated, service_role, attacked_api;

-- service_role skips row-level security on Supabase (BYPASSRLS). Cloud SQL may
-- refuse that attribute to its admin user; then service_role inherits the owner
-- role instead, and table owners skip RLS too. Either way the result matches.
do $$
begin
  begin
    execute 'alter role service_role bypassrls';
  exception when insufficient_privilege then
    raise notice 'BYPASSRLS refused: service_role inherits attacked_owner instead';
    execute 'grant attacked_owner to service_role';
  end;
end $$;

-- Supabase's request timeouts, so a runaway query cannot hold a connection.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';

-- 2. extensions schema --------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role, attacked_api, attacked_owner;

-- Everything below is created as, and owned by, attacked_owner.
set role attacked_owner;

-- 3. auth: accounts and the request-JWT helpers ------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, attacked_api;

-- Column names match Supabase's auth.users, so the export copies straight in
-- and restored functions that read auth.users (signup trigger, admin views)
-- keep working. Only the columns the app uses are kept.
create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  aud                 text not null default 'authenticated',
  role                text not null default 'authenticated',
  email               text,
  email_confirmed_at  timestamptz,
  last_sign_in_at     timestamptz,
  raw_app_meta_data   jsonb not null default '{}'::jsonb,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  banned_until        timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists users_email_key on auth.users (lower(email)) where deleted_at is null;

-- One row per way a person signs in (google, email).
create table if not exists auth.identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  provider         text not null,
  provider_id      text not null,
  identity_data    jsonb not null default '{}'::jsonb,
  email            text,
  last_sign_in_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (provider, provider_id)
);
create index if not exists identities_user_id_idx on auth.identities (user_id);

-- Our sign-in sessions. The browser holds a random token in the HttpOnly
-- __session cookie; only its SHA-256 is stored. expires_at is ABSOLUTE
-- (30 days from sign-in by default, SESSION_DAYS on the API).
create table if not exists auth.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  token_hash    bytea not null unique,
  method        text not null,                 -- google | email | dev
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  user_agent    text,
  ip            inet
);
create index if not exists sessions_user_id_idx on auth.sessions (user_id);
create index if not exists sessions_expires_at_idx on auth.sessions (expires_at);

-- Email sign-in codes: hash only, 10-minute life, 5 tries, single use.
create table if not exists auth.email_codes (
  id           bigserial primary key,
  email        text not null,
  code_hash    bytea not null,
  meta         jsonb,                           -- the sign-up form, applied on first sign-in
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0,
  consumed_at  timestamptz,
  ip           inet
);
create index if not exists email_codes_email_idx on auth.email_codes (lower(email), created_at desc);
create index if not exists email_codes_ip_idx on auth.email_codes (ip, created_at desc);

-- Google sign-in round trips (state -> PKCE verifier + nonce), 10-minute life.
-- In the database, not a cookie: Firebase Hosting forwards only __session.
create table if not exists auth.oauth_states (
  state          text primary key,
  code_verifier  text not null,
  nonce          text not null,
  redirect_to    text not null default '/?dashboard',
  created_at     timestamptz not null default now()
);

-- Supabase-compatible helpers. PostgREST puts the verified JWT's claims in
-- request.jwt.claims; RLS policies and functions call these.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role, attacked_api;

-- The API reads and writes the sign-in tables; the browser never can (the auth
-- schema is not exposed through PostgREST and anon/authenticated get nothing).
grant select, insert, update on auth.users, auth.identities to attacked_api;
grant select, insert, update, delete on auth.sessions, auth.email_codes, auth.oauth_states to attacked_api;
grant usage on sequence auth.email_codes_id_seq to attacked_api;

-- 4. net: pg_net stand-ins that queue HTTP calls ------------------------------
create schema if not exists outbox;
create table if not exists outbox.requests (
  id               bigserial primary key,
  method           text not null default 'POST',
  url              text not null,
  headers          jsonb not null default '{}'::jsonb,
  body             jsonb,
  params           jsonb not null default '{}'::jsonb,
  timeout_ms       int not null default 5000,
  created_at       timestamptz not null default now(),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  done_at          timestamptz,
  last_status      int,
  last_error       text
);
create index if not exists outbox_pending_idx on outbox.requests (next_attempt_at) where done_at is null;
grant usage on schema outbox to attacked_api;
grant select, update, delete on outbox.requests to attacked_api;

create schema if not exists net;

-- Same signatures as pg_net, so restored triggers and cron jobs compile and run.
create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language sql security definer set search_path = '' as $$
  insert into outbox.requests (method, url, headers, body, params, timeout_ms)
  values ('POST', url, coalesce(headers, '{}'::jsonb), body, coalesce(params, '{}'::jsonb), timeout_milliseconds)
  returning id
$$;

create or replace function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint
language sql security definer set search_path = '' as $$
  insert into outbox.requests (method, url, headers, params, timeout_ms)
  values ('GET', url, coalesce(headers, '{}'::jsonb), coalesce(params, '{}'::jsonb), timeout_milliseconds)
  returning id
$$;

-- Callable from triggers whatever role fired them; never exposed as an RPC
-- (net is not one of PostgREST's schemas).
grant usage on schema net to anon, authenticated, service_role;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, integer), net.http_get(text, jsonb, jsonb, integer)
  to anon, authenticated, service_role;

-- 5. vault: named secrets, owner-only ----------------------------------------
create schema if not exists vault;
create table if not exists vault.secrets (
  id           uuid primary key default gen_random_uuid(),
  name         text unique not null,
  secret       text not null,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
  from vault.secrets;
revoke all on vault.secrets, vault.decrypted_secrets from public;

reset role;
