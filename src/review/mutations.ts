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
import { DEFAULT_LEECH_ACTION, DEFAULT_LEECH_THRESHOLD, isLeechAt, type LeechAction } from "./leech.ts";
import type { FsrsCardState, FsrsSchedulerParams } from "../fsrs/types.ts";
import type { CardKind, CardStateRow, NoteRow, ReviewInput, ReviewRow, SchedulerConfigRow } from "./types.ts";

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
    learningStep: row.learningStep,
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
    learningStep: 0,
    suspended: false,
    buriedOn: null,
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
export interface LeechPolicy {
  threshold: number;
  action: LeechAction;
}

export const DEFAULT_LEECH_POLICY: LeechPolicy = {
  threshold: DEFAULT_LEECH_THRESHOLD,
  action: DEFAULT_LEECH_ACTION,
};

/** The sibling to bury and the `ankiDayKey` to bury it on — Anki's automatic
 * "bury siblings" (rslib/src/scheduler/answering/mod.rs): answering one of a
 * `Capybara+` note's two independent cards (D17) hides the other until the
 * study day rolls over, so a session never shows recall and spelling of the
 * same word back to back. Optional because most notes (`hasSpelling: false`)
 * have no sibling to bury at all — the caller (`handlers.ts`, which already
 * knows the note and the day boundary) decides whether one applies; this
 * module stays a pure state transition either way. */
export interface SiblingBury {
  current: CardStateRow | null;
  noteId: string;
  cardKind: CardKind;
  buriedOn: string;
}

export function buildReviewMutation(
  current: CardStateRow | null,
  input: ReviewInput,
  params: FsrsSchedulerParams,
  leech: LeechPolicy = DEFAULT_LEECH_POLICY,
  sibling?: SiblingBury,
): { reviewRow: ReviewRow; cardStateRow: CardStateRow; becameLeech: boolean; siblingCardStateRow?: CardStateRow } {
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

  // Only an answer that actually *added* a lapse can make a card a leech.
  // Testing the count alone would re-announce on every subsequent Good, since a
  // card parked at 8 lapses still reads as "at threshold" forever. Anki avoids
  // this structurally — it only evaluates the rule inside answer_again — and
  // comparing against the prior count is how that reads here, where one function
  // handles all four ratings.
  const priorLapses = priorFsrsState?.lapses ?? 0;
  const becameLeech = nextFsrsState.lapses > priorLapses &&
    isLeechAt(nextFsrsState.lapses, leech.threshold);

  const cardStateRow = mergeCardState(current, input.noteId, input.cardKind, {
    due: nextFsrsState.due,
    stability: nextFsrsState.stability,
    difficulty: nextFsrsState.difficulty,
    state: nextFsrsState.state,
    reps: nextFsrsState.reps,
    lapses: nextFsrsState.lapses,
    lastReview: nextFsrsState.lastReview,
    learningStep: nextFsrsState.learningStep,
    lastUserId: input.userId,
    // 'tag' changes no scheduling — the announcement is the whole action (see
    // leech.ts). Only 'suspend' touches the card, and it never *un*suspends:
    // `suspended: false` is not written here, so a card suspended by hand stays
    // that way regardless of what the leech rule says.
    ...(becameLeech && leech.action === "suspend" ? { suspended: true } : {}),
  });

  const siblingCardStateRow = sibling
    ? buildBuryMutation(sibling.current, sibling.noteId, sibling.cardKind, sibling.buriedOn)
    : undefined;

  return { reviewRow, cardStateRow, becameLeech, siblingCardStateRow };
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

/** Bury (pass today's `ankiDayKey`) or unbury (pass `null`) — the manual half of
 * D12's third action. `buriedOn` is the caller's to compute (see
 * `CardStateRow.buriedOn`'s docstring on why this module stays unaware of
 * `DayBoundary`); `buildReviewMutation`'s `sibling` option is the automatic half,
 * for Anki's own "bury siblings" behaviour. */
export function buildBuryMutation(
  current: CardStateRow | null,
  noteId: string,
  cardKind: CardKind,
  buriedOn: string | null,
): CardStateRow {
  return mergeCardState(current, noteId, cardKind, { buriedOn });
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

/** The fields the settings screen (Phase 5.3) can change — the "SQL-only" gap
 * §4's table named: daily limits, retention, rollover, timezone, leech
 * threshold/action. Deliberately excludes `fsrsParams`/`maxInterval`/
 * `learningSteps`: nothing in §4 asked for those to become editable, and a
 * mistyped weight vector is a much sharper edge than a mistyped limit. */
export type SettingsPatch = Partial<
  Pick<
    SchedulerConfigRow,
    | "dailyNewLimit"
    | "dailyReviewLimit"
    | "desiredRetention"
    | "timeZone"
    | "rolloverHour"
    | "leechThreshold"
    | "leechAction"
  >
>;

export interface SettingsEditResult {
  valid: boolean;
  errors: string[];
  /** Only present when `valid` — same "never write something that failed
   * validation" rule as `NoteEditResult.patch`. */
  patch?: SettingsPatch;
}

/** Sanity bound on a time zone string, not a real IANA-name validator — the
 * actual check is handing it to `Intl` and seeing whether it throws. */
const TIME_ZONE_MAX_LENGTH = 64;

/**
 * Validates a settings-screen submission. Field hygiene only, same spirit as
 * `validateNoteEdit`: catches a value that would corrupt scheduling (a
 * retention outside FSRS's valid range, a rollover hour that isn't a real
 * hour) rather than second-guessing a deliberate choice (a daily limit of 0 is
 * a real thing to want — it means "review nothing new today").
 */
export function validateSettingsEdit(patch: SettingsPatch): SettingsEditResult {
  const errors: string[] = [];

  if ("dailyNewLimit" in patch && !(Number.isInteger(patch.dailyNewLimit) && patch.dailyNewLimit! >= 0)) {
    errors.push("daily new limit must be a whole number, 0 or more");
  }
  if ("dailyReviewLimit" in patch && !(Number.isInteger(patch.dailyReviewLimit) && patch.dailyReviewLimit! >= 0)) {
    errors.push("daily review limit must be a whole number, 0 or more");
  }
  if (
    "desiredRetention" in patch &&
    !(typeof patch.desiredRetention === "number" && patch.desiredRetention > 0 && patch.desiredRetention < 1)
  ) {
    errors.push("desired retention must be a number between 0 and 1 (exclusive)");
  }
  if (
    "rolloverHour" in patch &&
    !(Number.isInteger(patch.rolloverHour) && patch.rolloverHour! >= 0 && patch.rolloverHour! <= 23)
  ) {
    errors.push("rollover hour must be a whole number between 0 and 23");
  }
  if ("leechThreshold" in patch && !(Number.isInteger(patch.leechThreshold) && patch.leechThreshold! >= 0)) {
    errors.push("leech threshold must be a whole number, 0 or more (0 disables the check)");
  }
  if ("leechAction" in patch && patch.leechAction !== "tag" && patch.leechAction !== "suspend") {
    errors.push(`leech action must be 'tag' or 'suspend', got ${JSON.stringify(patch.leechAction)}`);
  }
  if ("timeZone" in patch && patch.timeZone !== null) {
    const zone = patch.timeZone;
    if (typeof zone !== "string" || zone.trim() === "" || zone.length > TIME_ZONE_MAX_LENGTH) {
      errors.push("time zone must be a non-empty IANA zone name, or null for UTC");
    } else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
      } catch {
        errors.push(`'${zone}' is not a recognized time zone`);
      }
    }
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
