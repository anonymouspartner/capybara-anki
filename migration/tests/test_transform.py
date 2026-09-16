from datetime import timedelta, timezone

from migration.extract import NoteType, RawCard, RawNote, RawReview
from migration.transform import (
    EXPECTED_FIELDS,
    PRONUNCIATION_FIELDS,
    card_kind_for,
    compute_elapsed_days,
    latest_review_time,
    note_uuid,
    resolve_vocab_deck,
    review_uuid,
    strip_deck_prefix,
    transform_card_state,
    transform_note,
    transform_pronunciation_note,
    transform_review,
)

# A placeholder id, not a real Anki note-type id — these are hand-built unit tests
# of transform_note() in isolation, so all that matters is that RawNote.mid and
# NoteType.mid agree with each other, not that either is a real assigned value.
_TEST_MID = "1"


def _capybara_note_type():
    return NoteType(mid=_TEST_MID, name="Capybara", field_names=EXPECTED_FIELDS)


def _raw_note(**overrides):
    # Field order matches EXPECTED_FIELDS — verified against a real export,
    # 2026-09-15: lemma_translation is LAST, not third (see transform.py).
    defaults = dict(
        id=1, guid="guid-aaa", mid=_TEST_MID,
        fields=["важкий", "hard", "adj", "uk",
                "Це було важке завдання.", "It was a hard task.", "hard (difficulty)"],
        tags=[],
    )
    defaults.update(overrides)
    return RawNote(**defaults)


class TestTransformNote:
    def test_recognized_capybara_note_transforms_cleanly(self):
        note, skip_reason = transform_note(_raw_note(), _capybara_note_type())
        assert skip_reason is None
        assert note.lemma == "важкий"
        assert note.language == "uk"
        assert note.anki_guid == "guid-aaa"
        assert note.source == "anki-import"
        # audio is never in the export (media excluded) — see transform.py docstring
        assert note.audio_url is None

    def test_ids_are_deterministic_across_runs(self):
        """§7.2 / D15: migration is re-run at least twice, so re-running on the same
        export must produce the same note id, not a fresh random one each time."""
        note1, _ = transform_note(_raw_note(), _capybara_note_type())
        note2, _ = transform_note(_raw_note(), _capybara_note_type())
        assert note1.id == note2.id == note_uuid("guid-aaa")

    def test_different_guid_produces_a_different_id(self):
        note_a, _ = transform_note(_raw_note(guid="guid-aaa"), _capybara_note_type())
        note_b, _ = transform_note(_raw_note(guid="guid-bbb"), _capybara_note_type())
        assert note_a.id != note_b.id

    def test_unknown_note_type_is_skipped_not_guessed(self):
        note, skip_reason = transform_note(_raw_note(), note_type=None)
        assert note is None
        assert "unknown note type" in skip_reason

    def test_note_type_with_unrelated_fields_is_skipped(self):
        """A completely different field set (e.g. the real collection's separate
        'Capybara Pronunciation (shadowing)' note type) is excluded — by field
        signature, not by name. See the module comment above EXPECTED_FIELDS."""
        wrong_type = NoteType(mid="99", name="Basic", field_names=["Front", "Back"])
        note, skip_reason = transform_note(_raw_note(mid="99"), wrong_type)
        assert note is None
        assert "fields don't match" in skip_reason

    def test_note_type_name_is_irrelevant_to_recognition(self):
        """Verified against a real export: two different note-type NAMES
        ("Capybara" and "Capybara+") carry the identical Capybara vocabulary field
        set. Recognition has to key on fields, not name, or one of the two would be
        silently skipped."""
        differently_named = NoteType(mid="7", name="Capybara+", field_names=EXPECTED_FIELDS)
        note, skip_reason = transform_note(_raw_note(mid="7"), differently_named)
        assert skip_reason is None
        assert note is not None

    def test_reordered_fields_are_skipped_not_silently_misread(self):
        """A field-order mismatch is exactly the failure mode that would otherwise
        put a translation in the lemma column with no error anywhere."""
        reordered = NoteType(
            mid=_TEST_MID, name="Capybara",
            field_names=["gloss", "lemma", *EXPECTED_FIELDS[2:]],
        )
        note, skip_reason = transform_note(_raw_note(), reordered)
        assert note is None
        assert "fields don't match" in skip_reason

    def test_mismatched_field_count_is_skipped(self):
        note, skip_reason = transform_note(
            _raw_note(fields=["важкий", "hard"]), _capybara_note_type()
        )
        assert note is None
        assert "malformed flds" in skip_reason


