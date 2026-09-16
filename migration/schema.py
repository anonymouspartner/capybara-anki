"""The migration's output shape — mirrors docs/DESIGN.md §5, the data model.

Kept as plain dataclasses rather than importing anything Postgres-specific: this
package never connects to a database (see the module docstring in __init__.py), it
only ever writes these out as JSON for a human, or eventually for a loader that does
the writing. Field names and types match §5 exactly, field-for-field, so that mapping
either side against the design doc is a straight diff.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime


@dataclass
class Note:
    """One row of `notes`. `anki_guid` is the migration idempotency key — §7.2."""

    id: str  # freshly generated uuid4; stable only within one migration run
    anki_guid: str  # notes.guid — stable across Anki exports, the real identity
    lemma: str
    gloss: str | None
    lemma_translation: str | None
    part_of_speech: str | None
    language: str  # 'uk' | 'en'
    example: str | None
    example_translation: str | None
    audio_url: str | None
    source: str = "anki-import"
    # D17/D18, resolved against a real export 2026-09-16 (docs/DESIGN.md §7.5
    # finding 5, §8): a note's home deck, whether it's a plain vocab note or a
    # `Capybara Pronunciation (shadowing)` one, and whether it also produces a real
    # second Anki card (a `Capybara+` note). All three default to the schema's own
    # every-other-note case so a caller building a Note without deck/kind/has_spelling
    # in mind (every test written before this) still gets something valid.
    deck: str = "Ukrainian"
    kind: str = "vocab"  # 'vocab' | 'pronunciation'
    has_spelling: bool = False
    created_at: datetime | None = None


@dataclass
class CardState:
    """One row of `card_state`, keyed on (note_id, card_kind) — D17, resolved against
    a real export: a `Capybara+` note's second card is independently scheduled, so
    folding both into one row per note would silently merge two different memory
    states. `card_kind` defaults to 'recall'; 'spelling' only exists for a card drawn
    from a note's own Spelling-deck card (see transform.py's `card_kind_for`).

    `last_user_id` is denormalized and never authoritative — see the comment in
    docs/DESIGN.md §5 above this table. The migration sets it to whoever's export
    this run is reading, since that's the only user who could have produced these
    reviews.
    """

    note_id: str
    due: date | None
    stability: float | None  # FSRS memory state; None if not recoverable — see §7.1
    difficulty: float | None  # FSRS memory state
    state: int | None  # 0 new | 1 learning | 2 review | 3 relearning
    reps: int
    lapses: int
    suspended: bool
    last_user_id: str
    card_kind: str = "recall"  # 'recall' | 'spelling'
    # Not bookkeeping — required to correctly resume FSRS scheduling (the live
    # schema's own comment on this column, docs/DESIGN.md §5: `card_state.due`/
    # `state` alone are enough to place a migrated card in the due queue, but
    # `src/review/mutations.ts`'s `toFsrsCardState` treats a card with no
    # `lastReview` as brand new — losing every bit of migrated stability/difficulty
    # on its very next real review — unless this is set from the same revlog the
    # card's own reviews already carry. Derived from the latest of THIS card's
    # reviews (see cli.py), not guessed: None only for a genuinely unreviewed card.
    last_review: datetime | None = None


@dataclass
class Review:
    """One row of `reviews` — the append-only log, §4.2. Never updated, never deleted."""

    id: str  # generated fresh per row; real client ids come later, from the app
    note_id: str
    user_id: str
    rating: int  # 1..4, straight from Anki's revlog.ease
    reviewed_at: datetime
    elapsed_days: int
    scheduled_days: int
    card_kind: str = "recall"  # 'recall' | 'spelling' — D17, see CardState above
    ingested_at: datetime | None = None


@dataclass
class SchedulerConfig:
    """One row of `scheduler_config` — lifted verbatim from AnkiDroid, §7.3.

    Every field defaults to None rather than a guessed number. A None here means the
    extractor could not find this value under any of the key names it knows about —
    see config.py — and the report says so loudly rather than the migration silently
    shipping a wrong retention target or daily limit.
    """

    user_id: str
    fsrs_params: list[float] | None = None
    desired_retention: float | None = None
    learning_steps: list[int] | None = None
    daily_new_limit: int | None = None
    daily_review_limit: int | None = None
    max_interval: int | None = None
    # Provenance: field name -> which key path in the raw Anki config supplied it,
    # or "NOT FOUND" if nothing matched. Not part of the target schema — dropped
    # before anything is written toward Postgres — but essential while this is a
    # spike, per §7.1's "verify against an actual export before promising anything."
    source_keys: dict[str, str] = field(default_factory=dict)


@dataclass
class MigrationResult:
    notes: list[Note]
    card_states: list[CardState]
    reviews: list[Review]
    scheduler_config: SchedulerConfig
    warnings: list[str]
    skipped_note_count: int
    collection_format: str  # 'anki21b' (zstd) | 'anki21' | 'anki2' (legacy)
