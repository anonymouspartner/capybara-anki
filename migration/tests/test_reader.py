"""§7.1's central question: can both export shapes actually be opened, and does the
result actually decode the way a real collection does?
"""

import zipfile

import pytest

from migration.reader import UnreadableExportError, open_collection
from migration.tests.fixtures import write_export


def test_reads_plain_uncompressed_export(tmp_path):
    export = write_export(tmp_path / "export.colpkg", compressed=False)
    with open_collection(export) as (col, fmt):
        assert fmt == "anki21"
        assert col.db.scalar("select count(*) from notes") == 3


def test_reads_zstd_compressed_export(tmp_path):
    """The modern format — this is the one §7.1 flagged as unverified against a real
    file, and it now is: this shape is exactly what a real AnkiDroid export uses,
    confirmed 2026-09-15."""
    export = write_export(tmp_path / "export.colpkg", compressed=True)
    with open_collection(export) as (col, fmt):
        assert fmt == "anki21b"
        assert col.db.scalar("select count(*) from notes") == 3


def test_collection_is_a_real_anki_collection_object(tmp_path):
    """Not a bare sqlite3.Connection — see reader.py's docstring on why: deck
    options are a protobuf blob in a real export, and only Anki's own library
    decodes that correctly."""
    export = write_export(tmp_path / "export.colpkg", compressed=False)
    with open_collection(export) as (col, _fmt):
        # If this were a plain sqlite3.Connection, .decks wouldn't exist at all.
        deck_names = [d.name for d in col.decks.all_names_and_ids()]
        assert "Capybara::Ukrainian" in deck_names


def test_missing_collection_raises_with_a_useful_message(tmp_path):
    path = tmp_path / "empty.colpkg"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("media", "{}")
        zf.writestr("some_other_file.txt", "not a collection")

    with pytest.raises(UnreadableExportError) as exc_info:
        with open_collection(path):
            pass

    # The whole point of this error is telling a human what to look at next.
    assert "some_other_file.txt" in str(exc_info.value)


def test_not_a_zip_file_raises_a_clear_error(tmp_path):
    bad_file = tmp_path / "not_a_zip.colpkg"
    bad_file.write_bytes(b"this is not a zip file")

    with pytest.raises(UnreadableExportError):
        with open_collection(bad_file):
            pass
