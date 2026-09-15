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
    get_note_types,
    get_notes,
    get_revlog,
)
from migration.reader import UnreadableExportError, open_collection
from migration.schema import MigrationResult
from migration.transform import compute_elapsed_days, transform_card_state, transform_note, transform_review


def run_migration(export_path: Path, user_id: str, deck_prefix: str = "Capybara::") -> MigrationResult:
    conn, collection_format = open_collection(export_path)
    try:
        crt = get_collection_created_at(conn)
        note_types = get_note_types(conn)
        raw_notes = get_notes(conn)
        raw_cards = get_cards(conn)
        raw_revlog = get_revlog(conn)
        scheduler_config, config_warnings = extract_scheduler_config(
            conn=conn, user_id=user_id, deck_name_prefix=deck_prefix
        )
    finally:
        conn.close()

    warnings: list[str] = []
    skipped_note_count = 0

    notes = []
    note_id_by_anki_id: dict[int, str] = {}
    for raw_note in raw_notes:
        note, skip_reason = transform_note(raw_note, note_types.get(raw_note.mid))
        if skip_reason:
            skipped_note_count += 1
            warnings.append(f"skipped: {skip_reason}")
            continue
        notes.append(note)
        note_id_by_anki_id[raw_note.id] = note.id

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
        note_uuid = note_id_by_anki_id[anki_note_id]
        cards.sort(key=lambda c: c.id)
        if len(cards) > 1:
            warnings.append(
                f"note {anki_note_id}: has {len(cards)} cards, expected 1 (the "
                "Capybara note type is single-card, §1.3). Using card "
                f"{cards[0].id} for scheduling state; review history from all "
                f"{len(cards)} cards is kept."
            )

        primary = cards[0]
        card_state, cs_warnings = transform_card_state(primary, note_uuid, user_id, crt)
        card_states.append(card_state)
        warnings.extend(cs_warnings)

        for card in cards:
            card_revlog = revlog_by_card.get(card.id, [])
            elapsed = compute_elapsed_days(card_revlog)
            for r in card_revlog:
                reviews.append(transform_review(r, note_uuid, user_id, elapsed[r.id]))

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
