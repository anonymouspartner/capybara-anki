-- Leech settings on the per-user scheduler config (see src/review/leech.ts).
--
-- Anki has carried these in its deck config since long before FSRS; this app's
-- anki_scheduler_config already mirrors the rest of that config, so they belong
-- beside daily_new_limit and rollover_hour rather than in a new table.
--
-- Deliberately optional to apply. schedulerConfigFromRow reads both through a
-- nullish fallback to the same defaults written below, and `select *` simply
-- omits a column that does not exist, so the app behaves identically before and
-- after this migration runs. Applying it only buys the ability to change the
-- values per person; skipping it leaves everyone on Anki's defaults. This is the
-- same shape time_zone/rollover_hour used when they were added.
--
-- Defaults match Anki (rslib/src/deckconfig/mod.rs): threshold 8, and the
-- non-destructive action. 'tag' here means "say so, change no scheduling" —
-- there is no tags table in this schema, so the announcement is the action.

alter table anki_scheduler_config
  add column if not exists leech_threshold smallint not null default 8,
  add column if not exists leech_action text not null default 'tag';

-- 0 disables the check outright, matching Anki; anything negative is meaningless.
alter table anki_scheduler_config
  drop constraint if exists anki_scheduler_config_leech_threshold_check;
alter table anki_scheduler_config
  add constraint anki_scheduler_config_leech_threshold_check
  check (leech_threshold >= 0);

alter table anki_scheduler_config
  drop constraint if exists anki_scheduler_config_leech_action_check;
alter table anki_scheduler_config
  add constraint anki_scheduler_config_leech_action_check
  check (leech_action in ('tag', 'suspend'));

comment on column anki_scheduler_config.leech_threshold is
  'Lapses before a card is called a leech. 0 disables. Anki default 8. Fires at the threshold and every half-threshold after — see src/review/leech.ts.';
comment on column anki_scheduler_config.leech_action is
  'tag = announce it in the reviewer and change nothing; suspend = also take the card out of rotation.';
