import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { FULL_PREFIX, PREVIEW_PREFIX, decide } from "./src/lib/reportGate.js";
import reportPdf from "./api/report-pdf.mjs";
import broadcasts from "./api/broadcasts.mjs";

// The subscriber gate for /reports-full/ on the dev and preview servers — the
// same decision middleware.js makes on Vercel, so localhost shows exactly
// what a free reader or a subscriber gets on the live site.
function reportGate(env) {
  const opts = { supabaseUrl: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY };
  const gate = async (req, res, next) => {
    const d = await decide(req.url || "/", req.headers.authorization, opts);
    if (d.action === "pass") return next();
    res.setHeader("cache-control", "private, no-store");
    if (d.action === "serve") { req.url = FULL_PREFIX + d.file; return next(); }
    if (d.action === "preview") { res.statusCode = 302; res.setHeader("location", PREVIEW_PREFIX + d.file); return res.end(); }
    if (d.action === "deny") { res.statusCode = 403; res.setHeader("content-type", "application/json"); return res.end('{"error":"subscribers_only"}'); }
    res.statusCode = 404; res.end("Not found");
  };
  // The licensed PDF endpoint, the same handler Vercel runs (api/report-pdf.mjs).
  const pdf = (req, res, next) => (String(req.url || "").split("?")[0] === "/api/report-pdf" ? reportPdf(req, res) : next());
  // The broadcast episodes of a briefing, the same handler Vercel runs (api/broadcasts.mjs).
  const bc = (req, res, next) => (String(req.url || "").split("?")[0] === "/api/broadcasts" ? broadcasts(req, res, opts) : next());
  return {
    name: "attacked-report-gate",
    configureServer(server) { server.middlewares.use(pdf); server.middlewares.use(bc); server.middlewares.use(gate); },
    configurePreviewServer(server) { server.middlewares.use(pdf); server.middlewares.use(bc); server.middlewares.use(gate); },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), reportGate(loadEnv(mode, process.cwd(), ""))],
  server: {
    port: 5173,
    open: true,
  },
}));
