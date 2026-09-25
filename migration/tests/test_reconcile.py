"""Unit tests for reconcile.py. `build_report` is pure — rows in, checks out — so
every case here is a handful of synthetic rows, never a real table or network
call (check.yml's boundary). The rows mirror the live shapes the report was
first run against: the imported/in-app split by uuid version, a schedule row a
recovery load left behind its log, a double tap."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

from migration.reconcile import (
    FREEZE_AT, PASS, WARN, FAIL, build_report, is_imported, pick_snapshot, render, snapshot_time,
)
from migration.transform import review_uuid

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
SINCE = NOW - timedelta(days=7)
TIM = "u-tim"
VIKA = "u-vika"
N1 = "note-1"
N2 = "note-2"


def ts(dt: datetime) -> str:
    return dt.isoformat()


def app_review(note, when, *, user=TIM, rating=3, kind="recall"):
    return {"id": str(uuid.uuid4()), "note_id": note, "card_kind": kind, "user_id": user,
            "rating": rating, "reviewed_at": ts(when)}


def phone_review(note, when, *, revlog, user=TIM, rating=3):
    return {"id": review_uuid(1, revlog), "note_id": note, "card_kind": "recall", "user_id": user,
            "rating": rating, "reviewed_at": ts(when)}


def state(note, last_review, *, kind="recall", due=None, stability=5.0):
    return {"note_id": note, "card_kind": kind, "due": ts(due or last_review + timedelta(days=3)),
            "stability": stability, "difficulty": 5.0, "state": 2, "reps": 3, "lapses": 0,
            "last_review": ts(last_review) if last_review else None, "suspended": False,
            "buried_on": None, "last_user_id": TIM}


def live(notes=None, states=(), reviews=()):
    return {
        "anki_notes": notes if notes is not None else [
            {"id": N1, "anki_guid": "g1", "language": "uk"},
            {"id": N2, "anki_guid": "g2", "language": "en"},
        ],
        "anki_card_state": list(states),
        "anki_reviews": list(reviews),
        "users": [{"id": TIM, "learning_language": "uk"}, {"id": VIKA, "learning_language": "en"}],
    }


def check(report, name):
    return next(c for c in report.checks if c.name == name)


def run(data, **kw):
    return build_report(data, since=SINCE, now=NOW, **kw)


class TestProvenance:
    def test_imported_ids_are_uuid5_and_app_ids_are_uuid4(self):
        assert is_imported(review_uuid(123, 456))
        assert not is_imported(str(uuid.uuid4()))
        assert not is_imported("not-a-uuid")


class TestClean:
    def test_a_consistent_week_passes(self):
        t = NOW - timedelta(days=2)
        r = app_review(N1, t)
        report = run(live(states=[state(N1, t)], reviews=[r]))
        assert not report.failed
        assert all(c.status == PASS for c in report.checks)
        assert report.activity == {"learner of uk": {t.date().isoformat(): 1}}
        assert "RESULT: no drift" in render(report)


class TestScheduleAgainstLog:
    def test_a_review_newer_than_the_schedule_fails_inside_the_window(self):
        # The load_recovery shape: the review row landed, the state row didn't move.
        old, new = NOW - timedelta(days=20), NOW - timedelta(days=1)
        report = run(live(states=[state(N1, old)], reviews=[app_review(N1, old), app_review(N1, new)]))
        assert check(report, "schedule-behind-log").status == FAIL
        assert report.failed

    def test_the_same_drift_older_than_the_window_only_warns(self):
        old, newer = NOW - timedelta(days=30), NOW - timedelta(days=20)
        report = run(live(states=[state(N1, old)], reviews=[phone_review(N1, old, revlog=1), phone_review(N1, newer, revlog=2)]))
        c = check(report, "schedule-behind-log")
        assert c.status == WARN and len(c.ids) == 1
        assert not report.failed

    def test_a_schedule_with_no_review_behind_it_fails(self):
        t = NOW - timedelta(days=1)
        report = run(live(states=[state(N1, t)], reviews=[]))
        assert check(report, "schedule-ahead-of-log").status == FAIL

    def test_sub_second_clock_rounding_is_not_drift(self):
        t = NOW - timedelta(days=1)
        report = run(live(states=[state(N1, t + timedelta(milliseconds=400))], reviews=[app_review(N1, t)]))
        assert check(report, "schedule-behind-log").status == PASS
        assert check(report, "schedule-ahead-of-log").status == PASS

    def test_a_new_card_with_no_reviews_and_no_last_review_is_fine(self):
        report = run(live(states=[state(N1, None, due=NOW)], reviews=[]))
        assert not report.failed

    def test_reviews_of_a_card_with_no_schedule_row_fail(self):
        report = run(live(states=[], reviews=[app_review(N1, NOW - timedelta(hours=1))]))
        assert check(report, "reviews-without-schedule").status == FAIL

    def test_cards_are_keyed_by_kind_too(self):
        t = NOW - timedelta(days=1)
        report = run(live(states=[state(N1, t), state(N1, t - timedelta(days=5), kind="spelling")],
                          reviews=[app_review(N1, t), app_review(N1, t - timedelta(days=5), kind="spelling")]))
        assert not report.failed


class TestDoubleSubmits:
    def test_two_answers_one_second_apart_are_one_tap_twice(self):
        t = NOW - timedelta(days=1)
        second = t + timedelta(seconds=1.5)
        report = run(live(states=[state(N1, second)], reviews=[app_review(N1, t), app_review(N1, second)]))
        c = check(report, "double-submits")
        assert c.status == FAIL and len(c.ids) == 1

    def test_three_taps_count_twice(self):
        t = NOW - timedelta(days=1)
        rows = [app_review(N1, t + timedelta(seconds=s)) for s in (0, 1.5, 2.4)]
        report = run(live(states=[state(N1, t + timedelta(seconds=2.4))], reviews=rows))
        assert len(check(report, "double-submits").ids) == 2

    def test_imported_near_pairs_are_ankidroid_history_not_this_app(self):
        t = NOW - timedelta(days=1)
        rows = [phone_review(N1, t, revlog=1), phone_review(N1, t + timedelta(seconds=1), revlog=2)]
        report = run(live(states=[state(N1, t + timedelta(seconds=1))], reviews=rows), freeze_at=NOW)
        assert check(report, "double-submits").status == PASS

    def test_two_people_answering_the_same_card_is_not_a_double_tap(self):
        t = NOW - timedelta(days=1)
        rows = [app_review(N1, t), app_review(N1, t + timedelta(seconds=1), user=VIKA)]
        report = run(live(states=[state(N1, t + timedelta(seconds=1))], reviews=rows))
        assert check(report, "double-submits").status == PASS


class TestFreeze:
    def test_ankidroid_reviews_before_the_freeze_pass(self):
        t = FREEZE_AT - timedelta(days=5)
        report = run(live(states=[state(N1, t)], reviews=[phone_review(N1, t, revlog=1)]))
        c = check(report, "freeze-held")
        assert c.status == PASS and t.date().isoformat() in c.summary

    def test_an_ankidroid_review_after_the_freeze_fails(self):
        t = FREEZE_AT + timedelta(days=1)
        report = run(live(states=[state(N1, t)], reviews=[phone_review(N1, t, revlog=1)]))
        assert check(report, "freeze-held").status == FAIL


class TestOwnDecks:
    def test_reviewing_the_partners_language_warns(self):
        t = NOW - timedelta(days=1)
        report = run(live(states=[state(N2, t)], reviews=[app_review(N2, t, user=TIM)]))
        assert check(report, "own-decks-only").status == WARN
        assert not report.failed


class TestBaseline:
    def _pair(self, before_reviews, after_reviews, before_states, after_states, notes=None):
        base = live(notes=notes, states=before_states, reviews=before_reviews)
        now = live(notes=notes, states=after_states, reviews=after_reviews)
        return run(now, baseline=base, baseline_label="test")

    def test_a_week_of_ordinary_reviewing_passes(self):
        t0, t1 = SINCE - timedelta(days=3), NOW - timedelta(days=1)
        r0, r1 = app_review(N1, t0), app_review(N1, t1)
        report = self._pair([r0], [r0, r1], [state(N1, t0)], [state(N1, t1, stability=9.0)])
        assert not report.failed
        assert check(report, "history-kept").status == PASS
        assert check(report, "schedule-moves-only-with-reviews").status == PASS

    def test_a_lost_review_fails(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        report = self._pair([r0], [], [state(N1, t0)], [state(N1, t0)])
        assert check(report, "history-kept").status == FAIL

    def test_history_that_left_with_its_deleted_note_is_expected(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N2, t0)
        base = live(states=[state(N2, t0)], reviews=[r0])
        after = live(notes=[{"id": N1, "anki_guid": "g1", "language": "uk"}])
        report = run(after, baseline=base, baseline_label="test")
        c = check(report, "history-kept")
        assert c.status == PASS and "deleted note" in c.summary
        assert "1 deleted" in check(report, "notes").summary

    def test_a_rewritten_review_fails(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        changed = dict(r0, rating=1)
        report = self._pair([r0], [changed], [state(N1, t0)], [state(N1, t0)])
        assert check(report, "history-unchanged").status == FAIL

    def test_the_same_instant_formatted_differently_is_not_a_rewrite(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        reformatted = dict(r0, reviewed_at=t0.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z")
        report = self._pair([r0], [reformatted], [state(N1, t0)], [state(N1, t0)])
        assert check(report, "history-unchanged").status == PASS

    def test_a_schedule_that_moved_without_a_review_fails(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        moved = state(N1, t0 + timedelta(days=2), stability=40.0)
        report = self._pair([r0], [r0], [state(N1, t0)], [moved])
        assert check(report, "schedule-moves-only-with-reviews").status == FAIL

    def test_a_re_derived_schedule_with_the_same_last_review_looks_like_an_undo(self):
        # Rated in the window, then undone: the review is gone and the state was
        # replayed from what's left -- same last_review, different numbers.
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        report = self._pair([r0], [r0], [state(N1, t0)], [state(N1, t0, stability=4.2)])
        assert check(report, "schedule-moves-only-with-reviews").status == WARN
        assert not report.failed

    def test_suspending_or_burying_is_not_a_schedule_move(self):
        t0 = SINCE - timedelta(days=3)
        r0 = app_review(N1, t0)
        after = dict(state(N1, t0), suspended=True, buried_on="2026-10-01")
        report = self._pair([r0], [r0], [state(N1, t0)], [after])
        assert check(report, "schedule-moves-only-with-reviews").status == PASS


class TestExport:
    def test_everything_loaded_and_frozen_passes(self):
        t = FREEZE_AT - timedelta(days=2)
        pr = phone_review(N1, t, revlog=7)
        export = {"anki_notes": [{"id": N1, "anki_guid": "g1"}], "anki_reviews": [pr]}
        report = run(live(states=[state(N1, t)], reviews=[pr]), export=export)
        assert check(report, "export-notes-loaded").status == PASS
        assert check(report, "export-reviews-loaded").status == PASS
        assert check(report, "export-after-freeze").status == PASS

    def test_an_export_not_yet_loaded_fails_and_says_how_to_fix_it(self):
        t = FREEZE_AT - timedelta(days=2)
        export = {"anki_notes": [{"id": "note-9", "anki_guid": "g9"}],
                  "anki_reviews": [phone_review("note-9", t, revlog=8)]}
        report = run(live(), export=export)
        assert check(report, "export-notes-loaded").status == FAIL
        c = check(report, "export-reviews-loaded")
        assert c.status == FAIL and "load_recovery" in c.summary

    def test_an_export_with_reviews_after_the_freeze_fails(self):
        t = FREEZE_AT + timedelta(hours=3)
        pr = phone_review(N1, t, revlog=9)
        report = run(live(states=[state(N1, t)], reviews=[pr]),
                     export={"anki_notes": [], "anki_reviews": [pr]})
        assert check(report, "export-after-freeze").status == FAIL


class TestSnapshots:
    PATHS = ["2026/2026-09-22T065758Z.json", "2026/2026-09-23T030412Z.json", "2026/2026-09-24T030455Z.json"]

    def test_reads_the_time_back_out_of_the_path(self):
        assert snapshot_time(self.PATHS[0]) == datetime(2026, 9, 22, 6, 57, 58, tzinfo=timezone.utc)

    def test_picks_the_newest_snapshot_at_or_before_the_window_start(self):
        since = datetime(2026, 9, 24, 0, 0, tzinfo=timezone.utc)
        assert pick_snapshot(self.PATHS, since) == self.PATHS[1]

    def test_falls_back_to_the_oldest_when_the_window_predates_every_backup(self):
        since = datetime(2026, 9, 1, tzinfo=timezone.utc)
        assert pick_snapshot(self.PATHS, since) == self.PATHS[0]

    def test_no_snapshots_means_no_baseline(self):
        assert pick_snapshot([], NOW) is None


class TestPrivacy:
    def test_output_carries_no_text_and_no_ids_unless_asked(self):
        t = NOW - timedelta(days=1)
        notes = [{"id": N1, "anki_guid": "g1", "language": "uk", "lemma": "SECRET-LEMMA"}]
        r = app_review(N1, t)
        report = run(live(notes=notes, states=[], reviews=[r]))
        plain = render(report)
        assert "SECRET-LEMMA" not in plain
        assert r["id"] not in plain and N1 not in plain
        assert TIM not in plain
        detailed = render(report, details=True)
        assert "SECRET-LEMMA" not in detailed
        assert N1 in detailed

    def test_report_is_json_safe_input_agnostic(self):
        # Timestamps may arrive as PostgREST strings or as a snapshot's strings —
        # both parse; a round trip through JSON changes nothing.
        t = NOW - timedelta(days=1)
        data = json.loads(json.dumps(live(states=[state(N1, t)], reviews=[app_review(N1, t)])))
        assert not run(data).failed


class TestIO:
    def test_fetch_baseline_lists_the_bucket_and_downloads_the_right_snapshot(self, monkeypatch):
        import migration.reconcile as reconcile

        calls = []
        snap = {"taken_at": "x", "tables": {"anki_notes": [], "anki_card_state": [], "anki_reviews": []}}

        def fake_request(method, url, *, key, body=None, extra_headers=None):
            calls.append((method, url))
            if "/object/list/" in url:
                prefix = json.loads(body)["prefix"]
                names = ["2026-09-22T065758Z.json", "2026-09-23T030412Z.json"] if prefix == "2026" else []
                return 200, json.dumps([{"name": n} for n in names]).encode()
            return 200, json.dumps(snap).encode()

        monkeypatch.setattr(reconcile, "_request", fake_request)
        tables, label = reconcile.fetch_baseline("https://x.supabase.co", "k",
                                                 datetime(2026, 9, 23, 12, tzinfo=timezone.utc))
        assert tables == snap["tables"]
        assert label == "anki-backups/2026/2026-09-23T030412Z.json"
        assert calls[-1] == ("GET", "https://x.supabase.co/storage/v1/object/anki-backups/2026/2026-09-23T030412Z.json")

    def test_main_exits_1_on_drift_and_0_without(self, monkeypatch, capsys):
        import migration.reconcile as reconcile

        t = datetime.now(timezone.utc) - timedelta(days=1)
        monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
        clean = live(states=[state(N1, t)], reviews=[app_review(N1, t)])
        monkeypatch.setattr(reconcile, "fetch_live", lambda *_: clean)
        assert reconcile.main(["--no-baseline"]) == 0
        drifted = live(states=[state(N1, t - timedelta(days=2))], reviews=[app_review(N1, t)])
        monkeypatch.setattr(reconcile, "fetch_live", lambda *_: drifted)
        assert reconcile.main(["--no-baseline"]) == 1
        assert "DRIFT" in capsys.readouterr().out
