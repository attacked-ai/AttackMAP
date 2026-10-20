#!/usr/bin/env node
// scripts/docker-local.mjs — the LOCAL Supabase stack (Docker) for Attacked.ai.
//
// One place for every local-stack chore, so nobody has to remember CLI flags:
//
//   node scripts/docker-local.mjs doctor [--fix-wsl]     is this PC ready? (Docker, WSL, disk, RAM, ports)
//   node scripts/docker-local.mjs start [--exclude=a,b]  start the containers, then write .env.docker
//   node scripts/docker-local.mjs env                    (re)write .env.docker + api/.env.docker from `supabase status`
//   node scripts/docker-local.mjs dump [--db-url=…] [--force] [--seed-exclude=a.b,c.d] [--seed-schemas=x,y]
//                                                        copy the LIVE schema + data into supabase/ (one time)
//   node scripts/docker-local.mjs reset                  rebuild the local DB from supabase/migrations + seed
//   node scripts/docker-local.mjs verify                 can the app reach the local stack? how many incidents?
//   node scripts/docker-local.mjs status                 `supabase status`
//   node scripts/docker-local.mjs stop [--wipe]          stop (data kept) / stop and delete the data
//
// All of it is wired as npm scripts (local:doctor, local:start, …); pass flags
// after `--`, e.g.  npm run local:dump -- --force . Flags work the same in
// PowerShell, cmd and bash, which `VAR=value npm run …` does not. The Supabase
// CLI runs through `npx supabase@2`, which lives in the npm cache (D:\npm-cache
// on this PC): nothing is installed on the full C: drive.
//
// Safety: nothing here writes to the live project. `dump` only READS from it,
// once, through the connection string you give it. The keys it writes into
// .env.docker are the local stack's well-known development keys. The one write
// to live this setup ever suggests (`supabase migration repair`, so a later
// `db push` does not replay the whole schema) is printed for YOU to run.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, copyFileSync, statfsSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const ENV_FILE = join(ROOT, ".env.docker");
const API_ENV_FILE = join(ROOT, "api", ".env.docker");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const ARCHIVE = join(ROOT, "supabase", "migrations.live-applied");
const SEED_DIR = join(ROOT, "supabase", "seed");
const SEED_FILE = join(SEED_DIR, "live_data.sql");

// ── arguments: `cmd [--flag] [--key=value]` ─────────────────────────────────
const [cmd = "doctor", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--") && !a.includes("=")));
const opts = Object.fromEntries(rest.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => { const i = a.indexOf("="); return [a.slice(2, i), a.slice(i + 1)]; }));
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

// Containers not to start. imgproxy = storage image transforms (unused).
// Add edge-runtime to save ~200 MB RAM when not testing functions:
//   npm run local:start -- --exclude=imgproxy,edge-runtime
const EXCLUDE = list(opts.exclude ?? process.env.LOCAL_SUPABASE_EXCLUDE ?? "imgproxy");

// Data-only dump: ONLY these schemas leave live. identity (accounts, profiles,
// applications, feedback, prefs) and ops (deliveries, logs) stay on live: local
// accounts are created fresh. Without this list the CLI dumps every schema,
// including auth (password hashes, session tokens), storage, cron and net —
// and the cron rows then break `supabase db reset` (postgres may not insert
// into cron.job). Override: --seed-schemas=cms,public
const SEED_SCHEMAS_DEFAULT = ["cms", "content", "map", "public", "reference", "sweep"];

// Within those schemas, tables whose ROWS stay on live. EXACT schema.table
// names only: the CLI double-quotes each value, so a "*" is matched literally,
// not as a wildcard. (public.profiles is a view over identity.profiles, so it
// has no rows anyway; it is listed in case that changes.) Override:
//   npm run local:dump -- --seed-exclude=public.a,public.b
const SEED_EXCLUDE_DEFAULT = [
  "public.profiles", "public.newsletter_subscribers", "public.vendor_applications",
  "public.partner_applications", "public.partner_feedback", "public.subscribers",
];

const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (m) => console.log(`${c.g}  ok  ${c.x}${m}`);
const warn = (m) => console.log(`${c.y} warn ${c.x}${m}`);
const bad = (m) => console.log(`${c.r} FAIL ${c.x}${m}`);
const info = (m) => console.log(`      ${c.d}${m}${c.x}`);
const head = (m) => console.log(`\n${c.b}${m}${c.x}`);
const die = (m, code = 1) => { console.error(`\n${c.r}${m}${c.x}\n`); process.exit(code); };

