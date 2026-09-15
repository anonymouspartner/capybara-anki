"""Builds synthetic Anki collections for tests — via the real `anki` library.

Never touches the maintainer's real collection — deliberately. Real exports contain
the corpus (see this repo's .gitignore and README); tests only ever exercise this
package against data invented here.

**Why the `anki` library builds these rather than hand-written SQL**, verified
2026-09-15: a hand-rolled schema is exactly how the previous version of this file
diverged from reality — it modeled the *old* Anki schema (note types as JSON in
`col.models`, deck options as JSON in `col.dconf`), which a real, current AnkiDroid
export doesn't use at all anymore (see reader.py's docstring). Anki's own library
can't drift from Anki's own schema. Building fixtures with the same library
`migration/` reads with means a schema-version fixture staying wrong silently is no
longer a failure mode — if `anki` changes its schema, both sides move together.

Card scheduling state (type/queue/due/ivl/reps/lapses/FSRS `data`) and revlog rows
have no note-level API for synthetic test data, so those are written directly via
`col.db.execute(...)` after the note/card exist — still real tables, same shapes
`extract.py` reads, just poked in by hand rather than by simulating real reviews.
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import zstandard
from anki.collection import Collection

CAPYBARA_FIELDS = [
    "lemma",
    "gloss",
    "part_of_speech",
    "language",
    "example",
    "example_translation",
    "lemma_translation",
]

PRONUNCIATION_FIELDS = ["TargetText", "ReferenceAudio", "Translation", "Language", "Hint", "SourceId"]


@dataclass
class FixtureCard:
    lemma: str
    gloss: str = ""
    part_of_speech: str = ""
    language: str = "uk"
    example: str = ""
    example_translation: str = ""
    lemma_translation: str = ""
    note_type: str = "capybara"  # "capybara" | "capybara_plus" | "pronunciation"
    deck: str = "Capybara::Ukrainian"
    type: int = 2  # 0 new, 1 learning, 2 review, 3 relearning
    queue: int = 2  # -1 suspended
    due: int = 30  # days since collection creation, for type 2/3
    ivl: int = 10
    reps: int = 3
    lapses: int = 0
    stability: float | None = 8.5
    difficulty: float | None = 5.2


@dataclass
class FixtureReview:
    card_index: int  # position in FixtureCollection.cards
    ease: int = 3
    ivl: int = 10
    days_after_crt: float = 1.0


@dataclass
class FixtureCollection:
    crt: int = 1_700_000_000  # collection creation, epoch seconds
    cards: list[FixtureCard] = field(default_factory=list)
    reviews: list[FixtureReview] = field(default_factory=list)
    fsrs_params: list[float] = field(default_factory=lambda: [0.4, 0.6, 2.4, 5.8])
    desired_retention: float = 0.9
    learning_steps: list[float] = field(default_factory=lambda: [1.0, 10.0])
    daily_new_limit: int = 20
    daily_review_limit: int = 200
    max_interval: int = 36500


def _default_collection() -> FixtureCollection:
    return FixtureCollection(
        cards=[
            FixtureCard("важкий", "hard", "adj", "uk", "Це було важке завдання.",
                        "It was a hard task.", "hard (difficulty)",
                        type=2, queue=2, due=30, ivl=10, reps=3, lapses=0,
                        stability=8.5, difficulty=5.2),
            FixtureCard("капібара", "capybara", "noun", "uk", "Капібара плаває в річці.",
                        "The capybara swims in the river.", "capybara",
                        type=2, queue=-1, due=15, ivl=5, reps=5, lapses=1,
                        stability=12.1, difficulty=3.9),  # suspended
            FixtureCard("новий", "new", "adj", "uk", "Це новий підручник.",
                        "This is a new textbook.", "new",
                        type=0, queue=0, due=0, ivl=0, reps=0, lapses=0,
                        stability=None, difficulty=None),  # new, no FSRS state yet
        ],
        reviews=[
            FixtureReview(card_index=0, ease=3, ivl=3, days_after_crt=1),
            FixtureReview(card_index=0, ease=3, ivl=10, days_after_crt=2),
            FixtureReview(card_index=1, ease=2, ivl=1, days_after_crt=1),
            FixtureReview(card_index=1, ease=4, ivl=5, days_after_crt=2),
            FixtureReview(card_index=1, ease=3, ivl=15, days_after_crt=3),
        ],
    )


def _add_capybara_note_type(col: Collection, name: str, fields: list[str]) -> dict:
    nt = col.models.new(name)
    for f in fields:
        fld = col.models.new_field(f)
        col.models.add_field(nt, fld)
    tmpl = col.models.new_template("Card 1")
    tmpl["qfmt"] = f"{{{{{fields[0]}}}}}"
    tmpl["afmt"] = "{{FrontSide}}<hr>" + "".join(f"{{{{{f}}}}}" for f in fields[1:])
    col.models.add_template(nt, tmpl)
    col.models.add(nt)
    return nt


def _build_collection_bytes(fc: FixtureCollection) -> bytes:
    tmpdir = tempfile.mkdtemp(prefix="capybara_anki_fixture_")
    try:
        path = f"{tmpdir}/collection.anki2"
        col = Collection(path)

        note_types = {
            "capybara": _add_capybara_note_type(col, "Capybara", CAPYBARA_FIELDS),
            "capybara_plus": _add_capybara_note_type(col, "Capybara+", CAPYBARA_FIELDS),
            "pronunciation": _add_capybara_note_type(
                col, "Capybara Pronunciation (shadowing)", PRONUNCIATION_FIELDS
            ),
        }

        # Collection creation time isn't separately settable via the public API in
        # every version — pin it directly, the same way real Anki data is read.
        col.db.execute("update col set crt = ?", fc.crt)

        # Deck config: one preset ("Capybara"), matching the real collection's shape
        # of a single shared preset rather than one per deck. Created and assigned
        # to the standard Capybara decks unconditionally — not only when a card
        # happens to reference one — so a caller building a FixtureCollection() just
        # to inspect scheduler settings (no cards at all) still gets a real deck to
        # resolve config from, the same as the real collection always has one.
        config_id = col.decks.add_config_returning_id("Capybara")
        cfg = col.decks.get_config(config_id)
        cfg["fsrsParams5"] = fc.fsrs_params
        cfg["desiredRetention"] = fc.desired_retention
        cfg["new"]["delays"] = fc.learning_steps
        cfg["new"]["perDay"] = fc.daily_new_limit
        cfg["rev"]["perDay"] = fc.daily_review_limit
        cfg["rev"]["maxIvl"] = fc.max_interval
        col.decks.update_config(cfg)

        for deck_name in ("Capybara::Ukrainian", "Capybara::English"):
            did = col.decks.id(deck_name, create=True)
            col.decks.set_config_id_for_deck_dict(col.decks.get(did), config_id)

        card_ids: list[int] = []
        for spec in fc.cards:
            nt = note_types[spec.note_type]
            note = col.new_note(nt)
            values = {
                "lemma": spec.lemma,
                "gloss": spec.gloss,
                "part_of_speech": spec.part_of_speech,
                "language": spec.language,
                "example": spec.example,
                "example_translation": spec.example_translation,
                "lemma_translation": spec.lemma_translation,
            }
            for fname in CAPYBARA_FIELDS:
                note[fname] = values[fname]

            did = col.decks.id(spec.deck, create=True)
            col.decks.set_config_id_for_deck_dict(col.decks.get(did), config_id)
            col.add_note(note, did)

            card_id = col.card_ids_of_note(note.id)[0]
            card_ids.append(card_id)

            data = {}
            if spec.stability is not None:
                data["s"] = spec.stability
            if spec.difficulty is not None:
                data["d"] = spec.difficulty
            col.db.execute(
                "update cards set type=?, queue=?, due=?, ivl=?, reps=?, lapses=?, data=? "
                "where id=?",
                spec.type, spec.queue, spec.due, spec.ivl, spec.reps, spec.lapses,
                json.dumps(data), card_id,
            )

        for i, review in enumerate(fc.reviews):
            card_id = card_ids[review.card_index]
            # +i milliseconds: two reviews (different cards) can share the same
            # days_after_crt, and revlog.id must be globally unique — it's a real
            # timestamp in real Anki data, where that's true by construction.
            revlog_id = int(fc.crt * 1000 + review.days_after_crt * 86_400_000) + i
            col.db.execute(
                "insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) "
                "values (?, ?, -1, ?, ?, 0, 2500, 5000, 1)",
                revlog_id, card_id, review.ease, review.ivl,
            )

        col.close()
        return Path(path).read_bytes()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def write_export(out_path: Path, compressed: bool, fc: FixtureCollection | None = None) -> Path:
    """Writes a synthetic .colpkg-shaped zip to out_path. compressed=True produces
    the modern zstd (collection.anki21b) shape; False produces the plain
    (collection.anki21) shape.

    Streamed compression, not one-shot, when compressed=True — verified against a
    real export that this is what Anki actually writes (a zstd frame with no
    content-size header). See reader.py's docstring.
    """
    fc = fc or _default_collection()
    raw = _build_collection_bytes(fc)

    with zipfile.ZipFile(out_path, "w") as zf:
        if compressed:
            buf = io.BytesIO()
            with zstandard.ZstdCompressor().stream_writer(buf, closefd=False) as writer:
                writer.write(raw)
            zf.writestr("collection.anki21b", buf.getvalue())
        else:
            zf.writestr("collection.anki21", raw)
        zf.writestr("media", "{}")
    return out_path
