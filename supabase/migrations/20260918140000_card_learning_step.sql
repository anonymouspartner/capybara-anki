-- Per-card (re)learning-step counter — see src/fsrs/types.ts's FsrsCardState.learningStep.
--
-- ts-fsrs 5.0 (FSRS-6) added `Card.learning_steps`: which step of the configured
-- (re)learning sequence a card in New/Learning/Relearning is currently on. It has
-- to round-trip through storage like every other FSRS field this table already
-- carries (due, stability, ...) or resuming a card mid-steps silently restarts it
-- at step 0 instead of continuing where it left off.
--
-- Deliberately optional to apply, same shape as leech_threshold/leech_action:
-- cardStateFromRow reads it through a nullish fallback to 0 (the same value a
-- never-reviewed card already defaults to), and `select *` simply omits a column
-- that does not exist, so the app behaves identically before and after this
-- migration runs — it just can't correctly resume a card mid-steps until it does.

alter table anki_card_state
  add column if not exists learning_step smallint not null default 0;

alter table anki_card_state
  drop constraint if exists anki_card_state_learning_step_check;
alter table anki_card_state
  add constraint anki_card_state_learning_step_check
  check (learning_step >= 0);

comment on column anki_card_state.learning_step is
  'ts-fsrs Card.learning_steps: which (re)learning step this card is currently on — an index into anki_scheduler_config.learning_steps, not a duration. 0 once graduated to Review, and 0 before a card''s first review. See src/fsrs/replay.ts.';
