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
 * has no reason to touch.
 *
 * `deck` was added after the fact, not in the original design doc sketch: the
 * schema had no deck concept at all until a real look at AnkiDroid's own deck list
 * (Ukrainian / English / Grammar / Spelling / Pronunciation) made clear that
 * "browse by deck" is core to how this is actually used, not a detail. It's a
 * free-text label, not a foreign key to a decks table — Anki itself treats a deck
 * as just a path string on a card, and nothing here needs more than that yet.
 * Only decks whose notes share the Capybara vocabulary schema (lemma/gloss/…) are
 * reviewable by this app today; Spelling and Pronunciation are different note
 * shapes entirely (§7.5 finding 5) and aren't representable here regardless of
 * this field. */
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
  deck: string;
}

/** A note not yet in `notes` — what `/scan` (step 5, docs/DESIGN.md §4.1) inserts
 * directly, per D10 ("no ingest review step"): scan, extract, import, with
 * edit-in-place (D11) as the only repair path afterward. `source` is the one field
 * `NoteRow` deliberately omits (provenance the reviewer has no reason to touch) but
 * that a real insert always has an opinion about. */
export interface NewNote {
  lemma: string;
  gloss: string | null;
  lemmaTranslation: string | null;
  partOfSpeech: string | null;
  language: "uk" | "en";
  example: string | null;
  exampleTranslation: string | null;
  audioUrl: string | null;
  deck: string;
  source: "scan" | "bot" | "anki-import";
}

/** What the due-queue selector needs to know about one note — a projection of
 * `NoteRow` + `CardStateRow`, not a new source of truth. */
export interface DueCandidate {
  noteId: string;
  due: Date | null;
  state: 0 | 1 | 2 | 3 | null;
  suspended: boolean;
}

/** Per-deck due counts for the deck-list screen — the same three-bucket
 * categorization `selectDueQueue` uses (learning/relearning, review, new),
 * summarized as counts instead of an ordered id list. */
export interface QueueSummary {
  learningCount: number;
  reviewCount: number;
  newCount: number;
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

/** How many notes sit in each scheduling bucket right now, across every deck —
 * the stats screen's collection-composition breakdown (step 6, docs/DESIGN.md §9).
 * Distinct from `QueueSummary`: that's "what's due today," this is "what state is
 * every card actually in," so a mature review card that isn't due yet still counts
 * here. `suspendedCount` overlaps the other three rather than excluding from them
 * (a suspended card is still new, learning, or review — suspension is orthogonal to
 * scheduling state, same as everywhere else in this codebase, e.g. `dueQueue.ts`). */
export interface StateCounts {
  newCount: number;
  learningCount: number;
  reviewCount: number;
  suspendedCount: number;
}

/** One day's reviews, split by rating — the stats screen's activity histogram.
 * `date` is a `YYYY-MM-DD` UTC day key, the same day-boundary simplification
 * `store.ts`'s `getDailyCounts` already makes (docs/DESIGN.md §11 open question 3
 * on real day-rollover times is unresolved either way, and this doesn't newly
 * depend on it). */
export interface DailyReviewCount {
  date: string;
  again: number;
  hard: number;
  good: number;
  easy: number;
}
