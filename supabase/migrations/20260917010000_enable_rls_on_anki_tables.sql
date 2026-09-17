-- Enable row level security on the four anki_* tables.
--
-- These were created without it, which meant the project's **anon** key — the one
-- that is public by design, safe to ship in a browser bundle, and printed in the
-- Supabase dashboard — could read and write every row. Verified against the live
-- project before this ran: an anonymous PostgREST request returned all 1037 notes,
-- 3804 reviews, 1278 card states and both scheduler_config rows. Writes were open
-- too; that path is how the original Anki import was bulk-loaded.
--
-- That is the whole vocabulary corpus and a complete, timestamped record of when
-- two specific people study, which is exactly the "private relationship memory"
-- this project exists to keep private.
--
-- WHY THERE ARE NO POLICIES
--
-- Enabling RLS with no policy denies everything to ordinary roles, which is the
-- correct and complete model here, not a stub to fill in later:
--
--   * Every legitimate reader and writer is an edge function (sync/, scan/,
--     pronounce/), and all three construct their Supabase client with
--     SUPABASE_SERVICE_ROLE_KEY. service_role carries BYPASSRLS, so none of them
--     is affected by this change. Checked all three before applying, not assumed.
--   * The browser never talks to PostgREST. web/ builds every request against
--     API_BASE = .../functions/v1 (web/config.js) and holds no Supabase key at all.
--   * There is no Supabase Auth identity to write a policy against. D13 auth is a
--     per-person device bearer token, resolved in src/auth.ts against function
--     secrets — it never becomes a JWT the database sees, so `auth.uid()` is null
--     for every request that could reach these tables. A policy like
--     `using (auth.uid() = last_user_id)` would read as security while actually
--     denying everyone, which is worse than an honest deny-all.
--
-- So: if a direct-from-browser client is ever wanted, it needs real Supabase Auth
-- first, and the policies get written then, against an identity that exists.
--
-- Idempotent: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is a no-op when already on.
--
-- Deliberately NOT using FORCE ROW LEVEL SECURITY. FORCE only extends RLS to the
-- table owner, which is not the threat here (the anon role is), and it adds a way
-- for maintenance run as the owner to fail confusingly.

ALTER TABLE "public"."anki_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."anki_card_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."anki_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."anki_scheduler_config" ENABLE ROW LEVEL SECURITY;
