from migration.config import extract_scheduler_config, find_capybara_deck_config
from migration.reader import open_collection
from migration.tests.fixtures import FixtureCollection, write_export


def test_finds_the_preset_the_capybara_deck_actually_uses(tmp_path):
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    conn, _ = open_collection(export)
    try:
        entry, warnings = find_capybara_deck_config(conn)
    finally:
        conn.close()
    assert entry is not None
    assert warnings == []
    assert "fsrsParams5" in entry


def test_extracts_all_five_settings_from_the_matched_preset(tmp_path):
    fc = FixtureCollection()
    export = write_export(tmp_path / "e.colpkg", compressed=False, fc=fc)
    conn, _ = open_collection(export)
    try:
        config, warnings = extract_scheduler_config(conn, user_id="tim")
    finally:
        conn.close()

    assert config.fsrs_params == fc.fsrs_params
    assert config.desired_retention == fc.desired_retention
    assert config.learning_steps == fc.learning_steps
    assert config.daily_new_limit == fc.daily_new_limit
    assert config.daily_review_limit == fc.daily_review_limit
    assert config.max_interval == fc.max_interval
    assert warnings == []
    # Provenance recorded for every field, not just success/failure
    assert config.source_keys["fsrs_params"] == "fsrsParams5"
    assert config.source_keys["desired_retention"] == "desiredRetention"


def test_missing_capybara_deck_falls_back_and_warns_loudly(tmp_path):
    """Never silently defaults — a missing deck has to be visible in the report."""
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    conn, _ = open_collection(export)
    try:
        entry, warnings = find_capybara_deck_config(conn, deck_name_prefix="Nonexistent::")
    finally:
        conn.close()
    assert entry is None
    assert any("No deck named" in w for w in warnings)


def test_unrecognized_key_names_leave_the_field_none_not_guessed(tmp_path):
    """Simulates a future Anki version that renamed the params key — the exact
    failure mode §7.1 and config.py's docstring both flag as expected to happen."""
    export = write_export(
        tmp_path / "e.colpkg", compressed=False, fsrs_params_key="fsrsParamsRenamedInV99"
    )
    conn, _ = open_collection(export)
    try:
        config, warnings = extract_scheduler_config(conn, user_id="tim")
    finally:
        conn.close()

    assert config.fsrs_params is None
    assert config.source_keys["fsrs_params"] == "NOT FOUND"
    assert any("fsrs_params" in w for w in warnings)
