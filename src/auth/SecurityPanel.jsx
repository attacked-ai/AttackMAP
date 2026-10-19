// ─────────────────────────────────────────────────────────────────────────
// SecurityPanel — "Security" on the Profile page (?profile#security).
//
// Two-step verification: a 6-digit code from an authenticator app (Google
// Authenticator, Microsoft Authenticator, 1Password, …). Turned on here — scan
// a QR code, confirm one code — and WorkOS then asks for a code on its sign-in
// page. Turning it on or off needs a recent sign-in and a correct code.
// Passkeys are created on the WorkOS sign-in page itself (WorkOS has no API
// for them); this explains how, and shows when the last sign-in used one.
// The bridge (supabase/functions/workos-auth, /security routes) does the work;
// shown only with WorkOS sign-in switched on.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { WORKOS, securityApi, startHosted } from "../lib/workos";

const C = {
  paper: "#FFFFFF", paper2: "#FAFAFA", ink: "#101010", ink2: "#52525B", ink3: "#6A6A6A",
  line: "#E7E7E9", line2: "#CFCDC4", gold: "#FCBD00", goldDeep: "#8A6D00",
  obsidian: "#1A1A1A", err: "#C0341D", ok: "#1E7A3D", okBg: "#EAF6EE", warnBg: "#FFF7DD",
};
const FONT = "Inter, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const card = { marginTop: 22, background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "22px 24px" };
const h3 = { margin: "0 0 6px", fontSize: 15, fontWeight: 800, color: C.ink, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", outline: "none" };
const p = { margin: "0 0 12px", fontSize: 13.5, lineHeight: 1.6, color: C.ink2 };
const btn = (primary, disabled) => ({
  padding: "11px 18px", background: primary ? C.gold : "transparent", color: C.obsidian,
  border: primary ? "none" : `1px solid ${C.line2}`, borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  fontFamily: FONT, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
});
const pill = (on) => ({
  fontSize: 10.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 999,
  background: on ? C.okBg : "#F1F1F2", color: on ? C.ok : C.ink3,
});
const codeInput = { width: 150, padding: "11px 12px", border: `1px solid ${C.line2}`, borderRadius: 4, fontFamily: MONO, fontSize: 18, letterSpacing: "0.3em", textAlign: "center", color: C.ink, background: "#fff" };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; } };
const METHOD = { Passkey: "a passkey", Password: "your password", MagicAuth: "an email code", GoogleOAuth: "Google", MicrosoftOAuth: "Microsoft", SSO: "single sign-on" };
const finePointer = () => { try { return window.matchMedia("(pointer: fine)").matches; } catch { return true; } };

