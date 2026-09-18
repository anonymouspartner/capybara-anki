import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { buildBuryMutation, buildReviewMutation, buildSuspendMutation, previewIntervals, validateNoteEdit } from "./mutations.ts";
import type { CardStateRow } from "./types.ts";

const PARAMS = { fsrsParams: [], desiredRetention: 0.9, maxInterval: 36500, learningSteps: [1, 10] };

function newCardState(overrides: Partial<CardStateRow> = {}): CardStateRow {
  return {
    noteId: "n1",
    cardKind: "recall",
    due: null,
    stability: null,
    difficulty: null,
    state: null,
    reps: 0,
    lapses: 0,
    lastReview: null,
    learningStep: 0,
    suspended: false,
    buriedOn: null,
    lastUserId: null,
    ...overrides,
  };
}

Deno.test("reviewing a never-studied note (no card_state row) produces a real state", () => {
  const { reviewRow, cardStateRow } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(reviewRow.elapsedDays, 0); // first-ever review of this card
  assertEquals(cardStateRow.reps, 1);
  assertEquals(cardStateRow.lastUserId, "tim");
  if (!(cardStateRow.stability! > 0)) throw new Error("expected real stability");
});

Deno.test("reviewing an already-suspended card does not unsuspend it", () => {
  const suspended = newCardState({ suspended: true });
  const { cardStateRow } = buildReviewMutation(
    suspended,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(cardStateRow.suspended, true);
});

Deno.test("reviewing a row that exists only because it was pre-emptively suspended works like a fresh card", () => {
  // Exactly the case types.ts's module docstring describes: a row with `suspended`
  // set and every FSRS field null, from suspending before ever studying it.
  const suspendedButNeverStudied = newCardState({ suspended: true });
  const { cardStateRow } = buildReviewMutation(
    suspendedButNeverStudied,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(cardStateRow.reps, 1); // treated as the card's first-ever review
});

Deno.test("elapsedDays on the review row reflects the gap since the prior review", () => {
  const firstReviewDate = new Date("2026-01-01T00:00:00Z");
  const { cardStateRow: afterFirst } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: firstReviewDate },
    PARAMS,
  );
  const secondReviewDate = new Date("2026-01-05T00:00:00Z");
  const { reviewRow: secondReviewRow } = buildReviewMutation(
    afterFirst,
    { reviewId: "r2", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: secondReviewDate },
    PARAMS,
  );
  assertEquals(secondReviewRow.elapsedDays, 4);
});

Deno.test("suspending a never-reviewed note creates a card_state row from nothing", () => {
  const result = buildSuspendMutation(null, "n1", "recall", true);
  assertEquals(result.suspended, true);
  assertEquals(result.noteId, "n1");
  assertEquals(result.stability, null); // still genuinely new — nothing invented
});

Deno.test("suspending an already-reviewed note leaves its FSRS state untouched", () => {
  const reviewed = newCardState({ stability: 8.5, difficulty: 5.2, reps: 3, state: 2 });
  const result = buildSuspendMutation(reviewed, "n1", "recall", true);
  assertEquals(result.suspended, true);
  assertEquals(result.stability, 8.5);
  assertEquals(result.reps, 3);
});

Deno.test("unsuspending is the same operation with the opposite boolean", () => {
  const suspended = newCardState({ suspended: true, stability: 8.5 });
  const result = buildSuspendMutation(suspended, "n1", "recall", false);
  assertEquals(result.suspended, false);
  assertEquals(result.stability, 8.5);
});

Deno.test("burying a never-reviewed note creates a card_state row from nothing", () => {
  const result = buildBuryMutation(null, "n1", "recall", "2026-09-16");
  assertEquals(result.buriedOn, "2026-09-16");
  assertEquals(result.noteId, "n1");
  assertEquals(result.stability, null); // still genuinely new — nothing invented
});