class TestTransformCardState:
    def test_new_card_has_no_due_date_and_no_fsrs_state(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0,
                        reps=0, lapses=0, data={})
        state, warnings = transform_card_state(card, note_id="n1", user_id="tim",
                                                 collection_created_at=1_700_000_000)
        assert state.due is None
        assert state.stability is None
        assert state.state == 0
        assert warnings == []  # a new card having no FSRS state yet isn't a warning

    def test_review_card_due_date_is_collection_creation_plus_due_days(self):
        crt = 1_700_000_000  # a Tuesday-ish date, exact day doesn't matter
        card = RawCard(id=1, note_id=1, deck_id=2, type=2, queue=2, due=30, ivl=10,
                        reps=3, lapses=0, data={"s": 8.5, "d": 5.2})
        from datetime import datetime, timezone
        state, warnings = transform_card_state(
            card, note_id="n1", user_id="tim", collection_created_at=crt,
            last_review=datetime.fromtimestamp(crt, tz=timezone.utc),
        )
        expected = datetime.fromtimestamp(crt, tz=timezone.utc).date() + timedelta(days=30)
        assert state.due == expected
        assert state.stability == 8.5
        assert state.difficulty == 5.2
        assert warnings == []

    def test_suspended_card_is_flagged_regardless_of_type(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=2, queue=-1, due=10, ivl=5,
                        reps=2, lapses=1, data={"s": 3.0, "d": 4.0})
        state, _ = transform_card_state(card, note_id="n1", user_id="tim",
                                         collection_created_at=1_700_000_000)
        assert state.suspended is True

    def test_missing_fsrs_state_on_a_non_new_card_warns_instead_of_guessing(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=2, queue=2, due=10, ivl=5,
                        reps=2, lapses=0, data={})  # no "s"/"d" keys at all
        state, warnings = transform_card_state(card, note_id="n1", user_id="tim",
                                                 collection_created_at=1_700_000_000)
        assert state.stability is None
        assert state.difficulty is None
        assert any("no FSRS memory state" in w for w in warnings)

    def test_last_user_id_is_whoever_this_export_belongs_to(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0,
                        reps=0, lapses=0, data={})
        state, _ = transform_card_state(card, note_id="n1", user_id="vika",
                                         collection_created_at=1_700_000_000)
        assert state.last_user_id == "vika"


class TestTransformReview:
    def test_review_id_is_deterministic(self):
        r1 = review_uuid(card_id=101, revlog_id=1_700_100_000_000)
        r2 = review_uuid(card_id=101, revlog_id=1_700_100_000_000)
        assert r1 == r2

    def test_reviewed_at_comes_from_the_revlog_timestamp(self):
        raw = RawReview(id=1_700_100_000_000, card_id=101, ease=3, ivl=10)
        review = transform_review(raw, note_id="n1", user_id="tim", elapsed_days=1)
        assert review.reviewed_at.year >= 2023  # 1.7e9 ms is late 2023
        assert review.rating == 3
        assert review.scheduled_days == 10
        assert review.elapsed_days == 1

    def test_negative_ivl_learning_step_floors_to_zero_scheduled_days(self):
        """A negative Anki ivl means seconds (a same-day step), not a day count —
        must never surface as a negative scheduled_days downstream."""
        raw = RawReview(id=1_700_100_000_000, card_id=101, ease=2, ivl=-600)
        review = transform_review(raw, note_id="n1", user_id="tim", elapsed_days=0)
        assert review.scheduled_days == 0


class TestComputeElapsedDays:
    def test_first_review_has_zero_elapsed_days(self):
        reviews = [RawReview(id=1_700_000_000_000, card_id=1, ease=3, ivl=1)]
        elapsed = compute_elapsed_days(reviews)
        assert elapsed[1_700_000_000_000] == 0

    def test_second_review_one_day_later_is_elapsed_one(self):
        one_day_ms = 86_400_000
        reviews = [
            RawReview(id=1_700_000_000_000, card_id=1, ease=3, ivl=1),
            RawReview(id=1_700_000_000_000 + one_day_ms, card_id=1, ease=3, ivl=3),
        ]
        elapsed = compute_elapsed_days(reviews)
        assert elapsed[1_700_000_000_000] == 0
        assert elapsed[1_700_000_000_000 + one_day_ms] == 1

    def test_reviews_same_day_elapse_zero_days(self):
        reviews = [
            RawReview(id=1_700_000_000_000, card_id=1, ease=2, ivl=0),
            RawReview(id=1_700_000_060_000, card_id=1, ease=3, ivl=1),  # 1 min later
        ]
        elapsed = compute_elapsed_days(reviews)
        assert elapsed[1_700_000_060_000] == 0


