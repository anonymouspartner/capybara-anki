// D13's device token (§4.5), shared by every page in web/ (index.html's app.js,
// scan.html's scan.js) — both need exactly the same "read the fragment, remember
// it, hand it back as a bearer token" logic, so it lives here once rather than
// twice.

const TOKEN_KEY = "capybara-anki-token";

/** Install is opening one link, `#t=<token>`. Reads the fragment, stores the
 * token, and strips it from the visible URL and history so it never lingers there
 * or gets shared by accident. `location.hash` includes its own leading "#" (e.g.
 * "#t=abc"), which `URLSearchParams` doesn't expect — stripped here before
 * parsing, not after (a real bug the first version of this had, caught with
 * Playwright: a fresh install link never actually stored its token). */
export function captureTokenFromUrl() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("t");
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState(null, "", location.pathname + location.search);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
