


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "cms";


ALTER SCHEMA "cms" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "content";


ALTER SCHEMA "content" OWNER TO "postgres";


COMMENT ON SCHEMA "content" IS 'Editorial — explainer library, reporter roster, captured leads.';



CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE SCHEMA IF NOT EXISTS "identity";


ALTER SCHEMA "identity" OWNER TO "postgres";


COMMENT ON SCHEMA "identity" IS 'Accounts, plans, entitlements and applications.';



CREATE SCHEMA IF NOT EXISTS "intel";


ALTER SCHEMA "intel" OWNER TO "postgres";


COMMENT ON SCHEMA "intel" IS 'Sweeper helper schema added by db/sweeper/0001_intel_additions.sql: cross-writer dedup, the intel_routine write guard and write checks for the Intelligence routine. Not the Intelligence database schema. Not meant to be exposed through the API.';



CREATE SCHEMA IF NOT EXISTS "map";


ALTER SCHEMA "map" OWNER TO "postgres";


COMMENT ON SCHEMA "map" IS 'Attack Map read models and daily snapshot cache.';



COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE SCHEMA IF NOT EXISTS "ops";


ALTER SCHEMA "ops" OWNER TO "postgres";


COMMENT ON SCHEMA "ops" IS 'Operations — delivery, notifications, recipients. Backend only.';



CREATE SCHEMA IF NOT EXISTS "reference";


ALTER SCHEMA "reference" OWNER TO "postgres";


COMMENT ON SCHEMA "reference" IS 'Controlled vocabularies shared across domains.';



CREATE SCHEMA IF NOT EXISTS "sweep";


ALTER SCHEMA "sweep" OWNER TO "postgres";


COMMENT ON SCHEMA "sweep" IS 'Daily intelligence pipeline — runs, incidents, enrichment, coverage proof.';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."incident_origin" AS ENUM (
    'daily_sweep',
    'historical_import',
    'manual',
    'vendor_intel',
    'intel_routine'
);


ALTER TYPE "public"."incident_origin" OWNER TO "postgres";


CREATE TYPE "sweep"."change_class" AS ENUM (
    'initial',
    'corroboration',
    'enrichment',
    'correction',
    'contradiction',
    'scope_expansion',
    'scope_reduction',
    'escalation',
    'recovery',
    'closure',
    'reopen'
);


ALTER TYPE "sweep"."change_class" OWNER TO "postgres";


CREATE TYPE "sweep"."consequence_state" AS ENUM (
    'not_applicable',
    'no_signal',
    'suspected',
    'reported',
    'confirmed_active',
    'worsening',
    'stable',
    'contained',
    'recovering',
    'resolved',
    'residual_open',
    'unknown'
);


ALTER TYPE "sweep"."consequence_state" OWNER TO "postgres";


CREATE TYPE "sweep"."evidence_state" AS ENUM (
    'confirmed',
    'reported',
    'inferred',
    'disputed',
    'disproven',
    'calculated',
    'scenario',
    'unknown'
);


ALTER TYPE "sweep"."evidence_state" OWNER TO "postgres";


CREATE TYPE "sweep"."freshness_state" AS ENUM (
    'current',
    'review_due',
    'stale',
    'updating',
    'superseded',
    'disputed',
    'closed'
);


ALTER TYPE "sweep"."freshness_state" OWNER TO "postgres";


CREATE TYPE "sweep"."lifecycle_stage" AS ENUM (
    'signal',
    'verified',
    'active',
    'escalating',
    'stabilising',
    'recovering',
    'residual',
    'closed',
    'reopened'
);


ALTER TYPE "sweep"."lifecycle_stage" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "intel"."entity_tokens"("p_name" "text") RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
    WITH w AS (
        SELECT s.tok, s.ord
        FROM pg_catalog.regexp_split_to_table(
                 pg_catalog.lower(
                     pg_catalog.regexp_replace(
                         pg_catalog.regexp_replace(COALESCE(p_name, ''), '[''’‘`]', '', 'g'),
                         '\m([[:alpha:]])\.', '\1', 'g')),
                 '[[:space:][:punct:]“”«»–—·•・、。，（）]+') WITH ORDINALITY AS s(tok, ord)
        WHERE s.tok <> ''
          AND s.tok <> ALL (ARRAY[
                'the', 'and', 'for', 'of',
                'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
                'ltd', 'limited', 'plc', 'llc', 'llp', 'lp',
                'group', 'holding', 'holdings',
                'sa', 'ag', 'nv', 'bv', 'se', 'ab', 'as', 'asa', 'oy', 'oyj',
                'gmbh', 'spa', 'srl', 'sarl', 'kk', 'pty', 'bhd', 'tbk']::text[])
    )
    SELECT CASE
        WHEN EXISTS (SELECT 1 FROM w WHERE pg_catalog.char_length(w.tok) >= 3)
            THEN ARRAY(SELECT DISTINCT w.tok FROM w
                       WHERE pg_catalog.char_length(w.tok) >= 3 ORDER BY w.tok)
        WHEN EXISTS (SELECT 1 FROM w)
            THEN ARRAY[(SELECT pg_catalog.string_agg(w.tok, '' ORDER BY w.ord) FROM w)]
        ELSE '{}'::text[]
    END
$$;


