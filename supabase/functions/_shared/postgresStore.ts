/**
 * The real `Store` (src/review/store.ts), backed by Postgres via
 * `@supabase/supabase-js` — the piece `supabase/functions/sync/index.ts` and
 * `supabase/functions/pronounce/index.ts` were both left without, on purpose,
 * until there was a live project to write it against and test assumptions
 * against (see those files' own docstrings on why). There now is one: the
 * `anki_*` tables applied to capybara-bot's project, 2026-09-16.
 *
 * Written against `import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.1"`
 * — the exact same import capybara-bot's own `telegram-bot/index.ts` uses — rather
 * than an import-map entry, so this matches D6's "reuse the bot's own pattern"
 * rather than inventing a second convention for the same project.
 *
 * Column names are snake_case in Postgres, camelCase in every `*Row` type
 * (src/review/types.ts) — the `*FromRow` functions below are the one place that
 * translation happens, mirroring `migration/schema.py`'s dataclasses being the one
 * place Anki's own column names get translated on the Python side.
 *
 * **Per-user access has no column of its own to enforce it.** `anki_notes` carries
 * no `user_id` — D2 (docs/DESIGN.md) scopes access by `language` instead, since
 * decks are disjoint by language today (one person's learning_language is the
 * other's native_language, per capybara-bot's own `users` table). `learningLanguage()`
 * below is what makes that real: every method that lists or counts notes for a
 * user resolves their `users.learning_language` first and filters by it. If that
 * assumption ever stops holding (docs/DESIGN.md §5's `anki_card_state` comment
 * already names the escape hatch), this is the one place that needs to change.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.1";
import { cardKey } from "../../../src/review/store.ts";
import type { Store } from "../../../src/review/store.ts";
import { ankiDayKey, DEFAULT_ROLLOVER_HOUR, type DayBoundary } from "../../../src/review/day.ts";
import {
  DEFAULT_LEECH_ACTION,
  DEFAULT_LEECH_THRESHOLD,
  type LeechAction,
} from "../../../src/review/leech.ts";
import type {
  CardKind,
  CardStateRow,
  DailyCounts,
  DueCandidate,
  DueItem,
  NewNote,
  NoteRow,
  ReviewRow,
  SchedulerConfigRow,
  StateCounts,
} from "../../../src/review/types.ts";

/** The three columns getDailyCounts needs out of a review; named because the
 * recent-window memo stores a list of them. */
interface RecentReview {
  note_id: string;
  card_kind: string;
  reviewed_at: string;
}

function noteFromRow(row: Record<string, unknown>): NoteRow {
  return {
    id: row.id as string,
    lemma: row.lemma as string,
    gloss: row.gloss as string | null,
    lemmaTranslation: row.lemma_translation as string | null,
    partOfSpeech: row.part_of_speech as string | null,
    language: row.language as "uk" | "en",
    example: row.example as string | null,
    exampleTranslation: row.example_translation as string | null,
    audioUrl: row.audio_url as string | null,
    deck: row.deck as string,
    kind: row.kind as NoteRow["kind"],
    hasSpelling: row.has_spelling as boolean,
  };
}

function cardStateFromRow(row: Record<string, unknown>): CardStateRow {
  return {
    noteId: row.note_id as string,
    cardKind: row.card_kind as CardKind,
    due: row.due ? new Date(row.due as string) : null,
    stability: row.stability as number | null,
    difficulty: row.difficulty as number | null,
    state: row.state as CardStateRow["state"],
    reps: row.reps as number,
    lapses: row.lapses as number,
    lastReview: row.last_review ? new Date(row.last_review as string) : null,
    suspended: row.suspended as boolean,
    lastUserId: row.last_user_id as string | null,
  };
}

function reviewFromRow(row: Record<string, unknown>): ReviewRow {
  return {
    id: row.id as string,
    noteId: row.note_id as string,
    cardKind: row.card_kind as CardKind,
    userId: row.user_id as string,
    rating: row.rating as ReviewRow["rating"],
    reviewedAt: new Date(row.reviewed_at as string),
    elapsedDays: row.elapsed_days as number,
    scheduledDays: row.scheduled_days as number,
  };
}

