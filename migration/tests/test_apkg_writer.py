"""Round-trip test for `apkg_writer.py` — build a collection from this app's own
row shapes, export it, then read it back with the SAME production pipeline a real
re-import would use (`reader.py` / `cli.run_migration`). This is the test the
writer exists to pass: not "does this look plausible", but "does the exact code
this repo already trusts recover what was written, unchanged".

Deliberately does not touch a real export or a real database — every input here
is invented, matching every other test in this package (see fixtures.py's own
docstring on why that rule holds even for tests, not just production).
"""

from __future__ import annotations

import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4

from migration.apkg_writer import MediaFile, build_apkg
from migration.cli import run_migration
from migration.schema import CardState, Note, Review, SchedulerConfig


def _note(**overrides) -> Note:
    defaults = dict(
        id=str(uuid4()),
        anki_guid=f"guid-{uuid4().hex[:8]}",
        lemma="приклад",
        gloss="example",
        lemma_translation="example",
        part_of_speech="noun",
        language="uk",
        example="Це приклад.",
        example_translation="This is an example.",
        audio_url=None,
        deck="Ukrainian",
        kind="vocab",
        has_spelling=False,
    )
    defaults.update(overrides)
    return Note(**defaults)


def _card_state(note_id: str, **overrides) -> CardState:
    defaults = dict(
        note_id=note_id,
        due=date(2026, 10, 1),
        stability=4.2,
        difficulty=5.6,
        state=2,
        reps=3,
        lapses=0,
        suspended=False,
        last_user_id="tim",
        card_kind="recall",
        last_review=datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    return CardState(**defaults)


def _review(note_id: str, **overrides) -> Review:
    defaults = dict(
        id=str(uuid4()),
        note_id=note_id,
        user_id="tim",
        rating=3,
        reviewed_at=datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc),
        elapsed_days=1,
        scheduled_days=4,
        card_kind="recall",
    )
    defaults.update(overrides)
    return Review(**defaults)


def _build_and_reread(notes, card_states, reviews, config, media=None):
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "export.apkg"
        build_apkg(notes, card_states, reviews, config, out_path, media=media)
        assert out_path.exists()
        return run_migration(out_path, user_id="tim")


