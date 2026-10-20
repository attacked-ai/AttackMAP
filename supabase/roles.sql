-- Roles of the live database (names, memberships, settings; passwords removed),
-- written by scripts/docker-local.mjs dump. The Supabase CLI applies this file
-- before the migrations on every db reset, so objects owned by custom roles
-- (e.g. intel_globe_owner) can be restored. Safe to commit.

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

CREATE ROLE "app_reader";
ALTER ROLE "app_reader" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN NOBYPASSRLS;
CREATE ROLE "intel_globe";
ALTER ROLE "intel_globe" WITH NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOBYPASSRLS CONNECTION LIMIT 3;
CREATE ROLE "intel_globe_owner";
ALTER ROLE "intel_globe_owner" WITH NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOBYPASSRLS;

ALTER ROLE "anon" SET "statement_timeout" TO '3s';

ALTER ROLE "authenticated" SET "statement_timeout" TO '8s';

ALTER ROLE "authenticator" SET "statement_timeout" TO '8s';

ALTER ROLE "intel_globe" SET "statement_timeout" TO '60s';
ALTER ROLE "intel_globe" SET "lock_timeout" TO '10s';
ALTER ROLE "intel_globe" SET "idle_in_transaction_session_timeout" TO '60s';

RESET ALL;

-- Local only: the migrations run as postgres (not a superuser here); it must be a
-- member of each custom role to transfer ownership to it.
GRANT "app_reader" TO "postgres";
GRANT "intel_globe" TO "postgres";
GRANT "intel_globe_owner" TO "postgres";
