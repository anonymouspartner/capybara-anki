"""Open an Anki collection export as a real `anki.collection.Collection`.

Two things verified against a real AnkiDroid export, 2026-09-15, that changed this
module from its first draft:

1. **Container format** — the container-name guess in the original design (§7.1) was
   right first try: a modern export is a zip holding `collection.anki21b`, a
   zstd-compressed SQLite database. What *wasn't* right: Anki writes that zstd frame
   without an embedded content-size header (a streaming compress, not a one-shot with
   a known length), so a one-shot decompress fails with "could not determine content
   size in frame header" on a real file despite passing every test against a
   synthetic one. `_decompress_if_needed` uses a streaming reader instead.

2. **What's inside the SQLite file** — this is the bigger finding. This export is
   Anki's post-Rust-rewrite schema (`col.ver` 18): note-type definitions, deck
   definitions, and deck *options* have all moved out of the JSON blobs this package
   originally read (`col.models` / `col.decks` / `col.dconf` — all **empty strings**
   in a real file) into dedicated tables (`notetypes`, `fields`, `decks`,
   `deck_config`). Deck options in particular are stored as a **protobuf blob**, not
   JSON — there's no path around decoding that by hand that doesn't silently break
   the next time Anki adds a field. So this module hands back Anki's own
   `anki.collection.Collection`, opened against a throwaway copy, rather than a bare
   `sqlite3.Connection`: it's the one thing guaranteed to keep decoding correctly as
   Anki's on-disk format keeps changing, because it *is* the schema owner. Plain
   tables (notes, cards, revlog) are still read via `col.db.all(...)` — see
   extract.py — since those are unaffected either way.

Always a **copy**. This package never writes to a collection (see __init__.py), and
opening the genuine article with Anki's own library — which can and does perform
schema upgrades on open — is exactly the operation that rule exists to prevent. The
copy lives in its own throwaway temp directory for the duration of the `with` block
and is removed unconditionally on exit.
"""

from __future__ import annotations

import contextlib
import io
import shutil
import tempfile
import zipfile
from pathlib import Path

from anki.collection import Collection

# Newest first. Only "anki21b" is zstd-compressed; the other two are plain SQLite.
_COLLECTION_NAMES = ("collection.anki21b", "collection.anki21", "collection.anki2")


class UnreadableExportError(RuntimeError):
    """The zip didn't contain a collection database under any name we know about."""


# The first four bytes of any zstd frame, regardless of what's inside it or what
# the container calls the file holding it. `collection.anki21b`'s "b" suffix is a
# reliable enough signal for _decompress_if_needed below (Anki's own naming
# convention), but `upload_pronunciation_audio.py`'s `media` manifest has no such
# per-format name to key off of — compressed or not, it's always just "media" —
# so that caller checks these bytes directly instead.
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def decompress_zstd_frame(raw: bytes) -> bytes:
    """Streaming zstd decompress, shared by every caller in this package that
    needs one — `_decompress_if_needed` below (the collection database) and
    `upload_pronunciation_audio.py` (the media manifest), both zstd frames from
    the same modern export.

    Anki writes the frame without an embedded content size (a streaming
    compress, not a one-shot with a known length up front) — confirmed against
    a real export; `ZstdDecompressor.decompress()` requires that header and
    raises "could not determine content size in frame header" without it.
    `stream_reader` makes no such assumption.
    """
    try:
        import zstandard
    except ImportError as e:
        raise UnreadableExportError(
            "zstd-compressed content found but the `zstandard` package is not installed. "
            "pip install -r migration/requirements.txt"
        ) from e
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)) as reader:
        return reader.read()


def _decompress_if_needed(name: str, raw: bytes) -> bytes:
    if not name.endswith("b"):
        return raw
    return decompress_zstd_frame(raw)


def _extract_collection_bytes(export_path: Path) -> tuple[bytes, str]:
    """Returns (decompressed sqlite bytes, format name)."""
    try:
        zf_ctx = zipfile.ZipFile(export_path)
    except (zipfile.BadZipFile, FileNotFoundError, IsADirectoryError) as e:
        raise UnreadableExportError(f"{export_path} is not a readable zip file: {e}") from e

    with zf_ctx as zf:
        names_present = set(zf.namelist())
        for candidate in _COLLECTION_NAMES:
            if candidate not in names_present:
                continue
            raw = zf.read(candidate)
            data = _decompress_if_needed(candidate, raw)
            return data, candidate.removeprefix("collection.")

        raise UnreadableExportError(
            "No collection database found in this export under any known name "
            f"({', '.join(_COLLECTION_NAMES)}). Files actually present: "
            f"{sorted(names_present) or '(empty zip)'}"
        )


@contextlib.contextmanager
def open_collection(export_path: Path):
    """`with open_collection(path) as (col, format_name): ...`

    format_name is one of "anki21b", "anki21", "anki2" — recorded in the report so a
    human can tell at a glance which container shape actually ran.

    The throwaway copy lives for exactly the `with` block's duration. Anki's
    `Collection` can perform a schema upgrade on open, write lock files, and so on —
    all of that happens to the copy, never to `export_path`.
    """
    data, format_name = _extract_collection_bytes(export_path)

    tmpdir = tempfile.mkdtemp(prefix="capybara_anki_migration_")
    try:
        copy_path = Path(tmpdir) / "collection.anki2"
        copy_path.write_bytes(data)
        col = Collection(str(copy_path))
        try:
            yield col, format_name
        finally:
            col.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