class TestRoundTrip:
    def test_plain_vocab_note_survives_a_round_trip(self):
        note = _note()
        cs = _card_state(note.id)
        rv = _review(note.id)
        config = SchedulerConfig(
            user_id="tim", fsrs_params=[], desired_retention=0.9,
            learning_steps=[1, 10], daily_new_limit=40, daily_review_limit=200,
            max_interval=36500,
        )

        result = _build_and_reread([note], [cs], [rv], config)

        assert len(result.notes) == 1
        out_note = result.notes[0]
        assert out_note.lemma == note.lemma
        assert out_note.gloss == note.gloss
        assert out_note.lemma_translation == note.lemma_translation
        assert out_note.part_of_speech == note.part_of_speech
        assert out_note.language == note.language
        assert out_note.example == note.example
        assert out_note.example_translation == note.example_translation
        assert out_note.anki_guid == note.anki_guid
        assert out_note.deck == "Ukrainian"
        assert out_note.has_spelling is False

        assert len(result.card_states) == 1
        out_cs = result.card_states[0]
        assert out_cs.card_kind == "recall"
        assert out_cs.due == cs.due
        assert out_cs.stability == cs.stability
        assert out_cs.difficulty == cs.difficulty
        assert out_cs.state == cs.state
        assert out_cs.reps == cs.reps
        assert out_cs.lapses == cs.lapses
        assert out_cs.suspended is False

        assert len(result.reviews) == 1
        out_rv = result.reviews[0]
        assert out_rv.rating == rv.rating
        assert out_rv.reviewed_at == rv.reviewed_at
        assert out_rv.card_kind == "recall"

        assert result.scheduler_config.desired_retention == 0.9
        assert result.scheduler_config.daily_new_limit == 40
        assert result.scheduler_config.daily_review_limit == 200
        assert result.scheduler_config.max_interval == 36500
        assert result.scheduler_config.learning_steps == [1.0, 10.0]

    def test_spelling_card_round_trips_into_its_own_deck_and_kind(self):
        """D17/D21: a has_spelling note produces two independently-scheduled
        cards, and the second one must come back filed under the Spelling deck,
        classified card_kind='spelling' — exactly what card_kind_for/
        resolve_vocab_deck derive purely from deck placement (transform.py)."""
        note = _note(has_spelling=True)
        recall_cs = _card_state(note.id, card_kind="recall", due=date(2026, 10, 1))
        spelling_cs = _card_state(
            note.id, card_kind="spelling", due=date(2026, 10, 5), stability=2.1, difficulty=6.0,
        )
        config = SchedulerConfig(user_id="tim")

        result = _build_and_reread([note], [recall_cs, spelling_cs], [], config)

        assert len(result.notes) == 1
        assert result.notes[0].has_spelling is True
        assert result.notes[0].deck == "Ukrainian"  # the recall card's deck, not Spelling

        by_kind = {cs.card_kind: cs for cs in result.card_states}
        assert set(by_kind) == {"recall", "spelling"}
        assert by_kind["recall"].due == recall_cs.due
        assert by_kind["spelling"].due == spelling_cs.due
        assert by_kind["spelling"].stability == spelling_cs.stability

    def test_english_deck_note_keeps_its_deck(self):
        note = _note(language="en", deck="English", lemma="hard", lemma_translation="важкий")
        result = _build_and_reread([note], [], [], SchedulerConfig(user_id="tim"))
        assert result.notes[0].deck == "English"
        assert result.notes[0].language == "en"

    def test_grammar_deck_note_is_plain_vocab_under_a_different_deck(self):
        """§7.5/§11 item 4: Capybara::Grammar is the plain vocabulary schema under
        a different deck name, no separate note kind."""
        note = _note(deck="Grammar", lemma="б", lemma_translation="would", part_of_speech="particle")
        result = _build_and_reread([note], [], [], SchedulerConfig(user_id="tim"))
        assert result.notes[0].deck == "Grammar"
        assert result.notes[0].kind == "vocab"

    def test_pronunciation_note_round_trips_with_its_field_mapping(self):
        """D18: TargetText<-lemma, Translation<-lemma_translation, Hint<-gloss,
        ReferenceAudio<-audio_url (via the embedded media file)."""
        note = _note(
            kind="pronunciation", deck="Pronunciation", part_of_speech=None,
            lemma="Доброго ранку", lemma_translation="Good morning", gloss="a morning greeting",
            example=None, example_translation=None,
            audio_url="https://example.test/pronunciation-audio/capy_pron_test.mp3",
        )
        media = [MediaFile(filename="capy_pron_test.mp3", data=b"fake mp3 bytes")]

        result = _build_and_reread([note], [], [], SchedulerConfig(user_id="tim"), media=media)

        assert len(result.notes) == 1
        out = result.notes[0]
        assert out.kind == "pronunciation"
        assert out.lemma == note.lemma
        assert out.lemma_translation == note.lemma_translation
        assert out.gloss == note.gloss
        assert out.language == "uk"
        # The reader never reconstructs audio_url from ReferenceAudio (D23 does
        # that separately, from a real Storage URL) — this only asserts the note
        # itself, and its audio, survived the round trip at all, not that the
        # exact original URL comes back unchanged.
        assert out.audio_url is None

    def test_suspended_card_stays_suspended(self):
        note = _note()
        cs = _card_state(note.id, suspended=True)
        result = _build_and_reread([note], [cs], [], SchedulerConfig(user_id="tim"))
        assert result.card_states[0].suspended is True

    def test_new_never_reviewed_card_has_no_fsrs_state(self):
        note = _note()
        cs = _card_state(
            note.id, state=0, stability=None, difficulty=None, due=None,
            reps=0, lapses=0, last_review=None,
        )
        result = _build_and_reread([note], [cs], [], SchedulerConfig(user_id="tim"))
        out = result.card_states[0]
        assert out.stability is None
        assert out.difficulty is None
        assert out.due is None

    def test_multiple_reviews_on_one_card_all_survive(self):
        note = _note()
        reviews = [
            _review(note.id, rating=1, reviewed_at=datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)),
            _review(note.id, rating=3, reviewed_at=datetime(2026, 9, 5, 8, 0, tzinfo=timezone.utc)),
            _review(note.id, rating=4, reviewed_at=datetime(2026, 9, 12, 8, 0, tzinfo=timezone.utc)),
        ]
        result = _build_and_reread([note], [], reviews, SchedulerConfig(user_id="tim"))
        assert len(result.reviews) == 3
        assert sorted(r.rating for r in result.reviews) == [1, 3, 4]
        assert {r.reviewed_at for r in result.reviews} == {r.reviewed_at for r in reviews}

    def test_a_whole_small_collection_round_trips_with_no_warnings(self):
        """The thing Phase 0's own gate (docs/MIGRATION.md §5) asks for: a
        multi-deck, multi-kind collection that comes back with the right shape
        and nothing silently dropped or misclassified."""
        notes = [
            _note(lemma="приклад", deck="Ukrainian"),
            _note(lemma="капібара", deck="Ukrainian", has_spelling=True),
            _note(lemma="hard", language="en", deck="English", lemma_translation="важкий"),
            _note(lemma="б", deck="Grammar", part_of_speech="particle"),
            _note(
                kind="pronunciation", deck="Pronunciation", part_of_speech=None,
                lemma="Доброго ранку", lemma_translation="Good morning",
            ),
        ]
        card_states = [
            _card_state(notes[0].id, card_kind="recall"),
            _card_state(notes[1].id, card_kind="recall"),
            _card_state(notes[1].id, card_kind="spelling"),
        ]
        reviews = [_review(notes[0].id), _review(notes[1].id, card_kind="spelling")]

        result = _build_and_reread(notes, card_states, reviews, SchedulerConfig(user_id="tim"))

        assert result.skipped_note_count == 0
        assert len(result.notes) == 5
        # Every physical Anki card gets a card_state row, "new" by default —
        # 5 notes' recall cards plus the one extra spelling card, even though
        # only 3 of those 6 had scheduling state explicitly set above.
        assert len(result.card_states) == 6
        assert len(result.reviews) == 2
        decks = {n.deck for n in result.notes}
        assert decks == {"Ukrainian", "English", "Grammar", "Pronunciation"}
        assert {cs.card_kind for cs in result.card_states} == {"recall", "spelling"}
        scheduled = [cs for cs in result.card_states if cs.stability is not None]
        assert len(scheduled) == 3  # notes[0]'s recall, notes[1]'s recall and spelling
