// ─────────────────────────────────────────────────────────────────────────
// TwoStepCard — the "Two-step verification" card of Profile › Login and
// security: a grid of two method rows (Passkey first, then Authenticator
// app), the expanded flow under it (passkey explainer, set-up form, turn-off
// form), three footnotes, the live status line and the admin reminder.
// Nothing is forced: every row only offers "Set up". State and handlers
// live in SecurityPanel.jsx.
// ─────────────────────────────────────────────────────────────────────────
import React from "react";
import { C, MONO, card, h3, p, btn, pill, recPill, helper, codeInput, methodRow, flowBox, fmtDate, finePointer } from "./tokens";
import { Icon, IconTile } from "./icons";

const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 4 };
const infoBtn = (open) => ({
  width: 28, height: 28, padding: 0, border: "none", borderRadius: "50%", background: open ? C.warnBg : "transparent",
  color: open ? C.goldDeep : C.ink3, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
});

function MethodRow({ icon, name, pillEl, text, info, action, note }) {
  return (
    <div className="sec-row" style={methodRow}>
      <IconTile name={icon} />
      <strong style={{ fontSize: 13.5, color: C.ink }}>{name}</strong>
      {info}
      {pillEl}
      <div style={{ ...helper, flex: "1 1 100%" }}>{text}</div>
      {action}
      {note && <div id="passkey-note" style={{ ...helper, flex: "1 1 100%" }}>{note}</div>}
    </div>
  );
}

