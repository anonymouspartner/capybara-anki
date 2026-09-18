"""Writes a real Anki collection from this app's own row shapes — `schema.py`'s
`Note`/`CardState`/`Review`/`SchedulerConfig` — and exports it as a legacy-format
`.apkg`. Phase 0.1 of `docs/MIGRATION.md`: the escape hatch `docs/DESIGN.md` §2.3
promises and that, until this file, did not exist for this collection.

This is the read side's mirror image, deliberately built to round-trip through the
SAME code that reads an export back in (`reader.py` / `extract.py` / `transform.py`
/ `cli.py`'s `run_migration`), not a second, independently-guessed shape:

- Decks are named `Capybara::<deck>` because `transform.strip_deck_prefix`'s
  default prefix is `"Capybara::"` — anything else would silently fail to
  round-trip through the exact tool this repo already trusts.
- A spelling card is filed in `Capybara::Spelling` because `card_kind_for`
  classifies a card as `'spelling'` iff its deck (after stripping that prefix)
  is literally `"Spelling"` — see `transform.py`.
- Scheduling state is written into `cards.data` as `{"s": stability,
  "d": difficulty}`, because that is the exact key `transform_card_state` reads
  it back from.

None of this is guessed. Every shape here is the inverse of a function this repo
already verified against a real export (`docs/DESIGN.md` §7.5).

**Two vocab notetypes, not one conditional template.** `"Capybara"` (one
template, `Card 1`) for notes without a spelling card; `"Capybara+"` (two
templates, the second pinned via its own `did` to the Spelling deck) for notes
with one — mirroring the real collection's own structure (§7.5 finding 5) rather
than inventing a mechanism Anki doesn't already use for the same thing. Card
templates are minimal (front/back text, no attempt to reproduce the original
export's exact CSS) — this tool's job is that the *data* survives a round trip
intact, not that the cards are visually identical to whatever AnkiDroid rendered.

**D7's reasoning applies to writing as much as it does to reading.** Hand-writing
SQLite rows for notes/decks/notetypes would silently drift the moment Anki's
schema changes again. This uses the real `anki` package's `Collection` API for
all of that, and only drops to raw SQL for the two things that API has no public
setter for — a card's FSRS memory state and its own `revlog` rows — the exact
same two raw-SQL operations `reader.py`'s read side already established as safe.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from hashlib import sha1
from pathlib import Path

from anki.collection import Collection, ExportAnkiPackageOptions

from migration.schema import CardState, Note, Review, SchedulerConfig

VOCAB_FIELDS = [
    "lemma", "gloss", "part_of_speech", "language",
    "example", "example_translation", "lemma_translation",
]
PRONUNCIATION_FIELDS = ["TargetText", "ReferenceAudio", "Translation", "Language", "Hint", "SourceId"]

DECK_PREFIX = "Capybara::"
SPELLING_DECK_NAME = "Spelling"

# Below transform.py's own _TIMESTAMP_VS_DAY_OFFSET_THRESHOLD (10**9) by
# construction — every due value this module writes is a day-count from
# _COLLECTION_CREATED_AT, in the thousands at most, so it always lands on the
# "day offset" branch of _due_to_date, never the "raw timestamp" one.
_CRT_DATE = date(2020, 1, 1)
_COLLECTION_CREATED_AT = int(datetime.combine(_CRT_DATE, datetime.min.time(), tzinfo=timezone.utc).timestamp())


def _stable_guid(note_id: str) -> str:
    """A deterministic guid for a note that never had a real Anki one — anything
    with `source != 'anki-import'` (bot- and scan-captured notes). Deterministic
    so running this exporter twice for the same note produces the same guid both
    times, which is what would let a future re-import recognise it as the same
    note rather than minting a duplicate. Doesn't need Anki's own base91 guid
    alphabet, only to be short, stable, and vanishingly unlikely to collide with
    a real Anki-issued one — nothing about Anki's guid format is reserved in a
    way a foreign string could accidentally match.
    """
    return sha1(note_id.encode()).hexdigest()[:10]


def _card_deck_name(note: Note, card_kind: str) -> str:
    """The one place this module decides which deck a card belongs in — mirrors
    `src/review/types.ts`'s `deckOfCard` exactly (a spelling card lives in the
    Spelling deck, never its note's own deck)."""
    return SPELLING_DECK_NAME if card_kind == "spelling" else note.deck


@dataclass
class MediaFile:
    """One pronunciation recording to embed. `filename` must match the basename
    already referenced by the note's `ReferenceAudio` field (`[sound:<filename>]`)
    — see `_pronunciation_sound_field`."""

    filename: str
    data: bytes


