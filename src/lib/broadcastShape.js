// broadcastShape.js — the broadcast's pure helpers, with no browser or
// Supabase dependency, so the Vercel function (api/broadcasts.mjs) and the
// Node build scripts can share them with the app (src/lib/broadcasts.js
// re-exports everything here).

// "14 min" / "1 h 05 min" for the bar, the card and the print document.
export function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (!s) return "";
  const m = Math.round(s / 60);
  if (m < 1) return `${s} s`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

// Audio file or a page: the player handles files; a page (Spotify, YouTube,
// Apple Podcasts) opens in a new tab instead.
export function isAudioFile(url) {
  return /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm)(\?.*|#.*)?$/i.test(String(url || ""));
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (!b) return "";
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// The hosts list as the admin types it — one per line, "Name — Role" (or
// "Name - Role", "Name, Role") — and back again.
export function parseHosts(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.split(/\s+[—–-]\s+|\s*,\s*/);
    return { name: (m[0] || "").trim(), role: m.slice(1).join(", ").trim() };
  }).filter((h) => h.name);
}
export function hostsText(hosts) {
  return (Array.isArray(hosts) ? hosts : []).map((h) => [h.name, h.role].filter(Boolean).join(" — ")).join("\n");
}

// A table row → what a reader-facing surface shows: the Hub bar, the report's
// broadcast card (window.__ATTACKED_BROADCAST__) and the print build's
// --broadcast-json. `url` is what the play button acts on: the audio file when
// there is one, else the episode page.
export function frameBroadcast(eps) {
  const list = Array.isArray(eps) ? eps : [];
  const ep = list[0];
  if (!ep) return null;
  return {
    id: ep.id,
    ref: ep.report_ref,
    series: ep.series || "Attacked.ai Briefing Room",
    episode: ep.episode || "",
    title: ep.title || "",
    url: ep.audio_url || ep.page_url || null,
    page: ep.page_url || null,
    file: ep.audio_url && isAudioFile(ep.audio_url) ? ep.audio_url : null,
    duration: formatDuration(ep.duration_sec),
    durationSec: ep.duration_sec || null,
    note: ep.show_notes || "",
    hosts: Array.isArray(ep.hosts) ? ep.hosts.filter((h) => h && h.name) : [],
    publishedAt: ep.published_at || null,
    episodes: list.length,
  };
}

// The reader-facing columns of a row (the API never returns created_by).
export function publicEpisode(ep) {
  const { id, report_ref, series, episode, title, audio_url, page_url, duration_sec, show_notes, hosts, published_at, sort_order } = ep || {};
  return { id, report_ref, series, episode, title, audio_url, page_url, duration_sec, show_notes, hosts: Array.isArray(hosts) ? hosts : [], published_at, sort_order: sort_order || 0 };
}

// Rows in the order every surface shows them: sort_order, then newest first.
export function sortEpisodes(rows) {
  return [...(rows || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(b.published_at || "").localeCompare(String(a.published_at || "")));
}