export function TwoStepCard({
  status, loading, noWorkos, on, bridgeOff, disabledTitle, busy, step, setup, code, copy, msg, passkeyInfo, hasPassword, tier,
  titleRef, flowRef, onStart, onConfirm, onRemove, onOpenRemove, onCancel, onCopy, onCode, onTogglePasskey, onTogglePasskeyInfo, onSignInAgain,
}) {
  const method = status ? status.method : null;
  const since = status && status.totp ? status.totp.since : null;
  // id: the panel returns focus to this button when its form or panel closes.
  const act = (id, primary, disabled, onClick, label, danger) => (
    <button type="button" id={id} className="sec-act" disabled={disabled} title={disabled && bridgeOff ? disabledTitle : undefined} onClick={onClick}
      style={{ ...btn(primary, disabled), marginLeft: "auto", flex: "0 0 auto", ...(danger ? { color: C.err, borderColor: C.err } : {}) }}>{label}</button>
  );

  return (
    <div style={card}>
      <h3 ref={titleRef} tabIndex={-1} style={h3}>
        Two-step verification
        {status && !noWorkos && <span style={pill(on)}>{on ? "On" : "Off"}</span>}
      </h3>
      <p style={p}>Optional. A second check on the Attacked.ai sign-in page, so a stolen password alone can't get in. Set-up takes about two minutes, and you can switch it off here at any time.</p>

      <div className="sec-grid" style={grid}>
        {/* Row A — Passkey (first, like MongoDB's Security Key/Biometric) */}
        <MethodRow icon="fingerprint" name="Passkey"
          info={<button type="button" className="sec-info" aria-label="About passkeys" aria-expanded={passkeyInfo} aria-controls="passkey-note" style={infoBtn(passkeyInfo)} onClick={onTogglePasskeyInfo}><Icon name="info" /></button>}
          pillEl={status ? (method === "Passkey" ? <span style={pill(true)}>Used last time</span> : <span style={recPill}>Recommended</span>) : null}
          text={loading ? "Checking…" : "Your fingerprint, face, phone or security key. Can't be phished, and it covers both steps on its own."}
          action={!loading && act("sec-passkey-btn", false, !!busy || bridgeOff, onTogglePasskey, step === "passkeyHelp" ? "Close" : "Set up")}
          note={passkeyInfo ? "Works on recent phones, laptops and browsers. A passkey saved on one device isn't automatically on another." : null} />

        {/* Row B — Authenticator app */}
        <MethodRow icon="phone" name="Authenticator app"
          pillEl={status ? (on ? <span style={pill(true)}>On</span> : <span style={recPill}>Recommended</span>) : null}
          text={loading ? "Checking…" : on
            ? `${since && fmtDate(since) ? `On since ${fmtDate(since)}. ` : ""}The Attacked.ai sign-in page asks for the code.`
            : "A 6-digit code from Google Authenticator, Microsoft Authenticator, 1Password or similar."}
          action={!loading && (on
            ? act("sec-totp-btn", false, !!busy || bridgeOff || step === "remove", onOpenRemove, "Turn off", true)
            : act("sec-totp-btn", true, !!busy || bridgeOff || step === "setup", onStart, busy === "start" ? "Starting…" : "Set up"))} />
      </div>

      {/* Passkey explainer */}
      {step === "passkeyHelp" && (
        <div style={flowBox}>
          <h4 ref={flowRef} tabIndex={-1} style={{ ...p, margin: "0 0 8px", fontWeight: 600, color: C.ink, outline: "none" }}>Add a passkey</h4>
          <ol style={{ margin: "0 0 10px", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.6, color: C.ink2 }}>
            <li style={!hasPassword ? { color: C.goldDeep, fontWeight: 600 } : undefined}>Set a password above if you don't have one yet — the sign-in page only offers a passkey after a password sign-in.</li>
            <li>Sign out, then sign in on the Attacked.ai sign-in page with your email and password.</li>
            <li>When it offers to create a passkey, say yes and follow your phone's or computer's prompt.</li>
          </ol>
          <p style={{ ...helper, margin: "0 0 14px" }}>Didn't see the offer? It comes back on a later sign-in. Lost a device? Contact the Attacked.ai team and we'll remove its passkey after checking it's you.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" style={btn(true)} onClick={onSignInAgain}>Sign out and open the sign-in page</button>
            <button type="button" style={btn(false)} onClick={onCancel}>Close</button>
          </div>
        </div>
      )}

      {/* Set-up form */}
      {step === "setup" && setup && (
        <form onSubmit={onConfirm} style={flowBox}>
          <p ref={flowRef} tabIndex={-1} style={{ ...p, fontWeight: 600, color: C.ink, outline: "none" }}>1. Add Attacked.ai to your authenticator app.</p>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            {setup.qr && <img src={setup.qr} alt="QR code that adds Attacked.ai to an authenticator app" width={168} height={168} style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: "#fff", maxWidth: "100%" }} />}
            <div style={{ flex: "1 1 220px", minWidth: 0, fontSize: 12.5, color: C.ink3, lineHeight: 1.6 }}>
              {setup.qr ? "Scan the code with the app. " : ""}On this phone? {setup.uri && <a href={setup.uri} style={{ color: C.goldDeep, fontWeight: 700 }}>Open in authenticator app</a>}{setup.uri ? ", or a" : "A"}dd an account by hand with this key:
              {setup.secret && (
                <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <code style={{ fontFamily: MONO, fontSize: 13, color: C.ink, background: C.paper2, border: `1px solid ${C.line}`, padding: "6px 8px", borderRadius: 4, wordBreak: "break-all" }}>{setup.secret}</code>
                  <button type="button" style={{ ...btn(false), padding: "6px 10px", fontSize: 10.5 }} onClick={onCopy}>{copy === "ok" ? "Copied" : "Copy"}</button>
                </div>
              )}
              {copy === "failed" && <div style={{ marginTop: 4, color: C.err }}>Copy didn't work here: select the key and copy it.</div>}
            </div>
          </div>
          <label htmlFor="totp-code" style={{ ...p, display: "block", fontWeight: 600, color: C.ink }}>2. Type the 6-digit code the app shows.</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input id="totp-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={(e) => onCode(e.target.value)}
              style={codeInput} autoFocus={finePointer()} aria-invalid={msg && !msg.ok ? true : undefined} aria-describedby="security-msg" />
            <button type="submit" style={btn(true, !!busy || code.length !== 6)} disabled={!!busy || code.length !== 6}>{busy === "confirm" ? "Checking…" : "Confirm"}</button>
            <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={onCancel}>Cancel</button>
          </div>
        </form>
      )}

      {/* Turn-off form */}
      {step === "remove" && (
        <form onSubmit={onRemove} style={flowBox}>
          <label htmlFor="totp-off" style={{ ...p, display: "block" }}>To turn two-step verification off, type the current code from your authenticator app.</label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input id="totp-off" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" value={code} onChange={(e) => onCode(e.target.value)}
              style={codeInput} autoFocus={finePointer()} aria-invalid={msg && !msg.ok ? true : undefined} aria-describedby="security-msg" />
            <button type="submit" style={{ ...btn(false, !!busy || code.length !== 6), color: C.err, borderColor: C.err }} disabled={!!busy || code.length !== 6}>{busy === "remove" ? "Checking…" : "Turn off two-step"}</button>
            <button type="button" style={btn(false, !!busy)} disabled={!!busy} onClick={onCancel}>Keep it on</button>
          </div>
        </form>
      )}

      {/* Footnotes */}
      <div style={{ ...helper, marginTop: 14, display: "grid", gap: 4 }}>
        <div>Tip: set up both. With a passkey and an authenticator app you can still get in if you lose one.</div>
        <div>We don't offer email or text-message codes as a second step: they're the easiest for an attacker to get hold of.</div>
        <div>Lost your phone? Contact the Attacked.ai team and we'll reset two-step verification after checking it's you.</div>
      </div>

      <div id="security-msg" role="status" aria-live="polite" style={{ marginTop: msg ? 12 : 0, fontSize: 13, fontWeight: 600, color: msg && msg.ok ? C.ok : C.err }}>
        {(msg && msg.text) || ""}
        {msg && msg.reauth && <div style={{ marginTop: 8 }}><button type="button" style={btn(true)} onClick={onSignInAgain}>Sign in again</button></div>}
      </div>

      {tier === "admin" && status && !on && method !== "Passkey" && (
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.6, color: C.goldDeep, fontWeight: 600 }}>You are an admin: please turn on two-step verification or use a passkey. The admin console will soon require it.</div>
      )}
    </div>
  );
}
