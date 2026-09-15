/**
 * `card_state` is a fold over the `reviews` log — docs/DESIGN.md §4.3, the safety
 * property the whole app leans on. This module is that fold, and its inverse: apply
 * one more review to an existing state.
 *
 * Two entry points, both pure (no I/O, no Postgres, no Supabase client):
 *
 * - `replayCardState` — the cache-rebuild path. Given every review a note has ever
 *   had, in order, produces the `card_state` row from scratch. This is what proves
 *   §4.3's claim: run it after a bad migration, an FSRS version bump, or a bug fix,
 *   and `card_state` is correct again with no data lost, because it was never the
 *   truth to begin with.
 * - `applyReview` — the hot path. An ingest function calling this for every new
 *   review would be wasteful; `applyReview` advances an already-known card state by
 *   exactly one review instead. `replayCardState` is built on top of it (a `reduce`
 *   starting from "no card yet"), which is also the property under test in
 *   replay.test.ts: replaying from scratch and applying incrementally must always
 *   agree, or the "cache, not the truth" argument stops holding.
 *
 * What this deliberately does NOT decide:
 *
 * - `suspended` is not part of this fold at all. Suspending a card is a UI action
 *   (D12), not a scheduling computation — there is nothing about a rating history
 *   that determines whether a card is suspended, so replaying reviews must never
 *   touch it. A caller merges `replayCardState`'s output with whatever the current
 *   `suspended` value already is; this module doesn't know it exists.
 * - `note_id` / `last_user_id` are the caller's business, not the algorithm's — a
 *   `ReviewEvent` here is just (when, how well), nothing about whose card it is.
 */

import { createEmptyCard, FSRS, fsrs, generatorParameters } from "ts-fsrs";
import type { FsrsCardState, FsrsSchedulerParams, ReviewEvent } from "./types.ts";

function buildScheduler(params: FsrsSchedulerParams): FSRS {
  return fsrs(
    generatorParameters({
      w: params.fsrsParams,
      request_retention: params.desiredRetention,
      maximum_interval: params.maxInterval,
      enable_fuzz: false, // fuzz exists to spread reviews across a UI session; a
      // replay is reconstructing history, not scheduling a future review, so any
      // randomness here would make two replays of the same log disagree.
    }),
  );
}

function toFsrsCardState(card: {
  due: Date;
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  last_review?: Date;
}): FsrsCardState {
  return {
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    state: card.state as FsrsCardState["state"],
    reps: card.reps,
    lapses: card.lapses,
    // Always set after any real review — createEmptyCard's fresh card is the only
    // shape without one, and that path never reaches here (applyReviewWith always
    // calls next() first, which stamps last_review onto its result).
    lastReview: card.last_review as Date,
  };
}

/** Rebuilds a full ts-fsrs `Card` from a stored `FsrsCardState`. `elapsed_days` and
 * `scheduled_days` are set to 0 here and never trusted by ts-fsrs on a resumed card
 * — it recomputes both from `last_review` vs. the new review's date instead
 * (verified directly against the installed version), so there's nothing real to
 * reconstruct for them. */
function toFsrsCard(state: FsrsCardState) {
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    state: state.state,
    reps: state.reps,
    lapses: state.lapses,
    last_review: state.lastReview,
    elapsed_days: 0,
    scheduled_days: 0,
  };
}

function applyReviewWith(
  scheduler: FSRS,
  current: FsrsCardState | null,
  review: ReviewEvent,
): FsrsCardState {
  const card = current === null ? createEmptyCard(review.reviewedAt) : toFsrsCard(current);
  const result = scheduler.next(card, review.reviewedAt, review.rating);
  return toFsrsCardState(result.card);
}

/**
 * Advances `current` (or a fresh, never-reviewed card if `current` is null) by
 * exactly one review. `current` must be the real result of the review immediately
 * before this one — see the module docstring's note on the ordering invariant this
 * relies on.
 *
 * Builds a scheduler per call, deliberately: this is the path an ingest function
 * calls once per incoming review, where that cost is negligible. `replayCardState`
 * below has the hot-loop version that builds it once.
 */
export function applyReview(
  current: FsrsCardState | null,
  review: ReviewEvent,
  params: FsrsSchedulerParams,
): FsrsCardState {
  return applyReviewWith(buildScheduler(params), current, review);
}

/**
 * Rebuilds a note's entire `card_state` from its full review history. `reviews`
 * does not need to arrive pre-sorted — it's sorted here, defensively, because
 * getting this wrong silently produces a plausible-looking but wrong card state
 * (FSRS is order-sensitive) rather than an error.
 *
 * Returns `null` for a note with no reviews at all — a genuinely new card has no
 * `card_state` row yet rather than a row full of zeros pretending to mean something.
 */
export function replayCardState(
  reviews: ReviewEvent[],
  params: FsrsSchedulerParams,
): FsrsCardState | null {
  if (reviews.length === 0) return null;
  const sorted = [...reviews].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
  const scheduler = buildScheduler(params);
  let state: FsrsCardState | null = null;
  for (const review of sorted) {
    state = applyReviewWith(scheduler, state, review);
  }
  return state;
}