function schedulerConfigFromRow(row: Record<string, unknown>): SchedulerConfigRow {
  return {
    userId: row.user_id as string,
    fsrsParams: (row.fsrs_params as number[] | null) ?? [],
    desiredRetention: row.desired_retention as number,
    learningSteps: (row.learning_steps as number[] | null) ?? [],
    dailyNewLimit: row.daily_new_limit as number,
    dailyReviewLimit: row.daily_review_limit as number,
    maxInterval: row.max_interval as number,
    timeZone: (row.time_zone as string | null) ?? null,
    rolloverHour: (row.rollover_hour as number | null) ?? DEFAULT_ROLLOVER_HOUR,
    // These two read as defaults until the migration adding their columns is
    // applied: `select *` simply omits a column that doesn't exist yet, so the
    // nullish fallbacks make the code correct before and after. Same shape the
    // time_zone/rollover_hour pair used when they were added.
    leechThreshold: (row.leech_threshold as number | null) ?? DEFAULT_LEECH_THRESHOLD,
    leechAction: (row.leech_action as LeechAction | null) ?? DEFAULT_LEECH_ACTION,
  };
}

export class PostgresStore implements Store {
  private client: SupabaseClient;

  // PostgREST's own server-side max-rows cap on this project — see getDailyCounts'
  // and getReviewsSince's own comments on the live bug this paging fixes.
  private static readonly PAGE_SIZE = 1000;

  /** How far back getDailyCounts looks for reviews that could count toward today.
   * A study day is at most 24 hours long and the current one began at most 24
   * hours ago, so 48 hours is a safe superset of "today" under any timezone or
   * rollover hour, with room to spare across a DST seam. */
  private static readonly RECENT_WINDOW_MS = 172_800_000;

  /** Cap on ids per `.in(...)` filter. PostgREST puts these in the query string,
   * and a long enough list makes the request fail outright — that was a real
   * live failure on this account, see getDueCandidates' own history. */
  private static readonly IN_CHUNK = 100;

