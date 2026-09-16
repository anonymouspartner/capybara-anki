/**
 * The four D12 actions (review, suspend, edit, delete) as pure state transitions.
 * "Pure" here means: given the current row(s) and an input, produce the row(s) to
 * write — no Postgres, no Supabase client, nothing that can't run in a test. The
 * `sync` edge function (supabase/functions/sync/) is the thin layer that actually
 * reads/writes Postgres and calls into these.
 *
 * The recurring shape below is `mergeCardState`: every action that touches
 * `card_state` goes through it, because — see types.ts's module docstring — a row
 * can exist with only `suspended` set and every FSRS field null (a never-reviewed
 * card someone suspended pre-emptively), and no action should ever clobber fields
 * it has no opinion about. A review sets the FSRS fields and leaves `suspended`
 * exactly as it was; a suspend toggle sets `suspended` and leaves the FSRS fields
 * exactly as they were, creating the row from nothing if needed.
 */

import { applyReview, type CardSeed } from "../fsrs/replay.ts";
import type { FsrsCardState, FsrsSchedulerParams } from "../fsrs/types.ts";
import type { CardKind, CardStateRow, NoteRow, ReviewInput, ReviewRow } from "./types.ts";

const MS_PER_DAY = 86_400_000;

/**
 * This app's equivalent of Anki's card id, for seeding interval fuzz: `(noteId,
 * cardKind)` is what identifies a card here (D17), where Anki has a single
 * integer. Every path that schedules the same card — answering it, and previewing
 * what each button would do — has to pass the identical seed, or the interval on
 * the button stops being the interval the card gets.
 */
export function cardSeed(noteId: string, cardKind: CardKind): CardSeed {
  return `${noteId}|${cardKind}`;
}

function toFsrsCardState(row: CardStateRow): FsrsCardState | null {
  if (
    row.state === null || row.stability === null || row.difficulty === null ||
    row.lastReview === null || row.due === null
  ) {
    // A row with FSRS fields still null (e.g. suspended-before-first-review) is
    // "new" to the scheduler, identically to no row existing at all. `lastReview`
    // and `due` are checked too, defensively: a real row from buildReviewMutation
    // always sets every one of these together, but ts-fsrs throws on a null date
    // rather than treating it as "unknown," and this function's job is to never
    // hand it one — caught by a test building exactly that (otherwise impossible)
    // partially-null shape.
    return null;
  }
  return {
    due: row.due as Date,
    stability: row.stability,
    difficulty: row.difficulty,
    state: row.state,
    reps: row.reps,
    lapses: row.lapses,
    lastReview: row.lastReview as Date,
  };
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(Math.round((b.getTime() - a.getTime()) / MS_PER_DAY), 0);
}

/** Merges a partial change into whatever `card_state` currently is (or nothing, for
 * a genuinely new card), touching only the fields present in `patch`. This is the
 * one place that has to know a missing row and an all-null row mean the same thing.
 * `cardKind` (D17) is part of the row's identity, not a patchable field — a review
 * or suspend action always knows up front which of a note's (one or two) cards
 * it's touching. */
export function mergeCardState(
  current: CardStateRow | null,
  noteId: string,
  cardKind: CardKind,
  patch: Partial<Omit<CardStateRow, "noteId" | "cardKind">>,
): CardStateRow {
  const base: CardStateRow = current ?? {
    noteId,
    cardKind,
    due: null,
    stability: null,
    difficulty: null,
    state: null,
    reps: 0,
    lapses: 0,
    lastReview: null,
    suspended: false,
    lastUserId: null,
  };
  return { ...base, ...patch };
}

/**
 * Applies one answer to a card. Returns the `reviews` row to insert and the
 * resulting `card_state` row to upsert — never touches `suspended`, per this
 * module's docstring: answering a suspended card (which the due queue would never
 * have offered in the first place, but a stale client tab could still submit for)
 * does not implicitly unsuspend it.
 */
