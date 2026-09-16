// Per-instance config, shared by every page in web/ (index.html's app.js,
// scan.html's scan.js, stats.html's stats.js) — one place rather than three.
//
// web/ is a static site (GitHub Pages, no server behind it) hosted on a
// different origin from the Supabase project it talks to, so every API call
// needs the project's full URL, not a relative path — Supabase Edge Functions
// are always reached under /functions/v1/<slug>, never bare root (confirmed
// against Supabase's own routing docs, not assumed), and this app has no
// origin of its own that maps onto that.
//
// PRODUCTION_API_BASE is the one line a new instance's maintainer edits when
// provisioning (see PROVISION_NEW_COUPLE.md in capybara-bot, whose own
// couple-agnostic-via-secrets pattern this mirrors as closely as a static
// site with no server-side config store can) — every other couple's instance
// points at a different Supabase project.
const PRODUCTION_API_BASE = "https://tonirwlcrcjythefhugc.supabase.co/functions/v1";

// web/demo-server.ts serves both the static shell and a fake API from the
// same origin (127.0.0.1/localhost), so a relative, same-origin path is
// correct there and CORS never enters into it — matching how this app
// actually behaved before it had a real deployment target at all.
const isLocalDemo = ["localhost", "127.0.0.1"].includes(location.hostname);

export const API_BASE = isLocalDemo ? "" : PRODUCTION_API_BASE;
