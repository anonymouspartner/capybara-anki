"""Carry the pronunciation reference audio out of an Anki export and into Storage.

Why this exists as its own tool
-------------------------------
`transform.py` sets every pronunciation note's ``audio_url`` to ``None``, with a
comment saying media "was deliberately excluded from the export". That was true
of the export it was written against. It is not true of a real
``File > Export > Include media`` ``.apkg``: the one exported 2026-09-17 carries
**190 mp3 files**, one per pronunciation note, and the notes' ``ReferenceAudio``
field points at them as ``[sound:capy_pron_….mp3]``.

The cost of that gap is the whole feature. The reviewer only renders an
``<audio>`` element when the note has an ``audio_url`` (``web/app.js``), so with
all 190 rows null a pronunciation card shows no reference audio at all — there is
nothing to listen to before you try to say it, which is the entire point of a
shadowing card.

Anki stores media as numbered files (``0``, ``1``, ``2``…) plus a ``media`` JSON
manifest mapping those numbers to real filenames. This reads the manifest, uploads
each file to Supabase Storage, and sets ``anki_notes.audio_url`` on the matching
note.

Run this yourself
-----------------
It needs the service-role key, which lives on the maintainer's machine and
nowhere else — the same reason the migration itself is a local CLI (D7), and the
reason this was not simply run for you.

    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service role key>
    python -m migration.upload_pronunciation_audio Capybara-2026-09-17.apkg

Add ``--dry-run`` to see exactly what it would upload and update, touching
nothing. Re-running is safe: uploads overwrite by path and the note update is
idempotent, so a partial run is repaired by running it again.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

# The bucket the reviewer's <audio> element fetches from. Public-read: these are
# machine-generated readings of study phrases, they are fetched by a plain
# <audio src> with no Authorization header, and a signed URL would expire while a
# card sat open. The bucket holds nothing but this audio.
BUCKET = "pronunciation-audio"

# Anki wraps a media reference like [sound:capy_pron_93567aac78cf.mp3].
SOUND_RE = re.compile(r"\[sound:([^\]]+)\]")

PRONUNCIATION_FIELDS = ["TargetText", "ReferenceAudio", "Translation", "Language", "Hint", "SourceId"]


@dataclass
class MediaItem:
    """One reference recording, and the note text it belongs to."""

    filename: str          # capy_pron_….mp3, as Anki's manifest names it
    archive_member: str    # the numbered file inside the .apkg holding the bytes
    target_text: str       # the note's TargetText, which is anki_notes.lemma
    language: str          # 'uk' / 'en', from the note's Language field


def _collection_member(zf: zipfile.ZipFile) -> str:
    for name in ("collection.anki21", "collection.anki2"):
        if name in zf.namelist():
            return name
    raise SystemExit("no collection database inside that export — is it really an .apkg?")


def read_media_items(export_path: Path) -> list[MediaItem]:
    """Every pronunciation note that actually has a recording attached.

    Notes whose ``ReferenceAudio`` names a file the archive does not contain are
    skipped and reported rather than guessed at — the same principle the rest of
    `migration/` applies to malformed rows.
    """
    with zipfile.ZipFile(export_path) as zf:
        if "media" not in zf.namelist():
            raise SystemExit(
                "that export contains no media. Re-export from Anki with "
                '"Include media" ticked — without it there is no audio to upload.'
            )
        manifest: dict[str, str] = json.loads(zf.read("media"))
        by_filename = {filename: member for member, filename in manifest.items()}

        member = _collection_member(zf)
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / member
            db_path.write_bytes(zf.read(member))
            con = sqlite3.connect(db_path)
            models = json.loads(con.execute("select models from col").fetchone()[0])
            rows = con.execute("select mid, flds from notes").fetchall()
            con.close()

    pronunciation_mids = {
        int(mid)
        for mid, model in models.items()
        if [f["name"] for f in model["flds"]] == PRONUNCIATION_FIELDS
    }

    items: list[MediaItem] = []
    missing: list[str] = []
    for mid, flds in rows:
        if mid not in pronunciation_mids:
            continue
        values = dict(zip(PRONUNCIATION_FIELDS, flds.split("\x1f")))
        match = SOUND_RE.search(values["ReferenceAudio"] or "")
        if not match:
            continue
        filename = match.group(1)
        if filename not in by_filename:
            missing.append(filename)
            continue
        language = (values["Language"] or "").split("-")[0].lower()
        target = (values["TargetText"] or "").strip()
        if not target or language not in {"uk", "en"}:
            # Same rejection transform.py makes: 13 real notes had an empty
            # Language and a garbled TargetText. Skipped, not guessed at.
            continue
        items.append(MediaItem(filename, by_filename[filename], target, language))

    if missing:
        print(f"  ! {len(missing)} notes reference audio not present in the archive", file=sys.stderr)
    return items


def _request(method: str, url: str, *, body: bytes | None, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def ensure_bucket(base_url: str, key: str) -> None:
    """Create the bucket if it isn't there. Already-exists is success, not failure."""
    status, body = _request(
        "POST",
        f"{base_url}/storage/v1/bucket",
        body=json.dumps({"id": BUCKET, "name": BUCKET, "public": True}).encode(),
        headers={
            "authorization": f"Bearer {key}",
            "apikey": key,
            "content-type": "application/json",
        },
    )
    if status in (200, 201):
        print(f"  created bucket {BUCKET!r} (public read)")
    elif status == 409 or b"already exists" in body.lower():
        print(f"  bucket {BUCKET!r} already exists")
    else:
        raise SystemExit(f"could not create bucket: {status} {body.decode(errors='replace')}")