export function buildReviewMutation(
  current: CardStateRow | null,
  input: ReviewInput,
  params: FsrsSchedulerParams,
): { reviewRow: ReviewRow; cardStateRow: CardStateRow } {
  const priorFsrsState = current ? toFsrsCardState(current) : null;
  const nextFsrsState = applyReview(
    priorFsrsState,
    { reviewedAt: input.reviewedAt, rating: input.rating },
    params,
    cardSeed(input.noteId, input.cardKind),
  );

  const elapsedDays = priorFsrsState
    ? daysBetween(priorFsrsState.lastReview, input.reviewedAt)
    : 0;
  const scheduledDays = daysBetween(input.reviewedAt, nextFsrsState.due);

  const reviewRow: ReviewRow = {
    id: input.reviewId,
    noteId: input.noteId,
    cardKind: input.cardKind,
    userId: input.userId,
    rating: input.rating,
    reviewedAt: input.reviewedAt,
    elapsedDays,
    scheduledDays,
  };

  const cardStateRow = mergeCardState(current, input.noteId, input.cardKind, {
    due: nextFsrsState.due,
    stability: nextFsrsState.stability,
    difficulty: nextFsrsState.difficulty,
    state: nextFsrsState.state,
    reps: nextFsrsState.reps,
    lapses: nextFsrsState.lapses,
    lastReview: nextFsrsState.lastReview,
    lastUserId: input.userId,
  });

  return { reviewRow, cardStateRow };
}

/** Suspend or unsuspend. Creates a `card_state` row from nothing if the note has
 * never been reviewed — see types.ts's module docstring for why that's necessary
 * rather than a special case. */
export function buildSuspendMutation(
  current: CardStateRow | null,
  noteId: string,
  cardKind: CardKind,
  suspended: boolean,
): CardStateRow {
  return mergeCardState(current, noteId, cardKind, { suspended });
}

export interface NoteEditResult {
  valid: boolean;
  errors: string[];
  /** Only present when `valid` — the edit-in-place repair path (D11) never writes
   * a note that fails validation, full stop. */
  patch?: Partial<Omit<NoteRow, "id">>;
}

/**
 * Validates an edit-in-place submission (D11 — the one repair path for a wrong
 * card, since D10 skips an ingest review step). Deliberately narrow: this is field
 * hygiene, not translation quality — nothing here can catch a wrong-sense
 * translation, only a lemma someone accidentally emptied while fixing something
 * else.
 */
export function validateNoteEdit(patch: Partial<Omit<NoteRow, "id">>): NoteEditResult {
  const errors: string[] = [];

  if ("lemma" in patch && !patch.lemma?.trim()) {
    errors.push("lemma cannot be empty — a card needs something on its front");
  }
  if ("language" in patch && patch.language !== "uk" && patch.language !== "en") {
    errors.push(`language must be 'uk' or 'en', got ${JSON.stringify(patch.language)}`);
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [], patch };
}

/** The interval each of the four ratings would produce, computed without writing
 * anything — the number AnkiDroid shows above each button (its own "<10m" /
 * "4.1mo" style). `applyReview` is pure, so running it four times against the
 * same `current` and throwing three of the results away is the whole
 * implementation; there's no separate "preview mode" in the scheduler to call.
 *
 * Takes the card's identity rather than reading it off `current`, because
 * `current` is null for exactly the cards that need a preview most — a new one,
 * whose four buttons are the first thing anyone sees. Passing the same seed the
 * answer will use is what makes the number on the button a promise: fuzz is
 * seeded on `(card, reps)`, neither of which moves while someone is deciding. */
export interface IntervalPreview {
  again: Date;
  hard: Date;
  good: Date;
  easy: Date;
}

export function previewIntervals(
  current: CardStateRow | null,
  noteId: string,
  cardKind: CardKind,
  now: Date,
  params: FsrsSchedulerParams,
): IntervalPreview {
  const priorFsrsState = current ? toFsrsCardState(current) : null;
  const seed = cardSeed(noteId, cardKind);
  const due = (rating: 1 | 2 | 3 | 4) =>
    applyReview(priorFsrsState, { reviewedAt: now, rating }, params, seed).due;
  return { again: due(1), hard: due(2), good: due(3), easy: due(4) };
}