Deno.test("burying an already-reviewed note leaves its FSRS state untouched", () => {
  const reviewed = newCardState({ stability: 8.5, difficulty: 5.2, reps: 3, state: 2 });
  const result = buildBuryMutation(reviewed, "n1", "recall", "2026-09-16");
  assertEquals(result.buriedOn, "2026-09-16");
  assertEquals(result.stability, 8.5);
  assertEquals(result.reps, 3);
});

Deno.test("unburying is the same operation with null", () => {
  const buried = newCardState({ buriedOn: "2026-09-16", stability: 8.5 });
  const result = buildBuryMutation(buried, "n1", "recall", null);
  assertEquals(result.buriedOn, null);
  assertEquals(result.stability, 8.5);
});

Deno.test("bury and suspend are independent — burying leaves suspended exactly as it was", () => {
  const suspended = newCardState({ suspended: true });
  const result = buildBuryMutation(suspended, "n1", "recall", "2026-09-16");
  assertEquals(result.suspended, true);
  assertEquals(result.buriedOn, "2026-09-16");
});

Deno.test("bury siblings: answering a note's recall card buries its spelling card on today's key", () => {
  const { cardStateRow, siblingCardStateRow } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
    undefined,
    { current: null, noteId: "n1", cardKind: "spelling", buriedOn: "2026-01-01" },
  );
  assertEquals(cardStateRow.cardKind, "recall");
  assertEquals(cardStateRow.buriedOn, null, "the answered card itself is never buried by this");
  assertEquals(siblingCardStateRow?.cardKind, "spelling");
  assertEquals(siblingCardStateRow?.buriedOn, "2026-01-01");
});

Deno.test("bury siblings: preserves the sibling's own FSRS state — bury never resets scheduling", () => {
  const siblingCurrent = newCardState({ cardKind: "spelling", stability: 12, reps: 4, state: 2 });
  const { siblingCardStateRow } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
    undefined,
    { current: siblingCurrent, noteId: "n1", cardKind: "spelling", buriedOn: "2026-01-01" },
  );
  assertEquals(siblingCardStateRow?.stability, 12);
  assertEquals(siblingCardStateRow?.reps, 4);
  assertEquals(siblingCardStateRow?.buriedOn, "2026-01-01");
});

Deno.test("no sibling option, no sibling row — a note with one card leaves siblingCardStateRow undefined", () => {
  const { siblingCardStateRow } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", cardKind: "recall", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(siblingCardStateRow, undefined);
});

Deno.test("D17: a note's recall and spelling cards keep fully independent state", () => {
  const recallState = newCardState({ cardKind: "recall", stability: 20, reps: 5 });
  const { cardStateRow: spellingResult } = buildReviewMutation(
    null, // this note's spelling card has never been reviewed, even though recall has
    { reviewId: "r1", noteId: "n1", cardKind: "spelling", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(spellingResult.cardKind, "spelling");
  assertEquals(spellingResult.reps, 1); // spelling's own first review, unaffected by recall's history
  assertEquals(recallState.reps, 5); // untouched — a different row entirely
});

Deno.test("an empty lemma is rejected — a card needs something on its front", () => {
  const result = validateNoteEdit({ lemma: "   " });
  assertEquals(result.valid, false);
  assertNotEquals(result.errors.length, 0);
  assertEquals(result.patch, undefined);
});

Deno.test("an invalid language code is rejected", () => {
  // deno-lint-ignore no-explicit-any
  const result = validateNoteEdit({ language: "ru" as any });
  assertEquals(result.valid, false);
});

Deno.test("a real edit passes through untouched", () => {
  const result = validateNoteEdit({ lemma: "важкий", gloss: "hard" });
  assertEquals(result.valid, true);
  assertEquals(result.patch, { lemma: "важкий", gloss: "hard" });
});

Deno.test("editing a field this function doesn't validate (e.g. gloss alone) is never blocked by it", () => {
  const result = validateNoteEdit({ gloss: "" });
  assertEquals(result.valid, true);
});

Deno.test("previewIntervals: a harder rating never schedules sooner than an easier one", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const preview = previewIntervals(null, "note-1", "recall", now, PARAMS);
  // Again <= Hard <= Good <= Easy — the one invariant that has to hold regardless
  // of the exact FSRS weights, or the buttons would be lying about relative effort.
  if (!(preview.again.getTime() <= preview.hard.getTime())) throw new Error("Again should not outlast Hard");
  if (!(preview.hard.getTime() <= preview.good.getTime())) throw new Error("Hard should not outlast Good");
  if (!(preview.good.getTime() <= preview.easy.getTime())) throw new Error("Good should not outlast Easy");
});

Deno.test("previewIntervals: computing a preview never writes anything — same input, same output twice", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const reviewed = newCardState({
    stability: 8.5, difficulty: 5.2, state: 2, reps: 3,
    lastReview: new Date("2025-12-28T00:00:00Z"),
    due: new Date("2026-01-01T00:00:00Z"),
  });
  const first = previewIntervals(reviewed, "note-1", "recall", now, PARAMS);
  const second = previewIntervals(reviewed, "note-1", "recall", now, PARAMS);
  assertEquals(first, second);
  // And the input itself is untouched.
  assertEquals(reviewed.stability, 8.5);
});

