// ─────────────────────────────────────────────────────────────────────────
// LoginCard — the "Login" card of Profile › Login and security.
//
// Rows: Email address (read-only) · Password (set or change, in-page form) ·
// Linked accounts (read-only: WorkOS has no unlink) · Last sign-in ·
// Signed-in devices (Supabase "sign out everywhere else"). All state and
// handlers live in SecurityPanel.jsx; this file only renders.
// ─────────────────────────────────────────────────────────────────────────
import React from "react";
import {
  C, card, h3, p, btn, pill, helper, rowLabel, readBox, subRow, field, focusGold, blurLine, linkBtn,
  codeInput, fmtDateTime, METHOD, providerName, isOAuth,
} from "./tokens";
import { IconTile, ProviderMark } from "./icons";

const rowText = { fontSize: 13.5, lineHeight: 1.6, color: C.ink2 };
const rowWrap = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "14px 0", borderTop: `1px solid ${C.line}` };

// A row: icon tile · label + text block · right-aligned action (full width on phones).
export function Row({ icon, label, children, action }) {
  return (
    <div className="sec-row" style={rowWrap}>
      {icon && <IconTile name={icon} />}
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={rowLabel}>{label}</div>
        <div style={rowText}>{children}</div>
      </div>
      {action}
    </div>
  );
}

// A row's action button: right-aligned on desktop, full width on phones (.sec-act).
export function ActBtn({ id, primary = false, disabled = false, danger = false, title, onClick, children }) {
  return (
    <button type="button" id={id} className="sec-act" title={title} disabled={disabled} onClick={onClick}
      style={{ ...btn(primary, disabled), marginLeft: "auto", flex: "0 0 auto", ...(danger ? { color: C.err, borderColor: C.err } : {}) }}>
      {children}
    </button>
  );
}

// Plain text under its visible label (no aria-label: not allowed on a bare div).
export function ReadBox({ value }) {
  return <div style={readBox}>{value}</div>;
}

