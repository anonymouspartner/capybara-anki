"""Unit tests for load_recovery.py's pure row-preparation logic. No network, no
Postgres — these only exercise _parse_user_map and _prepare_rows.
"""

from __future__ import annotations

import pytest

from migration.load_recovery import _parse_user_map, _prepare_rows


class TestParseUserMap:
    def test_single_pair(self):
        assert _parse_user_map(["tim=abc-123"]) == {"tim": "abc-123"}

    def test_multiple_pairs(self):
        assert _parse_user_map(["tim=abc", "vika=def"]) == {"tim": "abc", "vika": "def"}

    def test_missing_equals_sign_raises(self):
        with pytest.raises(SystemExit):
            _parse_user_map(["tim"])


class TestPrepareRows:
    def test_drops_null_created_at_so_the_db_default_applies(self):
        rows = [{"id": "n1", "lemma": "x", "created_at": None}]
        prepared = _prepare_rows(rows, "anki_notes", None, {})
        assert "created_at" not in prepared[0]

    def test_keeps_non_null_created_at(self):
        rows = [{"id": "n1", "lemma": "x", "created_at": "2026-01-01T00:00:00Z"}]
        prepared = _prepare_rows(rows, "anki_notes", None, {})
        assert prepared[0]["created_at"] == "2026-01-01T00:00:00Z"

    def test_remaps_placeholder_user_id(self):
        rows = [{"note_id": "n1", "last_user_id": "tim"}]
        prepared = _prepare_rows(rows, "anki_card_state", "last_user_id", {"tim": "real-uuid"})
        assert prepared[0]["last_user_id"] == "real-uuid"

    def test_unmapped_placeholder_raises(self):
        rows = [{"note_id": "n1", "last_user_id": "tim"}]
        with pytest.raises(SystemExit):
            _prepare_rows(rows, "anki_card_state", "last_user_id", {})

    def test_does_not_mutate_the_input_row(self):
        row = {"note_id": "n1", "last_user_id": "tim"}
        rows = [row]
        _prepare_rows(rows, "anki_card_state", "last_user_id", {"tim": "real-uuid"})
        assert row["last_user_id"] == "tim"

    def test_reviews_drops_null_ingested_at(self):
        rows = [{"id": "r1", "user_id": "tim", "ingested_at": None}]
        prepared = _prepare_rows(rows, "anki_reviews", "user_id", {"tim": "real-uuid"})
        assert "ingested_at" not in prepared[0]
        assert prepared[0]["user_id"] == "real-uuid"