Deno.test("previewIntervals: works on a genuinely new note (no card_state row at all)", () => {
  const preview = previewIntervals(null, "note-1", "recall", new Date("2026-01-01T00:00:00Z"), PARAMS);
  if (!(preview.good.getTime() > 0)) throw new Error("expected a real date for Good on a new card");
});

Deno.test("previewIntervals: a row with FSRS fields set but no lastReview is treated as new, not a crash", () => {
  // Shouldn't occur from buildReviewMutation (it always sets both together), but
  // this is exactly the shape a hand-built or corrupted row could have, and
  // ts-fsrs throws on a null date rather than treating it as "unknown" — this
  // guards that at the boundary instead of propagating the crash.
  const inconsistentRow = newCardState({ stability: 8.5, difficulty: 5.2, state: 2, reps: 3, lastReview: null });
  const preview = previewIntervals(inconsistentRow, "note-1", "recall", new Date("2026-01-01T00:00:00Z"), PARAMS);
  if (!(preview.good.getTime() > 0)) throw new Error("expected a real date, not a thrown error");
});

Deno.test("previewIntervals: the interval on the button is the one the answer actually schedules", () => {
  // Fuzz makes this worth asserting rather than assuming. ts-fsrs' own default
  // seed mixes in the review timestamp, so a preview rendered at 12:00:00 and an
  // answer submitted at 12:00:45 would fuzz differently and the card would land
  // somewhere other than the button promised. Seeding on (card, reps) instead —
  // the way Anki does — is what makes the two agree; this is the test that says
  // so out loud.
  const shownAt = new Date("2026-01-01T12:00:00Z");
  const answeredAt = new Date("2026-01-01T12:00:45Z"); // 45s later: a real pause
  const current = newCardState({
    stability: 12.5, difficulty: 5.4, state: 2, reps: 6,
    lastReview: new Date("2025-12-20T12:00:00Z"),
    due: shownAt,
  });

  const preview = previewIntervals(current, "n1", "recall", shownAt, PARAMS);

  for (const [rating, previewed] of [[1, preview.again], [2, preview.hard], [3, preview.good], [4, preview.easy]] as const) {
    const { cardStateRow } = buildReviewMutation(
      current,
      { reviewId: `r-${rating}`, noteId: "n1", cardKind: "recall", userId: "tim", rating, reviewedAt: answeredAt },
      PARAMS,
    );
    // Same scheduled length, offset only by the 45s the reader spent deciding.
    const previewedDays = Math.round((previewed.getTime() - shownAt.getTime()) / 86_400_000);
    const actualDays = Math.round((cardStateRow.due!.getTime() - answeredAt.getTime()) / 86_400_000);
    assertEquals(actualDays, previewedDays, `rating ${rating}: button said ${previewedDays}d, card got ${actualDays}d`);
  }
});

