"""Orchestrates the whole spike: open → extract → transform → report → write files.

This is `python -m migration`'s entry point (see __main__.py). It never touches
Postgres — see the module docstring in __init__.py — it only prints a report and
writes plain JSON files under --out, exactly as §7.4 describes: "The CLI does not
write to Postgres. It emits files, and prints a report... The first run should be a
read-only question — what is actually in here? — not a mutation of the live couple
database."
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from migration.config import extract_scheduler_config
from migration.extract import (
    get_cards,
    get_collection_created_at,
    get_deck_names,
    get_note_types,
    get_notes,
    get_revlog,
)
from migration.reader import UnreadableExportError, open_collection
from migration.schema import MigrationResult
from migration.transform import (
    PRONUNCIATION_FIELDS,
    card_kind_for,
    compute_elapsed_days,
    resolve_vocab_deck,
    transform_card_state,
    transform_note,
    transform_pronunciation_note,
    transform_review,
)


def _dispatch_note(raw_note, note_type):
    """Picks which of the two real Capybara note schemas (D17's vocab shape, D18's
    pronunciation shape) this note actually is, by field signature — see
    transform.py's EXPECTED_FIELDS/PRONUNCIATION_FIELDS comments for why signature,
    not name. Anything that's neither falls through to transform_note, which already
    produces a clear "fields don't match" (or "unknown note type") skip reason —
    no need to duplicate that message here for a third case that isn't really
    different from the first."""
    if note_type is not None and note_type.field_names == PRONUNCIATION_FIELDS:
        return transform_pronunciation_note(raw_note, note_type)
    return transform_note(raw_note, note_type)


def run_migration(export_path: Path, user_id: str, deck_prefix: str = "Capybara::") -> MigrationResult:
    with open_collection(export_path) as (col, collection_format):
        crt = get_collection_created_at(col)
        note_types = get_note_types(col)
        deck_names = get_deck_names(col)
        raw_notes = get_notes(col)
        raw_cards = get_cards(col)
        raw_revlog = get_revlog(col)
        scheduler_config, config_warnings = extract_scheduler_config(
            col=col, user_id=user_id, deck_name_prefix=deck_prefix
        )

    warnings: list[str] = []
    skipped_note_count = 0

    notes = []
    note_id_by_anki_id: dict[int, str] = {}
    note_by_anki_id: dict[int, object] = {}
    for raw_note in raw_notes:
        note, skip_reason = _dispatch_note(raw_note, note_types.get(raw_note.mid))
        if skip_reason:
            skipped_note_count += 1
            warnings.append(f"skipped: {skip_reason}")
            continue
        notes.append(note)
        note_id_by_anki_id[raw_note.id] = note.id
        note_by_anki_id[raw_note.id] = note

    cards_by_note: dict[int, list] = defaultdict(list)
    for card in raw_cards:
        if card.note_id in note_id_by_anki_id:
            cards_by_note[card.note_id].append(card)

    revlog_by_card: dict[int, list] = defaultdict(list)
    for review in raw_revlog:
        revlog_by_card[review.card_id].append(review)

    card_states = []
    reviews = []
    for anki_note_id, cards in cards_by_note.items():
        note = note_by_anki_id[anki_note_id]
        note_uuid = note_id_by_anki_id[anki_note_id]
        cards.sort(key=lambda c: c.id)

        # D17: a vocab note's own `deck`/`has_spelling` depend on how many real
        # Anki cards it has and where they're filed — not knowable until cards_by_note
        # exists, so transform_note/transform_pronunciation_note leave these at their
        # schema defaults and this is where the real values land. Pronunciation notes
        # already got the right values (deck="Pronunciation", has_spelling=False)
        # from transform_pronunciation_note itself — every one of them is single-card
        # in the real export (verified 2026-09-16), so nothing here needs to change
        # for those, but the >2-cards check below still guards the assumption.
        if note.kind == "vocab":
            note.deck, note.has_spelling = resolve_vocab_deck(cards, deck_names, deck_prefix)

        expected_card_count = 2 if note.has_spelling else 1
        if len(cards) != expected_card_count:
            warnings.append(
                f"note {anki_note_id} ({note.kind}): has {len(cards)} card(s), "
                f"expected {expected_card_count} — scheduling state and review "
                "history are still recorded for every card found, per its own "
                "deck-derived card_kind, but this note's shape doesn't match what "
                "D17/D18 predict and is worth checking by hand."
            )

        for card in cards:
            kind = card_kind_for(card, deck_names, deck_prefix)
            card_state, cs_warnings = transform_card_state(card, note_uuid, user_id, crt, card_kind=kind)
            card_states.append(card_state)
            warnings.extend(cs_warnings)

            card_revlog = revlog_by_card.get(card.id, [])
            elapsed = compute_elapsed_days(card_revlog)
            for r in card_revlog:
                reviews.append(transform_review(r, note_uuid, user_id, elapsed[r.id], card_kind=kind))

    warnings.extend(config_warnings)

    return MigrationResult(
        notes=notes,
        card_states=card_states,
        reviews=reviews,
        scheduler_config=scheduler_config,
        warnings=warnings,
        skipped_note_count=skipped_note_count,
        collection_format=collection_format,
    )


def _json_default(obj):
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError(f"not JSON serializable: {type(obj)}")


def write_output(result: MigrationResult, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "notes.json").write_text(
        json.dumps([dataclasses.asdict(n) for n in result.notes], default=_json_default, indent=2)
    )
    (out_dir / "card_state.json").write_text(
        json.dumps([dataclasses.asdict(c) for c in result.card_states], default=_json_default, indent=2)
    )
    (out_dir / "reviews.json").write_text(
        json.dumps([dataclasses.asdict(r) for r in result.reviews], default=_json_default, indent=2)
    )
    (out_dir / "scheduler_config.json").write_text(
        json.dumps(dataclasses.asdict(result.scheduler_config), default=_json_default, indent=2)
    )
    (out_dir / "warnings.txt").write_text("\n".join(result.warnings) + ("\n" if result.warnings else ""))


def print_report(result: MigrationResult) -> None:
    print(f"collection format:  {result.collection_format}")
    print(f"notes read:         {len(result.notes)}  (skipped: {result.skipped_note_count})")
    print(f"card states:        {len(result.card_states)}")
    fsrs_present = sum(1 for c in result.card_states if c.stability is not None)
    print(f"  with FSRS state:  {fsrs_present} / {len(result.card_states)}")
    print(f"suspended cards:    {sum(1 for c in result.card_states if c.suspended)}")
    print(f"reviews:            {len(result.reviews)}")
    if result.reviews:
        earliest = min(r.reviewed_at for r in result.reviews)
        latest = max(r.reviewed_at for r in result.reviews)
        print(f"  date range:       {earliest.date()} .. {latest.date()}")

    print()
    print("scheduler config (§7.3):")
    sc = result.scheduler_config
    for field_name in (
        "fsrs_params",
        "desired_retention",
        "learning_steps",
        "daily_new_limit",
        "daily_review_limit",
        "max_interval",
    ):
        value = getattr(sc, field_name)
        source = sc.source_keys.get(field_name, "?")
        shown = value if value is None or not isinstance(value, list) else f"[{len(value)} values]"
        print(f"  {field_name:20s} = {shown!r:30s}  (from: {source})")

    if result.warnings:
        print()
        print(f"warnings ({len(result.warnings)}):")
        for w in result.warnings:
            print(f"  - {w}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m migration",
        description=(
            "Read-only. Reads an Anki collection export and reports what's in it. "
            "Never writes to Postgres — see docs/DESIGN.md §7.4."
        ),
    )
    parser.add_argument("export_path", type=Path, help="a .colpkg (or .apkg) export")
    parser.add_argument(
        "--user", required=True, help="whose export this is (e.g. 'tim' or 'vika') — "
        "becomes reviews.user_id and card_state.last_user_id"
    )
    parser.add_argument("--out", type=Path, default=Path("scratch/migration-output"))
    parser.add_argument("--deck-prefix", default="Capybara::")
    args = parser.parse_args(argv)

    try:
        result = run_migration(args.export_path, args.user, args.deck_prefix)
    except UnreadableExportError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print_report(result)
    write_output(result, args.out)
    print()
    print(f"wrote notes.json, card_state.json, reviews.json, scheduler_config.json, "
          f"warnings.txt to {args.out}/")
    return 0