def _pronunciation_sound_field(note: Note) -> str:
    """`ReferenceAudio`'s value: empty if this note has no audio (nothing to
    shadow, same state a never-uploaded note is in today), otherwise Anki's
    `[sound:...]` syntax around whatever filename `audio_url` ends in."""
    if not note.audio_url:
        return ""
    filename = note.audio_url.rsplit("/", 1)[-1]
    return f"[sound:{filename}]"


def _set_collection_created_at(col: Collection, epoch_seconds: int) -> None:
    col.db.execute("update col set crt = ?", epoch_seconds)


def _ensure_decks(col: Collection, notes: list[Note], has_pronunciation: bool) -> dict[str, int]:
    """One Anki deck per distinct app-level deck name actually needed, keyed on
    that plain name (`"Ukrainian"`, not `"Capybara::Ukrainian"`) so callers never
    have to re-derive the prefix. `Spelling` is created whenever any note carries
    a spelling card; `Pronunciation` whenever any pronunciation note exists —
    matching `getDecks`' own "the deck exists iff something needs it" rule
    (`supabase/functions/_shared/postgresStore.ts`)."""
    names = {note.deck for note in notes if note.kind == "vocab"}
    if any(note.has_spelling for note in notes):
        names.add(SPELLING_DECK_NAME)
    if has_pronunciation:
        names.add("Pronunciation")

    deck_ids: dict[str, int] = {}
    for name in sorted(names):
        result = col.decks.add_normal_deck_with_name(f"{DECK_PREFIX}{name}")
        deck_ids[name] = result.id
    return deck_ids


def _write_scheduler_config(col: Collection, cfg: SchedulerConfig, deck_ids: dict[str, int]) -> None:
    """Applies the five settings §7.3 says matter to every deck this export
    creates, via a single new deck-options group — the inverse of
    `config.py`'s read side, key-for-key: `fsrsParams6`, `desiredRetention`,
    `new.delays`, `new.perDay`, `rev.perDay`, `rev.maxIvl`. A `None` field (the
    extractor couldn't find it) is left at whatever `Collection()` already
    defaulted it to, rather than writing a guessed number."""
    conf_id = col.decks.add_config_returning_id("Capybara")
    conf = col.decks.get_config(conf_id)
    if conf is None:
        return  # pragma: no cover — add_config_returning_id always creates one

    if cfg.fsrs_params is not None:
        conf["fsrsParams6"] = list(cfg.fsrs_params)
    if cfg.desired_retention is not None:
        conf["desiredRetention"] = cfg.desired_retention
    if cfg.learning_steps is not None:
        conf["new"]["delays"] = list(cfg.learning_steps)
    if cfg.daily_new_limit is not None:
        conf["new"]["perDay"] = cfg.daily_new_limit
    if cfg.daily_review_limit is not None:
        conf["rev"]["perDay"] = cfg.daily_review_limit
    if cfg.max_interval is not None:
        conf["rev"]["maxIvl"] = cfg.max_interval
    col.decks.update_config(conf)

    for deck_id in deck_ids.values():
        deck = col.decks.get(deck_id)
        if deck is not None:
            col.decks.set_config_id_for_deck_dict(deck, conf_id)


def _ensure_vocab_notetypes(col: Collection, deck_ids: dict[str, int]) -> tuple[dict, dict]:
    """`Capybara` (one card, `Card 1`) and `Capybara+` (two cards, `Card 1` +
    `Spelling`) — the real collection's own two note types (§7.5 finding 5), not
    one note type with a conditionally-generated card. `Capybara+`'s `Spelling`
    template gets its own `did`, exactly how the real collection pins that
    template to `Capybara::Spelling` regardless of which deck the note's primary
    card was added to — a template-level deck override, not a note-level one."""

    def add_fields(nt: dict) -> None:
        for name in VOCAB_FIELDS:
            col.models.add_field(nt, col.models.new_field(name))

    def front_back(field_name: str = "lemma") -> tuple[str, str]:
        front = f"{{{{{field_name}}}}}"
        back = (
            "{{FrontSide}}<hr>{{lemma_translation}}<br>{{gloss}}<br>"
            "<i>{{part_of_speech}}</i><br>{{example}}<br>{{example_translation}}"
        )
        return front, back

    capybara = col.models.new("Capybara")
    add_fields(capybara)
    tmpl = col.models.new_template("Card 1")
    tmpl["qfmt"], tmpl["afmt"] = front_back()
    col.models.add_template(capybara, tmpl)
    col.models.add(capybara)

    capybara_plus = col.models.new("Capybara+")
    add_fields(capybara_plus)
    recall_tmpl = col.models.new_template("Card 1")
    recall_tmpl["qfmt"], recall_tmpl["afmt"] = front_back()
    col.models.add_template(capybara_plus, recall_tmpl)
    spelling_tmpl = col.models.new_template("Spelling")
    spelling_tmpl["qfmt"] = "Spell: {{lemma_translation}}"
    spelling_tmpl["afmt"] = "{{FrontSide}}<hr>{{lemma}}"
    if SPELLING_DECK_NAME in deck_ids:
        spelling_tmpl["did"] = deck_ids[SPELLING_DECK_NAME]
    col.models.add_template(capybara_plus, spelling_tmpl)
    col.models.add(capybara_plus)

    return capybara, capybara_plus