Deno.test("two different cards in identical states don't get the identical interval", () => {
  // Anki seeds fuzz per card, so a batch answered together spreads out instead of
  // stacking on one day. Identical state, different card identity, different day.
  const now = new Date("2026-01-01T12:00:00Z");
  const state = (noteId: string) =>
    newCardState({
      noteId, stability: 40, difficulty: 5.4, state: 2, reps: 9,
      lastReview: new Date("2025-11-20T12:00:00Z"), due: now,
    });

  const dueDates = new Set(
    Array.from({ length: 30 }, (_, i) => {
      const noteId = `n-${i}`;
      const { cardStateRow } = buildReviewMutation(
        state(noteId),
        { reviewId: `r-${i}`, noteId, cardKind: "recall", userId: "tim", rating: 3, reviewedAt: now },
        PARAMS,
      );
      return cardStateRow.due!.toISOString().slice(0, 10);
    }),
  );

  if (dueDates.size < 2) throw new Error("identical cards should not all land on one day once fuzz is seeded per card");
});

Deno.test("a note's recall and spelling cards fuzz independently (D17)", () => {
  // cardKind is part of the seed because it is part of the card's identity here —
  // otherwise a Capybara+ note's two cards would move in lockstep forever.
  const now = new Date("2026-01-01T12:00:00Z");
  const base = { stability: 40, difficulty: 5.4, state: 2 as const, reps: 9, lastReview: new Date("2025-11-20T12:00:00Z"), due: now };

  const due = (cardKind: "recall" | "spelling") =>
    buildReviewMutation(
      newCardState({ noteId: "n1", cardKind, ...base }),
      { reviewId: `r-${cardKind}`, noteId: "n1", cardKind, userId: "tim", rating: 3, reviewedAt: now },
      PARAMS,
    ).cardStateRow.due!.getTime();

  assertNotEquals(due("recall"), due("spelling"));
});

Deno.test("previewIntervals: rating order holds under fuzz, at every card maturity", () => {
  // Fuzz widens each rating's interval into a range, and the ranges for Good and
  // Easy sit close together on a mature card — close enough that a careless
  // implementation could show "Good 45d / Easy 43d". Anki guards this explicitly
  // (its answer_easy raises Easy's minimum above the fuzzed Good). This sweeps
  // real maturities against many seeds to confirm ts-fsrs holds the same line,
  // since the four buttons lying about relative effort is a visible bug.
  const now = new Date("2026-01-01T12:00:00Z");
  const maturities = [
    { stability: 2, difficulty: 4, reps: 1 },
    { stability: 8, difficulty: 5, reps: 3 },
    { stability: 40, difficulty: 5.5, reps: 8 },
    { stability: 150, difficulty: 6.5, reps: 15 },
    { stability: 400, difficulty: 7.5, reps: 25 },
  ];

  for (const m of maturities) {
    for (let i = 0; i < 100; i++) {
      const noteId = `n-${i}`;
      const row = newCardState({
        noteId, state: 2, ...m,
        lastReview: new Date("2025-12-01T12:00:00Z"),
        due: now,
      });
      const p = previewIntervals(row, noteId, "recall", now, PARAMS);
      const label = `stability=${m.stability} seed=${noteId}`;
      if (p.again.getTime() > p.hard.getTime()) throw new Error(`${label}: Again outlasted Hard`);
      if (p.hard.getTime() > p.good.getTime()) throw new Error(`${label}: Hard outlasted Good`);
      if (p.good.getTime() > p.easy.getTime()) throw new Error(`${label}: Good outlasted Easy`);
    }
  }
});
