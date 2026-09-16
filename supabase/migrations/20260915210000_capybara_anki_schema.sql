-- capybara-anki schema — docs/DESIGN.md §5, as resolved by the D2/D13 decisions and
-- by building src/fsrs/replay.ts (see below for what that changed).
--
-- Table names are prefixed `anki_` — found out the hard way (2026-09-16, checking the
-- live project's actual schema before ever applying this) that "public"."notes" was
-- already taken: capybara-bot has its own unrelated `notes` table (the /remember,
-- /pin personal-notes feature — author_id/content/language, nothing to do with
-- vocabulary). `CREATE TABLE IF NOT EXISTS` against that name would have silently
-- no-opped, leaving this app's actual notes table missing while card_state/reviews/
-- scheduler_config (no real collision there) got created fine — exactly the kind of
-- partial, silent failure worth catching before applying anything. Prefixing all four
-- tables here, not just the one that happened to collide, since nothing here depends
-- on the shorter names yet and a second undetected collision is not a risk worth
-- keeping. (Related, and already an open question — §11 item 2 — not a new one: the
-- bot also has its own `vocabulary`/`flashcards` tables, semantically close to what
-- this app's notes represent. Whether those ever get reconciled is a real product
-- question, but it doesn't block this app having its own non-colliding tables today.)
--
-- NOT APPLIED ANYWHERE UNTIL 2026-09-16. This was a file on disk, committed for
-- review, nothing more, per this repo's ground rules (README) and capybara-bot's
-- CLAUDE.md — migrations against the live Supabase project happen only on an
-- explicit, in-the-moment request from the maintainer, never as a side effect of
-- writing code. Applied on 2026-09-16 on exactly such a request.
--
-- Open question this file does NOT resolve, deliberately: WHICH repo's migration
-- history actually carries this long-term. D4 puts this app on the same Supabase
-- project capybara-bot already uses, and capybara-bot/supabase/migrations/ is the
-- versioned history already wired to deploy against that project (see its CLAUDE.md).
-- Whether this file's contents get folded into that sequence, or a separate Supabase
-- CLI config in this repo keeps pointing at the same project ref, is a cross-repo
-- call for the maintainer, not something to decide by writing a file. Named and dated
-- so it's easy to renumber into either home verbatim, either way.
--
-- Written in the same idempotent style as capybara-bot's migrations (IF NOT EXISTS)
-- so re-running it is safe.
--
-- Foreign keys point at "public"."users", capybara-bot's existing table — not a
-- parallel identity system. A D13 device token resolves to one of its two rows;
-- that's what "which user is reviewing" means everywhere below.

CREATE TABLE IF NOT EXISTS "public"."anki_notes" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    -- Set only for notes that came from an Anki collection (migration/, source =
    -- 'anki-import'); the idempotency key §7.2 requires so re-running migration
    -- never duplicates a note. NULL for everything else — Postgres allows multiple
    -- NULLs under a UNIQUE constraint, which is exactly the behavior wanted here.
    "anki_guid" "text",
    "lemma" "text" NOT NULL,
    "gloss" "text",
    "lemma_translation" "text",
    "part_of_speech" "text",
    "language" "text" NOT NULL,
    "example" "text",
    "example_translation" "text",
    "audio_url" "text",
    "source" "text" DEFAULT 'bot' NOT NULL,
    -- Free-text label, not a foreign key to a decks table — Anki itself treats a
    -- deck as just a path string on a card, and the reviewer (src/review/types.ts's
    -- NoteRow) needs no more than that. Added after the fact, once a real look at
    -- AnkiDroid's own deck list (Ukrainian / English / Grammar / Spelling /
    -- Pronunciation) made "browse by deck" look core rather than a detail; default
    -- keeps this column additive for any row inserted before the app had decks.
    "deck" "text" DEFAULT 'Ukrainian' NOT NULL,
    -- D18, resolved against a real export 2026-09-16: a "Capybara Pronunciation
    -- (shadowing)" note is an `anki_notes` row too, `kind = 'pronunciation'`, reusing
    -- these same columns (TargetText->lemma, ReferenceAudio->audio_url,
    -- Translation->lemma_translation, Hint->gloss) rather than a parallel table.
    "kind" "text" DEFAULT 'vocab' NOT NULL,
    -- D17, resolved against the same export: true only for a real `Capybara+`
    -- note, which produces a second, independently-scheduled `Spelling` card
    -- (see anki_card_state/anki_reviews' card_kind column below). Default false
    -- keeps this additive for every note that isn't one.
    "has_spelling" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "anki_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "anki_notes_anki_guid_key" UNIQUE ("anki_guid"),
    CONSTRAINT "anki_notes_language_check" CHECK (("language" = ANY (ARRAY['uk'::"text", 'en'::"text"]))),
    CONSTRAINT "anki_notes_source_check" CHECK (("source" = ANY (ARRAY['scan'::"text", 'bot'::"text", 'anki-import'::"text"]))),
    CONSTRAINT "anki_notes_kind_check" CHECK (("kind" = ANY (ARRAY['vocab'::"text", 'pronunciation'::"text"])))
);

-- One row per CARD, not per note (D17, resolved 2026-09-16 against a real export:
-- a `Capybara+` note's real Anki data confirmed it produces two independently-
-- scheduled cards — separate `cards` rows, separate revlog history — so folding
-- them into one row per note would silently merge two different memory states).
-- `card_kind` defaults to 'recall'; 'spelling' only ever exists for a note with
-- `anki_notes.has_spelling`. A cache over "anki_reviews" (docs/DESIGN.md §4.3),
-- folded without regard to who reviewed — see D2. Correct as long as a note is only
-- ever reviewed by one person, which decks being disjoint by language makes true
-- today; the escape hatch if that ever stops holding is to split this table by
-- (note_id, card_kind, user_id) and rebuild it by replaying "anki_reviews" — nothing
-- about "anki_reviews" itself has to change to do that.
CREATE TABLE IF NOT EXISTS "public"."anki_card_state" (
    "note_id" "uuid" NOT NULL,
    "card_kind" "text" DEFAULT 'recall' NOT NULL,
    "due" timestamp with time zone,
    "stability" real,
    "difficulty" real,
    "state" smallint,
    "reps" integer DEFAULT 0 NOT NULL,
    "lapses" integer DEFAULT 0 NOT NULL,
    -- Required to correctly resume FSRS scheduling, not optional bookkeeping:
    -- ts-fsrs derives elapsed time from this against the next review's timestamp
    -- (confirmed directly against the library — the alternative, storing
    -- elapsed_days/scheduled_days instead, was tried and found to be ignored by
    -- the library on a resumed card). Real Anki carries the equivalent as "lrt"
    -- on a card's own memory-state JSON, found while reading a real export during
    -- the migration spike (docs/DESIGN.md §7.5) — this isn't a guess.
    "last_review" timestamp with time zone,
    "suspended" boolean DEFAULT false NOT NULL,
    -- Denormalized from the fold, not authoritative: whichever user_id last
    -- appeared in `anki_reviews` for this note. Lets the reviewer filter "my due
    -- queue" without a join.
    "last_user_id" "uuid",
    CONSTRAINT "anki_card_state_pkey" PRIMARY KEY ("note_id", "card_kind"),
    CONSTRAINT "anki_card_state_card_kind_check" CHECK (("card_kind" = ANY (ARRAY['recall'::"text", 'spelling'::"text"]))),
    CONSTRAINT "anki_card_state_state_check" CHECK ((("state" IS NULL) OR ("state" BETWEEN 0 AND 3))),
    CONSTRAINT "anki_card_state_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."anki_notes"("id") ON DELETE CASCADE,
    CONSTRAINT "anki_card_state_last_user_id_fkey" FOREIGN KEY ("last_user_id") REFERENCES "public"."users"("id")
);

CREATE INDEX IF NOT EXISTS "anki_card_state_due_idx" ON "public"."anki_card_state" USING "btree" ("last_user_id", "due")
    WHERE (NOT "suspended");

-- Append-only. The sync primitive (docs/DESIGN.md §4.2). Never updated, never
-- deleted by the application. "id" is client-generated so a retried or replayed
-- ingest is an idempotent no-op, not a duplicate. "card_kind" (D17) records which
-- of a note's (one or two) cards this answers — see anki_card_state's own comment.
CREATE TABLE IF NOT EXISTS "public"."anki_reviews" (
    "id" "uuid" NOT NULL,
    "note_id" "uuid" NOT NULL,
    "card_kind" "text" DEFAULT 'recall' NOT NULL,
    "user_id" "uuid" NOT NULL,
    "rating" smallint NOT NULL,
    -- Client clock: when the review actually happened. What FSRS replay needs.
    "reviewed_at" timestamp with time zone NOT NULL,
    "elapsed_days" integer,
    "scheduled_days" integer,
    -- Server clock: when it reached the database. What debugging a week-long
    -- offline stretch needs — very different from reviewed_at in that case.
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "anki_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "anki_reviews_rating_check" CHECK (("rating" BETWEEN 1 AND 4)),
    CONSTRAINT "anki_reviews_card_kind_check" CHECK (("card_kind" = ANY (ARRAY['recall'::"text", 'spelling'::"text"]))),
    CONSTRAINT "anki_reviews_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "public"."anki_notes"("id") ON DELETE CASCADE,
    CONSTRAINT "anki_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
);

CREATE INDEX IF NOT EXISTS "anki_reviews_note_id_reviewed_at_idx" ON "public"."anki_reviews" USING "btree" ("note_id", "reviewed_at");

-- Per-person. Lifted verbatim from AnkiDroid at migration (docs/DESIGN.md §7.3),
-- one row per user. Verified real values for one user, 2026-09-15: desired_retention
-- 0.9, learning_steps {1,10} (minutes), daily_new_limit 40, daily_review_limit 200,
-- max_interval 36500. fsrs_params was an empty array for that user — a real,
-- meaningful state (FSRS on, "Optimize" never run), not missing data; ts-fsrs falls
-- back to its own built-in defaults for an empty array, so the application does not
-- need to special-case it either.
CREATE TABLE IF NOT EXISTS "public"."anki_scheduler_config" (
    "user_id" "uuid" NOT NULL,
    "fsrs_params" real[] DEFAULT '{}' NOT NULL,
    "desired_retention" real,
    "learning_steps" real[],
    "daily_new_limit" integer,
    "daily_review_limit" integer,
    "max_interval" integer,
    CONSTRAINT "anki_scheduler_config_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "anki_scheduler_config_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
);
