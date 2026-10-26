// ─────────────────────────────────────────────────────────────────────────
// SecurityPanel — "Login and security" on the Profile page (?profile#security).
//
// Two cards, after the shape of MongoDB's Login and Security page:
//   Login — email (read-only), password (set or change, in-page), linked
//           accounts (read-only: WorkOS has no unlink), last sign-in,
//           signed-in devices (one row per device, "Sign out" on every other
//           one, and Supabase's "sign out everywhere else" at the bottom).
//   Two-step verification — Passkey and Authenticator app rows, each with a
//           "Set up". Optional, never forced; switched off here at any time.
// The bridge (supabase/functions/workos-auth, /security routes) does the
// work. GET /security?full=1 is the only status request; the presence of its
// `signed_in_at` key tells the page the bridge is new enough (v8) for the
// password route and the linked-accounts list. The devices list follows the
// status (GET /security/devices); a bridge without that route (404 / 405)
// leaves the plain row in place. Shown only with WorkOS sign-in switched on.
// State and handlers live here; src/auth/security/ holds the tokens, icons
// and the two cards.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthProvider";
import { WORKOS, securityApi, startHosted } from "../lib/workos";
import { C, card, btn } from "./security/tokens";
import { LoginCard } from "./security/LoginCard";
import { TwoStepCard } from "./security/TwoStepCard";