  private static chunked<T>(items: T[], size = PostgresStore.IN_CHUNK): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  /**
   * Request-scoped memos. `sync/index.ts` constructs one `PostgresStore` per
   * request and throws it away, so "cached for the life of this object" means
   * "cached for the life of this request" — long enough to stop asking the same
   * question repeatedly while answering one, too short to ever serve a stale
   * config to a later one.
   *
   * That lifetime is load-bearing, not incidental: a store hoisted to module
   * scope would start serving one request's scheduler config to the next, so if
   * `getStore()` ever stops being per-request these have to go with it.
   *
   * What they save is real. `getDeckSummaries` fans out over the deck list, and
   * every branch of that fan-out independently re-resolved the user's learning
   * language and re-read their scheduler config: five decks meant eleven
   * identical lookups, plus one 48-hour review-window scan per deck of the same
   * rows.
   */
  private readonly languageMemo = new Map<string, Promise<"uk" | "en">>();
  private readonly configMemo = new Map<string, Promise<SchedulerConfigRow>>();
  private readonly recentReviewsMemo = new Map<string, Promise<RecentReview[]>>();
  private readonly startedEarlierMemo = new Map<string, Promise<Set<string>>>();

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey);
  }

  /** Memoizes the promise, not the resolved value, so concurrent callers (the
   * `Promise.all` fan-outs above this layer) share one in-flight query instead
   * of each starting their own before the first resolves. A rejected lookup is
   * evicted so a transient failure isn't cached for the rest of the request. */
  private memo<T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing;
    const started = run().catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, started);
    return started;
  }

  /** D2's access rule made concrete: which `anki_notes.language` this user is
   * allowed to see, read off capybara-bot's own `users` table (D4 — same project,
   * no parallel identity system). */
  private learningLanguage(userId: string): Promise<"uk" | "en"> {
    return this.memo(this.languageMemo, userId, async () => {
      const { data, error } = await this.client
        .from("users")
        .select("learning_language")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error(`learningLanguage: ${error.message}`);
      if (!data) throw new Error(`no user row for ${userId}`);
      return data.learning_language as "uk" | "en";
    });
  }

  async getNote(noteId: string): Promise<NoteRow | null> {
    const { data, error } = await this.client.from("anki_notes").select("*").eq("id", noteId).maybeSingle();
    if (error) throw new Error(`getNote: ${error.message}`);
    return data ? noteFromRow(data) : null;
  }

  async getCardState(noteId: string, cardKind: CardKind): Promise<CardStateRow | null> {
    const { data, error } = await this.client
      .from("anki_card_state")
      .select("*")
      .eq("note_id", noteId)
      .eq("card_kind", cardKind)
      .maybeSingle();
    if (error) throw new Error(`getCardState: ${error.message}`);
    return data ? cardStateFromRow(data) : null;
  }

  /** Every requested note in one query per chunk of ids, rather than one query
   * per note — see the Store interface for why this exists. Chunked through the
   * same IN_CHUNK cap as everything else here, because PostgREST renders `.in()`
   * into the query string and a long enough list fails the request outright. */
  async getNotes(noteIds: string[]): Promise<Map<string, NoteRow>> {
    const out = new Map<string, NoteRow>();
    if (noteIds.length === 0) return out;
    for (const ids of PostgresStore.chunked(noteIds)) {
      const { data, error } = await this.client.from("anki_notes").select("*").in("id", ids);
      if (error) throw new Error(`getNotes: ${error.message}`);
      for (const row of data ?? []) out.set(row.id as string, noteFromRow(row));
    }
    return out;
  }

  /** Card states for a set of (noteId, cardKind) pairs. Filtering on note_id
   * alone and discarding the kinds nobody asked for is deliberate: PostgREST has
   * no clean way to express "these specific pairs," and a note has at most two
   * card_state rows (D17), so the over-fetch is bounded at 2x and costs one
   * query instead of one per pair. */
  async getCardStates(items: DueItem[]): Promise<Map<string, CardStateRow>> {
    const out = new Map<string, CardStateRow>();
    if (items.length === 0) return out;
    const wanted = new Set(items.map((i) => cardKey(i.noteId, i.cardKind)));
    const noteIds = [...new Set(items.map((i) => i.noteId))];
    for (const ids of PostgresStore.chunked(noteIds)) {
      const { data, error } = await this.client.from("anki_card_state").select("*").in("note_id", ids);
      if (error) throw new Error(`getCardStates: ${error.message}`);
      for (const row of data ?? []) {
        const key = cardKey(row.note_id as string, row.card_kind as CardKind);
        if (wanted.has(key)) out.set(key, cardStateFromRow(row));
      }
    }
    return out;
  }

  getSchedulerConfig(userId: string): Promise<SchedulerConfigRow> {
    return this.memo(this.configMemo, userId, async () => {
      const { data, error } = await this.client
        .from("anki_scheduler_config")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(`getSchedulerConfig: ${error.message}`);
      if (!data) throw new Error(`no scheduler_config row for user ${userId}`);
      return schedulerConfigFromRow(data);
    });
  }

  async createNote(note: NewNote): Promise<string> {
    const { data, error } = await this.client
      .from("anki_notes")
      .insert({
        lemma: note.lemma,
        gloss: note.gloss,
        lemma_translation: note.lemmaTranslation,
        part_of_speech: note.partOfSpeech,
        language: note.language,
        example: note.example,
        example_translation: note.exampleTranslation,
        audio_url: note.audioUrl,
        deck: note.deck,
        kind: note.kind,
        has_spelling: note.hasSpelling,
        source: note.source,
      })
      .select("id")
      .single();
    if (error) throw new Error(`createNote: ${error.message}`);
    return data.id as string;
  }

  async getDecks(userId: string): Promise<string[]> {
    const language = await this.learningLanguage(userId);
    const { data, error } = await this.client.from("anki_notes").select("deck").eq("language", language);
    if (error) throw new Error(`getDecks: ${error.message}`);
    return [...new Set((data ?? []).map((r) => r.deck as string))];
  }

  async getDueCandidates(userId: string, deck?: string): Promise<DueCandidate[]> {
    const language = await this.learningLanguage(userId);
    // A two-step fetch-notes-then-`.in("note_id", noteIds)` query used to sit here.
    // It broke the moment a real account had a few hundred notes: PostgREST renders
    // `.in()` as a literal comma-separated list in the request URL, and a few hundred
    // UUIDs blows past what the underlying HTTP client will send at all — "error
    // sending request", not even a graceful 4xx. Found live, backfilling 572 real
    // notes for one account (2026-09-16). Embedding `anki_card_state` through its own
    // FK to `anki_notes.id` gets every candidate's state in the one query PostgREST
    // was always meant to answer this with, no id list of any size involved.
    // Paged via PAGE_SIZE too — a single language's note count is already 838 for
    // the account this was migrated for (2026-09-16), close enough to PostgREST's
    // own 1000-row cap on this project (see getReviewsSince/getDailyCounts' own
    // comments on that exact cap silently truncating a live account) that leaving
    // this unbounded would just be waiting for the same bug to recur.
    const notes: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PostgresStore.PAGE_SIZE) {
      let noteQuery = this.client
        .from("anki_notes")
        .select("id, has_spelling, anki_card_state(card_kind, due, state, suspended)")
        .eq("language", language)
        .range(from, from + PostgresStore.PAGE_SIZE - 1);
      if (deck !== undefined) noteQuery = noteQuery.eq("deck", deck);
      const { data, error } = await noteQuery;
      if (error) throw new Error(`getDueCandidates: ${error.message}`);
      notes.push(...(data ?? []));
      if (!data || data.length < PostgresStore.PAGE_SIZE) break;
    }

    const candidates: DueCandidate[] = [];
    for (const note of notes) {
      const states = (note.anki_card_state ?? []) as Array<
        { card_kind: CardKind; due: string | null; state: DueCandidate["state"]; suspended: boolean }
      >;
      const stateByKind = new Map(states.map((s) => [s.card_kind, s]));
      const cardKinds: CardKind[] = note.has_spelling ? ["recall", "spelling"] : ["recall"];
      for (const kind of cardKinds) {
        const state = stateByKind.get(kind);
        candidates.push({
          noteId: note.id as string,
          cardKind: kind,
          due: state?.due ? new Date(state.due) : null,
          state: state?.state ?? null,
          suspended: state?.suspended ?? false,
        });
      }
    }
    return candidates;
  }

  /** The user's reviews inside a recent window, paged and memoized. Splitting
   * this out of getDailyCounts is what lets the per-deck fan-out share one read
   * of the window instead of one per deck. */
  private recentReviews(userId: string, windowStart: Date): Promise<RecentReview[]> {
    return this.memo(this.recentReviewsMemo, `${userId}|${windowStart.toISOString()}`, async () => {
      const recent: RecentReview[] = [];
      for (let from = 0; ; from += PostgresStore.PAGE_SIZE) {
        const { data, error } = await this.client
          .from("anki_reviews")
          .select("note_id, card_kind, reviewed_at")
          .eq("user_id", userId)
          .gte("reviewed_at", windowStart.toISOString())
          .order("reviewed_at", { ascending: true })
          .range(from, from + PostgresStore.PAGE_SIZE - 1);
        if (error) throw new Error(`getDailyCounts: ${error.message}`);
        recent.push(...(data ?? []));
        if (!data || data.length < PostgresStore.PAGE_SIZE) break;
      }
      return recent;
    });
  }

  /**
   * How many new cards and how many reviews this user has already taken today.
   *
   * Reads a bounded recent window, not the whole history. It used to page every
   * review the user had ever done — 3,804 rows on this account — and
   * getDeckSummaries calls this once per deck, so a single /sync/decks pulled
   * that history three times over. Measured at 3-4 seconds, which the reviewer
   * then blocked on after every rating (issue #16).
   *
   * The counting rule is unchanged, and still matches InMemoryStore exactly: a
   * review counts as "new" iff it is the FIRST review anki_reviews has ever
   * recorded for its (note_id, card_kind). What changed is how that is
   * established. Walking the window in order reproduces it for anything that
   * started inside the window; for anything older, one targeted lookup asks
   * whether the card has any review before the window at all, and seeds the
   * seen-set with the answer.
   */
  async getDailyCounts(userId: string, now: Date, deck?: string): Promise<DailyCounts> {
    // Study days, not UTC days (day.ts). Comparing day keys rather than an
    // instant is what keeps this DST-safe — no local wall-clock time is ever
    // converted back into a UTC instant, which is the part that breaks twice a
    // year.
    const config = await this.getSchedulerConfig(userId);
    const boundary: DayBoundary = { timeZone: config.timeZone, rolloverHour: config.rolloverHour };
    const today = ankiDayKey(now, boundary);
    const windowStart = new Date(now.getTime() - PostgresStore.RECENT_WINDOW_MS);

    // Memoized on (user, window): getDeckSummaries asks for counts once per
    // deck with the same `now`, and the rows are identical every time — only
    // the deck filter applied below them differs.
    const recent = await this.recentReviews(userId, windowStart);
    // The common case, and the one that used to cost the most: nothing studied
    // recently, so there is nothing else to ask about.
    if (recent.length === 0) return { newTakenToday: 0, reviewTakenToday: 0 };

    const noteIds = [...new Set(recent.map((r) => r.note_id))];

    // Which of these cards were already being studied before the window opened.
    // Only their existence matters, so this asks about the touched notes alone
    // rather than reading history wholesale.
    // Also memoized on (user, window): the note set comes from `recent`, which
    // is itself shared across the per-deck fan-out, so this answer is identical
    // for every deck too.
    const startedEarlier = await this.memo(
      this.startedEarlierMemo,
      `${userId}|${windowStart.toISOString()}`,
      async () => {
        const found = new Set<string>();
        for (const ids of PostgresStore.chunked(noteIds)) {
          const { data, error } = await this.client
            .from("anki_reviews")
            .select("note_id, card_kind")
            .eq("user_id", userId)
            .in("note_id", ids)
            .lt("reviewed_at", windowStart.toISOString());
          if (error) throw new Error(`getDailyCounts: ${error.message}`);
          for (const row of data ?? []) {
            found.add(cardKey(row.note_id as string, row.card_kind as CardKind));
          }
        }
        return found;
      },
    );

    // Scoping to a deck asks which of the touched notes are in it, rather than
    // listing the deck's whole contents — that select was unbounded, and so was
    // one PostgREST max-rows cap away from silently dropping notes.
    let deckNoteIds: Set<string> | null = null;
    if (deck !== undefined) {
      deckNoteIds = new Set<string>();
      for (const ids of PostgresStore.chunked(noteIds)) {
        const { data, error } = await this.client
          .from("anki_notes")
          .select("id")
          .in("id", ids)
          .eq("deck", deck);
        if (error) throw new Error(`getDailyCounts: ${error.message}`);
        for (const row of data ?? []) deckNoteIds.add(row.id as string);
      }
    }

    const seen = new Set(startedEarlier);
    let newTakenToday = 0;
    let reviewTakenToday = 0;
    for (const row of recent) {
      const key = cardKey(row.note_id as string, row.card_kind as CardKind);
      const isFirstEver = !seen.has(key);
      seen.add(key);
      if (ankiDayKey(new Date(row.reviewed_at as string), boundary) !== today) continue;
      if (deckNoteIds && !deckNoteIds.has(row.note_id as string)) continue;
      if (isFirstEver) newTakenToday++;
      else reviewTakenToday++;
    }
    return { newTakenToday, reviewTakenToday };
  }

  async getReviewsSince(userId: string, since: Date): Promise<ReviewRow[]> {
    // Paged via PAGE_SIZE, not one unbounded select — found live (2026-09-16),
    // migrating a real ~3,800-review collection into this table: an unbounded
    // select silently returns only PostgREST's own server-side max-rows cap
    // (1000 on this project), ordered ascending — the OLDEST 1000 rows, not the
    // most recent — so the stats screen's totalReviews/successRate/streak all
    // quietly undercounted a real account the moment its history crossed that
    // cap. `getDailyCounts` had the identical bug, same day, same fix shape.
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PostgresStore.PAGE_SIZE) {
      const { data, error } = await this.client
        .from("anki_reviews")
        .select("*")
        .eq("user_id", userId)
        .gte("reviewed_at", since.toISOString())
        .order("reviewed_at", { ascending: true })
        .range(from, from + PostgresStore.PAGE_SIZE - 1);
      if (error) throw new Error(`getReviewsSince: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PostgresStore.PAGE_SIZE) break;
    }
    return rows.map(reviewFromRow);
  }

  async getCardStateCounts(userId: string): Promise<StateCounts> {
    const language = await this.learningLanguage(userId);
    // Same fix, same reason, as getDueCandidates above: embed anki_card_state through
    // its FK rather than fetching note ids and re-querying with `.in(noteIds)`, which
    // breaks outright once a real account has a few hundred notes. Paged via
    // PAGE_SIZE for the same reason getDueCandidates is, just below.
    const notes: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PostgresStore.PAGE_SIZE) {
      const { data, error } = await this.client
        .from("anki_notes")
        .select("id, has_spelling, anki_card_state(card_kind, state, suspended)")
        .eq("language", language)
        .range(from, from + PostgresStore.PAGE_SIZE - 1);
      if (error) throw new Error(`getCardStateCounts: ${error.message}`);
      notes.push(...(data ?? []));
      if (!data || data.length < PostgresStore.PAGE_SIZE) break;
    }
    if (notes.length === 0) {
      return { newCount: 0, learningCount: 0, reviewCount: 0, suspendedCount: 0 };
    }

    let newCount = 0, learningCount = 0, reviewCount = 0, suspendedCount = 0;
    for (const note of notes) {
      const states = (note.anki_card_state ?? []) as Array<
        { card_kind: CardKind; state: CardStateRow["state"]; suspended: boolean }
      >;
      const stateByKind = new Map(states.map((s) => [s.card_kind, s]));
      const cardKinds: CardKind[] = note.has_spelling ? ["recall", "spelling"] : ["recall"];
      for (const kind of cardKinds) {
        const state = stateByKind.get(kind);
        if (state?.suspended) suspendedCount++;
        if (state?.state === 1 || state?.state === 3) learningCount++;
        else if (state?.state === 2) reviewCount++;
        else newCount++;
      }
    }
    return { newCount, learningCount, reviewCount, suspendedCount };
  }

  async getReviewsForCard(userId: string, noteId: string, cardKind: CardKind): Promise<ReviewRow[]> {
    // One card's history is small by construction (a card answered daily for a
    // year is 365 rows), so this needs none of the paging the collection-wide
    // reads above do.
    const { data, error } = await this.client
      .from("anki_reviews")
      .select("*")
      .eq("user_id", userId)
      .eq("note_id", noteId)
      .eq("card_kind", cardKind)
      .order("reviewed_at", { ascending: true });
    if (error) throw new Error(`getReviewsForCard: ${error.message}`);
    return (data ?? []).map(reviewFromRow);
  }

  async deleteReview(reviewId: string): Promise<void> {
    const { error } = await this.client.from("anki_reviews").delete().eq("id", reviewId);
    if (error) throw new Error(`deleteReview: ${error.message}`);
  }

  async deleteCardState(noteId: string, cardKind: CardKind): Promise<void> {
    const { error } = await this.client
      .from("anki_card_state")
      .delete()
      .eq("note_id", noteId)
      .eq("card_kind", cardKind);
    if (error) throw new Error(`deleteCardState: ${error.message}`);
  }

  async insertReview(row: ReviewRow): Promise<void> {
    // §4.2's idempotency promise, the same way capybara-bot's own writes get it:
    // `ignoreDuplicates` turns the primary-key conflict on a retried `row.id` into
    // a no-op instead of an error, matching InMemoryStore's `if (this.reviews.has
    // (row.id)) return` exactly. Safe here specifically because `row` is always a
    // complete row (every NOT NULL column present) — see `updateNote`'s comment
    // below for the partial-column case where `upsert` is NOT safe.
    const { error } = await this.client
      .from("anki_reviews")
      .upsert(
        {
          id: row.id,
          note_id: row.noteId,
          card_kind: row.cardKind,
          user_id: row.userId,
          rating: row.rating,
          reviewed_at: row.reviewedAt.toISOString(),
          elapsed_days: row.elapsedDays,
          scheduled_days: row.scheduledDays,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
    if (error) throw new Error(`insertReview: ${error.message}`);
  }

  async upsertCardState(row: CardStateRow): Promise<void> {
    // Full row, same reasoning as insertReview: mergeCardState (mutations.ts)
    // always returns every column, never a patch, so this can't hit the NOT-NULL-
    // before-conflict-check failure mode updateNote guards against below.
    const { error } = await this.client
      .from("anki_card_state")
      .upsert(
        {
          note_id: row.noteId,
          card_kind: row.cardKind,
          due: row.due ? row.due.toISOString() : null,
          stability: row.stability,
          difficulty: row.difficulty,
          state: row.state,
          reps: row.reps,
          lapses: row.lapses,
          last_review: row.lastReview ? row.lastReview.toISOString() : null,
          suspended: row.suspended,
          last_user_id: row.lastUserId,
        },
        { onConflict: "note_id,card_kind" },
      );
    if (error) throw new Error(`upsertCardState: ${error.message}`);
  }

  async updateNote(noteId: string, patch: Partial<Omit<NoteRow, "id">>): Promise<void> {
    const dbPatch: Record<string, unknown> = {};
    if ("lemma" in patch) dbPatch.lemma = patch.lemma;
    if ("gloss" in patch) dbPatch.gloss = patch.gloss;
    if ("lemmaTranslation" in patch) dbPatch.lemma_translation = patch.lemmaTranslation;
    if ("partOfSpeech" in patch) dbPatch.part_of_speech = patch.partOfSpeech;
    if ("language" in patch) dbPatch.language = patch.language;
    if ("example" in patch) dbPatch.example = patch.example;
    if ("exampleTranslation" in patch) dbPatch.example_translation = patch.exampleTranslation;
    if ("audioUrl" in patch) dbPatch.audio_url = patch.audioUrl;
    if ("deck" in patch) dbPatch.deck = patch.deck;
    if ("kind" in patch) dbPatch.kind = patch.kind;
    if ("hasSpelling" in patch) dbPatch.has_spelling = patch.hasSpelling;

    // A genuine UPDATE, never `upsert({ onConflict: "id" })` — capybara-bot hit this
    // exact bug on `vocabulary` (see its own `backfill_translations` comment):
    // PostgREST turns that upsert into `INSERT ... ON CONFLICT (id) DO UPDATE`, and
    // Postgres validates NOT NULL constraints (anki_notes.lemma/language, no
    // defaults) against the candidate row BEFORE it ever gets to the conflict
    // check. A partial patch like `{ gloss: "..." }` would fail outright, every
    // time. `editNote` (handlers.ts) already confirmed the note exists via
    // `getNote` before calling this, so a plain UPDATE is not just the fix but the
    // correct operation — there is no insert case to cover.
    const { error } = await this.client.from("anki_notes").update(dbPatch).eq("id", noteId);
    if (error) throw new Error(`updateNote: ${error.message}`);
  }

  async deleteNote(noteId: string): Promise<void> {
    // anki_card_state/anki_reviews both reference anki_notes ON DELETE CASCADE
    // (the migration) — one DELETE is enough, no separate cleanup query needed.
    const { error } = await this.client.from("anki_notes").delete().eq("id", noteId);
    if (error) throw new Error(`deleteNote: ${error.message}`);
  }
}
