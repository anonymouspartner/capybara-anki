"""The reconciliation report — docs/MIGRATION.md Phase 6.3 ("one week app-only,
with a reconciliation report") and §7 item 5 ("a week of app-only reviewing with
no reconciliation drift").

What "drift" means here
------------------------
The live tables hold two things that have to keep agreeing with each other: the
review log (`anki_reviews`, append-only history) and the schedule derived from it
(`anki_card_state`, one row per card). Drift is any way those stop agreeing, or
any way history changes after the fact:

* a card whose schedule is older than its newest review — a review landed without
  its state update. This is exactly what `load_recovery.py` leaves behind when an
  AnkiDroid review lands on a card the app already had a state row for, because
  that loader never overwrites (`ignore-duplicates`);
* a card whose schedule moved with no review to explain it;
* the same card answered twice by one tap (two in-app reviews under 2 s apart);
* a review row that disappeared or changed since the start of the window, while
  its note still exists (deleting a note deletes its history on purpose);
* an AnkiDroid review dated after the freeze (Phase 6.1) — the phone was used.

Imported and in-app reviews are told apart by their ids alone, no bookkeeping:
`transform.review_uuid` derives every imported id as a uuid5, while the app's
client mints `crypto.randomUUID()`, a uuid4.

Each check is either about the window (`--since`, default the last 7 days) or
older than it. Anything new inside the window is a FAIL; anything older is a WARN
that stays visible without failing every future run over the same known rows.

Baseline
---------
"Did history change" needs a before. By default this reads the newest daily
snapshot `backup_tables.py` wrote at or before `--since` (the private
`anki-backups` bucket), so a run on day 7 compares the whole week against the
morning it started. `--baseline FILE` uses a local snapshot instead, and
`--no-baseline` skips those checks.

After Phase 6.2
----------------
Point `--export` at the directory `python -m migration <final.colpkg> --out DIR`
wrote, and the report also checks that every note and review in AnkiDroid's final
export is in the live tables, and that none of its reviews postdate the freeze.

Privacy
--------
This repo is public and so are its Actions logs. The report prints counts only:
no lemma, no example, no name — people are labelled by the language they are
learning. `--details` adds row ids (uuids, still no text) for chasing a finding
down locally.

Run this yourself
------------------
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>
    python -m migration.reconcile                       # the last 7 days
    python -m migration.reconcile --since 2026-09-26    # the app-only week
    python -m migration.reconcile --export scratch/final

Exits 1 when any check FAILs, so `.github/workflows/reconcile.yml` goes red.
Read-only: it never writes to the database or to Storage.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from migration.backup_tables import BUCKET, _fetch_all, _request

# The moment Phase 6.1's freeze was declared — docs/MIGRATION.md §6.13.
FREEZE_AT = datetime(2026, 9, 22, 7, 5, 27, tzinfo=timezone.utc)

# Two answers to one card closer together than this are one tap recorded twice:
# nobody reads a card, decides, and answers it again inside two seconds.
DOUBLE_SUBMIT_SECONDS = 2.0

# card_state.last_review and the review's reviewed_at are written by the same
# request from the same client clock; anything beyond rounding is real.
CLOCK_SLACK_SECONDS = 1.0

# The fields the scheduler owns. suspended / buried_on / last_user_id change
# without a review on purpose (suspend, bury, the sibling bury), so they're not
# drift.
SCHEDULE_FIELDS = ("due", "stability", "difficulty", "state", "reps", "lapses", "last_review")

REVIEW_FIELDS = ("note_id", "card_kind", "user_id", "rating", "reviewed_at")

FAIL, WARN, PASS, INFO = "FAIL", "WARN", "PASS", "INFO"


@dataclass
class Check:
    name: str
    status: str
    summary: str
    ids: list[str] = field(default_factory=list)


@dataclass
class Report:
    since: datetime
    now: datetime
    baseline_label: str | None
    checks: list[Check] = field(default_factory=list)
    activity: dict[str, dict[str, int]] = field(default_factory=dict)

    @property
    def failed(self) -> bool:
        return any(c.status == FAIL for c in self.checks)


def parse_ts(value) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_imported(review_id: str) -> bool:
    """uuid5 = came from an AnkiDroid export (transform.review_uuid); anything
    else was minted by the app."""
    try:
        return uuid.UUID(review_id).version == 5
    except ValueError:
        return False


def _card(row: dict) -> tuple[str, str]:
    return (row["note_id"], row.get("card_kind") or "recall")


def _split(rows_with_time: list[tuple[str, datetime | None]], since: datetime) -> tuple[list[str], list[str]]:
    """(in the window, older) — a row with no time counts as in the window, the
    cautious side."""
    new, old = [], []
    for row_id, when in rows_with_time:
        (old if when is not None and when < since else new).append(row_id)
    return new, old


def _windowed(name: str, what: str, new: list[str], old: list[str]) -> Check:
    if new:
        extra = f" (+{len(old)} older)" if old else ""
        return Check(name, FAIL, f"{len(new)} {what} in the window{extra}", new + old)
    if old:
        return Check(name, WARN, f"{len(old)} {what}, all older than the window", old)
    return Check(name, PASS, f"no {what}")


def _label(person: dict | None) -> str:
    if not person:
        return "unknown person"
    return f"learner of {person.get('learning_language') or '?'}"


def build_report(
    live: dict[str, list[dict]],
    *,
    since: datetime,
    now: datetime,
    baseline: dict[str, list[dict]] | None = None,
    baseline_label: str | None = None,
    export: dict[str, list[dict]] | None = None,
    freeze_at: datetime = FREEZE_AT,
) -> Report:
    """Every check, from rows already in hand — no network, so the tests drive it
    with plain dicts. `live`/`baseline` are keyed by table name, as in a
    `backup_tables.py` snapshot, plus `users` for `live`."""
    report = Report(since=since, now=now, baseline_label=baseline_label)
    add = report.checks.append

    notes = {n["id"]: n for n in live["anki_notes"]}
    states = {_card(s): s for s in live["anki_card_state"]}
    reviews = live["anki_reviews"]
    people = {u["id"]: u for u in live.get("users", [])}

    by_card: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in reviews:
        by_card[_card(r)].append(r)
    for rows in by_card.values():
        rows.sort(key=lambda r: parse_ts(r["reviewed_at"]))

    # --- The schedule agrees with the log ------------------------------------
    behind, ahead = [], []
    for key, state in states.items():
        last_review = parse_ts(state.get("last_review"))
        log = by_card.get(key, [])
        newest = parse_ts(log[-1]["reviewed_at"]) if log else None
        card_id = f"{key[0]}/{key[1]}"
        if newest is None:
            if last_review is not None:
                ahead.append((card_id, last_review))
            continue
        if last_review is None or (newest - last_review).total_seconds() > CLOCK_SLACK_SECONDS:
            behind.append((card_id, newest))
        elif (last_review - newest).total_seconds() > CLOCK_SLACK_SECONDS:
            ahead.append((card_id, last_review))
    add(_windowed("schedule-behind-log", "card(s) whose schedule predates their newest review",
                  *_split(behind, since)))
    add(_windowed("schedule-ahead-of-log", "card(s) whose schedule is newer than any review",
                  *_split(ahead, since)))

    stateless = [(f"{k[0]}/{k[1]}", parse_ts(rows[-1]["reviewed_at"]))
                 for k, rows in by_card.items() if k not in states]
    add(_windowed("reviews-without-schedule", "reviewed card(s) with no schedule row",
                  *_split(stateless, since)))

    orphans = [(r["id"], parse_ts(r["reviewed_at"])) for r in reviews if r["note_id"] not in notes]
    add(_windowed("orphan-reviews", "review(s) of a note that no longer exists", *_split(orphans, since)))

    future = [r["id"] for r in reviews
              if parse_ts(r["reviewed_at"]) > now + timedelta(minutes=5)]
    add(Check("future-reviews", FAIL if future else PASS,
              f"{len(future)} review(s) dated in the future" if future else "no review dated in the future",
              future))

    # --- One tap, one review ---------------------------------------------------
    doubles = []
    for rows in by_card.values():
        app_rows = [r for r in rows if not is_imported(r["id"])]
        for a, b in zip(app_rows, app_rows[1:]):
            gap = (parse_ts(b["reviewed_at"]) - parse_ts(a["reviewed_at"])).total_seconds()
            if a["user_id"] == b["user_id"] and gap < DOUBLE_SUBMIT_SECONDS:
                doubles.append((b["id"], parse_ts(b["reviewed_at"])))
    add(_windowed("double-submits", "in-app answer(s) recorded twice for one tap", *_split(doubles, since)))

    # --- The freeze held --------------------------------------------------------
    imported = [r for r in reviews if is_imported(r["id"])]
    thawed = [r["id"] for r in imported if parse_ts(r["reviewed_at"]) > freeze_at]
    last_phone = max((parse_ts(r["reviewed_at"]) for r in imported), default=None)
    last_phone_text = last_phone.isoformat(timespec="seconds") if last_phone else "none"
    if thawed:
        add(Check("freeze-held", FAIL,
                  f"{len(thawed)} AnkiDroid review(s) after the freeze ({freeze_at:%Y-%m-%d %H:%M} UTC); "
                  f"last one {last_phone_text}", thawed))
    else:
        add(Check("freeze-held", PASS,
                  f"no AnkiDroid review after the freeze; last one in the database {last_phone_text}"))

    # --- Everyone studies their own decks --------------------------------------
    cross = [r["id"] for r in reviews
             if not is_imported(r["id"]) and parse_ts(r["reviewed_at"]) >= since
             and r["note_id"] in notes and r["user_id"] in people
             and people[r["user_id"]].get("learning_language")
             and notes[r["note_id"]].get("language") != people[r["user_id"]]["learning_language"]]
    add(Check("own-decks-only", WARN if cross else PASS,
              f"{len(cross)} review(s) in the window of the other person's language — "
              "a card has one schedule, so these move the partner's" if cross
              else "every review in the window was of the reviewer's own language", cross))

    # --- History since the baseline -------------------------------------------
    if baseline is not None:
        base_reviews = {r["id"]: r for r in baseline["anki_reviews"]}
        live_reviews = {r["id"]: r for r in reviews}
        lost = [rid for rid, r in base_reviews.items() if rid not in live_reviews and r["note_id"] in notes]
        with_note = sum(1 for rid, r in base_reviews.items() if rid not in live_reviews and r["note_id"] not in notes)
        summary = f"{len(lost)} review(s) gone while their note still exists" if lost else "no review lost"
        if with_note:
            summary += f"; {with_note} went with a deleted note (expected)"
        add(Check("history-kept", FAIL if lost else PASS, summary, lost))

        rewritten = [rid for rid, r in base_reviews.items() if rid in live_reviews and any(
            (parse_ts(r[f]) != parse_ts(live_reviews[rid][f])) if f == "reviewed_at"
            else r.get(f) != live_reviews[rid].get(f) for f in REVIEW_FIELDS)]
        add(Check("history-unchanged", FAIL if rewritten else PASS,
                  f"{len(rewritten)} review(s) changed after the fact" if rewritten
                  else "no review changed after the fact", rewritten))

        # Undo is the one legitimate way a schedule moves with no review left
        # behind it: it deletes the review and re-derives the state by replaying
        # what remains (handlers.ts undoLastReview), which lands back on the
        # baseline's last_review but can differ from it everywhere else -- the
        # baseline state may have come from AnkiDroid, not from a replay. So a
        # move that kept last_review is only a WARN; one that changed it is not
        # explained by anything and FAILs.
        new_by_card = {_card(r) for rid, r in live_reviews.items() if rid not in base_reviews}
        base_states = {_card(s): s for s in baseline["anki_card_state"]}
        moved, maybe_undo = [], []
        for key, before in base_states.items():
            after = states.get(key)
            if after is None or key in new_by_card:
                continue
            if any(_norm(before.get(f), f) != _norm(after.get(f), f) for f in SCHEDULE_FIELDS):
                same_last = _norm(before.get("last_review"), "last_review") == _norm(after.get("last_review"), "last_review")
                (maybe_undo if same_last else moved).append(f"{key[0]}/{key[1]}")
        if moved:
            summary = f"{len(moved)} card(s) rescheduled with no review since the baseline"
            if maybe_undo:
                summary += f" (+{len(maybe_undo)} that look like an undo)"
            add(Check("schedule-moves-only-with-reviews", FAIL, summary, moved + maybe_undo))
        elif maybe_undo:
            add(Check("schedule-moves-only-with-reviews", WARN,
                      f"{len(maybe_undo)} card(s) re-derived with no new review — the shape an undo leaves",
                      maybe_undo))
        else:
            add(Check("schedule-moves-only-with-reviews", PASS,
                      "every schedule change since the baseline has a review behind it"))

        base_notes = {n["id"] for n in baseline["anki_notes"]}
        added = sum(1 for nid in notes if nid not in base_notes)
        deleted = sum(1 for nid in base_notes if nid not in notes)
        add(Check("notes", INFO, f"{added} note(s) added, {deleted} deleted since the baseline"))

    # --- AnkiDroid's final export is all here ----------------------------------
    if export is not None:
        export_notes = export.get("anki_notes", [])
        export_reviews = export.get("anki_reviews", [])
        by_guid = {n.get("anki_guid") for n in live["anki_notes"]}
        missing_notes = [n["id"] for n in export_notes
                         if n["id"] not in notes and n.get("anki_guid") not in by_guid]
        live_ids = {r["id"] for r in reviews}
        missing_reviews = [r["id"] for r in export_reviews if r["id"] not in live_ids]
        hint = " — run migration.load_recovery on this export"
        add(Check("export-notes-loaded", FAIL if missing_notes else PASS,
                  f"{len(missing_notes)} of {len(export_notes)} exported note(s) not in the database{hint}"
                  if missing_notes else f"all {len(export_notes)} exported notes are in the database",
                  missing_notes))
        add(Check("export-reviews-loaded", FAIL if missing_reviews else PASS,
                  f"{len(missing_reviews)} of {len(export_reviews)} exported review(s) not in the database{hint}"
                  if missing_reviews else f"all {len(export_reviews)} exported reviews are in the database",
                  missing_reviews))
        late = [r["id"] for r in export_reviews if parse_ts(r["reviewed_at"]) > freeze_at]
        last_export = max((parse_ts(r["reviewed_at"]) for r in export_reviews), default=None)
        add(Check("export-after-freeze", FAIL if late else PASS,
                  (f"{len(late)} review(s) in the export after the freeze" if late
                   else "no review in the export after the freeze")
                  + (f"; its last review {last_export.isoformat(timespec='seconds')}" if last_export else ""),
                  late))

    # --- What the week looked like ---------------------------------------------
    activity: dict[str, Counter] = defaultdict(Counter)
    for r in reviews:
        when = parse_ts(r["reviewed_at"])
        if when >= since and not is_imported(r["id"]):
            activity[_label(people.get(r["user_id"]))][when.date().isoformat()] += 1
    report.activity = {who: dict(sorted(days.items())) for who, days in sorted(activity.items())}
    return report


def _norm(value, name: str):
    """Timestamps compare as instants (PostgREST's formatting of one can differ
    between a snapshot and a live read); reals compare at float32 precision, the
    column type."""
    if value is None:
        return None
    if name in ("due", "last_review"):
        return parse_ts(value)
    if name in ("stability", "difficulty"):
        return round(float(value), 4)
    return value


def render(report: Report, *, details: bool = False) -> str:
    lines = [
        "Reconciliation report",
        f"  window:   {report.since:%Y-%m-%d %H:%M} UTC → {report.now:%Y-%m-%d %H:%M} UTC",
        f"  baseline: {report.baseline_label or 'none (history checks skipped)'}",
        "",
    ]
    width = max(len(c.name) for c in report.checks)
    for c in report.checks:
        lines.append(f"  {c.status:<4}  {c.name:<{width}}  {c.summary}")
        if details and c.ids and c.status != PASS:
            lines.extend(f"          {i}" for i in c.ids[:50])
            if len(c.ids) > 50:
                lines.append(f"          … {len(c.ids) - 50} more")
    lines.append("")
    lines.append("In-app reviews in the window, per day:")
    if not report.activity:
        lines.append("  none")
    for who, days in report.activity.items():
        total = sum(days.values())
        lines.append(f"  {who}: {total} over {len(days)} day(s) — "
                     + ", ".join(f"{d[5:]} {n}" for d, n in days.items()))
    lines.append("")
    lines.append("RESULT: " + ("DRIFT — see FAIL lines above" if report.failed else "no drift"))
    return "\n".join(lines)


# --- I/O --------------------------------------------------------------------------

def fetch_live(base_url: str, key: str) -> dict[str, list[dict]]:
    tables = {t: _fetch_all(base_url, key, t) for t in ("anki_notes", "anki_card_state", "anki_reviews")}
    # Only id and learning_language are ever read (people are labelled by the
    # language they learn); nothing else from this table reaches the output.
    tables["users"] = _fetch_all(base_url, key, "users")
    return tables


def _list_snapshots(base_url: str, key: str, year: int) -> list[str]:
    status, body = _request(
        "POST", f"{base_url}/storage/v1/object/list/{BUCKET}", key=key,
        body=json.dumps({"prefix": str(year), "limit": 1000, "offset": 0,
                         "sortBy": {"column": "name", "order": "asc"}}).encode(),
    )
    if status != 200:
        raise SystemExit(f"listing {BUCKET} failed: {status} {body.decode(errors='replace')}")
    return [f"{year}/{o['name']}" for o in json.loads(body) if o.get("name", "").endswith(".json")]


def snapshot_time(path: str) -> datetime:
    """`2026/2026-09-22T065758Z.json` → that instant (backup_tables._object_path)."""
    stamp = path.rsplit("/", 1)[-1].removesuffix(".json")
    return datetime.strptime(stamp, "%Y-%m-%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def pick_snapshot(paths: list[str], since: datetime) -> str | None:
    """The newest snapshot taken at or before `since` — the state the window
    started from. Falls back to the oldest one when every snapshot is newer."""
    if not paths:
        return None
    ordered = sorted(paths, key=snapshot_time)
    before = [p for p in ordered if snapshot_time(p) <= since]
    return before[-1] if before else ordered[0]


def fetch_baseline(base_url: str, key: str, since: datetime) -> tuple[dict[str, list[dict]], str] | None:
    paths = _list_snapshots(base_url, key, since.year) + _list_snapshots(base_url, key, since.year - 1)
    path = pick_snapshot(paths, since)
    if path is None:
        return None
    status, body = _request("GET", f"{base_url}/storage/v1/object/{BUCKET}/{path}", key=key)
    if status != 200:
        raise SystemExit(f"downloading {path} failed: {status} {body.decode(errors='replace')}")
    snapshot = json.loads(body)
    taken = snapshot_time(path)
    label = f"{BUCKET}/{path}"
    if taken > since:
        label += " (the oldest backup; newer than the window start)"
    return snapshot["tables"], label


def load_export(directory: Path) -> dict[str, list[dict]]:
    """The JSON `python -m migration <export> --out DIR` writes."""
    files = {"anki_notes": "notes.json", "anki_reviews": "reviews.json"}
    out = {}
    for table, name in files.items():
        path = directory / name
        if not path.exists():
            raise SystemExit(f"missing {path} — run `python -m migration <export> --user tim --out {directory}` first")
        out[table] = json.loads(path.read_text(encoding="utf-8"))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", help="window start, YYYY-MM-DD (UTC) or ISO timestamp; default 7 days ago")
    parser.add_argument("--baseline", type=Path, help="a local backup_tables.py snapshot to diff against")
    parser.add_argument("--no-baseline", action="store_true", help="skip the history checks")
    parser.add_argument("--export", type=Path, help="directory of AnkiDroid's final export, as `python -m migration --out` wrote it")
    parser.add_argument("--freeze-at", help=f"when AnkiDroid was frozen (default {FREEZE_AT.isoformat()}, §6.13)")
    parser.add_argument("--details", action="store_true", help="list the row ids behind each finding (no text)")
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    since = parse_ts(args.since) if args.since else now - timedelta(days=7)
    freeze_at = parse_ts(args.freeze_at) if args.freeze_at else FREEZE_AT

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see this module's docstring)")

    live = fetch_live(base_url, key)

    baseline, baseline_label = None, None
    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))["tables"]
        baseline_label = str(args.baseline)
    elif not args.no_baseline:
        found = fetch_baseline(base_url, key, since)
        if found:
            baseline, baseline_label = found

    export = load_export(args.export) if args.export else None

    report = build_report(live, since=since, now=now, baseline=baseline, baseline_label=baseline_label,
                          export=export, freeze_at=freeze_at)
    print(render(report, details=args.details))
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