ALTER FUNCTION "intel"."entity_tokens"("p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "intel"."entity_tokens"("p_name" "text") IS 'Victim words used for cross-writer dedup. No index or constraint depends on it.';



CREATE OR REPLACE FUNCTION "intel"."find_duplicates"("p_entity" "text", "p_event_date" "date", "p_primary_category" "text" DEFAULT NULL::"text", "p_primary_subcategory_code" "text" DEFAULT NULL::"text", "p_disclosure_date" "date" DEFAULT NULL::"date", "p_report_ref" "text" DEFAULT NULL::"text", "p_window_days" integer DEFAULT 45, "p_min_overlap" numeric DEFAULT 0.5, "p_exclude_id" bigint DEFAULT NULL::bigint, "p_require_category" boolean DEFAULT true) RETURNS TABLE("incident_id" bigint, "match_level" "text", "score" numeric, "entity_overlap" numeric, "exact_victim" boolean, "day_gap" integer, "same_category" boolean, "same_subcategory" boolean, "is_intel_routine" boolean, "origin" "text", "report_ref" "text", "entity" "text", "headline" "text", "event_date" "date", "disclosure_date" "date", "primary_category" "text", "primary_subcategory_code" "text")
    LANGUAGE "sql" STABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
    WITH q AS (
        SELECT intel.entity_tokens(p_entity)                                              AS toks,
               intel.victim_key(p_entity)                                                 AS vkey,
               COALESCE(p_event_date, p_disclosure_date)                                  AS qdate,
               GREATEST(COALESCE(p_window_days, 45), 0)                                   AS win,
               COALESCE(p_min_overlap, 0.5)                                               AS min_ov,
               COALESCE(p_require_category, true)                                         AS req_cat,
               NULLIF(pg_catalog.btrim(p_report_ref), '')                                 AS rref,
               NULLIF(pg_catalog.upper(pg_catalog.btrim(p_primary_category)), '')         AS cat,
               NULLIF(pg_catalog.upper(pg_catalog.btrim(p_primary_subcategory_code)), '') AS subcat
    ),
    cand AS MATERIALIZED (
        SELECT i.id, i.origin::text AS origin_txt, i.report_ref, i.entity, i.headline,
               i.event_date, i.disclosure_date,
               i.primary_category, i.primary_subcategory_code,
               (q.rref IS NOT NULL AND i.report_ref = q.rref)                             AS ref_hit,
               LEAST(abs(i.event_date - p_event_date),
                     abs(i.disclosure_date - p_disclosure_date),
                     abs(COALESCE(i.event_date, i.disclosure_date, i.incident_day) - q.qdate)) AS gap
        FROM sweep.incidents i
        CROSS JOIN q
        WHERE (p_exclude_id IS NULL OR i.id <> p_exclude_id)
          AND (   (q.rref IS NOT NULL AND i.report_ref = q.rref)
               OR abs(i.event_date - p_event_date) <= q.win
               OR abs(i.disclosure_date - p_disclosure_date) <= q.win
               OR abs(COALESCE(i.event_date, i.disclosure_date, i.incident_day) - q.qdate) <= q.win)
    ),
    graded AS (
        SELECT c.*,
               intel.token_overlap(t.etoks, q.toks)                                       AS ov,
               (q.vkey IS NOT NULL AND pg_catalog.array_to_string(t.etoks, ' ') = q.vkey) AS exact_v,
               (q.cat IS NOT NULL
                AND pg_catalog.upper(pg_catalog.btrim(c.primary_category)) = q.cat)       AS same_cat,
               (q.cat IS NULL
                OR NULLIF(pg_catalog.btrim(c.primary_category), '') IS NULL)              AS cat_unknown,
               (q.subcat IS NOT NULL
                AND pg_catalog.upper(pg_catalog.btrim(c.primary_subcategory_code)) = q.subcat) AS same_sub,
               q.win, q.min_ov, q.req_cat
        FROM cand c
        CROSS JOIN q
        CROSS JOIN LATERAL (SELECT intel.entity_tokens(c.entity) AS etoks) t
    )
    SELECT g.id,
           CASE WHEN g.ref_hit     THEN 'same_report'
                WHEN g.same_cat    THEN 'same_event'
                WHEN g.cat_unknown THEN 'type_unknown'
                ELSE 'same_victim_window' END,
           round(COALESCE(g.ov, 0)
                 + CASE WHEN g.gap <= 2 THEN 0.30 WHEN g.gap <= 14 THEN 0.15
                        WHEN g.gap <= 60 THEN 0.05 ELSE 0 END
                 + CASE WHEN g.same_sub THEN 0.10 ELSE 0 END, 3),
           round(g.ov, 3),
           g.exact_v,
           g.gap,
           g.same_cat,
           g.same_sub,
           COALESCE(g.origin_txt = 'intel_routine', false),
           g.origin_txt,
           g.report_ref,
           g.entity,
           g.headline,
           g.event_date,
           g.disclosure_date,
           g.primary_category,
           g.primary_subcategory_code
    FROM graded g
    WHERE g.ref_hit
       OR (    g.ov > 0
           AND g.ov >= g.min_ov
           AND g.gap <= g.win
           AND (g.same_cat OR g.cat_unknown OR g.exact_v OR NOT g.req_cat))
    ORDER BY CASE WHEN g.ref_hit THEN 0 WHEN g.same_cat THEN 1 WHEN g.cat_unknown THEN 2 ELSE 3 END,
             3 DESC, g.id
$$;


ALTER FUNCTION "intel"."find_duplicates"("p_entity" "text", "p_event_date" "date", "p_primary_category" "text", "p_primary_subcategory_code" "text", "p_disclosure_date" "date", "p_report_ref" "text", "p_window_days" integer, "p_min_overlap" numeric, "p_exclude_id" bigint, "p_require_category" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "intel"."find_duplicates"("p_entity" "text", "p_event_date" "date", "p_primary_category" "text", "p_primary_subcategory_code" "text", "p_disclosure_date" "date", "p_report_ref" "text", "p_window_days" integer, "p_min_overlap" numeric, "p_exclude_id" bigint, "p_require_category" boolean) IS 'Candidate duplicates for one event: closest event/disclosure date gap <= p_window_days, victim word overlap >= p_min_overlap, same primary category (or one side unknown, or exact victim) unless p_require_category is false. Levels: same_report, same_event, type_unknown, same_victim_window. The caller decides.';



CREATE OR REPLACE FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
    v_ref text := NULLIF(pg_catalog.btrim(p_report_ref), '');
    v_n   integer := 0;
BEGIN
    IF p_incident_id IS NULL OR v_ref IS NULL THEN
        RAISE EXCEPTION 'incident id and report_ref are both required';
    END IF;
    IF pg_catalog.char_length(v_ref) > 64 OR v_ref !~ '^ATK-[A-Za-z0-9][A-Za-z0-9._-]*$' THEN
        RAISE EXCEPTION 'report_ref % does not look like an Incident Reporting id', v_ref;
    END IF;

    IF EXISTS (SELECT 1 FROM sweep.incidents WHERE id = p_incident_id AND report_ref = v_ref) THEN
        RETURN true;
    END IF;

    IF EXISTS (SELECT 1 FROM sweep.incidents WHERE report_ref = v_ref AND id <> p_incident_id) THEN
        RETURN false;
    END IF;

    BEGIN
        UPDATE sweep.incidents
           SET report_ref = v_ref
         WHERE id = p_incident_id
           AND report_ref IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
        -- Another session linked the same report to a different row meanwhile.
        RETURN false;
    END;

    IF v_n = 1 THEN
        RETURN true;
    END IF;
    RETURN EXISTS (SELECT 1 FROM sweep.incidents
                   WHERE id = p_incident_id AND report_ref = v_ref);
END
$_$;


ALTER FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") IS 'Sets sweep.incidents.report_ref only while it is NULL and no other row holds that report_ref; returns false instead of raising when it cannot link. The one change the Intelligence routine may make to a row written by another pipeline.';



CREATE OR REPLACE FUNCTION "intel"."publish_globe"("p_payload" "jsonb", "p_payload_sha256" "text", "p_intel_run_id" bigint, "p_force_new_pin" boolean) RETURNS TABLE("outcome" "text", "sweeper_incident_id" bigint, "sweep_run_id" bigint, "match_level" "text", "other_id" bigint, "dropped_keys" "jsonb", "secondaries_dropped" integer, "dropped_removed" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'pg_temp'
    SET "lock_timeout" TO '10s'
    AS $_$
#variable_conflict use_column
DECLARE
  c_tz        constant text := 'Asia/Kolkata';
  -- Decision I-1 (Samarth, 7 Oct 2026): 42 industries only. These are the Sweeper ids that the "slugs" of
  -- config/industry_crosswalk.json reach: the Digital Twin's 40 (ids 1 to 40) plus 44 Government and 45 Education.
  -- Ids 41, 42, 43, 46 and 47 exist in reference.industries but the routine never writes them. The suite
  -- tests/part_b/test_globe.py compares this list with the crosswalk.
  c_industry_ids constant integer[] := ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
                                                  21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 44, 45];
  v_ref       text;
  v_inc       jsonb;
  v_dup       record;
  v_has_dup   boolean;
  v_pin       bigint;
  v_run       bigint;
  v_n         integer;
  v_changed   integer := 0;
  v_secs      jsonb;
  v_conf      text;
  v_sec_all   integer;
  v_dropped   jsonb;
  v_removed   boolean := false;
  v_delete    boolean;
  v_bad       text;
  v_match     text;
  v_other     bigint;
  v_list      text;
  v_cap       integer;
BEGIN
  -- 1. Hash and shape.
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'INTEL_GLOBE_PAYLOAD: the payload must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex') IS DISTINCT FROM p_payload_sha256 THEN
    RAISE EXCEPTION 'INTEL_GLOBE_HASH: the payload does not match its hash' USING ERRCODE = '22023';
  END IF;
  IF p_intel_run_id IS NULL OR p_intel_run_id <= 0 THEN
    RAISE EXCEPTION 'INTEL_GLOBE_PAYLOAD: an Intelligence run id is required' USING ERRCODE = '22023';
  END IF;
  v_ref := p_payload ->> 'report_ref';
  v_inc := p_payload -> 'incident';
  IF p_payload ->> 'format' IS DISTINCT FROM 'b-globe-1' THEN
    v_bad := 'format must be b-globe-1';
  ELSIF v_ref IS NULL OR char_length(v_ref) > 64 OR v_ref !~ '^ATK-[A-Za-z0-9][A-Za-z0-9._-]*$' THEN
    v_bad := 'report_ref must look like an Incident Reporting id';
  ELSIF v_inc IS NULL OR jsonb_typeof(v_inc) <> 'object' THEN
    v_bad := 'incident must be an object';
  ELSIF nullif(btrim(v_inc ->> 'headline'), '') IS NULL OR nullif(btrim(v_inc ->> 'entity'), '') IS NULL THEN
    v_bad := 'incident needs a headline and an entity';
  ELSIF coalesce(v_inc ->> 'event_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        OR (v_inc ->> 'disclosure_date' IS NOT NULL AND v_inc ->> 'disclosure_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
    v_bad := 'event_date (and disclosure_date when given) must be YYYY-MM-DD';
  ELSIF coalesce(v_inc ->> 'primary_category', '') !~ '^(CYB|DAT|ENV|FIN|GEO|OPS|PHY|PPL|REG|REP|STR|TEC|TPR)$'
        OR coalesce(v_inc ->> 'primary_subcategory_code', '') !~ '^[A-Z]{3}-[A-Z0-9]{2,4}$'
        OR left(v_inc ->> 'primary_subcategory_code', 3) <> v_inc ->> 'primary_category' THEN
    v_bad := 'primary_category and primary_subcategory_code must be GUARD codes that agree';
  ELSIF coalesce(v_inc ->> 'severity', '') !~ '^[1-5]$' THEN
    v_bad := 'severity must be 1 to 5';
  ELSIF v_inc ? 'secondary_mappings' AND jsonb_typeof(v_inc -> 'secondary_mappings') <> 'array' THEN
    v_bad := 'secondary_mappings must be an array';
  ELSIF v_inc ? 'secondary_mappings'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_inc -> 'secondary_mappings') e WHERE jsonb_typeof(e) <> 'object') THEN
    v_bad := 'every secondary_mappings element must be an object';
  ELSIF upper(v_inc ->> 'confidence') IS NOT NULL AND upper(v_inc ->> 'confidence') NOT IN ('HIGH', 'MEDIUM', 'LOW') THEN
    -- S16.5: sweep.incidents.confidence is HIGH, MEDIUM, LOW or NULL (incidents_confidence_check).
    v_bad := 'confidence must be High, Medium or Low (any case), or absent';
  ELSIF p_payload::text ~ '"(hook_[a-z_]*|image_prompt)": ' THEN
    v_bad := 'hook_* and image_prompt are never written';
  ELSIF coalesce(jsonb_typeof(v_inc -> 'industry_id'), 'null') <> 'null'
        OR coalesce(jsonb_typeof(v_inc -> 'industry'), 'null') <> 'null' THEN
    -- G-52: both null (or absent), or one row of reference.industries, id and exact name together.
    IF jsonb_typeof(v_inc -> 'industry_id') IS DISTINCT FROM 'number' OR jsonb_typeof(v_inc -> 'industry') IS DISTINCT FROM 'string'
       OR (v_inc ->> 'industry_id') !~ '^[1-9][0-9]{0,8}$' THEN
      v_bad := 'industry_id and industry must be one row of reference.industries (both or neither)';
    ELSIF NOT EXISTS (SELECT 1 FROM reference.industries x
                       WHERE x.id = (v_inc ->> 'industry_id')::bigint AND x.industry = v_inc ->> 'industry'
                         AND x.id = ANY (c_industry_ids)) THEN
      -- Decision I-1: a row of reference.industries, and one of the 42 (c_industry_ids), id and exact name together.
      v_bad := 'industry_id and industry must be one of the 42 industries of config/industry_crosswalk.json, a row of reference.industries (both or neither)';
    END IF;
  END IF;
  IF v_bad IS NULL THEN
    FOR v_list, v_cap IN SELECT * FROM (VALUES ('blast_radius', 20), ('peer_watchlist', 12), ('sources', 400),
                                               ('control_objectives', 12), ('adaptive_controls', 48),
                                               ('historical_analogues', 10)) AS l(n, cap) LOOP
      IF p_payload ? v_list AND jsonb_typeof(p_payload -> v_list) <> 'array' THEN
        v_bad := v_list || ' must be an array';
      ELSIF jsonb_array_length(coalesce(p_payload -> v_list, '[]'::jsonb)) > v_cap THEN
        v_bad := format('%s has %s rows (at most %s)', v_list, jsonb_array_length(p_payload -> v_list), v_cap);
      ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> v_list, '[]'::jsonb)) e
                     WHERE jsonb_typeof(e) <> 'object' OR coalesce(char_length(e ->> 'key'), 0) NOT BETWEEN 1 AND 200)
            OR (SELECT count(*) <> count(DISTINCT e ->> 'key') FROM jsonb_array_elements(coalesce(p_payload -> v_list, '[]'::jsonb)) e) THEN
        v_bad := v_list || ': every row needs a key of 1 to 200 characters, unique in the list';
      END IF;
      EXIT WHEN v_bad IS NOT NULL;
    END LOOP;
  END IF;
  IF v_bad IS NULL AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'blast_radius', '[]'::jsonb)) e
        WHERE coalesce(e ->> 'exposure_group', '') NOT IN ('competitive_peer', 'supply_chain', 'customer_counterparty',
                                                           'internal', 'regulatory', 'financial_market')
           OR coalesce(e ->> 'sev', '') !~ '^[1-5]$' OR nullif(btrim(e ->> 'name'), '') IS NULL) THEN
    v_bad := 'blast_radius rows need a name, one of the six exposure groups and sev 1 to 5';
  END IF;
  IF v_bad IS NULL AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'sources', '[]'::jsonb)) e
        WHERE coalesce(e ->> 'url', '') !~* '^https?://') THEN
    v_bad := 'every source url must start with https:// or http://';
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'INTEL_GLOBE_PAYLOAD: %', v_bad USING ERRCODE = '22023';
  END IF;

  -- One write per report at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('intel.publish_globe:' || v_ref, 0));

  -- Confidence as the Sweeper stores it (S16.5): HIGH, MEDIUM, LOW or NULL. The payload keeps its own casing.
  v_conf := upper(v_inc ->> 'confidence');

  -- Secondary mappings: the 5 with the highest confidence, in payload order, written with the Newsroom's key names
  -- (S16.4): category <- cat, subcategory_code <- subcat, subcategory_name <- name, confidence in upper case, and why
  -- only when the element has a non-empty one. Nothing is made up; a missing value is a missing key.
  SELECT count(*) INTO v_sec_all FROM jsonb_array_elements(coalesce(v_inc -> 'secondary_mappings', '[]'::jsonb));
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                    'category', s.e ->> 'cat', 'subcategory_code', s.e ->> 'subcat', 'subcategory_name', s.e ->> 'name',
                    'confidence', upper(s.e ->> 'confidence'), 'why', nullif(btrim(s.e ->> 'why'), '')))
                  ORDER BY s.rk, s.ord), '[]'::jsonb) INTO v_secs
    FROM (SELECT e, ord, rk, row_number() OVER (ORDER BY rk, ord) AS rn
            FROM (SELECT e, ord, CASE lower(e ->> 'confidence') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END AS rk
                    FROM jsonb_array_elements(coalesce(v_inc -> 'secondary_mappings', '[]'::jsonb)) WITH ORDINALITY AS x(e, ord)) y) s
   WHERE s.rn <= 5;

  -- 2. Duplicates (db/sweeper/0001 note 3).
  SELECT d.* INTO v_dup
    FROM intel.find_duplicates(p_entity => v_inc ->> 'entity', p_event_date => (v_inc ->> 'event_date')::date,
                               p_primary_category => v_inc ->> 'primary_category',
                               p_primary_subcategory_code => v_inc ->> 'primary_subcategory_code',
                               p_disclosure_date => (v_inc ->> 'disclosure_date')::date, p_report_ref => v_ref) d
   LIMIT 1;
  v_has_dup := FOUND;

  IF v_has_dup AND v_dup.match_level = 'same_report' THEN
    IF NOT v_dup.is_intel_routine THEN
      -- The report is linked to a Newsroom row already: first writer wins.
      RETURN QUERY SELECT 'linked_existing'::text, v_dup.incident_id, NULL::bigint, 'same_report'::text, v_dup.incident_id,
                          '[]'::jsonb, 0, false;
      RETURN;
    END IF;
    v_pin := v_dup.incident_id;
    v_match := 'same_report';
  ELSIF v_has_dup AND v_dup.match_level = 'same_event' AND NOT v_dup.is_intel_routine AND NOT coalesce(p_force_new_pin, false) THEN
    IF intel.link_report_to_incident(v_dup.incident_id, v_ref) THEN
      RETURN QUERY SELECT 'linked_existing'::text, v_dup.incident_id, NULL::bigint, 'same_event'::text, v_dup.incident_id,
                          '[]'::jsonb, 0, false;
    ELSE
      RETURN QUERY SELECT 'held_possible_duplicate'::text, NULL::bigint, NULL::bigint, 'same_event'::text, v_dup.incident_id,
                          '[]'::jsonb, 0, false;
    END IF;
    RETURN;
  ELSIF v_has_dup AND NOT coalesce(p_force_new_pin, false) THEN
    RETURN QUERY SELECT 'held_possible_duplicate'::text, NULL::bigint, NULL::bigint, v_dup.match_level, v_dup.incident_id,
                        '[]'::jsonb, 0, false;
    RETURN;
  ELSE
    v_match := CASE WHEN v_has_dup THEN v_dup.match_level ELSE 'none' END;
  END IF;
  v_other := CASE WHEN v_has_dup AND v_match <> 'same_report' THEN v_dup.incident_id END;

  -- 3. The pin: insert ours, or update ours in place.
  IF v_pin IS NULL THEN
    INSERT INTO ops.runs AS r (generated_at, uploaded_at, writer, intel_run_ref)
    VALUES (now(), now(), 'intel_routine', p_intel_run_id::text)
    ON CONFLICT (intel_run_ref) WHERE intel_run_ref IS NOT NULL DO UPDATE SET uploaded_at = EXCLUDED.uploaded_at
    RETURNING r.id INTO v_run;
    INSERT INTO sweep.incidents AS i (
      sweep_id, origin, report_ref, headline, summary, entity, sector, location_name, country, latitude, longitude,
      event_date, disclosure_date, primary_category, primary_subcategory_code, primary_subcategory_name, severity,
      severity_rationale, confidence, incident_day, industry, industry_id, article_body, secondary_mappings,
      image_url, image_source, image_credit, image_prompt, image_updated_at)
    VALUES (
      v_run, 'intel_routine', v_ref, v_inc ->> 'headline', v_inc ->> 'summary', v_inc ->> 'entity', v_inc ->> 'sector',
      v_inc ->> 'location_name', v_inc ->> 'country', (v_inc ->> 'latitude')::numeric, (v_inc ->> 'longitude')::numeric,
      (v_inc ->> 'event_date')::date, (v_inc ->> 'disclosure_date')::date, v_inc ->> 'primary_category',
      v_inc ->> 'primary_subcategory_code', v_inc ->> 'primary_subcategory_name', (v_inc ->> 'severity')::integer,
      v_inc ->> 'severity_rationale', v_conf, (now() AT TIME ZONE c_tz)::date, v_inc ->> 'industry',
      (v_inc ->> 'industry_id')::bigint,
      v_inc ->> 'article_body', v_secs, NULL, NULL, NULL, NULL, NULL)
    RETURNING i.id INTO v_pin;
    v_changed := 1;
  ELSE
    SELECT i.sweep_id INTO v_run FROM sweep.incidents i WHERE i.id = v_pin;
    UPDATE sweep.incidents i SET
      headline = v_inc ->> 'headline', summary = v_inc ->> 'summary', entity = v_inc ->> 'entity', sector = v_inc ->> 'sector',
      location_name = v_inc ->> 'location_name', country = v_inc ->> 'country',
      latitude = (v_inc ->> 'latitude')::numeric, longitude = (v_inc ->> 'longitude')::numeric,
      event_date = (v_inc ->> 'event_date')::date, disclosure_date = (v_inc ->> 'disclosure_date')::date,
      primary_category = v_inc ->> 'primary_category', primary_subcategory_code = v_inc ->> 'primary_subcategory_code',
      primary_subcategory_name = v_inc ->> 'primary_subcategory_name', severity = (v_inc ->> 'severity')::integer,
      severity_rationale = v_inc ->> 'severity_rationale', confidence = v_conf,
      article_body = v_inc ->> 'article_body', secondary_mappings = v_secs,
      industry = v_inc ->> 'industry', industry_id = (v_inc ->> 'industry_id')::bigint
     WHERE i.id = v_pin AND i.origin::text = 'intel_routine'
       AND (i.headline, i.summary, i.entity, i.sector, i.location_name, i.country, i.latitude, i.longitude, i.event_date,
            i.disclosure_date, i.primary_category, i.primary_subcategory_code, i.primary_subcategory_name, i.severity,
            i.severity_rationale, i.confidence, i.article_body, i.secondary_mappings, i.industry, i.industry_id)
           IS DISTINCT FROM
           (v_inc ->> 'headline', v_inc ->> 'summary', v_inc ->> 'entity', v_inc ->> 'sector', v_inc ->> 'location_name',
            v_inc ->> 'country', (v_inc ->> 'latitude')::numeric, (v_inc ->> 'longitude')::numeric,
            (v_inc ->> 'event_date')::date, (v_inc ->> 'disclosure_date')::date, v_inc ->> 'primary_category',
            v_inc ->> 'primary_subcategory_code', v_inc ->> 'primary_subcategory_name', (v_inc ->> 'severity')::integer,
            v_inc ->> 'severity_rationale', v_conf, v_inc ->> 'article_body', v_secs,
            v_inc ->> 'industry', (v_inc ->> 'industry_id')::bigint);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed + v_n;
  END IF;

  -- 4. Child rows, upserted on (incident_id, intel_key); unchanged rows are not touched.
  INSERT INTO sweep.blast_radius AS b (incident_id, writer, intel_key, exposure_group, name, type, country, latitude,
                                       longitude, reason, impact_score, impact_rationale, transmission_mechanism,
                                       impact_horizon, recommended_action_for_them)
  SELECT v_pin, 'intel_routine', x.key, x.exposure_group, x.name, x.type, x.country, x.latitude, x.longitude, x.reason,
         x.sev * 2, x.impact_rationale, x.transmission_mechanism, x.impact_horizon, x.recommended_action_for_them
    FROM jsonb_to_recordset(coalesce(p_payload -> 'blast_radius', '[]'::jsonb))
         AS x(key text, exposure_group text, name text, type text, country text, latitude numeric, longitude numeric,
              reason text, sev integer, impact_rationale text, transmission_mechanism text, impact_horizon text,
              recommended_action_for_them text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    exposure_group = EXCLUDED.exposure_group, name = EXCLUDED.name, type = EXCLUDED.type, country = EXCLUDED.country,
    latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, reason = EXCLUDED.reason,
    impact_score = EXCLUDED.impact_score, impact_rationale = EXCLUDED.impact_rationale,
    transmission_mechanism = EXCLUDED.transmission_mechanism, impact_horizon = EXCLUDED.impact_horizon,
    recommended_action_for_them = EXCLUDED.recommended_action_for_them
   WHERE b.writer = 'intel_routine'
     AND (b.exposure_group, b.name, b.type, b.country, b.latitude, b.longitude, b.reason, b.impact_score, b.impact_rationale,
          b.transmission_mechanism, b.impact_horizon, b.recommended_action_for_them)
         IS DISTINCT FROM
         (EXCLUDED.exposure_group, EXCLUDED.name, EXCLUDED.type, EXCLUDED.country, EXCLUDED.latitude, EXCLUDED.longitude,
          EXCLUDED.reason, EXCLUDED.impact_score, EXCLUDED.impact_rationale, EXCLUDED.transmission_mechanism,
          EXCLUDED.impact_horizon, EXCLUDED.recommended_action_for_them);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  INSERT INTO sweep.peer_watchlist AS b (incident_id, writer, intel_key, name, country, latitude, longitude, exposure_reason)
  SELECT v_pin, 'intel_routine', x.key, x.name, x.country, x.latitude, x.longitude, x.exposure_reason
    FROM jsonb_to_recordset(coalesce(p_payload -> 'peer_watchlist', '[]'::jsonb))
         AS x(key text, name text, country text, latitude numeric, longitude numeric, exposure_reason text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    name = EXCLUDED.name, country = EXCLUDED.country, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
    exposure_reason = EXCLUDED.exposure_reason
   WHERE b.writer = 'intel_routine'
     AND (b.name, b.country, b.latitude, b.longitude, b.exposure_reason)
         IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.country, EXCLUDED.latitude, EXCLUDED.longitude, EXCLUDED.exposure_reason);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  INSERT INTO sweep.sources AS b (incident_id, writer, intel_key, title, url, publisher)
  SELECT v_pin, 'intel_routine', x.key, x.title, x.url, x.publisher
    FROM jsonb_to_recordset(coalesce(p_payload -> 'sources', '[]'::jsonb)) AS x(key text, title text, url text, publisher text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    title = EXCLUDED.title, url = EXCLUDED.url, publisher = EXCLUDED.publisher
   WHERE b.writer = 'intel_routine'
     AND (b.title, b.url, b.publisher) IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.url, EXCLUDED.publisher);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  INSERT INTO sweep.control_objectives AS b (incident_id, writer, intel_key, objective_id, statement)
  SELECT v_pin, 'intel_routine', x.key, x.objective_id, x.statement
    FROM jsonb_to_recordset(coalesce(p_payload -> 'control_objectives', '[]'::jsonb)) AS x(key text, objective_id text, statement text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    objective_id = EXCLUDED.objective_id, statement = EXCLUDED.statement
   WHERE b.writer = 'intel_routine'
     AND (b.objective_id, b.statement) IS DISTINCT FROM (EXCLUDED.objective_id, EXCLUDED.statement);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  -- kind stays NULL until preflight S16.5 confirms the Newsroom vocabulary.
  INSERT INTO sweep.adaptive_controls AS b (incident_id, writer, intel_key, control_id, parent_mc_id, statement, rationale, kind)
  SELECT v_pin, 'intel_routine', x.key, x.control_id, x.parent_mc_id, x.statement, x.rationale, NULL
    FROM jsonb_to_recordset(coalesce(p_payload -> 'adaptive_controls', '[]'::jsonb))
         AS x(key text, control_id text, parent_mc_id text, statement text, rationale text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    control_id = EXCLUDED.control_id, parent_mc_id = EXCLUDED.parent_mc_id, statement = EXCLUDED.statement,
    rationale = EXCLUDED.rationale, kind = EXCLUDED.kind
   WHERE b.writer = 'intel_routine'
     AND (b.control_id, b.parent_mc_id, b.statement, b.rationale, b.kind)
         IS DISTINCT FROM (EXCLUDED.control_id, EXCLUDED.parent_mc_id, EXCLUDED.statement, EXCLUDED.rationale, EXCLUDED.kind);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  INSERT INTO sweep.historical_analogues AS b (incident_id, writer, intel_key, event_name, entity, year, summary, outcome)
  SELECT v_pin, 'intel_routine', x.key, x.event_name, x.entity, x.year, x.summary, x.outcome
    FROM jsonb_to_recordset(coalesce(p_payload -> 'historical_analogues', '[]'::jsonb))
         AS x(key text, event_name text, entity text, year integer, summary text, outcome text)
  ON CONFLICT (incident_id, intel_key) WHERE intel_key IS NOT NULL DO UPDATE SET
    event_name = EXCLUDED.event_name, entity = EXCLUDED.entity, year = EXCLUDED.year, summary = EXCLUDED.summary,
    outcome = EXCLUDED.outcome
   WHERE b.writer = 'intel_routine'
     AND (b.event_name, b.entity, b.year, b.summary, b.outcome)
         IS DISTINCT FROM (EXCLUDED.event_name, EXCLUDED.entity, EXCLUDED.year, EXCLUDED.summary, EXCLUDED.outcome);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_changed := v_changed + v_n;

  -- 5. Stale keys: routine child rows of our pin whose key is not in the payload.
  SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_dropped FROM (
    SELECT 'blast_radius:' || c.intel_key AS k FROM sweep.blast_radius c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'blast_radius', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
    UNION ALL
    SELECT 'peer_watchlist:' || c.intel_key FROM sweep.peer_watchlist c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'peer_watchlist', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
    UNION ALL
    SELECT 'sources:' || c.intel_key FROM sweep.sources c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'sources', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
    UNION ALL
    SELECT 'control_objectives:' || c.intel_key FROM sweep.control_objectives c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'control_objectives', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
    UNION ALL
    SELECT 'adaptive_controls:' || c.intel_key FROM sweep.adaptive_controls c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'adaptive_controls', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
    UNION ALL
    SELECT 'historical_analogues:' || c.intel_key FROM sweep.historical_analogues c
     WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'historical_analogues', '[]'::jsonb)) e WHERE e ->> 'key' = c.intel_key)
  ) d;

  -- With db/sweeper/0003 (approved, applied by S4) the owner holds DELETE on the
  -- six child tables, and the stale rows of our own pin are removed here.
  v_delete := has_table_privilege('intel_globe_owner', 'sweep.blast_radius', 'DELETE')
              AND has_table_privilege('intel_globe_owner', 'sweep.peer_watchlist', 'DELETE')
              AND has_table_privilege('intel_globe_owner', 'sweep.sources', 'DELETE')
              AND has_table_privilege('intel_globe_owner', 'sweep.control_objectives', 'DELETE')
              AND has_table_privilege('intel_globe_owner', 'sweep.adaptive_controls', 'DELETE')
              AND has_table_privilege('intel_globe_owner', 'sweep.historical_analogues', 'DELETE');
  IF v_delete AND jsonb_array_length(v_dropped) > 0 THEN
    DELETE FROM sweep.blast_radius c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('blast_radius:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    DELETE FROM sweep.peer_watchlist c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('peer_watchlist:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    DELETE FROM sweep.sources c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('sources:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    DELETE FROM sweep.control_objectives c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('control_objectives:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    DELETE FROM sweep.adaptive_controls c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('adaptive_controls:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    DELETE FROM sweep.historical_analogues c WHERE c.incident_id = v_pin AND c.writer = 'intel_routine'
       AND ('historical_analogues:' || c.intel_key) IN (SELECT jsonb_array_elements_text(v_dropped));
    GET DIAGNOSTICS v_n = ROW_COUNT; v_changed := v_changed + v_n;
    v_removed := true;
  END IF;

  RETURN QUERY SELECT CASE WHEN v_match = 'same_report' THEN CASE WHEN v_changed > 0 THEN 'updated' ELSE 'unchanged' END
                           ELSE 'inserted' END,
                      v_pin, v_run, v_match, v_other, v_dropped, v_sec_all - jsonb_array_length(v_secs), v_removed;
END
$_$;


-- local only (scripts/docker-local.mjs): the new owner below needs CREATE on the schema for the transfer
GRANT USAGE, CREATE ON SCHEMA "intel" TO "intel_globe_owner";
ALTER FUNCTION "intel"."publish_globe"("p_payload" "jsonb", "p_payload_sha256" "text", "p_intel_run_id" bigint, "p_force_new_pin" boolean) OWNER TO "intel_globe_owner";


COMMENT ON FUNCTION "intel"."publish_globe"("p_payload" "jsonb", "p_payload_sha256" "text", "p_intel_run_id" bigint, "p_force_new_pin" boolean) IS 'Part B: writes the globe version of one published report (payload b-globe-1, checked against its hash): updates our own pin, links to a Newsroom row of the same event (first writer wins), holds a possible duplicate for a person, or inserts our pin and its child rows. Only routine rows are written.';



CREATE OR REPLACE FUNCTION "intel"."tg_routine_write_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
    c_routine constant text := 'intel_routine';
    v_tag_col text;
    v_key_col text;
    v_child   boolean;
    v_old     jsonb;
    v_new     jsonb;
BEGIN
    IF current_user::text NOT IN ('intel_routine', 'intel_globe_owner') THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    v_tag_col := TG_ARGV[0];
    v_key_col := NULLIF(TG_ARGV[1], '');
    v_child   := COALESCE(TG_ARGV[2], '') = 'child';

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old := pg_catalog.to_jsonb(OLD);
        IF (v_old ->> v_tag_col) IS DISTINCT FROM c_routine THEN
            RAISE EXCEPTION '% may only change routine rows: % on %.% id % refused (% is %)',
                current_user, TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, v_old ->> 'id',
                v_tag_col, COALESCE(v_old ->> v_tag_col, 'NULL')
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
    END IF;

    v_new := pg_catalog.to_jsonb(NEW);
    IF (v_new ->> v_tag_col) IS DISTINCT FROM c_routine THEN
        RAISE EXCEPTION '% must write % = intel_routine on %.% (got %)',
            current_user, v_tag_col, TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(v_new ->> v_tag_col, 'NULL')
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_key_col IS NOT NULL AND (v_new ->> v_key_col) IS NULL THEN
        RAISE EXCEPTION 'routine rows on %.% need % (the idempotency key)',
            TG_TABLE_SCHEMA, TG_TABLE_NAME, v_key_col
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_child AND NOT EXISTS (
            SELECT 1 FROM sweep.incidents i
             WHERE i.id = (v_new ->> 'incident_id')::bigint
               AND i.origin::text = c_routine) THEN
        RAISE EXCEPTION 'routine rows on %.% must sit under an intel_routine incident (incident_id %)',
            TG_TABLE_SCHEMA, TG_TABLE_NAME, COALESCE(v_new ->> 'incident_id', 'NULL')
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END
$$;


ALTER FUNCTION "intel"."tg_routine_write_guard"() OWNER TO "postgres";


COMMENT ON FUNCTION "intel"."tg_routine_write_guard"() IS 'BEFORE row trigger (intel_routine_write_guard) on sweep.incidents, the six child tables, sweep.incident_updates and ops.runs. Returns at once for every login except intel_routine and intel_globe_owner; for those it refuses writes to rows they do not own, untagged rows, rows without their key, and child rows under a non-routine incident.';



CREATE OR REPLACE FUNCTION "intel"."token_overlap"("p_a" "text"[], "p_b" "text"[]) RETURNS numeric
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
    SELECT CASE
        WHEN p_a IS NULL OR p_b IS NULL
          OR pg_catalog.cardinality(p_a) = 0 OR pg_catalog.cardinality(p_b) = 0
            THEN NULL
        ELSE (SELECT count(*) FROM (SELECT unnest(p_a) INTERSECT SELECT unnest(p_b)) x)::numeric
             / LEAST(pg_catalog.cardinality(p_a), pg_catalog.cardinality(p_b))
    END
$$;


ALTER FUNCTION "intel"."token_overlap"("p_a" "text"[], "p_b" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "intel"."victim_key"("p_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
    SELECT NULLIF(pg_catalog.array_to_string(intel.entity_tokens(p_name), ' '), '')
$$;


ALTER FUNCTION "intel"."victim_key"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "map"."rebuild_all_snapshots"() RETURNS TABLE("days_built" integer, "incidents_covered" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d date; n integer := 0;
BEGIN
  FOR d IN SELECT DISTINCT i.incident_day FROM sweep.incidents i
           WHERE i.incident_day IS NOT NULL ORDER BY 1
  LOOP
    PERFORM map.rebuild_daily_snapshot(d);
    n := n + 1;
  END LOOP;
  RETURN QUERY SELECT n, coalesce(sum(s.incident_count),0)::bigint FROM map.daily_snapshots s;
END $$;


ALTER FUNCTION "map"."rebuild_all_snapshots"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "map"."rebuild_daily_snapshot"("p_day" "date") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_payload jsonb;
  v_teasers jsonb;
  v_count   integer;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.severity DESC NULLS LAST, f.id DESC), '[]'::jsonb),
         count(*)
    INTO v_payload, v_count
  FROM map.incident_feed f
  WHERE f.incident_day = p_day;

  SELECT coalesce(jsonb_agg(t), '[]'::jsonb) INTO v_teasers
  FROM (
    SELECT jsonb_build_object(
             'id', f.id, 'headline', f.headline, 'entity', f.entity,
             'country', f.country, 'severity', f.severity,
             'primary_category', f.primary_category,
             'latitude', f.latitude, 'longitude', f.longitude) AS t
    FROM map.incident_feed f
    WHERE f.incident_day = p_day
    ORDER BY f.severity DESC NULLS LAST, f.id DESC
    LIMIT 5
  ) s;

  INSERT INTO map.daily_snapshots (date_key, payload, teasers, incident_count, created_at, updated_at)
  VALUES (p_day::text, v_payload, v_teasers, v_count, now(), now())
  ON CONFLICT (date_key) DO UPDATE
    SET payload        = EXCLUDED.payload,
        teasers        = EXCLUDED.teasers,
        incident_count = EXCLUDED.incident_count,
        updated_at     = now();

  RETURN v_count;
END $$;


ALTER FUNCTION "map"."rebuild_daily_snapshot"("p_day" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "map"."rebuild_daily_snapshot"("p_day" "date") IS 'Rebuilds one day of the Attack Map cache. Call after each sweep for the affected day.';



CREATE OR REPLACE FUNCTION "map"."refresh_touched_days"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR d IN SELECT DISTINCT incident_day FROM new_rows WHERE incident_day IS NOT NULL
    LOOP PERFORM map.rebuild_daily_snapshot(d); END LOOP;

  ELSIF TG_OP = 'UPDATE' THEN
    FOR d IN SELECT DISTINCT day FROM (
               SELECT incident_day AS day FROM new_rows
               UNION SELECT incident_day FROM old_rows) x
             WHERE day IS NOT NULL
    LOOP PERFORM map.rebuild_daily_snapshot(d); END LOOP;

  ELSIF TG_OP = 'DELETE' THEN
    FOR d IN SELECT DISTINCT incident_day FROM old_rows WHERE incident_day IS NOT NULL
    LOOP PERFORM map.rebuild_daily_snapshot(d); END LOOP;
  END IF;
  RETURN NULL;
END $$;


ALTER FUNCTION "map"."refresh_touched_days"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_html_esc"("t" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select replace(replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;


ALTER FUNCTION "public"."_html_esc"("t" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_is_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(
    (select tier = 'admin' from public.profiles where id = auth.uid()),
    false
  );
$$;


ALTER FUNCTION "public"."_is_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."_is_admin"() IS 'Returns true if the current authenticated user has tier=admin in profiles.';



CREATE OR REPLACE FUNCTION "public"."_report_stub"("p_ref" "text", "p_title" "text", "p_subtitle" "text", "p_summary" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'
    || _html_esc(p_title) || ' · Preview</title><style>body{margin:0;background:#fff;color:#1A1A1A;font:16px/1.6 Inter,system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:72px 22px}'
    || '.k{font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#8A6D00}h1{font-size:34px;line-height:1.15;letter-spacing:-.02em;margin:14px 0 10px}'
    || '.s{color:#4A463E;font-size:18px}.lock{margin-top:36px;border-top:1px solid #E6E2D8;padding-top:28px}.lock h2{font-size:20px;margin:0 0 8px}'
    || 'button{margin-top:16px;background:#FCBD00;color:#0f0f0f;border:0;padding:12px 20px;font:700 12px/1 Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}'
    || '@media print{body>*{display:none!important}body::before{content:"Download PDF is available to Attacked.ai subscribers.";display:block;padding:40px;font:600 16px Inter,sans-serif}}</style></head>'
    || '<body><main data-locked="preview"><div class="k">' || _html_esc(p_ref) || '</div><h1>' || _html_esc(p_title) || '</h1>'
    || case when coalesce(p_subtitle, '') <> '' then '<p class="s">' || _html_esc(p_subtitle) || '</p>' else '' end
    || case when coalesce(p_summary, '') <> '' then '<p>' || _html_esc(p_summary) || '</p>' else '' end
    || '<section class="lock" id="r-lock"><h2>The full briefing is for subscribers</h2><p>The complete analysis, sources and the Download PDF are part of an Attacked.ai subscription.</p>'
    || '<button type="button" data-subscribe onclick="subscribe()">Subscribe to read the full briefing</button></section></main>'
    || '<script>function subscribe(){ try{ window.top.location.href=''/?subscribe''; }catch(e){ location.href=''/?subscribe''; } } window.subscribe=subscribe;</script></body></html>'
$$;


ALTER FUNCTION "public"."_report_stub"("p_ref" "text", "p_title" "text", "p_subtitle" "text", "p_summary" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_approve_partner_application"("p_application_id" bigint, "p_notes" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  updated_id bigint;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  update public.partner_applications
     set status = 'approved',
         decided_at = now(),
         decided_by = auth.uid(),
         decision_notes = coalesce(p_notes, decision_notes)
   where id = p_application_id
     and status = 'pending'
   returning id into updated_id;

  if updated_id is null then
    raise exception 'Application % not found or not pending', p_application_id
      using errcode = 'P0002';
  end if;

  return updated_id;
end;
$$;


ALTER FUNCTION "public"."admin_approve_partner_application"("p_application_id" bigint, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_approve_vendor_application"("p_application_id" bigint, "p_listing_tier" "text" DEFAULT 'basic'::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  updated_id bigint;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  if p_listing_tier not in ('basic','featured','premium') then
    raise exception 'Invalid listing_tier %', p_listing_tier
      using errcode = '22023';
  end if;

  update public.vendor_applications
     set status = 'approved',
         listing_tier = p_listing_tier,
         decided_at = now(),
         decided_by = auth.uid(),
         decision_notes = coalesce(p_notes, decision_notes)
   where id = p_application_id
     and status = 'pending'
   returning id into updated_id;

  if updated_id is null then
    raise exception 'Vendor application % not found or not pending', p_application_id
      using errcode = 'P0002';
  end if;

  return updated_id;
end;
$$;


ALTER FUNCTION "public"."admin_approve_vendor_application"("p_application_id" bigint, "p_listing_tier" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_dashboard_stats"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  result jsonb;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  result := jsonb_build_object(
    -- ── USERS ────────────────────────────────────────────────────────
    'users', jsonb_build_object(
      'total',           (select count(*) from public.profiles),
      'new_today',       (select count(*) from auth.users where created_at::date = current_date),
      'new_7d',          (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'new_30d',         (select count(*) from auth.users where created_at >= now() - interval '30 days'),
      'active_7d',       (select count(*) from auth.users where last_sign_in_at >= now() - interval '7 days'),
      'subscribed',      (select count(*) from public.profiles where email_subscribed = true),
      'by_tier',         (
        select jsonb_object_agg(tier, cnt)
        from (
          select tier, count(*) as cnt
          from public.profiles
          group by tier
        ) t
      )
    ),

    -- ── APPLICATIONS ────────────────────────────────────────────────
    'applications', jsonb_build_object(
      'partner_pending',   (select count(*) from public.partner_applications where status = 'pending'),
      'partner_approved',  (select count(*) from public.partner_applications where status = 'approved'),
      'partner_rejected',  (select count(*) from public.partner_applications where status = 'rejected'),
      'partner_total',     (select count(*) from public.partner_applications),
      'vendor_pending',    (select count(*) from public.vendor_applications where status = 'pending'),
      'vendor_approved',   (select count(*) from public.vendor_applications where status = 'approved'),
      'vendor_rejected',   (select count(*) from public.vendor_applications where status = 'rejected'),
      'vendor_total',      (select count(*) from public.vendor_applications)
    ),

    -- ── INCIDENTS ───────────────────────────────────────────────────
    'incidents', jsonb_build_object(
      'total',           (select count(*) from public.incidents),
      'last_day',        (select count(*) from public.incidents where incident_day = current_date - 1),
      'last_7d',         (select count(*) from public.incidents where incident_day >= current_date - 7),
      'last_30d',        (select count(*) from public.incidents where incident_day >= current_date - 30),
      'tagged_industry', (select count(*) from public.incidents where industry is not null),
      'untagged',        (select count(*) from public.incidents where industry is null),
      'by_severity',     (
        select jsonb_object_agg(severity::text, cnt)
        from (
          select severity, count(*) as cnt
          from public.incidents
          where severity is not null
          group by severity
        ) s
      )
    ),

    -- ── SWEEPS ──────────────────────────────────────────────────────
    'sweeps', jsonb_build_object(
      'total',        (select count(*) from public.sweeps),
      'last_upload',  (select max(generated_at) from public.sweeps),
      'last_7d',      (select count(*) from public.sweeps where generated_at >= now() - interval '7 days')
    ),

    -- ── EMAIL ───────────────────────────────────────────────────────
    'email', jsonb_build_object(
      'notify_log_count',  (select count(*) from public.sweep_notifications_log),
      'last_digest_date',  (select max(sweep_date) from public.sweep_notifications_log),
      'last_digest_sent_at',(select max(notified_at) from public.sweep_notifications_log)
    ),

    -- ── FEEDBACK ────────────────────────────────────────────────────
    'feedback', jsonb_build_object(
      'total_submissions', (select count(*) from public.partner_feedback)
    ),

    'computed_at', now()
  );

  return result;
end;
$$;


ALTER FUNCTION "public"."admin_dashboard_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_report"("p_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  delete from public.hub_reports where id = p_id;
end $$;


ALTER FUNCTION "public"."admin_delete_report"("p_id" bigint) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."hub_reports" (
    "id" bigint NOT NULL,
    "ref" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "subtitle" "text",
    "summary" "text",
    "industry" "text",
    "primary_category" "text",
    "severity" smallint,
    "incident_id" bigint,
    "hero_image_url" "text",
    "author" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "data" "jsonb",
    "brand" "jsonb",
    "html" "text",
    "published_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "html_preview" "text",
    CONSTRAINT "hub_reports_severity_check" CHECK ((("severity" >= 1) AND ("severity" <= 5))),
    CONSTRAINT "hub_reports_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text"])))
);


ALTER TABLE "public"."hub_reports" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_get_report"("p_id" bigint) RETURNS SETOF "public"."hub_reports"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select * from public.hub_reports where id = p_id and _is_admin()
$$;


ALTER FUNCTION "public"."admin_get_report"("p_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_feedback"() RETURNS TABLE("id" bigint, "user_id" "uuid", "email" "text", "tier_at_submission" "text", "q_one_thing_pay" "text", "q_killer_feature" "text", "q_free_inbox" "text", "q_report_tease_stop" "text", "q_vendor_signposting" "text", "q_firehose_volume" "text", "additional_notes" "text", "submitted_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select
    f.id, f.user_id, f.email, f.tier_at_submission,
    f.q_one_thing_pay, f.q_killer_feature, f.q_free_inbox,
    f.q_report_tease_stop, f.q_vendor_signposting, f.q_firehose_volume,
    f.additional_notes, f.submitted_at
  from public.partner_feedback f
  where public._is_admin()
  order by f.submitted_at desc;
$$;


ALTER FUNCTION "public"."admin_list_feedback"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_reports"() RETURNS TABLE("id" bigint, "ref" "text", "status" "text", "title" "text", "subtitle" "text", "summary" "text", "industry" "text", "primary_category" "text", "severity" smallint, "incident_id" bigint, "hero_image_url" "text", "author" "text", "tags" "text"[], "published_at" timestamp with time zone, "updated_at" timestamp with time zone, "created_at" timestamp with time zone, "has_html" boolean, "has_data" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select id, ref, status, title, subtitle, summary, industry, primary_category, severity, incident_id, hero_image_url, author, tags, published_at, updated_at, created_at, html is not null, data is not null
    from public.hub_reports where _is_admin() order by updated_at desc
$$;


ALTER FUNCTION "public"."admin_list_reports"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_users"() RETURNS TABLE("id" "uuid", "email" "text", "tier" "text", "company" "text", "role" "text", "email_subscribed" boolean, "approved_at" timestamp with time zone, "created_at" timestamp with time zone, "last_sign_in_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select
    p.id,
    p.email,
    p.tier,
    p.company,
    p.role,
    p.email_subscribed,
    p.approved_at,
    u.created_at,
    u.last_sign_in_at
  from public.profiles p
  left join auth.users u on u.id = p.id
  where public._is_admin()
  order by u.created_at desc nulls last;
$$;


ALTER FUNCTION "public"."admin_list_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reject_partner_application"("p_application_id" bigint, "p_notes" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  updated_id bigint;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  update public.partner_applications
     set status = 'rejected',
         decided_at = now(),
         decided_by = auth.uid(),
         decision_notes = coalesce(p_notes, decision_notes)
   where id = p_application_id
     and status in ('pending','approved')
   returning id into updated_id;

  if updated_id is null then
    raise exception 'Application % not found', p_application_id
      using errcode = 'P0002';
  end if;

  return updated_id;
end;
$$;


ALTER FUNCTION "public"."admin_reject_partner_application"("p_application_id" bigint, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reject_vendor_application"("p_application_id" bigint, "p_notes" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  updated_id bigint;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  update public.vendor_applications
     set status = 'rejected',
         decided_at = now(),
         decided_by = auth.uid(),
         decision_notes = coalesce(p_notes, decision_notes)
   where id = p_application_id
     and status in ('pending','approved')
   returning id into updated_id;

  if updated_id is null then
    raise exception 'Vendor application % not found', p_application_id
      using errcode = 'P0002';
  end if;

  return updated_id;
end;
$$;


ALTER FUNCTION "public"."admin_reject_vendor_application"("p_application_id" bigint, "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_incident_media"("p_source" "text", "p_incident_id" bigint, "p_image_url" "text", "p_article_body" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not _is_admin() then
    raise exception 'not authorised';
  end if;
  -- One incidents table since the 2026-07-28 restructure; p_source is kept for
  -- the existing admin UI call signature. A manual picture wins over the
  -- generated one (image_source = 'manual').
  update sweep.incidents
     set image_url        = nullif(btrim(p_image_url), ''),
         image_source     = case when nullif(btrim(p_image_url), '') is null then null else 'manual' end,
         image_updated_at = now(),
         article_body     = coalesce(nullif(btrim(p_article_body), ''), article_body)
   where id = p_incident_id;
end;
$$;


ALTER FUNCTION "public"."admin_set_incident_media"("p_source" "text", "p_incident_id" bigint, "p_image_url" "text", "p_article_body" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_report_status"("p_id" bigint, "p_status" "text") RETURNS SETOF "public"."hub_reports"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare r public.hub_reports;
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  if p_status not in ('draft','published') then raise exception 'bad status'; end if;
  update public.hub_reports
     set status = p_status,
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
         updated_at = now()
   where id = p_id returning * into r;
  return next r;
end $$;


ALTER FUNCTION "public"."admin_set_report_status"("p_id" bigint, "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_user_tier"("p_user_id" "uuid", "p_new_tier" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  updated uuid;
begin
  if not public._is_admin() then
    raise exception 'Forbidden — admin tier required' using errcode = '42501';
  end if;

  if p_new_tier not in ('free','partner','enterprise','vendor','admin') then
    raise exception 'Invalid tier %', p_new_tier using errcode = '22023';
  end if;

  update public.profiles
     set tier = p_new_tier,
         approved_at = case when p_new_tier in ('partner','enterprise','vendor','admin')
                            then coalesce(approved_at, now())
                            else null
                       end
   where id = p_user_id
   returning id into updated;

  if updated is null then
    raise exception 'User % not found', p_user_id using errcode = 'P0002';
  end if;

  return updated;
end;
$$;


ALTER FUNCTION "public"."admin_set_user_tier"("p_user_id" "uuid", "p_new_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_upsert_report"("p" "jsonb") RETURNS SETOF "public"."hub_reports"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare r public.hub_reports; v_tags text[];
begin
  if not _is_admin() then raise exception 'not authorised'; end if;
  select coalesce(array_agg(x), '{}') into v_tags from jsonb_array_elements_text(coalesce(p->'tags', '[]'::jsonb)) x;
  if (p->>'id') is null then
    insert into public.hub_reports (ref, title, subtitle, summary, industry, primary_category, severity, incident_id, hero_image_url, author, tags, data, brand, html, html_preview, created_by)
    values (p->>'ref', p->>'title', p->>'subtitle', p->>'summary', p->>'industry', p->>'primary_category', (p->>'severity')::smallint, (p->>'incident_id')::bigint, p->>'hero_image_url', p->>'author', v_tags, p->'data', p->'brand', p->>'html', p->>'html_preview', auth.uid())
    returning * into r;
  else
    update public.hub_reports
       set ref = coalesce(p->>'ref', ref), title = coalesce(p->>'title', title), subtitle = p->>'subtitle', summary = p->>'summary',
           industry = p->>'industry', primary_category = p->>'primary_category', severity = (p->>'severity')::smallint,
           incident_id = (p->>'incident_id')::bigint, hero_image_url = p->>'hero_image_url', author = p->>'author', tags = v_tags,
           data = case when p ? 'data' then p->'data' else data end,
           brand = case when p ? 'brand' then p->'brand' else brand end,
           html = case when p ? 'html' then p->>'html' else html end,
           html_preview = case when p ? 'html_preview' then p->>'html_preview' when p ? 'html' then null else html_preview end,
           updated_at = now()
     where id = (p->>'id')::bigint
    returning * into r;
  end if;
  return next r;
end $$;


ALTER FUNCTION "public"."admin_upsert_report"("p" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text" DEFAULT NULL::"text", "p_verdict" "text" DEFAULT 'SUSPECT'::"text", "p_verify_note" "text" DEFAULT NULL::"text", "p_sources" "jsonb" DEFAULT '[]'::"jsonb", "p_sweep_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_incident     record;
  v_existing     bigint;
  v_id           bigint;
  v_apply        boolean := (p_verdict = 'REAL');
  v_new_severity integer;
  v_label        text := to_char(p_update_date, 'FMDD Mon YYYY');
begin
  if not public.guard_upload_key_ok() then
    raise exception 'apply_incident_update: a valid x-guard-upload-key header is required' using errcode = '42501';
  end if;
  if p_verdict is null or p_verdict not in ('REAL', 'SUSPECT') then
    raise exception 'apply_incident_update: verdict must be REAL or SUSPECT, got %', p_verdict using errcode = '22023';
  end if;

  select i.id, i.severity, i.summary, i.severity_rationale
    into v_incident
    from sweep.incidents i
   where i.id = p_incident_id
     for update;
  if not found then
    raise exception 'apply_incident_update: incident % does not exist', p_incident_id using errcode = 'P0002';
  end if;

  -- Re-landing a day must never append the same update twice.
  select u.id into v_existing
    from sweep.incident_updates u
   where u.incident_id = p_incident_id and u.update_date = p_update_date and u.headline = btrim(p_headline);
  if v_existing is not null then
    return jsonb_build_object('update_id', v_existing, 'status', 'already_applied',
                              'severity_before', v_incident.severity, 'severity_after', v_incident.severity);
  end if;

  -- Severity may rise, never fall. Only a REAL update touches the incident at all.
  v_new_severity := case when v_apply then greatest(coalesce(v_incident.severity, p_severity_after), p_severity_after)
                         else v_incident.severity end;

  insert into sweep.incident_updates (incident_id, sweep_id, update_date, headline, what_changed, development_type,
                                      severity_before, severity_after, severity_rationale, verdict, verify_note,
                                      sources, applied_to_incident)
  values (p_incident_id, p_sweep_id, p_update_date, btrim(p_headline), btrim(p_what_changed), p_development_type,
          v_incident.severity, p_severity_after, p_severity_rationale, p_verdict, p_verify_note,
          coalesce(p_sources, '[]'::jsonb), v_apply)
  returning id into v_id;

  if v_apply then
    update sweep.incidents
       set summary = concat_ws(E'\n\n', nullif(summary, ''), 'UPDATE ' || v_label || ': ' || btrim(p_what_changed)),
           severity = v_new_severity,
           severity_rationale = case
             when v_new_severity is distinct from v_incident.severity then
               concat_ws(E'\n\n', nullif(severity_rationale, ''),
                 'Raised from ' || coalesce(v_incident.severity::text, 'none') || ' to ' || v_new_severity::text
                 || ' on ' || v_label || ': ' || coalesce(nullif(btrim(p_severity_rationale), ''), btrim(p_headline)))
             else severity_rationale end
     where id = p_incident_id;
  end if;

  return jsonb_build_object('update_id', v_id,
                            'status', case when v_apply then 'applied' else 'logged_only' end,
                            'severity_before', v_incident.severity,
                            'severity_after', v_new_severity);
end;
$$;


ALTER FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) IS 'The only path that changes an existing incident. Requires the upload key. REAL: logs the update, appends a dated UPDATE note to the summary, raises severity (never lowers). SUSPECT: logs only. Idempotent per (incident, date, headline).';



CREATE OR REPLACE FUNCTION "public"."fn_sweep_report"("p_sweep_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    AS $$
with target as (
  select coalesce(p_sweep_id, (select sweep_id from v_latest_sweep)) as sweep_id
),
this as (select * from v_sweep_summary where sweep_id = (select sweep_id from target)),
prev as (
  select * from v_sweep_summary
  where generated_at < (select generated_at from this)
  order by generated_at desc limit 1
),
cats as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'label', label,
           'incidents', incidents, 'major', major, 'avg_severity', avg_severity
         ) order by incidents desc), '[]'::jsonb) as arr
  from v_sweep_category_counts where sweep_id = (select sweep_id from target)
),
majors as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'severity', severity, 'headline', headline, 'entity', entity,
           'sector', sector, 'country', country,
           'category', category_label, 'subcategory', subcategory,
           'confidence', confidence
         ) order by severity desc, headline), '[]'::jsonb) as arr
  from v_major_incidents where sweep_id = (select sweep_id from target)
),
all_inc as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'severity', severity, 'headline', headline, 'summary', summary,
           'entity', entity, 'sector', sector, 'country', country,
           'category', category_label, 'subcategory', subcategory,
           'subcategory_code', subcategory_code,
           'secondary', coalesce(secondary_mappings, '[]'::jsonb),
           'confidence', confidence
         ) order by severity desc, headline), '[]'::jsonb) as arr
  from v_sweep_incidents where sweep_id = (select sweep_id from target)
),
trend as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', day, 'total', total_incidents, 'major', major_incidents
         ) order by day), '[]'::jsonb) as arr
  from (select * from v_daily_trend order by day desc limit 14) t
),
upd as (
  select u.*,
         case when u.applied_to_incident
              then greatest(coalesce(u.severity_before, u.severity_after), u.severity_after)
              else u.severity_before end as severity_now,
         coalesce(u.sweep_id,
                  (select s.id from public.sweeps s
                    where s.uploaded_at > u.created_at
                      and not exists (select 1 from public.sweeps earlier
                                       where earlier.uploaded_at < s.uploaded_at
                                         and earlier.generated_at > s.generated_at)
                    order by s.uploaded_at, s.id limit 1),
                  (select sweep_id from v_latest_sweep)) as brief_sweep_id
    from sweep.incident_updates u
),
updates as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'update_id', u.id, 'incident_id', u.incident_id,
           'update_date', u.update_date, 'headline', u.headline, 'what_changed', u.what_changed,
           'development_type', u.development_type,
           'verdict', u.verdict, 'confirmed', u.applied_to_incident,
           'severity_before', u.severity_before, 'severity_after', u.severity_now,
           'sources', u.sources,
           'incident_headline', i.headline, 'entity', i.entity, 'country', i.country,
           'category', i.category_label,
           'first_sweep_id', i.sweep_id,
           'first_sweep_date', (select (s.generated_at at time zone 'UTC')::date from public.sweeps s where s.id = i.sweep_id)
         ) order by u.applied_to_incident desc, u.severity_now desc nulls last, u.update_date desc, u.id), '[]'::jsonb) as arr
  from upd u
  join v_sweep_incidents i on i.id = u.incident_id
  where u.brief_sweep_id = (select sweep_id from target)
)
select jsonb_build_object(
  'sweep_id',     (select sweep_id from this),
  'generated_at', (select generated_at from this),
  'sweep_date',   (select sweep_date from this),
  'totals', jsonb_build_object(
     'total',       (select total_incidents from this),
     'major',       (select major_incidents from this),
     'critical',    (select critical_incidents from this),
     'high',        (select high_incidents from this),
     'avg_severity',(select avg_severity from this),
     'categories',  (select categories_hit from this),
     'sectors',     (select sectors_hit from this),
     'countries',   (select countries_hit from this),
     'updates',     (select jsonb_array_length(arr) from updates)
  ),
  'delta', jsonb_build_object(
     'prev_sweep_id',(select sweep_id from prev),
     'prev_total',   (select total_incidents from prev),
     'prev_major',   (select major_incidents from prev),
     'total_change', (select total_incidents from this) - (select total_incidents from prev),
     'major_change', (select major_incidents from this) - (select major_incidents from prev)
  ),
  'categories',      (select arr from cats),
  'major_incidents', (select arr from majors),
  'incidents',       (select arr from all_inc),
  'updates',         (select arr from updates),
  'trend_14d',       (select arr from trend),
  'exec_line', format(
     '%s incidents in the last sweep (%s major, %s critical). %s vs prior sweep. Top: %s.',
     (select total_incidents from this),
     (select major_incidents from this),
     (select critical_incidents from this),
     case
       when (select total_incidents from prev) is null then 'No prior sweep'
       when (select total_incidents from this) > (select total_incidents from prev)
         then format('Up %s', (select total_incidents from this) - (select total_incidents from prev))
       when (select total_incidents from this) < (select total_incidents from prev)
         then format('Down %s', (select total_incidents from prev) - (select total_incidents from this))
       else 'Flat'
     end,
     coalesce((select string_agg(headline, '; ')
               from (select headline from v_major_incidents
                     where sweep_id = (select sweep_id from target)
                     order by severity desc limit 2) h), 'none')
  )
);
$$;


