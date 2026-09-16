/**
 * The request-shaped operations `supabase/functions/sync/` exposes over HTTP —
 * kept as plain functions over a `Store`, not `Deno.serve` handlers, so they're
 * testable without a network stack. `sync/index.ts` is the thin adapter that
 * parses a `Request`, calls one of these, and serializes the result.
 */

import { selectDueQueue, summarizeDueQueue } from "./dueQueue.ts";
import {
  buildReviewMutation,
  buildSuspendMutation,
  type IntervalPreview,
  previewIntervals,
  validateNoteEdit,
} from "./mutations.ts";
import { computeStats, type StatsResult } from "./stats.ts";
import type { NoteRow, QueueSummary, ReviewInput, SchedulerConfigRow } from "./types.ts";
import type { FsrsSchedulerParams } from "../fsrs/types.ts";
import type { Store } from "./store.ts";

function toFsrsParams(config: SchedulerConfigRow): FsrsSchedulerParams {
  return {
    fsrsParams: config.fsrsParams,
    desiredRetention: config.desiredRetention,
    maxInterval: config.maxInterval,
  };
}

/** GET the due queue: note ids only, in review order, optionally scoped to one
 * deck. The caller fetches each note's fields separately (or the HTTP layer
 * batches it) — this function's job stops at "what order," matching dueQueue.ts's
 * own scope. */
export async function getDueQueue(
  store: Store,
  userId: string,
  now: Date,
  deck?: string,
): Promise<string[]> {
  const [candidates, config, counts] = await Promise.all([
    store.getDueCandidates(userId, deck),
    store.getSchedulerConfig(userId),
    store.getDailyCounts(userId, now, deck),
  ]);
  return selectDueQueue(
    candidates,
    { dailyNewLimit: config.dailyNewLimit, dailyReviewLimit: config.dailyReviewLimit },
    counts,
    now,
  );
}

export interface DeckSummary extends QueueSummary {
  deck: string;
}

/** GET the deck-list screen's row set: every deck this user has notes in, each
 * with its own new/learning/review counts. One `getDueCandidates` round trip per
 * deck rather than one big query filtered client-side — simpler to keep correct
 * as `getDailyCounts`/`getDueCandidates` evolve, and there are a handful of decks,
 * not thousands. */
export async function getDeckSummaries(store: Store, userId: string, now: Date): Promise<DeckSummary[]> {
  const [decks, config] = await Promise.all([store.getDecks(userId), store.getSchedulerConfig(userId)]);
  const limits = { dailyNewLimit: config.dailyNewLimit, dailyReviewLimit: config.dailyReviewLimit };

  return Promise.all(
    decks.map(async (deck) => {
      const [candidates, counts] = await Promise.all([
        store.getDueCandidates(userId, deck),
        store.getDailyCounts(userId, now, deck),
      ]);
      return { deck, ...summarizeDueQueue(candidates, limits, counts, now) };
    }),
  );
}

export interface DueCard extends NoteRow {
  preview: IntervalPreview;
}

/** GET the due queue with each card's content and interval preview attached — what
 * the reviewer UI actually renders. Built on `getDueQueue` for ordering, then one
 * `getNote`/`getCardState` round trip per card to assemble the response; this is the
 * single place that logic lives, replacing what would otherwise be duplicated
 * between `supabase/functions/sync/index.ts` and `web/demo-server.ts`. */
export async function getDueQueueWithPreviews(
  store: Store,
  userId: string,
  now: Date,
  deck?: string,
): Promise<DueCard[]> {
  const [ids, config] = await Promise.all([
    getDueQueue(store, userId, now, deck),
    store.getSchedulerConfig(userId),
  ]);
  const params = toFsrsParams(config);

  const cards = await Promise.all(ids.map(async (id) => {
    const [note, cardState] = await Promise.all([store.getNote(id), store.getCardState(id)]);
    if (!note) return null;
    return { ...note, preview: previewIntervals(cardState, now, params) };
  }));
  return cards.filter((c): c is DueCard => c !== null);
}

const DEFAULT_STATS_WINDOW_DAYS = 30;
// Far enough back that "since this date" is really "all-time" for any real
// account — streak and success rate need full history, not just the chart window
// (see stats.ts's own docstring on why one fetch covers both).
const ALL_TIME = new Date(0);

/** GET the stats screen (step 6): a day-by-day activity histogram over `days`
 * (default 30), plus all-time success rate, streak, and collection composition.
 * `getReviewsSince(userId, ALL_TIME)` is one round trip doing double duty — the
 * histogram bucketing in stats.ts drops whatever falls outside its own window. */
export async function getStats(
  store: Store,
  userId: string,
  now: Date,
  days = DEFAULT_STATS_WINDOW_DAYS,
): Promise<StatsResult> {
  const [reviews, cardCounts] = await Promise.all([
    store.getReviewsSince(userId, ALL_TIME),
    store.getCardStateCounts(userId),
  ]);
  return computeStats(reviews, cardCounts, now, days);
}

export class NotFoundError extends Error {}

/** POST a review answer. Idempotent on `input.reviewId` — a retried submission
 * (the exact case §4.2 exists for) reaches `store.insertReview`, which no-ops on a
 * duplicate id, but still re-runs `upsertCardState` with the same computed values,
 * so a retry is harmless either way. */
export async function submitReview(store: Store, input: ReviewInput): Promise<void> {
  const [current, config] = await Promise.all([
    store.getCardState(input.noteId),
    store.getSchedulerConfig(input.userId),
  ]);
  const { reviewRow, cardStateRow } = buildReviewMutation(current, input, toFsrsParams(config));
  await store.insertReview(reviewRow);
  await store.upsertCardState(cardStateRow);
}

/** POST suspend or unsuspend. */
export async function setSuspended(store: Store, noteId: string, suspended: boolean): Promise<void> {
  const current = await store.getCardState(noteId);
  await store.upsertCardState(buildSuspendMutation(current, noteId, suspended));
}

export interface EditNoteResult {
  ok: boolean;
  errors?: string[];
}

/** PATCH a note's fields — D11's edit-in-place repair path. */
export async function editNote(
  store: Store,
  noteId: string,
  patch: Partial<Omit<NoteRow, "id">>,
): Promise<EditNoteResult> {
  const note = await store.getNote(noteId);
  if (!note) throw new NotFoundError(`no note ${noteId}`);

  const result = validateNoteEdit(patch);
  if (!result.valid) return { ok: false, errors: result.errors };

  await store.updateNote(noteId, result.patch!);
  return { ok: true };
}

/** DELETE a note outright — see docs/DESIGN.md §5.1/D12: distinct from suspend,
 * this permanently removes a genuinely wrong card and its review history, on the
 * assumption (§9.1) that a note is only ever reviewed by the one person who added
 * or encountered it. */
export async function deleteNote(store: Store, noteId: string): Promise<void> {
  const note = await store.getNote(noteId);
  if (!note) throw new NotFoundError(`no note ${noteId}`);
  await store.deleteNote(noteId);
}
