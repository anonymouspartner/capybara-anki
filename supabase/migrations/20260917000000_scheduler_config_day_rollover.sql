-- Per-user day rollover — when this person's study day ends and the next begins.
--
-- Everything that counts "today" (the daily new/review limits, the stats histogram,
-- the streak) was bucketing by midnight UTC. Anki doesn't: a day rolls over at a
-- configurable LOCAL hour, 4am by default, and the current day doesn't count before
-- that time (rslib/src/scheduler/timing.rs). The visible symptom was a streak reading
-- 0 while AnkiDroid, on the same review history, still counted it.
--
-- Both columns live here, on the existing per-user config row, rather than as a
-- function secret or an instance-wide constant, for the reason this table is
-- per-user in the first place: the two halves of a couple learning each other's
-- languages are not reliably in the same country, so "the instance's timezone" is
-- not a thing that exists. Anki stores the same pair per collection.
--
-- Additive and safe to re-run. Both columns are nullable with the application
-- falling back to (UTC, 4am) when unset, so no backfill is required and every
-- existing row keeps meaning exactly what it meant before this ran.

-- IANA zone name, e.g. 'America/New_York'. NOT a UTC offset, deliberately: Eastern
-- is UTC-4 in July and UTC-5 in December, so a stored offset would be wrong for
-- half the year. The application resolves the zone through Intl, which carries the
-- zone database and gets the DST transitions right.
ALTER TABLE "public"."anki_scheduler_config"
    ADD COLUMN IF NOT EXISTS "time_zone" "text";

-- Local hour, 0-23, the day rolls over at. 4 is Anki's default, and is late enough
-- to catch night-owl reviewing while never landing on a US DST transition (those
-- happen at 2am), so the rollover instant is never ambiguous or missing.
ALTER TABLE "public"."anki_scheduler_config"
    ADD COLUMN IF NOT EXISTS "rollover_hour" smallint DEFAULT 4;

DO $$
BEGIN
    ALTER TABLE "public"."anki_scheduler_config"
        ADD CONSTRAINT "anki_scheduler_config_rollover_hour_check"
        CHECK (("rollover_hour" IS NULL) OR ("rollover_hour" BETWEEN 0 AND 23));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
