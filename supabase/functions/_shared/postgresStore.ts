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
import type {
  CardKind,
  CardStateRow,
  DailyCounts,
  DueCandidate,
  NewNote,
  NoteRow,
  ReviewRow,
  SchedulerConfigRow,
  StateCounts,
} from "../../../src/review/types.ts";

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
  };
}

export class PostgresStore implements Store {
  private client: SupabaseClient;

  // PostgREST's own server-side max-rows cap on this project — see getDailyCounts'
  // and getReviewsSince's own comments on the live bug this paging fixes.
  private static readonly PAGE_SIZE = 1000;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey);
  }

  /** D2's access rule made concrete: which `anki_notes.language` this user is
   * allowed to see, read off capybara-bot's own `users` table (D4 — same project,
   * no parallel identity system). */
  private async learningLanguage(userId: string): Promise<"uk" | "en"> {
    const { data, error } = await this.client
      .from("users")
      .select("learning_language")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new Error(`learningLanguage: ${error.message}`);
    if (!data) throw new Error(`no user row for ${userId}`);
    return data.learning_language as "uk" | "en";
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

  async getSchedulerConfig(userId: string): Promise<SchedulerConfigRow> {
    const { data, error } = await this.client
      .from("anki_scheduler_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`getSchedulerConfig: ${error.message}`);
    if (!data) throw new Error(`no scheduler_config row for user ${userId}`);
    return schedulerConfigFromRow(data);
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

  async getDailyCounts(userId: string, now: Date, deck?: string): Promise<DailyCounts> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // No live analog of InMemoryStore's `reviewStateAtSubmission` map exists here —
    // each request is stateless. Instead: a review counts as "new" iff it's the
    // FIRST review `anki_reviews` (append-only, §4.2) has ever recorded for its
    // (note_id, card_kind) — exactly the condition InMemoryStore's `priorState ===
    // null` captures, since that's precisely when no `card_state` row existed yet.
    // Ordering the user's whole history once and tracking what's been seen so far
    // reconstructs that without adding a column this schema doesn't have.
    //
    // Paged via PAGE_SIZE, not one unbounded select — found live (2026-09-16),
    // migrating a real ~3,800-review collection: PostgREST caps an unbounded
    // select at its own server-side max-rows (1000 on this project) regardless of
    // ORDER BY, so a single select silently returned only the OLDEST 1000 rows —
    // missing every recent review, which is exactly backwards for "how many has
    // this user already done today." See getReviewsSince's own comment on the
    // same bug, hit by the same migration on the same day.
    const reviews: Array<{ note_id: string; card_kind: string; reviewed_at: string }> = [];
    for (let from = 0; ; from += PostgresStore.PAGE_SIZE) {
      const { data, error } = await this.client
        .from("anki_reviews")
        .select("note_id, card_kind, reviewed_at")
        .eq("user_id", userId)
        .order("reviewed_at", { ascending: true })
        .range(from, from + PostgresStore.PAGE_SIZE - 1);
      if (error) throw new Error(`getDailyCounts: ${error.message}`);
      reviews.push(...(data ?? []));
      if (!data || data.length < PostgresStore.PAGE_SIZE) break;
    }

    let deckNoteIds: Set<string> | null = null;
    if (deck !== undefined) {
      const { data: notes, error: notesErr } = await this.client.from("anki_notes").select("id").eq("deck", deck);
      if (notesErr) throw new Error(`getDailyCounts: ${notesErr.message}`);
      deckNoteIds = new Set((notes ?? []).map((n) => n.id as string));
    }

    const seen = new Set<string>();
    let newTakenToday = 0;
    let reviewTakenToday = 0;
    for (const row of reviews ?? []) {
      const key = cardKey(row.note_id as string, row.card_kind as CardKind);
      const isFirstEver = !seen.has(key);
      seen.add(key);
      if (new Date(row.reviewed_at as string).getTime() < dayStart.getTime()) continue;
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
