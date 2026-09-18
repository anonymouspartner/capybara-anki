/**
 * Types shared by the FSRS replay logic — a deliberate TypeScript mirror of the
 * dataclasses in `migration/schema.py`. Kept in sync by hand, not by codegen: the
 * two sides are read by different languages for different reasons (migration reads
 * Anki; this reads/writes Postgres), and a generator would be more machinery than
 * the two files are worth. Field names match `docs/DESIGN.md` §5 in both places —
 * that's the shared source of truth, not either file.
 */

/** One row of `reviews` — see docs/DESIGN.md §5. Only the fields replay.ts actually
 * needs; `id`/`note_id`/`user_id`/`ingested_at` matter to the database, not to FSRS. */
export interface ReviewEvent {
  reviewedAt: Date;
  /** 1 Again | 2 Hard | 3 Good | 4 Easy — matches ts-fsrs's Rating enum values
   * exactly, which in turn matches Anki's own revlog.ease encoding. No translation
   * needed anywhere in this pipeline, verified against a real export. */
  rating: 1 | 2 | 3 | 4;
}

/** The FSRS-derived subset of `card_state` — due/stability/difficulty/state/reps/
 * lapses/lastReview. Deliberately does NOT include `note_id`, `last_user_id`, or
 * `suspended`: the first two are the caller's business, not the algorithm's, and
 * `suspended` is not derived from the reviews log at all — see replay.ts's module
 * docstring.
 *
 * `lastReview` matters more than it looks: ts-fsrs's own `next()` derives elapsed
 * time from it (verified directly — `elapsed_days`/`scheduled_days` on a resumed
 * card are recomputed from `lastReview` vs. the new review's date and the *input*
 * values are ignored even when deliberately wrong), so it's the one field, beyond
 * the obviously-needed memory state, that correctly resuming a card actually
 * requires storing. Real Anki agrees: a card's own memory-state JSON carries an
 * `lrt` (last-review-time) field for the same reason — found while reading a real
 * export during the migration spike. */
export interface FsrsCardState {
  due: Date;
  stability: number;
  difficulty: number;
  /** 0 New | 1 Learning | 2 Review | 3 Relearning */
  state: 0 | 1 | 2 | 3;
  reps: number;
  lapses: number;
  lastReview: Date;
  /** ts-fsrs's own per-card counter of which (re)learning step this card is
   * currently on — an index into `FsrsSchedulerParams.learningSteps`, not a
   * duration. 0 once graduated to Review, and 0 before a card's first review.
   * Added in ts-fsrs 5.0 alongside FSRS-6; must round-trip through storage like
   * every other field here — resuming a card mid-steps without it silently
   * restarts it at step 0 instead of continuing where it left off (verified
   * directly: omitting it and rebuilding via `createEmptyCard`'s default is
   * indistinguishable from a fresh card to the scheduler). */
  learningStep: number;
}

/** The subset of `scheduler_config` that FSRS itself consumes. `learning_steps`,
 * `daily_new_limit`, and `daily_review_limit` are real columns (§5) but they govern
 * queue *selection*, not a card's memory state — out of scope for replay, in scope
 * for the reviewer (step 2). */
export interface FsrsSchedulerParams {
  /** Anki's convention, confirmed against a real export: an empty array means "no
   * personalized weights yet, use the built-in defaults" — ts-fsrs implements that
   * same fallback itself (verified: an empty or wrong-length array auto-fills), so
   * this can be passed straight through without special-casing here. */
  fsrsParams: number[];
  desiredRetention: number;
  maxInterval: number;
  /** Anki's (re)learning steps, in minutes (e.g. `[1, 10]`) — real Anki data, per
   * Anki's own convention, confirmed against a real export: an explicit `[]` means
   * "no short-term steps, FSRS manages timing entirely" (verified directly: a new
   * card graduates straight to Review on its first Good) and is passed through as
   * such, not treated as missing. `null` means this was never configured at all —
   * distinct from a real `[]` — and ts-fsrs's own built-in default (`1m, 10m`)
   * applies instead. */
  learningSteps: number[] | null;
}
