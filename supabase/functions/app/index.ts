/**
 * Serves `web/`'s static files — the reviewer PWA itself (index.html/app.js,
 * scan.html/scan.js, stats.html/stats.js, offline.js, auth.js, sw.js, theme.css).
 *
 * Exists because `web/` had nowhere to run: no build step, no hosting config
 * anywhere in this repo, and every fetch in `app.js`/`scan.js`/`stats.js` used a
 * same-origin relative path with no base URL — none of which is Supabase's own
 * routing (confirmed against Supabase's own docs, not assumed: a deployed edge
 * function's paths are always prefixed with its own slug, e.g. `/sync/...` for
 * the `sync` function — there is no way to serve anything at bare root). Rather
 * than pick an external static host (a second account, a second deploy step, a
 * decision this repo shouldn't make silently) and wire up CORS across two
 * origins, this serves `web/` from the same Supabase project as `sync`/`scan`/
 * `pronounce` — matching D6 ("one deploy target") exactly, and same-origin, so
 * no CORS is needed at all. The client files now build every API URL as
 * `/functions/v1/<slug>/...` (see their own comments) to match.
 *
 * `url.pathname` inside this handler has already had `/functions/v1` stripped by
 * the platform, same as every other function here — what's left is `/app/...`
 * (this function's own slug prefix), stripped below to find the file under
 * `web/`. A request for `/app` or `/app/` (no file) serves `index.html`.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  let path = url.pathname.replace(/^\/app\/?/, "");
  if (path === "") path = "index.html";
  // Never serve the dev-only demo server, and never allow escaping web/ via "..".
  if (path === "demo-server.ts" || path.includes("..")) {
    return new Response("not found", { status: 404 });
  }

  try {
    const file = await Deno.readFile(new URL(`../../../web/${path}`, import.meta.url));
    return new Response(method === "HEAD" ? null : file, {
      headers: { "content-type": contentTypeFor(path) },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
});
