// useReportBroadcast — the published broadcast episodes of the open report,
// loaded once per ref, shared by the Hub's ReportFrame and the dashboard's.
//   undefined  still loading (the host does not touch the frame yet)
//   []         none: the frame's card stays on its baked line ("coming soon")
//   [ep, …]    frameBroadcast(eps) goes into the frame (reportLock.applyBroadcastToFrame)
// Design review (localhost only — import.meta.env.DEV is false in the live
// build): ?bcdemo=1 announces a sample episode, ?bcdemo=2 a sample player.
import { useEffect, useState } from "react";
import { listBroadcasts } from "./broadcasts";

const SAMPLE = (reportRef, player) => [{
  id: 0, report_ref: reportRef, series: "Attacked.ai Briefing Room", episode: "Episode 1", title: "The Millisecond That Stopped UK Departures",
  audio_url: player ? "https://example.com/episode-1.mp3" : null, page_url: null, duration_sec: player ? 1380 : null, hosts: [],
  show_notes: "The analyst conversation on the NATS outage: the latent defect, who it reached and what to do next.", published: true, published_at: new Date().toISOString(), sort_order: 0,
}];

export function useReportBroadcast(reportRef) {
  const [eps, setEps] = useState(undefined);
  useEffect(() => {
    let dead = false; setEps(undefined);
    if (!reportRef) { setEps([]); return undefined; }
    const demo = import.meta.env.DEV && (() => { try { return new URLSearchParams(window.location.search).get("bcdemo"); } catch { return null; } })();
    const q = demo ? Promise.resolve(SAMPLE(reportRef, demo === "2")) : listBroadcasts(reportRef);
    q.then((rows) => { if (!dead) setEps(rows || []); }).catch(() => { if (!dead) setEps([]); });
    return () => { dead = true; };
  }, [reportRef]);
  return eps;
}