ALTER FUNCTION "public"."fn_sweep_report"("p_sweep_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_upload_key_ok"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(
    (current_setting('request.headers', true)::json ->> 'x-guard-upload-key')
      = (select decrypted_secret from vault.decrypted_secrets where name = 'guard_upload_key'),
    false)
$$;


ALTER FUNCTION "public"."guard_upload_key_ok"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, tier, email_subscribed, created_at, updated_at)
  VALUES (NEW.id, NEW.email, 'free', true, now(), now())
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  pre_approved boolean;
  app_record   public.partner_applications%ROWTYPE;
BEGIN
  -- Create the profile row (existing behaviour)
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;

  -- Look for an approved application matching this email
  SELECT * INTO app_record
  FROM public.partner_applications
  WHERE lower(email) = lower(NEW.email) AND status = 'approved'
  ORDER BY decided_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    UPDATE public.profiles
    SET tier = 'partner',
        approved_at = COALESCE(app_record.decided_at, now()),
        company = app_record.company,
        role    = app_record.role
    WHERE id = NEW.id;

    -- Backfill user_id on the application
    UPDATE public.partner_applications
    SET user_id = NEW.id
    WHERE id = app_record.id;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_partner_approval"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  matched_id uuid;
BEGIN
  -- Find matching profile (by user_id first, fall back to email)
  IF NEW.user_id IS NOT NULL THEN
    matched_id := NEW.user_id;
  ELSE
    SELECT id INTO matched_id
    FROM public.profiles
    WHERE lower(email) = lower(NEW.email)
    LIMIT 1;
  END IF;

  IF matched_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- TRANSITION INTO 'approved' — promote tier to 'partner'
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    UPDATE public.profiles
    SET tier = 'partner',
        approved_at = COALESCE(NEW.decided_at, now()),
        company = COALESCE(profiles.company, NEW.company),
        role    = COALESCE(profiles.role,    NEW.role)
    WHERE id = matched_id;
  END IF;

  -- TRANSITION FROM 'approved' INTO 'rejected'/'withdrawn' — revoke tier
  -- Only revoke if the user is currently a 'partner' (don't demote admins)
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'approved'
     AND NEW.status IN ('rejected', 'withdrawn') THEN
    UPDATE public.profiles
    SET tier = 'free',
        approved_at = NULL
    WHERE id = matched_id
      AND tier = 'partner';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_partner_approval"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_vendor_application_decision"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  -- ── APPROVED ─────────────────────────────────────────────────────
  if new.status = 'approved' then
    if new.user_id is not null then
      update public.profiles
         set tier = 'vendor',
             approved_at = coalesce(approved_at, now())
       where id = new.user_id
         and tier <> 'admin';
    else
      update public.profiles
         set tier = 'vendor',
             approved_at = coalesce(approved_at, now())
       where lower(email) = lower(new.email)
         and tier <> 'admin';
    end if;
  end if;

  -- ── REJECTED / WITHDRAWN (only revert if was previously approved) ──
  if new.status in ('rejected','withdrawn') and old.status = 'approved' then
    if new.user_id is not null then
      update public.profiles
         set tier = 'free'
       where id = new.user_id
         and tier = 'vendor';
    else
      update public.profiles
         set tier = 'free'
       where lower(email) = lower(new.email)
         and tier = 'vendor';
    end if;
  end if;

  -- Stamp decision timestamp
  if new.decided_at is null then
    new.decided_at := now();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_vendor_application_decision"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_vendor_application_decision"() IS 'Sync profile.tier with vendor_applications.status. Approved → vendor; reverted → free.';



CREATE OR REPLACE FUNCTION "public"."incident_teaser"("p_incident_id" bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'sweep', 'public'
    AS $$
  with first_group as (
    select exposure_group
    from sweep.blast_radius
    where incident_id = p_incident_id
    group by exposure_group
    order by count(*) desc, exposure_group
    limit 1
  )
  select jsonb_build_object(
    'peer_watchlist', jsonb_build_object(
      'total', (select count(*) from sweep.peer_watchlist where incident_id = p_incident_id),
      'rows',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                  from (select * from sweep.peer_watchlist where incident_id = p_incident_id order by id limit 1) x)),
    'adaptive_controls', jsonb_build_object(
      'total', (select count(*) from sweep.adaptive_controls where incident_id = p_incident_id),
      'rows',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                  from (select * from sweep.adaptive_controls where incident_id = p_incident_id order by id limit 1) x)),
    'historical_analogues', jsonb_build_object(
      'total', (select count(*) from sweep.historical_analogues where incident_id = p_incident_id),
      'rows',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                  from (select * from sweep.historical_analogues where incident_id = p_incident_id order by id limit 1) x)),
    'sources', jsonb_build_object(
      'total', (select count(*) from sweep.sources where incident_id = p_incident_id),
      'rows',  (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
                  from (select * from sweep.sources where incident_id = p_incident_id order by id limit 1) x)),
    'blast_radius', jsonb_build_object(
      'total', (select count(*) from sweep.blast_radius where incident_id = p_incident_id),
      'channels', (select coalesce(jsonb_agg(c order by (c->>'count')::int desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'group', b.exposure_group,
            'count', count(*),
            'rows', case when b.exposure_group = (select exposure_group from first_group)
                      then (select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb)
                              from sweep.blast_radius y
                             where y.incident_id = p_incident_id and y.exposure_group = b.exposure_group)
                      else '[]'::jsonb end
          ) as c
          from sweep.blast_radius b
          where b.incident_id = p_incident_id
          group by b.exposure_group
        ) g))
  )
$$;


ALTER FUNCTION "public"."incident_teaser"("p_incident_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_subscriber"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'identity'
    AS $$
  select coalesce((select p.tier in ('enterprise','admin') from identity.profiles p where p.id = auth.uid()), false)
$$;


ALTER FUNCTION "public"."is_subscriber"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "sweep"."adaptive_controls" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "control_id" "text",
    "parent_mc_id" "text",
    "statement" "text",
    "rationale" "text",
    "kind" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "adaptive_controls_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "adaptive_controls_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."adaptive_controls" OWNER TO "postgres";


COMMENT ON TABLE "sweep"."adaptive_controls" IS 'AC-* tier: incident-specific adaptive controls, child of a master control.';



COMMENT ON COLUMN "sweep"."adaptive_controls"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."adaptive_controls"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."adaptive_controls"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."adaptive_controls"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE TABLE IF NOT EXISTS "sweep"."blast_radius" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "exposure_group" "text" NOT NULL,
    "name" "text",
    "type" "text",
    "country" "text",
    "latitude" numeric,
    "longitude" numeric,
    "reason" "text",
    "impact_score" integer,
    "impact_rationale" "text",
    "transmission_mechanism" "text",
    "impact_horizon" "text",
    "recommended_action_for_them" "text",
    "hook_product" "text",
    "hook_cta_label" "text",
    "hook_scenario_seed" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "blast_radius_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "blast_radius_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."blast_radius" OWNER TO "postgres";


COMMENT ON COLUMN "sweep"."blast_radius"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."blast_radius"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."blast_radius"."hook_product" IS 'Intelligence routine: never written on its rows (origin intel_routine), so it stays NULL there. Internal sales copy; do not show it on the globe. Kept for the Newsroom and the Email Campaign fallback.';



COMMENT ON COLUMN "sweep"."blast_radius"."hook_cta_label" IS 'Intelligence routine: never written on its rows (origin intel_routine), so it stays NULL there. Internal sales copy; do not show it on the globe. Kept for the Newsroom and the Email Campaign fallback.';



COMMENT ON COLUMN "sweep"."blast_radius"."hook_scenario_seed" IS 'Intelligence routine: never written on its rows (origin intel_routine), so it stays NULL there. Internal sales copy; do not show it on the globe. Kept for the Newsroom and the Email Campaign fallback.';



COMMENT ON COLUMN "sweep"."blast_radius"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."blast_radius"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE TABLE IF NOT EXISTS "sweep"."historical_analogues" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "event_name" "text",
    "entity" "text",
    "year" integer,
    "summary" "text",
    "outcome" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "historical_analogues_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "historical_analogues_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."historical_analogues" OWNER TO "postgres";


COMMENT ON TABLE "sweep"."historical_analogues" IS 'Historical analogue events with parallel and outcome.';



COMMENT ON COLUMN "sweep"."historical_analogues"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."historical_analogues"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."historical_analogues"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."historical_analogues"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE TABLE IF NOT EXISTS "sweep"."incidents" (
    "id" bigint NOT NULL,
    "sweep_id" bigint,
    "headline" "text",
    "summary" "text",
    "entity" "text",
    "sector" "text",
    "location_name" "text",
    "country" "text",
    "latitude" numeric,
    "longitude" numeric,
    "event_date" "date",
    "disclosure_date" "date",
    "primary_category" "text",
    "primary_subcategory_code" "text",
    "primary_subcategory_name" "text",
    "severity" integer,
    "severity_rationale" "text",
    "confidence" "text",
    "incident_day" "date",
    "industry" "text",
    "industry_id" bigint,
    "article_body" "text",
    "origin" "public"."incident_origin",
    "secondary_mappings" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "image_url" "text",
    "image_source" "text",
    "image_credit" "text",
    "image_prompt" "text",
    "image_updated_at" timestamp with time zone,
    "report_ref" "text",
    "audit_status" "text",
    "verified_incident" boolean GENERATED ALWAYS AS (("audit_status" = 'material_verified'::"text")) STORED,
    CONSTRAINT "incidents_audit_status_chk" CHECK ((("audit_status" IS NULL) OR ("audit_status" = ANY (ARRAY['material_verified'::"text", 'material_needs_fix'::"text", 'update_of_earlier'::"text", 'duplicate'::"text", 'signal'::"text", 'developing'::"text", 'rejected_routine'::"text", 'rejected_minor'::"text", 'rejected_unverified'::"text", 'rejected_did_not_happen'::"text", 'rejected_not_an_incident'::"text"])))),
    CONSTRAINT "incidents_confidence_check" CHECK ((("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"])) OR ("confidence" IS NULL))),
    CONSTRAINT "incidents_intel_report_ref_chk" CHECK ((("report_ref" IS NULL) OR (("char_length"("report_ref") <= 64) AND ("report_ref" ~ '^ATK-[A-Za-z0-9][A-Za-z0-9._-]*$'::"text"))))
);


ALTER TABLE "sweep"."incidents" OWNER TO "postgres";


COMMENT ON COLUMN "sweep"."incidents"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."incidents"."sweep_id" IS 'POINTER, not this row''s own number: which sweep.runs row this belongs to (references sweep.runs.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."incidents"."confidence" IS 'Assessment confidence level: HIGH | MEDIUM | LOW.';



COMMENT ON COLUMN "sweep"."incidents"."industry" IS 'GICS sub-industry from the 40-industry master list. References public.industries.industry by name.';



COMMENT ON COLUMN "sweep"."incidents"."industry_id" IS 'POINTER, not this row''s own number: which reference.industries row this belongs to (references reference.industries.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."incidents"."report_ref" IS 'ATK id of the full report (for example ATK-2026-0908-NATS). The report is final only on the internal Intelligence dashboard (schema intel of the Incident Reporting project, intel.reports.ir_incident_id; Samarth, 7 Oct 2026): the portal never shows it, and a pin carries no link to it. Unique when set. Key of routine rows; on a Newsroom row it is set only by intel.link_report_to_incident and only records which internal report covers the event. No foreign key, because the report lives in another database; the routine checks it exists before writing. Added by 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."incidents"."audit_status" IS 'Verdict of the 2026-09-24 full-DB audit against the Material Incident Qualification Standard v1.0. material_verified = real, material, stored correctly. material_needs_fix = real and material but a field is wrong (entity/date/headline). update_of_earlier / duplicate = not a separate incident. signal / developing = held, outcome not realised yet. rejected_routine / rejected_minor / rejected_unverified / rejected_did_not_happen / rejected_not_an_incident = does not qualify. NULL = landed after the audit, not judged yet. The audited material set = audit_status IN (''material_verified'',''material_needs_fix'') (1,113 records).';



COMMENT ON COLUMN "sweep"."incidents"."verified_incident" IS 'TRUE = audited and confirmed correct: a real, material incident stored with no errors (980 records, 2026-09-24 audit against Material Incident Qualification Standard v1.0). FALSE = audited and NOT confirmed correct (see audit_status for the reason: needs a field fix, duplicate, update, signal, developing, or rejected). NULL = landed after the audit, not judged yet. For "give me the material incidents", use: WHERE verified_incident. Kept in sync automatically from audit_status.';



CREATE TABLE IF NOT EXISTS "sweep"."peer_watchlist" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "name" "text",
    "country" "text",
    "latitude" numeric,
    "longitude" numeric,
    "exposure_reason" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "peer_watchlist_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "peer_watchlist_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."peer_watchlist" OWNER TO "postgres";


COMMENT ON TABLE "sweep"."peer_watchlist" IS 'Peer organizations exposed to the same risk, with geo.';



COMMENT ON COLUMN "sweep"."peer_watchlist"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."peer_watchlist"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."peer_watchlist"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."peer_watchlist"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE TABLE IF NOT EXISTS "sweep"."sources" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "title" "text",
    "url" "text",
    "publisher" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "sources_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "sources_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."sources" OWNER TO "postgres";


