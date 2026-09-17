// Who this browser is, shared by every page in web/ (index.html's app.js,
// scan.html's scan.js, stats.html's stats.js) — all of them need the same
// answer, so it lives here once rather than three times.
//
// There are two credentials, because there are two ways in:
//
//   * D13's device token (§4.5), for the PWA opened from its install link.
//   * Telegram's signed `initData`, when the same page is opened as a Mini App
//     inside capybara-bot (#17). Nothing is stored for this one — Telegram
//     re-issues it on every launch, and the server verifies rather than trusts.
//
// Telegram wins when both are available: inside Telegram there may well be no
// device token at all, and the signed credential is the stronger of the two.

const TOKEN_KEY = "capybara-anki-token";
const TELEGRAM_INIT_DATA_KEY = "capybara-anki-tg-init-data";

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

/**
 * The Mini App credential, if this page is running inside Telegram.
 *
 * Two sources, deliberately. Telegram's own SDK exposes it as
 * `Telegram.WebApp.initData`, but this is an offline-first PWA and that SDK is
 * a script loaded from telegram.org — so the app must not depend on it having
 * arrived. Telegram also passes the same string in the launch URL's fragment as
 * `tgWebAppData`, which needs nothing external to read.
 *
 * The fragment only exists on the launch URL, so it is kept in sessionStorage to
 * survive navigation between pages: per-tab and cleared when the tab closes,
 * which is the right lifetime for a credential Telegram re-issues on every
 * launch and the server expires after a day anyway.
 */
export function getTelegramInitData() {
  const fromSdk = globalThis.Telegram?.WebApp?.initData;
  if (typeof fromSdk === "string" && fromSdk.length > 0) return fromSdk;

  const fromUrl = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
  if (fromUrl) {
    try {
      sessionStorage.setItem(TELEGRAM_INIT_DATA_KEY, fromUrl);
    } catch {
      // Private mode or blocked storage — the credential still works for this
      // page load, it just won't survive navigating to another one.
    }
    return fromUrl;
  }

  try {
    return sessionStorage.getItem(TELEGRAM_INIT_DATA_KEY);
  } catch {
    return null;
  }
}

/** True when this page was launched as a Telegram Mini App. */
export function isTelegramMiniApp() {
  return getTelegramInitData() !== null;
}

/**
 * The full `Authorization` header value, or null when this browser has no way
 * to identify itself. Callers send it verbatim rather than assembling a scheme
 * themselves — the two credentials use different schemes (`tma` is Telegram's
 * own convention, `Bearer` is D13's), and that difference should live here.
 */
export function authHeader() {
  const initData = getTelegramInitData();
  if (initData) return `tma ${initData}`;
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}
