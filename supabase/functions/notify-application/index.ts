// notify-application — RETIRED 2026-10-09.
//
// It emailed partner-application receipts / approvals / rejections. The partner
// flow was retired on 2026-09-21 (last application: 2026-06-05), and the
// function had no authentication: anyone could make it send branded mail with
// their own text to any address. It now refuses every call. The previous code
// is in git history (before this commit) if the flow ever comes back; if it
// does, gate it with requireInternal from ../_shared/auth.ts.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: false, error: "gone" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  })
);