COMMENT ON COLUMN "sweep"."sources"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."sources"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."sources"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."sources"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE OR REPLACE VIEW "public"."incident_layer_counts" WITH ("security_invoker"='false') AS
 SELECT "id" AS "incident_id",
    (( SELECT "count"(*) AS "count"
           FROM "sweep"."sources" "s"
          WHERE ("s"."incident_id" = "i"."id")))::integer AS "sources",
    (( SELECT "count"(*) AS "count"
           FROM "sweep"."blast_radius" "b"
          WHERE ("b"."incident_id" = "i"."id")))::integer AS "blast",
    (( SELECT "count"(*) AS "count"
           FROM "sweep"."peer_watchlist" "p"
          WHERE ("p"."incident_id" = "i"."id")))::integer AS "peers",
    (( SELECT "count"(*) AS "count"
           FROM "sweep"."adaptive_controls" "a"
          WHERE ("a"."incident_id" = "i"."id")))::integer AS "controls",
    (( SELECT "count"(*) AS "count"
           FROM "sweep"."historical_analogues" "h"
          WHERE ("h"."incident_id" = "i"."id")))::integer AS "analogues"
   FROM "sweep"."incidents" "i";


ALTER VIEW "public"."incident_layer_counts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."incidents" AS
 SELECT "id",
    "sweep_id",
    "headline",
    "summary",
    "secondary_mappings",
    "entity",
    "sector",
    "location_name",
    "country",
    "latitude",
    "longitude",
    "event_date",
    "disclosure_date",
    "primary_category",
    "primary_subcategory_code",
    "primary_subcategory_name",
    "severity",
    "severity_rationale",
    "incident_day",
    "industry",
    "industry_id",
    "article_body",
    "origin",
    "confidence",
    "image_url",
    "image_source",
    "image_credit",
    "image_updated_at",
    "image_prompt",
    "audit_status",
    "verified_incident"
   FROM "sweep"."incidents";


ALTER VIEW "public"."incidents" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."layer_counts"("public"."incidents") RETURNS SETOF "public"."incident_layer_counts"
    LANGUAGE "sql" STABLE ROWS 1
    AS $_$
  select * from public.incident_layer_counts where incident_id = $1.id
$_$;


ALTER FUNCTION "public"."layer_counts"("public"."incidents") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_on_onboarded"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF OLD.onboarded_at IS NULL AND NEW.onboarded_at IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/welcome-email',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('user_id', NEW.id::text),
      timeout_milliseconds := 30000
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_on_onboarded failed: %', sqlerrm;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_on_onboarded"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_on_sweep_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'net'
    AS $$
declare
  target_day      date;
  current_count   int;
  already_logged  boolean;
  req_id          bigint;
begin
  -- Latest sweep date wins (most recent generated_at across both tables)
  select greatest(
    coalesce((select max(date(generated_at)) from public.sweeps), date '1900-01-01'),
    coalesce((select max(date(generated_at)) from public.vi_sweeps), date '1900-01-01')
  ) into target_day;

  if target_day is null or target_day = date '1900-01-01' then
    return null;
  end if;

  -- Count incidents for this day; skip if none yet (sweep row may have
  -- been inserted before its children — the incidents insert will fire
  -- this trigger again with non-zero count).
  select count(*) into current_count
  from public.incidents
  where incident_day = target_day;

  if current_count = 0 then
    return null;
  end if;

  -- De-dup: once notified for a sweep date, never again
  select exists(
    select 1 from public.sweep_notifications_log where sweep_date = target_day
  ) into already_logged;

  if already_logged then
    return null;
  end if;

  -- Mark BEFORE firing so a concurrent insert can't race in
  insert into public.sweep_notifications_log (sweep_date, incident_count)
  values (target_day, current_count)
  on conflict (sweep_date) do nothing;

  -- Async HTTP call via pg_net — does not block the originating insert
  select net.http_post(
    url := 'https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('day', target_day::text),
    timeout_milliseconds := 30000
  ) into req_id;

  update public.sweep_notifications_log
     set http_request_id = req_id
   where sweep_date = target_day;

  return null;
exception when others then
  -- Never block the originating insert if the notify mechanism fails
  raise warning 'notify_on_sweep_change failed: %', sqlerrm;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_on_sweep_change"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notify_on_sweep_change"() IS 'Fires daily-digest edge fn when a new sweep + its incidents are uploaded. Idempotent via sweep_notifications_log.';



CREATE OR REPLACE FUNCTION "public"."notify_partner_application"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  payload jsonb;
  func_url text := 'https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/notify-application';
BEGIN
  -- Build the payload in the same shape as Supabase Database Webhooks send
  -- so the edge function's payload parser works identically whether called
  -- from this trigger or a future Database Webhook.
  payload := jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', row_to_json(NEW),
    'old_record', CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) ELSE NULL END
  );

  -- Fire and forget. pg_net is async — does not block the INSERT.
  PERFORM net.http_post(
    url := func_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := payload,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block the row write if the notify fails. Log instead.
  RAISE WARNING 'notify_partner_application failed: %', SQLERRM;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_partner_application"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_development"("p_run_id" "uuid", "p_match_key" "text", "p_title" "text", "p_jurisdiction" "text" DEFAULT NULL::"text", "p_domain" "text" DEFAULT NULL::"text", "p_regulation" "text" DEFAULT NULL::"text", "p_authority" "text" DEFAULT NULL::"text", "p_sector" "text" DEFAULT NULL::"text", "p_change_type" "text" DEFAULT NULL::"text", "p_legal_status" "text" DEFAULT NULL::"text", "p_publication_date" "date" DEFAULT NULL::"date", "p_effective_date" "date" DEFAULT NULL::"date", "p_enforcement_date" "date" DEFAULT NULL::"date", "p_deadline" "date" DEFAULT NULL::"date", "p_what_changed" "text" DEFAULT NULL::"text", "p_who_affected" "text" DEFAULT NULL::"text", "p_why_matters" "text" DEFAULT NULL::"text", "p_primary_source" "text" DEFAULT NULL::"text", "p_source_url" "text" DEFAULT NULL::"text", "p_secondary_source" "text" DEFAULT NULL::"text", "p_confidence" "text" DEFAULT NULL::"text", "p_materiality" "text" DEFAULT NULL::"text") RETURNS TABLE("development_id" "uuid", "disposition" "text", "previous_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
declare
  v_id       uuid;
  v_prev     text;
  v_existed  boolean;
begin
  select d.id, d.change_type into v_id, v_prev
    from developments d
   where d.match_key = p_match_key;

  v_existed := v_id is not null;

  insert into developments as d (
    match_key, title, jurisdiction, domain, regulation, authority, sector,
    change_type, legal_status, publication_date, effective_date, enforcement_date,
    deadline, what_changed, who_affected, why_matters, primary_source, source_url,
    secondary_source, confidence, materiality, first_seen_run, last_seen_run
  ) values (
    p_match_key, p_title, p_jurisdiction, p_domain, p_regulation, p_authority, p_sector,
    p_change_type, p_legal_status, p_publication_date, p_effective_date, p_enforcement_date,
    p_deadline, p_what_changed, p_who_affected, p_why_matters, p_primary_source, p_source_url,
    p_secondary_source, p_confidence, p_materiality, p_run_id, p_run_id
  )
  on conflict (match_key) do update set
    title            = excluded.title,
    jurisdiction     = coalesce(excluded.jurisdiction,     d.jurisdiction),
    domain           = coalesce(excluded.domain,           d.domain),
    regulation       = coalesce(excluded.regulation,       d.regulation),
    authority        = coalesce(excluded.authority,        d.authority),
    sector           = coalesce(excluded.sector,           d.sector),
    change_type      = coalesce(excluded.change_type,      d.change_type),
    legal_status     = coalesce(excluded.legal_status,     d.legal_status),
    publication_date = coalesce(excluded.publication_date, d.publication_date),
    effective_date   = coalesce(excluded.effective_date,   d.effective_date),
    enforcement_date = coalesce(excluded.enforcement_date, d.enforcement_date),
    deadline         = coalesce(excluded.deadline,         d.deadline),
    what_changed     = coalesce(excluded.what_changed,     d.what_changed),
    who_affected     = coalesce(excluded.who_affected,     d.who_affected),
    why_matters      = coalesce(excluded.why_matters,      d.why_matters),
    primary_source   = coalesce(excluded.primary_source,   d.primary_source),
    source_url       = coalesce(excluded.source_url,       d.source_url),
    secondary_source = coalesce(excluded.secondary_source, d.secondary_source),
    confidence       = coalesce(excluded.confidence,       d.confidence),
    materiality      = coalesce(excluded.materiality,      d.materiality),
    last_seen_run    = p_run_id,
    last_seen_at     = now(),
    updated_at       = now()
  returning d.id into v_id;

  if not v_existed then
    insert into status_history (development_id, run_id, previous_status, new_status, note)
    values (v_id, p_run_id, null, coalesce(p_change_type,'NEW'), 'first observation');
    return query select v_id, 'NEW'::text, null::text;
  elsif v_prev is distinct from p_change_type and p_change_type is not null then
    insert into status_history (development_id, run_id, previous_status, new_status, note)
    values (v_id, p_run_id, v_prev, p_change_type, 'status transition');
    return query select v_id, 'CHANGED'::text, v_prev;
  else
    return query select v_id, 'UNCHANGED'::text, v_prev;
  end if;
end;
$$;


ALTER FUNCTION "public"."record_development"("p_run_id" "uuid", "p_match_key" "text", "p_title" "text", "p_jurisdiction" "text", "p_domain" "text", "p_regulation" "text", "p_authority" "text", "p_sector" "text", "p_change_type" "text", "p_legal_status" "text", "p_publication_date" "date", "p_effective_date" "date", "p_enforcement_date" "date", "p_deadline" "date", "p_what_changed" "text", "p_who_affected" "text", "p_why_matters" "text", "p_primary_source" "text", "p_source_url" "text", "p_secondary_source" "text", "p_confidence" "text", "p_materiality" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."report_html"("p_ref" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select case when public.is_subscriber() then r.html
              else coalesce(r.html_preview, public._report_stub(r.ref, r.title, r.subtitle, r.summary)) end
    from public.hub_reports r
   where r.ref = p_ref and r.status = 'published'
$$;


ALTER FUNCTION "public"."report_html"("p_ref" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpt_cockpit"("p_sweep_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
with tgt as (select coalesce(p_sweep_id,(select sweep_id from rpt_sweep_trend order by generated_at desc limit 1)) sid),
hdr as (select * from rpt_sweep_trend where sweep_id=(select sid from tgt))
select jsonb_build_object(
  'sweep',(select jsonb_build_object('id',sweep_id,'date',sweep_date,'generated_at',generated_at,'lookback_hours',lookback_hours,'model',model) from hdr),
  'totals',(select jsonb_build_object('incidents',total_incidents,'major',major_count,'critical',critical_count,'enriched',enriched_count,'categories_hit',categories_hit,'sectors_hit',sectors_hit,'countries_hit',countries_hit,'avg_severity',avg_severity) from hdr),
  'trend',(select jsonb_build_object('delta',total_delta,'prev_total',prev_total_incidents,'pct_change',case when prev_total_incidents>0 then round(100.0*total_delta/prev_total_incidents,1) end,'trailing7_avg',trailing7_avg,'direction',case when total_delta>0 then 'up' when total_delta<0 then 'down' else 'flat' end) from hdr),
  'by_category',(select coalesce(jsonb_agg(jsonb_build_object('code',category,'name',category_name,'incidents',incidents,'major',major) order by incidents desc, category),'[]'::jsonb) from rpt_category_by_sweep where sweep_id=(select sid from tgt)),
  'series_14d',(select coalesce(jsonb_agg(jsonb_build_object('day',day,'incidents',incidents,'major',major) order by day),'[]'::jsonb) from (select * from rpt_incident_day_counts order by day desc limit 14) s),
  'contacts_meta',jsonb_build_object('total',(select count(*) from contacts c join incidents i on i.id=c.reason_incident_id where i.sweep_id=(select sid from tgt)),'sources',(select coalesce(jsonb_agg(distinct source),'[]'::jsonb) from contacts)),
  'incidents',(select coalesce(jsonb_agg(obj order by (obj->>'severity')::int desc),'[]'::jsonb) from (
     select jsonb_build_object(
       'id',i.id,'headline',i.headline,'summary',i.summary,'entity',i.entity,'sector',i.sector,
       'country',i.country,'lat',i.latitude,'lng',i.longitude,'severity',i.severity,
       'category',i.primary_category,'subcategory',i.primary_subcategory_name,'confidence',i.confidence,
       'threat_actor',i.threat_actor,'financial_impact',i.financial_impact_disclosed,
       'velocity_trajectory',i.velocity_trajectory,'velocity_brief',i.velocity_brief,
       'emerging_risk_signal',i.emerging_risk_signal,'if_x_then_y',i.if_you_operate_x_then_y,
       'event_date',i.event_date,'disclosure_date',i.disclosure_date,
       'factors',jsonb_build_object('severity',i.severity,'blast_count',(select count(*) from blast_radius b where b.incident_id=i.id),'max_impact',(select coalesce(max(impact_score),0) from blast_radius b where b.incident_id=i.id),'peer_count',(select count(*) from peer_watchlist p where p.incident_id=i.id),'vendor_count',(select count(*) from vendors v where v.incident_id=i.id),'velocity_flag',case when i.velocity_trajectory ~* 'celerat|increas|rising|escalat|surg' then 1 when i.velocity_trajectory ~* 'declin|eas|slow|abat' then -1 else 0 end,'notable',case when i.financial_impact_disclosed is not null then 1 else 0 end),
       'blast_radius',(select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'name',name,'type',type,'country',country,'lat',latitude,'lng',longitude,'impact_score',impact_score,'impact_horizon',impact_horizon,'transmission',transmission_mechanism,'action',recommended_action_for_them,'hook_product',hook_product,'hook_cta',hook_cta_label)),'[]'::jsonb) from (select * from blast_radius b where b.incident_id=i.id order by impact_score desc nulls last limit 14) br),
       'peers',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'country',country,'reason',exposure_reason,'confidence',confidence)),'[]'::jsonb) from (select * from peer_watchlist p where p.incident_id=i.id limit 10) pw),
       'vendors',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'product',product,'url',url,'hq',headquarters,'note',coverage_note)),'[]'::jsonb) from (select * from vendors v where v.incident_id=i.id limit 8) vd),
       'controls',jsonb_build_object(
          'adaptive',(select coalesce(jsonb_agg(jsonb_build_object('code',control_id,'statement',statement) order by control_id),'[]'::jsonb) from (select * from adaptive_master_controls a where a.incident_id=i.id order by control_id limit 14) a),
          'objectives',(select coalesce(jsonb_agg(jsonb_build_object('code',objective_id,'statement',statement) order by objective_id),'[]'::jsonb) from (select * from adaptive_objectives o where o.incident_id=i.id order by objective_id limit 10) o),
          'secondary',(select coalesce(jsonb_agg(jsonb_build_object('cat',category,'sub',subcategory_code,'why',why)),'[]'::jsonb) from (select * from secondary_mappings sm where sm.incident_id=i.id limit 6) sm)),
       'vendor_mitigations',(select coalesce(jsonb_agg(jsonb_build_object('name',vv.name,'product',vv.product_name,'how',vv.mitigation_mechanism->>'summary','covers',replace(replace(vv.covers_controls::text,'{',''),'}',''),'rating',vv.ai_verdict,'limit',(vv.mitigation_limits->0->>'limit'))),'[]'::jsonb) from vi_vendors vv join vi_incidents vi2 on vi2.id=vv.vi_incident_id where vi2.headline=i.headline limit 8),
       'analogues',(select coalesce(jsonb_agg(jsonb_build_object('event',event_name,'entity',entity,'year',year,'parallel',parallel,'outcome',outcome)),'[]'::jsonb) from (select * from historical_analogues h where h.incident_id=i.id limit 4) ha),
       'contacts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'org',org_name,'side',side,'name',full_name,'title',title,'seniority',seniority,'department',department,'email',email,'linkedin',linkedin_url,'reason',reason_text,'hook',recommended_hook,'relevance',relevance_score,'status',campaign_status,'source',source) order by relevance_score desc nulls last),'[]'::jsonb) from (select * from contacts c where c.reason_incident_id=i.id and not c.suppressed order by relevance_score desc nulls last limit 14) ct)
     ) as obj
     from incidents i where i.sweep_id=(select sid from tgt)
  ) z)
);
$$;


ALTER FUNCTION "public"."rpt_cockpit"("p_sweep_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpt_cockpit_vi"("p_vi_sweep_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
with tgt as (select coalesce(p_vi_sweep_id,(select id from vi_sweeps order by generated_at desc limit 1)) sid)
select jsonb_build_object(
  'enriched', true,
  'sweep',(select jsonb_build_object('id',id,'date',generated_at::date,'source_sweep',source_sweep,'validator',validator_version,'model','vendor-intel') from vi_sweeps where id=(select sid from tgt)),
  'totals',(select jsonb_build_object('incidents',count(*),'major',count(*) filter (where severity>=4),'critical',count(*) filter (where severity=5),'categories_hit',count(distinct primary_category),'countries_hit',count(distinct country)) from vi_incidents where vi_sweep_id=(select sid from tgt)),
  'contacts_meta',jsonb_build_object('total',0,'sources',jsonb_build_array('n/a')),
  'incidents',(select coalesce(jsonb_agg(obj order by (obj->>'severity')::int desc),'[]'::jsonb) from (
     select jsonb_build_object(
       'id',vi.id,'headline',vi.headline,'summary',vi.summary,'entity',vi.entity,'sector',vi.sector,
       'country',vi.country,'lat',vi.latitude,'lng',vi.longitude,'severity',vi.severity,
       'category',vi.primary_category,'subcategory',vi.primary_subcategory_name,'confidence',vi.confidence,
       'threat_actor',vi.threat_actor,'financial_impact',vi.financial_impact_disclosed,
       'velocity_trajectory',vi.velocity_trajectory,'emerging_risk_signal',vi.emerging_risk_signal,
       'if_x_then_y',vi.if_you_operate_x_then_y,
       'factors',jsonb_build_object('severity',vi.severity,'blast_count',(select count(*) from vi_blast_radius b where b.vi_incident_id=vi.id),'max_impact',(select coalesce(max(impact_score),0) from vi_blast_radius b where b.vi_incident_id=vi.id),'peer_count',(select count(*) from vi_peer_watchlist p where p.vi_incident_id=vi.id),'vendor_count',(select count(*) from vi_vendors v where v.vi_incident_id=vi.id),'velocity_flag',0,'notable',case when vi.financial_impact_disclosed is not null then 1 else 0 end),
       'controls',(select coalesce(jsonb_agg(jsonb_build_object('code',mc_id,'statement',statement,'vendors',coalesce(vendors_covering,'[]'::jsonb)) order by mc_id),'[]'::jsonb) from vi_master_controls mc where mc.vi_incident_id=vi.id),
       'coverage',(select jsonb_build_object('total',count(*),'covered',count(*) filter (where coalesce(jsonb_array_length(vendors_covering),0)>0)) from vi_master_controls mc where mc.vi_incident_id=vi.id),
       'vendor_mitigations',(select coalesce(jsonb_agg(jsonb_build_object(
            'name',name,'product',product_name,'rating',ai_verdict,
            'dims',jsonb_build_array(ai_verdict_d1,ai_verdict_d2,ai_verdict_d3,ai_verdict_d4),
            'rationale',score_rationale,'fit',fit_level,'placement',placement,
            'how',case when jsonb_typeof(mitigation_mechanism)='object' then mitigation_mechanism->>'summary' end,
            'covers',replace(replace(covers_controls::text,'{',''),'}',''),
            'limit',case when jsonb_typeof(mitigation_limits)='array' and jsonb_array_length(mitigation_limits)>0 then mitigation_limits->0->>'limit' end,
            'workflow',case when jsonb_typeof(workflow_steps)='object' then workflow_steps->>'steps' end,
            'coverage',(select coalesce(jsonb_agg(jsonb_build_object('dimension',d->>'dimension','coverage',d->>'coverage')),'[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(dimension_coverage)='array' then dimension_coverage else '[]'::jsonb end) d)
          ) order by (ai_verdict)::int desc nulls last),'[]'::jsonb) from vi_vendors vv where vv.vi_incident_id=vi.id),
       'blast_radius',(select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket,'name',name,'type',type,'country',country,'lat',latitude,'lng',longitude,'impact_score',impact_score,'impact_horizon',impact_horizon,'transmission',transmission_mechanism,'action',recommended_action_for_them,'hook_product',hook_product,'hook_cta',hook_cta_label)),'[]'::jsonb) from (select * from vi_blast_radius b where b.vi_incident_id=vi.id order by impact_score desc nulls last limit 12) br),
       'peers',(select coalesce(jsonb_agg(jsonb_build_object('name',name,'country',country,'reason',exposure_reason,'confidence',confidence)),'[]'::jsonb) from (select * from vi_peer_watchlist p where p.vi_incident_id=vi.id limit 10) pw),
       'sponsored',(select coalesce(jsonb_agg(jsonb_build_object('slot',slot_type,'vendor',vendor_name,'rating',ai_verdict)),'[]'::jsonb) from vi_sponsored_slots sp where sp.vi_incident_id=vi.id),
       'editorial',(select coalesce(jsonb_agg(jsonb_build_object('slot',slot_type,'vendor',vendor_name,'rating',ai_verdict)),'[]'::jsonb) from vi_editorial_picks ep where ep.vi_incident_id=vi.id),
       'contacts',jsonb_build_array(),'analogues',jsonb_build_array(),'vendors',jsonb_build_array()
     ) as obj
     from vi_incidents vi where vi.vi_sweep_id=(select sid from tgt)
  ) z)
);
$$;


ALTER FUNCTION "public"."rpt_cockpit_vi"("p_vi_sweep_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rpt_daily_summary"("p_sweep_id" bigint DEFAULT NULL::bigint) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    AS $$
with target as (
  select coalesce(
           p_sweep_id,
           (select sweep_id from public.rpt_sweep_trend order by generated_at desc limit 1)
         ) as sweep_id
),
hdr as (
  select t.* from public.rpt_sweep_trend t, target tg where t.sweep_id = tg.sweep_id
),
cats as (
  select rc.category, rc.category_name, rc.incidents, rc.major
  from public.rpt_category_by_sweep rc, target tg
  where rc.sweep_id = tg.sweep_id
),
prev_cats as (
  select rc.category, rc.incidents
  from public.rpt_category_by_sweep rc
  where rc.sweep_id = (select prev_sweep_id from hdr)
),
movers as (
  select c.category, c.incidents - coalesce(p.incidents, 0) as delta
  from cats c left join prev_cats p using (category)
  where c.incidents - coalesce(p.incidents, 0) <> 0
  order by abs(c.incidents - coalesce(p.incidents, 0)) desc, c.category
  limit 5
),
majors as (
  select rm.incident_id, rm.headline, rm.entity, rm.sector, rm.country,
         rm.category, rm.subcategory, rm.severity, rm.confidence
  from public.rpt_major_incidents rm, target tg
  where rm.sweep_id = tg.sweep_id
),
series as (
  select day, incidents, major
  from public.rpt_incident_day_counts
  order by day desc
  limit 14
)
select jsonb_build_object(
  'sweep', (select jsonb_build_object(
        'id', sweep_id, 'generated_at', generated_at, 'date', sweep_date) from hdr),
  'totals', (select jsonb_build_object(
        'incidents', total_incidents,
        'major', major_count,
        'critical', critical_count,
        'max_severity', max_severity,
        'avg_severity', avg_severity,
        'categories_hit', categories_hit,
        'sectors_hit', sectors_hit,
        'countries_hit', countries_hit) from hdr),
  'trend', (select jsonb_build_object(
        'prev_sweep_id', prev_sweep_id,
        'prev_total', prev_total_incidents,
        'delta', total_delta,
        'pct_change', case when prev_total_incidents > 0
              then round(100.0 * total_delta / prev_total_incidents, 1) end,
        'trailing7_avg', trailing7_avg,
        'direction', case when total_delta > 0 then 'up'
                          when total_delta < 0 then 'down' else 'flat' end) from hdr),
  'by_category', (select coalesce(jsonb_agg(jsonb_build_object(
        'code', category, 'name', category_name,
        'incidents', incidents, 'major', major)
        order by incidents desc, category), '[]'::jsonb) from cats),
  'top_movers', (select coalesce(jsonb_agg(jsonb_build_object(
        'category', category, 'delta', delta)), '[]'::jsonb) from movers),
  'major_incidents', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', incident_id, 'headline', headline, 'entity', entity,
        'sector', sector, 'country', country, 'category', category,
        'subcategory', subcategory, 'severity', severity,
        'confidence', confidence)
        order by severity desc, category), '[]'::jsonb) from majors),
  'series_14d', (select coalesce(jsonb_agg(jsonb_build_object(
        'day', day, 'incidents', incidents, 'major', major)
        order by day), '[]'::jsonb) from series)
);
$$;


