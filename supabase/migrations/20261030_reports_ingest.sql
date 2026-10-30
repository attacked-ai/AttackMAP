-- 20261030_reports_ingest.sql — the receiving end of a push from the incident
-- reporting project: it posts batches of rows to
--   POST /rest/v1/rpc/report_ingest  { p_key, p_table, p_rows: [...] }
-- (its pg_net extension does the posting), and this function writes them
-- into reports.*. Keyed like report_payload (reports.feed_keys); without a
-- valid key nothing is written. Child rows arrive with the upstream column
-- name incident_id, which becomes briefing_id here. Rows replace by primary
-- key (delete + insert), so a batch can be sent twice without harm.
-- Used for the first load on 2026-10-30; reports.sync_from_vault is the
-- ongoing refresh.
create or replace function public.report_ingest(p_key text, p_table text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = reports, public
as $$
declare
  r jsonb;
  n integer;
begin
  if not exists (
    select 1 from reports.feed_keys k
    where k.key_sha256 = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')
  ) then raise exception 'report_ingest: bad key' using errcode = '28000'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'report_ingest: p_rows must be a JSON array'; end if;
  select coalesce(jsonb_agg(case when e ? 'incident_id' then (e - 'incident_id') || jsonb_build_object('briefing_id', e->'incident_id') else e end), '[]'::jsonb)
    into r from jsonb_array_elements(p_rows) e;
  n := jsonb_array_length(r);
  if n = 0 then return jsonb_build_object('table', p_table, 'rows', 0); end if;

  case p_table
    when 'reporters' then
      delete from reports.reporters where code in (select e->>'code' from jsonb_array_elements(r) e);
      insert into reports.reporters select * from jsonb_populate_recordset(null::reports.reporters, r);
    when 'industries' then
      delete from reports.industries where slug in (select e->>'slug' from jsonb_array_elements(r) e);
      insert into reports.industries select * from jsonb_populate_recordset(null::reports.industries, r);
    when 'briefings' then
      -- replacing a briefing cascades to its children: send children after briefings
      delete from reports.briefings where id in (select e->>'id' from jsonb_array_elements(r) e);
      insert into reports.briefings select * from jsonb_populate_recordset(null::reports.briefings,
        (select jsonb_agg(e || jsonb_build_object('synced_at', now())) from jsonb_array_elements(r) e));
    when 'blast' then
      delete from reports.blast where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.blast select * from jsonb_populate_recordset(null::reports.blast, r);
    when 'sources' then
      delete from reports.sources where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.sources select * from jsonb_populate_recordset(null::reports.sources, r);
    when 'vendors' then
      delete from reports.vendors where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.vendors select * from jsonb_populate_recordset(null::reports.vendors, r);
    when 'vendor_controls' then
      delete from reports.vendor_controls where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.vendor_controls select * from jsonb_populate_recordset(null::reports.vendor_controls, r);
    when 'vendor_logos' then
      delete from reports.vendor_logos where vendor_id in (select (e->>'vendor_id')::bigint from jsonb_array_elements(r) e);
      insert into reports.vendor_logos select * from jsonb_populate_recordset(null::reports.vendor_logos, r);
    when 'controls' then
      delete from reports.controls where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.controls select * from jsonb_populate_recordset(null::reports.controls, r);
    when 'comparables' then
      delete from reports.comparables where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.comparables select * from jsonb_populate_recordset(null::reports.comparables, r);
    when 'causes' then
      delete from reports.causes where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.causes select * from jsonb_populate_recordset(null::reports.causes, r);
    when 'guard_map' then
      delete from reports.guard_map where id in (select (e->>'id')::bigint from jsonb_array_elements(r) e);
      insert into reports.guard_map select * from jsonb_populate_recordset(null::reports.guard_map, r);
    else
      raise exception 'report_ingest: unknown table %', p_table;
  end case;
  return jsonb_build_object('table', p_table, 'rows', n);
end
$$;
revoke all on function public.report_ingest(text, text, jsonb) from public;
grant execute on function public.report_ingest(text, text, jsonb) to anon, authenticated;
