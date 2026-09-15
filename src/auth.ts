/**
 * D13's device-token auth (§4.5), shared by every edge function
 * (`supabase/functions/sync/`, `supabase/functions/scan/`) rather than
 * reimplemented per function — both need exactly the same answer to "which user
 * is this request," and drift between two copies would be a real auth bug, not a
 * style nit.
 */

/** A bearer token, one per person, read from `Deno.env.get` — never hardcoded,
 * never logged. `TIM_TOKEN`/`VIKA_TOKEN` name whose is whose; `TIM_USER_ID`/
 * `VIKA_USER_ID` are the `users.id` rows each resolves to. Returns `null` for a
 * missing or unrecognized token — callers respond 401 before touching a store. */
export function resolveUserId(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return null;

  for (const [tokenVar, userIdVar] of [
    ["TIM_TOKEN", "TIM_USER_ID"],
    ["VIKA_TOKEN", "VIKA_USER_ID"],
  ] as const) {
    const expected = Deno.env.get(tokenVar);
    if (expected && token === expected) return Deno.env.get(userIdVar) ?? null;
  }
  return null;
}
