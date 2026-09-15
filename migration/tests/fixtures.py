"""Builds synthetic Anki-schema collections for tests.

Never touches the maintainer's real collection — deliberately. Real exports contain
the corpus (see this repo's .gitignore and README); tests only ever exercise this
package against data invented here.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import zstandard

FIELD_SEP = "\x1f"
CAPYBARA_FIELDS = [
    "lemma",
    "gloss",
    "lemma_translation",
    "part_of_speech",
    "language",
    "example",
    "example_translation",
]

_SCHEMA = """
create table col (
  id integer primary key, crt integer, mod integer, scm integer, ver integer,
  dty integer, usn integer, ls integer, conf text, models text, decks text,
  dconf text, tags text
);
create table notes (
  id integer primary key, guid text, mid integer, mod integer, usn integer,
  tags text, flds text, sfld text, csum integer, flags integer, data text
);
create table cards (
  id integer primary key, nid integer, did integer, ord integer, mod integer,
  usn integer, type integer, queue integer, due integer, ivl integer,
  factor integer, reps integer, lapses integer, left integer, odue integer,
  odid integer, flags integer, data text
);
create table revlog (
  id integer primary key, cid integer, usn integer, ease integer, ivl integer,
  lastIvl integer, factor integer, time integer, type integer
);
"""

CAPYBARA_MID = 1700000000001
UKRAINIAN_DECK_ID = 2
CAPYBARA_DCONF_ID = 3


@dataclass
class FixtureNote:
    note_id: int
    guid: str
    lemma: str
    gloss: str = ""
    lemma_translation: str = ""
    part_of_speech: str = ""
    language: str = "uk"
    example: str = ""
    example_translation: str = ""


@dataclass
class FixtureCard:
    card_id: int
    note_id: int
    deck_id: int = UKRAINIAN_DECK_ID
    type: int = 2  # review
    queue: int = 2
    due: int = 30  # days since collection creation
    ivl: int = 10
    reps: int = 3
    lapses: int = 0
    stability: float | None = 8.5
    difficulty: float | None = 5.2


@dataclass
class FixtureReview:
    revlog_id: int  # epoch-ms
    card_id: int
    ease: int = 3
    ivl: int = 10


@dataclass
class FixtureCollection:
    crt: int = 1_700_000_000  # collection creation, epoch seconds
    notes: list[FixtureNote] = field(default_factory=list)
    cards: list[FixtureCard] = field(default_factory=list)
    reviews: list[FixtureReview] = field(default_factory=list)
    fsrs_params: list[float] = field(default_factory=lambda: [0.4, 0.6, 2.4, 5.8])
    desired_retention: float = 0.9
    learning_steps: list[int] = field(default_factory=lambda: [1, 10])
    daily_new_limit: int = 20
    daily_review_limit: int = 200
    max_interval: int = 36500


def _default_collection() -> FixtureCollection:
    fc = FixtureCollection()
    fc.notes = [
        FixtureNote(1, "guid-aaa", "важкий", "hard", "hard (difficulty)", "adj", "uk",
                    "Це було важке завдання.", "It was a hard task."),
        FixtureNote(2, "guid-bbb", "капібара", "capybara", "capybara", "noun", "uk",
                    "Капібара плаває в річці.", "The capybara swims in the river."),
        FixtureNote(3, "guid-ccc", "новий", "new", "new", "adj", "uk",
                    "Це новий підручник.", "This is a new textbook."),
    ]
    fc.cards = [
        FixtureCard(101, 1, type=2, queue=2, due=30, ivl=10, reps=3, lapses=0,
                    stability=8.5, difficulty=5.2),
        FixtureCard(102, 2, type=2, queue=-1, due=15, ivl=5, reps=5, lapses=1,
                    stability=12.1, difficulty=3.9),  # suspended
        FixtureCard(103, 3, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0,
                    stability=None, difficulty=None),  # new, no FSRS state yet
    ]
    fc.reviews = [
        FixtureReview(1_700_100_000_000, 101, ease=3, ivl=3),
        FixtureReview(1_700_186_400_000, 101, ease=3, ivl=10),  # +1 day later
        FixtureReview(1_700_300_000_000, 102, ease=2, ivl=1),
        FixtureReview(1_700_400_000_000, 102, ease=4, ivl=5),
        FixtureReview(1_700_500_000_000, 102, ease=3, ivl=15),
    ]
    return fc


def _build_sqlite(fc: FixtureCollection, note_type_name: str = "Capybara",
                   note_type_fields: list[str] | None = None,
                   fsrs_params_key: str = "fsrsParams5") -> bytes:
    """`fsrs_params_key` exists for test_config.py's "Anki renamed the key" case —
    everywhere else uses the default, matching what config.py actually looks for."""
    fields = CAPYBARA_FIELDS if note_type_fields is None else note_type_fields
    models = {
        str(CAPYBARA_MID): {
            "name": note_type_name,
            "flds": [{"name": f} for f in fields],
        }
    }
    decks = {
        "1": {"name": "Default", "conf": 1},
        str(UKRAINIAN_DECK_ID): {"name": "Capybara::Ukrainian", "conf": CAPYBARA_DCONF_ID},
    }
    dconf = {
        "1": {"new": {"delays": [1, 10], "perDay": 20}, "rev": {"perDay": 200, "maxIvl": 36500}},
        str(CAPYBARA_DCONF_ID): {
            fsrs_params_key: fc.fsrs_params,
            "desiredRetention": fc.desired_retention,
            "new": {"delays": fc.learning_steps, "perDay": fc.daily_new_limit},
            "rev": {"perDay": fc.daily_review_limit, "maxIvl": fc.max_interval},
        },
    }

    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        db_path = tmp.name
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA)
    conn.execute(
        "insert into col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) "
        "values (1, ?, 0, 0, 18, 0, 0, 0, '{}', ?, ?, ?, '{}')",
        (fc.crt, json.dumps(models), json.dumps(decks), json.dumps(dconf)),
    )
    for n in fc.notes:
        flds = FIELD_SEP.join(
            [n.lemma, n.gloss, n.lemma_translation, n.part_of_speech, n.language,
             n.example, n.example_translation]
        )
        conn.execute(
            "insert into notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) "
            "values (?, ?, ?, 0, 0, '', ?, ?, 0, 0, '')",
            (n.note_id, n.guid, CAPYBARA_MID, flds, n.lemma),
        )
    for c in fc.cards:
        data = {}
        if c.stability is not None:
            data["s"] = c.stability
        if c.difficulty is not None:
            data["d"] = c.difficulty
        conn.execute(
            "insert into cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, "
            "factor, reps, lapses, left, odue, odid, flags, data) "
            "values (?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 2500, ?, ?, 0, 0, 0, 0, ?)",
            (c.card_id, c.note_id, c.deck_id, c.type, c.queue, c.due, c.ivl,
             c.reps, c.lapses, json.dumps(data)),
        )
    for r in fc.reviews:
        conn.execute(
            "insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) "
            "values (?, ?, 0, ?, ?, 0, 2500, 5000, 1)",
            (r.revlog_id, r.card_id, r.ease, r.ivl),
        )
    conn.commit()
    conn.close()

    data = Path(db_path).read_bytes()
    Path(db_path).unlink()
    return data


def write_export(
    out_path: Path,
    compressed: bool,
    fc: FixtureCollection | None = None,
    note_type_name: str = "Capybara",
    note_type_fields: list[str] | None = None,
    fsrs_params_key: str = "fsrsParams5",
) -> Path:
    """Writes a synthetic .colpkg-shaped zip to out_path. compressed=True produces
    the modern zstd (collection.anki21b) shape; False produces the plain
    (collection.anki21) shape this repo's other test suite already reads."""
    fc = fc or _default_collection()
    raw = _build_sqlite(fc, note_type_name=note_type_name, note_type_fields=note_type_fields,
                         fsrs_params_key=fsrs_params_key)

    with zipfile.ZipFile(out_path, "w") as zf:
        if compressed:
            payload = zstandard.ZstdCompressor().compress(raw)
            zf.writestr("collection.anki21b", payload)
        else:
            zf.writestr("collection.anki21", raw)
        zf.writestr("media", "{}")
    return out_path
