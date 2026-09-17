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
import type { DayBoundary } from "./day.ts";
import type { CardKind, DueItem, NoteRow, QueueSummary, ReviewInput, SchedulerConfigRow } from "./types.ts";
import type { FsrsSchedulerParams } from "../fsrs/types.ts";
import { cardKey, type Store } from "./store.ts";

function toFsrsParams(config: SchedulerConfigRow): FsrsSchedulerParams {
  return {
    fsrsParams: config.fsrsParams,
    desiredRetention: config.desiredRetention,
    maxInterval: config.maxInterval,
  };
}

/** The same projection-per-consumer shape as `toFsrsParams` and `QueueLimits`:
 * a function takes the half of the config it actually uses. */
export function dayBoundary(config: SchedulerConfigRow): DayBoundary {
  return { timeZone: config.timeZone, rolloverHour: config.rolloverHour };
}

/** GET the due queue: `(noteId, cardKind)` pairs only, in review order,
 * optionally scoped to one deck. The caller fetches each card's content
 * separately (or the HTTP layer batches it) — this function's job stops at "what
 * order," matching dueQueue.ts's own scope. */
export async function getDueQueue(
  store: Store,
  userId: string,
  now: Date,
  deck?: string,
): Promise<DueItem[]> {
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
  /** Which of this note's (one or two, D17) cards this is — part of the UI's
   * identity for the item, since `note.id` alone no longer uniquely picks one out
   * of the due queue once a `Capybara+` note's spelling card can appear too. */
  cardKind: CardKind;
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
  const [items, config] = await Promise.all([
    getDueQueue(store, userId, now, deck),
    store.getSchedulerConfig(userId),
  ]);
  const params = toFsrsParams(config);

  // Two batched reads for the whole queue, not two per card. The per-card
  // version of this loop was what made opening a deck slow: 96 due cards meant
  // 192 queries before the first card could render. The queue is already
  // bounded by the daily limits, so these batches are small by construction.
  const [notes, cardStates] = await Promise.all([
    store.getNotes([...new Set(items.map((i) => i.noteId))]),
    store.getCardStates(items),
  ]);

  const cards: DueCard[] = [];
  for (const item of items) {
    const note = notes.get(item.noteId);
    // A note that vanished between selecting the queue and reading it (deleted
    // from another device mid-session) is skipped rather than rendered blank —
    // same behaviour as the per-card version's null check.
    if (!note) continue;
    cards.push({
      ...note,
      cardKind: item.cardKind,
      preview: previewIntervals(
        cardStates.get(cardKey(item.noteId, item.cardKind)) ?? null,
        item.noteId,
        item.cardKind,
        now,
        params,
      ),
    });
  }
  return cards;
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
  const [reviews, cardCounts, config] = await Promise.all([
    store.getReviewsSince(userId, ALL_TIME),
    store.getCardStateCounts(userId),
    store.getSchedulerConfig(userId),
  ]);
  return computeStats(reviews, cardCounts, now, days, dayBoundary(config));
}

export class NotFoundError extends Error {}

/** POST a review answer. Idempotent on `input.reviewId` — a retried submission
 * (the exact case §4.2 exists for) reaches `store.insertReview`, which no-ops on a
 * duplicate id, but still re-runs `upsertCardState` with the same computed values,
 * so a retry is harmless either way. */
export async function submitReview(store: Store, input: ReviewInput): Promise<void> {
  const [current, config] = await Promise.all([
    store.getCardState(input.noteId, input.cardKind),
    store.getSchedulerConfig(input.userId),
  ]);
  const { reviewRow, cardStateRow } = buildReviewMutation(current, input, toFsrsParams(config));
  await store.insertReview(reviewRow);
  await store.upsertCardState(cardStateRow);
}

/** POST suspend or unsuspend one of a note's (one or two, D17) cards. */
export async function setSuspended(
  store: Store,
  noteId: string,
  cardKind: CardKind,
  suspended: boolean,
): Promise<void> {
  const current = await store.getCardState(noteId, cardKind);
  await store.upsertCardState(buildSuspendMutation(current, noteId, cardKind, suspended));
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