ALTER FUNCTION "public"."rpt_daily_summary"("p_sweep_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_onboarding"("p_full_name" "text", "p_company" "text", "p_role" "text", "p_industry" "text", "p_country" "text", "p_company_size" "text", "p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  UPDATE public.profiles SET
    full_name        = NULLIF(TRIM(p_full_name), ''),
    company          = NULLIF(TRIM(p_company), ''),
    role             = NULLIF(TRIM(p_role), ''),
    industry         = NULLIF(TRIM(p_industry), ''),
    country          = NULLIF(TRIM(p_country), ''),
    company_size     = NULLIF(TRIM(p_company_size), ''),
    watch_industries = p_watch_industries,
    watch_categories = p_watch_categories,
    digest_frequency = COALESCE(NULLIF(TRIM(p_digest_frequency), ''), 'daily'),
    email_subscribed = COALESCE(p_email_subscribed, email_subscribed, true),
    onboarded_at     = now(),
    updated_at       = now()
  WHERE id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."save_onboarding"("p_full_name" "text", "p_company" "text", "p_role" "text", "p_industry" "text", "p_country" "text", "p_company_size" "text", "p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_own_subscription"("p_on" boolean) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'identity'
    AS $$
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
    return cur;
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


ALTER FUNCTION "public"."set_own_subscription"("p_on" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_partner_application"("p_email" "text", "p_full_name" "text", "p_company" "text", "p_role" "text", "p_why_interested" "text", "p_sector" "text" DEFAULT NULL::"text", "p_linkedin_url" "text" DEFAULT NULL::"text", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  new_id bigint;
BEGIN
  -- Trim + lowercase the email defensively
  p_email := lower(trim(p_email));

  -- Server-side validation
  IF p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'Email is required' USING ERRCODE = '22023';
  END IF;
  IF p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Invalid email format' USING ERRCODE = '22023';
  END IF;
  IF p_full_name IS NULL OR length(trim(p_full_name)) < 2 THEN
    RAISE EXCEPTION 'Full name is required' USING ERRCODE = '22023';
  END IF;
  IF p_company IS NULL OR length(trim(p_company)) < 2 THEN
    RAISE EXCEPTION 'Company is required' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR length(trim(p_role)) < 2 THEN
    RAISE EXCEPTION 'Role is required' USING ERRCODE = '22023';
  END IF;
  IF p_why_interested IS NULL OR length(trim(p_why_interested)) < 30 THEN
    RAISE EXCEPTION 'Please share more detail on why you are interested (min 30 chars)' USING ERRCODE = '22023';
  END IF;

  -- Friendlier error than the raw 23505 from the unique-pending index
  IF EXISTS (
    SELECT 1 FROM partner_applications
    WHERE lower(email) = p_email AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'There is already a pending application from this email — we will be in touch soon.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO partner_applications (
    email, full_name, company, role, sector, linkedin_url, why_interested, user_id
  ) VALUES (
    p_email, trim(p_full_name), trim(p_company), trim(p_role),
    NULLIF(trim(p_sector), ''), NULLIF(trim(p_linkedin_url), ''),
    trim(p_why_interested), p_user_id
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$_$;


ALTER FUNCTION "public"."submit_partner_application"("p_email" "text", "p_full_name" "text", "p_company" "text", "p_role" "text", "p_why_interested" "text", "p_sector" "text", "p_linkedin_url" "text", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_vendor_application"("p_email" "text", "p_company_name" "text", "p_contact_name" "text", "p_contact_role" "text", "p_capability_summary" "text", "p_website" "text" DEFAULT NULL::"text", "p_linkedin_url" "text" DEFAULT NULL::"text", "p_categories" "text"[] DEFAULT NULL::"text"[], "p_target_sectors" "text"[] DEFAULT NULL::"text"[], "p_founded_year" integer DEFAULT NULL::integer, "p_headquarters_country" "text" DEFAULT NULL::"text", "p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  new_id bigint;
begin
  if coalesce(trim(p_email),        '') = '' then raise exception 'email is required'; end if;
  if coalesce(trim(p_company_name), '') = '' then raise exception 'company_name is required'; end if;
  if coalesce(trim(p_contact_name), '') = '' then raise exception 'contact_name is required'; end if;
  if coalesce(trim(p_contact_role), '') = '' then raise exception 'contact_role is required'; end if;
  if coalesce(trim(p_capability_summary), '') = '' then raise exception 'capability_summary is required'; end if;

  insert into public.vendor_applications (
    user_id, email, company_name, contact_name, contact_role,
    website, linkedin_url, categories, capability_summary,
    target_sectors, founded_year, headquarters_country
  ) values (
    p_user_id, lower(trim(p_email)), trim(p_company_name), trim(p_contact_name), trim(p_contact_role),
    nullif(trim(coalesce(p_website,'')), ''),
    nullif(trim(coalesce(p_linkedin_url,'')), ''),
    p_categories, trim(p_capability_summary),
    p_target_sectors, p_founded_year,
    nullif(trim(coalesce(p_headquarters_country,'')), '')
  )
  returning id into new_id;

  return new_id;
end;
$$;


ALTER FUNCTION "public"."submit_vendor_application"("p_email" "text", "p_company_name" "text", "p_contact_name" "text", "p_contact_role" "text", "p_capability_summary" "text", "p_website" "text", "p_linkedin_url" "text", "p_categories" "text"[], "p_target_sectors" "text"[], "p_founded_year" integer, "p_headquarters_country" "text", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_industry_text_from_fk"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.industry_id is not null then
    select ind.industry into new.industry
    from public.industries ind
    where ind.id = new.industry_id;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_industry_text_from_fk"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sync_industry_text_from_fk"() IS 'Auto-mirror industries.industry into incidents.industry text column whenever industry_id is set/changed. Keeps UI in sync with uploader canonical tagging.';



CREATE OR REPLACE FUNCTION "public"."sync_subscription_tier"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  target_tier text;
  has_approved_app boolean;
BEGIN
  IF NEW.status IN ('active', 'trialing') THEN
    -- Look up the plan's tier and promote
    SELECT p.tier INTO target_tier FROM public.plans p WHERE p.id = NEW.plan_id;
    IF target_tier IS NOT NULL AND target_tier NOT IN ('free') THEN
      UPDATE public.profiles
      SET tier = target_tier
      WHERE id = NEW.user_id
        AND tier NOT IN ('admin');    -- never demote admins
    END IF;
  ELSIF NEW.status IN ('canceled', 'unpaid', 'incomplete_expired') THEN
    -- Check if user has an approved partner application still standing
    SELECT EXISTS (
      SELECT 1 FROM public.partner_applications pa
      WHERE pa.user_id = NEW.user_id AND pa.status = 'approved'
    ) INTO has_approved_app;
    UPDATE public.profiles
    SET tier = CASE WHEN has_approved_app THEN 'partner' ELSE 'free' END
    WHERE id = NEW.user_id
      AND tier NOT IN ('admin');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_subscription_tier"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_daily_digest_now"("p_day" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  request_id bigint;
  body_json jsonb;
BEGIN
  body_json := CASE
    WHEN p_day IS NULL THEN jsonb_build_object('source', 'manual')
    ELSE jsonb_build_object('source', 'manual', 'day', p_day)
  END;
  SELECT net.http_post(
    url := 'https://ovenyjguhkgiceddzwna.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := body_json,
    timeout_milliseconds := 60000
  ) INTO request_id;
  RETURN jsonb_build_object('request_id', request_id, 'queued_at', now());
END;
$$;


ALTER FUNCTION "public"."trigger_daily_digest_now"("p_day" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unsubscribe_by_token"("p_token" "uuid") RETURNS TABLE("email" "text", "already_unsubscribed" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  target_id   uuid;
  target_email text;
  was_subscribed boolean;
BEGIN
  -- Columns are qualified: the OUT parameter "email" shadowed profiles.email,
  -- so the unqualified select failed with "column reference email is
  -- ambiguous" and every unsubscribe link in every email errored (fixed 2026-09-30).
  SELECT p.id, p.email, p.email_subscribed INTO target_id, target_email, was_subscribed
  FROM public.profiles p
  WHERE p.unsubscribe_token = p_token
  LIMIT 1;

  IF target_id IS NULL THEN
    RAISE EXCEPTION 'Invalid unsubscribe link.' USING ERRCODE = 'P0001';
  END IF;

  IF was_subscribed THEN
    UPDATE public.profiles AS pr SET email_subscribed = false WHERE pr.id = target_id;
  END IF;

  RETURN QUERY SELECT target_email, NOT was_subscribed;
END;
$$;


ALTER FUNCTION "public"."unsubscribe_by_token"("p_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_subscription_prefs"("p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  UPDATE public.profiles SET
    watch_industries = p_watch_industries,
    watch_categories = p_watch_categories,
    digest_frequency = COALESCE(NULLIF(TRIM(p_digest_frequency), ''), 'daily'),
    email_subscribed = COALESCE(p_email_subscribed, email_subscribed, true),
    updated_at       = now()
  WHERE id = auth.uid();
END;
$$;


ALTER FUNCTION "public"."update_subscription_prefs"("p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "sweep"."match_candidates"("p_entity" "text", "p_category" "text", "p_day" "date", "p_window_days" integer DEFAULT 45) RETURNS TABLE("thread_id" bigint, "public_ref" "text", "canonical_title" "text", "entity" "text", "category" "text", "thread_day" "date", "gap_days" integer, "same_category" boolean, "signal_score" integer)
    LANGUAGE "sql" STABLE
    AS $$
  with target as (
    select coalesce(e.canonical_name, lower(trim(p_entity))) as ent
    from (select 1) x
    left join sweep.entity_aliases a on a.alias_norm = lower(trim(p_entity))
    left join sweep.entities e on e.id = a.entity_id
    limit 1)
  select t.id, t.public_ref, t.canonical_title,
         coalesce(e2.canonical_name, lower(trim(i.entity))),
         i.primary_category,
         i.incident_day,
         (p_day - i.incident_day)::int,
         (i.primary_category = p_category),
         -- shortlist ranking, NOT a decision
         (case when i.primary_category = p_category then 40 else 0 end
        + case when p_day - i.incident_day <= 7  then 40
               when p_day - i.incident_day <= 21 then 25
               else 10 end
        + case when t.lifecycle_stage in ('active','escalating','verified') then 20 else 0 end)::int
  from sweep.incident_threads t
  join sweep.incidents i on i.thread_id = t.id and i.version_no = 1
  left join sweep.entity_aliases a2 on a2.alias_norm = lower(trim(i.entity))
  left join sweep.entities e2 on e2.id = a2.entity_id
  cross join target
  where coalesce(e2.canonical_name, lower(trim(i.entity))) = target.ent
    and t.lifecycle_stage <> 'closed'
    and i.incident_day <= p_day
    and p_day - i.incident_day <= p_window_days
  order by 9 desc, 7 asc;
$$;


ALTER FUNCTION "sweep"."match_candidates"("p_entity" "text", "p_category" "text", "p_day" "date", "p_window_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "sweep"."match_candidates"("p_entity" "text", "p_category" "text", "p_day" "date", "p_window_days" integer) IS 'Shortlist for the match gate. Entity is RESOLVED through aliases (microsoft = Microsoft Corporation). Category is a ranking signal, never a filter — categories drift mid-incident. Returns candidates only; the routing decision is made by a model and logged in match_decisions.';



CREATE OR REPLACE FUNCTION "sweep"."norm_entity"("t" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select nullif(trim(regexp_replace(
    regexp_replace(
      lower(trim(t)),
      '[[:space:],]*(,|&)?[[:space:]]*(inc|inc\.|incorporated|corp|corp\.|corporation|plc|ltd|ltd\.|limited|llc|l\.l\.c\.|a/s|s\.a\.|sa|s\.p\.a\.|spa|ag|nv|n\.v\.|se|ab|oyj|as|holdings|holding|group|co|co\.|& co|and co)\.?$',
      '', 'i'),
    '[[:punct:]]+$', '')), '');
$_$;


ALTER FUNCTION "sweep"."norm_entity"("t" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "sweep"."record_material_change"("p_ref" "text", "p_class" "text", "p_what" "text", "p_prev" "text", "p_curr" "text", "p_why" "text" DEFAULT NULL::"text", "p_next" "text" DEFAULT NULL::"text", "p_occurred" "date" DEFAULT NULL::"date", "p_sources" "text"[] DEFAULT NULL::"text"[], "p_incident_id" bigint DEFAULT NULL::bigint) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
declare v_thread bigint; v_next int;
begin
  select id, latest_version + 1 into v_thread, v_next
    from sweep.incident_threads where public_ref = p_ref;
  if v_thread is null then raise exception 'unknown thread %', p_ref; end if;

  insert into sweep.incident_versions
    (thread_id, version_no, incident_id, change_class, occurred_at, evidence_cutoff,
     what_changed, previous_position, current_position, why_changed, next_trigger, source_urls)
  values (v_thread, v_next, p_incident_id, p_class::sweep.change_class,
          coalesce(p_occurred, current_date)::timestamptz, now(),
          p_what, p_prev, p_curr, p_why, p_next, p_sources);

  update sweep.incident_threads
     set latest_version          = v_next,
         last_material_change_at = coalesce(p_occurred, current_date)::timestamptz,
         last_reviewed_at        = now(),
         evidence_cutoff         = now(),
         freshness_state         = 'current',
         lifecycle_stage = case
           when p_class = 'reopen'   then 'reopened'::sweep.lifecycle_stage
           when p_class = 'closure'  then 'closed'::sweep.lifecycle_stage
           when p_class = 'recovery' then 'recovering'::sweep.lifecycle_stage
           when p_class in ('escalation','scope_expansion') then 'escalating'::sweep.lifecycle_stage
           else lifecycle_stage end,
         updated_at = now()
   where id = v_thread;
  return v_next;
end $$;


ALTER FUNCTION "sweep"."record_material_change"("p_ref" "text", "p_class" "text", "p_what" "text", "p_prev" "text", "p_curr" "text", "p_why" "text", "p_next" "text", "p_occurred" "date", "p_sources" "text"[], "p_incident_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "sweep"."record_no_change"("p_ref" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  update sweep.incident_threads
     set last_reviewed_at = now(),
         freshness_state  = 'current',
         updated_at       = now()
   where public_ref = p_ref;
  insert into sweep.match_decisions (matched_thread_id, decision, reasoning, decided_by)
  select id, 'corroboration', coalesce(p_note,'Continuity review found no material change since evidence cutoff.'), 'model'
    from sweep.incident_threads where public_ref = p_ref;
end $$;


ALTER FUNCTION "sweep"."record_no_change"("p_ref" "text", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "sweep"."set_consequence"("p_ref" "text", "p_dim" "text", "p_state" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "sql"
    AS $$
  insert into sweep.thread_consequences (thread_id, dimension, state, note, updated_at)
  select id, p_dim, p_state::sweep.consequence_state, p_note, now()
    from sweep.incident_threads where public_ref = p_ref
  on conflict (thread_id, dimension)
  do update set state = excluded.state, note = coalesce(excluded.note, sweep.thread_consequences.note),
                updated_at = now();
$$;


ALTER FUNCTION "sweep"."set_consequence"("p_ref" "text", "p_dim" "text", "p_state" "text", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "sweep"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;


ALTER FUNCTION "sweep"."touch_updated_at"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "cms"."global_blocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "block" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "cms"."global_blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "cms"."keyword_registry" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "keyword" "text" NOT NULL,
    "page_id" "uuid",
    "intent" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "cms"."keyword_registry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "cms"."page_revisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "page_id" "uuid" NOT NULL,
    "title" "text",
    "seo" "jsonb",
    "blocks" "jsonb",
    "saved_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "cms"."page_revisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "cms"."pages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "collection" "text" DEFAULT 'blog'::"text" NOT NULL,
    "slug" "text" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "seo" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "blocks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "author" "text" DEFAULT 'Aman Sehgal'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "published_at" timestamp with time zone,
    CONSTRAINT "pages_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'published'::"text", 'scheduled'::"text", 'archived'::"text"])))
);


ALTER TABLE "cms"."pages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "content"."reporters" (
    "id" bigint NOT NULL,
    "sweep_id" bigint,
    "slug" "text" NOT NULL,
    "name" "text",
    "desk" "text",
    "cats" "text"[],
    "color" "text"
);


ALTER TABLE "content"."reporters" OWNER TO "postgres";


ALTER TABLE "content"."reporters" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "content"."reporters_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "identity"."partner_applications" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "email" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "company" "text" NOT NULL,
    "role" "text" NOT NULL,
    "sector" "text",
    "linkedin_url" "text",
    "why_interested" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "uuid",
    "decision_notes" "text",
    CONSTRAINT "partner_app_email_not_blank" CHECK (("length"(TRIM(BOTH FROM "email")) > 0)),
    CONSTRAINT "partner_applications_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "identity"."partner_applications" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "identity"."partner_applications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "identity"."partner_applications_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "identity"."partner_applications_id_seq" OWNED BY "identity"."partner_applications"."id";



CREATE TABLE IF NOT EXISTS "identity"."partner_feedback" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "email" "text" NOT NULL,
    "q_one_thing_pay" "text",
    "q_killer_feature" "text",
    "q_free_inbox" "text",
    "q_report_tease_stop" "text",
    "q_vendor_signposting" "text",
    "q_firehose_volume" "text",
    "additional_notes" "text",
    "tier_at_submission" "text",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "identity"."partner_feedback" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "identity"."partner_feedback_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "identity"."partner_feedback_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "identity"."partner_feedback_id_seq" OWNED BY "identity"."partner_feedback"."id";



CREATE TABLE IF NOT EXISTS "identity"."plans" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "tier" "text" NOT NULL,
    "price_cents" integer,
    "currency" "text" DEFAULT 'INR'::"text" NOT NULL,
    "interval" "text",
    "stripe_price_id" "text",
    "active" boolean DEFAULT true NOT NULL,
    "features" "jsonb",
    "metadata" "jsonb",
    "display_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "plans_tier_check" CHECK (("tier" = ANY (ARRAY['free'::"text", 'partner'::"text", 'enterprise'::"text", 'vendor'::"text", 'admin'::"text"])))
);


ALTER TABLE "identity"."plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "identity"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "company" "text",
    "role" "text",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email_subscribed" boolean DEFAULT true NOT NULL,
    "unsubscribe_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stripe_customer_id" "text",
    "full_name" "text",
    "industry" "text",
    "country" "text",
    "company_size" "text",
    "watch_industries" "jsonb",
    "watch_categories" "jsonb",
    "digest_frequency" "text" DEFAULT 'daily'::"text",
    "onboarded_at" timestamp with time zone,
    "avatar_url" "text",
    CONSTRAINT "profiles_tier_check" CHECK (("tier" = ANY (ARRAY['free'::"text", 'partner'::"text", 'enterprise'::"text", 'vendor'::"text", 'admin'::"text"])))
);


ALTER TABLE "identity"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "identity"."subscriptions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "stripe_subscription_id" "text",
    "stripe_customer_id" "text",
    "status" "text" NOT NULL,
    "plan_id" "text",
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "canceled_at" timestamp with time zone,
    "trial_end" timestamp with time zone,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "identity"."subscriptions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "identity"."subscriptions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "identity"."subscriptions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "identity"."subscriptions_id_seq" OWNED BY "identity"."subscriptions"."id";



CREATE TABLE IF NOT EXISTS "identity"."vendor_applications" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "email" "text" NOT NULL,
    "company_name" "text" NOT NULL,
    "contact_name" "text" NOT NULL,
    "contact_role" "text" NOT NULL,
    "website" "text",
    "linkedin_url" "text",
    "categories" "text"[],
    "capability_summary" "text" NOT NULL,
    "target_sectors" "text"[],
    "founded_year" integer,
    "headquarters_country" "text",
    "listing_tier" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "uuid",
    "decision_notes" "text",
    CONSTRAINT "vendor_applications_listing_tier_check" CHECK (("listing_tier" = ANY (ARRAY['basic'::"text", 'featured'::"text", 'premium'::"text"]))),
    CONSTRAINT "vendor_applications_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'withdrawn'::"text"])))
);


ALTER TABLE "identity"."vendor_applications" OWNER TO "postgres";


COMMENT ON TABLE "identity"."vendor_applications" IS 'Vendor listing applications. Submitted via submit_vendor_application RPC. Admin sets status + listing_tier; tier flip handled by trigger.';



CREATE SEQUENCE IF NOT EXISTS "identity"."vendor_applications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "identity"."vendor_applications_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "identity"."vendor_applications_id_seq" OWNED BY "identity"."vendor_applications"."id";



CREATE OR REPLACE VIEW "intel"."v_cross_writer_duplicates" WITH ("security_invoker"='true') AS
 SELECT "r"."id" AS "routine_incident_id",
    "r"."report_ref" AS "routine_report_ref",
    "r"."entity" AS "routine_entity",
    "r"."event_date" AS "routine_event_date",
    "r"."primary_category" AS "routine_primary_category",
    "d"."incident_id" AS "other_incident_id",
    "d"."origin" AS "other_origin",
    "d"."is_intel_routine" AS "other_is_routine",
    ("d"."incident_id" > "r"."id") AS "other_is_newer",
    "d"."match_level",
    "d"."score",
    "d"."entity_overlap",
    "d"."exact_victim",
    "d"."day_gap",
    "d"."same_category",
    "d"."report_ref" AS "other_report_ref",
    "d"."entity" AS "other_entity",
    "d"."headline" AS "other_headline",
    "d"."event_date" AS "other_event_date",
    "d"."primary_category" AS "other_primary_category"
   FROM ("sweep"."incidents" "r"
     CROSS JOIN LATERAL "intel"."find_duplicates"("r"."entity", "r"."event_date", "r"."primary_category", "r"."primary_subcategory_code", "r"."disclosure_date", NULL::"text", 45, 0.5, "r"."id", true) "d"("incident_id", "match_level", "score", "entity_overlap", "exact_victim", "day_gap", "same_category", "same_subcategory", "is_intel_routine", "origin", "report_ref", "entity", "headline", "event_date", "disclosure_date", "primary_category", "primary_subcategory_code"))
  WHERE ((("r"."origin")::"text" = 'intel_routine'::"text") AND ((NOT "d"."is_intel_routine") OR ("d"."incident_id" > "r"."id")));


ALTER VIEW "intel"."v_cross_writer_duplicates" OWNER TO "postgres";


COMMENT ON VIEW "intel"."v_cross_writer_duplicates" IS 'For each intel_routine incident, the other incidents that look like the same event (45 days, overlap 0.5, same or unknown category, or exact victim). The Newsroom''s review-after-insert path.';



CREATE TABLE IF NOT EXISTS "sweep"."control_objectives" (
    "id" bigint NOT NULL,
    "incident_id" bigint,
    "objective_id" "text",
    "statement" "text",
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "control_objectives_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "control_objectives_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "sweep"."control_objectives" OWNER TO "postgres";


COMMENT ON TABLE "sweep"."control_objectives" IS 'CO-* tier: control objectives mapped to an incident.';



COMMENT ON COLUMN "sweep"."control_objectives"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "sweep"."control_objectives"."incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



COMMENT ON COLUMN "sweep"."control_objectives"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "sweep"."control_objectives"."intel_key" IS 'Idempotency key set by the Intelligence routine: stable across re-runs and unique within the incident (routine upserts ON CONFLICT (incident_id, intel_key)). Set exactly when writer = intel_routine; NULL on every other row. Added by 0001_intel_additions.';



CREATE OR REPLACE VIEW "intel"."v_routine_pins" WITH ("security_invoker"='true') AS
 SELECT "id" AS "incident_id",
    "report_ref",
        CASE
            WHEN (("origin")::"text" = 'intel_routine'::"text") THEN 'routine_pin'::"text"
            ELSE 'newsroom_link'::"text"
        END AS "pin_kind",
    ("origin")::"text" AS "origin",
    "sweep_id",
    "event_date",
    "severity",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."blast_radius" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "blast_radius_rows",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."peer_watchlist" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "peer_watchlist_rows",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."sources" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "sources_rows",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."control_objectives" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "control_objectives_rows",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."adaptive_controls" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "adaptive_controls_rows",
    ( SELECT "count"(*) AS "count"
           FROM "sweep"."historical_analogues" "c"
          WHERE (("c"."incident_id" = "i"."id") AND ("c"."writer" = 'intel_routine'::"text"))) AS "historical_analogues_rows"
   FROM "sweep"."incidents" "i"
  WHERE ((("origin")::"text" = 'intel_routine'::"text") OR ("report_ref" IS NOT NULL));


ALTER VIEW "intel"."v_routine_pins" OWNER TO "postgres";


COMMENT ON VIEW "intel"."v_routine_pins" IS 'Routine pins (origin intel_routine) and Newsroom rows linked to a report (report_ref set), with routine child row counts. Read by the Part B audit as app_reader.';



CREATE OR REPLACE VIEW "intel"."v_routine_write_issues" WITH ("security_invoker"='true') AS
 WITH "routine" AS (
         SELECT "i"."id"
           FROM "sweep"."incidents" "i"
          WHERE (("i"."origin")::"text" = 'intel_routine'::"text")
        )
 SELECT 'sweep.incidents'::"text" AS "table_name",
    "i"."id" AS "row_id",
    "i"."id" AS "incident_id",
    'routine incident without report_ref'::"text" AS "issue"
   FROM "sweep"."incidents" "i"
  WHERE ((("i"."origin")::"text" = 'intel_routine'::"text") AND ("i"."report_ref" IS NULL))
UNION ALL
 SELECT 'sweep.blast_radius'::"text" AS "table_name",
    "b"."id" AS "row_id",
    "b"."incident_id",
    'hook_* written on a routine row'::"text" AS "issue"
   FROM ("sweep"."blast_radius" "b"
     JOIN "routine" "r" ON (("r"."id" = "b"."incident_id")))
  WHERE (("b"."hook_product" IS NOT NULL) OR ("b"."hook_cta_label" IS NOT NULL) OR ("b"."hook_scenario_seed" IS NOT NULL))
UNION ALL
 SELECT 'sweep.blast_radius'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."blast_radius" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")))
UNION ALL
 SELECT 'sweep.peer_watchlist'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."peer_watchlist" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")))
UNION ALL
 SELECT 'sweep.sources'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."sources" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")))
UNION ALL
 SELECT 'sweep.control_objectives'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."control_objectives" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")))
UNION ALL
 SELECT 'sweep.adaptive_controls'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."adaptive_controls" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")))
UNION ALL
 SELECT 'sweep.historical_analogues'::"text" AS "table_name",
    "c"."id" AS "row_id",
    "c"."incident_id",
        CASE
            WHEN ("r"."id" IS NOT NULL) THEN 'row under a routine incident not tagged intel_routine'::"text"
            ELSE 'intel_routine row under a non-routine incident'::"text"
        END AS "issue"
   FROM ("sweep"."historical_analogues" "c"
     LEFT JOIN "routine" "r" ON (("r"."id" = "c"."incident_id")))
  WHERE (("r"."id" IS NOT NULL) <> (NOT ("c"."writer" IS DISTINCT FROM 'intel_routine'::"text")));


ALTER VIEW "intel"."v_routine_write_issues" OWNER TO "postgres";


COMMENT ON VIEW "intel"."v_routine_write_issues" IS 'Routine rows that break the writer rules. Should be empty.';



CREATE TABLE IF NOT EXISTS "map"."daily_snapshots" (
    "date_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "teasers" "jsonb",
    "incident_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "map"."daily_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "map"."daily_snapshots" IS 'Pre-rendered Attack Map payload, one row per date_key. Replaces the per-request fan-out across 19 tables and the static JSON baked into /public/sweeps/.';



CREATE OR REPLACE VIEW "map"."incident_detail" WITH ("security_invoker"='true') AS
 SELECT "id",
    "article_body",
    "severity_rationale",
    "disclosure_date"
   FROM "sweep"."incidents" "i";


ALTER VIEW "map"."incident_detail" OWNER TO "postgres";


CREATE OR REPLACE VIEW "map"."incident_feed" WITH ("security_invoker"='true') AS
 SELECT "id",
    "headline",
    "summary",
    "entity",
    "country",
    "location_name",
    "latitude",
    "longitude",
    "industry",
    "sector",
    "severity",
        CASE
            WHEN ("confidence" IS NULL) THEN NULL::"text"
            WHEN ("upper"("confidence") ~~ 'HIGH%'::"text") THEN 'HIGH'::"text"
            WHEN ("upper"("confidence") ~~ 'MEDIUM%'::"text") THEN 'MEDIUM'::"text"
            WHEN ("upper"("confidence") ~~ 'LOW%'::"text") THEN 'LOW'::"text"
            ELSE NULL::"text"
        END AS "confidence_level",
    "primary_category",
    "primary_subcategory_code",
    "primary_subcategory_name",
    "event_date",
    "incident_day",
    "origin"
   FROM "sweep"."incidents" "i";


ALTER VIEW "map"."incident_feed" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ops"."contacts" (
    "id" bigint NOT NULL,
    "org_name" "text" NOT NULL,
    "org_domain" "text",
    "org_country" "text",
    "side" "text" NOT NULL,
    "full_name" "text",
    "title" "text",
    "seniority" "text",
    "department" "text",
    "email" "text",
    "phone" "text",
    "linkedin_url" "text",
    "person_city" "text",
    "person_country" "text",
    "reason_incident_id" bigint,
    "reason_text" "text",
    "relevance_score" integer,
    "recommended_hook" "text",
    "campaign_status" "text" DEFAULT 'new'::"text" NOT NULL,
    "source" "text" DEFAULT 'simulated'::"text" NOT NULL,
    "source_ref" "text",
    "lawful_basis" "text" DEFAULT 'legitimate_interest'::"text" NOT NULL,
    "consent_status" "text" DEFAULT 'not_required'::"text" NOT NULL,
    "suppressed" boolean DEFAULT false NOT NULL,
    "retention_until" "date",
    "enriched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "ops"."contacts" OWNER TO "postgres";


COMMENT ON TABLE "ops"."contacts" IS 'B2B outreach contacts. Personal data — backend only, no anon/authenticated grant. GDPR fields: lawful_basis, consent_status, suppressed, retention_until.';



COMMENT ON COLUMN "ops"."contacts"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "ops"."contacts"."reason_incident_id" IS 'POINTER, not this row''s own number: which sweep.incidents row this belongs to (references sweep.incidents.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



ALTER TABLE "ops"."contacts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "ops"."contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "ops"."delivery_log" (
    "id" bigint NOT NULL,
    "sweep_id" bigint,
    "kind" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "recipient" "text",
    "status" "text" NOT NULL,
    "provider_id" "text",
    "error" "text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "ops"."delivery_log" OWNER TO "postgres";


COMMENT ON COLUMN "ops"."delivery_log"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "ops"."delivery_log"."sweep_id" IS 'POINTER, not this row''s own number: which sweep.runs row this belongs to (references sweep.runs.id). Many rows here can share one value — that is how one parent record links to all of its child rows.';



ALTER TABLE "ops"."delivery_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "ops"."delivery_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "ops"."report_recipients" (
    "id" bigint NOT NULL,
    "label" "text",
    "role" "text" DEFAULT 'full'::"text" NOT NULL,
    "channel" "text" NOT NULL,
    "address" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "report_recipients_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'whatsapp'::"text"]))),
    CONSTRAINT "report_recipients_role_check" CHECK (("role" = ANY (ARRAY['full'::"text", 'exec'::"text"])))
);


ALTER TABLE "ops"."report_recipients" OWNER TO "postgres";


COMMENT ON TABLE "ops"."report_recipients" IS 'Who receives automated incident reports, by channel and detail level.';



COMMENT ON COLUMN "ops"."report_recipients"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



ALTER TABLE "ops"."report_recipients" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "ops"."report_recipients_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "ops"."runs" (
    "id" bigint NOT NULL,
    "generated_at" timestamp with time zone NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_run_ref" "text",
    CONSTRAINT "runs_intel_run_ref_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_run_ref" IS NOT NULL)) AND (("intel_run_ref" IS NULL) OR (("char_length"("intel_run_ref") >= 1) AND ("char_length"("intel_run_ref") <= 200))))),
    CONSTRAINT "runs_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"]))))
);


ALTER TABLE "ops"."runs" OWNER TO "postgres";


COMMENT ON TABLE "ops"."runs" IS 'One row per daily sweep run.';



COMMENT ON COLUMN "ops"."runs"."id" IS 'Unique row key for this table (primary key). Auto-generated, so it happens to run 1,2,3... but its purpose is IDENTITY, not counting: other tables reference this value via their *_id columns. Never renumber or reuse it.';



COMMENT ON COLUMN "ops"."runs"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions.';



COMMENT ON COLUMN "ops"."runs"."intel_run_ref" IS 'Intelligence DB run id for runs written by the Intelligence routine. Set exactly when writer = intel_routine; unique when set, so a repeated run reuses its row.';



CREATE TABLE IF NOT EXISTS "ops"."sweep_notifications_log" (
    "sweep_date" "date" NOT NULL,
    "notified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "incident_count" integer,
    "http_request_id" bigint
);


ALTER TABLE "ops"."sweep_notifications_log" OWNER TO "postgres";


COMMENT ON TABLE "ops"."sweep_notifications_log" IS 'Idempotency table — one row per sweep date that has been notified. Prevents the digest from firing twice for the same sweep.';



ALTER TABLE "ops"."runs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "ops"."sweeps_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."adaptive_controls" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "control_id",
    "parent_mc_id",
    "statement",
    "rationale",
    "kind"
   FROM "sweep"."adaptive_controls";


ALTER VIEW "public"."adaptive_controls" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."adaptive_objectives" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "objective_id",
    "statement"
   FROM "sweep"."control_objectives";


ALTER VIEW "public"."adaptive_objectives" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."blast_radius" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "exposure_group",
    "name",
    "type",
    "country",
    "latitude",
    "longitude",
    "reason",
    "impact_score",
    "impact_rationale",
    "transmission_mechanism",
    "impact_horizon",
    "recommended_action_for_them",
    "hook_product",
    "hook_cta_label",
    "hook_scenario_seed"
   FROM "sweep"."blast_radius";


ALTER VIEW "public"."blast_radius" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."contacts" WITH ("security_invoker"='true') AS
 SELECT "id",
    "org_name",
    "org_domain",
    "org_country",
    "side",
    "full_name",
    "title",
    "seniority",
    "department",
    "email",
    "phone",
    "linkedin_url",
    "person_city",
    "person_country",
    "reason_incident_id",
    "reason_text",
    "relevance_score",
    "recommended_hook",
    "campaign_status",
    "source",
    "source_ref",
    "lawful_basis",
    "consent_status",
    "suppressed",
    "retention_until",
    "enriched_at",
    "created_at"
   FROM "ops"."contacts";


ALTER VIEW "public"."contacts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."delivery_log" WITH ("security_invoker"='true') AS
 SELECT "id",
    "sweep_id",
    "kind",
    "channel",
    "recipient",
    "status",
    "provider_id",
    "error",
    "payload",
    "created_at"
   FROM "ops"."delivery_log";


ALTER VIEW "public"."delivery_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."developments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "match_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "jurisdiction" "text",
    "domain" "text",
    "regulation" "text",
    "authority" "text",
    "sector" "text",
    "change_type" "text",
    "legal_status" "text",
    "publication_date" "date",
    "effective_date" "date",
    "enforcement_date" "date",
    "deadline" "date",
    "what_changed" "text",
    "who_affected" "text",
    "why_matters" "text",
    "primary_source" "text",
    "source_url" "text",
    "secondary_source" "text",
    "confidence" "text",
    "materiality" "text",
    "first_seen_run" "uuid",
    "last_seen_run" "uuid",
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "developments_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'UNVERIFIED'::"text"]))),
    CONSTRAINT "developments_materiality_check" CHECK (("materiality" = ANY (ARRAY['CRITICAL'::"text", 'HIGH'::"text", 'STANDARD'::"text"])))
);


ALTER TABLE "public"."developments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."historical_analogues" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "event_name",
    "entity",
    "year",
    "summary",
    "outcome"
   FROM "sweep"."historical_analogues";


ALTER VIEW "public"."historical_analogues" OWNER TO "postgres";


ALTER TABLE "public"."hub_reports" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."hub_reports_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."hub_reports_public" WITH ("security_invoker"='false') AS
 SELECT "id",
    "ref",
    "title",
    "subtitle",
    "summary",
    "industry",
    "primary_category",
    "severity",
    "incident_id",
    "hero_image_url",
    "author",
    "tags",
    "published_at",
    "updated_at"
   FROM "public"."hub_reports"
  WHERE ("status" = 'published'::"text");


ALTER VIEW "public"."hub_reports_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "sweep"."incident_updates" (
    "id" bigint NOT NULL,
    "incident_id" bigint NOT NULL,
    "sweep_id" bigint,
    "update_date" "date" NOT NULL,
    "headline" "text" NOT NULL,
    "what_changed" "text" NOT NULL,
    "development_type" "text" NOT NULL,
    "severity_before" integer,
    "severity_after" integer NOT NULL,
    "severity_rationale" "text",
    "verdict" "text" NOT NULL,
    "verify_note" "text",
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "applied_to_incident" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "writer" "text" DEFAULT 'newsroom'::"text",
    "intel_key" "text",
    CONSTRAINT "incident_updates_development_type_check" CHECK (("development_type" = ANY (ARRAY['root_cause'::"text", 'leadership_change'::"text", 'regulatory_action'::"text", 'legal_action'::"text", 'financial_impact'::"text", 'casualties'::"text", 'scale_change'::"text", 'recovery'::"text", 'attribution'::"text", 'other'::"text"]))),
    CONSTRAINT "incident_updates_headline_check" CHECK (("length"("btrim"("headline")) > 0)),
    CONSTRAINT "incident_updates_intel_key_chk" CHECK ((((NOT ("writer" IS DISTINCT FROM 'intel_routine'::"text")) = ("intel_key" IS NOT NULL)) AND (("intel_key" IS NULL) OR (("char_length"("intel_key") >= 1) AND ("char_length"("intel_key") <= 200))))),
    CONSTRAINT "incident_updates_intel_writer_chk" CHECK ((("writer" IS NULL) OR ("writer" = ANY (ARRAY['newsroom'::"text", 'intel_routine'::"text", 'manual'::"text"])))),
    CONSTRAINT "incident_updates_severity_after_check" CHECK ((("severity_after" >= 1) AND ("severity_after" <= 5))),
    CONSTRAINT "incident_updates_severity_before_check" CHECK ((("severity_before" >= 1) AND ("severity_before" <= 5))),
    CONSTRAINT "incident_updates_sources_check" CHECK (("jsonb_typeof"("sources") = 'array'::"text")),
    CONSTRAINT "incident_updates_verdict_check" CHECK (("verdict" = ANY (ARRAY['REAL'::"text", 'SUSPECT'::"text"]))),
    CONSTRAINT "incident_updates_what_changed_check" CHECK (("length"("btrim"("what_changed")) > 0))
);


ALTER TABLE "sweep"."incident_updates" OWNER TO "postgres";


COMMENT ON COLUMN "sweep"."incident_updates"."writer" IS 'Which pipeline wrote this row: newsroom (default for new rows), intel_routine (always set by the Intelligence routine) or manual. NULL = written before 0001_intel_additions. A routine follow-up may sit under a Newsroom incident.';



COMMENT ON COLUMN "sweep"."incident_updates"."intel_key" IS 'Idempotency key set by the Intelligence routine (its watch re-check id). Set exactly when writer = intel_routine; unique when set.';



CREATE OR REPLACE VIEW "public"."incident_updates" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "sweep_id",
    "update_date",
    "headline",
    "what_changed",
    "development_type",
    "severity_before",
    "severity_after",
    "severity_rationale",
    "verdict",
    "verify_note",
    "sources",
    "applied_to_incident",
    "created_at"
   FROM "sweep"."incident_updates";


ALTER VIEW "public"."incident_updates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "reference"."industries" (
    "id" integer NOT NULL,
    "industry" "text" NOT NULL,
    "gics_sector" "text" NOT NULL,
    "key_regulations" "text",
    "display_order" integer DEFAULT 100 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "in_universe" boolean DEFAULT true NOT NULL
);


ALTER TABLE "reference"."industries" OWNER TO "postgres";


COMMENT ON TABLE "reference"."industries" IS '40-industry controlled vocabulary for incident tagging (Attacked.ai master coverage list).';



CREATE OR REPLACE VIEW "public"."industries" WITH ("security_invoker"='true') AS
 SELECT "id",
    "industry",
    "gics_sector",
    "key_regulations",
    "display_order",
    "active",
    "in_universe"
   FROM "reference"."industries";


ALTER VIEW "public"."industries" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."map_daily_snapshot" WITH ("security_invoker"='true') AS
 SELECT "date_key",
    "incident_count",
    "teasers",
    "payload",
    "updated_at"
   FROM "map"."daily_snapshots";


ALTER VIEW "public"."map_daily_snapshot" OWNER TO "postgres";


COMMENT ON VIEW "public"."map_daily_snapshot" IS 'Attack Map daily cache. Fetch a date range instead of paginating incidents — no row cap.';



CREATE OR REPLACE VIEW "public"."map_incident_detail" WITH ("security_invoker"='true') AS
 SELECT "id",
    "article_body",
    "severity_rationale",
    "disclosure_date"
   FROM "map"."incident_detail";


ALTER VIEW "public"."map_incident_detail" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."map_incident_feed" WITH ("security_invoker"='true') AS
 SELECT "id",
    "headline",
    "summary",
    "entity",
    "country",
    "location_name",
    "latitude",
    "longitude",
    "industry",
    "sector",
    "severity",
    "confidence_level",
    "primary_category",
    "primary_subcategory_code",
    "primary_subcategory_name",
    "event_date",
    "incident_day",
    "origin"
   FROM "map"."incident_feed";


ALTER VIEW "public"."map_incident_feed" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."partner_applications" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "email",
    "full_name",
    "company",
    "role",
    "sector",
    "linkedin_url",
    "why_interested",
    "status",
    "submitted_at",
    "decided_at",
    "decided_by",
    "decision_notes"
   FROM "identity"."partner_applications";


ALTER VIEW "public"."partner_applications" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."partner_feedback" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "email",
    "q_one_thing_pay",
    "q_killer_feature",
    "q_free_inbox",
    "q_report_tease_stop",
    "q_vendor_signposting",
    "q_firehose_volume",
    "additional_notes",
    "tier_at_submission",
    "submitted_at"
   FROM "identity"."partner_feedback";


ALTER VIEW "public"."partner_feedback" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."peer_watchlist" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "name",
    "country",
    "latitude",
    "longitude",
    "exposure_reason"
   FROM "sweep"."peer_watchlist";


ALTER VIEW "public"."peer_watchlist" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."plans" WITH ("security_invoker"='true') AS
 SELECT "id",
    "name",
    "description",
    "tier",
    "price_cents",
    "currency",
    "interval",
    "stripe_price_id",
    "active",
    "features",
    "metadata",
    "display_order",
    "created_at",
    "updated_at"
   FROM "identity"."plans";


ALTER VIEW "public"."plans" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."profiles" WITH ("security_invoker"='true') AS
 SELECT "id",
    "email",
    "tier",
    "company",
    "role",
    "approved_at",
    "created_at",
    "updated_at",
    "email_subscribed",
    "unsubscribe_token",
    "stripe_customer_id",
    "full_name",
    "industry",
    "country",
    "company_size",
    "watch_industries",
    "watch_categories",
    "digest_frequency",
    "onboarded_at",
    "avatar_url"
   FROM "identity"."profiles";


ALTER VIEW "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scan_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "window_start" "date",
    "window_end" "date",
    "domains" "text"[],
    "item_count" integer DEFAULT 0,
    "notes" "text",
    "artifact_url" "text",
    "artifact_title" "text"
);


ALTER TABLE "public"."scan_runs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."recent_reports" AS
 SELECT "run_at",
    "artifact_title",
    "artifact_url",
    "item_count",
    "notes"
   FROM "public"."scan_runs"
  WHERE ("artifact_url" IS NOT NULL)
  ORDER BY "run_at" DESC;


ALTER VIEW "public"."recent_reports" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."report_recipients" WITH ("security_invoker"='true') AS
 SELECT "id",
    "label",
    "role",
    "channel",
    "address",
    "active",
    "created_at"
   FROM "ops"."report_recipients";


ALTER VIEW "public"."report_recipients" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."reporters" WITH ("security_invoker"='true') AS
 SELECT "id",
    "sweep_id",
    "slug",
    "name",
    "desk",
    "cats",
    "color"
   FROM "content"."reporters";


ALTER VIEW "public"."reporters" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rpt_category_by_sweep" WITH ("security_invoker"='true') AS
 WITH "cats"("code", "name") AS (
         VALUES ('STR'::"text",'Strategic'::"text"), ('OPS'::"text",'Operational'::"text"), ('FIN'::"text",'Financial'::"text"), ('REG'::"text",'Regulatory'::"text"), ('CYB'::"text",'Cyber'::"text"), ('DAT'::"text",'Data'::"text"), ('TPR'::"text",'Third-party'::"text"), ('PPL'::"text",'People'::"text"), ('TEC'::"text",'Technology'::"text"), ('GEO'::"text",'Geopolitical'::"text"), ('REP'::"text",'Reputational'::"text"), ('ENV'::"text",'Environmental'::"text"), ('PHY'::"text",'Physical'::"text")
        )
 SELECT "s"."id" AS "sweep_id",
    "s"."generated_at",
    "c"."code" AS "category",
    "c"."name" AS "category_name",
    "count"("i"."id") AS "incidents",
    "count"(*) FILTER (WHERE ("i"."severity" >= 4)) AS "major"
   FROM (("ops"."runs" "s"
     CROSS JOIN "cats" "c")
     LEFT JOIN "sweep"."incidents" "i" ON ((("i"."sweep_id" = "s"."id") AND ("i"."primary_category" = "c"."code"))))
  GROUP BY "s"."id", "s"."generated_at", "c"."code", "c"."name";


ALTER VIEW "public"."rpt_category_by_sweep" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rpt_incident_day_counts" WITH ("security_invoker"='true') AS
 SELECT "incident_day" AS "day",
    "count"(*) AS "incidents",
    "count"(*) FILTER (WHERE ("severity" >= 4)) AS "major",
    "count"(*) FILTER (WHERE ("severity" = 5)) AS "critical",
    "count"(DISTINCT "primary_category") AS "categories_hit"
   FROM "sweep"."incidents" "i"
  WHERE ("incident_day" IS NOT NULL)
  GROUP BY "incident_day";


ALTER VIEW "public"."rpt_incident_day_counts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rpt_major_incidents" WITH ("security_invoker"='true') AS
 SELECT "sweep_id",
    "id" AS "incident_id",
    "headline",
    "entity",
    "sector",
    "country",
    "primary_category" AS "category",
    "primary_subcategory_name" AS "subcategory",
    "severity",
    "confidence",
    "incident_day"
   FROM "sweep"."incidents" "i"
  WHERE ("severity" >= 4);


ALTER VIEW "public"."rpt_major_incidents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rpt_sweep_summary" WITH ("security_invoker"='true') AS
 SELECT "s"."id" AS "sweep_id",
    "s"."generated_at",
    ("s"."generated_at")::"date" AS "sweep_date",
    "count"("i"."id") AS "total_incidents",
    "count"(*) FILTER (WHERE ("i"."severity" >= 4)) AS "major_count",
    "count"(*) FILTER (WHERE ("i"."severity" = 5)) AS "critical_count",
    "max"("i"."severity") AS "max_severity",
    "round"("avg"("i"."severity"), 2) AS "avg_severity",
    "count"(DISTINCT "i"."primary_category") AS "categories_hit",
    "count"(DISTINCT "i"."sector") FILTER (WHERE ("i"."sector" IS NOT NULL)) AS "sectors_hit",
    "count"(DISTINCT "i"."country") FILTER (WHERE ("i"."country" IS NOT NULL)) AS "countries_hit"
   FROM ("ops"."runs" "s"
     LEFT JOIN "sweep"."incidents" "i" ON (("i"."sweep_id" = "s"."id")))
  GROUP BY "s"."id", "s"."generated_at";


ALTER VIEW "public"."rpt_sweep_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rpt_sweep_trend" WITH ("security_invoker"='true') AS
 SELECT "sweep_id",
    "generated_at",
    "sweep_date",
    "total_incidents",
    "major_count",
    "critical_count",
    "max_severity",
    "avg_severity",
    "categories_hit",
    "sectors_hit",
    "countries_hit",
    "lag"("sweep_id") OVER "w" AS "prev_sweep_id",
    "lag"("total_incidents") OVER "w" AS "prev_total_incidents",
    ("total_incidents" - "lag"("total_incidents") OVER "w") AS "total_delta",
    "round"("avg"("total_incidents") OVER (ORDER BY "generated_at" ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING), 2) AS "trailing7_avg"
   FROM "public"."rpt_sweep_summary" "ss"
  WINDOW "w" AS (ORDER BY "generated_at");


ALTER VIEW "public"."rpt_sweep_trend" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sources" WITH ("security_invoker"='true') AS
 SELECT "id",
    "incident_id",
    "title",
    "url",
    "publisher"
   FROM "sweep"."sources";


ALTER VIEW "public"."sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."status_history" (
    "id" bigint NOT NULL,
    "development_id" "uuid" NOT NULL,
    "run_id" "uuid",
    "previous_status" "text",
    "new_status" "text" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."status_history" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."status_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."status_history_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."status_history_id_seq" OWNED BY "public"."status_history"."id";



CREATE OR REPLACE VIEW "public"."subscriptions" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "stripe_subscription_id",
    "stripe_customer_id",
    "status",
    "plan_id",
    "current_period_start",
    "current_period_end",
    "cancel_at_period_end",
    "canceled_at",
    "trial_end",
    "metadata",
    "created_at",
    "updated_at"
   FROM "identity"."subscriptions";


ALTER VIEW "public"."subscriptions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sweep_notifications_log" WITH ("security_invoker"='true') AS
 SELECT "sweep_date",
    "notified_at",
    "incident_count",
    "http_request_id"
   FROM "ops"."sweep_notifications_log";


ALTER VIEW "public"."sweep_notifications_log" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."sweeps" WITH ("security_invoker"='true') AS
 SELECT "id",
    "generated_at",
    "uploaded_at"
   FROM "ops"."runs";


ALTER VIEW "public"."sweeps" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."upcoming_deadlines" AS
 SELECT "match_key",
    "title",
    "jurisdiction",
    "domain",
    "regulation",
    "deadline",
    "confidence",
    "materiality",
    "source_url",
    ("deadline" - CURRENT_DATE) AS "days_remaining",
        CASE
            WHEN (("deadline" - CURRENT_DATE) <= 30) THEN '0-30 days'::"text"
            WHEN (("deadline" - CURRENT_DATE) <= 60) THEN '31-60 days'::"text"
            WHEN (("deadline" - CURRENT_DATE) <= 90) THEN '61-90 days'::"text"
            WHEN (("deadline" - CURRENT_DATE) <= 180) THEN '91-180 days'::"text"
            ELSE 'beyond 180 days'::"text"
        END AS "bucket"
   FROM "public"."developments"
  WHERE (("deadline" IS NOT NULL) AND ("deadline" >= CURRENT_DATE))
  ORDER BY "deadline";


ALTER VIEW "public"."upcoming_deadlines" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_daily_trend" WITH ("security_invoker"='true') AS
 SELECT "incident_day" AS "day",
    "count"(*) AS "total_incidents",
    "count"(*) FILTER (WHERE ("severity" >= 4)) AS "major_incidents",
    "count"(*) FILTER (WHERE ("severity" = 5)) AS "critical_incidents",
    "round"("avg"("severity"), 2) AS "avg_severity"
   FROM "sweep"."incidents" "i"
  WHERE ("incident_day" IS NOT NULL)
  GROUP BY "incident_day"
  ORDER BY "incident_day";


ALTER VIEW "public"."v_daily_trend" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_sweep_summary" WITH ("security_invoker"='true') AS
 SELECT "s"."id" AS "sweep_id",
    "s"."generated_at",
    (("s"."generated_at" AT TIME ZONE 'UTC'::"text"))::"date" AS "sweep_date",
    "count"("i"."id") AS "total_incidents",
    "count"(*) FILTER (WHERE ("i"."severity" >= 4)) AS "major_incidents",
    "count"(*) FILTER (WHERE ("i"."severity" = 5)) AS "critical_incidents",
    "count"(*) FILTER (WHERE ("i"."severity" = 4)) AS "high_incidents",
    "round"("avg"("i"."severity"), 2) AS "avg_severity",
    "count"(DISTINCT "i"."primary_category") AS "categories_hit",
    "count"(DISTINCT "i"."sector") AS "sectors_hit",
    "count"(DISTINCT "i"."country") AS "countries_hit",
    "count"(*) FILTER (WHERE ("i"."confidence" = 'High'::"text")) AS "high_confidence"
   FROM ("ops"."runs" "s"
     LEFT JOIN "sweep"."incidents" "i" ON (("i"."sweep_id" = "s"."id")))
  GROUP BY "s"."id", "s"."generated_at";


ALTER VIEW "public"."v_sweep_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_latest_sweep" WITH ("security_invoker"='true') AS
 SELECT "sweep_id",
    "generated_at",
    "sweep_date",
    "total_incidents",
    "major_incidents"
   FROM "public"."v_sweep_summary"
  ORDER BY "generated_at" DESC
 LIMIT 1;


ALTER VIEW "public"."v_latest_sweep" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_risk_category_labels" WITH ("security_invoker"='true') AS
 SELECT "code",
    "label"
   FROM ( VALUES ('OPS'::"text",'Operational'::"text"), ('GEO'::"text",'Geopolitical'::"text"), ('STR'::"text",'Strategic'::"text"), ('CYB'::"text",'Cyber Security'::"text"), ('PPL'::"text",'People & Human Capital'::"text"), ('REP'::"text",'Reputational'::"text"), ('ENV'::"text",'Environmental'::"text"), ('TEC'::"text",'Technology'::"text"), ('DAT'::"text",'Data & Privacy'::"text"), ('PHY'::"text",'Physical Security'::"text"), ('TPR'::"text",'Third-Party Risk'::"text"), ('REG'::"text",'Regulatory'::"text"), ('FIN'::"text",'Financial'::"text")) "t"("code", "label");


ALTER VIEW "public"."v_risk_category_labels" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_major_incidents" WITH ("security_invoker"='true') AS
 SELECT "i"."id",
    "i"."sweep_id",
    "i"."severity",
    "i"."headline",
    "i"."summary",
    "i"."entity",
    "i"."sector",
    "i"."country",
    "i"."primary_category" AS "code",
    COALESCE("l"."label", "i"."primary_category") AS "category_label",
    "i"."primary_subcategory_name" AS "subcategory",
    "i"."confidence",
    "i"."incident_day",
    "i"."event_date",
    "i"."disclosure_date"
   FROM ("sweep"."incidents" "i"
     LEFT JOIN "public"."v_risk_category_labels" "l" ON (("l"."code" = "i"."primary_category")))
  WHERE ("i"."severity" >= 4);


ALTER VIEW "public"."v_major_incidents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_sweep_category_counts" WITH ("security_invoker"='true') AS
 SELECT "i"."sweep_id",
    "i"."primary_category" AS "code",
    COALESCE("l"."label", "i"."primary_category") AS "label",
    "count"(*) AS "incidents",
    "count"(*) FILTER (WHERE ("i"."severity" >= 4)) AS "major",
    "round"("avg"("i"."severity"), 2) AS "avg_severity"
   FROM ("sweep"."incidents" "i"
     LEFT JOIN "public"."v_risk_category_labels" "l" ON (("l"."code" = "i"."primary_category")))
  GROUP BY "i"."sweep_id", "i"."primary_category", "l"."label";


ALTER VIEW "public"."v_sweep_category_counts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_sweep_incidents" AS
 SELECT "i"."id",
    "i"."sweep_id",
    "i"."severity",
    "i"."headline",
    "i"."summary",
    "i"."entity",
    "i"."sector",
    "i"."country",
    "i"."primary_category" AS "code",
    COALESCE("l"."label", "i"."primary_category") AS "category_label",
    "i"."primary_subcategory_name" AS "subcategory",
    "i"."confidence",
    "i"."incident_day",
    "i"."primary_subcategory_code" AS "subcategory_code",
    "i"."secondary_mappings"
   FROM ("sweep"."incidents" "i"
     LEFT JOIN "public"."v_risk_category_labels" "l" ON (("l"."code" = "i"."primary_category")));


ALTER VIEW "public"."v_sweep_incidents" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vendor_applications" WITH ("security_invoker"='true') AS
 SELECT "id",
    "user_id",
    "email",
    "company_name",
    "contact_name",
    "contact_role",
    "website",
    "linkedin_url",
    "categories",
    "capability_summary",
    "target_sectors",
    "founded_year",
    "headquarters_country",
    "listing_tier",
    "status",
    "submitted_at",
    "decided_at",
    "decided_by",
    "decision_notes"
   FROM "identity"."vendor_applications";


ALTER VIEW "public"."vendor_applications" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "reference"."industries_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "reference"."industries_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "reference"."industries_id_seq" OWNED BY "reference"."industries"."id";



ALTER TABLE "sweep"."adaptive_controls" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "sweep"."adaptive_controls_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "sweep"."control_objectives" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."adaptive_objectives_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "sweep"."blast_radius" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."blast_radius_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "sweep"."historical_analogues" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."historical_analogues_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE SEQUENCE IF NOT EXISTS "sweep"."incident_updates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "sweep"."incident_updates_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "sweep"."incident_updates_id_seq" OWNED BY "sweep"."incident_updates"."id";



ALTER TABLE "sweep"."incidents" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."incidents_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "sweep"."peer_watchlist" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."peer_watchlist_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "sweep"."sources" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "sweep"."sources_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "identity"."partner_applications" ALTER COLUMN "id" SET DEFAULT "nextval"('"identity"."partner_applications_id_seq"'::"regclass");



ALTER TABLE ONLY "identity"."partner_feedback" ALTER COLUMN "id" SET DEFAULT "nextval"('"identity"."partner_feedback_id_seq"'::"regclass");



ALTER TABLE ONLY "identity"."subscriptions" ALTER COLUMN "id" SET DEFAULT "nextval"('"identity"."subscriptions_id_seq"'::"regclass");



ALTER TABLE ONLY "identity"."vendor_applications" ALTER COLUMN "id" SET DEFAULT "nextval"('"identity"."vendor_applications_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."status_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."status_history_id_seq"'::"regclass");



ALTER TABLE ONLY "reference"."industries" ALTER COLUMN "id" SET DEFAULT "nextval"('"reference"."industries_id_seq"'::"regclass");



ALTER TABLE ONLY "sweep"."incident_updates" ALTER COLUMN "id" SET DEFAULT "nextval"('"sweep"."incident_updates_id_seq"'::"regclass");



ALTER TABLE ONLY "cms"."global_blocks"
    ADD CONSTRAINT "global_blocks_name_key" UNIQUE ("name");



ALTER TABLE ONLY "cms"."global_blocks"
    ADD CONSTRAINT "global_blocks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "cms"."keyword_registry"
    ADD CONSTRAINT "keyword_registry_keyword_key" UNIQUE ("keyword");



ALTER TABLE ONLY "cms"."keyword_registry"
    ADD CONSTRAINT "keyword_registry_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "cms"."page_revisions"
    ADD CONSTRAINT "page_revisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "cms"."pages"
    ADD CONSTRAINT "pages_collection_slug_key" UNIQUE ("collection", "slug");



ALTER TABLE ONLY "cms"."pages"
    ADD CONSTRAINT "pages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "content"."reporters"
    ADD CONSTRAINT "reporters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."partner_applications"
    ADD CONSTRAINT "partner_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."partner_feedback"
    ADD CONSTRAINT "partner_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "identity"."subscriptions"
    ADD CONSTRAINT "subscriptions_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "identity"."vendor_applications"
    ADD CONSTRAINT "vendor_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "map"."daily_snapshots"
    ADD CONSTRAINT "attack_map_sweeps_pkey" PRIMARY KEY ("date_key");



ALTER TABLE ONLY "ops"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ops"."delivery_log"
    ADD CONSTRAINT "delivery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ops"."report_recipients"
    ADD CONSTRAINT "report_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ops"."sweep_notifications_log"
    ADD CONSTRAINT "sweep_notifications_log_pkey" PRIMARY KEY ("sweep_date");



ALTER TABLE ONLY "ops"."runs"
    ADD CONSTRAINT "sweeps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."developments"
    ADD CONSTRAINT "developments_match_key_key" UNIQUE ("match_key");



ALTER TABLE ONLY "public"."developments"
    ADD CONSTRAINT "developments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hub_reports"
    ADD CONSTRAINT "hub_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hub_reports"
    ADD CONSTRAINT "hub_reports_ref_key" UNIQUE ("ref");



ALTER TABLE ONLY "public"."scan_runs"
    ADD CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "reference"."industries"
    ADD CONSTRAINT "industries_industry_key" UNIQUE ("industry");



ALTER TABLE ONLY "reference"."industries"
    ADD CONSTRAINT "industries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."adaptive_controls"
    ADD CONSTRAINT "adaptive_controls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."control_objectives"
    ADD CONSTRAINT "adaptive_objectives_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."blast_radius"
    ADD CONSTRAINT "blast_radius_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."historical_analogues"
    ADD CONSTRAINT "historical_analogues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."incident_updates"
    ADD CONSTRAINT "incident_updates_once" UNIQUE ("incident_id", "update_date", "headline");



ALTER TABLE ONLY "sweep"."incident_updates"
    ADD CONSTRAINT "incident_updates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."incidents"
    ADD CONSTRAINT "incidents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."peer_watchlist"
    ADD CONSTRAINT "peer_watchlist_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "sweep"."sources"
    ADD CONSTRAINT "sources_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_reporters_sweep" ON "content"."reporters" USING "btree" ("sweep_id");



CREATE INDEX "idx_pa_decided" ON "identity"."partner_applications" USING "btree" ("decided_by");



CREATE INDEX "idx_subs_plan" ON "identity"."subscriptions" USING "btree" ("plan_id");



CREATE INDEX "idx_va_decided" ON "identity"."vendor_applications" USING "btree" ("decided_by");



CREATE INDEX "idx_vendor_apps_email" ON "identity"."vendor_applications" USING "btree" ("lower"("email"));



CREATE INDEX "idx_vendor_apps_status" ON "identity"."vendor_applications" USING "btree" ("status");



CREATE INDEX "idx_vendor_apps_user" ON "identity"."vendor_applications" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "partner_apps_email_idx" ON "identity"."partner_applications" USING "btree" ("lower"("email"));



CREATE UNIQUE INDEX "partner_apps_one_pending_per_email" ON "identity"."partner_applications" USING "btree" ("lower"("email")) WHERE ("status" = 'pending'::"text");



CREATE INDEX "partner_apps_status_idx" ON "identity"."partner_applications" USING "btree" ("status");



CREATE INDEX "partner_apps_user_id_idx" ON "identity"."partner_applications" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "partner_feedback_email_idx" ON "identity"."partner_feedback" USING "btree" ("lower"("email"));



CREATE INDEX "partner_feedback_submitted_at_idx" ON "identity"."partner_feedback" USING "btree" ("submitted_at" DESC);



CREATE INDEX "partner_feedback_user_id_idx" ON "identity"."partner_feedback" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);



CREATE INDEX "plans_active_order_idx" ON "identity"."plans" USING "btree" ("display_order") WHERE ("active" = true);



CREATE INDEX "profiles_email_idx" ON "identity"."profiles" USING "btree" ("email");



CREATE INDEX "profiles_stripe_customer_id_idx" ON "identity"."profiles" USING "btree" ("stripe_customer_id") WHERE ("stripe_customer_id" IS NOT NULL);



CREATE INDEX "profiles_tier_idx" ON "identity"."profiles" USING "btree" ("tier");



CREATE INDEX "profiles_tier_subscribed_idx" ON "identity"."profiles" USING "btree" ("tier", "email_subscribed") WHERE ("email_subscribed" = true);



CREATE UNIQUE INDEX "profiles_unsubscribe_token_idx" ON "identity"."profiles" USING "btree" ("unsubscribe_token");



CREATE INDEX "subscriptions_period_end_idx" ON "identity"."subscriptions" USING "btree" ("current_period_end");



CREATE INDEX "subscriptions_status_idx" ON "identity"."subscriptions" USING "btree" ("status");



CREATE INDEX "subscriptions_user_id_idx" ON "identity"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "attack_map_sweeps_updated_idx" ON "map"."daily_snapshots" USING "btree" ("updated_at" DESC);



CREATE INDEX "contacts_incident_idx" ON "ops"."contacts" USING "btree" ("reason_incident_id");



CREATE INDEX "contacts_org_idx" ON "ops"."contacts" USING "btree" ("org_name");



CREATE INDEX "contacts_side_idx" ON "ops"."contacts" USING "btree" ("side", "suppressed");



CREATE INDEX "delivery_log_created_idx" ON "ops"."delivery_log" USING "btree" ("created_at" DESC);



CREATE INDEX "delivery_log_sweep_idx" ON "ops"."delivery_log" USING "btree" ("sweep_id");



CREATE INDEX "idx_sweeps_generated" ON "ops"."runs" USING "btree" ("generated_at" DESC);



CREATE UNIQUE INDEX "runs_intel_run_ref_uidx" ON "ops"."runs" USING "btree" ("intel_run_ref") WHERE ("intel_run_ref" IS NOT NULL);



CREATE UNIQUE INDEX "unique_sweep_generated_at" ON "ops"."runs" USING "btree" ("generated_at");



CREATE INDEX "developments_deadline_idx" ON "public"."developments" USING "btree" ("deadline") WHERE ("deadline" IS NOT NULL);



CREATE INDEX "developments_domain_idx" ON "public"."developments" USING "btree" ("domain");



CREATE INDEX "developments_jurisdiction_idx" ON "public"."developments" USING "btree" ("jurisdiction");



CREATE INDEX "developments_last_seen_idx" ON "public"."developments" USING "btree" ("last_seen_at" DESC);



CREATE INDEX "status_history_dev_idx" ON "public"."status_history" USING "btree" ("development_id", "changed_at" DESC);



CREATE INDEX "idx_industries_active" ON "reference"."industries" USING "btree" ("active");



CREATE INDEX "idx_industries_sector" ON "reference"."industries" USING "btree" ("gics_sector");



CREATE UNIQUE INDEX "adaptive_controls_intel_key_uidx" ON "sweep"."adaptive_controls" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE UNIQUE INDEX "blast_radius_intel_key_uidx" ON "sweep"."blast_radius" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE UNIQUE INDEX "control_objectives_intel_key_uidx" ON "sweep"."control_objectives" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE UNIQUE INDEX "historical_analogues_intel_key_uidx" ON "sweep"."historical_analogues" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE INDEX "idx_adaptive_controls_incident" ON "sweep"."adaptive_controls" USING "btree" ("incident_id");



CREATE INDEX "idx_adaptive_controls_kind" ON "sweep"."adaptive_controls" USING "btree" ("kind");



CREATE INDEX "idx_aobj_incident" ON "sweep"."control_objectives" USING "btree" ("incident_id");



CREATE INDEX "idx_blast_bucket" ON "sweep"."blast_radius" USING "btree" ("exposure_group");



CREATE INDEX "idx_blast_inc" ON "sweep"."blast_radius" USING "btree" ("incident_id");



CREATE INDEX "idx_hist_incident" ON "sweep"."historical_analogues" USING "btree" ("incident_id");



CREATE INDEX "idx_incidents_country" ON "sweep"."incidents" USING "btree" ("country");



CREATE INDEX "idx_incidents_event" ON "sweep"."incidents" USING "btree" ("event_date" DESC);



CREATE INDEX "idx_incidents_industry" ON "sweep"."incidents" USING "btree" ("industry") WHERE ("industry" IS NOT NULL);



CREATE INDEX "idx_incidents_industry_id" ON "sweep"."incidents" USING "btree" ("industry_id");



CREATE INDEX "idx_incidents_origin" ON "sweep"."incidents" USING "btree" ("origin");



CREATE INDEX "idx_incidents_pcat" ON "sweep"."incidents" USING "btree" ("primary_category");



CREATE INDEX "idx_incidents_sev" ON "sweep"."incidents" USING "btree" ("severity");



CREATE INDEX "idx_incidents_sweep" ON "sweep"."incidents" USING "btree" ("sweep_id");



CREATE INDEX "idx_peer_incident" ON "sweep"."peer_watchlist" USING "btree" ("incident_id");



CREATE INDEX "idx_sources_inc" ON "sweep"."sources" USING "btree" ("incident_id");



CREATE INDEX "incident_updates_incident_id_idx" ON "sweep"."incident_updates" USING "btree" ("incident_id");



CREATE UNIQUE INDEX "incident_updates_intel_key_uidx" ON "sweep"."incident_updates" USING "btree" ("intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE INDEX "incident_updates_update_date_idx" ON "sweep"."incident_updates" USING "btree" ("update_date");



CREATE INDEX "incidents_audit_status_idx" ON "sweep"."incidents" USING "btree" ("audit_status");



CREATE UNIQUE INDEX "incidents_intel_report_ref_uidx" ON "sweep"."incidents" USING "btree" ("report_ref") WHERE ("report_ref" IS NOT NULL);



CREATE INDEX "incidents_verified_incident_idx" ON "sweep"."incidents" USING "btree" ("verified_incident") WHERE "verified_incident";



CREATE UNIQUE INDEX "peer_watchlist_intel_key_uidx" ON "sweep"."peer_watchlist" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE UNIQUE INDEX "sources_intel_key_uidx" ON "sweep"."sources" USING "btree" ("incident_id", "intel_key") WHERE ("intel_key" IS NOT NULL);



CREATE UNIQUE INDEX "uq_incidents_headline_entity_day" ON "sweep"."incidents" USING "btree" ("lower"("btrim"("headline")), "lower"("btrim"("entity")), "event_date");



COMMENT ON INDEX "sweep"."uq_incidents_headline_entity_day" IS 'Backstop against duplicate incident uploads. App-level dedup remains primary.';



CREATE OR REPLACE TRIGGER "profiles_touch_updated_at" BEFORE UPDATE ON "identity"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "subscriptions_touch_updated_at" BEFORE UPDATE ON "identity"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "trg_notify_application" AFTER INSERT OR UPDATE OF "status" ON "identity"."partner_applications" FOR EACH ROW EXECUTE FUNCTION "public"."notify_partner_application"();



CREATE OR REPLACE TRIGGER "trg_partner_approval" AFTER INSERT OR UPDATE OF "status" ON "identity"."partner_applications" FOR EACH ROW EXECUTE FUNCTION "public"."handle_partner_approval"();



CREATE OR REPLACE TRIGGER "trg_sync_subscription_tier" AFTER INSERT OR UPDATE OF "status" ON "identity"."subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."sync_subscription_tier"();



CREATE OR REPLACE TRIGGER "trg_vendor_approval" BEFORE UPDATE ON "identity"."vendor_applications" FOR EACH ROW EXECUTE FUNCTION "public"."handle_vendor_application_decision"();



CREATE OR REPLACE TRIGGER "trg_welcome_on_onboarded" AFTER UPDATE OF "onboarded_at" ON "identity"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_onboarded"();



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "ops"."runs" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_run_ref', '');



CREATE OR REPLACE TRIGGER "trg_notify_on_new_sweep" AFTER INSERT ON "ops"."runs" FOR EACH ROW EXECUTE FUNCTION "public"."notify_on_sweep_change"();



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."adaptive_controls" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."blast_radius" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."control_objectives" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."historical_analogues" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."incident_updates" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', '');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."incidents" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('origin', 'report_ref', '');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."peer_watchlist" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "intel_routine_write_guard" BEFORE INSERT OR DELETE OR UPDATE ON "sweep"."sources" FOR EACH ROW EXECUTE FUNCTION "intel"."tg_routine_write_guard"('writer', 'intel_key', 'child');



CREATE OR REPLACE TRIGGER "trg_map_refresh_del" AFTER DELETE ON "sweep"."incidents" REFERENCING OLD TABLE AS "old_rows" FOR EACH STATEMENT EXECUTE FUNCTION "map"."refresh_touched_days"();



CREATE OR REPLACE TRIGGER "trg_map_refresh_ins" AFTER INSERT ON "sweep"."incidents" REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "map"."refresh_touched_days"();



CREATE OR REPLACE TRIGGER "trg_map_refresh_upd" AFTER UPDATE ON "sweep"."incidents" REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "map"."refresh_touched_days"();



CREATE OR REPLACE TRIGGER "trg_notify_after_incidents_insert" AFTER INSERT ON "sweep"."incidents" FOR EACH STATEMENT EXECUTE FUNCTION "public"."notify_on_sweep_change"();



CREATE OR REPLACE TRIGGER "trg_sync_industry_text" BEFORE INSERT OR UPDATE OF "industry_id" ON "sweep"."incidents" FOR EACH ROW WHEN (("new"."industry_id" IS NOT NULL)) EXECUTE FUNCTION "public"."sync_industry_text_from_fk"();



ALTER TABLE ONLY "cms"."keyword_registry"
    ADD CONSTRAINT "keyword_registry_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "cms"."pages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "cms"."page_revisions"
    ADD CONSTRAINT "page_revisions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "cms"."pages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "content"."reporters"
    ADD CONSTRAINT "reporters_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "ops"."runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "identity"."partner_applications"
    ADD CONSTRAINT "partner_applications_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "identity"."partner_applications"
    ADD CONSTRAINT "partner_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "identity"."partner_feedback"
    ADD CONSTRAINT "partner_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "identity"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "identity"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "identity"."plans"("id");



ALTER TABLE ONLY "identity"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "identity"."vendor_applications"
    ADD CONSTRAINT "vendor_applications_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "identity"."vendor_applications"
    ADD CONSTRAINT "vendor_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "ops"."contacts"
    ADD CONSTRAINT "contacts_reason_incident_id_fkey" FOREIGN KEY ("reason_incident_id") REFERENCES "sweep"."incidents"("id");



ALTER TABLE ONLY "ops"."delivery_log"
    ADD CONSTRAINT "delivery_log_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "ops"."runs"("id");



ALTER TABLE ONLY "public"."developments"
    ADD CONSTRAINT "developments_first_seen_run_fkey" FOREIGN KEY ("first_seen_run") REFERENCES "public"."scan_runs"("id");



ALTER TABLE ONLY "public"."developments"
    ADD CONSTRAINT "developments_last_seen_run_fkey" FOREIGN KEY ("last_seen_run") REFERENCES "public"."scan_runs"("id");



ALTER TABLE ONLY "public"."hub_reports"
    ADD CONSTRAINT "hub_reports_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_development_id_fkey" FOREIGN KEY ("development_id") REFERENCES "public"."developments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."status_history"
    ADD CONSTRAINT "status_history_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."scan_runs"("id");



ALTER TABLE ONLY "sweep"."adaptive_controls"
    ADD CONSTRAINT "adaptive_controls_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."control_objectives"
    ADD CONSTRAINT "adaptive_objectives_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."blast_radius"
    ADD CONSTRAINT "blast_radius_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."historical_analogues"
    ADD CONSTRAINT "historical_analogues_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."incident_updates"
    ADD CONSTRAINT "incident_updates_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."incident_updates"
    ADD CONSTRAINT "incident_updates_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "ops"."runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "sweep"."incidents"
    ADD CONSTRAINT "incidents_industry_id_fkey" FOREIGN KEY ("industry_id") REFERENCES "reference"."industries"("id");



ALTER TABLE ONLY "sweep"."incidents"
    ADD CONSTRAINT "incidents_sweep_id_fkey" FOREIGN KEY ("sweep_id") REFERENCES "ops"."runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."peer_watchlist"
    ADD CONSTRAINT "peer_watchlist_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "sweep"."sources"
    ADD CONSTRAINT "sources_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "sweep"."incidents"("id") ON DELETE CASCADE;



CREATE POLICY "cms_globals_read" ON "cms"."global_blocks" FOR SELECT USING (true);



CREATE POLICY "cms_keywords_read" ON "cms"."keyword_registry" FOR SELECT USING (true);



CREATE POLICY "cms_pages_read" ON "cms"."pages" FOR SELECT USING (true);



CREATE POLICY "cms_revisions_read" ON "cms"."page_revisions" FOR SELECT USING (true);



ALTER TABLE "cms"."global_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "cms"."keyword_registry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "cms"."page_revisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "cms"."pages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anon select" ON "content"."reporters" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "guard_uploader_insert" ON "content"."reporters" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



ALTER TABLE "content"."reporters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "identity"."partner_applications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_apps_anyone_insert" ON "identity"."partner_applications" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "partner_apps_own_select" ON "identity"."partner_applications" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("lower"("email") = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))));



ALTER TABLE "identity"."partner_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_feedback_self_insert" ON "identity"."partner_feedback" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) OR ("lower"("email") = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))));



