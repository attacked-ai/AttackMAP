// ─────────────────────────────────────────────────────────────────────────
// SignUpPage — /?signup: create an account with every question on one page
// (owner, 2026-10-22: name, email, job title, company and industry together,
// and nothing more to answer after the code).
//
// It looks like the WorkOS-hosted page it replaces (same two columns, same
// left panel as the AuthKit branding, authkit-panel/), because WorkOS's hosted
// sign-up can only ask for a name and an email. WorkOS still proves the
// address: Continue asks the bridge for a WorkOS email code (WorkOS emails
// it), the reader types it here and the bridge opens the Supabase session
// (supabase/functions/workos-auth: /email/start, /email/verify). Google and
// Microsoft go there directly (/start?provider=…) with the answers kept for
// that trip only; AuthProvider saves them on the way back.
//
// Sign-in stays on the WorkOS-hosted page ("Already have an account?"), and
// so does any account the bridge says must finish there (two-step
// verification on: code "use_hosted"). The answers ride along. A bridge that
// does not offer these routes (an older one, or BRIDGE_SIGNUP_FORM=off: its
// /providers has no signup_form: true) gets the answers kept and the reader
// sent to WorkOS's hosted sign-up instead, so nothing is asked twice.
//
// The answers fill an empty profile only (src/lib/signupAnswers.js); the
// first save stamps onboarded_at, which sends the welcome email.
// ─────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from "react";
import "../styles/signup.css";
import { useAuth } from "./AuthProvider";
import { supabase } from "../lib/supabaseClient";
import { SECTORS, ROLES } from "../lib/taxonomy";
import { bridgeInfo, clearPending, emailStart, emailVerify, startHosted, startProvider } from "../lib/workos";
import { applySignupAnswers } from "../lib/signupAnswers";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_WAIT_S = 30;

const GOOGLE = (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.5 2.9-2.2 5.4-4.7 7.1l7.3 5.7c4.3-3.9 7.2-9.8 7.2-16.8z" />
    <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.6 10.7l7.9-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.1 1.4-4.9 2.3-8.6 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
  </svg>
);
const MICROSOFT = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect x="2" y="2" width="9" height="9" fill="#F25022" /><rect x="13" y="2" width="9" height="9" fill="#7FBA00" />
    <rect x="2" y="13" width="9" height="9" fill="#00A4EF" /><rect x="13" y="13" width="9" height="9" fill="#FFB900" />
  </svg>
);
// [the id startProvider takes, the bridge's name for it, label, mark]
const OAUTH = [["google", "GoogleOAuth", "Google", GOOGLE], ["azure", "MicrosoftOAuth", "Microsoft", MICROSOFT]];

