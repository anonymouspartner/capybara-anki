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

import type { LeechAction } from "./leech.ts";

/** D17: a `Capybara+` note's real second Anki card, scheduled entirely
 * independently of its recall card (confirmed against a real export — separate
 * `cards` rows, separate revlog history). Every note that isn't `Capybara+` only
 * ever has a `'recall'` row; `'spelling'` only exists for notes with
 * `NoteRow.hasSpelling`. */
export type CardKind = "recall" | "spelling";

/**
 * The deck a *spelling* card lives in.
 *
 * Anki puts it there too, and that is the point: the `Capybara+` note type's
 * second template is pinned to the `Capybara::Spelling` deck, so a note's recall
 * card and its spelling card sit in **different decks** — confirmed against a
 * real export (244 cards under `Capybara::Spelling`, template #1). This app
 * originally derived a card's deck from its *note*, which quietly folded every
 * spelling card into Ukrainian or English and made the Spelling deck disappear
 * from a list that otherwise matched AnkiDroid's exactly.
 *
 * A constant rather than a column: `anki_notes.deck` describes the note, and a
 * note has only ever one of these cards, so "which deck is this card in" is a
 * pure function of `(note.deck, cardKind)` and needs nothing stored.
 */
export const SPELLING_DECK = "Spelling";

/**
 * Decks that hold both languages' cards, split per language when shown.
 *
 * Both people see every deck, and a card has one schedule shared by whoever
 * answers it (postgresStore.ts's class docstring). Ukrainian and English are
 * already one learner's each, but Spelling, Grammar and Pronunciation gathered
 * both languages into one queue, so studying one of them moved the other
 * person's cards too. Splitting them by language keeps each person's schedule
 * their own as long as they open their own decks — without storing anything:
 * `anki_notes.deck` keeps naming the topic ("Grammar"), `language` already says
 * whose it is, and capybara-bot keeps writing exactly what it writes today.
 */
const SPLIT_DECKS: ReadonlySet<string> = new Set(["Grammar", "Pronunciation"]);
const LANGUAGE_NAME: Record<"uk" | "en", string> = { uk: "Ukrainian", en: "English" };

/** Which deck a given card of a note belongs to. The one place that mapping
 * lives, so the deck list, the queue and the daily counts cannot disagree. */
export function deckOfCard(noteDeck: string, cardKind: CardKind, language: "uk" | "en"): string {
  const prefix = LANGUAGE_NAME[language];
  if (cardKind === "spelling") return `${prefix} ${SPELLING_DECK}`;
  if (SPLIT_DECKS.has(noteDeck)) return `${prefix} ${noteDeck}`;
  return noteDeck;
}

/** Which notes could have a card in `deck` — a query narrowing only; callers
 * still check every card with `deckOfCard`, which stays the one authority. A
 * split deck narrows by language alone, so a note stored under an
 * already-qualified name (say "English Pronunciation") is never filtered out
 * before that check sees it. */
export function notesForDeck(deck: string): { language?: "uk" | "en"; deck?: string } {
  for (const [language, name] of Object.entries(LANGUAGE_NAME) as Array<["uk" | "en", string]>) {
    if (!deck.startsWith(`${name} `)) continue;
    const topic = deck.slice(name.length + 1);
    if (topic === SPELLING_DECK || SPLIT_DECKS.has(topic)) return { language };
  }
  return { deck };
}

/** Which language a deck-list name belongs to -- "Ukrainian" and every
 * "Ukrainian <topic>" (the split decks deckOfCard produces, or a stored name
 * like "English Pronunciation") is uk, likewise for English. Anything else --
 * a deck named for neither language -- has none. The deck list groups rows by
 * this to show each person the decks of the language they're learning (see
 * PersonRow), since that grouping is exactly what keeps one person's schedule
 * from being spent by the other (postgresStore.ts's class docstring). */
export function languageOfDeck(deck: string): "uk" | "en" | undefined {
  for (const [language, name] of Object.entries(LANGUAGE_NAME) as Array<["uk" | "en", string]>) {
    if (deck === name || deck.startsWith(`${name} `)) return language;
  }
  return undefined;
}

/** One of the people this collection belongs to -- the `users` rows
 * capybara-bot provisions, reduced to what the deck list shows. */
export interface PersonRow {
  id: string;
  displayName: string | null;
  learningLanguage: string | null;
}

/** D18: what kind of thing a note is, for the reviewer UI's sake — not a
 * different table, since a real export's `Capybara Pronunciation (shadowing)`
 * note type's fields map directly onto the existing vocabulary columns
 * (`TargetText`→`lemma`, `ReferenceAudio`→`audioUrl`, `Translation`→
 * `lemmaTranslation`, `Hint`→`gloss`). `'vocab'` is the default and everything
 * built before D18 implicitly assumed it. */
export type NoteKind = "vocab" | "pronunciation";

/** One row of `card_state`, now identified by `(noteId, cardKind)` rather than
 * `noteId` alone (D17) — a `Capybara+` note has two independent rows, everything
 * else has exactly one, always `cardKind: 'recall'`. FSRS fields are null for a
 * card with no `card_state` row at all (never reviewed, never suspended) —
 * callers should treat "no row" and "a row with every FSRS field null" the same
 * way; both mean "new." */
