"""§7.1's central question: can both export shapes actually be opened?"""

import zipfile

import pytest

from migration.reader import UnreadableExportError, open_collection
from migration.tests.fixtures import write_export


def test_reads_plain_uncompressed_export(tmp_path):
    export = write_export(tmp_path / "export.colpkg", compressed=False)
    conn, fmt = open_collection(export)
    try:
        assert fmt == "anki21"
        row = conn.execute("select count(*) as n from notes").fetchone()
        assert row["n"] == 3
    finally:
        conn.close()


def test_reads_zstd_compressed_export(tmp_path):
    """The modern format — this is the one §7.1 flags as unverified against a real
    file. At minimum, the decompression mechanics are proven here."""
    export = write_export(tmp_path / "export.colpkg", compressed=True)
    conn, fmt = open_collection(export)
    try:
        assert fmt == "anki21b"
        row = conn.execute("select count(*) as n from notes").fetchone()
        assert row["n"] == 3
    finally:
        conn.close()


def test_missing_collection_raises_with_a_useful_message(tmp_path):
    path = tmp_path / "empty.colpkg"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("media", "{}")
        zf.writestr("some_other_file.txt", "not a collection")

    with pytest.raises(UnreadableExportError) as exc_info:
        open_collection(path)

    # The whole point of this error is telling a human what to look at next.
    assert "some_other_file.txt" in str(exc_info.value)
