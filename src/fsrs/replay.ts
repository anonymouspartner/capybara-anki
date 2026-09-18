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

import { createEmptyCard, FSRS, fsrs, generatorParameters, StrategyMode } from "ts-fsrs";
import type { StepUnit } from "ts-fsrs";
import type { FsrsCardState, FsrsSchedulerParams, ReviewEvent } from "./types.ts";

/** `FsrsSchedulerParams.learningSteps` stores plain minutes (matching
 * `anki_scheduler_config.learning_steps`'s real-Anki shape); ts-fsrs wants
 * `StepUnit` strings (`"1m"`). Minutes-only because that's the only unit this
 * app has ever stored or needed — Anki's own step config can express hours/days
 * too, but nothing here has had a reason to. */
function toStepUnits(minutes: number[]): StepUnit[] {
  return minutes.map((m) => `${m}m` as StepUnit);
}

/**
 * Stable identity for one card, used to seed interval fuzz (see `buildScheduler`).
 * Opaque here on purpose — this module has no concept of a note id (see types.ts),
 * it only needs a string that names the same card every time.
 * `src/review/mutations.ts` is what knows how to build one.
 */
export type CardSeed = string;

function buildScheduler(params: FsrsSchedulerParams, fuzzSeed?: string): FSRS {
  const scheduler = fsrs(
    generatorParameters({
      w: params.fsrsParams,
      request_retention: params.desiredRetention,
      maximum_interval: params.maxInterval,
      // Fuzz spreads cards answered together across nearby days instead of
      // stacking them all on one. Without it, every card leaving learning on the
      // same rating gets the identical interval and they come back as one lump:
      // measured against ts-fsrs 4.7's defaults, 40 new cards learned in one
      // session all land on a single day, vs. three days with fuzz on. ts-fsrs
      // implements Anki's own fuzz ranges exactly (checked value-by-value against
      // rslib/src/scheduler/states/fuzz.rs: 4d→[3,5], 14d→[12,16], 125d→[117,133],
      // and nothing under 2.5d is fuzzed at all).
      //
      // It is only safe to enable because the seed below makes it a pure function
      // of the card's stored state, NOT a random draw — §4.3's "card_state is a
      // fold over reviews" still holds, and replay.test.ts asserts exactly that.
      enable_fuzz: fuzzSeed !== undefined,
      // `null` (never configured) is left out entirely so ts-fsrs's own built-in
      // default applies; a real `[]` is passed through as-is — see this field's
      // docstring in types.ts for why those two are not the same thing.
      ...(params.learningSteps !== null ? { learning_steps: toStepUnits(params.learningSteps) } : {}),
    }),
  );
  if (fuzzSeed !== undefined) {
    // ts-fsrs' default seed mixes in the review timestamp, which would make the
    // interval shown on a rating button differ from the one the answer actually
    // gets (the seconds the reader spent deciding would change it). Anki seeds
    // from (card id, reps) instead — "a consistent seed for a given card at a
    // given number of reps", rslib/src/scheduler/answering/mod.rs — so the same
    // card at the same point in its history always fuzzes the same way. The
    // caller builds that seed; this only pins it in place.
    scheduler.useStrategy(StrategyMode.SEED, () => fuzzSeed);
  }
  return scheduler;
}

/**
 * Anki's fuzz seed is `(card id, reps)`, not the card id alone — otherwise a card
 * would land on the same side of its fuzz range at every single review, and the
 * small biases would compound over a card's life. `reps` is read off the card
 * being scheduled, so a replay reproduces the same sequence of seeds the original
 * scheduling ran with.
 *
 * With no `cardSeed` there is nothing stable to seed from, so fuzz stays off and
 * one scheduler serves every review in the loop.
 */
function schedulerFactory(
  params: FsrsSchedulerParams,
  cardSeed?: CardSeed,
): (reps: number) => FSRS {
  if (cardSeed === undefined) {
    const scheduler = buildScheduler(params);
    return () => scheduler;
  }
  return (reps) => buildScheduler(params, `${cardSeed}|${reps}`);
}

function toFsrsCardState(card: {
  due: Date;
  stability: number;
  difficulty: number;
  state: number;
  reps: number;
  lapses: number;
  last_review?: Date;
  learning_steps: number;
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
    learningStep: card.learning_steps,
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
    learning_steps: state.learningStep,
  };
}

function applyReviewWith(
  makeScheduler: (reps: number) => FSRS,
  current: FsrsCardState | null,
  review: ReviewEvent,
): FsrsCardState {
  const card = current === null ? createEmptyCard(review.reviewedAt) : toFsrsCard(current);
  const result = makeScheduler(card.reps).next(card, review.reviewedAt, review.rating);
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
 *
 * `cardSeed` opts this card into Anki's interval fuzz — see `buildScheduler`.
 * Omitting it schedules the unfuzzed interval, which is what a caller with no
 * stable per-card identity to seed from should do.
 */
export function applyReview(
  current: FsrsCardState | null,
  review: ReviewEvent,
  params: FsrsSchedulerParams,
  cardSeed?: CardSeed,
): FsrsCardState {
  return applyReviewWith(schedulerFactory(params, cardSeed), current, review);
}

/**
 * Rebuilds a note's entire `card_state` from its full review history. `reviews`
 * does not need to arrive pre-sorted — it's sorted here, defensively, because
 * getting this wrong silently produces a plausible-looking but wrong card state
 * (FSRS is order-sensitive) rather than an error.
 *
 * Returns `null` for a note with no reviews at all — a genuinely new card has no
 * `card_state` row yet rather than a row full of zeros pretending to mean something.
 *
 * `cardSeed` must be the same one the card's reviews were originally scheduled
 * with, or the rebuilt state will be a plausible but different card — that
 * equivalence is what §4.3 rests on, and replay.test.ts asserts it directly.
 */
export function replayCardState(
  reviews: ReviewEvent[],
  params: FsrsSchedulerParams,
  cardSeed?: CardSeed,
): FsrsCardState | null {
  if (reviews.length === 0) return null;
  const sorted = [...reviews].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
  const makeScheduler = schedulerFactory(params, cardSeed);
  let state: FsrsCardState | null = null;
  for (const review of sorted) {
    state = applyReviewWith(makeScheduler, state, review);
  }
  return state;
}
