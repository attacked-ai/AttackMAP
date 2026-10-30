// ─────────────────────────────────────────────────────────────────────────
// Supabase client — single instance shared across the app.
// Used for:
//   • Auth (magic-link sign-in, session persistence)
//   • Profile read (tier resolution)
//   • Future: partner application submission, admin actions
//
// Data fetching (incidents, blast_radius, etc.) still uses raw fetch with
// pagination in GlobalAttackMap.jsx — those paths are unchanged.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn(
    "[supabaseClient] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — auth will be disabled."
  );
}

export const supabase = createClient(url || "", key || "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // handles magic-link redirect
    storageKey: "attackmap.auth",
  },
});
