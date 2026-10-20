// dev-direct-signin.mjs: TESTING MODE sign-in without the email code, on the
// local dev server ONLY (owner, 2026-09-30: "we are in testing mode, remove the
// verification code for now; add it back when we productionize").
//
// A Vite plugin with apply: "serve", so it exists only under `npm run dev`. It is
// never part of `npm run build`, and the live site keeps the emailed code.
//
// POST /__dev/direct-signin { email, meta? }
//   1. creates the account if the address is new (email confirmed, meta as
//      user metadata, the same fields the sign-up form sends with the code)
//   2. asks the Auth admin API for a one-time magic-link token for the address
//   3. answers { token_hash, type }; the page exchanges it with verifyOtp, so
//      the session is made and stored exactly as a code sign-in would be.
//
// The secret key is read from api/.env on this machine at request time and never
// leaves the dev server process. Requests from anything but this computer are
// refused, so `vite --host` does not open it to the local network.
//
// Turn it off locally with VITE_DIRECT_SIGNIN=0 in .env.local (to test the real
// code flow). Remove this file and its line in vite.config.js before launch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readEnv = (root, f) => {
  try {
    return Object.fromEntries(readFileSync(resolve(root, f), "utf8").split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((ok, fail) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 20000) fail(new Error("body too large")); });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
  req.on("error", fail);
});

export function directSignin() {
  let root = process.cwd();
  let mode = "development";
  return {
    name: "attacked-dev-direct-signin",
    apply: "serve",
    configResolved(cfg) { root = cfg.root; mode = cfg.mode; },
    configureServer(server) {
      server.middlewares.use("/__dev/direct-signin", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: "Direct sign-in works only from this computer." });
        // Loopback is not enough: any website open in this browser can POST to
        // localhost. Accept only the dev page itself: same-origin fetch with a
        // JSON body (a cross-site page cannot send that without a preflight,
        // which this server never grants).
        const site = req.headers["sec-fetch-site"];
        const origin = req.headers.origin;
        const json = String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json");
        if ((site && site !== "same-origin") || (origin && origin !== `http://${req.headers.host}`) || !json) {
          return send(res, 403, { error: "Cross-site request refused." });
        }
        // Same files, same precedence as Vite: .env < .env.local < .env.<mode> < .env.<mode>.local.
        // `vite --mode docker` therefore reads .env.docker (the local Docker stack).
        const env = { ...readEnv(root, ".env"), ...readEnv(root, ".env.local"), ...readEnv(root, `.env.${mode}`), ...readEnv(root, `.env.${mode}.local`) };
        if (env.VITE_DIRECT_SIGNIN === "0") return send(res, 404, { error: "Direct sign-in is switched off (VITE_DIRECT_SIGNIN=0)." });
        const URL_ = env.VITE_SUPABASE_URL;
        // The secret for THIS backend: .env.<mode> may carry one (the local stack's
        // service_role key, not VITE_-prefixed so it never reaches the browser);
        // otherwise the live secret from api/.env, as before.
        // Only the default mode may fall back to api/.env: in any other mode a
        // missing .env.<mode> must never pair the live secret with a test sign-in.
        const SECRET = env.SUPABASE_SECRET_KEY || (mode === "development" ? readEnv(root, "api/.env").SUPABASE_SECRET_KEY : undefined);
        if (!URL_ || !SECRET) return send(res, 500, { error: mode === "development" ? "Needs VITE_SUPABASE_URL in .env and SUPABASE_SECRET_KEY in api/.env." : `Needs VITE_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.${mode} (run: npm run local:env).` });

        let body;
        try { body = await readBody(req); } catch { return send(res, 400, { error: "Bad request body." }); }
        const email = String(body.email || "").trim().toLowerCase();
        if (!EMAIL.test(email)) return send(res, 400, { error: "Enter a valid email address." });
        const meta = body.meta && typeof body.meta === "object" ? body.meta : undefined;

        const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
        try {
          // New address: create it confirmed. An existing one answers 422, which is fine.
          const mk = await fetch(`${URL_}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, email_confirm: true, ...(meta ? { user_metadata: meta } : {}) }) });
          if (!mk.ok && mk.status !== 422) return send(res, 502, { error: `Could not create the account (${mk.status}).` });

          const gen = await fetch(`${URL_}/auth/v1/admin/generate_link`, { method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", email }) });
          if (!gen.ok) return send(res, 502, { error: `Could not start the sign-in (${gen.status}).` });
          const link = await gen.json();
          const token_hash = link.hashed_token || link.properties?.hashed_token;
          if (!token_hash) return send(res, 502, { error: "Auth returned no sign-in token." });
          return send(res, 200, { token_hash, type: link.verification_type || link.properties?.verification_type || "magiclink", created: mk.ok });
        } catch (e) {
          return send(res, 502, { error: `Auth unreachable: ${e?.message || e}` });
        }
      });
    },
  };
}
