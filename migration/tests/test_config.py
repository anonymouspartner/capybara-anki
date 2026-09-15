from migration.config import (
    extract_scheduler_config,
    extract_scheduler_config_from_dict,
    find_capybara_deck_config,
)
from migration.reader import open_collection
from migration.tests.fixtures import FixtureCollection, write_export


def test_finds_the_preset_the_capybara_deck_actually_uses(tmp_path):
    export = write_export(tmp_path / "e.colpkg", compressed=False)
    with open_collection(export) as (col, _fmt):
        cfg, warnings = find_capybara_deck_config(col)
    assert cfg is not None
    assert warnings == []
    assert "fsrsParams5" in cfg


def test_extracts_all_five_settings_from_the_matched_preset(tmp_path):
    fc = FixtureCollection()
    export = write_export(tmp_path / "e.colpkg", compressed=False, fc=fc)
    with open_collection(export) as (col, _fmt):
        config, warnings = extract_scheduler_config(col, user_id="tim")

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
    with open_collection(export) as (col, _fmt):
        cfg, warnings = find_capybara_deck_config(col, deck_name_prefix="Nonexistent::")
    # Falls back to the one preset that does exist rather than returning nothing,
    # but says so.
    assert cfg is not None
    assert any("No deck named" in w for w in warnings)


class TestExtractSchedulerConfigFromDict:
    """Pure — no collection needed. This is where "Anki renamed a config key"
    (§7.1/§config.py's whole reason for existing) gets tested, directly against a
    hand-built dict rather than round-tripping through a synthetic protobuf blob."""

    def test_all_present_extracts_cleanly(self):
        raw = {
            "fsrsParams5": [0.1, 0.2, 0.3],
            "desiredRetention": 0.9,
            "new": {"delays": [1.0, 10.0], "perDay": 20},
            "rev": {"perDay": 200, "maxIvl": 36500},
        }
        config, warnings = extract_scheduler_config_from_dict(raw, user_id="tim")
        assert config.fsrs_params == [0.1, 0.2, 0.3]
        assert config.desired_retention == 0.9
        assert config.learning_steps == [1.0, 10.0]
        assert config.daily_new_limit == 20
        assert config.daily_review_limit == 200
        assert config.max_interval == 36500
        assert warnings == []

    def test_renamed_key_leaves_the_field_none_not_guessed(self):
        """Simulates a future Anki version that renamed the params key yet again —
        exactly the failure mode this module's docstring flags as expected."""
        raw = {
            "fsrsParamsRenamedInV99": [0.1, 0.2, 0.3],
            "desiredRetention": 0.9,
            "new": {"delays": [1.0, 10.0], "perDay": 20},
            "rev": {"perDay": 200, "maxIvl": 36500},
        }
        config, warnings = extract_scheduler_config_from_dict(raw, user_id="tim")
        assert config.fsrs_params is None
        assert config.source_keys["fsrs_params"] == "NOT FOUND"
        assert any("fsrs_params" in w for w in warnings)

    def test_populated_key_wins_over_an_earlier_empty_alias(self):
        """Regression test: fsrsParams6 is tried before fsrsParams5 (it's the newer
        name), and a real collection can have BOTH present with fsrsParams6 still
        an untouched empty list while fsrsParams5 holds real data. A naive
        first-non-None search latches onto the empty fsrsParams6 and never looks
        further — caught by this exact scenario during real-export testing."""
        raw = {
            "fsrsParams6": [],
            "fsrsParams5": [0.4, 0.6, 2.4, 5.8],
            "desiredRetention": 0.9,
            "new": {"delays": [1.0, 10.0], "perDay": 20},
            "rev": {"perDay": 200, "maxIvl": 36500},
        }
        config, warnings = extract_scheduler_config_from_dict(raw, user_id="tim")
        assert config.fsrs_params == [0.4, 0.6, 2.4, 5.8]
        assert config.source_keys["fsrs_params"] == "fsrsParams5"

    def test_empty_fsrs_params_is_a_real_value_not_a_miss(self):
        """Verified against the real collection: an empty list means "FSRS is on,
        but Optimize has never been run" — a real, meaningful state, not a failure
        to find the key. Must not be reported as NOT FOUND."""
        raw = {
            "fsrsParams5": [],
            "desiredRetention": 0.9,
            "new": {"delays": [1.0, 10.0], "perDay": 20},
            "rev": {"perDay": 200, "maxIvl": 36500},
        }
        config, warnings = extract_scheduler_config_from_dict(raw, user_id="tim")
        assert config.fsrs_params == []
        assert config.source_keys["fsrs_params"] == "fsrsParams5"
        assert any("never run Optimize" in w for w in warnings)

    def test_no_config_at_all_leaves_every_field_none(self):
        config, warnings = extract_scheduler_config_from_dict(None, user_id="tim")
        assert config.fsrs_params is None
        assert config.desired_retention is None
        assert all(v == "NOT FOUND" for v in config.source_keys.values())
        assert warnings
