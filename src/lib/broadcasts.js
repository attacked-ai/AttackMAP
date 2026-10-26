// broadcasts.js — the broadcast (podcast episode) attached to a report:
// public.report_broadcasts (migrations 20261021_report_broadcasts +
// 20261022_broadcast_audio) and the public `broadcasts` storage bucket.
//
// Readers: listBroadcasts(ref) — the published episodes for one briefing.
//   The Hub hands frameBroadcast(eps) into the report frame
//   (reportLock.applyBroadcastToFrame) where the v5 shell's broadcast card
//   plays it, and shows the BroadcastBar for shells without a card. A
//   standalone copy of a report asks /api/broadcasts?ref= instead.
// Admins: upload the file (uploadBroadcastAudio), then save the row through
//   the admin_* functions, gated by _is_admin() in the database. Storage
//   writes are gated by the bucket's policies (admin only).
//
// The table is additive: on a database without it (or without the 22 Oct
// columns) readers simply see no broadcast.

import { supabase } from "./supabaseClient";
import { sortEpisodes } from "./broadcastShape";

export * from "./broadcastShape";

export const BUCKET = "broadcasts";
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;     // the bucket's file_size_limit (100 MiB)
export const ACCEPT_AUDIO = ".mp3,.m4a,.aac,.ogg,.oga,.wav,.flac,.webm,audio/*";
const MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", flac: "audio/flac", webm: "audio/webm" };

const ext = (name) => String(name || "").toLowerCase().split(".").pop();
export const mimeFor = (file) => (file?.type && file.type.startsWith("audio/") ? file.type : MIME[ext(file?.name)] || "");
export const isAudioUpload = (file) => !!file && (!!MIME[ext(file.name)] || String(file.type || "").startsWith("audio/"));

export async function listBroadcasts(ref) {
  if (!ref) return [];
  const { data, error } = await supabase.from("report_broadcasts").select("*")
    .eq("report_ref", ref).eq("published", true).order("published_at", { ascending: false }).limit(5);
  if (error) return [];
  return sortEpisodes(data || []);
}

// Which briefings carry a broadcast: Map ref → { episodes, released, latest_at }.
export async function listBroadcastRefs() {
  const { data, error } = await supabase.from("report_broadcast_refs").select("report_ref,episodes,released,latest_at");
  if (error) return new Map();
  return new Map((data || []).map((r) => [r.report_ref, r]));
}

// The bucket's public URL for an uploaded object.
export function publicAudioUrl(path) {
  if (!path) return null;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// Upload the episode file under <ref>/<timestamp>-<name>; never overwrites, so a
// re-upload leaves the file readers are playing in place until the row moves on.
// Returns the columns to save on the row.
export async function uploadBroadcastAudio(ref, file) {
  if (!ref) throw new Error("Choose the report first.");
  if (!file) throw new Error("Choose an audio file first.");
  if (!isAudioUpload(file)) throw new Error("That is not an audio file. Use mp3, m4a, aac, ogg, wav, flac or webm.");
  if (file.size > MAX_AUDIO_BYTES) throw new Error(`The file is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${MAX_AUDIO_BYTES / 1048576} MB.`);
  const safe = String(file.name).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || `episode.${ext(file.name) || "mp3"}`;
  const path = `${String(ref).trim()}/${Date.now()}-${safe}`;
  const contentType = mimeFor(file) || "audio/mpeg";
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType, cacheControl: "31536000" });
  if (error) throw new Error(friendlyStorageError(error));
  return { audio_url: publicAudioUrl(path), audio_path: path, audio_bytes: file.size, audio_type: contentType };
}

// Best effort: an orphaned file is harmless, a failed delete never blocks the admin.
export async function removeBroadcastAudio(path) {
  if (!path) return false;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  return !error;
}

function friendlyStorageError(e) {
  const m = String(e?.message || e || "");
  if (/bucket not found/i.test(m)) return "The broadcasts bucket does not exist yet: run migration 20261022_broadcast_audio.sql on this database.";
  if (/row-level security|not authorized|unauthorized|403/i.test(m)) return "Not allowed: only an admin account can upload broadcasts.";
  if (/mime type|not supported/i.test(m)) return "The bucket refused this file type. Use mp3, m4a, aac, ogg, wav, flac or webm.";
  if (/exceeded|too large|413/i.test(m)) return "The file is larger than the bucket allows.";
  return m || "Upload failed.";
}

// The length of a local file, from the browser's decoder (null when it cannot tell).
export function readAudioDuration(file) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(file);
      const a = document.createElement("audio");
      a.preload = "metadata";
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; try { URL.revokeObjectURL(url); } catch { /* noop */ } resolve(v); };
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration) : null);
      a.onerror = () => done(null);
      setTimeout(() => done(null), 8000);
      a.src = url;
    } catch { resolve(null); }
  });
}

const throwing = ({ data, error }) => { if (error) throw error; return data; };
const one = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;

export const adminListBroadcasts = () => supabase.rpc("admin_list_broadcasts").then(throwing).then((rows) => rows || []);
export const adminUpsertBroadcast = (b) => supabase.rpc("admin_upsert_broadcast", { p: b }).then(throwing).then(one);
// Row first, then the file: a row pointing at a missing file would be worse than an orphan file.
export async function adminDeleteBroadcast(ep) {
  const id = typeof ep === "object" ? ep.id : ep;
  await supabase.rpc("admin_delete_broadcast", { p_id: id }).then(throwing);
  if (typeof ep === "object" && ep.audio_path) await removeBroadcastAudio(ep.audio_path);
}