def _ensure_pronunciation_notetype(col: Collection) -> dict:
    """`Capybara Pronunciation (shadowing)` — D18's field mapping in reverse:
    TargetText/ReferenceAudio/Translation/Language/Hint/SourceId, one template."""
    nt = col.models.new("Capybara Pronunciation (shadowing)")
    for name in PRONUNCIATION_FIELDS:
        col.models.add_field(nt, col.models.new_field(name))
    tmpl = col.models.new_template("Listen and Speak")
    tmpl["qfmt"] = "{{ReferenceAudio}}<br>{{Hint}}"
    tmpl["afmt"] = "{{FrontSide}}<hr>{{TargetText}}<br>{{Translation}}"
    col.models.add_template(nt, tmpl)
    col.models.add(nt)
    return nt


def _write_note(
    col: Collection,
    note: Note,
    vocab_nt: dict,
    vocab_plus_nt: dict,
    pron_nt: dict,
    deck_ids: dict[str, int],
    media_by_filename: dict[str, bytes],
) -> dict[str, int]:
    """Creates the note and its card(s), returns `{card_kind: anki_card_id}` so
    the caller can attach scheduling state and revlog to the right physical card.
    """
    if note.kind == "pronunciation":
        anki_note = col.new_note(pron_nt)
        anki_note.guid = note.anki_guid or _stable_guid(note.id)
        anki_note["TargetText"] = note.lemma
        anki_note["ReferenceAudio"] = _pronunciation_sound_field(note)
        anki_note["Translation"] = note.lemma_translation or ""
        anki_note["Language"] = note.language
        anki_note["Hint"] = note.gloss or ""
        anki_note["SourceId"] = ""

        filename = (note.audio_url or "").rsplit("/", 1)[-1]
        data = media_by_filename.get(filename)
        if data:
            with tempfile.NamedTemporaryFile(suffix=f"_{filename}") as tmp:
                tmp.write(data)
                tmp.flush()
                actual_name = col.media.add_file(tmp.name)
            anki_note["ReferenceAudio"] = f"[sound:{actual_name}]"

        deck_id = deck_ids.get("Pronunciation")
        col.add_note(anki_note, deck_id)
        (card_id,) = col.card_ids_of_note(anki_note.id)
        return {"recall": card_id}

    notetype = vocab_plus_nt if note.has_spelling else vocab_nt
    anki_note = col.new_note(notetype)
    anki_note.guid = note.anki_guid or _stable_guid(note.id)
    anki_note["lemma"] = note.lemma
    anki_note["gloss"] = note.gloss or ""
    anki_note["part_of_speech"] = note.part_of_speech or ""
    anki_note["language"] = note.language
    anki_note["example"] = note.example or ""
    anki_note["example_translation"] = note.example_translation or ""
    anki_note["lemma_translation"] = note.lemma_translation or ""

    deck_id = deck_ids.get(note.deck) or deck_ids.get("Ukrainian")
    col.add_note(anki_note, deck_id)
    card_ids = col.card_ids_of_note(anki_note.id)

    result = {"recall": card_ids[0]}
    if note.has_spelling and len(card_ids) > 1:
        result["spelling"] = card_ids[1]
    return result


# 0 New | 1 Learning | 2 Review | 3 Relearning — CardState.state's own encoding
# (docs/DESIGN.md §5), identical to Anki's cards.type. Queue mostly mirrors type;
# a suspended card always gets queue -1 regardless of type, matching Anki's own
# "suspension is orthogonal to scheduling state" rule (this repo's own comment on
# it, src/review/types.ts).
_QUEUE_FOR_STATE = {0: 0, 1: 1, 2: 2, 3: 1}


