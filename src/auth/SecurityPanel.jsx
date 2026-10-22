// ─────────────────────────────────────────────────────────────────────────
// SecurityPanel — "Login and security" on the Profile page (?profile#security).
//
// Two cards, after the shape of MongoDB's Login and Security page:
//   Login — email (read-only), password (set or change, in-page), linked
//           accounts (read-only: WorkOS has no unlink), last sign-in,
//           signed-in devices ("sign out everywhere else", Supabase only).
//   Two-step verification — Passkey and Authenticator app rows, each with a
//           "Set up". Optional, never forced; switched off here at any time.
// The bridge (supabase/functions/workos-auth, /security routes) does the
// work. GET /security?full=1 is the only status request; the presence of its
// `signed_in_at` key tells the page the bridge is new enough (v8) for the
// password route and the linked-accounts list. Shown only with WorkOS
// sign-in switched on. State and handlers live here; src/auth/security/
// holds the tokens, icons and the two cards.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { WORKOS, securityApi, startHosted } from "../lib/workos";
import { C, card, btn } from "./security/tokens";
import { LoginCard } from "./security/LoginCard";
import { TwoStepCard } from "./security/TwoStepCard";

const EMPTY_PW = { a: "", b: "", code: "", show: false };

export function SecurityPanel() {
  const { user, tier, signOut } = useAuth();
  const [status, setStatus] = useState(null);      // { workos, totp: { on, since }, method, strong, recent, signed_in_at?, password_set_at?, login? }
  const [loadErr, setLoadErr] = useState(null);    // { text, reauth }
  const [step, setStep] = useState("idle");        // idle | setup | remove | password | passkeyHelp
  const [setup, setSetup] = useState(null);        // { setup, secret, uri, qr }
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(null);          // which action is running
  const [msg, setMsg] = useState(null);            // { ok, text, reauth } — the two-step card's status line
  const [copy, setCopy] = useState(null);          // "ok" | "failed"
  const [pwForm, setPwForm] = useState(EMPTY_PW);  // { a, b, code, show }
  const [pwMsg, setPwMsg] = useState(null);        // { ok, text, reauth } — the password row
  const [others, setOthers] = useState("idle");    // idle | confirm | busy | done | error
  const [passkeyInfo, setPasskeyInfo] = useState(false);
  const [retry, setRetry] = useState(null);        // linked accounts "Try again": null | "busy" | "done"
  const titleRef = useRef(null);                   // the two-step card's h3
  const flowRef = useRef(null);                    // heading of the open flow (passkey panel, set-up form)
  const pwRef = useRef(null);                      // heading of the password form
  const trigger = useRef(null);                    // id of the row button that opened the current form or panel
  const othersBusy = useRef(false);                // one "sign out others" call at a time
  const booted = useRef(false);

  const load = () => securityApi("?full=1").then((s) => { setStatus(s); setLoadErr(null); }).catch((e) => setLoadErr({ text: e.message, reauth: e.code === "reauth" }));
  useEffect(() => { if (booted.current) return; booted.current = true; if (WORKOS) load(); }, []);
  useEffect(() => {
    if (window.location.hash === "#security") setTimeout(() => document.getElementById("security")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  }, []);
  // Opening a form or panel moves focus to its heading; closing it (Cancel,
  // Close, Save, Keep it on) returns focus to the row button that opened it,
  // so a keyboard reader is never dropped at the top of the document.
  useEffect(() => {
    if (step === "idle") {
      const id = trigger.current; trigger.current = null;
      if (id) document.getElementById(id)?.focus();
      return;
    }
    const el = (step === "password" ? pwRef.current : flowRef.current) || titleRef.current;
    el?.focus();
  }, [step]);
  const remember = () => { const a = document.activeElement; trigger.current = a && a.id ? a.id : null; };

  const loading = !status && !loadErr;
  const noWorkos = !!status && status.workos === false;
  const v8 = !!status && "signed_in_at" in status;                 // bridge ≥ 8: password route + linked accounts
  const hasPassword = !!(status && (status.password_set_at || status.method === "Password"));
  const on = !!(status && status.totp && status.totp.on);
  const bridgeOff = noWorkos || !!loadErr;                          // bridge-backed buttons render disabled
  const disabledTitle = noWorkos ? "Sign in with the Attacked.ai sign-in page first" : "Security settings couldn't be loaded. Try again above.";

  const run = async (name, fn, report = setMsg) => {
    setBusy(name); report(null);
    try { await fn(); }
    catch (e) {
      // Changed in another tab or device meanwhile: show what is true now.
      if (e.code === "state_changed") { setStep("idle"); setSetup(null); setCode(""); load(); }
      // Two-step was switched on elsewhere after this page loaded: the password
      // form stays open with what was typed and gains its code field.
      if (e.code === "code_required") { setStatus((s) => ({ ...s, totp: { ...(s && s.totp), on: true } })); load(); }
      report({ ok: false, text: e.message, reauth: e.code === "reauth" || e.code === "no_workos" });
    }
    finally { setBusy(null); }
  };
  const start = () => { remember(); run("start", async () => { setSetup(await securityApi("/totp/start", {})); setCode(""); setCopy(null); setStep("setup"); }); };
  const confirm = (e) => { e.preventDefault(); run("confirm", async () => {
    await securityApi("/totp/confirm", { setup: setup.setup, code });
    setStatus((s) => ({ ...s, totp: { ...(s && s.totp), on: true, since: new Date().toISOString() } }));
    setStep("idle"); setSetup(null); setCode("");
    setMsg({ ok: true, text: "Two-step verification is on. Next time you sign in on the Attacked.ai sign-in page, it will ask for a code from your app." });
    load();
  }); };
  const remove = (e) => { e.preventDefault(); run("remove", async () => {
    await securityApi("/totp/remove", { code });
    setStatus((s) => ({ ...s, totp: { ...(s && s.totp), on: false, since: null } }));
    setStep("idle"); setCode("");
    setMsg({ ok: true, text: "Two-step verification is off." });
    load();
  }); };
  const openRemove = () => { remember(); setStep("remove"); setSetup(null); setCode(""); setMsg(null); };
  const togglePasskey = () => { if (step !== "passkeyHelp") remember(); setSetup(null); setCode(""); setMsg(null); setStep((s) => (s === "passkeyHelp" ? "idle" : "passkeyHelp")); };
  const openPassword = () => { remember(); setSetup(null); setCode(""); setMsg(null); setPwForm(EMPTY_PW); setPwMsg(null); setStep("password"); };
  const cancel = () => {
    if (step === "password") { setPwForm(EMPTY_PW); setPwMsg(null); }
    else { setSetup(null); setCode(""); setMsg(null); }
    setStep("idle");
  };
  const savePassword = (e) => {
    e.preventDefault();
    const { a, b, code: c } = pwForm;
    if (a.length < 10) { setPwMsg({ ok: false, text: "Use at least 10 characters." }); return; }
    if (a !== b) { setPwMsg({ ok: false, text: "The two passwords don't match." }); return; }
    run("password", async () => {
      await securityApi("/password", { password: a, ...(on ? { code: c } : {}) });
      setStatus((s) => ({ ...s, password_set_at: new Date().toISOString() }));
      setStep("idle"); setPwForm(EMPTY_PW);
      setPwMsg({ ok: true, text: "Password saved. Use it with your email on the Attacked.ai sign-in page." });
      load();
    }, setPwMsg);
  };
  // Supabase ends every other session for this reader and keeps this one.
  // No SIGNED_OUT event fires for scope "others": only the result counts.
  const signOutOthers = async () => {
    if (othersBusy.current) return;   // one call per click, however quickly a second click follows
    othersBusy.current = true; setOthers("busy");
    try {
      const { supabase } = await import("../lib/supabaseClient");
      const { error } = await supabase.auth.signOut({ scope: "others" });
      setOthers(error ? "error" : "done");
    } catch { setOthers("error"); }
    finally { othersBusy.current = false; }
  };
  const retryLinked = () => { setRetry("busy"); load().finally(() => setRetry("done")); };
  const signInAgain = async () => {
    try { await signOut(); } catch { /* signed out anyway */ }
    try { await startHosted("sign-in", `${window.location.origin}/?profile#security`); }
    catch { window.location.href = "/?home"; }
  };
  const copyKey = async () => {
    try { await navigator.clipboard.writeText(setup.secret); setCopy("ok"); setTimeout(() => setCopy(null), 1500); }
    catch { setCopy("failed"); }
  };
  const digits = (v) => setCode(v.replace(/\D/g, "").slice(0, 6));
  if (!WORKOS) return null;

  return (
    <section id="security" aria-labelledby="security-h" style={{ scrollMarginTop: 90 }}>
      <h2 id="security-h" style={{ margin: "34px 0 0", fontSize: 17, fontWeight: 800, color: C.ink, letterSpacing: "-0.01em" }}>Login and security</h2>
      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: C.ink3 }}>Protect your Attacked.ai account with our security measures.</p>

      {loadErr && (
        <div role="alert" style={{ ...card, background: C.warnBg, borderColor: "#F1DE9C", fontSize: 13, color: C.ink2, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 220px" }}>{loadErr.text}</span>
          {loadErr.reauth
            ? <button type="button" style={btn(true)} onClick={signInAgain}>Sign in again</button>
            : <button type="button" style={btn(false)} onClick={() => { setLoadErr(null); load(); }}>Try again</button>}
        </div>
      )}

      <LoginCard user={user} status={status} loading={loading} noWorkos={noWorkos} v8={v8} hasPassword={hasPassword} on={on}
        bridgeOff={bridgeOff} disabledTitle={disabledTitle} busy={busy} step={step}
        pwForm={pwForm} setPwForm={setPwForm} pwMsg={pwMsg} pwHeadingRef={pwRef} retry={retry} others={others}
        onOpenPassword={openPassword} onSavePassword={savePassword} onCancel={cancel} onRetry={retryLinked}
        onOthers={() => setOthers("confirm")} onOthersConfirm={signOutOthers} onOthersCancel={() => setOthers("idle")} onOthersNow={signOutOthers}
        onSignInAgain={signInAgain} />

      <TwoStepCard status={status} loading={loading} noWorkos={noWorkos} on={on} bridgeOff={bridgeOff} disabledTitle={disabledTitle}
        busy={busy} step={step} setup={setup} code={code} copy={copy} msg={msg} passkeyInfo={passkeyInfo} hasPassword={hasPassword} tier={tier}
        titleRef={titleRef} flowRef={flowRef} onStart={start} onConfirm={confirm} onRemove={remove} onOpenRemove={openRemove} onCancel={cancel}
        onCopy={copyKey} onCode={digits} onTogglePasskey={togglePasskey} onTogglePasskeyInfo={() => setPasskeyInfo((v) => !v)} onSignInAgain={signInAgain} />
    </section>
  );
}
