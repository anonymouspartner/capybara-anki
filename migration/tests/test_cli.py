"""End-to-end: a synthetic export in, a MigrationResult and JSON files out.

This is the test that matters most for step 0 (docs/DESIGN.md §9) — it's the closest
thing to "did the spike actually work" that doesn't require a real collection.
"""

import json

from migration.cli import main, run_migration, write_output
from migration.tests.fixtures import write_export


def test_full_run_produces_the_expected_shape(tmp_path):
    export = write_export(tmp_path / "e.colpkg", compressed=True)
    result = run_migration(export, user_id="tim")

    # 3 fixture notes, all recognized Capybara notes
    assert len(result.notes) == 3
    assert result.skipped_note_count == 0

    # 3 fixture cards → 3 card_state rows (one per note, keyed on note_id per D2)
    assert len(result.card_states) == 3
    assert len({c.note_id for c in result.card_states}) == 3

    # 5 fixture revlog rows → 5 reviews, all attributed to the export's owner
    assert len(result.reviews) == 5
    assert all(r.user_id == "tim" for r in result.reviews)

    # The suspended fixture card (102) stayed suspended through the pipeline
    suspended_note = next(n for n in result.notes if n.lemma == "капібара")
    state = next(c for c in result.card_states if c.note_id == suspended_note.id)
    assert state.suspended is True

    assert result.scheduler_config.fsrs_params is not None
    assert result.collection_format == "anki21b"


def test_run_is_idempotent_across_two_invocations(tmp_path):
    """§7.2 / D15: the whole reason ids are deterministic (uuid5, not uuid4)."""
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    first = run_migration(export, user_id="tim")
    second = run_migration(export, user_id="tim")

    assert {n.id for n in first.notes} == {n.id for n in second.notes}
    assert {r.id for r in first.reviews} == {r.id for r in second.reviews}


def test_write_output_produces_valid_json_files(tmp_path):
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    result = run_migration(export, user_id="tim")
    out_dir = tmp_path / "out"
    write_output(result, out_dir)

    notes = json.loads((out_dir / "notes.json").read_text())
    assert len(notes) == 3
    assert notes[0]["lemma"]  # every note has real content, not a stub

    card_state = json.loads((out_dir / "card_state.json").read_text())
    assert len(card_state) == 3
    # dates serialize as plain ISO strings, not Python repr
    dated = [c for c in card_state if c["due"] is not None]
    assert all(len(c["due"]) == 10 for c in dated)  # "YYYY-MM-DD"

    config = json.loads((out_dir / "scheduler_config.json").read_text())
    assert config["user_id"] == "tim"

    assert (out_dir / "warnings.txt").exists()


def test_main_exits_zero_on_a_readable_export(tmp_path, capsys):
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    out_dir = tmp_path / "out"
    exit_code = main([str(export), "--user", "vika", "--out", str(out_dir)])
    assert exit_code == 0

    captured = capsys.readouterr()
    assert "notes read:" in captured.out
    assert (out_dir / "notes.json").exists()


def test_main_exits_nonzero_with_a_clear_message_on_an_unreadable_file(tmp_path, capsys):
    bad_file = tmp_path / "not_a_zip.colpkg"
    bad_file.write_bytes(b"this is not a zip file")

    exit_code = main([str(bad_file), "--user", "tim"])
    assert exit_code != 0
    captured = capsys.readouterr()
    assert "error" in captured.err.lower()