// Linked accounts = every sign-in provider seen (login.methods, accumulated by
// the bridge at sign-in) ∪ WorkOS's identities list. "Linked" only when WorkOS
// lists it; otherwise "Used last time" / "Used before". No unlink exists.
export function LinkedList({ status, retry, onRetry }) {
  const login = status.login && typeof status.login === "object" ? status.login : {};
  const identities = Array.isArray(login.identities) ? login.identities : null;   // null = couldn't check
  const methods = Array.isArray(login.methods) ? login.methods : (status.method ? [status.method] : []);
  const linked = new Set((identities || []).map((i) => i && i.provider).filter(isOAuth));
  const used = methods.filter(isOAuth);
  const providers = [...new Set([...linked, ...used])];

  if (identities === null && used.length === 0) {
    return (
      <div style={{ color: C.goldDeep, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span>{retry === "busy" ? "Checking…" : "We couldn't check your linked accounts just now."}</span>
        {retry === null && <button type="button" style={{ ...btn(false), padding: "6px 10px", fontSize: 10.5 }} onClick={onRetry}>Try again</button>}
      </div>
    );
  }
  if (!providers.length) {
    return (<>
      <div>None. You sign in with your email, a code or a password.</div>
      <div style={{ ...helper, marginTop: 4 }}>Sign in with Google or Microsoft using this same email and it shows here.</div>
    </>);
  }
  return (<>
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
      {providers.map((id) => {
        const name = providerName(id);
        const last = id === status.method;
        return (
          <div key={id} style={subRow}>
            <ProviderMark name={name} />
            <span style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{name}</span>
            {linked.has(id)
              ? <><span style={pill(true)}>Linked</span>{last && <span style={{ fontSize: 12, color: C.ink3 }}>· used last time</span>}</>
              : <span style={pill(last)}>{last ? "Used last time" : "Used before"}</span>}
          </div>
        );
      })}
    </div>
    <div style={{ ...helper, marginTop: 8 }}>A linked account can't be removed on its own. You can always sign in with your email and password, or an email code, instead.</div>
  </>);
}

// The in-page "Set or change your password" form (POST /security/password).
export function PasswordForm({ form, setForm, needsCode, busy, msg, headingRef, onSave, onCancel, onSignInAgain }) {
  const { a, b, code, show } = form;
  const set = (k) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [k]: v })); };
  const setDigits = (e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setForm((f) => ({ ...f, code: v })); };
  const tooShort = a.length > 0 && a.length < 10;
  const mismatch = !tooShort && b.length > 0 && a !== b;
  const ready = a.length >= 10 && a === b && (!needsCode || code.length === 6);
  const local = tooShort ? "Use at least 10 characters." : mismatch ? "The two passwords don't match." : "";
  const errText = local || (msg && !msg.ok ? msg.text : "");
  return (
    <form onSubmit={onSave} style={{ margin: "0 0 14px", padding: "16px", border: `1px solid ${C.line}`, borderRadius: 8, background: C.paper2 }}>
      <h4 ref={headingRef} tabIndex={-1} style={{ ...p, margin: "0 0 2px", fontWeight: 600, color: C.ink, outline: "none" }}>Set or change your password</h4>
      <p style={{ ...helper, margin: "0 0 14px" }}>If you already have one, this replaces it.</p>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
          <label htmlFor="pw-new" style={rowLabel}>New password</label>
          <button type="button" aria-pressed={show} onClick={() => setForm((f) => ({ ...f, show: !f.show }))}
            style={{ ...linkBtn, fontSize: 12, padding: "4px 0" }}>{show ? "Hide" : "Show"}</button>
        </div>
        <input id="pw-new" type={show ? "text" : "password"} autoComplete="new-password" minLength={10} maxLength={128} value={a}
          onChange={set("a")} style={field} onFocus={focusGold} onBlur={blurLine} aria-describedby="pw-hint pw-status" />
        <div id="pw-hint" style={{ ...helper, marginTop: 6 }}>At least 10 characters. A few words together is easier to remember and harder to guess. Don't use your name, your email, or a password you use anywhere else.</div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="pw-again" style={rowLabel}>Type it again</label>
        <input id="pw-again" type={show ? "text" : "password"} autoComplete="new-password" minLength={10} maxLength={128} value={b}
          onChange={set("b")} style={field} onFocus={focusGold} onBlur={blurLine} aria-describedby="pw-status" />
      </div>

      {needsCode && (
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="pw-code" style={rowLabel}>Code from your authenticator app</label>
          <input id="pw-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={setDigits}
            style={codeInput} aria-invalid={msg && !msg.ok ? true : undefined} aria-describedby="pw-status" />
          <div style={{ ...helper, marginTop: 6 }}>Because two-step verification is on, we check a code before changing your password.</div>
        </div>
      )}

      <div id="pw-status" role="status" aria-live="polite" style={{ fontSize: 13, fontWeight: 600, color: C.err, marginBottom: errText ? 10 : 0 }}>
        {errText}
        {msg && !msg.ok && msg.reauth && <div style={{ marginTop: 8 }}><button type="button" style={btn(true)} onClick={onSignInAgain}>Sign in again</button></div>}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="submit" className="sec-pw-act" style={btn(true, !!busy || !ready)} disabled={!!busy || !ready}>{busy === "password" ? "Saving…" : "Save password"}</button>
        <button type="button" className="sec-pw-act" style={btn(false, !!busy)} disabled={!!busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function LoginCard({
  user, status, loading, noWorkos, v8, hasPassword, on, bridgeOff, disabledTitle, busy, step,
  pwForm, setPwForm, pwMsg, pwHeadingRef, retry, others,
  onOpenPassword, onSavePassword, onCancel, onRetry, onOthers, onOthersConfirm, onOthersCancel, onOthersNow, onSignInAgain,
}) {
  const email = (user && user.email) || "";
  const method = status ? status.method : null;
  const full = !!status && !noWorkos && v8;          // the new bridge answered: every row
  const othersMsg = others === "done" ? "Done. Other devices are signed out; this one stays signed in."
    : others === "error" ? "Couldn't reach the sign-in server. Try again in a minute." : "";
  const pwSaved = !!(pwMsg && pwMsg.ok && step !== "password");

  return (
    <div style={card}>
      <h3 style={h3}>Login</h3>

      {/* Email address — always shown */}
      <div style={{ padding: "8px 0 14px" }}>
        <div style={rowLabel}>Email address</div>
        <ReadBox value={email} />
        <div style={{ ...helper, marginTop: 6 }}>This is the address you sign in with. To change it, contact the Attacked.ai team.</div>
      </div>

      {/* Notice A — no WorkOS account yet */}
      {status && noWorkos && (
        <div style={{ ...rowWrap, display: "block" }}>
          <p style={p}>To manage your password, linked accounts and two-step verification, sign in once with the Attacked.ai sign-in page.</p>
          <button type="button" style={btn(true)} onClick={onSignInAgain}>Sign out and sign in again</button>
        </div>
      )}

      {/* Notice B — the bridge is still the old one (no signed_in_at key) */}
      {status && !noWorkos && !v8 && (
        <div style={{ ...rowWrap, display: "block" }}>
          <div style={helper}>Password and linked-account settings are being updated. Check back shortly.</div>
        </div>
      )}

      {/* Password */}
      {(loading || full) && (<>
        <Row icon="key" label="Password"
          action={!loading && step !== "password" && (
            <ActBtn id="sec-pw-btn" disabled={!!busy || bridgeOff} title={bridgeOff ? disabledTitle : undefined} onClick={onOpenPassword}>
              {hasPassword ? "Change password" : "Set password"}
            </ActBtn>
          )}>
          {loading ? "Checking…" : hasPassword
            ? <>You have a password.{method === "Password" ? " It was used at your last sign-in." : ""}</>
            : "Set one to sign in with your email and password as well as Google, Microsoft or an email code. A password is also what unlocks the passkey offer on the sign-in page."}
          {/* always mounted, so the live region exists before the text arrives */}
          <div role="status" aria-live="polite" style={{ marginTop: pwSaved ? 6 : 0, fontSize: 13, fontWeight: 600, color: C.ok }}>
            {pwSaved && (<>
              {pwMsg.text}{" "}
              <button type="button" style={{ ...linkBtn, ...(others === "busy" ? { opacity: 0.6, cursor: "wait" } : {}) }} disabled={others === "busy"} onClick={onOthersNow}>
                Think someone else knew the old one? Sign out everywhere else.
              </button>
            </>)}
          </div>
        </Row>
        {step === "password" && (
          <PasswordForm form={pwForm} setForm={setPwForm} needsCode={on} busy={busy} msg={pwMsg} headingRef={pwHeadingRef}
            onSave={onSavePassword} onCancel={onCancel} onSignInAgain={onSignInAgain} />
        )}
      </>)}

      {/* Linked accounts */}
      {(loading || full) && (
        <Row icon="link" label="Linked accounts">
          {loading ? "Checking…" : <LinkedList status={status} retry={retry} onRetry={onRetry} />}
        </Row>
      )}

      {/* Last sign-in */}
      {(loading || (status && !noWorkos && method)) && (
        <Row icon="clock" label="Last sign-in">
          {loading ? "Checking…" : (<>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>
              With {METHOD[method] || providerName(method)}{status.signed_in_at && fmtDateTime(status.signed_in_at) ? ` · ${fmtDateTime(status.signed_in_at)}` : ""}
            </div>
            <div style={helper}>Any device. Doesn't look right? Sign out everywhere else and turn on two-step verification.</div>
          </>)}
        </Row>
      )}

      {/* Signed-in devices — Supabase only, works without the bridge */}
      <Row icon="devices" label="Signed-in devices"
        action={others !== "confirm" && others !== "busy" && <ActBtn onClick={onOthers}>Sign out everywhere else</ActBtn>}>
        This one, plus any other browser or phone where you signed in.
        {others === "confirm" && (
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 220px" }}>This signs out every other browser and phone within the hour. This one stays signed in.</span>
            <button type="button" style={btn(true)} onClick={onOthersConfirm}>Sign out others</button>
            <button type="button" style={btn(false)} onClick={onOthersCancel}>Cancel</button>
          </div>
        )}
        {others === "busy" && <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: C.ink3 }}>Signing out…</div>}
        <div role="status" aria-live="polite" style={{ marginTop: othersMsg ? 6 : 0, fontSize: 13, fontWeight: 600, color: others === "done" ? C.ok : C.err }}>{othersMsg}</div>
      </Row>
    </div>
  );
}
