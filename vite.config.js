import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");

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
    plugins: [react()],
    server: { port: 5173, open: true, proxy },
  };
});
