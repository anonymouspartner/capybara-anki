/**
 * What the handlers in handlers.ts need from a database — nothing more. Kept
 * narrow and I/O-free-in-signature on purpose: `handlers.ts` is tested entirely
 * against `InMemoryStore` below, the same way `migration/`'s tests never touch a
 * real Anki collection and `replay.ts`'s tests never touch Postgres. A
 * Postgres-backed implementation of this interface is what `supabase/functions/sync/`
 * needs to actually run — see that file for why it isn't written yet.
 */

import type {
  CardKind,
  CardStateRow,
  DailyCounts,
  DueCandidate,
  DueItem,
  NewNote,
  NoteRow,
  PersonRow,
  ReviewRow,
  SchedulerConfigRow,
  StateCounts,
} from "./types.ts";
import { ankiDayKey, type DayBoundary, UTC_MIDNIGHT } from "./day.ts";
import { deckOfCard } from "./types.ts";
import type { SettingsPatch } from "./mutations.ts";

export interface Store {
  getNote(noteId: string): Promise<NoteRow | null>;
  /** D17: a card is `(noteId, cardKind)`, not `noteId` alone — every caller already
   * knows which of a note's (one or two) cards it means before asking. */
  getCardState(noteId: string, cardKind: CardKind): Promise<CardStateRow | null>;
  /** The same answers as calling `getNote`/`getCardState` once per item, in a
   * bounded number of round trips instead of one per card.
   *
   * These exist because the reviewer's own endpoint was the thing making them
   * necessary: `getDueQueueWithPreviews` asked for one note and one card state
   * per due card, so opening a deck with 96 cards due cost 192 sequential
   * queries inside the edge function before the first card could render. The
   * per-card methods above stay — a single card is still a single lookup, and
   * `submitReview` genuinely wants one row — but anything assembling a queue
   * asks in batches.
   *
   * Both return maps rather than arrays so a caller never has to re-associate
   * results with inputs positionally; a missing id is simply absent, which is
   * the same "no row" the singular methods express as null. `getCardStates`
   * keys on `cardKey(noteId, cardKind)` (D17 — a note can have two). */
  getNotes(noteIds: string[]): Promise<Map<string, NoteRow>>;
  getCardStates(items: DueItem[]): Promise<Map<string, CardStateRow>>;
  getSchedulerConfig(userId: string): Promise<SchedulerConfigRow>;
  /** The settings screen's (Phase 5.3) write path — merges `patch` into whatever
   * `scheduler_config` row already exists for this user. A real UPDATE, not an
   * upsert: every user already has exactly one row (`anki_scheduler_config_pkey`
   * is `user_id`, seeded at provisioning), so there is no insert case to cover,
   * same reasoning as `updateNote`. */
  updateSchedulerConfig(userId: string, patch: SettingsPatch): Promise<void>;
  /** Inserts a note from an ingestion path (`/scan` today) and returns its
   * generated id. No review step (D10) — the row is immediately reviewable. */
  createNote(note: NewNote): Promise<string>;
  /** Every deck name with at least one note this user can review — the deck-list
   * screen's row set. */
  getDecks(userId: string): Promise<string[]>;
  /** Everyone this collection belongs to (capybara-bot's `users` rows) -- the
   * deck list's per-person grouping and each person's streak. */
  getPeople(): Promise<PersonRow[]>;
  /** Every pronunciation note's (D18) reference audio URL, for the offline
   * audio cache (Phase 5.4) to hand the service worker — one shared list, not
   * scoped by `userId`, same "doesn't model per-user access" shape `getDecks`
   * already has: the collection is shared (postgresStore.ts's own docstring),
   * so both people's due queues eventually need every one of these files. */
  getPronunciationAudioUrls(userId: string): Promise<string[]>;
  /** Every card this user's due queue could possibly include, optionally narrowed
   * to one deck (undefined = every deck combined) — one entry per note, plus a
   * second `cardKind: 'spelling'` entry for each note with `hasSpelling` (D17).
   * Deck/language scoping happens here, not in dueQueue.ts, which only knows
   * scheduling. `now` resolves `DueCandidate.buried` against the user's own
   * `DayBoundary` — same reasoning as `getDailyCounts` taking it, and the same
   * per-implementation pattern (see `InMemoryStore`'s below). */
  getDueCandidates(userId: string, now: Date, deck?: string): Promise<DueCandidate[]>;
  /** Daily new/review counts so far, across the whole collection — one shared
   * daily allowance against `scheduler_config`'s limit, not a separate one per
   * deck (§4.3, resolved 2026-09-18: matches Anki's own per-collection default
   * rather than every deck getting its own full allowance). Unlike
   * `getDueCandidates`, this takes no `deck` parameter — the count that
   * matters for "how much of today's budget is left" is never scoped to
   * which deck someone happens to be looking at. */
  getDailyCounts(userId: string, now: Date): Promise<DailyCounts>;
  /** Every review at or after `since`, across every deck — the stats screen's
   * (step 6) raw material. Callers wanting all-time numbers (streak, success rate)
   * pass a `since` far in the past; a real `PostgresStore` may eventually want a
   * smarter query for those two, but nothing here needs one yet. */
  getReviewsSince(userId: string, since: Date): Promise<ReviewRow[]>;
  /** How many notes are in each scheduling bucket right now — the stats screen's
   * collection-composition breakdown, independent of what's due today. */
  getCardStateCounts(userId: string): Promise<StateCounts>;