def _pronunciation_note_type():
    return NoteType(mid="pron-1", name="Capybara Pronunciation (shadowing)", field_names=PRONUNCIATION_FIELDS)


def _raw_pronunciation_note(**overrides):
    defaults = dict(
        id=1, guid="pron-guid-aaa", mid="pron-1",
        fields=["Доброго ранку", "[sound:x.mp3]", "Good morning", "uk-UA", "ранок", "src:1"],
        tags=[],
    )
    defaults.update(overrides)
    return RawNote(**defaults)


class TestTransformPronunciationNote:
    def test_recognized_pronunciation_note_transforms_cleanly(self):
        """D18's field mapping (docs/DESIGN.md §8, supabase/functions/pronounce/
        index.ts's own docstring): TargetText->lemma, Translation->lemma_translation,
        Hint->gloss, audio never populated (media excluded from every export)."""
        note, skip_reason = transform_pronunciation_note(_raw_pronunciation_note(), _pronunciation_note_type())
        assert skip_reason is None
        assert note.lemma == "Доброго ранку"
        assert note.lemma_translation == "Good morning"
        assert note.gloss == "ранок"
        assert note.language == "uk"
        assert note.audio_url is None
        assert note.kind == "pronunciation"
        assert note.has_spelling is False
        assert note.deck == "Pronunciation"

    def test_language_tag_is_normalized_to_its_primary_subtag(self):
        note, skip_reason = transform_pronunciation_note(
            _raw_pronunciation_note(fields=["x", "y", "z", "en-US", "h", "s"]), _pronunciation_note_type()
        )
        assert skip_reason is None
        assert note.language == "en"

    def test_empty_language_is_skipped_not_guessed(self):
        """The real export's actual failure mode (2026-09-16): 13 notes with an
        empty Language field and a garbled TargetText — stray test data, not real
        pronunciation content, and not safe to default to a language."""
        note, skip_reason = transform_pronunciation_note(
            _raw_pronunciation_note(fields=["junk", "", "junk", "", "", ""]), _pronunciation_note_type()
        )
        assert note is None
        assert "not a recognizable uk/en tag" in skip_reason

    def test_unrecognized_language_tag_is_skipped(self):
        note, skip_reason = transform_pronunciation_note(
            _raw_pronunciation_note(fields=["x", "y", "z", "fr-FR", "h", "s"]), _pronunciation_note_type()
        )
        assert note is None
        assert "not a recognizable uk/en tag" in skip_reason

    def test_note_type_name_is_irrelevant_to_recognition(self):
        """Same principle as transform_note: recognition is by field signature."""
        differently_named = NoteType(mid="p2", name="Something else entirely", field_names=PRONUNCIATION_FIELDS)
        note, skip_reason = transform_pronunciation_note(_raw_pronunciation_note(mid="p2"), differently_named)
        assert skip_reason is None
        assert note is not None

    def test_vocab_fields_are_not_recognized_as_pronunciation(self):
        vocab_type = NoteType(mid="v1", name="Capybara", field_names=EXPECTED_FIELDS)
        note, skip_reason = transform_pronunciation_note(_raw_pronunciation_note(mid="v1"), vocab_type)
        assert note is None
        assert "fields don't match" in skip_reason


