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

Anki stores media as numbered files (``0``, ``1``, ``2``…) plus a ``media``
manifest mapping members to real filenames. This reads the manifest, uploads
each file to Supabase Storage, and sets ``anki_notes.audio_url`` on the matching
note.

That manifest isn't always the plain ``{"0": "real.mp3", ...}`` JSON dict it was
when this tool was first written, though. A 2026-09-19 re-export of the same
collection uses Anki's newer format: `collection.anki21b` *and* the `media` file
are both zstd-compressed, `media` itself decompresses to Anki's own
`MediaEntries` protobuf message rather than JSON, entries carry no archive
member number at all (linked back to one only by content hash), and every
individual numbered payload is *itself* independently zstd-compressed on top of
all that. `read_media_items`/`_read_media_manifest`/`_decompress_media_member`
below handle both shapes — see their own docstrings for the full story, verified
against that real file. If you're reading this because a third shape shows up
someday: this is the second time the manifest format has changed under this
tool without changing its own filename, so treat "which shape is this" as
something to detect from the bytes, the way this file already does, not assume.

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
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from anki.import_export_pb2 import MediaEntries
from google.protobuf.message import DecodeError

from migration.reader import ZSTD_MAGIC, decompress_zstd_frame, open_collection

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


def _decompress_media_member(raw: bytes) -> bytes:
    """Every individual numbered media payload is independently zstd-compressed
    in a modern export too — confirmed against a real 2026-09-19 export, where
    every one of 190 payload files started with the zstd frame magic number.
    Self-describing, so this is safe to call unconditionally: an older
    export's uncompressed payloads pass through untouched."""
    if raw[:4] == ZSTD_MAGIC:
        return decompress_zstd_frame(raw)
    return raw


def _read_media_manifest(zf: zipfile.ZipFile) -> dict[str, str]:
    """Returns ``{archive_member: real_filename}``.

    Two export shapes, both real, both confirmed by hand:

    - **Older/plain**: `media` is a bare JSON dict, ``{"0": "real.mp3", ...}`` —
      the archive member name *is* the dict key. `upload_pronunciation_audio.py`
      was originally written only against this shape (the 2026-09-17 export).
    - **Modern**: `media` is zstd-compressed (like `collection.anki21b`, but
      with no alternate filename to signal that — checked by the frame's own
      magic number instead), and decompresses to Anki's own `MediaEntries`
      protobuf message (`anki.import_export_pb2`), not JSON. Confirmed against
      a real 2026-09-19 export: 190 entries, one per real file, each carrying
      `name`/`size`/`sha1` — but **no archive member number at all**, and
      entry order does *not* match the numbered zip members (entry 0's size
      didn't match zip member "0"'s). The two are additionally not directly
      comparable anyway: every numbered payload is *itself* independently
      zstd-compressed (see `_decompress_media_member`). The one thing that
      reliably links an entry to its member is `sha1`, computed over that
      member's *decompressed* bytes — verified by matching all 190 real
      entries this way with zero mismatches, so this is the one link this
      function trusts rather than any positional assumption.

    A `DecodeError` (or the protobuf parsing "succeeding" with zero entries,
    since a handful of legitimate byte sequences parse without erroring but
    produce nothing) means the modern shape doesn't apply here, so this falls
    back to the plain JSON dict — keeping the older export shape working
    exactly as it always did.
    """
    raw_manifest = zf.read("media")
    if raw_manifest[:4] == ZSTD_MAGIC:
        raw_manifest = decompress_zstd_frame(raw_manifest)

    entries = MediaEntries()
    try:
        entries.ParseFromString(raw_manifest)
        if len(entries.entries) == 0:
            raise DecodeError("parsed to zero entries — not really a MediaEntries message")
    except DecodeError:
        return json.loads(raw_manifest)

    numbered = [n for n in zf.namelist() if n.isdigit()]
    by_sha1 = {
        hashlib.sha1(_decompress_media_member(zf.read(member))).digest(): member
        for member in numbered
    }
    manifest: dict[str, str] = {}
    for entry in entries.entries:
        member = by_sha1.get(entry.sha1)
        if member is not None:
            manifest[member] = entry.name
    return manifest


def read_media_items(export_path: Path) -> list[MediaItem]:
    """Every pronunciation note that actually has a recording attached.

    Notes whose ``ReferenceAudio`` names a file the archive does not contain are
    skipped and reported rather than guessed at — the same principle the rest of
    `migration/` applies to malformed rows.

    Reads the collection through `reader.open_collection` (Anki's own
    `Collection` API) rather than a bare `sqlite3.connect`, and note-type field
    names through `col.models` rather than `select models from col` — the same
    two things `extract.py` already does, and for the same reason (reader.py's
    docstring, finding 2): a modern export's note-type definitions live in
    dedicated tables, not the JSON blob this file used to read directly, which
    is an empty string on a real export and silently found zero pronunciation
    notes. Verified against a real 2026-09-19 AnkiDroid export, which uses this
    shape — the 2026-09-17 export this tool was first written against evidently
    didn't, and nothing caught the gap until then.
    """
    with zipfile.ZipFile(export_path) as zf:
        if "media" not in zf.namelist():
            raise SystemExit(
                "that export contains no media. Re-export from Anki with "
                '"Include media" ticked — without it there is no audio to upload.'
            )
        manifest = _read_media_manifest(zf)
        by_filename = {filename: member for member, filename in manifest.items()}

    with open_collection(export_path) as (col, _format_name):
        # Stringified, matching extract.py's get_note_types/get_notes convention
        # (mid=str(...)) rather than trusting col.models' NotetypeId and the raw
        # notes table's mid column to compare equal as different Python types.
        pronunciation_mids = {
            str(m.id)
            for m in col.models.all_names_and_ids()
            if [f["name"] for f in col.models.get(m.id)["flds"]] == PRONUNCIATION_FIELDS
        }
        rows = col.db.all("select mid, flds from notes")

    items: list[MediaItem] = []
    missing: list[str] = []
    for mid, flds in rows:
        if str(mid) not in pronunciation_mids:
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
    """Uploads one recording and returns its public URL. Overwrites on re-run.

    `_decompress_media_member` here too: a modern export's payload bytes are
    the file's own zstd frame, not the mp3 itself — uploading them as-is would
    silently ship a file named "….mp3" that no `<audio>` element can play.
    """
    with zipfile.ZipFile(export_path) as zf:
        data = _decompress_media_member(zf.read(item.archive_member))
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