  /** Every review this user has given one card, oldest first — the raw material
   * for rebuilding its state from scratch (§4.3). Scoped to one card rather than
   * reusing getReviewsSince, which spans the whole collection. */
  getReviewsForCard(userId: string, noteId: string, cardKind: CardKind): Promise<ReviewRow[]>;

  insertReview(row: ReviewRow): Promise<void>;
  /** Removes one review. The only caller is undo, and it is the one operation
   * that legitimately shortens the log rather than appending to it. */
  deleteReview(reviewId: string): Promise<void>;
  /** Drops a card's state row entirely — what undoing a card's *only* review
   * leaves behind, since "never reviewed" is the absence of a row, not a row of
   * zeros (see types.ts). */
  deleteCardState(noteId: string, cardKind: CardKind): Promise<void>;
  upsertCardState(row: CardStateRow): Promise<void>;
  updateNote(noteId: string, patch: Partial<Omit<NoteRow, "id">>): Promise<void>;
  deleteNote(noteId: string): Promise<void>;
}

/**
 * A complete, in-memory `Store` — this is what `handlers.test.ts` runs against.
 * Not a mock with pre-programmed responses; it behaves like a real (tiny) database,
 * including the parts that matter for correctness: `insertReview` on a duplicate id
 * is a no-op (the idempotency §4.2 promises), and `getDailyCounts` actually derives
 * its answer from inserted reviews rather than being told the answer.
 */
/** `card_state`'s real key, D17: a `(noteId, cardKind)` pair, not `noteId` alone.
 * Exported so anything seeding `InMemoryStore.cardStates` directly (tests, the demo
 * server) uses the same format rather than hardcoding it. */
export function cardKey(noteId: string, cardKind: CardKind): string {
  return `${noteId}:${cardKind}`;
}

export class InMemoryStore implements Store {
  notes = new Map<string, NoteRow>();
  /** Keyed by `cardKey(noteId, cardKind)` — see that function's docstring. */
  cardStates = new Map<string, CardStateRow>();
  schedulerConfigs = new Map<string, SchedulerConfigRow>();
  reviews = new Map<string, ReviewRow>();
  people: PersonRow[] = [];
  /** The state a card was in at the moment each review was submitted — needed to
   * classify a past review as "was new" vs "was review" for getDailyCounts, since
   * card_state.state reflects the card's CURRENT state, not what it was back then. */
  private reviewStateAtSubmission = new Map<string, 0 | 1 | 2 | 3 | null>();

  getNote(noteId: string): Promise<NoteRow | null> {
    return Promise.resolve(this.notes.get(noteId) ?? null);
  }

  getPeople(): Promise<PersonRow[]> {
    return Promise.resolve([...this.people]);
  }

