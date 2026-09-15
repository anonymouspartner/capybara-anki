/**
 * Types for the reviewer's server-side logic (step 2, docs/DESIGN.md §9). A
 * deliberate TypeScript mirror of `supabase/migrations/20260915210000_capybara_anki_schema.sql`
 * — same relationship to that file as `src/fsrs/types.ts` has to `migration/schema.py`:
 * kept in sync by hand, the SQL is the source of truth.
 *
 * One thing this file's shapes reveal that the design doc's original sketch didn't
 * anticipate: **`CardStateRow` can exist with every FSRS field null.** §4.3 describes
 * `card_state` as "a fold over reviews," which is true of the FSRS-derived columns
 * (due/stability/difficulty/state/reps/lapses/lastReview) — but `suspended` is not
 * derived from reviews at all (see src/fsrs/replay.ts's docstring), and a card can be
 * suspended before its first review ever happens. So a row can exist purely to carry
 * `suspended = true` on a note nobody has studied yet, with every FSRS field null.
 * `mutations.ts`'s `mergeCardState` is what makes that safe: it only ever changes the
 * fields a given action actually determines, never wipes the rest.
 */

/** One row of `card_state`. FSRS fields are null for a note with no `card_state`
 * row at all (never reviewed, never suspended) — callers should treat "no row" and
 * "a row with every FSRS field null" the same way; both mean "new." */
export interface CardStateRow {
  noteId: string;
  due: Date | null;
  stability: number | null;
  difficulty: number | null;
  state: 0 | 1 | 2 | 3 | null;
  reps: number;
  lapses: number;
  lastReview: Date | null;
  suspended: boolean;
  lastUserId: string | null;
}

/** One row of `notes`. Only the fields the reviewer actually displays or edits —
 * `ankiGuid`/`source`/`createdAt` are migration/provenance concerns the review UI
 * has no reason to touch. */
export interface NoteRow {
  id: string;
  lemma: string;
  gloss: string | null;
  lemmaTranslation: string | null;
  partOfSpeech: string | null;
  language: "uk" | "en";
  example: string | null;
  exampleTranslation: string | null;
  audioUrl: string | null;
}

/** What the due-queue selector needs to know about one note — a projection of
 * `NoteRow` + `CardStateRow`, not a new source of truth. */
export interface DueCandidate {
  noteId: string;
  due: Date | null;
  state: 0 | 1 | 2 | 3 | null;
  suspended: boolean;
}

/** How many of each kind this user has already reviewed today — the daily-limit
 * inputs `selectDueQueue` needs but has no way to compute itself (that's a query
 * over `reviews`, which makes it the caller's job, not this pure function's). */
export interface DailyCounts {
  newTakenToday: number;
  reviewTakenToday: number;
}

/** The subset of `scheduler_config` the due-queue selector consumes. Distinct from
 * `FsrsSchedulerParams` (src/fsrs/types.ts) on purpose: replay needs the FSRS-tuning
 * fields, queue selection needs the daily-limit fields — a function's parameter
 * type should say what it actually uses, not "the whole config row." */
export interface QueueLimits {
  dailyNewLimit: number;
  dailyReviewLimit: number;
}

/** One full row of `scheduler_config` — what the store actually reads from
 * Postgres in a single round trip. `FsrsSchedulerParams` and `QueueLimits` are
 * both projections of this, taken by whichever function needs which half. */
export interface SchedulerConfigRow {
  userId: string;
  fsrsParams: number[];
  desiredRetention: number;
  learningSteps: number[];
  dailyNewLimit: number;
  dailyReviewLimit: number;
  maxInterval: number;
}

/** What submitting an answer to one card provides — everything the caller (an
 * authenticated HTTP request) knows before any database lookup happens. */
export interface ReviewInput {
  /** Client-generated — see docs/DESIGN.md §4.2. Makes a retried submission an
   * idempotent no-op rather than a duplicate. */
  reviewId: string;
  noteId: string;
  userId: string;
  rating: 1 | 2 | 3 | 4;
  reviewedAt: Date;
}

/** One row of `reviews`, ready to insert. */
export interface ReviewRow {
  id: string;
  noteId: string;
  userId: string;
  rating: 1 | 2 | 3 | 4;
  reviewedAt: Date;
  elapsedDays: number;
  scheduledDays: number;
}
