"""`upload_pronunciation_audio.py` had zero test coverage before this — it needs
the service-role key to actually upload anything, so it was never exercised
against a real collection at all. This covers the part that doesn't: reading
the manifest and the pronunciation notes back out of the export.

The real bug this was written for: a 2026-09-19 AnkiDroid export used the
modern format (zstd-compressed collection database *and* media manifest, note
types read through the Collection API rather than a `col.models` JSON blob)
that `reader.py` already handles for the read-only migration path, but this
module's `read_media_items` didn't — it opened the collection with a bare
`sqlite3.connect` and `json.loads`'d the manifest directly, both of which fail
against that shape. See reader.py's own docstring (finding 2) for why the JSON
blob is empty on a real modern export rather than merely absent.
"""

from migration.tests.fixtures import FixtureCard, FixtureCollection, write_export
from migration.upload_pronunciation_audio import read_media_items


def _pronunciation_export(tmp_path, name, *, compressed, compress_media, cards=None):
    fc = FixtureCollection(cards=cards if cards is not None else [
        FixtureCard(
            "Доброго ранку", gloss="a morning greeting", lemma_translation="Good morning",
            language="uk", note_type="pronunciation", reference_audio="[sound:capy_pron_abc123.mp3]",
        ),
    ])
    media_files = {"capy_pron_abc123.mp3": b"fake mp3 bytes"}
    return write_export(
        tmp_path / name, compressed=compressed, fc=fc,
        media_files=media_files, compress_media=compress_media,
    )


def test_reads_media_items_from_plain_uncompressed_export(tmp_path):
    export = _pronunciation_export(tmp_path, "plain.apkg", compressed=False, compress_media=False)
    items = read_media_items(export)
    assert len(items) == 1
    assert items[0].filename == "capy_pron_abc123.mp3"
    assert items[0].target_text == "Доброго ранку"
    assert items[0].language == "uk"


def test_reads_media_items_from_modern_zstd_compressed_export(tmp_path):
    """The regression test for the real bug: both the collection database and
    the media manifest are zstd frames, exactly the shape a real 2026-09-19
    AnkiDroid export uses."""
    export = _pronunciation_export(tmp_path, "modern.apkg", compressed=True, compress_media=True)
    items = read_media_items(export)
    assert len(items) == 1
    assert items[0].filename == "capy_pron_abc123.mp3"
    assert items[0].target_text == "Доброго ранку"


def test_a_compressed_manifest_paired_with_an_uncompressed_collection_still_works(tmp_path):
    """The two compression choices aren't actually coupled by anything in the
    container format — only by what one real export happened to do — so this
    checks the fixture's independent axes, not just the one combination seen
    in the wild."""
    export = _pronunciation_export(tmp_path, "mixed.apkg", compressed=False, compress_media=True)
    items = read_media_items(export)
    assert len(items) == 1


def test_reads_media_items_from_the_real_protobuf_manifest_shape(tmp_path):
    """The actual bug this whole module was rewritten for: a real 2026-09-19
    export's `media` file is Anki's own `MediaEntries` protobuf message, not
    JSON, with entries linked to numbered archive members by sha1 rather than
    position (the fixture deliberately scrambles the position to catch a
    positional shortcut), and every numbered payload independently
    zstd-compressed on top of that.
    """
    fc = FixtureCollection(cards=[
        FixtureCard(
            "Доброго ранку", lemma_translation="Good morning", language="uk",
            note_type="pronunciation", reference_audio="[sound:capy_pron_abc123.mp3]",
        ),
        FixtureCard(
            "Дякую", lemma_translation="Thank you", language="uk",
            note_type="pronunciation", reference_audio="[sound:capy_pron_def456.mp3]",
        ),
    ])
    export = write_export(
        tmp_path / "modern_protobuf.apkg", compressed=True, fc=fc,
        media_files={
            "capy_pron_abc123.mp3": b"fake mp3 bytes for the first word",
            "capy_pron_def456.mp3": b"fake mp3 bytes for the second word",
        },
        media_format="protobuf",
    )
    items = read_media_items(export)
    assert len(items) == 2
    by_filename = {i.filename: i for i in items}
    assert by_filename["capy_pron_abc123.mp3"].target_text == "Доброго ранку"
    assert by_filename["capy_pron_def456.mp3"].target_text == "Дякую"

    # The uploaded bytes must be the real, decompressed mp3 content — not the
    # zstd frame the archive member actually stores on disk.
    import zipfile
    from migration.upload_pronunciation_audio import _decompress_media_member
    with zipfile.ZipFile(export) as zf:
        raw = _decompress_media_member(zf.read(by_filename["capy_pron_abc123.mp3"].archive_member))
    assert raw == b"fake mp3 bytes for the first word"


def test_note_referencing_audio_not_in_the_archive_is_skipped_and_reported(tmp_path, capsys):
    fc = FixtureCollection(cards=[
        FixtureCard(
            "загублений", language="uk", note_type="pronunciation",
            reference_audio="[sound:does_not_exist.mp3]",
        ),
    ])
    export = write_export(
        tmp_path / "missing.apkg", compressed=True, fc=fc,
        media_files={"capy_pron_abc123.mp3": b"unrelated file"}, compress_media=True,
    )
    items = read_media_items(export)
    assert items == []
    assert "1 notes reference audio not present" in capsys.readouterr().err


def test_note_with_unsupported_language_is_skipped(tmp_path):
    fc = FixtureCollection(cards=[
        FixtureCard(
            "test", language="ru", note_type="pronunciation",
            reference_audio="[sound:capy_pron_abc123.mp3]",
        ),
    ])
    export = write_export(
        tmp_path / "badlang.apkg", compressed=True, fc=fc,
        media_files={"capy_pron_abc123.mp3": b"fake mp3 bytes"}, compress_media=True,
    )
    assert read_media_items(export) == []


def test_plain_vocabulary_notes_in_the_same_collection_are_ignored(tmp_path):
    """A collection is never only pronunciation notes — this confirms the
    note-type filter (col.models, not a raw table scan) actually discriminates
    rather than accidentally matching everything with a `flds` column."""
    fc = FixtureCollection(cards=[
        FixtureCard("важкий", "hard", "adj", "uk", note_type="capybara"),
        FixtureCard(
            "Доброго ранку", language="uk", note_type="pronunciation",
            reference_audio="[sound:capy_pron_abc123.mp3]",
        ),
    ])
    export = write_export(
        tmp_path / "mixed_types.apkg", compressed=True, fc=fc,
        media_files={"capy_pron_abc123.mp3": b"fake mp3 bytes"}, compress_media=True,
    )
    items = read_media_items(export)
    assert len(items) == 1
    assert items[0].target_text == "Доброго ранку"
