/**
 * CORS support for sync/scan/pronounce — needed once `web/` moved off this
 * Supabase project entirely (GitHub Pages, see docs/DESIGN.md and supabase/
 * functions/app/'s own removal) and every real call became cross-origin.
 *
 * `Access-Control-Allow-Origin: *` rather than a specific Pages origin,
 * deliberately: this repo is couple-agnostic (one instance per couple, each
 * with its own Supabase project and, now, its own Pages URL) — hardcoding one
 * origin here would break every instance but the one that picked it. The real
 * access boundary is D13's bearer token, checked well after CORS ever comes
 * into play; CORS only controls which *browser pages* may read a response,
 * not who may call the endpoint (a `curl` never goes through the browser's
 * CORS layer at all) — so an open origin adds no real exposure beyond what a
 * bad actor already has by calling the API directly.
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

/** Call first, before any auth check — a preflight OPTIONS request never
 * carries the real Authorization header, so gating it behind D13's token
 * check would fail every real cross-origin call before it ever got there. */
export function corsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  return null;
}