def _write_card_state(col: Collection, anki_card_id: int, cs: CardState) -> None:
    state = cs.state if cs.state is not None else 0
    queue = -1 if cs.suspended else _QUEUE_FOR_STATE.get(state, 0)
    due = (cs.due - _CRT_DATE).days if cs.due is not None else 0
    data = json.dumps(
        {"s": cs.stability, "d": cs.difficulty}
        if cs.stability is not None and cs.difficulty is not None
        else {}
    )
    col.db.execute(
        "update cards set type = ?, queue = ?, due = ?, ivl = ?, reps = ?, lapses = ?, data = ? "
        "where id = ?",
        state, queue, due, 0, cs.reps, cs.lapses, data, anki_card_id,
    )


# Anki's revlog.type (0 learn | 1 review | 2 relearn | 3 filtered | 4 manual) is
# display/history metadata — FSRS replay (both Anki's own and this repo's
# src/fsrs/replay.ts) reads ease and ivl, never this column. schema.py's Review
# doesn't carry the original value at all (nothing downstream needs it), so every
# restored row is written as a plain "review" rather than reconstructing a
# distinction nothing reads.
_REVLOG_TYPE = 1


def _write_revlog(col: Collection, anki_card_id: int, review: Review) -> None:
    """One `revlog` row per `Review`. `id` is the review's own epoch-ms timestamp
    — Anki's own revlog identity convention, and unique per card by construction
    since two answers to the same card can't share a millisecond in practice; on
    the rare collision this nudges forward by 1ms rather than failing the whole
    export, which is a display-order tiebreak, not a scheduling one (`ivl`/`ease`
    are what FSRS replay actually reads)."""
    review_id = int(review.reviewed_at.timestamp() * 1000)
    while col.db.scalar("select 1 from revlog where id = ?", review_id):
        review_id += 1
    col.db.execute(
        "insert into revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) "
        "values (?, ?, -1, ?, ?, 0, 0, 0, ?)",
        review_id, anki_card_id, review.rating, review.scheduled_days, _REVLOG_TYPE,
    )


def _export(col_path: str, out_path: Path) -> None:
    col = Collection(col_path)
    try:
        col.export_anki_package(
            out_path=str(out_path),
            # with_deck_configs=True matters more than it looks: without it, the
            # legacy exporter silently substitutes Anki's own factory-default
            # deck-options preset for every deck — found by a test that wrote
            # daily_new_limit=40 and read 20 back, Anki's own default, not a
            # missing-value fallback of this module's.
            options=ExportAnkiPackageOptions(
                with_scheduling=True, with_media=True, with_deck_configs=True, legacy=True,
            ),
            limit=None,
        )
    finally:
        col.close()


def build_apkg(
    notes: list[Note],
    card_states: list[CardState],
    reviews: list[Review],
    scheduler_config: SchedulerConfig,
    out_path: Path,
    media: list[MediaFile] | None = None,
) -> None:
    """Writes `out_path` as a legacy-format `.apkg` carrying every note, both
    card kinds, full scheduling state and the complete review log. `card_states`
    and `reviews` are matched to `notes` by `note_id` (== `Note.id`, the uuid
    `schema.py` already uses as the shared key)."""
    media_by_filename = {m.filename: m.data for m in (media or [])}

    card_states_by_note: dict[str, list[CardState]] = {}
    for cs in card_states:
        card_states_by_note.setdefault(cs.note_id, []).append(cs)
    reviews_by_key: dict[tuple[str, str], list[Review]] = {}
    for r in reviews:
        reviews_by_key.setdefault((r.note_id, r.card_kind), []).append(r)

    has_pronunciation = any(n.kind == "pronunciation" for n in notes)

    with tempfile.TemporaryDirectory() as tmp:
        col_path = str(Path(tmp) / "collection.anki2")
        col = Collection(col_path)
        try:
            _set_collection_created_at(col, _COLLECTION_CREATED_AT)
            deck_ids = _ensure_decks(col, notes, has_pronunciation)
            _write_scheduler_config(col, scheduler_config, deck_ids)
            vocab_nt, vocab_plus_nt = _ensure_vocab_notetypes(col, deck_ids)
            pron_nt = _ensure_pronunciation_notetype(col)

            for note in notes:
                card_ids = _write_note(
                    col, note, vocab_nt, vocab_plus_nt, pron_nt, deck_ids, media_by_filename,
                )
                for card_kind, anki_card_id in card_ids.items():
                    for cs in card_states_by_note.get(note.id, []):
                        if cs.card_kind == card_kind:
                            _write_card_state(col, anki_card_id, cs)
                    for review in reviews_by_key.get((note.id, card_kind), []):
                        _write_revlog(col, anki_card_id, review)
        finally:
            col.close()

        _export(col_path, out_path)
