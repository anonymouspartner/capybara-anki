"""Pulls raw rows out of an opened Collection. No interpretation happens here —
that's transform.py's job.

Two different read paths, deliberately:

- **notes, cards, revlog** — still plain SQL tables in every Anki schema version this
  targets, so these go through `col.db.all(...)` (Anki's thin raw-SQL wrapper around
  the same connection its own Rust backend uses) exactly the way a bare
  `sqlite3.Connection` would read them. Table shapes:

    notes(id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
      flds is every field joined by \\x1f (ASCII unit separator), in the note type's
      field order.

    cards(id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses,
          left, odue, odid, flags, data)
      type: 0 new, 1 learning, 2 review, 3 relearning. queue -1 means suspended.
      `data` is still plain JSON (verified against a real export) — FSRS memory
      state lives at `data.s` / `data.d`, and a real card also carries a per-card
      desired-retention override at `data.dr`, which this package doesn't currently
      use but is worth knowing is there.

    revlog(id, cid, usn, ease, ivl, lastIvl, factor, time, type)
      id is milliseconds-since-epoch — it doubles as the review's timestamp.

- **note types and decks** — go through the Collection API (`col.models`,
  `col.decks`), not raw SQL. See reader.py's docstring for why: in a modern
  collection these definitions live outside plain tables (dedicated `notetypes` /
  `fields` tables, or a protobuf blob for deck options), and the API is the one thing
  guaranteed to keep decoding them correctly as Anki's format evolves.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from anki.collection import Collection

FIELD_SEP = "\x1f"


@dataclass
class NoteType:
    mid: str
    name: str
    field_names: list[str]  # in on-disk order — matches how `flds` splits


@dataclass
class RawNote:
    id: int
    guid: str
    mid: str
    fields: list[str]  # already split on FIELD_SEP, in field_names order
    tags: list[str]


@dataclass
class RawCard:
    id: int
    note_id: int
    deck_id: int
    type: int
    queue: int
    due: int
    ivl: int
    reps: int
    lapses: int
    data: dict  # parsed from the `data` JSON column; {} if empty/unparseable


@dataclass
class RawReview:
    id: int  # epoch-ms timestamp, also the review's identity
    card_id: int
    ease: int
    ivl: int


def get_collection_created_at(col: Collection) -> int:
    """Seconds-since-epoch the collection was created — the anchor `cards.due` is
    measured from for review-state cards. See transform.py's due-date handling."""
    return col.db.scalar("select crt from col")


def get_note_types(col: Collection) -> dict[str, NoteType]:
    result = {}
    for m in col.models.all_names_and_ids():
        full = col.models.get(m.id)
        field_names = [f["name"] for f in full["flds"]]
        result[str(m.id)] = NoteType(mid=str(m.id), name=m.name, field_names=field_names)
    return result


def get_notes(col: Collection) -> list[RawNote]:
    rows = col.db.all("select id, guid, mid, flds, tags from notes")
    return [
        RawNote(
            id=r[0],
            guid=r[1],
            mid=str(r[2]),
            fields=r[3].split(FIELD_SEP),
            tags=[t for t in r[4].split(" ") if t],
        )
        for r in rows
    ]


def get_cards(col: Collection) -> list[RawCard]:
    rows = col.db.all("select id, nid, did, type, queue, due, ivl, reps, lapses, data from cards")
    out = []
    for r in rows:
        card_id, note_id, deck_id, type_, queue, due, ivl, reps, lapses, raw_data = r
        try:
            data = json.loads(raw_data) if raw_data else {}
            if not isinstance(data, dict):
                data = {}
        except json.JSONDecodeError:
            data = {}
        out.append(
            RawCard(
                id=card_id, note_id=note_id, deck_id=deck_id, type=type_, queue=queue,
                due=due, ivl=ivl, reps=reps, lapses=lapses, data=data,
            )
        )
    return out


def get_revlog(col: Collection) -> list[RawReview]:
    rows = col.db.all("select id, cid, ease, ivl from revlog order by cid, id")
    return [RawReview(id=r[0], card_id=r[1], ease=r[2], ivl=r[3]) for r in rows]


def get_deck_names(col: Collection) -> dict[int, str]:
    """Names come back already joined with "::" for nested decks — the raw `name`
    column actually stores the FIELD_SEP character between path components (the same
    convention notes use for fields), which `all_names_and_ids()` resolves. A prior
    version of this function read the column directly and got literal "\\x1f" bytes
    in the name, invisible in a terminal and easy to miss — hence going through the
    API here too rather than "it's just a text column, how hard can it be."
    """
    return {d.id: d.name for d in col.decks.all_names_and_ids()}
