"""Best-effort extraction of the five settings docs/DESIGN.md §7.3 says matter.

"Perfect card data with wrong limits will feel wrong" — so this module's job is not to
guess. For each of the five settings it tries a short list of key names Anki has used
across versions (they have moved: `fsrsWeights` → `fsrsParams4` → `fsrsParams5` as the
parameter count changed release to release), takes the first one present, and records
*which* key path supplied it in `SchedulerConfig.source_keys`. If nothing matches, the
field stays `None` and the report says so — never a silent default.

This is the one module in the whole migration spike most likely to need a rewrite once
a real export lands, precisely because it is guessing at schema key names rather than
reading a spec. That is expected and is what §7.1 already flags.
"""

from __future__ import annotations

import json
import sqlite3

from migration.schema import SchedulerConfig

# Tried in order; first key present wins. Each entry is a dotted path into the
# deck-config-group JSON object (the "dconf" entry Anki uses for a preset).
_FSRS_PARAMS_KEYS = ["fsrsParams5", "fsrsParams4", "fsrsWeights", "fsrs.w"]
_DESIRED_RETENTION_KEYS = ["desiredRetention", "fsrs.desiredRetention"]
_LEARNING_STEPS_KEYS = ["new.delays"]
_DAILY_NEW_LIMIT_KEYS = ["new.perDay"]
_DAILY_REVIEW_LIMIT_KEYS = ["rev.perDay"]
_MAX_INTERVAL_KEYS = ["rev.maxIvl"]


def _dig(obj: dict, dotted_path: str):
    """Walk `dotted_path` ("fsrs.w") through nested dicts. Returns None on any miss."""
    cur = obj
    for part in dotted_path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _first_match(obj: dict, candidate_paths: list[str]) -> tuple[str | None, object]:
    for path in candidate_paths:
        value = _dig(obj, path)
        if value is not None:
            return path, value
    return None, None


def find_capybara_deck_config(
    conn: sqlite3.Connection, deck_name_prefix: str = "Capybara::"
) -> tuple[dict | None, list[str]]:
    """Locates the deck-options preset actually used by the Capybara decks.

    Returns (dconf_entry, warnings). dconf_entry is the raw JSON object for the
    matched preset, or None if no Capybara deck — or no matching preset — was found,
    in which case the caller falls back to reporting on whatever exists so the run is
    still informative rather than a hard failure.
    """
    warnings: list[str] = []
    row = conn.execute("select decks, dconf from col").fetchone()
    if row is None:
        return None, ["col table has no rows — cannot locate deck configuration at all."]

    try:
        decks = json.loads(row["decks"])
        dconf = json.loads(row["dconf"])
    except (json.JSONDecodeError, TypeError) as e:
        return None, [f"col.decks / col.dconf did not parse as JSON: {e}"]

    capybara_decks = {
        did: d for did, d in decks.items() if d.get("name", "").startswith(deck_name_prefix)
    }
    if not capybara_decks:
        names = sorted(d.get("name", "?") for d in decks.values())
        return None, [
            f"No deck named '{deck_name_prefix}*' found. Decks present: {names}. "
            "Falling back to reporting every config preset in the collection."
        ]

    conf_ids = {d.get("conf") for d in capybara_decks.values()}
    conf_ids.discard(None)
    if len(conf_ids) > 1:
        warnings.append(
            f"Capybara decks use {len(conf_ids)} different option presets "
            f"({sorted(conf_ids)}), not one shared preset. Using the first; the "
            "daily-limit and retention numbers may differ per deck in reality — "
            "check dconf manually before trusting this."
        )
    if not conf_ids:
        return None, warnings + ["Capybara decks have no 'conf' preset id set."]

    chosen_id = str(sorted(conf_ids)[0])
    entry = dconf.get(chosen_id)
    if entry is None:
        return None, warnings + [
            f"Capybara decks point at preset id {chosen_id}, which is not in dconf. "
            f"Presets present: {sorted(dconf.keys())}."
        ]
    return entry, warnings


def extract_scheduler_config(
    conn: sqlite3.Connection, user_id: str, deck_name_prefix: str = "Capybara::"
) -> tuple[SchedulerConfig, list[str]]:
    """Best-effort. Never raises — every failure mode becomes a warning + None field."""
    result = SchedulerConfig(user_id=user_id)
    warnings: list[str] = []

    dconf_entry, deck_warnings = find_capybara_deck_config(conn, deck_name_prefix)
    warnings.extend(deck_warnings)

    if dconf_entry is None:
        row = conn.execute("select dconf from col").fetchone()
        if row is not None:
            try:
                all_dconf = json.loads(row["dconf"])
                if all_dconf:
                    # Fall back to *a* preset so the run still produces numbers to
                    # sanity-check by eye, clearly labelled as a guess in the report.
                    first_id, dconf_entry = next(iter(all_dconf.items()))
                    warnings.append(
                        f"Using preset id {first_id} as a fallback guess — verify "
                        "this is actually the Capybara decks' preset."
                    )
            except (json.JSONDecodeError, TypeError):
                pass

    if dconf_entry is not None:
        for field_name, candidates in (
            ("fsrs_params", _FSRS_PARAMS_KEYS),
            ("desired_retention", _DESIRED_RETENTION_KEYS),
            ("learning_steps", _LEARNING_STEPS_KEYS),
            ("daily_new_limit", _DAILY_NEW_LIMIT_KEYS),
            ("daily_review_limit", _DAILY_REVIEW_LIMIT_KEYS),
            ("max_interval", _MAX_INTERVAL_KEYS),
        ):
            matched_path, value = _first_match(dconf_entry, candidates)
            if matched_path is None:
                result.source_keys[field_name] = "NOT FOUND"
                warnings.append(
                    f"{field_name}: none of {candidates} present in the matched "
                    "preset. Left as None rather than guessed."
                )
            else:
                setattr(result, field_name, value)
                result.source_keys[field_name] = matched_path

    return result, warnings
