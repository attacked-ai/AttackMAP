// signupAnswers.js — the sign-up page's answers onto the account that was just
// signed in (SignUpPage.jsx after the email code; AuthProvider after a Google /
// Microsoft or hosted trip).
//
//   answers: { first_name, last_name, full_name, role, company, industry,
//              marketing_opt_in } — any of them may be missing.
//
// They fill only what the profile does not have yet: an account that already
// exists keeps its own answers (Profile is where those change). The first save
// stamps onboarded_at, and onboarded_at NULL -> set sends the welcome email
// (trg_welcome_on_onboarded). The answers are also kept on the account
// (user_metadata), where the dashboard and the profile step look if the
// profile write did not land.
import { supabase } from "./supabaseClient";

const PROFILE_KEYS = ["full_name", "role", "company", "industry"];

export async function applySignupAnswers(user, answers) {
  const uid = user?.id;
  if (!uid || !answers) return { error: "Not signed in." };
  const meta = user.user_metadata || {};
  const typedName = `${String(answers.first_name || "").trim()} ${String(answers.last_name || "").trim()}`.trim();
  const want = {
    full_name: String(answers.full_name || typedName || meta.full_name || "").trim() || null,
    role: answers.role || null,
    company: String(answers.company || "").trim() || null,
    industry: answers.industry || null,
  };

  // The account first: if the profile write fails, the dashboard repairs the
  // row from these (Dashboard.jsx, main.jsx ProfileStep).
  const metaPatch = {};
  if (answers.first_name && !meta.first_name) metaPatch.first_name = String(answers.first_name).trim();
  if (answers.last_name && !meta.last_name) metaPatch.last_name = String(answers.last_name).trim();
  if (want.full_name && !meta.full_name) metaPatch.full_name = want.full_name;
  if (want.role && !meta.job_title) metaPatch.job_title = want.role;
  if (want.company && !meta.company) metaPatch.company = want.company;
  if (want.industry && !meta.industry) metaPatch.industry = want.industry;
  if (typeof answers.marketing_opt_in === "boolean" && typeof meta.marketing_opt_in !== "boolean") metaPatch.marketing_opt_in = answers.marketing_opt_in;
  if (Object.keys(metaPatch).length) {
    const { error } = await supabase.auth.updateUser({ data: metaPatch });
    if (error) console.warn("[Sign-up] answers not kept on the account:", error.message);
  }

  const { data: before, error: readErr } = await supabase.from("profiles")
    .select("full_name, role, company, industry, avatar_url, onboarded_at").eq("id", uid).maybeSingle();
  if (readErr) { console.warn("[Sign-up] profile read failed:", readErr.message); return { error: "Could not save your details." }; }
  const patch = {};
  for (const k of PROFILE_KEYS) if (want[k] && !before?.[k]) patch[k] = want[k];
  // The provider's picture, where the profile has none.
  if (meta.avatar_url && !before?.avatar_url) patch.avatar_url = meta.avatar_url;
  if (!before?.onboarded_at) patch.onboarded_at = new Date().toISOString();
  if (!Object.keys(patch).length) return { ok: true };
  const { error } = await supabase.from("profiles").update(patch).eq("id", uid);
  if (error) { console.warn("[Sign-up] profile save failed:", error.message); return { error: "Could not save your details." }; }
  return { ok: true };
}