def upload(base_url: str, key: str, export_path: Path, item: MediaItem) -> str:
    """Uploads one recording and returns its public URL. Overwrites on re-run."""
    with zipfile.ZipFile(export_path) as zf:
        data = zf.read(item.archive_member)
    status, body = _request(
        "POST",
        f"{base_url}/storage/v1/object/{BUCKET}/{item.filename}",
        body=data,
        headers={
            "authorization": f"Bearer {key}",
            "apikey": key,
            "content-type": "audio/mpeg",
            # Makes a re-run a replace rather than a 409, which is what keeps this
            # tool safe to run twice.
            "x-upsert": "true",
        },
    )
    if status not in (200, 201):
        raise SystemExit(f"upload of {item.filename} failed: {status} {body.decode(errors='replace')}")
    return f"{base_url}/storage/v1/object/public/{BUCKET}/{item.filename}"


def set_audio_url(base_url: str, key: str, item: MediaItem, url: str) -> int:
    """Points the matching note row at the uploaded file.

    Matched on ``(lemma, language, kind)`` rather than on an id: the migration
    derives note ids from Anki GUIDs, and this tool deliberately does not assume
    the export it is handed is the same one that was migrated. ``lemma`` is the
    note's TargetText, which is what makes the match exact.
    """
    status, body = _request(
        "PATCH",
        f"{base_url}/rest/v1/anki_notes"
        f"?lemma=eq.{urllib.parse.quote(item.target_text)}"
        f"&language=eq.{item.language}&kind=eq.pronunciation",
        body=json.dumps({"audio_url": url}).encode(),
        headers={
            "authorization": f"Bearer {key}",
            "apikey": key,
            "content-type": "application/json",
            "prefer": "return=representation",
        },
    )
    if status not in (200, 204):
        raise SystemExit(f"updating {item.target_text!r} failed: {status} {body.decode(errors='replace')}")
    try:
        return len(json.loads(body))
    except (ValueError, TypeError):
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("export_path", type=Path, help="an .apkg exported WITH media")
    parser.add_argument("--dry-run", action="store_true", help="report what would happen, change nothing")
    args = parser.parse_args(argv)

    items = read_media_items(args.export_path)
    print(f"{len(items)} pronunciation recordings found in {args.export_path.name}")
    if not items:
        return 1

    if args.dry_run:
        for item in items[:5]:
            print(f"  would upload {item.filename}  ->  note {item.target_text[:40]!r} ({item.language})")
        if len(items) > 5:
            print(f"  … and {len(items) - 5} more")
        return 0

    base_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base_url or not key:
        raise SystemExit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first (see this module's docstring)")

    ensure_bucket(base_url, key)

    uploaded = matched = unmatched = 0
    for item in items:
        url = upload(base_url, key, args.export_path, item)
        uploaded += 1
        rows = set_audio_url(base_url, key, item, url)
        if rows:
            matched += 1
        else:
            unmatched += 1
            print(f"  ! no anki_notes row for {item.target_text[:50]!r} ({item.language})", file=sys.stderr)
        if uploaded % 25 == 0:
            print(f"  {uploaded}/{len(items)}…")

    print(f"\nuploaded {uploaded}, linked {matched} notes, {unmatched} with no matching row")
    print("Open /study and a Pronunciation card should now play its reference audio.")
    return 0 if unmatched == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