CREATE POLICY "partner_feedback_self_select" ON "identity"."partner_feedback" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("lower"("email") = "lower"(COALESCE(("auth"."jwt"() ->> 'email'::"text"), ''::"text")))));



ALTER TABLE "identity"."plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plans_anyone_select" ON "identity"."plans" FOR SELECT TO "authenticated", "anon" USING (("active" = true));



ALTER TABLE "identity"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_own_select" ON "identity"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));



CREATE POLICY "profiles_own_update" ON "identity"."profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "id")) WITH CHECK ((("auth"."uid"() = "id") AND ("tier" = ( SELECT "profiles_1"."tier"
   FROM "identity"."profiles" "profiles_1"
  WHERE ("profiles_1"."id" = "auth"."uid"())))));



ALTER TABLE "identity"."subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriptions_self_select" ON "identity"."subscriptions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "identity"."vendor_applications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "map"."daily_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "daily_snapshots_public_read" ON "map"."daily_snapshots" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select" ON "ops"."runs" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "app_reader_read" ON "ops"."runs" FOR SELECT TO "app_reader" USING (true);



ALTER TABLE "ops"."contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ops"."delivery_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "guard_uploader_insert" ON "ops"."runs" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "intel_globe_owner_insert" ON "ops"."runs" FOR INSERT TO "intel_globe_owner" WITH CHECK (("writer" = 'intel_routine'::"text"));



