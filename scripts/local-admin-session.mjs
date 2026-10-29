// local-admin.mjs — LOCAL STACK ONLY: make (or reuse) an admin account on the
// Docker Supabase and write a session for the dev page to adopt.
// Reads the local keys from the main repo's .env.docker (written by local:start).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const env = Object.fromEntries(readFileSync("C:/Users/mohin/OneDrive/Documents/Desktop/ATTACKEDMAP/.env.docker", "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const URL_ = env.VITE_SUPABASE_URL, SECRET = env.SUPABASE_SECRET_KEY, ANON = env.VITE_SUPABASE_ANON_KEY;
if (!/127\.0\.0\.1|localhost/.test(URL_)) throw new Error("refusing: not the local stack " + URL_);
const email = process.argv[2] || "admin.local@attacked.test";
const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
// 1. the account (idempotent)
let r = await fetch(`${URL_}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: "Local Admin", company: "Attacked.ai", role: "Editor" } }) });
let u = await r.json();
if (!r.ok && !/already|exists/i.test(JSON.stringify(u))) throw new Error("create user: " + JSON.stringify(u));
if (!r.ok) { const l = await (await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, { headers: H })).json(); u = (l.users || []).find((x) => x.email === email); }
console.log("user", u.id, u.email);
// 2. tier = admin (the trigger made the profile; upsert in case it did not)
r = await fetch(`${URL_}/rest/v1/profiles?on_conflict=id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ id: u.id, email, tier: "admin", full_name: "Local Admin", company: "Attacked.ai", role: "Editor" }) });
console.log("profile", r.status, (await r.text()).slice(0, 160));
// 3. a session: magic-link token → verify
r = await fetch(`${URL_}/auth/v1/admin/generate_link`, { method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", email }) });
const link = await r.json(); const tokenHash = link.hashed_token || link.properties?.hashed_token;
r = await fetch(`${URL_}/auth/v1/verify`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }) });
const s = await r.json();
if (!s.access_token) throw new Error("verify: " + JSON.stringify(s).slice(0, 200));
mkdirSync("D:/attacked-dev/wt-cards/dist", { recursive: true });
writeFileSync("D:/attacked-dev/wt-cards/dist/dev-session.json", JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token }));
console.log("session written → wt-cards/dist/dev-session.json (local stack tokens)");
