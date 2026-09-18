-- D12's third action, the one that was never built — see src/review/mutations.ts's
-- buildBuryMutation and docs/MIGRATION.md §4 ("No bury").
--
-- Stored as the ankiDayKey (src/review/day.ts) the card was buried on, not a
-- boolean or an expiry instant: "still buried" is exactly "buried_on equals
-- today's key" for the card's owner, which the app already knows how to compute
-- (day.ts exists precisely so no wall-clock-to-UTC conversion is ever needed for
-- this kind of check) — so a bury just stops mattering the moment the study day
-- rolls over, with no unbury step, no cron job, nothing to expire.
--
-- Text, not date: an ankiDayKey is a civil calendar date deliberately decoupled
-- from any single timezone (see day.ts's module docstring) — storing it as
-- Postgres `date` would invite exactly the "is this UTC or local" ambiguity that
-- type deliberately avoids everywhere else in this app.

alter table anki_card_state
  add column if not exists buried_on text;

comment on column anki_card_state.buried_on is
  'ankiDayKey (day.ts) this card was buried on, or NULL if not buried. Expires on its own at the next study-day rollover — see src/review/mutations.ts buildBuryMutation.';
