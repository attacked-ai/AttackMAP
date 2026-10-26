// ─────────────────────────────────────────────────────────────────────────
// Inline 16px SVG icons for the "Login and security" section (no icon
// library in this app) and neutral provider monograms (no vendor logos).
// All decorative: aria-hidden.
// ─────────────────────────────────────────────────────────────────────────
import React from "react";
import { C, FONT, iconTile } from "./tokens";

const PATHS = {
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14 9l3 3" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  devices: <><rect x="3" y="5" width="13" height="10" rx="1.5" /><path d="M6.5 19h6" /><rect x="17.5" y="9" width="4" height="10" rx="1" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></>,
  // The devices list: a laptop for Mac / Windows / Linux / Chrome OS rows, a tablet for iPad (phone above for iPhone / Android).
  laptop: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>,
  tablet: <><rect x="4.5" y="2.5" width="15" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  fingerprint: <><path d="M5 10.5a7 7 0 0 1 14 0" /><path d="M7.5 12a4.5 4.5 0 0 1 9 0c0 3-.6 5.6-1.6 8" /><path d="M12 12v1.5c0 2.8-.6 5.2-1.7 7.5" /><path d="M9.6 15.5c-.2 1.8-.7 3.4-1.4 4.9" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
};

export function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] || null}
    </svg>
  );
}

export function IconTile({ name }) {
  return <span style={iconTile} aria-hidden="true"><Icon name={name} /></span>;
}

const MONOGRAM = { Google: "G", Microsoft: "M", GitHub: "GH", Apple: "A", LinkedIn: "in" };
export function ProviderMark({ name }) {
  return (
    <span style={{ ...iconTile, fontFamily: FONT, fontSize: 11, fontWeight: 800, color: C.ink, letterSpacing: 0 }} aria-hidden="true">
      {MONOGRAM[name] || String(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}
