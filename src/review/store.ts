/**
 * What the handlers in handlers.ts need from a database — nothing more. Kept
 * narrow and I/O-free-in-signature on purpose: `handlers.ts` is tested entirely
 * against `InMemoryStore` below, the same way `migration/`'s tests never touch a
 * real Anki collection and `replay.ts`'s tests never touch Postgres. A
 * Postgres-backed implementation of this interface is what `supabase/functions/sync/`
 * needs to actually run — see that file for why it isn't written yet.
 */

import type {
  CardStateRow,
  DailyCounts,
  DueCandidate,
  NewNote,
  NoteRow,
  ReviewRow,
  SchedulerConfigRow,
} from "./types.ts";

export interface Store {
  getNote(noteId: string): Promise<NoteRow | null>;
  getCardState(noteId: string): Promise<CardStateRow | null>;
  getSchedulerConfig(userId: string): Promise<SchedulerConfigRow>;
  /** Inserts a note from an ingestion path (`/scan` today) and returns its
   * generated id. No review step (D10) — the row is immediately reviewable. */
  createNote(note: NewNote): Promise<string>;
  /** Every deck name with at least one note this user can review — the deck-list
   * screen's row set. */
  getDecks(userId: string): Promise<string[]>;
  /** Every note this user's due queue could possibly include, optionally narrowed
   * to one deck (undefined = every deck combined). Deck/language scoping happens
   * here, not in dueQueue.ts, which only knows scheduling. */
  getDueCandidates(userId: string, deck?: string): Promise<DueCandidate[]>;
  /** Daily new/review counts so far, scoped the same way as `getDueCandidates` —
   * each deck gets its own daily allowance against the one shared
   * `scheduler_config` limit, not one allowance split across every deck. */
  getDailyCounts(userId: string, now: Date, deck?: string): Promise<DailyCounts>;

  insertReview(row: ReviewRow): Promise<void>;
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
export class InMemoryStore implements Store {
  notes = new Map<string, NoteRow>();
  cardStates = new Map<string, CardStateRow>();
  schedulerConfigs = new Map<string, SchedulerConfigRow>();
  reviews = new Map<string, ReviewRow>();
  /** The state a card was in at the moment each review was submitted — needed to
   * classify a past review as "was new" vs "was review" for getDailyCounts, since
   * card_state.state reflects the card's CURRENT state, not what it was back then. */
  private reviewStateAtSubmission = new Map<string, 0 | 1 | 2 | 3 | null>();

  getNote(noteId: string): Promise<NoteRow | null> {
    return Promise.resolve(this.notes.get(noteId) ?? null);
  }

  getCardState(noteId: string): Promise<CardStateRow | null> {
    return Promise.resolve(this.cardStates.get(noteId) ?? null);
  }

  getSchedulerConfig(userId: string): Promise<SchedulerConfigRow> {
    const config = this.schedulerConfigs.get(userId);
    if (!config) throw new Error(`no scheduler_config row for user ${userId}`);
    return Promise.resolve(config);
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
    // The in-memory fixture doesn't model per-user access at all (§9.1's "decks are
    // disjoint by language" assumption) — tests construct exactly the note set they
    // want to see. A PostgresStore's version of this method is where per-user
    // access actually gets enforced.
    return Promise.resolve([...new Set([...this.notes.values()].map((n) => n.deck))]);
  }

  getDueCandidates(_userId: string, deck?: string): Promise<DueCandidate[]> {
    const candidates: DueCandidate[] = [];
    for (const note of this.notes.values()) {
      if (deck !== undefined && note.deck !== deck) continue;
      const state = this.cardStates.get(note.id);
      candidates.push({
        noteId: note.id,
        due: state?.due ?? null,
        state: state?.state ?? null,
        suspended: state?.suspended ?? false,
      });
    }
    return Promise.resolve(candidates);
  }

  getDailyCounts(userId: string, now: Date, deck?: string): Promise<DailyCounts> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let newTakenToday = 0;
    let reviewTakenToday = 0;
    for (const review of this.reviews.values()) {
      if (review.userId !== userId) continue;
      if (review.reviewedAt.getTime() < dayStart.getTime()) continue;
      if (deck !== undefined && this.notes.get(review.noteId)?.deck !== deck) continue;
      const stateAtSubmission = this.reviewStateAtSubmission.get(review.id);
      if (stateAtSubmission === null || stateAtSubmission === 0 || stateAtSubmission === undefined) {
        newTakenToday++;
      } else {
        reviewTakenToday++;
      }
    }
    return Promise.resolve({ newTakenToday, reviewTakenToday });
  }

  insertReview(row: ReviewRow): Promise<void> {
    if (this.reviews.has(row.id)) return Promise.resolve(); // idempotent, per §4.2
    const priorState = this.cardStates.get(row.noteId)?.state ?? null;
    this.reviewStateAtSubmission.set(row.id, priorState);
    this.reviews.set(row.id, row);
    return Promise.resolve();
  }

  upsertCardState(row: CardStateRow): Promise<void> {
    this.cardStates.set(row.noteId, row);
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
    this.cardStates.delete(noteId);
    for (const [id, review] of this.reviews) {
      if (review.noteId === noteId) this.reviews.delete(id);
    }
    return Promise.resolve();
  }
}
