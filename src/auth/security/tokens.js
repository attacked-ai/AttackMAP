// ─────────────────────────────────────────────────────────────────────────
// Design tokens shared by the "Login and security" section (SecurityPanel,
// LoginCard, TwoStepCard). Inline style objects, like the rest of the app.
// ─────────────────────────────────────────────────────────────────────────
export const C = {
  paper: "#FFFFFF", paper2: "#FAFAFA", ink: "#101010", ink2: "#52525B", ink3: "#6A6A6A",
  line: "#E7E7E9", line2: "#CFCDC4", gold: "#FCBD00", goldDeep: "#8A6D00",
  obsidian: "#1A1A1A", err: "#C0341D", ok: "#1E7A3D", okBg: "#EAF6EE", warnBg: "#FFF7DD",
};
export const FONT = "Inter, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, monospace";

export const card = { marginTop: 22, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "22px 24px" };
export const h3 = { margin: "0 0 6px", fontSize: 15, fontWeight: 800, color: C.ink, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", outline: "none" };
export const p = { margin: "0 0 12px", fontSize: 13.5, lineHeight: 1.6, color: C.ink2 };
export const helper = { fontSize: 12.5, lineHeight: 1.55, color: C.ink3 };
export const btn = (primary, disabled) => ({
  padding: "11px 18px", background: primary ? C.gold : "transparent", color: C.obsidian,
  border: primary ? "none" : `1px solid ${C.line2}`, borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  fontFamily: FONT, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
});
export const pill = (on) => ({
  fontSize: 10.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999,
  background: on ? C.okBg : "#F1F1F2", color: on ? C.ok : C.ink3, whiteSpace: "nowrap",
});
export const recPill = { ...pill(false), background: C.warnBg, color: C.goldDeep };
export const codeInput = { width: 150, maxWidth: "100%", boxSizing: "border-box", padding: "11px 12px", border: `1px solid ${C.line2}`, borderRadius: 4, fontFamily: MONO, fontSize: 18, letterSpacing: "0.3em", textAlign: "center", color: C.ink, background: "#fff" };
// ProfilePage's text field, for the password form.
export const field = { width: "100%", boxSizing: "border-box", padding: "11px 13px", background: C.paper, color: C.ink, border: `1px solid ${C.line2}`, borderRadius: 4, fontFamily: FONT, fontSize: 14, outline: "none" };
export const focusGold = (e) => { e.target.style.borderColor = C.gold; };
export const blurLine = (e) => { e.target.style.borderColor = C.line2; };
// Link-styled button (goldDeep, 700) for in-sentence actions.
export const linkBtn = { background: "none", border: "none", padding: 0, cursor: "pointer", color: C.goldDeep, fontFamily: FONT, fontSize: "inherit", fontWeight: 700, textAlign: "left" };

export const rowLabel = { fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 4 };
export const readBox = { background: C.paper2, border: `1px solid ${C.line}`, borderRadius: 4, padding: "11px 13px", fontSize: 14, color: C.ink3, wordBreak: "break-word" };
export const subRow = { border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" };
export const methodRow = { background: C.paper2, border: `1px solid ${C.line}`, borderRadius: 8, padding: "14px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minWidth: 0 };
export const iconTile = { width: 28, height: 28, borderRadius: "50%", background: C.paper2, border: `1px solid ${C.line}`, color: C.ink2, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" };
export const flowBox = { marginTop: 14, padding: "16px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.paper };

export const fmtDate = (iso) => {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch { return ""; }
};
export const fmtDateTime = (iso) => {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};
// How the last sign-in was made (the bridge's auth_method), in plain words.
export const METHOD = {
  Passkey: "a passkey", Password: "your password", MagicAuth: "an email code",
  GoogleOAuth: "Google", MicrosoftOAuth: "Microsoft", GitHubOAuth: "GitHub", AppleOAuth: "Apple",
  SSO: "single sign-on", Impersonation: "the Attacked.ai team (support access)",
};
export const PROVIDER = { GoogleOAuth: "Google", MicrosoftOAuth: "Microsoft", GitHubOAuth: "GitHub", AppleOAuth: "Apple" };
export const providerName = (id) => PROVIDER[id] || String(id || "").replace(/OAuth$/, "") || "Account";
export const isOAuth = (m) => typeof m === "string" && /OAuth$/.test(m);
export const finePointer = () => { try { return window.matchMedia("(pointer: fine)").matches; } catch { return true; } };
