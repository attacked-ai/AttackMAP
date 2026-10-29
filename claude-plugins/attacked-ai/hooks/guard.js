// PreToolUse guard for Attacked.ai hard rules. Exit 2 blocks the tool call and
// shows stderr to Claude; exit 0 lets it through.
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};

  const block = (msg) => { process.stderr.write(`[attacked-ai guard] ${msg}\n`); process.exit(2); };

  // 1. Table RLS must stay disabled (storage policies are fine).
  if (/execute_sql|apply_migration/.test(tool)) {
    const sql = String(ti.query || "");
    for (const stmt of sql.split(";")) {
      if (/(enable|force)\s+row\s+level\s+security/i.test(stmt) && !/storage\./i.test(stmt)) {
        block("Project rule: keep RLS DISABLED on data tables. Remove the ENABLE/FORCE ROW LEVEL SECURITY statement, or ask the owner first.");
      }
    }
    process.exit(0);
  }

  // 2/3. Browser code: no service-role secrets, no Replaceable.ai crimson.
  const file = String(ti.file_path || "").replace(/\\/g, "/");
  const isBrowserCode = /\/(src|public)\/|\/index\.html$/.test(file);
  if (!isBrowserCode) process.exit(0);

  const text = [ti.content, ti.new_string, ...(ti.edits || []).map((e) => e.new_string)]
    .filter(Boolean).join("\n");

  if (/service_role|SERVICE_ROLE_KEY|sb_secret_/i.test(text)) {
    block(`Never put Supabase service-role/secret keys in browser code (${file}). Move that call into an edge function.`);
  }
  if (/#C41E3A/i.test(text)) {
    block("#C41E3A is the Replaceable.ai crimson. Attacked.ai uses gold #F5B800 (text-safe #8A6D00 on white).");
  }
  process.exit(0);
});
