/**
 * Telegram Mini App authentication (issue #17) — proving that a request really
 * came from Telegram, on behalf of a specific Telegram account.
 *
 * A Mini App hands the page an `initData` string: a URL-encoded query string of
 * fields Telegram signed with the bot's token. Verifying it is the whole of the
 * auth story, because nothing else about the request is trustworthy — the page
 * runs in a webview the user controls, so `user.id` on its own is a claim, not
 * evidence.
 *
 * The algorithm is Telegram's, checked against core.telegram.org/bots/webapps
 * rather than written from memory, because getting any step subtly wrong either
 * locks everyone out or, worse, accepts forged data:
 *
 *   secret        = HMAC_SHA256(key: "WebAppData", message: <bot token>)
 *   checkString   = every field except `hash`, sorted by key, "k=v" joined by \n
 *   expected      = hex(HMAC_SHA256(key: secret, message: checkString))
 *   valid         <=> expected === the `hash` field
 *
 * Note which way round the first HMAC goes: the **token is the message** and the
 * literal string `WebAppData` is the key, which is the opposite of what the
 * phrase "secret key" suggests.
 *
 * `signature` stays IN the check string. Telegram excludes `hash` here and
 * excludes both `hash` and `signature` only for the separate Ed25519
 * third-party flow, which this is not. Dropping `signature` would make every
 * request from a client that sends it fail to validate.
 *
 * This module never talks to Telegram's API. It only uses the bot token as an
 * HMAC key, so it does not touch the webhook and cannot become the "second
 * consumer" of the token that capybara-bot's CLAUDE.md warns about.
 */

/** How stale an `initData` may be. Telegram recommends checking `auth_date` but
 * names no window; a day is long enough that a Mini App left open in the
 * background still works, and short enough that a leaked `initData` is not a
 * permanent credential. */
export const MAX_INIT_DATA_AGE_SECONDS = 86_400;

export type InitDataResult =
  | { ok: true; telegramId: number }
  | { ok: false; reason: string };

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent, value-independent comparison. Comparing hashes with ===
 * would leak how much of a forged hash was right via timing; this always looks
 * at every character. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies an `initData` string and returns the Telegram user id it attests to.
 *
 * Returns a reason rather than throwing, so a caller can log why a request was
 * rejected without the reason reaching the client — "expired" and "bad hash"
 * are useful in a log and are an oracle in a response body.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeSeconds: number = MAX_INIT_DATA_AGE_SECONDS,
): Promise<InitDataResult> {
  if (!initData) return { ok: false, reason: "empty initData" };
  if (!botToken) return { ok: false, reason: "no bot token configured" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash field" };

  // Every field except `hash`, sorted by key. URLSearchParams has already
  // percent-decoded the values, which is what Telegram signs.
  const checkString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secret, checkString));
  if (!timingSafeEqual(expected, hash)) return { ok: false, reason: "hash mismatch" };

  // Only checked once the hash is known good: an unverified auth_date is not
  // worth reasoning about.
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return { ok: false, reason: "no usable auth_date" };
  const ageSeconds = now.getTime() / 1000 - authDate;
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: "initData expired" };
  // A timestamp from the future means a wrong clock somewhere, not a fresh
  // credential, and accepting it would make the expiry check meaningless.
  if (ageSeconds < -maxAgeSeconds) return { ok: false, reason: "auth_date in the future" };

  const rawUser = params.get("user");
  if (!rawUser) return { ok: false, reason: "no user field" };
  let telegramId: unknown;
  try {
    telegramId = (JSON.parse(rawUser) as { id?: unknown }).id;
  } catch {
    return { ok: false, reason: "user field is not JSON" };
  }
  if (typeof telegramId !== "number" || !Number.isFinite(telegramId)) {
    return { ok: false, reason: "user.id missing or not a number" };
  }

  return { ok: true, telegramId };
}
