/**
 * D13's device-token auth (§4.5), shared by every edge function
 * (`supabase/functions/sync/`, `supabase/functions/scan/`) rather than
 * reimplemented per function — both need exactly the same answer to "which user
 * is this request," and drift between two copies would be a real auth bug, not a
 * style nit.
 */

import { verifyInitData } from "./telegramAuth.ts";

/** Whose is whose. One entry per person, and the only place the three secrets
 * that describe one person are tied together: their device token, their Telegram
 * account, and the `users.id` both resolve to. */
const PEOPLE = [
  { tokenVar: "TIM_TOKEN", telegramIdVar: "TIM_TELEGRAM_ID", userIdVar: "TIM_USER_ID" },
  { tokenVar: "VIKA_TOKEN", telegramIdVar: "VIKA_TELEGRAM_ID", userIdVar: "VIKA_USER_ID" },
] as const;

/** A bearer token, one per person, read from `Deno.env.get` — never hardcoded,
 * never logged. `TIM_TOKEN`/`VIKA_TOKEN` name whose is whose; `TIM_USER_ID`/
 * `VIKA_USER_ID` are the `users.id` rows each resolves to. Returns `null` for a
 * missing or unrecognized token — callers respond 401 before touching a store. */
export function resolveUserId(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return null;

  for (const { tokenVar, userIdVar } of PEOPLE) {
    const expected = Deno.env.get(tokenVar);
    if (expected && token === expected) return Deno.env.get(userIdVar) ?? null;
  }
  return null;
}

/**
 * Which user this request is, by either route.
 *
 * `Authorization: tma <initData>` is Telegram's own convention for a Mini App
 * (#17): the credential is a signed blob rather than a shared secret, so it is
 * verified rather than compared. `Authorization: Bearer <token>` stays exactly
 * as it was, for the PWA opened from its install link outside Telegram — the
 * two coexist because the same deployment serves both.
 *
 * The Telegram id is mapped to a `users.id` through function secrets, the same
 * way the device tokens already are, so this file still needs no database and
 * identity still lives entirely in configuration rather than in code.
 */
export async function resolveUserIdFromRequest(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("tma ")) return resolveUserId(req);

  const result = await verifyInitData(header.slice("tma ".length), Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "");
  if (!result.ok) {
    // Why it failed is useful here and is an oracle in a response, so it stays
    // in the log and the caller only ever learns "unauthorized".
    console.error("telegram initData rejected:", result.reason);
    return null;
  }

  for (const { telegramIdVar, userIdVar } of PEOPLE) {
    const configured = Deno.env.get(telegramIdVar);
    if (configured && configured === String(result.telegramId)) return Deno.env.get(userIdVar) ?? null;
  }
  // A real Telegram account that simply is not one of this instance's two
  // people. The signature was valid, so this is worth distinguishing in a log
  // from a forged one.
  console.error("telegram initData verified but the account is not configured for this instance");
  return null;
}
