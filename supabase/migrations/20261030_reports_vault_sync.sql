-- 20261030_reports_vault_sync.sql — two finishing touches for the reports schema.
--
-- 1. The public view is read-only for the API roles (Supabase's default
--    privileges had granted them everything on a new object in public).
revoke insert, update, delete, truncate, references, trigger on public.report_briefings_public from anon, authenticated;

-- 2. Sync without anyone typing the connection string: store it once in
--    Vault (Dashboard → Integrations → Vault → New secret, name
--    `incident_db_url`, value = the incident project's session-pooler
--    connection string) and run
--
--      select reports.sync_from_vault();            -- everything
--      select reports.sync_from_vault('logos');     -- one part
--
--    The secret never appears in logs or results; the same call can later be
--    scheduled with pg_cron so new briefings arrive on their own.
create or replace function reports.sync_from_vault(p_part text default 'all')
returns jsonb
language plpgsql
security definer
set search_path = reports, vault, public
as $$
declare conn text;
begin
  select decrypted_secret into conn from vault.decrypted_secrets where name = 'incident_db_url' order by created_at desc limit 1;
  if conn is null then raise exception 'Vault secret incident_db_url is not set'; end if;
  return reports.sync_from_incident_db(conn, p_part);
end
$$;
revoke all on function reports.sync_from_vault(text) from public, anon, authenticated;
