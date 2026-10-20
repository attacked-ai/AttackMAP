import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
// Testing mode: sign in on localhost without the email code (dev server only;
// see the file). Remove before launch.
import { directSignin } from "./scripts/dev-direct-signin.mjs";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

  // `--mode docker` (npm run dev:docker) means the LOCAL Supabase stack. With no
  // .env.docker yet (stack never started, or `local:start` failed) Vite would
  // silently fall back to .env and the "local" session would talk to live.
  if (mode === "docker" && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.VITE_SUPABASE_URL || "")) {
    throw new Error(`--mode docker, but VITE_SUPABASE_URL is "${env.VITE_SUPABASE_URL || ""}" (not the local stack). Run  npm run local:start  (or  npm run local:env ) to write .env.docker first.`);
  }

  if (command === "build") {
    // Without these the app cannot reach its data and would ship a blank page.
    const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`Build stopped: ${missing.join(", ")} not set (deploy/gcp/cloudbuild.yaml passes them on GCP).`);
    if (/localhost|127\.0\.0\.1/.test(env.VITE_API_URL || "")) {
      console.warn(`\n[build] VITE_API_URL=${env.VITE_API_URL} points at this computer: fine for a local build, wrong for a deploy.\n`);
    }
  }

  // GCP backend on localhost: the page calls /api and /rest/v1 on its own
  // origin, as it will behind Firebase Hosting. Forward them to the local API
  // (uvicorn on :8000) and a local PostgREST (VITE_DEV_DATA_URL, default :3000).
  const gcp = env.VITE_BACKEND === "gcp";
  const proxy = gcp ? {
    "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
    "/rest/v1": { target: env.VITE_DEV_DATA_URL || "http://127.0.0.1:3000", rewrite: (p) => p.replace(/^\/rest\/v1/, "") },
  } : undefined;

  return {
    plugins: [react(), directSignin()],
    server: { port: 5173, open: true, proxy },
  };
});
