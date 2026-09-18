"""Reads the live `anki_*` tables and writes a real `.apkg` — the escape hatch
`docs/DESIGN.md` §2.3 promises and `docs/MIGRATION.md` Phase 0.1 exists to build.
The writing itself is `apkg_writer.py`; this is the "fetch from Postgres, run it
yourself" wrapper around it, matching `upload_pronunciation_audio.py`'s own shape
exactly — same env vars, same `--dry-run`, same reason (the service-role key
lives on the maintainer's machine and nowhere else, D7).

Run this yourself
------------------
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>
    python -m migration.export_apkg --user-id <uuid> --out capybara-backup.apkg

`--user-id` picks whose `scheduler_config` row supplies the five settings
§7.3 cares about — Anki has one set of deck options, this app has one per
person, so an export has to choose. Defaults to whichever user has the most
reviews, on the theory that a backup should feel like the collection the person
who actually studies it is used to; override it when that guess is wrong.

`--dry-run` fetches nothing but a row count from each table and reports what
it would do. `--no-audio` skips downloading pronunciation recordings (faster,
and the note text and scheduling state still round-trip without them) — the
recordings are large relative to everything else this reads (14.3 MB across
190 files, docs/MIGRATION.md §4) and are also every one of the maintainer's own
uploads sitting in Storage already, so this is a convenience flag, not a
capability the export otherwise loses forever.

This never writes to Postgres — read-only in that direction, same as
`migration`'s own core package (see its `__init__.py`). The only thing it
writes is the `.apkg` file itself, on disk, wherever `--out` points.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from migration.apkg_writer import MediaFile, build_apkg
from migration.schema import CardState, Note, Review, SchedulerConfig

PAGE_SIZE = 1000  # matches supabase/functions/_shared/postgresStore.ts's own cap


def _request(method: str, url: str, *, key: str, body: bytes | None = None, extra_headers: dict | None = None) -> tuple[int, bytes]:
    headers = {"authorization": f"Bearer {key}", "apikey": key}
    if body is not None:
        headers["content-type"] = "application/json"
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _fetch_all(base_url: str, key: str, table: str, select: str = "*") -> list[dict]:
    """Every row of `table`, paged — the same PostgREST max-rows cap
    `postgresStore.ts` already works around (its own comment on the exact live
    failure this avoids), not a hypothetical one."""
    rows: list[dict] = []
    offset = 0
    while True:
        url = f"{base_url}/rest/v1/{table}?select={urllib.parse.quote(select)}"
        status, body = _request(
            "GET", url, key=key,
            extra_headers={"range-unit": "items", "range": f"{offset}-{offset + PAGE_SIZE - 1}"},
        )
        if status not in (200, 206):
            raise SystemExit(f"fetching {table} failed: {status} {body.decode(errors='replace')}")
        page = json.loads(body)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _parse_date(value: str | None):
    if not value:
        return None
    return _parse_dt(value).date() if "T" in value else datetime.strptime(value, "%Y-%m-%d").date()


def _note_from_row(row: dict) -> Note:
    return Note(
        id=row["id"],
        anki_guid=row.get("anki_guid"),
        lemma=row["lemma"],
        gloss=row.get("gloss"),
        lemma_translation=row.get("lemma_translation"),
        part_of_speech=row.get("part_of_speech"),
        language=row["language"],
        example=row.get("example"),
        example_translation=row.get("example_translation"),
        audio_url=row.get("audio_url"),
        source=row.get("source", "anki-import"),
        deck=row.get("deck", "Ukrainian"),
        kind=row.get("kind", "vocab"),
        has_spelling=bool(row.get("has_spelling", False)),
        created_at=_parse_dt(row.get("created_at")),
    )


def _card_state_from_row(row: dict) -> CardState:
    return CardState(
        note_id=row["note_id"],
        due=_parse_date(row.get("due")),
        stability=row.get("stability"),
        difficulty=row.get("difficulty"),
        state=row.get("state"),
        reps=row.get("reps", 0),
        lapses=row.get("lapses", 0),
        suspended=bool(row.get("suspended", False)),
        last_user_id=row.get("last_user_id") or "",
        card_kind=row.get("card_kind", "recall"),
        last_review=_parse_dt(row.get("last_review")),
    )


def _review_from_row(row: dict) -> Review:
    return Review(
        id=row["id"],
        note_id=row["note_id"],
        user_id=row["user_id"],
        rating=row["rating"],
        reviewed_at=_parse_dt(row["reviewed_at"]),
        elapsed_days=row.get("elapsed_days", 0),
        scheduled_days=row.get("scheduled_days", 0),
        card_kind=row.get("card_kind", "recall"),
        ingested_at=_parse_dt(row.get("ingested_at")),
    )


def _scheduler_config_from_row(row: dict) -> SchedulerConfig:
    return SchedulerConfig(
        user_id=row["user_id"],
        fsrs_params=row.get("fsrs_params"),
        desired_retention=row.get("desired_retention"),
        learning_steps=row.get("learning_steps"),
        daily_new_limit=row.get("daily_new_limit"),
        daily_review_limit=row.get("daily_review_limit"),
        max_interval=row.get("max_interval"),
    )


def _choose_user_id(reviews: list[dict], explicit: str | None) -> str:
    if explicit:
        return explicit
    counts = Counter(r["user_id"] for r in reviews)
    if not counts:
        raise SystemExit("no reviews exist yet and --user-id wasn't given — pass one explicitly")
    return counts.most_common(1)[0][0]


def _download_audio(notes: list[Note]) -> list[MediaFile]:
    """Pronunciation notes' `audio_url` already points at a public-read bucket
    (D23) — a plain GET, no service-role key needed for this part."""
    files: list[MediaFile] = []
    seen: set[str] = set()
    for note in notes:
        if note.kind != "pronunciation" or not note.audio_url:
            continue
        filename = note.audio_url.rsplit("/", 1)[-1]
        if filename in seen:
            continue
        seen.add(filename)
        try:
            with urllib.request.urlopen(note.audio_url) as res:
                files.append(MediaFile(filename=filename, data=res.read()))
        except urllib.error.URLError as e:
            print(f"  ! could not download {filename}: {e}", file=sys.stderr)
    return files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=None, help="output .apkg path (default: capybara-<date>.apkg)")
    parser.add_argument("--user-id", default=None, help="whose scheduler_config to embed (default: most active)")
    parser.add_argument("--no-audio", action="store_true", help="skip downloading pronunciation recordings")
    parser.add_argument("--dry-run", action="store_true", help="report row counts, write nothing")
    args = parser.parse_args(argv)

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see this module's docstring)")

    print("fetching anki_notes...")
    note_rows = _fetch_all(base_url, key, "anki_notes")
    print("fetching anki_card_state...")
    card_state_rows = _fetch_all(base_url, key, "anki_card_state")
    print("fetching anki_reviews...")
    review_rows = _fetch_all(base_url, key, "anki_reviews")
    print("fetching anki_scheduler_config...")
    config_rows = _fetch_all(base_url, key, "anki_scheduler_config")

    user_id = _choose_user_id(review_rows, args.user_id)
    config_row = next((r for r in config_rows if r["user_id"] == user_id), None)
    if config_row is None:
        raise SystemExit(f"no anki_scheduler_config row for user {user_id!r}")

    notes = [_note_from_row(r) for r in note_rows]
    card_states = [_card_state_from_row(r) for r in card_state_rows]
    reviews = [_review_from_row(r) for r in review_rows]
    config = _scheduler_config_from_row(config_row)

    pronunciation_count = sum(1 for n in notes if n.kind == "pronunciation")
    with_audio = sum(1 for n in notes if n.kind == "pronunciation" and n.audio_url)
    print(
        f"\n{len(notes)} notes ({pronunciation_count} pronunciation, {with_audio} with audio), "
        f"{len(card_states)} card states, {len(reviews)} reviews\n"
        f"scheduler config: user {user_id}"
    )

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    media = None
    if not args.no_audio and with_audio:
        print(f"\ndownloading {with_audio} pronunciation recordings...")
        media = _download_audio(notes)
        print(f"  {len(media)}/{with_audio} downloaded")

    out_path = args.out or Path(f"capybara-{datetime.now(timezone.utc).date().isoformat()}.apkg")
    print(f"\nwriting {out_path}...")
    build_apkg(notes, card_states, reviews, config, out_path, media=media)
    print(f"done. {out_path} is a real Anki collection export — import it into a clean Anki install to verify.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
