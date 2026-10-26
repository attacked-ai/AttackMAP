// ─────────────────────────────────────────────────────────────────────────
// LoginCard — the "Login" card of Profile › Login and security.
//
// Rows: Email address (read-only) · Password (set or change, in-page form) ·
// Linked accounts (read-only: WorkOS has no unlink) · Last sign-in ·
// Signed-in devices (one row per device from the bridge, "Sign out" on every
// other one, then Supabase's "sign out everywhere else"; the plain row stays
// while the bridge has no devices route). All state and handlers live in
// SecurityPanel.jsx; this file only renders.
// ─────────────────────────────────────────────────────────────────────────
import React from "react";
import {
  C, card, h3, p, btn, pill, helper, rowLabel, readBox, subRow, field, focusGold, blurLine, linkBtn,
  codeInput, fmtDate, fmtDateTime, fmtAgo, deviceName, deviceIcon, METHOD, providerName, isOAuth,
} from "./tokens";
import { IconTile, ProviderMark } from "./icons";

const rowText = { fontSize: 13.5, lineHeight: 1.6, color: C.ink2 };
const rowWrap = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "14px 0", borderTop: `1px solid ${C.line}` };

// A row: icon tile · label + text block · right-aligned action (full width on phones).
// labelId: the label can take focus (a list heading to land on after a row goes).
// top: the tile sits by the label, not centred on the whole block (rows that hold a list).
export function Row({ icon, label, labelId, top = false, children, action }) {
  return (
    <div className="sec-row" style={top ? { ...rowWrap, alignItems: "flex-start" } : rowWrap}>
      {icon && <IconTile name={icon} />}
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        {labelId
          ? <div id={labelId} tabIndex={-1} style={{ ...rowLabel, outline: "none" }}>{label}</div>
          : <div style={rowLabel}>{label}</div>}
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

// Signed-in devices = the reader's own sessions (GET /security/devices), one
// row each as the bridge names them ("Mac · Safari"), this one first and
// marked, every other one with its own "Sign out" (POST /security/devices/
// signout). The page never shows an address or the raw browser text. `lock`:
// "Sign out everywhere else" is running, so the row buttons wait for it.
const smallBtn = (primary, disabled) => ({ ...btn(primary, disabled), padding: "6px 10px", fontSize: 10.5 });
export function DevicesList({ devices, now, lock, onSignOut, onRetry, onSignInAgain }) {
  const { list, err, busyId, msg } = devices;
  // Always mounted, so the live region exists before the text arrives.
  const statusLine = (
    <div role="status" aria-live="polite" style={{ marginTop: msg ? 8 : 0, fontSize: 13, fontWeight: 600, color: msg && msg.ok ? C.ok : C.err }}>
      {msg ? msg.text : ""}
      {msg && !msg.ok && msg.reauth && <div style={{ marginTop: 8 }}><button type="button" style={btn(true)} onClick={onSignInAgain}>Sign in again</button></div>}
    </div>
  );
  if (err) {
    return (<>
      <div style={{ color: C.goldDeep, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
        <span>{err.reauth ? err.text : "We couldn't list your devices just now."}</span>
        {err.reauth
          ? <button type="button" style={smallBtn(true)} onClick={onSignInAgain}>Sign in again</button>
          : <button type="button" style={smallBtn(false)} onClick={onRetry}>Try again</button>}
      </div>
      {statusLine}
    </>);
  }
  if (!list) return (<><div style={{ marginTop: 6 }}>Checking…</div>{statusLine}</>);
  return (<>
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      {list.map((d) => {
        const name = deviceName(d);
        // For a screen reader: "Sign out Windows Chrome", no middle dot to announce.
        const spoken = (d.os || "Unknown device") + (d.browser && d.browser !== "Browser" ? ` ${d.browser}` : "");
        const ago = fmtAgo(d.last_active, now);
        const since = d.signed_in ? fmtDate(d.signed_in) : "";
        const busy = busyId === d.id;
        return (
          <div key={d.id} className="sec-row" style={subRow}>
            {/* tile and text stay together on one line; on phones only the button drops below */}
            <div style={{ display: "flex", gap: 12, alignItems: "center", flex: "1 1 180px", minWidth: 0 }}>
              <IconTile name={deviceIcon(d.os)} />
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>{name}</span>
                  {d.current && <span style={pill(true)}>This device</span>}
                </div>
                {(ago || since) && (
                  <div style={{ fontSize: 12, color: C.ink3, marginTop: 2 }}>
                    {ago ? `Last active ${ago}` : ""}{ago && since ? " · " : ""}{since ? `Signed in ${since}` : ""}
                  </div>
                )}
              </div>
            </div>
            {!d.current && (
              <button type="button" id={`sec-dev-${d.id}`} className="sec-act" aria-label={busy ? `Signing out ${spoken}` : `Sign out ${spoken}`} disabled={!!busyId || lock}
                onClick={() => onSignOut(d.id)}
                style={{ ...btn(false, !!busyId || lock), padding: "8px 12px", fontSize: 11, marginLeft: "auto", flex: "0 0 auto" }}>
                {busy ? "Signing out…" : "Sign out"}
              </button>
            )}
          </div>
        );
      })}
    </div>
    {list.length === 1 && <div style={{ ...helper, marginTop: 8 }}>No other browser or phone is signed in.</div>}
    {list.length === 0 && <div style={{ ...helper, marginTop: 8 }}>We couldn't tell which devices are signed in.</div>}
    {statusLine}
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
  pwForm, setPwForm, pwMsg, pwHeadingRef, retry, others, devices, now,
  onOpenPassword, onSavePassword, onCancel, onRetry, onOthers, onOthersConfirm, onOthersCancel, onOthersNow, onSignInAgain,
  onDeviceSignOut, onDevicesRetry,
}) {
  const email = (user && user.email) || "";
  const method = status ? status.method : null;
  const full = !!status && !noWorkos && v8;          // the new bridge answered: every row
  const othersMsg = others === "done" ? "Done. Other devices are signed out; this one stays signed in."
    : others === "error" ? "Couldn't reach the sign-in server. Try again in a minute." : "";
  const pwSaved = !!(pwMsg && pwMsg.ok && step !== "password");
  // Only this device in the list: nothing else to sign out, so the button goes.
  // It also stays away while the list refreshes right after "Sign out
  // everywhere else" has finished (no flash of the button under "Checking…").
  const showOthers = !(devices.list && devices.list.length === 1) && !(devices.list === null && !devices.err && others === "done");
  // A row's own Sign out is in flight: "Sign out everywhere else" waits for it.
  const othersLocked = others === "busy" || !!devices.busyId;
  // The "Sign out everywhere else" confirm, progress and result (both layouts).
  const othersFlow = (<>
    {others === "confirm" && (
      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 220px" }}>This signs out every other browser and phone within the hour. This one stays signed in.</span>
        <button type="button" style={btn(true, othersLocked)} disabled={othersLocked} onClick={onOthersConfirm}>Sign out others</button>
        <button type="button" style={btn(false)} onClick={onOthersCancel}>Cancel</button>
      </div>
    )}
    {others === "busy" && <div style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: C.ink3 }}>Signing out…</div>}
    <div role="status" aria-live="polite" style={{ marginTop: othersMsg ? 6 : 0, fontSize: 13, fontWeight: 600, color: others === "done" ? C.ok : C.err }}>{othersMsg}</div>
  </>);

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
              <button type="button" style={{ ...linkBtn, ...(othersLocked ? { opacity: 0.6, cursor: "wait" } : {}) }} disabled={othersLocked} onClick={onOthersNow}>
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
        <Row icon="link" label="Linked accounts" top>
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
            <div style={helper}>Any device. Doesn't look right? {devices.na ? "Sign out everywhere else" : "Check your signed-in devices below"} and turn on two-step verification.</div>
          </>)}
        </Row>
      )}

      {/* Signed-in devices. devices.na = the bridge has no devices route yet (or
          could not be asked): the plain Supabase-only row, exactly as before.
          Otherwise one row per device, then "Sign out everywhere else" at the
          bottom (left out once the list shows only this device). */}
      {devices.na ? (
        <Row icon="devices" label="Signed-in devices"
          action={others !== "confirm" && others !== "busy" && <ActBtn onClick={onOthers}>Sign out everywhere else</ActBtn>}>
          This one, plus any other browser or phone where you signed in.
          {othersFlow}
        </Row>
      ) : (
        <Row icon="devices" label="Signed-in devices" labelId="sec-dev-h" top>
          <div style={helper}>Every browser and phone where you are signed in.</div>
          <DevicesList devices={devices} now={now} lock={others === "busy"} onSignOut={onDeviceSignOut} onRetry={onDevicesRetry} onSignInAgain={onSignInAgain} />
          {showOthers && others !== "confirm" && others !== "busy" && (
            <div className="r-btnrow" style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" id="sec-others-btn" style={btn(false)} onClick={onOthers}>Sign out everywhere else</button>
            </div>
          )}
          {othersFlow}
        </Row>
      )}
    </div>
  );
}
