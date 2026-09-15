"""Open an Anki collection export and hand back a plain sqlite3 connection.

The one real unknown flagged in docs/DESIGN.md §7.1: a modern collection export
(`.colpkg`, and `.apkg` since Anki 2.1.50-ish) is a zip whose collection database is
**zstd-compressed** (`collection.anki21b`), not the plain SQLite this repo's other test
suite already reads out of a genanki-built `.apkg` (`collection.anki2` / `collection.anki21`).
Anki's own "support older Anki versions" export checkbox produces the plain form.

Rather than assume which one a given file is, this tries all three names Anki has used,
in newest-first order, and decompresses only if the name says it needs it. If none is
present the error message lists exactly what *was* in the zip — the fastest way to find
out the assumption above was wrong.
"""

from __future__ import annotations

import sqlite3
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote

# Newest first. Only "anki21b" is zstd-compressed; the other two are plain SQLite
# that sqlite3 can open directly once extracted.
_COLLECTION_NAMES = ("collection.anki21b", "collection.anki21", "collection.anki2")


class UnreadableExportError(RuntimeError):
    """The zip didn't contain a collection database under any name we know about."""


def _decompress_if_needed(name: str, raw: bytes) -> bytes:
    if not name.endswith("b"):
        return raw
    try:
        import zstandard
    except ImportError as e:
        raise UnreadableExportError(
            f"{name} is zstd-compressed but the `zstandard` package is not installed. "
            "pip install -r migration/requirements.txt"
        ) from e
    return zstandard.ZstdDecompressor().decompress(raw)


def open_collection(export_path: Path) -> tuple[sqlite3.Connection, str]:
    """Returns (connection, format_name). Caller owns closing the connection.

    format_name is one of "anki21b", "anki21", "anki2" — recorded in the report so a
    human can tell at a glance which code path actually ran.
    """
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
            # sqlite3 needs a real file on disk — there is no portable in-memory load
            # from bytes across the Python versions this has to run on. The temp file
            # is deleted as soon as the connection using it is opened; SQLite keeps
            # reading it fine on POSIX (the inode stays alive until every fd closes).
            tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
            try:
                tmp.write(data)
                tmp.close()
                # Read-only URI mode, deliberately: this package never writes to a
                # collection (see the module docstring in __init__.py), and opening
                # read-only means SQLite never needs the on-disk path to create a
                # rollback journal — so unlinking the path immediately below is safe
                # for every access this connection will ever make.
                conn = sqlite3.connect(f"file:{quote(tmp.name)}?mode=ro", uri=True)
                conn.row_factory = sqlite3.Row
            finally:
                Path(tmp.name).unlink(missing_ok=True)
            return conn, candidate.removeprefix("collection.")

        raise UnreadableExportError(
            "No collection database found in this export under any known name "
            f"({', '.join(_COLLECTION_NAMES)}). Files actually present: "
            f"{sorted(names_present) or '(empty zip)'}"
        )
