"""Dump the four `anki_*` tables to Supabase Storage as JSON — Phase 0.2 of
docs/MIGRATION.md's safety net.

Why this exists
----------------
Phase 0.1 (`export_apkg.py`) gives a human-usable escape hatch: a real `.apkg`
a person can open in Anki. That's not a substitute for a plain, cheap,
automatic backup of the actual rows — if a migration, a bad `UPDATE`, or a bug
in this app itself corrupted the live tables, the fastest recovery is a JSON
snapshot from before it happened, not "re-export from AnkiDroid and
re-run the recovery loader" (and AnkiDroid won't even be installed once
docs/MIGRATION.md Phase 6 finishes). Cheap enough that there's no reason to
wait for anything else to be perfect first — the doc calls this out
explicitly (§5, Phase 0.2).

Unlike this package's other three maintainer-run tools (`export_apkg.py`,
`upload_pronunciation_audio.py`, `load_recovery.py` — see `__init__.py`),
this one is meant to run **unattended**, on a schedule, from
`.github/workflows/backup.yml` — a GitHub Actions secret supplies the
service-role key there, never a maintainer's own machine. It can still be run
by hand the same way (see below); nothing about it requires CI specifically.

Deliberately dependency-free (stdlib only — no `anki`, no `zstandard`): the
other three tools need Anki's own library to read a `.apkg`, but this one only
ever talks to PostgREST and Storage, so the scheduled workflow that runs it
weekly doesn't need to install a heavy Rust-backed package to do it.

Bucket is **private**, unlike `pronunciation-audio` — a backup is the whole
corpus, and README.md's own rule ("never commit a collection export, or
anything derived from the corpus") applies here at least as much as it does
to git.

Run this yourself
------------------
    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>
    python -m migration.backup_tables

`--dry-run` reports row counts per table and the object path it would write,
touching nothing. Each run writes one dated, timestamped object rather than
overwriting a fixed path — restoring from *last Tuesday* has to stay possible
after *today*'s backup has already run.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# Private: this is the whole corpus, not machine-generated audio. No
# `<audio src>` or anything else fetches from this bucket directly — every
# read goes through the service-role key, same as the tables themselves.
BUCKET = "anki-backups"

TABLES = ["anki_notes", "anki_card_state", "anki_reviews", "anki_scheduler_config"]

PAGE_SIZE = 1000  # matches export_apkg.py's own PostgREST range cap


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


def _fetch_all(base_url: str, key: str, table: str) -> list[dict]:
    """Every row of `table`, paged past PostgREST's default row cap — same
    approach as export_apkg.py's own `_fetch_all`, duplicated rather than
    imported so this module stays free of that module's `anki`-dependent
    imports (see the module docstring)."""
    rows: list[dict] = []
    offset = 0
    while True:
        url = f"{base_url}/rest/v1/{table}?select=*"
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


def ensure_bucket(base_url: str, key: str) -> None:
    """Create the bucket if it isn't there. Already-exists is success, not
    failure — same shape as upload_pronunciation_audio.py's own helper,
    except `public: False`."""
    status, body = _request(
        "POST",
        f"{base_url}/storage/v1/bucket",
        key=key,
        body=json.dumps({"id": BUCKET, "name": BUCKET, "public": False}).encode(),
    )
    if status in (200, 201):
        print(f"  created bucket {BUCKET!r} (private)")
    elif status == 409 or b"already exists" in body.lower():
        print(f"  bucket {BUCKET!r} already exists")
    else:
        raise SystemExit(f"could not create bucket: {status} {body.decode(errors='replace')}")


def _object_path(now: datetime) -> str:
    """One dated, timestamped object per run, grouped by year — restoring from
    *last Tuesday* has to stay possible after *today*'s backup has already
    overwritten nothing, because nothing here ever gets a fixed path."""
    return f"{now:%Y}/{now:%Y-%m-%dT%H%M%SZ}.json"


def upload_snapshot(base_url: str, key: str, object_path: str, snapshot: dict) -> None:
    body = json.dumps(snapshot, indent=2).encode()
    status, resp_body = _request(
        "POST",
        f"{base_url}/storage/v1/object/{BUCKET}/{object_path}",
        key=key,
        body=body,
        extra_headers={"content-type": "application/json", "x-upsert": "true"},
    )
    if status not in (200, 201):
        raise SystemExit(f"upload of {object_path} failed: {status} {resp_body.decode(errors='replace')}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report row counts and the object path, upload nothing")
    args = parser.parse_args(argv)

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see this module's docstring)")

    now = datetime.now(timezone.utc)
    object_path = _object_path(now)

    snapshot: dict[str, list[dict]] = {}
    for table in TABLES:
        print(f"fetching {table}...")
        snapshot[table] = _fetch_all(base_url, key, table)

    counts = {table: len(rows) for table, rows in snapshot.items()}
    print(f"row counts: {counts}")

    if args.dry_run:
        print(f"would write {BUCKET}/{object_path}")
        return 0

    ensure_bucket(base_url, key)
    upload_snapshot(base_url, key, object_path, {
        "taken_at": now.isoformat(),
        "tables": snapshot,
    })
    print(f"wrote {BUCKET}/{object_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