CREATE POLICY "intel_globe_owner_select" ON "ops"."runs" FOR SELECT TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text"));



CREATE POLICY "intel_globe_owner_update" ON "ops"."runs" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK (("writer" = 'intel_routine'::"text"));



ALTER TABLE "ops"."report_recipients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ops"."runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "ops"."sweep_notifications_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."developments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hub_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."scan_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."status_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "reference"."industries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "industries_public_read" ON "reference"."industries" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "intel_globe_owner_select" ON "reference"."industries" FOR SELECT TO "intel_globe_owner" USING (true);



ALTER TABLE "sweep"."adaptive_controls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anon select" ON "sweep"."control_objectives" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select" ON "sweep"."incident_updates" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select" ON "sweep"."incidents" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."adaptive_controls" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."blast_radius" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."control_objectives" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."historical_analogues" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."incident_updates" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."incidents" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."peer_watchlist" FOR SELECT TO "app_reader" USING (true);



CREATE POLICY "app_reader_read" ON "sweep"."sources" FOR SELECT TO "app_reader" USING (true);



ALTER TABLE "sweep"."blast_radius" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "sweep"."control_objectives" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "guard_uploader_insert" ON "sweep"."adaptive_controls" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."blast_radius" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."control_objectives" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."historical_analogues" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."incidents" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."peer_watchlist" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



CREATE POLICY "guard_uploader_insert" ON "sweep"."sources" FOR INSERT TO "authenticated", "anon" WITH CHECK ("public"."guard_upload_key_ok"());



ALTER TABLE "sweep"."historical_analogues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "sweep"."incident_updates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "sweep"."incidents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "intel_globe_owner_insert" ON "sweep"."adaptive_controls" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "adaptive_controls"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."blast_radius" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "blast_radius"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."control_objectives" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "control_objectives"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."historical_analogues" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "historical_analogues"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."incidents" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("origin")::"text" = 'intel_routine'::"text"));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."peer_watchlist" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "peer_watchlist"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_insert" ON "sweep"."sources" FOR INSERT TO "intel_globe_owner" WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "sources"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."adaptive_controls" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "adaptive_controls"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."blast_radius" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "blast_radius"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."control_objectives" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "control_objectives"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."historical_analogues" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "historical_analogues"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."incidents" FOR SELECT TO "intel_globe_owner" USING (true);



CREATE POLICY "intel_globe_owner_select" ON "sweep"."peer_watchlist" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "peer_watchlist"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_select" ON "sweep"."sources" FOR SELECT TO "intel_globe_owner" USING ((("writer" = 'intel_routine'::"text") OR (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "sources"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."adaptive_controls" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "adaptive_controls"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."blast_radius" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "blast_radius"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."control_objectives" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "control_objectives"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."historical_analogues" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "historical_analogues"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."incidents" FOR UPDATE TO "intel_globe_owner" USING ((("origin")::"text" = 'intel_routine'::"text")) WITH CHECK ((("origin")::"text" = 'intel_routine'::"text"));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."peer_watchlist" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "peer_watchlist"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



CREATE POLICY "intel_globe_owner_update" ON "sweep"."sources" FOR UPDATE TO "intel_globe_owner" USING (("writer" = 'intel_routine'::"text")) WITH CHECK ((("writer" = 'intel_routine'::"text") AND (EXISTS ( SELECT 1
   FROM "sweep"."incidents" "i"
  WHERE (("i"."id" = "sources"."incident_id") AND (("i"."origin")::"text" = 'intel_routine'::"text"))))));



ALTER TABLE "sweep"."peer_watchlist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "sweep"."sources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscriber select" ON "sweep"."adaptive_controls" FOR SELECT TO "authenticated", "anon" USING ("public"."is_subscriber"());



CREATE POLICY "subscriber select" ON "sweep"."blast_radius" FOR SELECT TO "authenticated", "anon" USING ("public"."is_subscriber"());



CREATE POLICY "subscriber select" ON "sweep"."historical_analogues" FOR SELECT TO "authenticated", "anon" USING ("public"."is_subscriber"());



CREATE POLICY "subscriber select" ON "sweep"."peer_watchlist" FOR SELECT TO "authenticated", "anon" USING ("public"."is_subscriber"());



CREATE POLICY "subscriber select" ON "sweep"."sources" FOR SELECT TO "authenticated", "anon" USING ("public"."is_subscriber"());





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "cms" TO "anon";
GRANT USAGE ON SCHEMA "cms" TO "authenticated";



GRANT USAGE ON SCHEMA "content" TO "anon";
GRANT USAGE ON SCHEMA "content" TO "authenticated";
GRANT USAGE ON SCHEMA "content" TO "service_role";






GRANT USAGE ON SCHEMA "identity" TO "anon";
GRANT USAGE ON SCHEMA "identity" TO "authenticated";
GRANT USAGE ON SCHEMA "identity" TO "service_role";



GRANT USAGE ON SCHEMA "intel" TO "service_role";
GRANT USAGE ON SCHEMA "intel" TO "intel_globe_owner";
GRANT USAGE ON SCHEMA "intel" TO "intel_globe";
GRANT USAGE ON SCHEMA "intel" TO "app_reader";



GRANT USAGE ON SCHEMA "map" TO "anon";
GRANT USAGE ON SCHEMA "map" TO "authenticated";
GRANT USAGE ON SCHEMA "map" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "app_reader";






GRANT USAGE ON SCHEMA "ops" TO "service_role";
GRANT USAGE ON SCHEMA "ops" TO "intel_globe_owner";



GRANT USAGE ON SCHEMA "reference" TO "anon";
GRANT USAGE ON SCHEMA "reference" TO "authenticated";
GRANT USAGE ON SCHEMA "reference" TO "service_role";
GRANT USAGE ON SCHEMA "reference" TO "intel_globe_owner";



GRANT USAGE ON SCHEMA "sweep" TO "anon";
GRANT USAGE ON SCHEMA "sweep" TO "authenticated";
GRANT USAGE ON SCHEMA "sweep" TO "app_reader";
GRANT USAGE ON SCHEMA "sweep" TO "service_role";
GRANT USAGE ON SCHEMA "sweep" TO "intel_globe_owner";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";











































































































































































GRANT ALL ON FUNCTION "intel"."entity_tokens"("p_name" "text") TO "intel_globe_owner";



