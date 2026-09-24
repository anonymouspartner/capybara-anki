// Telegram Mini App integration (#17) — the presentation half. `auth.js` owns
// the credential; this owns how the page behaves once it is running inside
// Telegram rather than in a browser tab.
//
// Every one of these is optional on purpose. The app must still work when
// telegram.org's SDK script hasn't loaded — it is an offline-first PWA, and a
// third-party script is exactly the thing that won't be there on a bad
// connection. `auth.js` reads the credential from the launch URL in that case,
// so the only thing lost here is polish.

/** Telegram's own palette, for the chrome only.
 *
 * Deliberately partial: the rating buttons and the new/learning/review counts
 * keep their own colours, because those are semantic — Again is red and Good is
 * green in Anki, in AnkiDroid, and here, and repainting them in a client's theme
 * would make a familiar interface unreadable at a glance. What adopts Telegram's
 * theme is the surrounding surface, so the app sits inside the client instead of
 * fighting it. */
const THEME_MAP = [
  ["bg_color", "--bg-page"],
  ["secondary_bg_color", "--bg-toolbar"],
  ["secondary_bg_color", "--bg-card"],
  ["text_color", "--fg"],
  ["hint_color", "--fg-muted"],
];

function applyTheme(webApp) {
  const params = webApp.themeParams ?? {};
  for (const [telegramKey, cssVar] of THEME_MAP) {
    const value = params[telegramKey];
    if (typeof value === "string" && value) {
      document.documentElement.style.setProperty(cssVar, value);
    }
  }
  // theme.css keys its dark palette off prefers-color-scheme, which reflects the
  // OS rather than the Telegram client. Pinning data-theme lets a person running
  // Telegram in dark mode on a light OS (or the reverse) get the right one.
  if (webApp.colorScheme === "dark" || webApp.colorScheme === "light") {
    document.documentElement.setAttribute("data-theme", webApp.colorScheme);
  }
}

/**
 * Tells Telegram the page is ready, asks for the full viewport, and adopts the
 * client's theme. Safe to call on any page and outside Telegram entirely, where
 * it does nothing.
 *
 * `expand()` matters more than it looks for this app specifically: a Mini App
 * opens at roughly half height by default, and the reviewer pins its rating bar
 * to the bottom of the viewport — unexpanded, the buttons are the part that ends
 * up off screen.
 */
export function initTelegram() {
  const webApp = globalThis.Telegram?.WebApp;
  if (!webApp) return false;

  try {
    webApp.ready();
    webApp.expand();
    applyTheme(webApp);
    webApp.onEvent?.("themeChanged", () => applyTheme(webApp));
    return true;
  } catch (e) {
    console.error("telegram init failed", e);
    return false;
  }
}

/** A small physical tap to go with an answer -- Duolingo pairs every verdict
 * with one. Telegram's HapticFeedback, where the client offers it; a no-op
 * everywhere else (a browser tab, or a client too old to have it).
 *
 *   haptic("tap")      -- a button press (a rating)
 *   haptic("success")  -- a right answer, a finished session
 *   haptic("error")    -- a wrong answer
 */
export function haptic(kind) {
  const feedback = globalThis.Telegram?.WebApp?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === "tap") feedback.impactOccurred("light");
    else feedback.notificationOccurred(kind);
  } catch (e) {
    console.error("haptic failed", e);
  }
}
