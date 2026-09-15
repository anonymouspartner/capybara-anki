"""Raw Anki rows → the dataclasses in schema.py.

Two things worth knowing before touching this file:

1. **IDs are deterministic, not random.** Migration must be re-runnable without
   duplicating anything (§7.2, D15 — parallel-running with AnkiDroid means running
   this at least twice). `Note.id` is `uuid5` of the note's Anki guid; `Review.id` is
   `uuid5` of (card id, revlog id). Run this script twice on the same export and every
   id comes out identical, so a re-import is a no-op upsert rather than a duplicate.

2. **`cards.due`'s meaning depends on `cards.type`**, and Anki has changed this more
   than once across scheduler versions (v1/v2/v3). What's implemented here is the
   v2/v3 shape: for a review or relearning card, `due` is a day count from the
   collection's creation date (`col.crt`); for a new card it isn't a date at all
   (position in queue); for a learning card it's either a same-day timestamp or a
   day offset depending on how far into learning it is, which is genuinely ambiguous
   without a real file to check against. See §7.1. When the heuristic below has to
   guess, it says so in the returned warnings rather than staying quiet about it.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from migration.extract import NoteType, RawCard, RawNote, RawReview
from migration.schema import CardState, Note, Review

# uuid5 namespace, fixed so re-runs (and re-runs on a different machine) agree.
_NAMESPACE = uuid.UUID("f4c4b8b0-9d3a-4c1e-8b1d-6c6a1a1c5c1a")

# The Capybara vocabulary schema's field order. Verified against a real export,
# 2026-09-15 — and it does NOT match anki_package.py's APKG_FIELDS in the scanner
# repo, which lists lemma_translation third. The live collection has it last. Ground
# truth from the real file wins; a mismatch here would have silently rejected every
# real note (as happened on the first run against this export, before the fix).
#
# Also verified: the real collection has TWO note-type names carrying this exact
# field set — "Capybara" (850 notes) and "Capybara+" (244 notes), the "+" apparently
# an Anki-side clone from some past sync/edit. Matching by NAME would have skipped
# whichever one wasn't hardcoded. So recognition here is by field SIGNATURE, not
# name — any note type whose fields equal EXPECTED_FIELDS is accepted, whatever it's
# called. This still correctly excludes "Capybara Pronunciation (shadowing)" (204
# notes, a completely different field set: TargetText/ReferenceAudio/Translation/...)
# without needing to know its name either.
EXPECTED_FIELDS = [
    "lemma",
    "gloss",
    "part_of_speech",
    "language",
    "example",
    "example_translation",
    "lemma_translation",
]

# A learning-card `due` value this large can only be a Unix timestamp (seconds), not
# a day count — no collection is 31,710 years old. Below this, treat it as a day
# offset from col.crt, same as a review card. This threshold is a heuristic, flagged
# as such wherever it fires — see the module docstring, point 2.
_TIMESTAMP_VS_DAY_OFFSET_THRESHOLD = 10**9


def note_uuid(anki_guid: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"note:{anki_guid}"))


def review_uuid(card_id: int, revlog_id: int) -> str:
    return str(uuid.uuid5(_NAMESPACE, f"review:{card_id}:{revlog_id}"))


def transform_note(
    raw: RawNote, note_type: NoteType | None
) -> tuple[Note | None, str | None]:
    """Returns (Note, None) on success, or (None, skip_reason) if this note isn't a
    recognizable Capybara vocabulary note and shouldn't be guessed at. Recognition is
    by field signature, not note-type name — see the module-level comment above
    EXPECTED_FIELDS for why."""
    if note_type is None:
        return None, f"note {raw.id}: unknown note type id {raw.mid}"
    if note_type.field_names != EXPECTED_FIELDS:
        return None, (
            f"note {raw.id}: note type '{note_type.name}' fields don't match the "
            f"Capybara vocabulary schema — expected {EXPECTED_FIELDS}, "
            f"found {note_type.field_names}"
        )
    if len(raw.fields) != len(EXPECTED_FIELDS):
        return None, (
            f"note {raw.id}: has {len(raw.fields)} field values, expected "
            f"{len(EXPECTED_FIELDS)} — malformed flds?"
        )

    values = dict(zip(EXPECTED_FIELDS, raw.fields))
    return (
        Note(
            id=note_uuid(raw.guid),
            anki_guid=raw.guid,
            lemma=values["lemma"],
            gloss=values["gloss"] or None,
            lemma_translation=values["lemma_translation"] or None,
            part_of_speech=values["part_of_speech"] or None,
            language=values["language"],
            example=values["example"] or None,
            example_translation=values["example_translation"] or None,
            # Not in the export at all — media was deliberately excluded (README
            # step-zero instructions) and reference audio for the Capybara decks
            # comes from scripts/anki_pronunciation (ElevenLabs), not from Anki.
            audio_url=None,
            source="anki-import",
        ),
        None,
    )


def _due_to_date(card: RawCard, collection_created_at: int) -> tuple[date | None, str | None]:
    """Returns (due_date, warning). warning is set only when a heuristic had to guess."""
    if card.type == 0:  # new — no schedule yet
        return None, None

    if card.type == 1:  # learning — see module docstring, point 2
        if card.due >= _TIMESTAMP_VS_DAY_OFFSET_THRESHOLD:
            dt = datetime.fromtimestamp(card.due, tz=timezone.utc)
            return dt.date(), None
        warning = (
            f"card {card.id}: learning-state due={card.due} is below the "
            "timestamp/day-offset threshold — treated as a day offset from "
            "collection creation. Verify against the real export (§7.1)."
        )
        crt_date = datetime.fromtimestamp(collection_created_at, tz=timezone.utc).date()
        return crt_date + timedelta(days=card.due), warning

    # review (2) or relearning (3): due is a day count from collection creation.
    crt_date = datetime.fromtimestamp(collection_created_at, tz=timezone.utc).date()
    return crt_date + timedelta(days=card.due), None


def transform_card_state(
    card: RawCard, note_id: str, user_id: str, collection_created_at: int
) -> tuple[CardState, list[str]]:
    warnings: list[str] = []
    due, due_warning = _due_to_date(card, collection_created_at)
    if due_warning:
        warnings.append(due_warning)

    stability = card.data.get("s")
    difficulty = card.data.get("d")
    if card.type != 0 and (stability is None or difficulty is None):
        warnings.append(
            f"card {card.id}: no FSRS memory state in cards.data ({card.data!r}) "
            "for a non-new card. If FSRS is actually on, this key has probably "
            "changed name — see migration/config.py's candidate-key pattern for "
            "the fix once a real export shows the right one."
        )

    return (
        CardState(
            note_id=note_id,
            due=due,
            stability=float(stability) if stability is not None else None,
            difficulty=float(difficulty) if difficulty is not None else None,
            state=card.type,
            reps=card.reps,
            lapses=card.lapses,
            suspended=(card.queue == -1),
            last_user_id=user_id,
        ),
        warnings,
    )


def transform_review(review: RawReview, note_id: str, user_id: str, elapsed_days: int) -> Review:
    reviewed_at = datetime.fromtimestamp(review.id / 1000, tz=timezone.utc)
    # A negative Anki ivl means "this many seconds," a same-day learning step, not a
    # scheduled_days value at all — floor it to 0 rather than store a negative day
    # count that nothing downstream expects.
    scheduled_days = max(review.ivl, 0)
    return Review(
        id=review_uuid(review.card_id, review.id),
        note_id=note_id,
        user_id=user_id,
        rating=review.ease,
        reviewed_at=reviewed_at,
        elapsed_days=elapsed_days,
        scheduled_days=scheduled_days,
    )


def compute_elapsed_days(reviews_for_card: list[RawReview]) -> dict[int, int]:
    """Maps revlog id -> elapsed days since that card's previous review.

    The first review of a card has no previous review to measure from, so it gets 0
    (matches FSRS's own convention for a card's first rating). `reviews_for_card`
    must already be sorted by id (extract.get_revlog orders by cid, id).
    """
    out: dict[int, int] = {}
    previous_ts_ms: int | None = None
    for r in reviews_for_card:
        if previous_ts_ms is None:
            out[r.id] = 0
        else:
            out[r.id] = max((r.id - previous_ts_ms) // 86_400_000, 0)
        previous_ts_ms = r.id
    return out
