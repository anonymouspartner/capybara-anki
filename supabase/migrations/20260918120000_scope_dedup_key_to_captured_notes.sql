-- Rescopes anki_notes' dedup key to the bot's/scanner's own writes only —
-- docs/MIGRATION.md §2.1, §5 Phase 1. The full UNIQUE (lemma, part_of_speech,
-- language) constraint added in 20260916100000 is correct for those two
-- pipelines — one flashcard per word, regardless of which one captured it
-- first — but wrong for an imported collection: a real AnkiDroid export
-- genuinely contains 245 pairs of notes sharing one (lemma, part_of_speech,
-- language) — a plain "Capybara" note plus its "Capybara+" revision — and
-- 242 of those 245 pairs have BOTH twins independently reviewed for months,
-- not one abandoned duplicate. The full constraint silently discarded 248
-- notes and 799 reviews at the 2026-09-16 load — data that existed nowhere
-- but the phone until this same migration's sibling commit recovers it.
--
-- Scoped to `source <> 'anki-import'`: bot and scan writes still dedupe
-- against each other and against already-imported notes for genuinely-the-
-- same-word capture (the invariant 20260916100000 exists for at all);
-- imported twins from Anki itself are exempt, because Anki's own scheduling
-- already treats them as two independently-reviewed cards, not a data-entry
-- accident to be collapsed.
--
-- Safe to apply with no cleanup: the live table has exactly 13 `source='bot'`
-- rows and 0 `source='scan'` rows at the time this was written, and that set
-- is a strict subset of what the wider (now-dropped) constraint already
-- validated — a narrower predicate over fewer rows cannot discover a new
-- violation the broader one didn't already prevent.
--
-- Note for whoever next touches capybara-bot's writeAnkiNotes: a PARTIAL
-- unique index cannot be a PostgREST upsert's conflict target unless the
-- request's ON CONFLICT clause repeats the same WHERE predicate, and the
-- supabase-js client's `.upsert({ onConflict: "a,b,c" })` has no option to
-- supply one. capybara-bot's own write path was changed in the same PR that
-- applies this migration to an explicit select-then-insert instead of
-- relying on ON CONFLICT — see that repo's PR, and docs/MIGRATION.md §5
-- Phase 1.2, for the reasoning.
ALTER TABLE "public"."anki_notes" DROP CONSTRAINT "anki_notes_lemma_pos_language_key";

CREATE UNIQUE INDEX "anki_notes_lemma_pos_language_captured_key"
    ON "public"."anki_notes" ("lemma", "part_of_speech", "language")
    WHERE "source" <> 'anki-import';
