// broadcasts.js — the related broadcast (podcast episode) attached to a
// report (public.report_broadcasts, migration 20261021_report_broadcasts).
//
// Readers: listBroadcasts(ref) — the published episodes for one briefing,
// newest first; the Hub shows them in the "Related broadcast" panel when a
// report is opened. An episode with no audio_url is announced but not yet
// released ("coming soon").
// Admins: the admin_* functions, gated by _is_admin() in the database.

import { supabase } from "./supabaseClient";

const COLS = "id,report_ref,series,episode,title,audio_url,page_url,duration_sec,show_notes,published,published_at";

export async function listBroadcasts(ref) {
  if (!ref) return [];
  const { data, error } = await supabase.from("report_broadcasts").select(COLS)
    .eq("report_ref", ref).eq("published", true).order("published_at", { ascending: false }).limit(5);
  if (error) return [];      // the table is additive: a build without the migration just shows no panel
  return data || [];
}

// "14 min" / "1 h 05 min" for the panel and the print document.
export function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (!s) return "";
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

// Audio file or a page: the player handles files; a page (Spotify, YouTube,
// Apple Podcasts) opens in a new tab instead.
export function isAudioFile(url) {
  return /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)(\?.*)?$/i.test(String(url || ""));
}

const throwing = ({ data, error }) => { if (error) throw error; return data; };
const one = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;

export const adminListBroadcasts = () => supabase.rpc("admin_list_broadcasts").then(throwing);
export const adminUpsertBroadcast = (b) => supabase.rpc("admin_upsert_broadcast", { p: b }).then(throwing).then(one);
export const adminDeleteBroadcast = (id) => supabase.rpc("admin_delete_broadcast", { p_id: id }).then(throwing);
