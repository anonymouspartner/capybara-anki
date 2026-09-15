"""Pulls raw rows out of an opened collection. No interpretation happens here —
that's transform.py's job. This module only knows Anki's table shapes.

Table shapes (stable across the versions this targets; see reader.py for where the
version uncertainty actually lives — the export *container* format, not these tables):

  notes(id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
    flds is every field joined by \\x1f (ASCII unit separator), in the note type's
    field order — which is why the note type's own field list has to be read too.

  cards(id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses,
        left, odue, odid, flags, data)
    type: 0 new, 1 learning, 2 review, 3 relearning. queue -1 means suspended,
    regardless of type. `due`'s meaning depends on `type` — handled in transform.py,
    not here, because it needs col.crt (collection creation date) to resolve.

  revlog(id, cid, usn, ease, ivl, lastIvl, factor, time, type)
    id is milliseconds-since-epoch — it doubles as the review's timestamp.

  col(id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
    One row. `models` is note-type definitions, keyed by note-type id (as a string).
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass

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


def get_collection_created_at(conn: sqlite3.Connection) -> int:
    """Seconds-since-epoch the collection was created — the anchor `cards.due` is
    measured from for review-state cards. See transform.py's due-date handling."""
    row = conn.execute("select crt from col").fetchone()
    if row is None:
        raise ValueError("col table is empty — not a valid Anki collection database.")
    return row["crt"]


def get_note_types(conn: sqlite3.Connection) -> dict[str, NoteType]:
    row = conn.execute("select models from col").fetchone()
    if row is None or not row["models"]:
        return {}
    models = json.loads(row["models"])
    return {
        mid: NoteType(
            mid=mid,
            name=model.get("name", "?"),
            field_names=[f.get("name", f"field_{i}") for i, f in enumerate(model.get("flds", []))],
        )
        for mid, model in models.items()
    }


def get_notes(conn: sqlite3.Connection) -> list[RawNote]:
    rows = conn.execute("select id, guid, mid, flds, tags from notes").fetchall()
    return [
        RawNote(
            id=r["id"],
            guid=r["guid"],
            mid=str(r["mid"]),
            fields=r["flds"].split(FIELD_SEP),
            tags=[t for t in r["tags"].split(" ") if t],
        )
        for r in rows
    ]


def get_cards(conn: sqlite3.Connection) -> list[RawCard]:
    rows = conn.execute(
        "select id, nid, did, type, queue, due, ivl, reps, lapses, data from cards"
    ).fetchall()
    out = []
    for r in rows:
        try:
            data = json.loads(r["data"]) if r["data"] else {}
            if not isinstance(data, dict):
                data = {}
        except json.JSONDecodeError:
            data = {}
        out.append(
            RawCard(
                id=r["id"],
                note_id=r["nid"],
                deck_id=r["did"],
                type=r["type"],
                queue=r["queue"],
                due=r["due"],
                ivl=r["ivl"],
                reps=r["reps"],
                lapses=r["lapses"],
                data=data,
            )
        )
    return out


def get_revlog(conn: sqlite3.Connection) -> list[RawReview]:
    rows = conn.execute("select id, cid, ease, ivl from revlog order by cid, id").fetchall()
    return [RawReview(id=r["id"], card_id=r["cid"], ease=r["ease"], ivl=r["ivl"]) for r in rows]


def get_deck_names(conn: sqlite3.Connection) -> dict[int, str]:
    row = conn.execute("select decks from col").fetchone()
    if row is None or not row["decks"]:
        return {}
    decks = json.loads(row["decks"])
    return {int(did): d.get("name", "?") for did, d in decks.items()}
