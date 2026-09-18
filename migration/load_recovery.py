"""Load the recovery export (docs/MIGRATION.md §2.1/§2.2) into the live database.

Why this exists
----------------
The 2026-09-04 backfill lost 248 notes and 799 reviews it never should have — see
docs/MIGRATION.md §2.1. The fix is to re-run the same migration CLI against a fresh,
complete export (the 2026-09-18 colpkg) and load whatever the live tables are still
missing. ``cli.py`` already produces exactly the right JSON shape for this — run

    python -m migration <collection.colpkg> --user tim --out scratch/recovery

and its ``notes.json`` / ``card_state.json`` / ``reviews.json`` are rows shaped
exactly like ``anki_notes`` / ``anki_card_state`` / ``anki_reviews``, with ids
already derived deterministically from each Anki GUID (``note_uuid``, see
schema.py) — so re-running against the same export always produces the same ids,
and loading is naturally idempotent.

This script is the missing last step: it POSTs those three files to PostgREST with
``Prefer: resolution=ignore-duplicates``, so any row whose id/anki_guid/(note_id,
card_kind) already exists is silently skipped rather than erroring or overwriting.
That is deliberately weaker than an upsert — a row already in the table is assumed
correct, and this tool's job is only to fill in what a partial or lost run left
missing, never to overwrite live review history with a stale export.

Why this is a local CLI and not something run for you
-------------------------------------------------------
Same reason as ``upload_pronunciation_audio.py``: it needs
``SUPABASE_SERVICE_ROLE_KEY``, which lives on the maintainer's machine and nowhere
else. Loading real corpus rows one at a time by hand-copying SQL text is also just
the wrong tool for a few thousand rows — this does it in a handful of HTTP calls
with no transcription step at all.

Run this yourself
------------------
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>
    python -m migration.load_recovery scratch/recovery --user-id tim=<tim's real users.id UUID>

Add ``--dry-run`` to see row counts and the resolved user-id mapping without
sending anything. Re-running is always safe: everything is loaded with
``ignore-duplicates``, so a row already present is left untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Columns whose NULL in the export means "let the database default apply"
# (created_at / ingested_at), not "store NULL" — the columns are NOT NULL with a
# now() default, so the key must be dropped from the payload entirely rather than
# sent as null.
_DROP_IF_NULL = {
    "anki_notes": ["created_at"],
    "anki_card_state": [],
    "anki_reviews": ["ingested_at"],
}

# (table, JSON filename, on_conflict target, placeholder-user field to remap)
_TABLES = [
    ("anki_notes", "notes.json", "anki_guid", None),
    ("anki_card_state", "card_state.json", "note_id,card_kind", "last_user_id"),
    ("anki_reviews", "reviews.json", "id", "user_id"),
]

_BATCH_SIZE = 500


def _request(method: str, url: str, *, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _parse_user_map(pairs: list[str]) -> dict[str, str]:
    """``--user-id tim=<uuid>`` (repeatable) -> {"tim": "<uuid>"}."""
    mapping: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--user-id must be placeholder=uuid, got {pair!r}")
        placeholder, real_id = pair.split("=", 1)
        mapping[placeholder] = real_id
    return mapping


def _prepare_rows(rows: list[dict], table: str, user_field: str | None, user_map: dict[str, str]) -> list[dict]:
    drop_keys = _DROP_IF_NULL[table]
    prepared = []
    for row in rows:
        row = dict(row)
        for key in drop_keys:
            if row.get(key) is None:
                row.pop(key, None)
        if user_field is not None:
            placeholder = row[user_field]
            if placeholder not in user_map:
                raise SystemExit(
                    f"{table}.{user_field} has placeholder {placeholder!r} with no "
                    f"--user-id mapping for it (have: {sorted(user_map)})"
                )
            row[user_field] = user_map[placeholder]
        prepared.append(row)
    return prepared


def load_table(base_url: str, key: str, table: str, rows: list[dict], on_conflict: str) -> int:
    """POSTs `rows` in batches, ignoring rows that already exist. Returns the
    number of rows the server actually inserted (best-effort; PostgREST's
    ignore-duplicates response is the surviving rows, so this counts those)."""
    inserted = 0
    for start in range(0, len(rows), _BATCH_SIZE):
        batch = rows[start : start + _BATCH_SIZE]
        status, body = _request(
            "POST",
            f"{base_url}/rest/v1/{table}?on_conflict={on_conflict}",
            body=json.dumps(batch).encode(),
            headers={
                "authorization": f"Bearer {key}",
                "apikey": key,
                "content-type": "application/json",
                "prefer": "resolution=ignore-duplicates,return=representation",
            },
        )
        if status not in (200, 201):
            raise SystemExit(f"loading {table} batch at {start} failed: {status} {body.decode(errors='replace')}")
        try:
            inserted += len(json.loads(body))
        except (ValueError, TypeError):
            pass
        print(f"  {table}: batch {start}-{start + len(batch)} of {len(rows)} sent")
    return inserted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recovery_dir", type=Path, help="directory with notes.json / card_state.json / reviews.json")
    parser.add_argument(
        "--user-id", action="append", default=[], metavar="PLACEHOLDER=UUID",
        help="map a --user placeholder from the export (e.g. tim) to its real users.id. Repeatable.",
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would be sent, change nothing")
    args = parser.parse_args(argv)

    user_map = _parse_user_map(args.user_id)

    loaded_rows: dict[str, list[dict]] = {}
    for table, filename, on_conflict, user_field in _TABLES:
        path = args.recovery_dir / filename
        if not path.exists():
            raise SystemExit(f"missing {path} — run `python -m migration <export> --user <who> --out {args.recovery_dir}` first")
        rows = json.loads(path.read_text(encoding="utf-8"))
        loaded_rows[table] = _prepare_rows(rows, table, user_field, user_map)
        print(f"{table}: {len(loaded_rows[table])} rows in {filename}")

    if args.dry_run:
        print(f"user-id mapping: {user_map}")
        print("dry run — nothing sent")
        return 0

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see this module's docstring)")

    # Notes first: card_state and reviews both foreign-key onto anki_notes.id.
    for table, _filename, on_conflict, _user_field in _TABLES:
        inserted = load_table(base_url, key, table, loaded_rows[table], on_conflict)
        print(f"{table}: {inserted} new rows inserted ({len(loaded_rows[table]) - inserted} already present)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
