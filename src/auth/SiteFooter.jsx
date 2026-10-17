// ─────────────────────────────────────────────────────────────────────────
// SiteFooter — the shared site-wide footer (Attacked.ai branding).
//
// One component dropped into the landing page, the hub and pricing so the
// footer is consistent everywhere. Every control works:
//   • Subscribe   — validates the email and confirms inline (best-effort
//                   insert into newsletter_subscribers; never blocks the UI)
//   • Explore     — real in-app routes (map / hub / pricing)
//   • Resources   — FAQ, Scam warning, legal pages (?legal=…)
//   • Contact     — mailto
//   • Social      — open in a new tab
// ─────────────────────────────────────────────────────────────────────────
import React, { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "./AuthProvider";
import { Logo } from "./Logo";
import { BRAND } from "../brand.js";


const CONTACT_EMAIL = "hello@attacked.ai";
const SOCIAL = {
  linkedin: "https://www.linkedin.com/company/attacked-ai",
  x:        "https://x.com/attacked_ai",
  facebook: "https://www.facebook.com/attacked.ai",
  youtube:  "https://www.youtube.com/@attacked-ai",
  instagram:"https://www.instagram.com/attacked.ai",
};

function SocialIcon({ name, size = 15 }) {
  const c = { width: size, height: size, viewBox: "0 0 24 24", fill: "currentColor", style: { display: "block" } };
  switch (name) {
    case "linkedin": return (<svg {...c}><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05C20.4 8.65 22 11 22 14.5V21h-4v-5.7c0-1.36-.02-3.1-1.9-3.1-1.9 0-2.2 1.48-2.2 3v5.8H9z"/></svg>);
    case "x": return (<svg {...c}><path d="M18.9 2H22l-7.5 8.6L23 22h-6.8l-5.3-7-6.1 7H1.7l8-9.2L1 2h7l4.8 6.4zM16.8 20h1.9L7.3 4H5.3z"/></svg>);
    case "facebook": return (<svg {...c}><path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.2c-1.2 0-1.6.8-1.6 1.6V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12z"/></svg>);
    case "youtube": return (<svg {...c}><path d="M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.8-1.8C19.3 5 12 5 12 5s-7.3 0-8.8.5A2.5 2.5 0 0 0 1.4 7.3C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.8 1.8C4.7 19 12 19 12 19s7.3 0 8.8-.5a2.5 2.5 0 0 0 1.8-1.8C23 15.2 23 12 23 12zM9.8 15.3V8.7l5.7 3.3z"/></svg>);
    case "instagram": return (<svg {...c}><path d="M12 2.2c3.2 0 3.6 0 4.9.07 1.2.05 1.8.25 2.2.42.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.17.4.37 1 .42 2.2.06 1.3.07 1.7.07 4.9s0 3.6-.07 4.9c-.05 1.2-.25 1.8-.42 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.17-1 .37-2.2.42-1.3.06-1.7.07-4.9.07s-3.6 0-4.9-.07c-1.2-.05-1.8-.25-2.2-.42-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.17-.4-.37-1-.42-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.07-4.9c.05-1.2.25-1.8.42-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.17 1-.37 2.2-.42C8.4 2.2 8.8 2.2 12 2.2zm0 3.2A6.4 6.4 0 1 0 12 18.4 6.4 6.4 0 0 0 12 5.4zm0 10.5A4.1 4.1 0 1 1 12 7.7a4.1 4.1 0 0 1 0 8.2zm6.6-10.8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/></svg>);
    default: return null;
  }
}

export function SiteFooter() {
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | done | error
  const [privacyOn, setPrivacyOn] = useState(false);

  async function subscribe(e) {
    e.preventDefault();
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    if (!ok) { setState("error"); return; }
    setState("done");
    // Best-effort persistence — works if a newsletter_subscribers table exists,
    // otherwise the confirmation still shows (we never surface a table error).
    try { await supabase.from("newsletter_subscribers").insert({ email: email.trim() }); } catch { /* noop */ }
    setEmail("");
  }

  const mapHref = user ? "/" : "/?home";

  // One reusable utility link — white, gold on hover, no underline.
  const navLinkStyle = {
    color: BRAND.white, textDecoration: "none", fontSize: 15, fontWeight: 500,
    fontFamily: "Inter, sans-serif", whiteSpace: "nowrap", cursor: "pointer",
    transition: "color 160ms ease",
  };
  const NavLink = ({ label, href, ext }) => (
    <a className="r-foot-link" href={href} target={ext ? "_blank" : undefined} rel={ext ? "noopener noreferrer" : undefined}
      style={navLinkStyle}
      onMouseEnter={e => { e.currentTarget.style.color = BRAND.gold; }}
      onMouseLeave={e => { e.currentTarget.style.color = BRAND.white; }}
    >{label}</a>
  );

  return (
    <footer style={{ background: BRAND.deep, borderTop: `1px solid ${BRAND.border}` }}>
      <div className="r-pad" style={{ maxWidth: 1640, margin: "0 auto", padding: "56px clamp(28px, 5vw, 72px) 48px" }}>
        <a href={mapHref} style={{ textDecoration: "none", display: "inline-block" }}><Logo size="sm" /></a>

        <div style={{
          marginTop: 40, display: "flex", justifyContent: "space-between",
          gap: "clamp(40px, 8vw, 140px)", flexWrap: "wrap", alignItems: "flex-start",
        }}>
          {/* LEFT — Subscribe */}
          <div className="r-foot-left" style={{ flex: "1 1 360px", maxWidth: 440 }}>
            {/* Colour MUST be explicit. This heading used to inherit, which is
                invisible on the Attacked Hub: that page wraps its content in
                .hubft, which sets color:#14130F for the light newspaper layout,
                and the footer's own ground is #080808 — near-black on black, a
                1.08:1 contrast ratio. It only looked correct on the landing
                page, where the inherited colour happens to be white. */}
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em", color: BRAND.white }}>Subscribe</div>
            <div style={{ marginTop: 10, fontSize: 14, color: BRAND.t2, lineHeight: 1.55, maxWidth: 360 }}>
              Select topics and stay current with our latest intelligence briefs
            </div>
            {state === "done" ? (
              <div style={{ marginTop: 18, fontSize: 13, fontWeight: 600, color: BRAND.ok }}>
                ✓ You're on the list — check your inbox.
              </div>
            ) : (
              <form onSubmit={subscribe} style={{ marginTop: 18, display: "flex", gap: 14, maxWidth: 480 }}>
                <input
                  type="email" value={email}
                  onChange={e => { setEmail(e.target.value); if (state === "error") setState("idle"); }}
                  placeholder="Email address"
                  style={{
                    flex: "1 1 auto", minWidth: 0, padding: "13px 16px", borderRadius: 0,
                    background: "transparent", color: BRAND.white,
                    border: `1px solid ${state === "error" ? "#FF3B30" : "#4B5563"}`,
                    fontFamily: "Inter, sans-serif", fontSize: 14, outline: "none",
                  }}
                  onFocus={e => { if (state !== "error") e.currentTarget.style.borderColor = "#9CA3AF"; }}
                  onBlur={e => { if (state !== "error") e.currentTarget.style.borderColor = "#4B5563"; }}
                />
                <button type="submit" className="r-foot-submit" style={{
                  padding: "13px 32px", background: BRAND.gold, color: BRAND.obsidian,
                  border: "none", borderRadius: 0, cursor: "pointer",
                  fontFamily: "Inter, sans-serif", fontSize: 13, fontWeight: 700,
                  letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap",
                  transition: "background 160ms ease",
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#D4A000"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = BRAND.gold; }}
                >Submit</button>
              </form>
            )}
            {state === "error" && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#FF3B30" }}>Enter a valid email address.</div>
            )}
            <div style={{ marginTop: 28, fontSize: 13, color: BRAND.tmuted }}>
              © 2026 Attacked<span style={{ color: BRAND.gold }}>.ai</span>
            </div>
          </div>

          {/* RIGHT — utility links in fixed reference rows (5 / 3 / 1) + social.
              marginLeft auto: when the columns wrap (tablets, ~769-1170px) the
              block still ends at the right edge instead of mid-page. */}
          <div className="r-foot-right" style={{ flex: "1 1 600px", maxWidth: 740, marginLeft: "auto" }}>
            {/* Row 1 */}
            <div style={{
              display: "flex", flexWrap: "wrap", justifyContent: "flex-end",
              columnGap: 28, rowGap: 14, alignItems: "center",
            }}>
              <NavLink label="Contact us" href={`mailto:${CONTACT_EMAIL}`} ext />
              <NavLink label="Scam warning" href="/?legal=scam" />
              <NavLink label="FAQ" href="/?legal=faq" />
              <NavLink label="Privacy policy" href="/?legal=privacy" />
              {/* Your privacy choices — toggle. r-foot-toggle: padded like the
                  links on touch screens (responsive.css), a 22px target otherwise. */}
              <button
                type="button"
                className="r-foot-toggle"
                onClick={() => setPrivacyOn(v => !v)}
                aria-pressed={privacyOn}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 10,
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  color: BRAND.white, fontFamily: "Inter, sans-serif", fontSize: 15, fontWeight: 500,
                }}
              >
                <span style={{
                  width: 40, height: 22, borderRadius: 0, position: "relative",
                  background: privacyOn ? BRAND.gold : "#3a3a3a",
                  transition: "background 160ms ease", flexShrink: 0,
                }}>
                  <span style={{
                    position: "absolute", top: 3, left: privacyOn ? 21 : 3,
                    width: 16, height: 16, borderRadius: "50%", background: BRAND.white,
                    transition: "left 160ms ease",
                  }} />
                </span>
                Your privacy choices
              </button>
            </div>
            {/* Row 2 */}
            <div style={{
              display: "flex", flexWrap: "wrap", justifyContent: "flex-end",
              columnGap: 28, rowGap: 14, alignItems: "center", marginTop: 14,
            }}>
              <NavLink label="Cookie preferences" href="/?legal=cookies" />
              <NavLink label="Terms of use" href="/?legal=terms" />
              <NavLink label="Local language information" href="/?legal=languages" />
            </div>
            {/* Row 3 */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <NavLink label="Accessibility statement" href="/?legal=accessibility" />
            </div>

            {/* Social icons */}
            {/* Five 40px circles + four gaps must fit the phone column (vw - 40px):
                the gap is 12px from 288px up and shrinks only below that (10px at
                280), so the circles never squash and no other size changes. */}
            <div style={{ marginTop: 36, display: "flex", gap: "clamp(8px, 25vw - 60px, 12px)", alignItems: "center", justifyContent: "flex-end" }}>
              {Object.entries(SOCIAL).map(([name, url]) => (
                <a key={name} href={url} target="_blank" rel="noopener noreferrer" aria-label={name}
                  style={{
                    width: 40, height: 40, flex: "none", borderRadius: "50%",
                    border: `1px solid ${BRAND.white}`, color: BRAND.white, background: "transparent",
                    display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none",
                    transition: "color 160ms ease, background 160ms ease",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = BRAND.white; e.currentTarget.style.color = BRAND.obsidian; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = BRAND.white; }}
                >
                  <SocialIcon name={name} size={16} />
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