class TestDeckResolution:
    """D17, resolved against a real export 2026-09-16: a Capybara+ note's two real
    Anki cards are told apart, and a note's own home deck is found, by where each
    card is actually filed — see transform.py's module comment above
    _SPELLING_DECK_NAME for why deck placement rather than template order."""

    def test_strip_deck_prefix_removes_a_matching_prefix(self):
        assert strip_deck_prefix("Capybara::Ukrainian", "Capybara::") == "Ukrainian"

    def test_strip_deck_prefix_leaves_a_non_matching_name_alone(self):
        """The real export's own edge case: 13 pronunciation notes filed straight
        in the bare "Capybara" deck, no "::" at all."""
        assert strip_deck_prefix("Capybara", "Capybara::") == "Capybara"

    def test_card_kind_for_spelling_deck_is_spelling(self):
        deck_names = {1: "Capybara::Ukrainian", 2: "Capybara::Spelling"}
        recall_card = RawCard(id=1, note_id=1, deck_id=1, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        spelling_card = RawCard(id=2, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        assert card_kind_for(recall_card, deck_names, "Capybara::") == "recall"
        assert card_kind_for(spelling_card, deck_names, "Capybara::") == "spelling"

    def test_resolve_vocab_deck_for_a_single_card_note(self):
        deck_names = {1: "Capybara::Grammar"}
        card = RawCard(id=1, note_id=1, deck_id=1, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        deck, has_spelling = resolve_vocab_deck([card], deck_names, "Capybara::")
        assert deck == "Grammar"
        assert has_spelling is False

    def test_resolve_vocab_deck_for_a_two_card_capybara_plus_note(self):
        """The real pattern found on the export: one card in the note's home deck,
        one in Spelling — has_spelling is true, and `deck` is the HOME deck, not
        Spelling, regardless of which of the two cards sorts first."""
        deck_names = {1: "Capybara::Ukrainian", 2: "Capybara::Spelling"}
        spelling_card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        recall_card = RawCard(id=2, note_id=1, deck_id=1, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        deck, has_spelling = resolve_vocab_deck([spelling_card, recall_card], deck_names, "Capybara::")
        assert deck == "Ukrainian"
        assert has_spelling is True

    def test_resolve_vocab_deck_falls_back_to_ukrainian_for_an_unresolvable_deck(self):
        deck, has_spelling = resolve_vocab_deck([], {}, "Capybara::")
        assert deck == "Ukrainian"
        assert has_spelling is False


class TestCardKindThreadedThroughCardStateAndReview:
    def test_transform_card_state_records_its_card_kind(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        state, _ = transform_card_state(
            card, note_id="n1", user_id="tim", collection_created_at=1_700_000_000, card_kind="spelling"
        )
        assert state.card_kind == "spelling"

    def test_transform_card_state_defaults_to_recall(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        state, _ = transform_card_state(card, note_id="n1", user_id="tim", collection_created_at=1_700_000_000)
        assert state.card_kind == "recall"

    def test_transform_review_records_its_card_kind(self):
        raw = RawReview(id=1_700_100_000_000, card_id=101, ease=3, ivl=10)
        review = transform_review(raw, note_id="n1", user_id="tim", elapsed_days=1, card_kind="spelling")
        assert review.card_kind == "spelling"


class TestLatestReviewTime:
    """CardState.last_review — not optional bookkeeping, see its docstring: without
    it, the app's own FSRS resume logic (src/review/mutations.ts's toFsrsCardState)
    treats a migrated card as brand new on its very next real review."""

    def test_no_revlog_is_none(self):
        assert latest_review_time([]) is None

    def test_single_review_is_its_own_timestamp(self):
        raw = RawReview(id=1_700_100_000_000, card_id=1, ease=3, ivl=10)
        result = latest_review_time([raw])
        assert result.timestamp() * 1000 == raw.id

    def test_picks_the_most_recent_review_regardless_of_list_order(self):
        earlier = RawReview(id=1_700_000_000_000, card_id=1, ease=2, ivl=1)
        later = RawReview(id=1_700_100_000_000, card_id=1, ease=3, ivl=10)
        assert latest_review_time([later, earlier]).timestamp() * 1000 == later.id

    def test_result_is_timezone_aware_utc(self):
        raw = RawReview(id=1_700_000_000_000, card_id=1, ease=3, ivl=1)
        assert latest_review_time([raw]).tzinfo == timezone.utc

    def test_transform_card_state_carries_last_review_through(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=2, queue=2, due=10, ivl=5,
                        reps=1, lapses=0, data={"s": 3.0, "d": 4.0})
        revlog = [RawReview(id=1_700_100_000_000, card_id=1, ease=3, ivl=10)]
        state, warnings = transform_card_state(
            card, note_id="n1", user_id="tim", collection_created_at=1_700_000_000,
            last_review=latest_review_time(revlog),
        )
        assert state.last_review is not None
        assert not any("last_review" in w for w in warnings)

    def test_non_new_card_with_no_revlog_warns(self):
        """A card can only be non-new in Anki because it was reviewed at least
        once — a missing revlog for one is worth flagging, not silently accepted."""
        card = RawCard(id=1, note_id=1, deck_id=2, type=2, queue=2, due=10, ivl=5,
                        reps=1, lapses=0, data={"s": 3.0, "d": 4.0})
        state, warnings = transform_card_state(
            card, note_id="n1", user_id="tim", collection_created_at=1_700_000_000, last_review=None
        )
        assert state.last_review is None
        assert any("no revlog rows found" in w for w in warnings)

    def test_new_card_with_no_revlog_does_not_warn(self):
        card = RawCard(id=1, note_id=1, deck_id=2, type=0, queue=0, due=0, ivl=0, reps=0, lapses=0, data={})
        _, warnings = transform_card_state(
            card, note_id="n1", user_id="tim", collection_created_at=1_700_000_000, last_review=None
        )
        assert warnings == []
