// _shared/auth.ts — who may call a function.
//
// daily-digest, incident-deliver, welcome-email and incident-images are called
// by machines only: the scheduler, the database (pg_cron / pg_net on Supabase,
// the outbox on Google Cloud) and the owner's scripts. Before 2026-09-30 they
// accepted any caller — daily-digest and welcome-email run with verify_jwt=false,
// so anyone who knew the URL could mail every subscriber or read the dry-run
// list of reader addresses. requireInternal(req) now lets a request through only
// when it carries
//   (a) header x-internal-token equal to env INTERNAL_TOKEN — what the GCP API
//       (api/app/routers/gcp_jobs.py) sends with every function call, or
//   (b) Authorization: Bearer <env SUPABASE_SERVICE_ROLE_KEY> — pg_cron / pg_net
//       on Supabase, and scripts run by the owner.
// Anything else gets 401. Both comparisons are constant-time.
//
// On Cloud Run the Authorization header already carries Google's ID token (the
// service is --no-allow-unauthenticated), so (a) is the path there. A caller that
// wants (b) on Cloud Run sends the ID token in X-Serverless-Authorization instead.

const enc = new TextEncoder();

// Equal strings ⇔ equal SHA-256 digests. Comparing the fixed-length digests byte
// by byte takes the same time wherever the inputs differ, and whatever their length.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export function bearerOf(req: Request): string {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : "";
}

export async function isInternal(req: Request): Promise<boolean> {
  const expected = (Deno.env.get("INTERNAL_TOKEN") ?? "").trim();
  const token = (req.headers.get("x-internal-token") ?? "").trim();
  if (expected && token && await safeEqual(token, expected)) return true;
  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const bearer = bearerOf(req);
  return !!(serviceKey && bearer && await safeEqual(bearer, serviceKey));
}

export function unauthorized(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

// Top of a machine-only handler:  const denied = await requireInternal(req); if (denied) return denied;
export async function requireInternal(req: Request, headers: Record<string, string> = {}): Promise<Response | null> {
  if (await isInternal(req)) return null;
  if (!Deno.env.get("INTERNAL_TOKEN") && !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    console.error("[auth] neither INTERNAL_TOKEN nor SUPABASE_SERVICE_ROLE_KEY is set, so every call is refused");
  }
  return unauthorized(headers);
}

// incident-report only: the Daily Brief dashboard calls it from a browser with
// the public anon key (Authorization: Bearer <anon>, or an apikey header), so
// that key is accepted as well as the two internal ones.
export async function requireAnonOrInternal(req: Request, headers: Record<string, string> = {}): Promise<Response | null> {
  if (await isInternal(req)) return null;
  const anon = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();
  const presented = bearerOf(req) || (req.headers.get("apikey") ?? "").trim();
  if (anon && presented && await safeEqual(presented, anon)) return null;
  return unauthorized(headers);
}
