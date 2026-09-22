"""Unit tests for backup_tables.py's pure logic and its PostgREST pagination —
`_request` is monkeypatched to canned responses rather than touching a real
network, the same "no real API call" boundary check.yml's own comment holds
every other test in this suite to.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from migration.backup_tables import _fetch_all, _object_path, main


class TestObjectPath:
    def test_groups_by_year_and_stamps_to_the_second(self):
        now = datetime(2026, 9, 22, 3, 0, 5, tzinfo=timezone.utc)
        assert _object_path(now) == "2026/2026-09-22T030005Z.json"

    def test_two_calls_in_the_same_second_collide_by_design(self):
        # Not a bug to route around: this runs once a day from a schedule, and a
        # human re-running it by hand a second later gets a second, later path.
        now = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        assert _object_path(now) == _object_path(now)


class TestFetchAll:
    def test_stops_after_a_short_page(self, monkeypatch):
        import migration.backup_tables as backup_tables

        def fake_request(method, url, *, key, body=None, extra_headers=None):
            assert method == "GET"
            assert "anki_notes" in url
            return 200, json.dumps([{"id": "n1"}, {"id": "n2"}]).encode()

        monkeypatch.setattr(backup_tables, "_request", fake_request)
        rows = _fetch_all("https://example.supabase.co", "key", "anki_notes")
        assert rows == [{"id": "n1"}, {"id": "n2"}]

    def test_pages_past_the_cap(self, monkeypatch):
        import migration.backup_tables as backup_tables

        pages = [
            [{"id": str(i)} for i in range(backup_tables.PAGE_SIZE)],
            [{"id": "last"}],
        ]

        def fake_request(method, url, *, key, body=None, extra_headers=None):
            return 200, json.dumps(pages.pop(0)).encode()

        monkeypatch.setattr(backup_tables, "_request", fake_request)
        rows = _fetch_all("https://example.supabase.co", "key", "anki_reviews")
        assert len(rows) == backup_tables.PAGE_SIZE + 1
        assert rows[-1] == {"id": "last"}

    def test_a_non_2xx_status_raises_rather_than_silently_dropping_rows(self, monkeypatch):
        import migration.backup_tables as backup_tables
        import pytest

        def fake_request(method, url, *, key, body=None, extra_headers=None):
            return 500, b"internal error"

        monkeypatch.setattr(backup_tables, "_request", fake_request)
        with pytest.raises(SystemExit):
            _fetch_all("https://example.supabase.co", "key", "anki_notes")


class TestDryRun:
    def test_reports_counts_and_writes_nothing(self, monkeypatch, capsys):
        import migration.backup_tables as backup_tables

        table_rows = {
            "anki_notes": [{"id": "1"}],
            "anki_card_state": [{"id": "2"}, {"id": "3"}],
            "anki_reviews": [],
            "anki_scheduler_config": [{"id": "4"}],
        }

        def fake_fetch_all(base_url, key, table):
            return table_rows[table]

        called = {"ensure_bucket": False, "upload_snapshot": False}
        monkeypatch.setattr(backup_tables, "_fetch_all", fake_fetch_all)
        monkeypatch.setattr(backup_tables, "ensure_bucket", lambda *a, **k: called.__setitem__("ensure_bucket", True))
        monkeypatch.setattr(backup_tables, "upload_snapshot", lambda *a, **k: called.__setitem__("upload_snapshot", True))
        monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-key")

        exit_code = main(["--dry-run"])

        assert exit_code == 0
        assert called == {"ensure_bucket": False, "upload_snapshot": False}
        out = capsys.readouterr().out
        assert "'anki_notes': 1" in out
        assert "'anki_reviews': 0" in out
        assert "would write anki-backups/" in out

    def test_missing_credentials_exits_before_fetching_anything(self, monkeypatch):
        import migration.backup_tables as backup_tables
        import pytest

        def unexpected_fetch(*a, **k):
            raise AssertionError("should never fetch without credentials")

        monkeypatch.setattr(backup_tables, "_fetch_all", unexpected_fetch)
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

        with pytest.raises(SystemExit):
            main(["--dry-run"])