  getCardState(noteId: string, cardKind: CardKind): Promise<CardStateRow | null> {
    return Promise.resolve(this.cardStates.get(cardKey(noteId, cardKind)) ?? null);
  }

  getNotes(noteIds: string[]): Promise<Map<string, NoteRow>> {
    const out = new Map<string, NoteRow>();
    for (const id of noteIds) {
      const note = this.notes.get(id);
      if (note) out.set(id, note);
    }
    return Promise.resolve(out);
  }

  getCardStates(items: DueItem[]): Promise<Map<string, CardStateRow>> {
    const out = new Map<string, CardStateRow>();
    for (const item of items) {
      const key = cardKey(item.noteId, item.cardKind);
      const state = this.cardStates.get(key);
      if (state) out.set(key, state);
    }
    return Promise.resolve(out);
  }

  getSchedulerConfig(userId: string): Promise<SchedulerConfigRow> {
    const config = this.schedulerConfigs.get(userId);
    if (!config) throw new Error(`no scheduler_config row for user ${userId}`);
    return Promise.resolve(config);
  }

  updateSchedulerConfig(userId: string, patch: SettingsPatch): Promise<void> {
    const current = this.schedulerConfigs.get(userId);
    if (!current) throw new Error(`no scheduler_config row for user ${userId}`);
    this.schedulerConfigs.set(userId, { ...current, ...patch });
    return Promise.resolve();
  }

  createNote(note: NewNote): Promise<string> {
    const id = crypto.randomUUID();
    // `source` has no home in NoteRow (see its docstring) — the fixture doesn't
    // track provenance at all, matching how getDecks doesn't model per-user access.
    const { source: _source, ...noteRow } = note;
    this.notes.set(id, { id, ...noteRow });
    return Promise.resolve(id);
  }

  getDecks(_userId: string): Promise<string[]> {
    // The in-memory fixture doesn't model per-user access at all — tests construct
    // exactly the note set they want to see.
    const decks = new Set<string>();
    for (const note of this.notes.values()) {
      decks.add(deckOfCard(note.deck, "recall", note.language));
      // A spelling card lives in its own deck, exactly as Anki pins it — see
      // SPELLING_DECK. The deck exists iff some note actually has one.
      if (note.hasSpelling) decks.add(deckOfCard(note.deck, "spelling", note.language));
    }
    return Promise.resolve([...decks]);
  }

  getPronunciationAudioUrls(_userId: string): Promise<string[]> {
    const urls: string[] = [];
    for (const note of this.notes.values()) {
      if (note.kind === "pronunciation" && note.audioUrl) urls.push(note.audioUrl);
    }
    return Promise.resolve(urls);
  }

  getDueCandidates(userId: string, now: Date, deck?: string): Promise<DueCandidate[]> {
    // Same day-key pattern as getDailyCounts just below, and for the same
    // reason: "still buried" is "buried on today's ankiDayKey," never an instant
    // comparison — see DueCandidate.buried's docstring.
    const config = this.schedulerConfigs.get(userId);
    const boundary: DayBoundary = config
      ? { timeZone: config.timeZone, rolloverHour: config.rolloverHour }
      : UTC_MIDNIGHT;
    const today = ankiDayKey(now, boundary);

    const candidates: DueCandidate[] = [];
    for (const note of this.notes.values()) {
      const cardKinds: CardKind[] = note.hasSpelling ? ["recall", "spelling"] : ["recall"];
      for (const cardKind of cardKinds) {
        // Scoped on the card's deck, not the note's: a Capybara+ note's recall
        // card is in Ukrainian while its spelling card is in Spelling.
        if (deck !== undefined && deckOfCard(note.deck, cardKind, note.language) !== deck) continue;
        const state = this.cardStates.get(cardKey(note.id, cardKind));
        candidates.push({
          noteId: note.id,
          cardKind,
          due: state?.due ?? null,
          state: state?.state ?? null,
          suspended: state?.suspended ?? false,
          buried: state?.buriedOn === today,
        });
      }
    }
    return Promise.resolve(candidates);
  }

