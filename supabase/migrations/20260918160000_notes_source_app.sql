-- Phase 5.2 (docs/MIGRATION.md §4, "No way to add a card in the app"): the
-- add-a-card screen writes anki_notes.source = 'app', a fourth, genuinely
-- distinct provenance from 'scan' (a photographed page) and 'bot' (capybara-bot's
-- /learn) — see src/review/types.ts's NewNote.source docstring for why this
-- isn't just overloading one of the existing two.
--
-- The dedup partial index from 20260918120000 (WHERE source <> 'anki-import')
-- already covers any non-import source without change — 'app' rows dedupe
-- against 'scan'/'bot' rows exactly as those already dedupe against each other.

alter table anki_notes
  drop constraint if exists anki_notes_source_check;
alter table anki_notes
  add constraint anki_notes_source_check
  check (source = any (array['scan', 'bot', 'anki-import', 'app']));