export interface CardStateRow {
  noteId: string;
  cardKind: CardKind;
  due: Date | null;
  stability: number | null;
  difficulty: number | null;
  state: 0 | 1 | 2 | 3 | null;
  reps: number;
  lapses: number;
  lastReview: Date | null;
  /** ts-fsrs's per-card (re)learning-step counter — see FsrsCardState's docstring
   * (src/fsrs/types.ts). 0 for a never-reviewed or already-graduated card, same
   * default-before-any-answer convention as `reps`/`lapses`. */
  learningStep: number;
  suspended: boolean;
  /** D12's third action: hidden from the due queue until the study day rolls
   * over, then automatically visible again — no unbury step, no cron job.
   * Stored as the `ankiDayKey` (day.ts) it was buried on, not a boolean or an
   * expiry instant: "still buried" is exactly "buried on today's key," which a
   * caller with the right `DayBoundary` can always re-derive, and comparing keys
   * is what keeps every day-boundary computation in this app DST-safe (day.ts's
   * own docstring). `null` means not buried. Distinct from `suspended`, which is
   * indefinite and a person's own decision — a stats screen counting suspended
   * cards must not also count buried ones. */
  buriedOn: string | null;
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
 * `Capybara::Grammar` needed nothing beyond this: confirmed against a real export
 * (D17/§11 item 4) to be plain vocabulary notes, just filed under a different deck.
 *
 * `kind` (D18) and `hasSpelling` (D17) are the two things a real export's richer
 * deck list turned out to need: `kind: 'pronunciation'` reuses these same columns
 * for a `Capybara Pronunciation (shadowing)` note (see `NoteKind`'s docstring for
 * the field mapping) rather than adding a parallel table, and `hasSpelling` marks
 * which vocabulary notes are real `Capybara+` notes that also produce a `Spelling`
 * card (`CardKind`). Both default to the every-other-note case (`'vocab'`, `false`)
 * so every note created before D17/D18 existed needs no backfill to keep meaning
 * the same thing. */
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
  kind: NoteKind;
  hasSpelling: boolean;
}

/** A note not yet in `notes` — what `/scan` (step 5, docs/DESIGN.md §4.1) and the
 * add-a-card screen (Phase 5.2, `handlers.ts`'s `addCard`) insert directly, per
 * D10 ("no ingest review step"): scan or type, then edit-in-place (D11) as the
 * only repair path afterward. `source` is the one field `NoteRow` deliberately
 * omits (provenance the reviewer has no reason to touch) but that a real insert
 * always has an opinion about. */
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
  kind: NoteKind;
  hasSpelling: boolean;
  /** 'app': typed directly into the reviewer's own add-a-card screen — distinct
   * from 'bot' (capybara-bot's /learn) and 'scan' (a photographed page), the two
   * existing "a person deliberately chose this word" sources, because provenance
   * is a property of which pipeline wrote the row, not something to overload an
   * existing value for. */
  source: "scan" | "bot" | "anki-import" | "app";
}

/** What the due-queue selector needs to know about one *card* (D17: a note with
 * `hasSpelling` contributes two of these, one per `CardKind`) — a projection of
 * `NoteRow` + `CardStateRow`, not a new source of truth. */
export interface DueCandidate {
  noteId: string;
  cardKind: CardKind;
  due: Date | null;
  state: 0 | 1 | 2 | 3 | null;
  suspended: boolean;
  /** Resolved, not raw: "is `CardStateRow.buriedOn` today's `ankiDayKey`," decided
   * by whichever `Store` method builds this candidate (it has `now` and the
   * user's `DayBoundary` on hand; dueQueue.ts, which consumes this, deliberately
   * does not). A bury that expired at this study day's rollover is already
   * `false` here — dueQueue.ts never re-derives it and never sees the raw key. */
  buried: boolean;
}

/** Identifies one due card — `dueQueue.ts`'s output unit. Just `noteId` stopped
 * being unique the moment D17 gave a `Capybara+` note two independently-due cards;
 * `noteId` alone was `selectDueQueue`'s return type before that. */
export interface DueItem {
  noteId: string;
  cardKind: CardKind;
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
  /** See `FsrsSchedulerParams.learningSteps` (src/fsrs/types.ts) for what `null`
   * vs. a real `[]` each mean. */
  learningSteps: number[] | null;
  dailyNewLimit: number;
  dailyReviewLimit: number;
  maxInterval: number;
  /** IANA zone name deciding when this person's study day rolls over (see
   * day.ts). Per-user rather than per-instance because the two halves of a
   * couple learning each other's languages are not reliably in the same country.
   * `null` means UTC, which is what every row meant before this column existed. */
  timeZone: string | null;
  /** Local hour the day rolls over at, 0-23. Anki's default is 4. */
  rolloverHour: number;
  /** Lapses before a card is called a leech; 0 disables the check. Anki's
   * default is 8. See leech.ts. */
  leechThreshold: number;
  /** What crossing that threshold does. Anki's default, and this one, is to say
   * so without changing the card's scheduling. */
  leechAction: LeechAction;
}

/** What submitting an answer to one card provides — everything the caller (an
 * authenticated HTTP request) knows before any database lookup happens. */
export interface ReviewInput {
  /** Client-generated — see docs/DESIGN.md §4.2. Makes a retried submission an
   * idempotent no-op rather than a duplicate. */
  reviewId: string;
  noteId: string;
  /** Which of the note's (one or two, D17) cards this answers. */
  cardKind: CardKind;
  userId: string;
  rating: 1 | 2 | 3 | 4;
  reviewedAt: Date;
}

/** One row of `reviews`, ready to insert. */
export interface ReviewRow {
  id: string;
  noteId: string;
  cardKind: CardKind;
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