  getDailyCounts(userId: string, now: Date): Promise<DailyCounts> {
    // Study days, not UTC days — see day.ts. Comparing day keys rather than an
    // instant is what keeps this DST-safe: no local wall-clock time ever has to
    // be converted back into a UTC instant.
    const config = this.schedulerConfigs.get(userId);
    const boundary: DayBoundary = config
      ? { timeZone: config.timeZone, rolloverHour: config.rolloverHour }
      : UTC_MIDNIGHT;
    const today = ankiDayKey(now, boundary);
    let newTakenToday = 0;
    let reviewTakenToday = 0;
    for (const review of this.reviews.values()) {
      if (review.userId !== userId) continue;
      if (ankiDayKey(review.reviewedAt, boundary) !== today) continue;
      const stateAtSubmission = this.reviewStateAtSubmission.get(review.id);
      if (stateAtSubmission === null || stateAtSubmission === 0 || stateAtSubmission === undefined) {
        newTakenToday++;
      } else {
        reviewTakenToday++;
      }
    }
    return Promise.resolve({ newTakenToday, reviewTakenToday });
  }

  getReviewsSince(userId: string, since: Date): Promise<ReviewRow[]> {
    return Promise.resolve(
      [...this.reviews.values()].filter((r) => r.userId === userId && r.reviewedAt.getTime() >= since.getTime()),
    );
  }

  getCardStateCounts(_userId: string): Promise<StateCounts> {
    // Same "doesn't model per-user access" caveat as getDecks — every note in the
    // fixture counts, since tests construct exactly the set they want counted.
    // A note with hasSpelling contributes two cards, same as getDueCandidates —
    // its recall and spelling cards are two separate things to learn.
    let newCount = 0, learningCount = 0, reviewCount = 0, suspendedCount = 0;
    for (const note of this.notes.values()) {
      const cardKinds: CardKind[] = note.hasSpelling ? ["recall", "spelling"] : ["recall"];
      for (const cardKind of cardKinds) {
        const state = this.cardStates.get(cardKey(note.id, cardKind));
        if (state?.suspended) suspendedCount++;
        if (state?.state === 1 || state?.state === 3) learningCount++;
        else if (state?.state === 2) reviewCount++;
        else newCount++;
      }
    }
    return Promise.resolve({ newCount, learningCount, reviewCount, suspendedCount });
  }

  getReviewsForCard(userId: string, noteId: string, cardKind: CardKind): Promise<ReviewRow[]> {
    return Promise.resolve(
      [...this.reviews.values()]
        .filter((r) => r.userId === userId && r.noteId === noteId && r.cardKind === cardKind)
        .sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime()),
    );
  }

  deleteReview(reviewId: string): Promise<void> {
    this.reviews.delete(reviewId);
    this.reviewStateAtSubmission.delete(reviewId);
    return Promise.resolve();
  }

  deleteCardState(noteId: string, cardKind: CardKind): Promise<void> {
    this.cardStates.delete(cardKey(noteId, cardKind));
    return Promise.resolve();
  }

  insertReview(row: ReviewRow): Promise<void> {
    if (this.reviews.has(row.id)) return Promise.resolve(); // idempotent, per §4.2
    const priorState = this.cardStates.get(cardKey(row.noteId, row.cardKind))?.state ?? null;
    this.reviewStateAtSubmission.set(row.id, priorState);
    this.reviews.set(row.id, row);
    return Promise.resolve();
  }

  upsertCardState(row: CardStateRow): Promise<void> {
    this.cardStates.set(cardKey(row.noteId, row.cardKind), row);
    return Promise.resolve();
  }

  updateNote(noteId: string, patch: Partial<Omit<NoteRow, "id">>): Promise<void> {
    const current = this.notes.get(noteId);
    if (!current) throw new Error(`no note ${noteId}`);
    this.notes.set(noteId, { ...current, ...patch });
    return Promise.resolve();
  }

  deleteNote(noteId: string): Promise<void> {
    this.notes.delete(noteId);
    for (const key of [cardKey(noteId, "recall"), cardKey(noteId, "spelling")]) {
      this.cardStates.delete(key);
    }
    for (const [id, review] of this.reviews) {
      if (review.noteId === noteId) this.reviews.delete(id);
    }
    return Promise.resolve();
  }
}
