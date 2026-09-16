/**
 * The `/sync` edge function — HTTP surface over `../../../src/review/handlers.ts`.
 * Matches `capybara-bot`'s own shape (`Deno.serve`, one file, secrets via
 * `Deno.env.get`) deliberately, since D6 reuses that pattern rather than
 * inventing a second one.
 *
 * **Not deployed. Not deployable yet, on purpose — see PostgresStore below.**
 * Claude builds and commits; the maintainer deploys, and only on an explicit,
 * in-the-moment request (this repo's README, capybara-bot's CLAUDE.md). This file
 * exists so the real wiring is visible and reviewable now, not so it ships today.
 *
 * Routes:
 *   GET    /sync/decks            → deck-list screen: every deck this user has
 *                                    notes in, with its own new/learning/review
 *                                    counts (handlers.ts's getDeckSummaries)
 *   GET    /sync/due?deck=X       → this user's due queue for deck X (or every
 *                                    deck combined, with no ?deck), full note
 *                                    content plus each card's four-button interval
 *                                    preview, in review order (dueQueue.ts decides
 *                                    the order; getDueQueueWithPreviews fetches what
 *                                    the reviewer needs to render each card without
 *                                    a second request)
 *   POST   /sync/review           → { reviewId, noteId, cardKind?, rating, reviewedAt }
 *                                    (cardKind defaults to 'recall' — D17's
 *                                    'spelling' only exists for hasSpelling notes)
 *   POST   /sync/suspend          → { noteId, cardKind?, suspended }
 *   PATCH  /sync/note/:id         → a partial NoteRow
 *   DELETE /sync/note/:id
 *   GET    /sync/stats?days=N     → stats screen (step 6): a day-by-day activity
 *                                    histogram over the last N days (default 30),
 *                                    all-time success rate and streak, and the
 *                                    collection's current state composition
 *                                    (handlers.ts's getStats)
 *
 * Auth (D13, §4.5): a bearer token, one per person, read from `Deno.env.get` —
 * never hardcoded, never logged. `TIM_TOKEN`/`VIKA_TOKEN` name whose is whose;
 * `TIM_USER_ID`/`VIKA_USER_ID` are the `users.id` rows each resolves to. A request
 * with no matching token gets 401 before touching the store at all.
 */

import {
  deleteNote,
  editNote,
  getDeckSummaries,
  getDueQueueWithPreviews,
  getStats,
  NotFoundError,
  setSuspended,
  submitReview,
} from "../../../src/review/handlers.ts";
import type { Store } from "../../../src/review/store.ts";
import { resolveUserId } from "../../../src/auth.ts";

// ---------------------------------------------------------------------------
// Store — NOT YET IMPLEMENTED
// ---------------------------------------------------------------------------

/**
 * A real `Store` backed by Postgres (via `@supabase/supabase-js`) belongs here.
 * Deliberately not written yet: every other piece of this repo that touches
 * external data — the Anki collection reader, the FSRS replay logic, this
 * function's own routing — was built against something concrete enough to test
 * (a real export, the real `ts-fsrs` library, `InMemoryStore`) and had at least one
 * real assumption corrected in the process (docs/DESIGN.md §7.5, §5.1). A
 * `PostgresStore` written against no live project would skip that step entirely —
 * exactly the kind of untested code this whole build has been deliberately
 * avoiding. Write it once there's a project to run it against, even a scratch one,
 * and expect the same thing to happen: something about `@supabase/supabase-js`'s
 * actual query builder, RLS, or error shapes won't match what's guessed here.
 *
 * `Store`'s shape (src/review/store.ts) is intentionally already exactly what this
 * needs to implement — that interface is the real contract, this class is the one
 * piece still missing.
 */
class PostgresStore implements Store {
  constructor(_supabaseUrl: string, _serviceRoleKey: string) {}

  getNote(_noteId: string): ReturnType<Store["getNote"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getCardState(_noteId: string, _cardKind: Parameters<Store["getCardState"]>[1]): ReturnType<Store["getCardState"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getSchedulerConfig(_userId: string): ReturnType<Store["getSchedulerConfig"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  createNote(_note: Parameters<Store["createNote"]>[0]): ReturnType<Store["createNote"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getDecks(_userId: string): ReturnType<Store["getDecks"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getDueCandidates(_userId: string, _deck?: string): ReturnType<Store["getDueCandidates"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getDailyCounts(_userId: string, _now: Date, _deck?: string): ReturnType<Store["getDailyCounts"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getReviewsSince(_userId: string, _since: Date): ReturnType<Store["getReviewsSince"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  getCardStateCounts(_userId: string): ReturnType<Store["getCardStateCounts"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  insertReview(_row: Parameters<Store["insertReview"]>[0]): ReturnType<Store["insertReview"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  upsertCardState(_row: Parameters<Store["upsertCardState"]>[0]): ReturnType<Store["upsertCardState"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  updateNote(
    _noteId: string,
    _patch: Parameters<Store["updateNote"]>[1],
  ): ReturnType<Store["updateNote"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
  deleteNote(_noteId: string): ReturnType<Store["deleteNote"]> {
    throw new Error("PostgresStore is not implemented yet — see this class's docstring");
  }
}

function getStore(): Store {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — see README for local dev");
  }
  return new PostgresStore(url, key);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function route(req: Request, store: Store, userId: string): Promise<Response> {
  const url = new URL(req.url);
  const noteIdFromPath = url.pathname.match(/\/sync\/note\/([^/]+)$/)?.[1];

  if (req.method === "GET" && url.pathname === "/sync/decks") {
    return json(await getDeckSummaries(store, userId, new Date()));
  }

  if (req.method === "GET" && url.pathname === "/sync/due") {
    const deck = url.searchParams.get("deck") ?? undefined;
    return json(await getDueQueueWithPreviews(store, userId, new Date(), deck));
  }

  if (req.method === "GET" && url.pathname === "/sync/stats") {
    const daysParam = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : undefined;
    return json(await getStats(store, userId, new Date(), days));
  }

  if (req.method === "POST" && url.pathname === "/sync/review") {
    const body = await req.json();
    await submitReview(store, {
      reviewId: body.reviewId,
      noteId: body.noteId,
      // D17: defaults to 'recall' — every note without hasSpelling only ever has
      // one card, so most clients never need to say which one they mean.
      cardKind: body.cardKind ?? "recall",
      userId,
      rating: body.rating,
      reviewedAt: new Date(body.reviewedAt),
    });
    return json({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/sync/suspend") {
    const body = await req.json();
    await setSuspended(store, body.noteId, body.cardKind ?? "recall", body.suspended);
    return json({ ok: true });
  }

  if (req.method === "PATCH" && noteIdFromPath) {
    const patch = await req.json();
    const result = await editNote(store, noteIdFromPath, patch);
    return json(result, result.ok ? 200 : 400);
  }

  if (req.method === "DELETE" && noteIdFromPath) {
    await deleteNote(store, noteIdFromPath);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

Deno.serve(async (req) => {
  const userId = resolveUserId(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  try {
    return await route(req, getStore(), userId);
  } catch (e) {
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    console.error("sync: unhandled error", e);
    return json({ error: "internal error" }, 500);
  }
});
