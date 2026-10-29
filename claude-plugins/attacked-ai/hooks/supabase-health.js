// SessionStart: one tiny request to the live Supabase auth health endpoint so
// Claude knows up front whether the project is up or egress-locked (HTTP 402).
const URL_ = "https://ovenyjguhkgiceddzwna.supabase.co/auth/v1/health";
const KEY = "sb_publishable_23l5g7MVvgkKuUIctG-e9w_cWYnAtM5"; // public anon key

(async () => {
  try {
    const r = await fetch(URL_, { headers: { apikey: KEY }, signal: AbortSignal.timeout(5000) });
    if (r.ok) console.log("Attacked.ai: live Supabase (ovenyjguhkgiceddzwna) is UP.");
    else if (r.status === 402) console.log("Attacked.ai WARNING: live Supabase returns 402 (egress quota exceeded) - the live site, sign-in and emails are down. Avoid test loops that load the full incidents dataset.");
    else console.log(`Attacked.ai: live Supabase health check returned HTTP ${r.status}.`);
  } catch (e) {
    console.log(`Attacked.ai: could not reach live Supabase (${e.name}).`);
  }
})();