GRANT ALL ON FUNCTION "intel"."find_duplicates"("p_entity" "text", "p_event_date" "date", "p_primary_category" "text", "p_primary_subcategory_code" "text", "p_disclosure_date" "date", "p_report_ref" "text", "p_window_days" integer, "p_min_overlap" numeric, "p_exclude_id" bigint, "p_require_category" boolean) TO "intel_globe_owner";



REVOKE ALL ON FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") TO "service_role";
GRANT ALL ON FUNCTION "intel"."link_report_to_incident"("p_incident_id" bigint, "p_report_ref" "text") TO "intel_globe_owner";



REVOKE ALL ON FUNCTION "intel"."publish_globe"("p_payload" "jsonb", "p_payload_sha256" "text", "p_intel_run_id" bigint, "p_force_new_pin" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "intel"."publish_globe"("p_payload" "jsonb", "p_payload_sha256" "text", "p_intel_run_id" bigint, "p_force_new_pin" boolean) TO "intel_globe";



GRANT ALL ON FUNCTION "intel"."token_overlap"("p_a" "text"[], "p_b" "text"[]) TO "intel_globe_owner";



GRANT ALL ON FUNCTION "intel"."victim_key"("p_name" "text") TO "intel_globe_owner";



REVOKE ALL ON FUNCTION "map"."rebuild_all_snapshots"() FROM PUBLIC;
GRANT ALL ON FUNCTION "map"."rebuild_all_snapshots"() TO "service_role";



REVOKE ALL ON FUNCTION "map"."rebuild_daily_snapshot"("p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "map"."rebuild_daily_snapshot"("p_day" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."_html_esc"("t" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."_html_esc"("t" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_html_esc"("t" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."_report_stub"("p_ref" "text", "p_title" "text", "p_subtitle" "text", "p_summary" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."_report_stub"("p_ref" "text", "p_title" "text", "p_subtitle" "text", "p_summary" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."_report_stub"("p_ref" "text", "p_title" "text", "p_subtitle" "text", "p_summary" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_approve_partner_application"("p_application_id" bigint, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_approve_partner_application"("p_application_id" bigint, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_approve_partner_application"("p_application_id" bigint, "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_approve_vendor_application"("p_application_id" bigint, "p_listing_tier" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_approve_vendor_application"("p_application_id" bigint, "p_listing_tier" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_approve_vendor_application"("p_application_id" bigint, "p_listing_tier" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_dashboard_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_dashboard_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_dashboard_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_delete_report"("p_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_delete_report"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_report"("p_id" bigint) TO "service_role";



GRANT ALL ON TABLE "public"."hub_reports" TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_get_report"("p_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."admin_get_report"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_get_report"("p_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_list_feedback"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_list_feedback"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_list_feedback"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_list_reports"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_list_reports"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_list_reports"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_list_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."admin_list_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_list_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_reject_partner_application"("p_application_id" bigint, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_reject_partner_application"("p_application_id" bigint, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_reject_partner_application"("p_application_id" bigint, "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_reject_vendor_application"("p_application_id" bigint, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_reject_vendor_application"("p_application_id" bigint, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_reject_vendor_application"("p_application_id" bigint, "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_set_incident_media"("p_source" "text", "p_incident_id" bigint, "p_image_url" "text", "p_article_body" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_set_incident_media"("p_source" "text", "p_incident_id" bigint, "p_image_url" "text", "p_article_body" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_set_incident_media"("p_source" "text", "p_incident_id" bigint, "p_image_url" "text", "p_article_body" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_set_report_status"("p_id" bigint, "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_set_report_status"("p_id" bigint, "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_set_report_status"("p_id" bigint, "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_set_user_tier"("p_user_id" "uuid", "p_new_tier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_set_user_tier"("p_user_id" "uuid", "p_new_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_set_user_tier"("p_user_id" "uuid", "p_new_tier" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."admin_upsert_report"("p" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."admin_upsert_report"("p" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_upsert_report"("p" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_incident_update"("p_incident_id" bigint, "p_update_date" "date", "p_headline" "text", "p_what_changed" "text", "p_development_type" "text", "p_severity_after" integer, "p_severity_rationale" "text", "p_verdict" "text", "p_verify_note" "text", "p_sources" "jsonb", "p_sweep_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_sweep_report"("p_sweep_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."fn_sweep_report"("p_sweep_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_sweep_report"("p_sweep_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_upload_key_ok"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_upload_key_ok"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_upload_key_ok"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_upload_key_ok"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_partner_approval"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_partner_approval"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_partner_approval"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_vendor_application_decision"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_vendor_application_decision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_vendor_application_decision"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."incident_teaser"("p_incident_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."incident_teaser"("p_incident_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."incident_teaser"("p_incident_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."incident_teaser"("p_incident_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_subscriber"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_subscriber"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_subscriber"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_subscriber"() TO "service_role";



GRANT ALL ON TABLE "sweep"."adaptive_controls" TO "anon";
GRANT ALL ON TABLE "sweep"."adaptive_controls" TO "authenticated";
GRANT ALL ON TABLE "sweep"."adaptive_controls" TO "service_role";
GRANT SELECT ON TABLE "sweep"."adaptive_controls" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."adaptive_controls" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."blast_radius" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."blast_radius" TO "authenticated";
GRANT ALL ON TABLE "sweep"."blast_radius" TO "service_role";
GRANT SELECT ON TABLE "sweep"."blast_radius" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."blast_radius" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."historical_analogues" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."historical_analogues" TO "authenticated";
GRANT ALL ON TABLE "sweep"."historical_analogues" TO "service_role";
GRANT SELECT ON TABLE "sweep"."historical_analogues" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."historical_analogues" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."incidents" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."incidents" TO "authenticated";
GRANT ALL ON TABLE "sweep"."incidents" TO "service_role";
GRANT SELECT ON TABLE "sweep"."incidents" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."incidents" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."peer_watchlist" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."peer_watchlist" TO "authenticated";
GRANT ALL ON TABLE "sweep"."peer_watchlist" TO "service_role";
GRANT SELECT ON TABLE "sweep"."peer_watchlist" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."peer_watchlist" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."sources" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."sources" TO "authenticated";
GRANT ALL ON TABLE "sweep"."sources" TO "service_role";
GRANT SELECT ON TABLE "sweep"."sources" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."sources" TO "intel_globe_owner";



GRANT ALL ON TABLE "public"."incident_layer_counts" TO "service_role";
GRANT SELECT ON TABLE "public"."incident_layer_counts" TO "anon";
GRANT SELECT ON TABLE "public"."incident_layer_counts" TO "authenticated";



GRANT ALL ON TABLE "public"."incidents" TO "anon";
GRANT ALL ON TABLE "public"."incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."incidents" TO "service_role";



GRANT ALL ON FUNCTION "public"."layer_counts"("public"."incidents") TO "anon";
GRANT ALL ON FUNCTION "public"."layer_counts"("public"."incidents") TO "authenticated";
GRANT ALL ON FUNCTION "public"."layer_counts"("public"."incidents") TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_on_onboarded"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_onboarded"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_on_onboarded"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_on_sweep_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_on_sweep_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_on_sweep_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_partner_application"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_partner_application"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_partner_application"() TO "service_role";



GRANT ALL ON FUNCTION "public"."record_development"("p_run_id" "uuid", "p_match_key" "text", "p_title" "text", "p_jurisdiction" "text", "p_domain" "text", "p_regulation" "text", "p_authority" "text", "p_sector" "text", "p_change_type" "text", "p_legal_status" "text", "p_publication_date" "date", "p_effective_date" "date", "p_enforcement_date" "date", "p_deadline" "date", "p_what_changed" "text", "p_who_affected" "text", "p_why_matters" "text", "p_primary_source" "text", "p_source_url" "text", "p_secondary_source" "text", "p_confidence" "text", "p_materiality" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_development"("p_run_id" "uuid", "p_match_key" "text", "p_title" "text", "p_jurisdiction" "text", "p_domain" "text", "p_regulation" "text", "p_authority" "text", "p_sector" "text", "p_change_type" "text", "p_legal_status" "text", "p_publication_date" "date", "p_effective_date" "date", "p_enforcement_date" "date", "p_deadline" "date", "p_what_changed" "text", "p_who_affected" "text", "p_why_matters" "text", "p_primary_source" "text", "p_source_url" "text", "p_secondary_source" "text", "p_confidence" "text", "p_materiality" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_development"("p_run_id" "uuid", "p_match_key" "text", "p_title" "text", "p_jurisdiction" "text", "p_domain" "text", "p_regulation" "text", "p_authority" "text", "p_sector" "text", "p_change_type" "text", "p_legal_status" "text", "p_publication_date" "date", "p_effective_date" "date", "p_enforcement_date" "date", "p_deadline" "date", "p_what_changed" "text", "p_who_affected" "text", "p_why_matters" "text", "p_primary_source" "text", "p_source_url" "text", "p_secondary_source" "text", "p_confidence" "text", "p_materiality" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."report_html"("p_ref" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."report_html"("p_ref" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."report_html"("p_ref" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."rpt_cockpit"("p_sweep_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."rpt_cockpit"("p_sweep_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpt_cockpit"("p_sweep_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."rpt_cockpit_vi"("p_vi_sweep_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."rpt_cockpit_vi"("p_vi_sweep_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpt_cockpit_vi"("p_vi_sweep_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."rpt_daily_summary"("p_sweep_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."rpt_daily_summary"("p_sweep_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."rpt_daily_summary"("p_sweep_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."save_onboarding"("p_full_name" "text", "p_company" "text", "p_role" "text", "p_industry" "text", "p_country" "text", "p_company_size" "text", "p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."save_onboarding"("p_full_name" "text", "p_company" "text", "p_role" "text", "p_industry" "text", "p_country" "text", "p_company_size" "text", "p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_onboarding"("p_full_name" "text", "p_company" "text", "p_role" "text", "p_industry" "text", "p_country" "text", "p_company_size" "text", "p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_own_subscription"("p_on" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_own_subscription"("p_on" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_own_subscription"("p_on" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."submit_partner_application"("p_email" "text", "p_full_name" "text", "p_company" "text", "p_role" "text", "p_why_interested" "text", "p_sector" "text", "p_linkedin_url" "text", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_partner_application"("p_email" "text", "p_full_name" "text", "p_company" "text", "p_role" "text", "p_why_interested" "text", "p_sector" "text", "p_linkedin_url" "text", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_partner_application"("p_email" "text", "p_full_name" "text", "p_company" "text", "p_role" "text", "p_why_interested" "text", "p_sector" "text", "p_linkedin_url" "text", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."submit_vendor_application"("p_email" "text", "p_company_name" "text", "p_contact_name" "text", "p_contact_role" "text", "p_capability_summary" "text", "p_website" "text", "p_linkedin_url" "text", "p_categories" "text"[], "p_target_sectors" "text"[], "p_founded_year" integer, "p_headquarters_country" "text", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."submit_vendor_application"("p_email" "text", "p_company_name" "text", "p_contact_name" "text", "p_contact_role" "text", "p_capability_summary" "text", "p_website" "text", "p_linkedin_url" "text", "p_categories" "text"[], "p_target_sectors" "text"[], "p_founded_year" integer, "p_headquarters_country" "text", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_vendor_application"("p_email" "text", "p_company_name" "text", "p_contact_name" "text", "p_contact_role" "text", "p_capability_summary" "text", "p_website" "text", "p_linkedin_url" "text", "p_categories" "text"[], "p_target_sectors" "text"[], "p_founded_year" integer, "p_headquarters_country" "text", "p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_industry_text_from_fk"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_industry_text_from_fk"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_industry_text_from_fk"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_subscription_tier"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_subscription_tier"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_subscription_tier"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_daily_digest_now"("p_day" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_daily_digest_now"("p_day" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_daily_digest_now"("p_day" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."unsubscribe_by_token"("p_token" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unsubscribe_by_token"("p_token" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unsubscribe_by_token"("p_token" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_subscription_prefs"("p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."update_subscription_prefs"("p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_subscription_prefs"("p_watch_industries" "jsonb", "p_watch_categories" "jsonb", "p_digest_frequency" "text", "p_email_subscribed" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";












GRANT SELECT ON TABLE "cms"."global_blocks" TO "anon";
GRANT SELECT ON TABLE "cms"."global_blocks" TO "authenticated";



GRANT SELECT ON TABLE "cms"."keyword_registry" TO "anon";
GRANT SELECT ON TABLE "cms"."keyword_registry" TO "authenticated";



GRANT SELECT ON TABLE "cms"."page_revisions" TO "anon";
GRANT SELECT ON TABLE "cms"."page_revisions" TO "authenticated";



GRANT SELECT ON TABLE "cms"."pages" TO "anon";
GRANT SELECT ON TABLE "cms"."pages" TO "authenticated";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "content"."reporters" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "content"."reporters" TO "authenticated";
GRANT ALL ON TABLE "content"."reporters" TO "service_role";



GRANT ALL ON SEQUENCE "content"."reporters_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "content"."reporters_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "content"."reporters_id_seq" TO "service_role";















GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."partner_applications" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."partner_applications" TO "authenticated";
GRANT ALL ON TABLE "identity"."partner_applications" TO "service_role";



GRANT ALL ON SEQUENCE "identity"."partner_applications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "identity"."partner_applications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "identity"."partner_applications_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."partner_feedback" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."partner_feedback" TO "authenticated";
GRANT ALL ON TABLE "identity"."partner_feedback" TO "service_role";



GRANT ALL ON SEQUENCE "identity"."partner_feedback_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "identity"."partner_feedback_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "identity"."partner_feedback_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."plans" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."plans" TO "authenticated";
GRANT ALL ON TABLE "identity"."plans" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."profiles" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."profiles" TO "authenticated";
GRANT ALL ON TABLE "identity"."profiles" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."subscriptions" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "identity"."subscriptions" TO "service_role";



GRANT ALL ON SEQUENCE "identity"."subscriptions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "identity"."subscriptions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "identity"."subscriptions_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "identity"."vendor_applications" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "identity"."vendor_applications" TO "authenticated";
GRANT ALL ON TABLE "identity"."vendor_applications" TO "service_role";



GRANT ALL ON SEQUENCE "identity"."vendor_applications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "identity"."vendor_applications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "identity"."vendor_applications_id_seq" TO "service_role";



GRANT SELECT ON TABLE "intel"."v_cross_writer_duplicates" TO "service_role";
GRANT SELECT ON TABLE "intel"."v_cross_writer_duplicates" TO "app_reader";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "sweep"."control_objectives" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "sweep"."control_objectives" TO "authenticated";
GRANT ALL ON TABLE "sweep"."control_objectives" TO "service_role";
GRANT SELECT ON TABLE "sweep"."control_objectives" TO "app_reader";
GRANT SELECT,INSERT,UPDATE ON TABLE "sweep"."control_objectives" TO "intel_globe_owner";



GRANT SELECT ON TABLE "intel"."v_routine_pins" TO "app_reader";



GRANT SELECT ON TABLE "intel"."v_routine_write_issues" TO "service_role";
GRANT SELECT ON TABLE "intel"."v_routine_write_issues" TO "app_reader";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "map"."daily_snapshots" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "map"."daily_snapshots" TO "authenticated";
GRANT ALL ON TABLE "map"."daily_snapshots" TO "service_role";



GRANT SELECT ON TABLE "map"."incident_detail" TO "anon";
GRANT SELECT ON TABLE "map"."incident_detail" TO "authenticated";
GRANT SELECT ON TABLE "map"."incident_detail" TO "app_reader";



GRANT SELECT ON TABLE "map"."incident_feed" TO "anon";
GRANT SELECT ON TABLE "map"."incident_feed" TO "authenticated";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "ops"."contacts" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "ops"."contacts" TO "authenticated";
GRANT ALL ON TABLE "ops"."contacts" TO "service_role";



GRANT ALL ON SEQUENCE "ops"."contacts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "ops"."contacts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "ops"."contacts_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "ops"."delivery_log" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "ops"."delivery_log" TO "authenticated";
GRANT ALL ON TABLE "ops"."delivery_log" TO "service_role";



GRANT ALL ON SEQUENCE "ops"."delivery_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "ops"."delivery_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "ops"."delivery_log_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "ops"."report_recipients" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "ops"."report_recipients" TO "authenticated";
GRANT ALL ON TABLE "ops"."report_recipients" TO "service_role";



GRANT ALL ON SEQUENCE "ops"."report_recipients_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "ops"."report_recipients_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "ops"."report_recipients_id_seq" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "ops"."runs" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "ops"."runs" TO "authenticated";
GRANT ALL ON TABLE "ops"."runs" TO "service_role";
GRANT SELECT ON TABLE "ops"."runs" TO "app_reader";



GRANT SELECT("id") ON TABLE "ops"."runs" TO "intel_globe_owner";



GRANT INSERT("generated_at") ON TABLE "ops"."runs" TO "intel_globe_owner";



GRANT SELECT("uploaded_at"),INSERT("uploaded_at"),UPDATE("uploaded_at") ON TABLE "ops"."runs" TO "intel_globe_owner";



GRANT SELECT("writer"),INSERT("writer") ON TABLE "ops"."runs" TO "intel_globe_owner";



GRANT SELECT("intel_run_ref"),INSERT("intel_run_ref") ON TABLE "ops"."runs" TO "intel_globe_owner";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "ops"."sweep_notifications_log" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "ops"."sweep_notifications_log" TO "authenticated";
GRANT ALL ON TABLE "ops"."sweep_notifications_log" TO "service_role";



GRANT ALL ON SEQUENCE "ops"."sweeps_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "ops"."sweeps_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "ops"."sweeps_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "ops"."sweeps_id_seq" TO "intel_globe_owner";



GRANT ALL ON TABLE "public"."adaptive_controls" TO "anon";
GRANT ALL ON TABLE "public"."adaptive_controls" TO "authenticated";
GRANT ALL ON TABLE "public"."adaptive_controls" TO "service_role";
GRANT SELECT ON TABLE "public"."adaptive_controls" TO "app_reader";



GRANT ALL ON TABLE "public"."adaptive_objectives" TO "anon";
GRANT ALL ON TABLE "public"."adaptive_objectives" TO "authenticated";
GRANT ALL ON TABLE "public"."adaptive_objectives" TO "service_role";
GRANT SELECT ON TABLE "public"."adaptive_objectives" TO "app_reader";



GRANT ALL ON TABLE "public"."blast_radius" TO "anon";
GRANT ALL ON TABLE "public"."blast_radius" TO "authenticated";
GRANT ALL ON TABLE "public"."blast_radius" TO "service_role";
GRANT SELECT ON TABLE "public"."blast_radius" TO "app_reader";



GRANT ALL ON TABLE "public"."contacts" TO "anon";
GRANT ALL ON TABLE "public"."contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."contacts" TO "service_role";



GRANT ALL ON TABLE "public"."delivery_log" TO "anon";
GRANT ALL ON TABLE "public"."delivery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."delivery_log" TO "service_role";



GRANT ALL ON TABLE "public"."developments" TO "anon";
GRANT ALL ON TABLE "public"."developments" TO "authenticated";
GRANT ALL ON TABLE "public"."developments" TO "service_role";



GRANT ALL ON TABLE "public"."historical_analogues" TO "anon";
GRANT ALL ON TABLE "public"."historical_analogues" TO "authenticated";
GRANT ALL ON TABLE "public"."historical_analogues" TO "service_role";
GRANT SELECT ON TABLE "public"."historical_analogues" TO "app_reader";



GRANT ALL ON SEQUENCE "public"."hub_reports_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."hub_reports_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."hub_reports_id_seq" TO "service_role";



GRANT SELECT,MAINTAIN ON TABLE "public"."hub_reports_public" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "public"."hub_reports_public" TO "authenticated";
GRANT ALL ON TABLE "public"."hub_reports_public" TO "service_role";



GRANT SELECT ON TABLE "sweep"."incident_updates" TO "anon";
GRANT SELECT ON TABLE "sweep"."incident_updates" TO "authenticated";
GRANT SELECT ON TABLE "sweep"."incident_updates" TO "app_reader";
GRANT SELECT ON TABLE "sweep"."incident_updates" TO "service_role";



GRANT ALL ON TABLE "public"."incident_updates" TO "service_role";
GRANT SELECT ON TABLE "public"."incident_updates" TO "anon";
GRANT SELECT ON TABLE "public"."incident_updates" TO "authenticated";
GRANT SELECT ON TABLE "public"."incident_updates" TO "app_reader";



GRANT SELECT,MAINTAIN ON TABLE "reference"."industries" TO "anon";
GRANT SELECT,MAINTAIN ON TABLE "reference"."industries" TO "authenticated";
GRANT ALL ON TABLE "reference"."industries" TO "service_role";
GRANT SELECT ON TABLE "reference"."industries" TO "app_reader";



GRANT SELECT("id") ON TABLE "reference"."industries" TO "intel_globe_owner";



GRANT SELECT("industry") ON TABLE "reference"."industries" TO "intel_globe_owner";



GRANT ALL ON TABLE "public"."industries" TO "anon";
GRANT ALL ON TABLE "public"."industries" TO "authenticated";
GRANT ALL ON TABLE "public"."industries" TO "service_role";



GRANT ALL ON TABLE "public"."map_daily_snapshot" TO "anon";
GRANT ALL ON TABLE "public"."map_daily_snapshot" TO "authenticated";
GRANT ALL ON TABLE "public"."map_daily_snapshot" TO "service_role";



GRANT ALL ON TABLE "public"."map_incident_detail" TO "anon";
GRANT ALL ON TABLE "public"."map_incident_detail" TO "authenticated";
GRANT ALL ON TABLE "public"."map_incident_detail" TO "service_role";



GRANT ALL ON TABLE "public"."map_incident_feed" TO "anon";
GRANT ALL ON TABLE "public"."map_incident_feed" TO "authenticated";
GRANT ALL ON TABLE "public"."map_incident_feed" TO "service_role";



GRANT ALL ON TABLE "public"."partner_applications" TO "anon";
GRANT ALL ON TABLE "public"."partner_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."partner_applications" TO "service_role";



GRANT ALL ON TABLE "public"."partner_feedback" TO "anon";
GRANT ALL ON TABLE "public"."partner_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."partner_feedback" TO "service_role";



GRANT ALL ON TABLE "public"."peer_watchlist" TO "anon";
GRANT ALL ON TABLE "public"."peer_watchlist" TO "authenticated";
GRANT ALL ON TABLE "public"."peer_watchlist" TO "service_role";
GRANT SELECT ON TABLE "public"."peer_watchlist" TO "app_reader";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."scan_runs" TO "anon";
GRANT ALL ON TABLE "public"."scan_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_runs" TO "service_role";



GRANT ALL ON TABLE "public"."recent_reports" TO "anon";
GRANT ALL ON TABLE "public"."recent_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."recent_reports" TO "service_role";



GRANT ALL ON TABLE "public"."report_recipients" TO "anon";
GRANT ALL ON TABLE "public"."report_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."report_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."reporters" TO "anon";
GRANT ALL ON TABLE "public"."reporters" TO "authenticated";
GRANT ALL ON TABLE "public"."reporters" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."rpt_category_by_sweep" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."rpt_category_by_sweep" TO "authenticated";
GRANT ALL ON TABLE "public"."rpt_category_by_sweep" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."rpt_incident_day_counts" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."rpt_incident_day_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."rpt_incident_day_counts" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."rpt_major_incidents" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."rpt_major_incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."rpt_major_incidents" TO "service_role";



GRANT ALL ON TABLE "public"."rpt_sweep_summary" TO "anon";
GRANT ALL ON TABLE "public"."rpt_sweep_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."rpt_sweep_summary" TO "service_role";



GRANT ALL ON TABLE "public"."rpt_sweep_trend" TO "anon";
GRANT ALL ON TABLE "public"."rpt_sweep_trend" TO "authenticated";
GRANT ALL ON TABLE "public"."rpt_sweep_trend" TO "service_role";



GRANT ALL ON TABLE "public"."sources" TO "anon";
GRANT ALL ON TABLE "public"."sources" TO "authenticated";
GRANT ALL ON TABLE "public"."sources" TO "service_role";
GRANT SELECT ON TABLE "public"."sources" TO "app_reader";



GRANT ALL ON TABLE "public"."status_history" TO "anon";
GRANT ALL ON TABLE "public"."status_history" TO "authenticated";
GRANT ALL ON TABLE "public"."status_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."status_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."status_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."status_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."sweep_notifications_log" TO "anon";
GRANT ALL ON TABLE "public"."sweep_notifications_log" TO "authenticated";
GRANT ALL ON TABLE "public"."sweep_notifications_log" TO "service_role";



GRANT ALL ON TABLE "public"."sweeps" TO "anon";
GRANT ALL ON TABLE "public"."sweeps" TO "authenticated";
GRANT ALL ON TABLE "public"."sweeps" TO "service_role";



GRANT ALL ON TABLE "public"."upcoming_deadlines" TO "anon";
GRANT ALL ON TABLE "public"."upcoming_deadlines" TO "authenticated";
GRANT ALL ON TABLE "public"."upcoming_deadlines" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."v_daily_trend" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."v_daily_trend" TO "authenticated";
GRANT ALL ON TABLE "public"."v_daily_trend" TO "service_role";



GRANT ALL ON TABLE "public"."v_sweep_summary" TO "anon";
GRANT ALL ON TABLE "public"."v_sweep_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_sweep_summary" TO "service_role";



GRANT ALL ON TABLE "public"."v_latest_sweep" TO "anon";
GRANT ALL ON TABLE "public"."v_latest_sweep" TO "authenticated";
GRANT ALL ON TABLE "public"."v_latest_sweep" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."v_risk_category_labels" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."v_risk_category_labels" TO "authenticated";
GRANT ALL ON TABLE "public"."v_risk_category_labels" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."v_major_incidents" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."v_major_incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_major_incidents" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."v_sweep_category_counts" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."v_sweep_category_counts" TO "authenticated";
GRANT ALL ON TABLE "public"."v_sweep_category_counts" TO "service_role";



GRANT SELECT,INSERT,MAINTAIN ON TABLE "public"."v_sweep_incidents" TO "anon";
GRANT SELECT,INSERT,DELETE,MAINTAIN,UPDATE ON TABLE "public"."v_sweep_incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."v_sweep_incidents" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_applications" TO "anon";
GRANT ALL ON TABLE "public"."vendor_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_applications" TO "service_role";



GRANT ALL ON SEQUENCE "reference"."industries_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "reference"."industries_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "reference"."industries_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "sweep"."adaptive_controls_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."adaptive_controls_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."adaptive_controls_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."adaptive_controls_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."adaptive_objectives_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."adaptive_objectives_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."adaptive_objectives_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."adaptive_objectives_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."blast_radius_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."blast_radius_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."blast_radius_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."blast_radius_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."historical_analogues_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."historical_analogues_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."historical_analogues_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."historical_analogues_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."incidents_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."incidents_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."incidents_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."incidents_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."peer_watchlist_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."peer_watchlist_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."peer_watchlist_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."peer_watchlist_id_seq" TO "intel_globe_owner";



GRANT ALL ON SEQUENCE "sweep"."sources_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "sweep"."sources_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "sweep"."sources_id_seq" TO "service_role";
GRANT USAGE ON SEQUENCE "sweep"."sources_id_seq" TO "intel_globe_owner";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- local only (scripts/docker-local.mjs): undo the CREATE grants inserted before the ownership transfers
REVOKE CREATE ON SCHEMA "intel" FROM "intel_globe_owner";