export function SecurityPanel() {
  const { tier, signOut } = useAuth();
  const [status, setStatus] = useState(null);      // { workos, totp: { on, since }, method, strong, recent }
  const [loadErr, setLoadErr] = useState(null);
  const [step, setStep] = useState("idle");        // idle | setup | remove
  const [setup, setSetup] = useState(null);        // { setup, secret, uri, qr }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(null);          // which action is running
  const [msg, setMsg] = useState(null);            // { ok, text, reauth }
  const [copy, setCopy] = useState(null);          // "ok" | "failed"
  const titleRef = useRef(null);

  const load = () => securityApi("").then((s) => { setStatus(s); setLoadErr(null); }).catch((e) => setLoadErr(e.message));
  useEffect(() => { if (WORKOS) load(); }, []);
  useEffect(() => {
    if (window.location.hash === "#security") setTimeout(() => document.getElementById("security")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  }, []);
  useEffect(() => { if (step !== "idle") titleRef.current?.focus(); }, [step]);

  const run = async (name, fn) => {
    setBusy(name); setMsg(null);
    try { await fn(); }
    catch (e) { setMsg({ ok: false, text: e.message, reauth: e.code === "reauth" || e.code === "no_workos" }); }
    finally { setBusy(null); }
  };
  const start = () => run("start", async () => { setSetup(await securityApi("/totp/start", {})); setCode(""); setCopy(null); setStep("setup"); });
  const confirm = (e) => { e.preventDefault(); run("confirm", async () => {
    await securityApi("/totp/confirm", { setup: setup.setup, code });
    setStatus((s) => ({ ...s, totp: { on: true, since: new Date().toISOString() } }));
    setStep("idle"); setSetup(null); setCode("");
    setMsg({ ok: true, text: "Two-step verification is on. Next time you sign in on the Attacked.ai sign-in page, it will ask for a code from your app." });
    load();
  }); };
  const remove = (e) => { e.preventDefault(); run("remove", async () => {
    await securityApi("/totp/remove", { code });
    setStatus((s) => ({ ...s, totp: { on: false, since: null } }));
    setStep("idle"); setCode("");
    setMsg({ ok: true, text: "Two-step verification is off." });
    load();
  }); };
  const cancel = () => { setStep("idle"); setSetup(null); setCode(""); setMsg(null); };
  const signInAgain = async () => {
    try { await signOut(); } catch { /* signed out anyway */ }
    try { await startHosted("sign-in", `${window.location.origin}/?profile#security`); }
    catch { window.location.href = "/?home"; }
  };
  const copyKey = async () => {
    try { await navigator.clipboard.writeText(setup.secret); setCopy("ok"); setTimeout(() => setCopy(null), 1500); }
    catch { setCopy("failed"); }
  };
  const on = !!status?.totp?.on;
  const digits = (v) => setCode(v.replace(/\D/g, "").slice(0, 6));
  if (!WORKOS) return null;

  return (
    <section id="security" aria-labelledby="security-h" style={{ scrollMarginTop: 90 }}>
      <h2 id="security-h" style={{ margin: "34px 0 0", fontSize: 17, fontWeight: 800, color: C.ink, letterSpacing: "-0.01em" }}>Security</h2>
      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: C.ink3 }}>Protect your account with a second step at sign-in.</p>

      {loadErr && (
        <div role="alert" style={{ ...card, background: C.warnBg, borderColor: "#F1DE9C", fontSize: 13, color: C.ink2, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 220px" }}>{loadErr}</span>
          <button type="button" style={btn(false)} onClick={() => { setLoadErr(null); load(); }}>Try again</button>
        </div>
      )}

      {/* Two-step verification */}
      <div style={card}>
        <h3 ref={titleRef} tabIndex={-1} style={h3}>Two-step verification {status && status.workos !== false && <span style={pill(on)}>{on ? "On" : "Off"}</span>}
          {status && status.workos !== false && !on && status.method !== "Passkey" && <span style={{ ...pill(false), background: C.warnBg, color: C.goldDeep }}>Recommended</span>}</h3>
        {!status && !loadErr && <p style={p}>Checking…</p>}

        {status && status.workos === false && (<>
          <p style={p}>To use two-step verification, sign in once with the Attacked.ai sign-in page. Then come back here to turn it on.</p>
          <button type="button" style={btn(true)} onClick={signInAgain}>Sign out and sign in again</button>
        </>)}

        {status && status.workos !== false && !on && step === "idle" && (<>
          <p style={p}>Adds a second step on the Attacked.ai sign-in page: a 6-digit code from an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password. A stolen password alone is then not enough to get in.</p>
          <p style={{ ...p, fontSize: 12.5, color: C.ink3 }}>It's optional, and you can turn it off here at any time. Keep the app on your phone. If you lose it, contact the Attacked.ai team and we will reset two-step verification after checking it's you.</p>
          <button type="button" style={btn(true, !!busy)} disabled={!!busy} onClick={start}>{busy === "start" ? "Starting…" : "Turn on two-step verification"}</button>
        </>)}

        {step === "setup" && setup && (
          <form onSubmit={confirm}>
            <p style={{ ...p, fontWeight: 600, color: C.ink }}>1. Add Attacked.ai to your authenticator app.</p>
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
              {setup.qr && <img src={setup.qr} alt="QR code that adds Attacked.ai to an authenticator app" width={168} height={168} style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: "#fff" }} />}
              <div style={{ flex: "1 1 220px", fontSize: 12.5, color: C.ink3, lineHeight: 1.6 }}>
                {setup.qr ? "Scan the code with the app. " : ""}On this phone? {setup.uri && <a href={setup.uri} style={{ color: C.goldDeep, fontWeight: 700 }}>Open in authenticator app</a>}{setup.uri ? ", or a" : "A"}dd an account by hand with this key:
                {setup.secret && (
                  <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <code style={{ fontFamily: MONO, fontSize: 13, color: C.ink, background: C.paper2, border: `1px solid ${C.line}`, padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{setup.secret}</code>
                    <button type="button" style={{ ...btn(false), padding: "6px 10px", fontSize: 10.5 }} onClick={copyKey}>{copy === "ok" ? "Copied" : "Copy"}</button>
                  </div>
                )}
                {copy === "failed" && <div style={{ marginTop: 4, color: C.err }}>Copy didn't work here: select the key and copy it.</div>}
              </div>
            </div>
            <label htmlFor="totp-code" style={{ ...p, display: "block", fontWeight: 600, color: C.ink }}>2. Type the 6-digit code the app shows.</label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input id="totp-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={(e) => digits(e.target.value)}
                style={codeInput} autoFocus={finePointer()} aria-invalid={msg && !msg.ok ? true : undefined} aria-describedby="security-msg" />
              <button type="submit" style={btn(true, !!busy || code.length !== 6)} disabled={!!busy || code.length !== 6}>{busy === "confirm" ? "Checking…" : "Confirm"}</button>
              <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={cancel}>Cancel</button>
            </div>
          </form>
        )}

        {status && on && step === "idle" && (<>
          <p style={p}>{status.totp.since ? `On since ${fmtDate(status.totp.since)}. ` : ""}When you sign in on the Attacked.ai sign-in page, it asks for a code from your authenticator app. Signing in with a passkey covers both steps.</p>
          <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={() => { setStep("remove"); setCode(""); setMsg(null); }}>Turn off</button>
        </>)}

        {step === "remove" && (
          <form onSubmit={remove}>
            <label htmlFor="totp-off" style={{ ...p, display: "block" }}>To turn two-step verification off, type the current code from your authenticator app.</label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input id="totp-off" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={(e) => digits(e.target.value)}
                style={codeInput} autoFocus={finePointer()} aria-invalid={msg && !msg.ok ? true : undefined} aria-describedby="security-msg" />
              <button type="submit" style={{ ...btn(false, !!busy || code.length !== 6), color: C.err, borderColor: C.err }} disabled={!!busy || code.length !== 6}>{busy === "remove" ? "Checking…" : "Turn off two-step"}</button>
              <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={cancel}>Keep it on</button>
            </div>
          </form>
        )}

        <div id="security-msg" role="status" aria-live="polite" style={{ marginTop: msg ? 12 : 0, fontSize: 13, fontWeight: 600, color: msg?.ok ? C.ok : C.err }}>
          {msg?.text || ""}
          {msg?.reauth && <div style={{ marginTop: 8 }}><button type="button" style={btn(true)} onClick={signInAgain}>Sign in again</button></div>}
        </div>
      </div>

      {/* Passkeys */}
      <div style={card}>
        <h3 style={h3}>Passkeys {status?.method === "Passkey" && <span style={pill(true)}>Used last time</span>}</h3>
        <p style={p}>Sign in with your fingerprint, face or phone instead of typing anything. A passkey can't be phished or reused, and it covers both steps of two-step verification on its own.</p>
        <p style={{ ...p, marginBottom: 0 }}>
          <strong style={{ color: C.ink }}>How to add one:</strong> if you sign in with your email and password, the Attacked.ai sign-in page offers to save a passkey on your device. You can also create one when you make an account. Signing in with Google, Microsoft or an email code doesn't offer one. Lost a device? Contact the Attacked.ai team to remove its passkey.
        </p>
      </div>

      {/* Last sign-in */}
      {status && status.method && (
        <div style={{ ...card, padding: "16px 24px", background: C.paper2 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink2 }}>
            <strong style={{ color: C.ink }}>Your last sign-in (any device): </strong>with {METHOD[status.method] || status.method}.
            {tier === "admin" && !on && status.method !== "Passkey" && (
              <div style={{ marginTop: 6, color: C.goldDeep, fontWeight: 600 }}>You are an admin: please turn on two-step verification or use a passkey. The admin console will soon require it.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
