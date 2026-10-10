// authClient.js — the reader's access token, whichever backend this build uses.
// For code that only needs "who is reading" (the map's raw PostgREST calls,
// the API helpers), so it never touches supabase.auth directly — which does
// not exist on the GCP backend.
import { GCP } from "./backend";
import * as gcp from "./gcpAuth";
import { supabase } from "./supabaseClient";

export async function readerToken() {
  if (GCP) return gcp.getAccessToken();
  try { const { data } = await supabase.auth.getSession(); return data?.session?.access_token || null; }
  catch { return null; }
}

// cb(token|null) on sign-in, sign-out and every token renewal. Returns an unsubscribe.
export function onReaderToken(cb) {
  if (GCP) return gcp.onToken(cb);
  try {
    const sub = supabase.auth.onAuthStateChange((_e, s) => cb(s?.access_token || null))?.data?.subscription;
    return () => { try { sub?.unsubscribe?.(); } catch { /* noop */ } };
  } catch { return () => {}; }
}
