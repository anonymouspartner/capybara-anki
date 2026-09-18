/**
 * The `/sync` edge function — HTTP surface over `../../../src/review/handlers.ts`.
 * Matches `capybara-bot`'s own shape (`Deno.serve`, one file, secrets via
 * `Deno.env.get`) deliberately, since D6 reuses that pattern rather than
 * inventing a second one.
 *
 * **Deployed** (2026-09-16) against the live `anki_*` tables via `PostgresStore`
 * (`../_shared/postgresStore.ts`) — verified live, not guessed. Every deploy,
 * this one and each redeploy since, happened only on an explicit, in-the-moment
 * request (this repo's README, capybara-bot's CLAUDE.md) — never a side effect
 * of writing or committing code.
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
 *                                    Answers { ok, leech } — `leech` true when
 *                                    this answer pushed the card past the leech
 *                                    threshold (src/review/leech.ts)
 *   POST   /sync/undo             → { noteId, cardKind? } — removes this user's
 *                                    most recent answer to that card and rebuilds
 *                                    its state from the remaining log (§4.3)
 *   POST   /sync/suspend          → { noteId, cardKind?, suspended }
 *   POST   /sync/bury             → { noteId, cardKind?, buried } — D12's third
 *                                    action; answering a note's other card also
 *                                    buries this one automatically (bury siblings,
 *                                    src/review/mutations.ts's SiblingBury)
 *   POST   /sync/note             → { lemma, language, lemmaTranslation?, gloss?,
 *                                    partOfSpeech?, example?, exampleTranslation? }
 *                                    the add-a-card screen (Phase 5.2) — the deck
 *                                    picks itself from language, same as /scan
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
 *
 * CORS: `web/` is hosted on GitHub Pages, a different origin from this project
 * — every real call is cross-origin, so every response (and the OPTIONS
 * preflight browsers send ahead of one, since Authorization is never a
 * "simple" header) needs CORS headers. See `../_shared/cors.ts`.
 */

import {
  addCard,
  buryCard,
  deleteNote,
  editNote,
  getDeckSummaries,
  getDueQueueWithPreviews,
  getStats,
  NotFoundError,
  setSuspended,
  submitReview,
  undoLastReview,
} from "../../../src/review/handlers.ts";
import type { Store } from "../../../src/review/store.ts";
import { resolveUserIdFromRequest } from "../../../src/auth.ts";
import { PostgresStore } from "../_shared/postgresStore.ts";
import { CORS_HEADERS, corsPreflight } from "../_shared/cors.ts";

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
    headers: { "content-type": "application/json", ...CORS_HEADERS },
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
    const result = await submitReview(store, {
      reviewId: body.reviewId,
      noteId: body.noteId,
      // D17: defaults to 'recall' — every note without hasSpelling only ever has
      // one card, so most clients never need to say which one they mean.
      cardKind: body.cardKind ?? "recall",
      userId,
      rating: body.rating,
      reviewedAt: new Date(body.reviewedAt),
    });
    // `leech` is additive: a client that ignores it behaves exactly as before.
    return json({ ok: true, leech: result.becameLeech });
  }

  if (req.method === "POST" && url.pathname === "/sync/undo") {
    const body = await req.json();
    const result = await undoLastReview(store, userId, body.noteId, body.cardKind ?? "recall");
    return json({ ok: true, rating: result.rating });
  }

  if (req.method === "POST" && url.pathname === "/sync/suspend") {
    const body = await req.json();
    await setSuspended(store, body.noteId, body.cardKind ?? "recall", body.suspended);
    return json({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/sync/bury") {
    const body = await req.json();
    await buryCard(store, body.noteId, body.cardKind ?? "recall", body.buried, new Date(), userId);
    return json({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/sync/note") {
    const body = await req.json();
    const result = await addCard(store, {
      lemma: body.lemma,
      language: body.language,
      lemmaTranslation: body.lemmaTranslation ?? null,
      gloss: body.gloss ?? null,
      partOfSpeech: body.partOfSpeech ?? null,
      example: body.example ?? null,
      exampleTranslation: body.exampleTranslation ?? null,
    });
    return json(result, result.ok ? 200 : 400);
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
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  const userId = await resolveUserIdFromRequest(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  try {
    return await route(req, getStore(), userId);
  } catch (e) {
    if (e instanceof NotFoundError) return json({ error: e.message }, 404);
    console.error("sync: unhandled error", e);
    return json({ error: "internal error" }, 500);
  }
});
