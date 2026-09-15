/**
 * The request-shaped operations `supabase/functions/sync/` exposes over HTTP —
 * kept as plain functions over a `Store`, not `Deno.serve` handlers, so they're
 * testable without a network stack. `sync/index.ts` is the thin adapter that
 * parses a `Request`, calls one of these, and serializes the result.
 */

import { selectDueQueue } from "./dueQueue.ts";
import { buildReviewMutation, buildSuspendMutation, validateNoteEdit } from "./mutations.ts";
import type { NoteRow, ReviewInput, SchedulerConfigRow } from "./types.ts";
import type { FsrsSchedulerParams } from "../fsrs/types.ts";
import type { Store } from "./store.ts";

function toFsrsParams(config: SchedulerConfigRow): FsrsSchedulerParams {
  return {
    fsrsParams: config.fsrsParams,
    desiredRetention: config.desiredRetention,
    maxInterval: config.maxInterval,
  };
}

/** GET the due queue: note ids only, in review order. The caller fetches each
 * note's fields separately (or the HTTP layer batches it) — this function's job
 * stops at "what order," matching dueQueue.ts's own scope. */
export async function getDueQueue(store: Store, userId: string, now: Date): Promise<string[]> {
  const [candidates, config, counts] = await Promise.all([
    store.getDueCandidates(userId),
    store.getSchedulerConfig(userId),
    store.getDailyCounts(userId, now),
  ]);
  return selectDueQueue(
    candidates,
    { dailyNewLimit: config.dailyNewLimit, dailyReviewLimit: config.dailyReviewLimit },
    counts,
    now,
  );
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
