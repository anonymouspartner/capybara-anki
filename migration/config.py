"""Best-effort extraction of the five settings docs/DESIGN.md §7.3 says matter.

"Perfect card data with wrong limits will feel wrong" — so this module's job is not
to guess. For each of the five settings it tries a short list of key names Anki has
used across versions (they have moved: `fsrsWeights` → `fsrsParams5` → `fsrsParams6`
as the parameter count changed release to release), takes the first one present, and
records *which* key path supplied it in `SchedulerConfig.source_keys`. If nothing
matches, the field stays `None` and the report says so — never a silent default.

Split into two layers, verified against a real export, 2026-09-15:

- `extract_scheduler_config_from_dict` is pure: given a plain dict shaped like the
  one Anki's own `Collection.decks.config_dict_for_deck_id()` returns, it does the
  candidate-key search. No collection needed to test this half at all.
- `find_capybara_deck_config` gets that dict in the first place, via the Collection
  API rather than the `col.dconf` JSON blob this module originally read — that blob
  is a genuine protobuf message in a modern collection (real bytes, not JSON; see
  reader.py's docstring), and hand-decoding a protobuf message without its .proto
  schema is exactly the kind of thing that silently breaks on the next Anki release.
  Anki's own library is the one thing that keeps decoding it correctly.
"""

from __future__ import annotations

from anki.collection import Collection

from migration.schema import SchedulerConfig

# Tried in order; first key present wins. Anki's own decoded dict uses these names
# directly — no dotted-path digging into nested JSON is needed for the top-level
# ones anymore, but new/rev limits are still nested one level under "new"/"rev".
_FSRS_PARAMS_KEYS = ["fsrsParams6", "fsrsParams5", "fsrsParams4", "fsrsWeights"]
_DESIRED_RETENTION_KEYS = ["desiredRetention"]
_LEARNING_STEPS_KEYS = ["new.delays"]
_DAILY_NEW_LIMIT_KEYS = ["new.perDay"]
_DAILY_REVIEW_LIMIT_KEYS = ["rev.perDay"]
_MAX_INTERVAL_KEYS = ["rev.maxIvl"]


def _dig(obj: dict, dotted_path: str):
    """Walk `dotted_path` ("new.delays") through nested dicts. None on any miss."""
    cur = obj
    for part in dotted_path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _first_match(obj: dict, candidate_paths: list[str]) -> tuple[str | None, object]:
    """Two passes, deliberately. `_FSRS_PARAMS_KEYS` lists more than one candidate
    (Anki has carried "fsrsParams5" and "fsrsParams6" side by side while migrating
    between them), and a real collection can have BOTH present with one populated
    and the other still an untouched empty list. An empty list is a real, meaningful
    value on its own (Anki's convention for "no personalized weights yet" — see
    extract_scheduler_config_from_dict), so a naive first-non-None search would
    latch onto whichever empty placeholder sorts first in the candidate list and
    never look further, even with real data sitting one candidate down. Preferring
    any truthy match first — falling back to the first present-but-falsy one only
    if every candidate is empty — gets both right: real data wins when it exists,
    and "empty on purpose" is still reported accurately when that's genuinely all
    there is.
    """
    first_present: tuple[str, object] | None = None
    for path in candidate_paths:
        value = _dig(obj, path)
        if value is None:
            continue
        if first_present is None:
            first_present = (path, value)
        if value:  # truthy: real data, not just "the key exists"
            return path, value
    return first_present if first_present is not None else (None, None)


def extract_scheduler_config_from_dict(
    raw_config: dict | None, user_id: str
) -> tuple[SchedulerConfig, list[str]]:
    """Pure — no collection, no I/O. `raw_config` is the dict a deck's resolved
    options look like (Anki's own shape, or None if no config could be located at
    all, in which case every field stays None)."""
    result = SchedulerConfig(user_id=user_id)
    warnings: list[str] = []

    if raw_config is None:
        for field_name in (
            "fsrs_params", "desired_retention", "learning_steps",
            "daily_new_limit", "daily_review_limit", "max_interval",
        ):
            result.source_keys[field_name] = "NOT FOUND"
        return result, ["no deck config available to extract from"]

    for field_name, candidates in (
        ("fsrs_params", _FSRS_PARAMS_KEYS),
        ("desired_retention", _DESIRED_RETENTION_KEYS),
        ("learning_steps", _LEARNING_STEPS_KEYS),
        ("daily_new_limit", _DAILY_NEW_LIMIT_KEYS),
        ("daily_review_limit", _DAILY_REVIEW_LIMIT_KEYS),
        ("max_interval", _MAX_INTERVAL_KEYS),
    ):
        matched_path, value = _first_match(raw_config, candidates)
        if matched_path is None:
            result.source_keys[field_name] = "NOT FOUND"
            warnings.append(
                f"{field_name}: none of {candidates} present in the resolved "
                "config. Left as None rather than guessed."
            )
        else:
            setattr(result, field_name, value)
            result.source_keys[field_name] = matched_path

    if result.fsrs_params == []:
        warnings.append(
            "fsrs_params is an empty list — Anki's own convention for \"FSRS is on "
            "but no personalized weights have been computed yet (never run "
            "Optimize)\", not a missing value. The app will need to fall back to "
            "Anki's built-in default FSRS weights rather than porting a real one."
        )

    return result, warnings


def find_capybara_deck_config(
    col: Collection, deck_name_prefix: str = "Capybara::"
) -> tuple[dict | None, list[str]]:
    """Locates the deck-options preset actually used by the Capybara decks.

    Returns (config_dict, warnings). config_dict is the dict
    `col.decks.config_dict_for_deck_id()` returns for the matched preset, or None if
    no Capybara deck was found, in which case the caller falls back to reporting on
    whatever exists so the run is still informative rather than a hard failure.
    """
    warnings: list[str] = []
    capybara_decks = [
        d for d in col.decks.all_names_and_ids() if d.name.startswith(deck_name_prefix)
    ]
    if not capybara_decks:
        all_names = sorted(d.name for d in col.decks.all_names_and_ids())
        warnings.append(
            f"No deck named '{deck_name_prefix}*' found. Decks present: {all_names}. "
            "Falling back to reporting the first config preset in the collection."
        )
        all_config = col.decks.all_config()
        if all_config:
            return all_config[0], warnings + [
                f"Using preset id {all_config[0].get('id')} as a fallback guess — "
                "verify this is actually the Capybara decks' preset."
            ]
        return None, warnings + ["No deck-config presets exist in this collection at all."]

    configs_by_id: dict[int, dict] = {}
    for deck in capybara_decks:
        cfg = col.decks.config_dict_for_deck_id(deck.id)
        configs_by_id[cfg["id"]] = cfg

    if len(configs_by_id) > 1:
        warnings.append(
            f"Capybara decks use {len(configs_by_id)} different option presets "
            f"({sorted(configs_by_id.keys())}), not one shared preset. Using the "
            "lowest id; the daily-limit and retention numbers may differ per deck "
            "in reality — check deck options manually before trusting this."
        )

    chosen_id = sorted(configs_by_id.keys())[0]
    return configs_by_id[chosen_id], warnings


def extract_scheduler_config(
    col: Collection, user_id: str, deck_name_prefix: str = "Capybara::"
) -> tuple[SchedulerConfig, list[str]]:
    raw_config, deck_warnings = find_capybara_deck_config(col, deck_name_prefix)
    result, extract_warnings = extract_scheduler_config_from_dict(raw_config, user_id)
    return result, deck_warnings + extract_warnings