// ── running things ───────────────────────────────────────────────────────────
function run(command, args, { capture = false, cwd = ROOT, env, shell = false } = {}) {
  // With a shell, hand over ONE command string (Node warns when args + shell are mixed).
  const q = (x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);
  const r = shell
    ? spawnSync([command, ...args.map(q)].join(" "), { cwd, env: { ...process.env, ...env }, shell: true, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
    : spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "", error: r.error };
}
// npx on Windows is npx.cmd, which Node refuses to spawn without a shell (and a
// shell would mangle % and & in a percent-encoded DB URL). Run npm's own
// npx-cli.js with this Node instead: no shell, arguments passed as-is.
function npxCli() {
  const cands = [];
  if (process.env.npm_execpath) cands.push(join(dirname(process.env.npm_execpath), "npx-cli.js"));
  const prefix = run("npm", ["config", "get", "prefix"], { capture: true, shell: true });
  if (prefix.out.trim()) cands.push(join(prefix.out.trim(), "node_modules", "npm", "bin", "npx-cli.js"), join(prefix.out.trim(), "lib", "node_modules", "npm", "bin", "npx-cli.js"));
  cands.push(join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"));
  return cands.find((p) => existsSync(p));
}
const NPX = npxCli();
const sb = (args, o) => NPX
  ? run(process.execPath, [NPX, "-y", "supabase@2", ...args], o)
  : run(WIN ? "npx.cmd" : "npx", ["-y", "supabase@2", ...args], { ...o, shell: true });
const sbOrDie = (args, what) => { const r = sb(args); if (r.code !== 0) die(`${what} failed (exit ${r.code}).`); return r; };

// ── small helpers ────────────────────────────────────────────────────────────
const readEnv = (file) => {
  try {
    return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
};
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;
const freeBytes = (path) => { try { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };
// Docker Desktop on Windows publishes ports on 0.0.0.0 / [::] in a way that still
// lets another socket bind 127.0.0.1, so the IPv4 probe alone says "free" while the
// stack is up. Probe both loopbacks; a port is free only if nothing answers on either.
const bindResult = (host, port) => new Promise((res) => {
  const s = net.createServer()
    .once("error", (e) => res(e.code === "EADDRINUSE" || e.code === "EACCES" ? "inuse" : "free"))
    .once("listening", () => s.close(() => res("free")));
  s.listen(port, host);
});
const portFree = async (port) => {
  for (const host of ["127.0.0.1", "::1", "::"]) if ((await bindResult(host, port)) === "inuse") return false;
  return true;
};
const ts = (plusSeconds = 0) => new Date(Date.now() + plusSeconds * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
const version = (file) => (file.match(/^(\d{14})_/) || [])[1];
const baselineFile = () => existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).find((f) => /_baseline_live\.sql$/.test(f)) : undefined;
const triggerFile = () => existsSync(MIGRATIONS) ? readdirSync(MIGRATIONS).find((f) => /_auth_triggers_live\.sql$/.test(f)) : undefined;

// Docker Desktop on this PC is installed under D:\Docker (C: is full). A shell
// opened before the install has no docker on PATH, and the Supabase CLI calls
// plain "docker", so put the install's bin folder on PATH for everything we spawn.
const DOCKER_BIN_DIRS = WIN
  ? ["D:\\Docker\\resources\\bin", "C:\\Program Files\\Docker\\Docker\\resources\\bin"]
  : ["/usr/local/bin", "/opt/homebrew/bin"];
function ensureDockerOnPath() {
  if (spawnSync("docker", ["--version"], { encoding: "utf8", stdio: "ignore" }).status === 0) return;
  const dir = DOCKER_BIN_DIRS.find((d) => existsSync(join(d, WIN ? "docker.exe" : "docker")));
  if (dir) process.env.PATH = dir + (WIN ? ";" : ":") + (process.env.PATH || "");
}
ensureDockerOnPath();

function dockerState() {
  const client = run("docker", ["--version"], { capture: true });
  if (client.code !== 0) return { installed: false, running: false };
  const server = run("docker", ["version", "--format", "{{.Server.Version}}"], { capture: true });
  return { installed: true, running: server.code === 0, version: client.out.trim(), server: server.out.trim() };
}
function requireDocker() {
  const d = dockerState();
  if (!d.installed) die("Docker is not installed. See LOCAL_DOCKER_SETUP.md section 2 (docker\\install-docker-desktop.ps1).");
  if (!d.running) die("Docker Desktop is installed but its engine is not running. Start Docker Desktop and wait for \"Engine running\".");
}

// `supabase status -o env` → { API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL, STUDIO_URL, MAILPIT_URL | INBUCKET_URL, JWT_SECRET, … }
function stackStatus() {
  const r = sb(["status", "-o", "env"], { capture: true });
  if (r.code !== 0) return null;
  const vals = Object.fromEntries(r.out.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
  }));
  if (!vals.API_URL) return null;
  return {
    url: vals.API_URL,
    anon: vals.ANON_KEY || vals.PUBLISHABLE_KEY || "",
    service: vals.SERVICE_ROLE_KEY || vals.SECRET_KEY || "",
    jwtSecret: vals.JWT_SECRET || "",
    db: vals.DB_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    studio: vals.STUDIO_URL || "http://127.0.0.1:54323",
    mail: vals.MAILPIT_URL || vals.INBUCKET_URL || "http://127.0.0.1:54324",
  };
}

// ── commands ─────────────────────────────────────────────────────────────────
async function doctor() {
  head("Local Docker stack — doctor");
  const node = Number(process.versions.node.split(".")[0]);
  (node >= 18 ? ok : bad)(`Node ${process.version}`);

  const d = dockerState();
  if (!d.installed) bad("Docker: not installed → LOCAL_DOCKER_SETUP.md §2 (install to D:, C: is full)");
  else if (!d.running) warn(`Docker: ${d.version} installed, engine NOT running → open Docker Desktop`);
  else ok(`Docker: ${d.version}, engine ${d.server}`);

  if (WIN) {
    const w = run("wsl", ["--status"], { capture: true });
    (w.code === 0 ? ok : warn)(`WSL 2: ${w.code === 0 ? "present" : "not ready (Docker Desktop's installer enables it)"}`);
    const wslcfg = join(os.homedir(), ".wslconfig");
    if (existsSync(wslcfg)) {
      ok(`${wslcfg} present (RAM cap for WSL/Docker)`);
      if (!/^\s*swapFile\s*=/m.test(readFileSync(wslcfg, "utf8"))) warn("it has no swapFile= line: WSL puts its swap disk on C: (see docker/wslconfig.example)");
    } else if (flags.has("--fix-wsl")) {
      copyFileSync(join(ROOT, "docker", "wslconfig.example"), wslcfg);
      ok(`wrote ${wslcfg} — takes effect at the next  wsl --shutdown  (Docker Desktop restarts its engine afterwards)`);
    } else warn(`no ${wslcfg}: WSL may take half the RAM. Fix:  npm run local:doctor -- --fix-wsl  (best BEFORE Docker's first start)`);
  }

  for (const [drive, min] of WIN ? [["C:\\", 5], ["D:\\", 20]] : [["/", 10]]) {
    const f = freeBytes(drive);
    if (f == null) { info(`${drive} not found`); continue; }
    (f / 1024 ** 3 >= min ? ok : f / 1024 ** 3 >= 1.5 ? warn : bad)(`${drive} free: ${gb(f)} (want ≥ ${min} GB)`);
  }
  const ram = os.totalmem(), free = os.freemem();
  (ram / 1024 ** 3 >= 7.5 ? ok : warn)(`RAM: ${gb(ram)} total, ${gb(free)} free now (stack needs ~1 GB idle, ~2.5 GB busy; WSL capped at 3 GB)`);

  const ports = { 54321: "API gateway", 54322: "Postgres", 54323: "Studio", 54324: "Mailpit", 5173: "Vite", 5174: "Vite (desktop preview)" };
  const running = d.running && !!stackStatus();
  for (const [p, name] of Object.entries(ports)) {
    const free = await portFree(Number(p));
    if (free) ok(`port ${p} free (${name})`);
    else (running || p === "5173" || p === "5174" ? info : warn)(`port ${p} in use (${name}${running ? " — the stack is running" : ""})`);
  }

  const cli = sb(["--version"], { capture: true });
  (cli.code === 0 ? ok : bad)(`Supabase CLI via npx: ${cli.code === 0 ? cli.out.trim() : "cannot run"}`);
  info(NPX ? `npx runs through ${NPX}` : "npx runs through the shell (npx-cli.js not found)");
  (existsSync(join(ROOT, "supabase", "config.toml")) ? ok : bad)("supabase/config.toml");
  const base = baselineFile();
  (base ? ok : warn)(base ? `schema baseline: supabase/migrations/${base}` : "no schema baseline yet → npm run local:dump (after the stack runs once)");
  if (base) (triggerFile() ? ok : warn)(triggerFile() ? `auth.users triggers: supabase/migrations/${triggerFile()}` : "no auth.users trigger file: new local sign-ups get no profile row (re-run local:dump -- --force)");
  (existsSync(SEED_FILE) ? ok : warn)(existsSync(SEED_FILE) ? `data seed: supabase/seed/live_data.sql (${mb(statSync(SEED_FILE).size)})` : "no live data seed yet (local:dump writes it)");
  (existsSync(ENV_FILE) ? ok : info)(existsSync(ENV_FILE) ? ".env.docker present" : ".env.docker not written yet (local:start does it)");
  if (existsSync(join(ROOT, ".env.local"))) info(".env.local exists; .env.docker overrides it in --mode docker, as Vite's precedence says");
  console.log("");
}

function writeEnvFiles(s) {
  const prev = readEnv(ENV_FILE);
  const keep = (k, dflt) => (prev[k] !== undefined ? prev[k] : dflt);
  const web = [
    "# .env.docker — written by `npm run local:env` from `supabase status`. Loaded by",
    "# `vite --mode docker` only; `npm run dev` still uses .env (live). Git-ignored.",
    `# Written ${new Date().toISOString()}. Edit VITE_API_URL / VITE_DIRECT_SIGNIN freely: they are kept on rewrite.`,
    `VITE_SUPABASE_URL=${s.url}`,
    `VITE_SUPABASE_ANON_KEY=${s.anon}`,
    "VITE_SUPABASE_PUBLISHABLE_KEY=",
    `VITE_API_URL=${keep("VITE_API_URL", "")}`,
    "VITE_BACKEND=supabase",
    `VITE_AUTH_PROVIDERS=${keep("VITE_AUTH_PROVIDERS", "")}`,
    `VITE_DIRECT_SIGNIN=${keep("VITE_DIRECT_SIGNIN", "1")}`,
    "# not VITE_-prefixed: stays on the dev server (direct sign-in route), never in the browser",
    `SUPABASE_SECRET_KEY=${s.service}`,
    `SUPABASE_DB_URL=${s.db}`,
    "# informational; local:verify reads these when the stack is down",
    `STUDIO_URL=${s.studio}`,
    `MAILPIT_URL=${s.mail}`,
    "",
  ].join("\n");
  writeFileSync(ENV_FILE, web);

  // The FastAPI container (docker compose --profile api). It reaches the stack
  // through the host, so the URL is host.docker.internal, not 127.0.0.1.
  const api = [
    "# api/.env.docker — written by `npm run local:env`. Read by docker-compose.yml (api service). Git-ignored.",
    "ENV=local",
    "BACKEND=supabase",
    `SUPABASE_URL=${s.url.replace("127.0.0.1", "host.docker.internal").replace("localhost", "host.docker.internal")}`,
    `SUPABASE_ANON_KEY=${s.anon}`,
    `SUPABASE_SERVICE_ROLE_KEY=${s.service}`,
    `SUPABASE_JWT_SECRET=${s.jwtSecret}`,
    "ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
    "REPORTS_DIR=/srv/reports",
    "INGEST_TOKEN=local-ingest-token",
    "SUBSCRIBER_TIERS=enterprise,admin",
    "# Sign-in codes through the API need a real Gmail sender; empty = /auth/send-code answers 503",
    "# and the app shows that error. Leave VITE_API_URL empty in .env.docker to test sign-in via Mailpit.",
    "GMAIL_USER=",
    "GMAIL_APP_PASSWORD=",
    "",
  ].join("\n");
  writeFileSync(API_ENV_FILE, api);
  ok(`wrote .env.docker and api/.env.docker`);
}

function envCmd() {
  requireDocker();
  const s = stackStatus();
  if (!s) die("The local stack is not running (supabase status failed). Run: npm run local:start");
  writeEnvFiles(s);
  printUrls(s);
}

function printUrls(s) {
  console.log(`
  Web app (local stack):   npm run dev:docker      → http://localhost:5173
  Supabase Studio:         ${s.studio}
  Mail catcher (codes):    ${s.mail}
  API gateway:             ${s.url}
  Postgres:                ${s.db}   (psql: docker exec -it supabase_db_attackedmap psql -U postgres)
`);
}

// Before the baseline exists, any migration file in supabase/migrations is one of
// the deltas already applied on live. On an EMPTY local database they fail
// ("schema identity does not exist") and the CLI stops every container. They
// belong in the archive until a baseline is dumped (dump() moves them too).
function archiveDeltasWithoutBaseline() {
  if (!existsSync(MIGRATIONS) || baselineFile()) return;
  const deltas = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  if (!deltas.length) return;
  mkdirSync(ARCHIVE, { recursive: true });
  for (const f of deltas) renameSync(join(MIGRATIONS, f), join(ARCHIVE, f));
  warn(`moved ${deltas.length} pre-baseline migration file(s) to supabase/migrations.live-applied/ (they need the full schema first)`);
}

async function start() {
  requireDocker();
  head(`Starting the local Supabase stack (excluding: ${EXCLUDE.join(", ") || "nothing"})`);
  archiveDeltasWithoutBaseline();
  if (!baselineFile()) warn("No schema baseline yet: the database will be EMPTY until you run `npm run local:dump` (see LOCAL_DOCKER_SETUP.md §4).");
  const args = ["start"]; if (EXCLUDE.length) args.push("-x", EXCLUDE.join(","));
  sbOrDie(args, "supabase start");
  const s = stackStatus();
  if (!s) die("Started, but `supabase status` gave nothing usable.");
  writeEnvFiles(s);
  await verify(s, { quiet: true });
  printUrls(s);
}

function stop() {
  requireDocker();
  const wipe = flags.has("--wipe");
  head(wipe ? "Stopping and DELETING the local data" : "Stopping (data kept in Docker volumes)");
  sbOrDie(wipe ? ["stop", "--no-backup"] : ["stop"], "supabase stop");
}

async function reset() {
  requireDocker();
  archiveDeltasWithoutBaseline();
  if (!baselineFile()) warn("No schema baseline: reset gives an empty database. Run local:dump first.");
  head("Rebuilding the local database from supabase/migrations + seed");
  sbOrDie(["db", "reset"], "supabase db reset");
  const s = stackStatus(); if (s) await verify(s);
}

async function verify(s = null, { quiet = false } = {}) {
  s = s || stackStatus();
  if (!s) { const e = readEnv(ENV_FILE); if (!e.VITE_SUPABASE_URL) die("Stack not running and no .env.docker."); s = { url: e.VITE_SUPABASE_URL, anon: e.VITE_SUPABASE_ANON_KEY, studio: e.STUDIO_URL, mail: e.MAILPIT_URL, db: e.SUPABASE_DB_URL }; }
  if (!quiet) head("Verifying the local stack");
  const H = { apikey: s.anon, Authorization: `Bearer ${s.anon}` };
  try {
    const h = await fetch(`${s.url}/auth/v1/health`, { headers: H });
    (h.ok ? ok : bad)(`auth health: HTTP ${h.status}`);
  } catch (e) { bad(`auth unreachable: ${e.message}`); }
  try {
    const r = await fetch(`${s.url}/rest/v1/incidents?select=id&limit=1`, { headers: { ...H, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" } });
    if (r.status === 404 || r.status === 400) warn("PostgREST answers, but the incidents table is missing → the schema baseline is not in yet (npm run local:dump, then local:reset)");
    else if (!r.ok) bad(`PostgREST incidents: HTTP ${r.status}`);
    else { const total = (r.headers.get("content-range") || "").split("/")[1]; ok(`PostgREST incidents: ${total ?? "?"} rows readable as anon (live has ~2,300)`); }
  } catch (e) { bad(`PostgREST unreachable: ${e.message}`); }
}

// ── dump: copy the live project in ──────────────────────────────────────────
function liveDbUrl() {
  const fromEnv = opts["db-url"] || process.env.LIVE_DB_URL || readEnv(join(ROOT, "api", ".env")).SUPABASE_DB_URL;
  if (!fromEnv) die(`No live connection string. Put it in api/.env as SUPABASE_DB_URL=... (git-ignored), or pass it once:
  npm run local:dump -- --db-url="postgresql://..."
Where: Supabase dashboard → Project Settings → Database → Connection string → "Session pooler" (port 5432, IPv4-safe).
Percent-encode special characters in the password (@ → %40, # → %23, / → %2F).`);
  if (/127\.0\.0\.1|localhost|54322/.test(fromEnv)) die("That is the LOCAL database URL, not live.");
  return fromEnv;
}

const SECRET_PATTERNS = [
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT"],
  [/sb_secret_[A-Za-z0-9_-]{10,}/g, "Supabase secret key"],
  [/\bre_[A-Za-z0-9]{20,}\b/g, "Resend key"],
  [/postgres(?:ql)?:\/\/[^\s'"]+:[^\s'"@]+@/g, "connection string with password"],
  [/\bAC[0-9a-f]{32}\b/g, "Twilio SID"],
];
function scanSecrets(file) {
  const text = readFileSync(file, "utf8");
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, what] of SECRET_PATTERNS) if (re.test(line)) { hits.push(`  line ${i + 1}: ${what}: ${line.trim().slice(0, 60).replace(/[A-Za-z0-9_-]{12,}/g, "…")}`); re.lastIndex = 0; }
  });
  return hits;
}

// `ALTER <object> … OWNER TO <custom role>` needs the new owner to hold CREATE on
// the object's schema at that moment; the dump grants the role USAGE only, and
// thousands of lines later. On live a higher-privileged role ran it; locally the
// migration runs as postgres. Insert the grant right before the first transfer
// per (schema, role). Local-only privilege, flagged in the file.
function fixOwnershipGrants(file, customRoles) {
  if (!customRoles.length) return 0;
  const re = /^ALTER\s+(?:TABLE|FUNCTION|PROCEDURE|SEQUENCE|VIEW|MATERIALIZED VIEW|TYPE|DOMAIN)\s+(?:ONLY\s+)?"([A-Za-z0-9_]+)"\."[^"]+".*OWNER TO "([A-Za-z0-9_]+)";\s*$/;
  const out = [], done = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(re);
    if (m && customRoles.includes(m[2]) && !done.has(`${m[1]}:${m[2]}`)) {
      done.add(`${m[1]}:${m[2]}`);
      out.push(`-- local only (scripts/docker-local.mjs): the new owner below needs CREATE on the schema for the transfer`);
      out.push(`GRANT USAGE, CREATE ON SCHEMA "${m[1]}" TO "${m[2]}";`);
    }
    out.push(line);
  }
  if (done.size) {
    // Hand the extra privilege back once the transfers are done, so the local
    // schema ACL ends up exactly as on live (USAGE only for the role).
    out.push("", "-- local only (scripts/docker-local.mjs): undo the CREATE grants inserted before the ownership transfers");
    for (const k of done) { const [schema, role] = k.split(":"); out.push(`REVOKE CREATE ON SCHEMA "${schema}" FROM "${role}";`); }
    writeFileSync(file, out.join("\n") + "\n");
  }
  return done.size;
}

// The local image pre-seeds ALTER DEFAULT PRIVILEGES … IN SCHEMA public GRANT ALL
// TO anon, authenticated, so every public table/view/function the baseline creates
// is MORE open locally than on live (pg_dump emits GRANTs, never the absence of
// one). Capture live's actual grants for anon/authenticated on public relations
// and functions as REVOKE-then-GRANT statements; the CLI runs the file after the
// migrations (config.toml [db.seed] sql_paths), so local ends up matching live.
const ACL_FILE = join(ROOT, "supabase", "seed_live_acl.sql");
const ACL_SQL = `
select format('revoke all on public.%I from anon, authenticated;', c.relname)
  || coalesce((select string_agg(format(' grant %s on public.%I to %I;', s.privs, c.relname, s.grantee), '')
               from (select g.grantee::regrole::text as grantee, string_agg(g.privilege_type, ', ' order by g.privilege_type) as privs
                     from aclexplode(c.relacl) g
                     where g.grantee in ('anon'::regrole, 'authenticated'::regrole) group by g.grantee) s), '')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
union all
select format('revoke all on function public.%I(%s) from anon, authenticated;', p.proname, pg_get_function_identity_arguments(p.oid))
  || coalesce((select string_agg(format(' grant execute on function public.%I(%s) to %I;', p.proname, pg_get_function_identity_arguments(p.oid), g.grantee::regrole::text), '')
               from aclexplode(p.proacl) g
               where g.grantee in ('anon'::regrole, 'authenticated'::regrole) and g.privilege_type = 'EXECUTE'), '')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proacl is not null
order by 1;`.replace(/\s+/g, " ").trim();
function dumpLiveAcl(url) {
  const r = run("docker", ["run", "--rm", "postgres:17-alpine", "psql", url, "-At", "-v", "ON_ERROR_STOP=1", "-c", ACL_SQL], { capture: true });
  if (r.code !== 0) { warn(`could not read live privileges (${(r.err || r.out).trim().split(/\r?\n/).pop()}); local public objects stay more open than live`); return 0; }
  const lines = r.out.trim().split(/\r?\n/).filter(Boolean);
  writeFileSync(ACL_FILE, [
    "-- Privileges of anon / authenticated on the public schema, as they are on LIVE,",
    "-- written by scripts/docker-local.mjs dump (step 2b). Applied by the CLI after the",
    "-- migrations (config.toml [db.seed] sql_paths), because the local image grants ALL",
    "-- on every new public object to those roles by default and the schema dump cannot",
    "-- express the absence of a grant. Local only, safe to commit, regenerated on each dump.",
    ...lines,
    "",
  ].join("\n"));
  return lines.length;
}

async function dump() {
  requireDocker();   // the CLI runs pg_dump inside a container
  // Step 3 needs the stack; check first, so a stopped stack does not cost a
  // second read of live on the retry.
  if (!stackStatus()) die("The local stack is not running. Run: npm run local:start, then retry local:dump.");
  const url = liveDbUrl();

  head("0/3  Custom database roles → supabase/roles.sql (the CLI applies it before the migrations on every reset)");
  // Live owns some objects with its own roles (e.g. intel_globe_owner for the
  // intel schema). The baseline's ALTER … OWNER TO lines need those roles to
  // exist first. pg_dumpall --roles-only includes password hashes; they are
  // removed, nobody logs in as these roles locally.
  const rolesFile = join(ROOT, "supabase", "roles.sql");
  sbOrDie(["db", "dump", "--db-url", url, "--role-only", "-f", rolesFile], "role dump");
  let roles = readFileSync(rolesFile, "utf8");
  const stripped = (roles.match(/PASSWORD\s+'[^']*'/gi) || []).length;
  roles = roles.replace(/\s*(?:ENCRYPTED\s+)?PASSWORD\s+'[^']*'/gi, "");
  // The migrations run as `postgres`, which is NOT a superuser in the local
  // image: to run the baseline's `ALTER … OWNER TO <role>` it must be a member
  // of that role ("must be able to SET ROLE"). Grant every custom role to it.
  const customRoles = [...roles.matchAll(/^\s*CREATE ROLE\s+"?([A-Za-z0-9_]+)"?/gim)].map((m) => m[1]);
  const grants = customRoles.map((r) => `GRANT "${r}" TO "postgres";`).join("\n");
  writeFileSync(rolesFile, [
    "-- Roles of the live database (names, memberships, settings; passwords removed),",
    "-- written by scripts/docker-local.mjs dump. The Supabase CLI applies this file",
    "-- before the migrations on every db reset, so objects owned by custom roles",
    "-- (e.g. intel_globe_owner) can be restored. Safe to commit.",
    roles.trim(),
    "",
    "-- Local only: the migrations run as postgres (not a superuser here); it must be a",
    "-- member of each custom role to transfer ownership to it.",
    grants,
    "",
  ].join("\n"));
  ok(`wrote supabase/roles.sql (${customRoles.length} role(s): ${customRoles.join(", ")}; ${stripped} password hash(es) removed)`);

  head("1/3  Schema of the live database → supabase/migrations (schema only, no rows)");
  const existing = baselineFile();
  let baseName = existing;
  if (existing && !flags.has("--force")) {
    warn(`baseline already exists: ${existing}. Re-run with  npm run local:dump -- --force  to replace it (the old one is archived).`);
  } else {
    mkdirSync(MIGRATIONS, { recursive: true });
    const file = join(MIGRATIONS, `${ts()}_baseline_live.sql`);
    baseName = file.split(/[\\/]/).pop();
    sbOrDie(["db", "dump", "--db-url", url, "-f", file], "schema dump");
    const fixed = fixOwnershipGrants(file, customRoles);
    ok(`wrote supabase/migrations/${baseName} (${mb(statSync(file).size)}${fixed ? `, ${fixed} local-only schema grant(s) added for custom-role ownership` : ""})`);
    // Every older migration is already applied on live, so it is inside the
    // baseline. The auth-trigger file is left alone: step 1b replaces it only
    // once it has a fresh copy, so a failed read never leaves the stack without it.
    mkdirSync(ARCHIVE, { recursive: true });
    for (const f of readdirSync(MIGRATIONS)) {
      if (!f.endsWith(".sql") || f === baseName || f.endsWith("_auth_triggers_live.sql")) continue;
      renameSync(join(MIGRATIONS, f), join(ARCHIVE, f));
      info(`archived ${f} → supabase/migrations.live-applied/`);
    }
    const hits = scanSecrets(file);
    if (hits.length) {
      warn(`the schema dump contains ${hits.length} secret-looking value(s). Review and remove them BEFORE committing:`);
      hits.slice(0, 20).forEach((h) => console.log(h));
    } else ok("no secret-looking values in the schema dump");
  }

  head("1b/3  Triggers on auth.users (pg_dump skips the auth schema, but the sign-up → profile trigger lives there)");
  // Same trick deploy/gcp/db/migrate.sh uses: read the trigger definitions with
  // psql. No psql on this PC, so run it from the postgres image Docker already has.
  const trg = run("docker", ["run", "--rm", "postgres:17-alpine", "psql", url, "-At", "-v", "ON_ERROR_STOP=1", "-c",
    "select pg_get_triggerdef(t.oid) || ';' from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal order by t.tgname"], { capture: true });
  let trgName = triggerFile();
  if (trg.code !== 0) {
    const last = (trg.err || trg.out).trim().split(/\r?\n/).pop();
    warn(`could not read the auth.users triggers (${last}).${trgName ? ` Keeping the previous ${trgName}.` : " New local sign-ups will get no profile row until you add the trigger by hand."}`);
  } else {
    const body = trg.out.trim();
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith("_auth_triggers_live.sql"))) renameSync(join(MIGRATIONS, f), join(ARCHIVE, f));
    trgName = undefined;
    if (body) {
      const tf = join(MIGRATIONS, `${ts(1)}_auth_triggers_live.sql`);
      trgName = tf.split(/[\\/]/).pop();
      writeFileSync(tf, [
        "-- Triggers on auth.users, copied from live by scripts/docker-local.mjs dump.",
        "-- pg_dump leaves the auth schema out, so the baseline has the FUNCTIONS these call",
        "-- (public/identity schema) but not the triggers themselves.",
        body,
        "",
      ].join("\n"));
      ok(`wrote supabase/migrations/${trgName} (${body.split(/\r?\n/).length} trigger(s))`);
    } else info("live has no custom triggers on auth.users");
  }

  head("2b/3  Privileges of anon/authenticated on public objects, as on live → supabase/seed_live_acl.sql");
  const aclLines = dumpLiveAcl(url);
  if (aclLines) ok(`wrote supabase/seed_live_acl.sql (${aclLines} statement(s))`);

  head("2/3  Data of the live database → supabase/seed/live_data.sql (git-ignored)");
  const schemas = list(opts["seed-schemas"] || SEED_SCHEMAS_DEFAULT.join(","));
  const excl = list(opts["seed-exclude"] ?? process.env.LOCAL_SEED_EXCLUDE ?? SEED_EXCLUDE_DEFAULT.join(","));
  info(`schemas copied: ${schemas.join(", ")}   (identity, ops, auth, storage, cron, net, vault: never)`);
  info(`rows NOT copied within them: ${excl.join(", ") || "none"}`);
  mkdirSync(SEED_DIR, { recursive: true });
  const tmp = SEED_FILE + ".tmp";
  const args = ["db", "dump", "--db-url", url, "--data-only", "-s", schemas.join(",")];
  if (excl.length) args.push("-x", excl.join(","));
  sbOrDie([...args, "-f", tmp], "data dump");
  // Rows arrive without their parents in identity/auth: load with FK and
  // trigger checks off (same effect as pg_restore --disable-triggers).
  const body = readFileSync(tmp, "utf8");
  writeFileSync(SEED_FILE, `-- live data copy, written by scripts/docker-local.mjs dump on ${new Date().toISOString()}\n-- schemas: ${schemas.join(", ")}; excluded tables: ${excl.join(", ") || "none"}\nset session_replication_role = replica;\n${body}\nset session_replication_role = default;\n`);
  unlinkSync(tmp);   // the raw dump is reproducible; no 60 MB duplicate in a OneDrive folder
  ok(`wrote supabase/seed/live_data.sql (${mb(statSync(SEED_FILE).size)})`);
  const dh = scanSecrets(SEED_FILE);
  if (dh.length) warn(`${dh.length} secret-looking value(s) in the data seed (it is git-ignored, but keep it off shared drives).`);

  head("3/3  Load it into the local stack");
  sbOrDie(["db", "reset"], "supabase db reset");
  ok("local database rebuilt from the baseline + seed");
  const s = stackStatus(); if (s) await verify(s);

  info(`Egress: this read live once — the schema (small) plus the data of ${schemas.length} schemas (${mb(statSync(SEED_FILE).size)} as SQL; the whole live DB is ~220 MB). A few % of the 5 GB monthly quota. Never loop it.`);
  const versions = [baseName, trgName].filter(Boolean).map(version).filter(Boolean);
  if (versions.length) {
    console.log(`
  ${c.b}Before you ever run "supabase db push" against live:${c.x} these new files are not in live's
  migration history, so a push would try to replay the whole schema. Mark them applied first
  (the ONE write to live in this setup, run by you, once):
    npx supabase@2 migration repair --db-url "<live url>" --status applied ${versions.join(" ")}
  and always check with  npx supabase@2 db push --dry-run --db-url "<live url>"  that only the
  new migration is listed. Details: LOCAL_DOCKER_SETUP.md §5.
`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const table = { doctor, start, stop, status: () => sb(["status"]), env: envCmd, reset, verify: () => verify(), dump };
if (!table[cmd]) die(`Unknown command "${cmd}". One of: ${Object.keys(table).join(", ")}`);
await table[cmd]();