// The dark left panel: the WorkOS sign-up page's own (authkit-panel/signup.html).
const NODES = [[269, 166, "Supplier"], [96, 250, "Customer"], [345, 310, "Customer"], [40, 120, "Peer"], [400, 128, "Peer"]];
function Panel() {
  return (
    <div className="ap">
      <div className="ap-top"><img className="ap-logo" src="/attacked-ai-logo.svg" alt="" /><span className="ap-mark">Attacked<span>.ai</span></span></div>
      <div className="ap-art">
        <div className="ap-rings">
          <div className="ap-ring ap-r3" /><div className="ap-ring ap-r2" /><div className="ap-ring ap-r1" />
          <div className="ap-wave" /><div className="ap-wave w2" /><div className="ap-wave w3" />
          <div className="ap-core" />
          <span className="ap-tag c" style={{ left: "50%", top: "50%" }}>Incident</span>
          {NODES.map(([x, y, t], i) => (
            <React.Fragment key={i}>
              <div className="ap-node" style={{ left: x, top: y }} />
              <span className="ap-tag" style={{ left: x, top: y }}>{t}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="ap-body">
        <div className="ap-rule" />
        <h2 className="ap-title">One incident.<br /><span>Many companies.</span></h2>
        <p className="ap-copy">Create a free account to see who every incident reaches next, from suppliers to customers and peers, with a daily brief in your inbox.</p>
        <p className="ap-for">Free for risk, security and supply-chain teams</p>
      </div>
    </div>
  );
}

const query = () => { try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); } };

export function SignUpPage() {
  const { user, loading } = useAuth();
  // Subscribe while signed out → back to the subscription page to finish it.
  const subscribe = query().get("intent") === "subscribe";
  const back = `${window.location.origin}/${subscribe ? "?subscribe&activate=subscriber" : "?dashboard"}`;

  const [step, setStep] = useState("form");        // "form" | "code" | "away" (off to WorkOS)
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [company, setCompany] = useState("");
  const [industry, setIndustry] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);         // false | "continue" | "verify" | "resend" | "signin" | a provider id
  const [error, setError] = useState(null);
  const [invalid, setInvalid] = useState(null);    // the field the error is about
  const [note, setNote] = useState(null);
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [info, setInfo] = useState(null);          // the bridge's /providers answer; null = not known yet
  const signingUp = useRef(false);
  const cleanEmail = email.trim().toLowerCase();

  // Opened while signed in: there is nothing to create. (Not when the
  // session is the one this page just opened.)
  useEffect(() => {
    if (!loading && user && !signingUp.current) window.location.replace(back);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    bridgeInfo().then((j) => { if (live) setInfo(j); });
    return () => { live = false; };
  }, []);

  // The "Resend code in 24s" countdown.
  useEffect(() => {
    if (step !== "code") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  // Back from WorkOS or a provider with the browser's back button: the page
  // can come back exactly as it was left ("Taking you to…"). Make it usable.
  // After a finished sign-up the page is not left in history (replace), but
  // if the browser still restores it, go on to where the reader was going.
  useEffect(() => {
    const onShow = (e) => {
      if (!e.persisted) return;
      if (signingUp.current) { window.location.replace(back); return; }
      setBusy(false); setNote(null); setStep((s) => (s === "away" ? "form" : s));
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const oauth = OAUTH.filter(([, id]) => !info || info.providers.includes(id));
  const wait = Math.max(0, Math.ceil((sentAt + RESEND_WAIT_S * 1000 - now) / 1000));
  const inv = (id) => (invalid === id ? "true" : undefined);
  const described = (id) => (invalid === id ? "su-err" : undefined);

  function answers() {
    const a = { role: jobTitle || null, company: company.trim() || null, industry: industry || null, marketing_opt_in: consent };
    if (firstName.trim()) a.first_name = firstName.trim();
    if (lastName.trim()) a.last_name = lastName.trim();
    return a;
  }

  function fail(id, message) {
    setError(message);
    setInvalid(id);
    setTimeout(() => document.getElementById(id)?.focus(), 0);
  }
  // [field, answered?, message] in the order they appear; the first gap wins.
  function complete(checks) {
    for (const [id, ok, message] of checks) if (!ok) { fail(id, message); return false; }
    return true;
  }
  function clear() { setError(null); setInvalid(null); setNote(null); }
  // Typing into the field an error is about clears that error.
  const edit = (id, set) => (e) => { set(e.target.value); if (invalid === id) { setError(null); setInvalid(null); } };
  const workTyped = () => !!(jobTitle || company.trim() || industry);

  // The bridge's answer, asked again if the first try had not come back.
  async function bridge() {
    if (info) return info;
    const j = await bridgeInfo();
    setInfo(j);
    return j;
  }

  // The bridge does not offer the sign-up page's own routes: sign up on
  // WorkOS's hosted page, answers kept for the way back. Not when WorkOS's
  // page just sent the reader here (its "Sign up" link can point at this
  // page): that would go round in circles.
  async function hostedSignup() {
    const fromWorkOS = /\.authkit\.app|workos\.com/i.test(document.referrer || "");
    if (fromWorkOS) { setError("Sign-up isn't available right now. Please try again in a few minutes."); setBusy(false); return; }
    setStep("away"); setBusy("signin");
    setNote("Sign-up continues on the secure WorkOS page. Your answers are saved for when you come back.");
    try { await startHosted("sign-up", back, undefined, EMAIL.test(cleanEmail) ? cleanEmail : undefined, answers()); }
    catch (err) { setStep("form"); setNote(null); setError(err?.message || "Sign-up is unavailable right now."); setBusy(false); }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    clear();
    if (!complete([
      ["su-first", !!firstName.trim(), "Enter your first name."],
      ["su-email", EMAIL.test(cleanEmail) && cleanEmail.length <= 254, "Enter a valid email address."],
      ["su-role", !!jobTitle, "Choose your job title."],
      ["su-company", !!company.trim(), "Enter your company."],
      ["su-industry", !!industry, "Choose your industry. It decides what your dashboard and daily brief lead with."],
    ])) return;
    setBusy("continue");
    if ((await bridge())?.signup_form !== true) { await hostedSignup(); return; }
    try {
      await emailStart(cleanEmail);
      setCode(""); setSentAt(Date.now()); setNow(Date.now()); setStep("code");
    } catch (err) {
      setError(err?.message || "We could not send a code. Try again in a minute.");
    } finally { setBusy((b) => (b === "continue" ? false : b)); }
  }

  async function verify(e) {
    e.preventDefault();
    if (busy) return;
    clear();
    if (code.length !== 6) { fail("su-code", "Enter the 6-digit code from the email."); return; }
    setBusy("verify");
    signingUp.current = true;
    try {
      const t = await emailVerify(cleanEmail, code, { first_name: firstName.trim(), last_name: lastName.trim() });
      const { data, error: otpErr } = await supabase.auth.verifyOtp({ token_hash: t.token_hash, type: t.type });
      if (otpErr) throw Object.assign(new Error("We couldn't finish signing you in. Ask for a new code, then try again."), { cause: otpErr });
      // A save that fails is repaired from the account on the dashboard.
      await applySignupAnswers(data?.user || data?.session?.user, answers());
      clearPending();
      window.location.replace(back);   // not left in history: Back must not return to the code
    } catch (err) {
      signingUp.current = false;
      if (err?.code === "use_hosted") { await toHosted(err.reason); return; }
      setError(err?.message || "That code didn't work. Check it and try again.");
      setInvalid("su-code");
      setBusy(false);
    }
  }

  // Two-step verification on (or WorkOS needs its own page): sign in on the
  // WorkOS-hosted page, address filled in, answers kept for the way back.
  async function toHosted(reason) {
    setStep("away"); setBusy("signin");
    setNote(reason === "two_step"
      ? "This address already has an account with two-step verification, so it signs in on the secure sign-in page. Taking you there…"
      : "To finish, sign in on the secure sign-in page. It will email you a fresh code; your answers are saved. Taking you there…");
    try { await startHosted("sign-in", back, undefined, cleanEmail, answers()); }
    catch (err) { setStep("form"); setNote(null); setError(err?.message || "Sign-in is unavailable right now."); setBusy(false); }
  }

  async function resend() {
    if (busy || wait > 0) return;
    clear();
    setBusy("resend");
    try {
      await emailStart(cleanEmail);
      setCode(""); setSentAt(Date.now()); setNow(Date.now());
      setNote("A new code is on its way. Use the newest email: each new code replaces the one before.");
    } catch (err) {
      setError(err?.message || "We could not send a new code. Try again in a minute.");
    } finally { setBusy(false); }
  }

  // Google / Microsoft: the name and the address come from that account; the
  // work questions are answered here first and kept for the trip.
  async function social(id, label) {
    if (busy) return;
    clear();
    if (!complete([
      ["su-role", !!jobTitle, `Choose your job title first, then continue with ${label}.`],
      ["su-company", !!company.trim(), `Enter your company first, then continue with ${label}.`],
      ["su-industry", !!industry, `Choose your industry first, then continue with ${label}.`],
    ])) return;
    setBusy(id);
    if ((await bridge())?.signup_form !== true) { await hostedSignup(); return; }
    try { startProvider(id, back, answers()); }   // the browser is leaving for the provider
    catch (err) { setError(err?.message || `Could not continue with ${label}.`); setBusy(false); }
  }

  // Answers already typed go along (saved only if that sign-in makes a new account's profile).
  async function signIn() {
    if (busy) return;
    clear();
    setBusy("signin");
    try { await startHosted("sign-in", back, undefined, EMAIL.test(cleanEmail) ? cleanEmail : undefined, workTyped() ? answers() : null); }
    catch (err) { setError(err?.message || "Sign-in is unavailable right now."); setBusy(false); }
  }

  const errorBox = error && <div className="su-error" role="alert" id="su-err">{error}</div>;
  const agreement = <>By creating an account, you agree to the <a href="/?legal=terms">Terms of Service</a> and <a href="/?legal=privacy">Privacy Policy</a></>;
  const noteBox = note && <div className="su-note" role="status">{note}</div>;

  const form = (
    <>
      <form onSubmit={submit} noValidate>
        {errorBox}
        <div className="su-row">
          <div className="su-field">
            <label className="su-label" htmlFor="su-first">First name</label>
            <input id="su-first" className="su-input" type="text" placeholder="Your first name" autoComplete="given-name" maxLength={100} autoFocus
              value={firstName} onChange={edit("su-first", setFirstName)} aria-invalid={inv("su-first")} aria-describedby={described("su-first")} />
          </div>
          <div className="su-field">
            <label className="su-label" htmlFor="su-last">Surname</label>
            <input id="su-last" className="su-input" type="text" placeholder="Your surname" autoComplete="family-name" maxLength={100}
              value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>
        <div className="su-field">
          <label className="su-label" htmlFor="su-email">Email</label>
          <input id="su-email" className="su-input" type="email" inputMode="email" placeholder="Your email address" autoComplete="email" maxLength={254}
            value={email} onChange={edit("su-email", setEmail)} aria-invalid={inv("su-email")} aria-describedby={described("su-email")} />
        </div>
        <div className="su-row">
          <div className="su-field">
            <label className="su-label" htmlFor="su-role">Job title</label>
            <select id="su-role" className={`su-select${jobTitle ? "" : " su-empty"}`} value={jobTitle}
              onChange={edit("su-role", setJobTitle)} aria-invalid={inv("su-role")} aria-describedby={described("su-role")}>
              <option value="" disabled>Select</option>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="su-field">
            <label className="su-label" htmlFor="su-company">Company</label>
            <input id="su-company" className="su-input" type="text" placeholder="Your organisation" autoComplete="organization" maxLength={200}
              value={company} onChange={edit("su-company", setCompany)} aria-invalid={inv("su-company")} aria-describedby={described("su-company")} />
          </div>
        </div>
        <div className="su-field">
          <label className="su-label" htmlFor="su-industry">Industry</label>
          <select id="su-industry" className={`su-select${industry ? "" : " su-empty"}`} value={industry}
            onChange={edit("su-industry", setIndustry)} aria-invalid={inv("su-industry")} aria-describedby={described("su-industry")}>
            <option value="" disabled>Select your industry</option>
            {SECTORS.map(([sector, list]) => (
              <optgroup key={sector} label={sector}>
                {list.map((i) => <option key={i} value={i}>{i}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <label className="su-check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>Occasional emails about Attacked.ai, including account notifications. Unsubscribe any time.</span>
        </label>
        <button className="su-btn" type="submit" disabled={!!busy}>{busy === "continue" ? "Sending your code…" : "Continue"}</button>
      </form>
      {oauth.length > 0 && (
        <>
          <div className="su-or">OR</div>
          {oauth.map(([id, , label, mark]) => (
            <button key={id} type="button" className="su-oauth" disabled={!!busy} onClick={() => social(id, label)}>
              {mark}{busy === id ? `Opening ${label}…` : `Continue with ${label}`}
            </button>
          ))}
          <p className="su-hint">Name and email come from that account; job title, company and industry from above.</p>
        </>
      )}
      <p className="su-alt">Already have an account?{" "}
        <button type="button" className="su-link" onClick={signIn} disabled={!!busy}>{busy === "signin" ? "Opening…" : "Sign in"}</button>
      </p>
      <p className="su-agree">{agreement}</p>
    </>
  );

  const codeForm = (
    <>
      <form onSubmit={verify} noValidate>
        <p className="su-lead">We sent a 6-digit code to <b>{cleanEmail}</b>. Enter it below to create your account. It expires in 10 minutes.</p>
        {noteBox}
        {errorBox}
        <div className="su-field">
          <label className="su-label" htmlFor="su-code">Code</label>
          <input id="su-code" className="su-input su-code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus
            value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); if (invalid === "su-code") { setError(null); setInvalid(null); } }} aria-invalid={inv("su-code")} aria-describedby={described("su-code")} />
        </div>
        <button className="su-btn" type="submit" disabled={!!busy}>{busy === "verify" ? "Creating your account…" : "Create account"}</button>
      </form>
      <div className="su-actions">
        <button type="button" className="su-link" onClick={resend} disabled={!!busy || wait > 0}>
          {busy === "resend" ? "Sending…" : wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
        </button>
        <button type="button" className="su-link" disabled={!!busy} onClick={() => { clear(); setCode(""); setStep("form"); }}>Use a different email</button>
      </div>
      <p className="su-small">Can't find it? Check your spam or promotions folder.</p>
    </>
  );

  return (
    <div className="su">
      <aside className="su-panel" aria-hidden="true"><Panel /></aside>
      <main className="su-main">
        <a className="su-brand" href="/?home"><img src="/attacked-ai-logo-ink.png" alt="" /><span>Attacked<span>.ai</span></span></a>
        <a className="su-icon" href="/?home" aria-label="Attacked.ai home"><img src="/attacked-ai-logo-ink.png" alt="" /></a>
        <h1 className="su-h1">{step === "code" ? "Check your email" : "Create your Attacked.ai account"}</h1>
        <div className="su-card">
          {step === "code" ? codeForm : step === "away" ? <div>{noteBox}{errorBox}</div> : form}
        </div>
        {step !== "form" && <p className="su-legal">{agreement}</p>}
      </main>
    </div>
  );
}
