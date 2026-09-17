import { assertEquals } from "jsr:@std/assert@^1";
import { verifyInitData } from "./telegramAuth.ts";

const BOT_TOKEN = "123456:TEST-TOKEN-not-a-real-one";
const NOW = new Date("2026-09-17T12:00:00Z");
const AUTH_DATE = Math.floor(NOW.getTime() / 1000);

/** Signs a set of fields the way Telegram does, so the tests exercise the real
 * algorithm end to end rather than asserting against a hash this same code
 * produced. Mirrors the spec independently: secret = HMAC(key "WebAppData",
 * message token), then HMAC(key secret, message check-string). */
async function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): Promise<string> {
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, enc.encode(botToken));
  const finalKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", finalKey, enc.encode(checkString));
  const hash = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(AUTH_DATE),
    query_id: "AAterrific",
    user: JSON.stringify({ id: 111222333, first_name: "Test", username: "test" }),
    ...overrides,
  };
}

Deno.test("a correctly signed initData verifies and yields the Telegram user id", async () => {
  const result = await verifyInitData(await signInitData(validFields()), BOT_TOKEN, NOW);
  assertEquals(result, { ok: true, telegramId: 111222333 });
});

Deno.test("a tampered field is rejected", async () => {
  // The whole point of the signature: change the user and the hash no longer matches.
  const signed = await signInitData(validFields());
  const params = new URLSearchParams(signed);
  params.set("user", JSON.stringify({ id: 999999999, first_name: "Mallory" }));

  const result = await verifyInitData(params.toString(), BOT_TOKEN, NOW);
  assertEquals(result, { ok: false, reason: "hash mismatch" });
});

Deno.test("initData signed with a different bot token is rejected", async () => {
  const signed = await signInitData(validFields(), "999999:SOME-OTHER-BOT");
  const result = await verifyInitData(signed, BOT_TOKEN, NOW);
  assertEquals(result, { ok: false, reason: "hash mismatch" });
});

Deno.test("signature stays inside the check string, unlike hash", async () => {
  // Telegram excludes only `hash` for this HMAC check; it excludes `hash` AND
  // `signature` only for the separate Ed25519 third-party flow. Getting that
  // wrong would reject every client that sends `signature` — which newer ones
  // do. Signing WITH the field and verifying must therefore succeed.
  const signed = await signInitData(validFields({ signature: "abc123_ed25519_base64url" }));
  const result = await verifyInitData(signed, BOT_TOKEN, NOW);
  assertEquals(result, { ok: true, telegramId: 111222333 });

  // And dropping it after signing must fail, proving it was really covered.
  const params = new URLSearchParams(signed);
  params.delete("signature");
  assertEquals(
    await verifyInitData(params.toString(), BOT_TOKEN, NOW),
    { ok: false, reason: "hash mismatch" },
  );
});

Deno.test("stale initData is rejected once past the window", async () => {
  const signed = await signInitData(validFields());
  const wellWithin = new Date(NOW.getTime() + 60_000);
  assertEquals((await verifyInitData(signed, BOT_TOKEN, wellWithin)).ok, true);

  const twoDaysLater = new Date(NOW.getTime() + 2 * 86_400_000);
  assertEquals(
    await verifyInitData(signed, BOT_TOKEN, twoDaysLater),
    { ok: false, reason: "initData expired" },
  );
});

Deno.test("an auth_date far in the future is rejected, not treated as fresh", async () => {
  const signed = await signInitData(validFields());
  const longBefore = new Date(NOW.getTime() - 5 * 86_400_000);
  assertEquals(
    await verifyInitData(signed, BOT_TOKEN, longBefore),
    { ok: false, reason: "auth_date in the future" },
  );
});

Deno.test("missing pieces are reported rather than throwing", async () => {
  assertEquals(await verifyInitData("", BOT_TOKEN, NOW), { ok: false, reason: "empty initData" });
  assertEquals(
    await verifyInitData("auth_date=1&user=%7B%7D", BOT_TOKEN, NOW),
    { ok: false, reason: "no hash field" },
  );
  assertEquals(
    await verifyInitData(await signInitData(validFields()), "", NOW),
    { ok: false, reason: "no bot token configured" },
  );
});

Deno.test("a signed payload with no user field is rejected", async () => {
  // Signed correctly, but carries no account to act as — valid and useless.
  const signed = await signInitData({ auth_date: String(AUTH_DATE), query_id: "AAterrific" });
  assertEquals(
    await verifyInitData(signed, BOT_TOKEN, NOW),
    { ok: false, reason: "no user field" },
  );
});

Deno.test("a signed payload whose user.id is not a number is rejected", async () => {
  const signed = await signInitData(validFields({ user: JSON.stringify({ id: "111222333" }) }));
  assertEquals(
    await verifyInitData(signed, BOT_TOKEN, NOW),
    { ok: false, reason: "user.id missing or not a number" },
  );
});

Deno.test("values needing percent-encoding survive the round trip", async () => {
  // The check string uses decoded values, and a real user object is full of
  // characters that get encoded in transit — a display name with a space and
  // an ampersand would break a naive implementation that signed the raw string.
  const signed = await signInitData(validFields({
    user: JSON.stringify({ id: 111222333, first_name: "Ann & Bob", last_name: "О'Брайєн" }),
  }));
  assertEquals(await verifyInitData(signed, BOT_TOKEN, NOW), { ok: true, telegramId: 111222333 });
});
