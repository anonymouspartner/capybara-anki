"""Unit tests for export_apkg.py's pure row-mapping and date-parsing logic — the
layer test_apkg_writer.py's round trip doesn't reach at all, since that test
builds schema.py dataclasses directly rather than going through a PostgREST JSON
row first. No network, no Postgres — every row here is hand-built.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from migration.export_apkg import (
    _card_state_from_row,
    _choose_user_id,
    _note_from_row,
    _parse_date,
    _parse_dt,
    _review_from_row,
    _scheduler_config_from_row,
)


class TestParsing:
    def test_parse_dt_handles_a_z_suffix(self):
        assert _parse_dt("2026-09-17T12:00:00Z") == datetime(2026, 9, 17, 12, 0, tzinfo=timezone.utc)

    def test_parse_dt_none_stays_none(self):
        assert _parse_dt(None) is None

    def test_parse_date_from_a_plain_date_string(self):
        assert _parse_date("2026-09-17") == date(2026, 9, 17)

    def test_parse_date_from_a_timestamp_string(self):
        # Postgres can hand back a `date` column as either shape depending on the
        # client — PostgREST's JSON encoding of a `date` column is a plain
        # "YYYY-MM-DD", but this is defensive against a timestamp sneaking through.
        assert _parse_date("2026-09-17T00:00:00Z") == date(2026, 9, 17)

    def test_parse_date_none_stays_none(self):
        assert _parse_date(None) is None


class TestRowMapping:
    def test_note_from_row_maps_every_field(self):
        row = {
            "id": "n1", "anki_guid": "guid-1", "lemma": "приклад", "gloss": "example",
            "lemma_translation": "example", "part_of_speech": "noun", "language": "uk",
            "example": "Це приклад.", "example_translation": "This is an example.",
            "audio_url": None, "source": "anki-import", "deck": "Ukrainian",
            "kind": "vocab", "has_spelling": True, "created_at": "2026-06-10T08:00:00Z",
        }
        note = _note_from_row(row)
        assert note.id == "n1"
        assert note.anki_guid == "guid-1"
        assert note.lemma == "приклад"
        assert note.has_spelling is True
        assert note.created_at == datetime(2026, 6, 10, 8, 0, tzinfo=timezone.utc)

    def test_note_from_row_defaults_missing_optional_fields(self):
        row = {"id": "n2", "lemma": "b", "language": "uk"}
        note = _note_from_row(row)
        assert note.deck == "Ukrainian"
        assert note.kind == "vocab"
        assert note.has_spelling is False
        assert note.source == "anki-import"

    def test_card_state_from_row(self):
        row = {
            "note_id": "n1", "due": "2026-10-01", "stability": 4.2, "difficulty": 5.6,
            "state": 2, "reps": 3, "lapses": 0, "suspended": False,
            "last_user_id": "u1", "card_kind": "recall", "last_review": "2026-09-15T12:00:00Z",
        }
        cs = _card_state_from_row(row)
        assert cs.due == date(2026, 10, 1)
        assert cs.stability == 4.2
        assert cs.last_review == datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)

    def test_card_state_from_row_new_card_has_nulls(self):
        row = {"note_id": "n1", "card_kind": "recall", "last_user_id": "u1"}
        cs = _card_state_from_row(row)
        assert cs.due is None
        assert cs.stability is None
        assert cs.state is None
        assert cs.suspended is False

    def test_review_from_row(self):
        row = {
            "id": "r1", "note_id": "n1", "user_id": "u1", "rating": 3,
            "reviewed_at": "2026-09-15T12:00:00Z", "elapsed_days": 1,
            "scheduled_days": 4, "card_kind": "recall",
        }
        rv = _review_from_row(row)
        assert rv.rating == 3
        assert rv.reviewed_at == datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)

    def test_scheduler_config_from_row(self):
        row = {
            "user_id": "u1", "fsrs_params": [], "desired_retention": 0.9,
            "learning_steps": [1, 10], "daily_new_limit": 40,
            "daily_review_limit": 200, "max_interval": 36500,
        }
        cfg = _scheduler_config_from_row(row)
        assert cfg.desired_retention == 0.9
        assert cfg.daily_new_limit == 40


class TestChooseUserId:
    def test_explicit_user_id_wins_regardless_of_review_counts(self):
        reviews = [{"user_id": "a"}, {"user_id": "a"}, {"user_id": "b"}]
        assert _choose_user_id(reviews, explicit="b") == "b"

    def test_defaults_to_whoever_has_the_most_reviews(self):
        reviews = [{"user_id": "a"}, {"user_id": "b"}, {"user_id": "b"}, {"user_id": "b"}]
        assert _choose_user_id(reviews, explicit=None) == "b"

    def test_raises_if_no_reviews_and_no_explicit_id(self):
        try:
            _choose_user_id([], explicit=None)
            assert False, "expected SystemExit"
        except SystemExit:
            pass