const EMPTY_PW = { a: "", b: "", code: "", show: false };
// Signed-in devices: list (null while loading), err { text, reauth }, busyId
// (the row being signed out), msg { ok, text, reauth } under the list, na
// (the bridge has no devices route, or could not be asked: the plain row).
const NO_DEVICES = { list: null, err: null, busyId: null, msg: null, na: false };
// An older bridge answers GET /security/devices with 404 (no such route) or
// 405 (v8's router: GET is only for the exact /security path).
const noRoute = (e) => e.status === 404 || e.status === 405 || (e.status == null && /^(not found|method not allowed)$/i.test(e.message || ""));

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
  const [devices, setDevices] = useState(NO_DEVICES);
  const [now, setNow] = useState(() => Date.now()); // "Last active …" is read against this; ticks every minute while the list is up
  const devBusy = useRef(false);                   // one device sign-out at a time
  const devFocus = useRef(null);                   // after a row goes: id of the element to focus (next row's button, or the list heading)
  const titleRef = useRef(null);                   // the two-step card's h3
  const flowRef = useRef(null);                    // heading of the open flow (passkey panel, set-up form)
  const pwRef = useRef(null);                      // heading of the password form
  const trigger = useRef(null);                    // id of the row button that opened the current form or panel
  const othersBusy = useRef(false);                // one "sign out others" call at a time
  const booted = useRef(false);

  const load = () => securityApi("?full=1").then((s) => { setStatus(s); setLoadErr(null); return s; }).catch((e) => { setLoadErr({ text: e.message, reauth: e.code === "reauth" }); return null; });
  // The devices list, once the status has answered (so a dead or old bridge
  // costs one request, not two). A 404 / 405 means the bridge has no devices
  // route yet: the plain row stays. Reloaded by "Try again" and after a
  // successful "Sign out everywhere else".
  // keep: the rows stay in place while the list refreshes (after "Sign out
  // everywhere else", which has already trimmed them) instead of "Checking…".
  const loadDevices = ({ keep = false } = {}) => {
    setDevices((d) => (keep ? { ...d, err: null, na: false } : { ...NO_DEVICES }));
    return securityApi("/devices")
      .then((j) => {
        const rows = Array.isArray(j && j.devices) ? j.devices.filter((d) => d && typeof d.id === "string") : [];
        setNow(Date.now());
        setDevices((d) => ({ ...NO_DEVICES, msg: keep ? d.msg : null, list: [...rows.filter((x) => x.current), ...rows.filter((x) => !x.current)] }));   // this device first
      })
      .catch((e) => setDevices({ ...NO_DEVICES, na: noRoute(e), err: noRoute(e) ? null : { text: e.message, reauth: e.code === "reauth" } }));
  };
  // Status first, then the devices list when the bridge is new enough to have
  // it (a v8 status; the v7 one, and a failed status, leave the plain row).
  // The list needs no WorkOS account: the sessions are Supabase's.
  const boot = () => load().then((s) => {
    if (s && "signed_in_at" in s) loadDevices();
    else setDevices({ ...NO_DEVICES, na: true });
  });
  useEffect(() => { if (booted.current) return; booted.current = true; if (WORKOS) boot(); }, []);
  // A device row has gone (signed out): focus moves to the next row's button
  // or, with none left, to the list heading, never back to the top of the page.
  useEffect(() => {
    const id = devFocus.current; if (!id) return;
    devFocus.current = null;
    document.getElementById(id)?.focus();
  }, [devices.list]);
  // "Last active 2 minutes ago" keeps up on a page left open: a minute tick
  // while a list is shown (the current row is always "just now" anyway).
  const listUp = !!devices.list;
  useEffect(() => {
    if (!listUp) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [listUp]);
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
      if (!error && !devices.na) {
        // The other rows are gone now: show that at once (no "Checking…", no
        // button flashing back), then refresh the list behind it.
        setDevices((d) => ({ ...d, list: d.list ? d.list.filter((x) => x.current) : d.list, msg: null }));
        loadDevices({ keep: true });
      }
    } catch { setOthers("error"); }
    finally { othersBusy.current = false; }
  };
  // Ends one other device's session (POST /security/devices/signout). On
  // success the row goes and the message says the device may stay signed in
  // for up to an hour: the auth server refuses its token at once, but data
  // reads with the access token it already holds run until that expires. A
  // device the bridge no longer finds (not_found) is gone already, so its row
  // goes too.
  const signOutDevice = async (id) => {
    if (devBusy.current) return;   // one call per click
    devBusy.current = true;
    setDevices((d) => ({ ...d, busyId: id, msg: null }));
    const drop = (d, text, ok) => {
      if (d.list === null) return { ...d, busyId: null, msg: { ok, text } };   // the list is refreshing meanwhile: it will show what is true
      const old = d.list;
      const at = old.findIndex((x) => x.id === id);
      const list = old.filter((x) => x.id !== id);
      const after = list.slice(Math.max(at, 0)).find((x) => !x.current) || [...list].reverse().find((x) => !x.current);
      devFocus.current = after ? `sec-dev-${after.id}` : "sec-dev-h";
      return { ...d, list, busyId: null, msg: { ok, text } };
    };
    try {
      await securityApi("/devices/signout", { id });
      setDevices((d) => drop(d, "Signed out that device. It may stay signed in for up to an hour.", true));
    } catch (e) {
      if (e.code === "not_found") setDevices((d) => drop(d, e.message, false));
      else setDevices((d) => ({ ...d, busyId: null, msg: { ok: false, text: e.message, reauth: e.code === "reauth" } }));
    } finally { devBusy.current = false; }
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
            : <button type="button" style={btn(false)} onClick={() => { setLoadErr(null); boot(); }}>Try again</button>}
        </div>
      )}

      <LoginCard user={user} status={status} loading={loading} noWorkos={noWorkos} v8={v8} hasPassword={hasPassword} on={on}
        bridgeOff={bridgeOff} disabledTitle={disabledTitle} busy={busy} step={step}
        pwForm={pwForm} setPwForm={setPwForm} pwMsg={pwMsg} pwHeadingRef={pwRef} retry={retry} others={others} devices={devices} now={now}
        onOpenPassword={openPassword} onSavePassword={savePassword} onCancel={cancel} onRetry={retryLinked}
        onOthers={() => setOthers("confirm")} onOthersConfirm={signOutOthers} onOthersCancel={() => setOthers("idle")} onOthersNow={signOutOthers}
        onDeviceSignOut={signOutDevice} onDevicesRetry={() => loadDevices()} onSignInAgain={signInAgain} />

      <TwoStepCard status={status} loading={loading} noWorkos={noWorkos} on={on} bridgeOff={bridgeOff} disabledTitle={disabledTitle}
        busy={busy} step={step} setup={setup} code={code} copy={copy} msg={msg} passkeyInfo={passkeyInfo} hasPassword={hasPassword} tier={tier}
        titleRef={titleRef} flowRef={flowRef} onStart={start} onConfirm={confirm} onRemove={remove} onOpenRemove={openRemove} onCancel={cancel}
        onCopy={copyKey} onCode={digits} onTogglePasskey={togglePasskey} onTogglePasskeyInfo={() => setPasskeyInfo((v) => !v)} onSignInAgain={signInAgain} />
    </section>
  );
}
