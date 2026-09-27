-- Words from the book being read, as opposed to words from the couple's
-- conversations (docs/MIGRATION.md §6.17). The reviewer labels these cards
-- "Originated from book".
--
-- A page-scanner note (source = 'scan') is from the book by definition and the app
-- treats it so whether or not this is set. The column exists for notes whose
-- source says nothing about it: the AnkiDroid import, where book words and
-- conversation words arrived together as 'anki-import'. Which of those are from
-- the book is a data decision made once against the live corpus (§6.17), not a
-- rule this migration encodes.

alter table anki_notes
  add column if not exists from_book boolean not null default false;
