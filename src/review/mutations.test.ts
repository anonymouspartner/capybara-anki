import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { buildReviewMutation, buildSuspendMutation, validateNoteEdit } from "./mutations.ts";
import type { CardStateRow } from "./types.ts";

const PARAMS = { fsrsParams: [], desiredRetention: 0.9, maxInterval: 36500 };

function newCardState(overrides: Partial<CardStateRow> = {}): CardStateRow {
  return {
    noteId: "n1",
    due: null,
    stability: null,
    difficulty: null,
    state: null,
    reps: 0,
    lapses: 0,
    lastReview: null,
    suspended: false,
    lastUserId: null,
    ...overrides,
  };
}

Deno.test("reviewing a never-studied note (no card_state row) produces a real state", () => {
  const { reviewRow, cardStateRow } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
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
    { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
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
    { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: new Date("2026-01-01T00:00:00Z") },
    PARAMS,
  );
  assertEquals(cardStateRow.reps, 1); // treated as the card's first-ever review
});

Deno.test("elapsedDays on the review row reflects the gap since the prior review", () => {
  const firstReviewDate = new Date("2026-01-01T00:00:00Z");
  const { cardStateRow: afterFirst } = buildReviewMutation(
    null,
    { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: firstReviewDate },
    PARAMS,
  );
  const secondReviewDate = new Date("2026-01-05T00:00:00Z");
  const { reviewRow: secondReviewRow } = buildReviewMutation(
    afterFirst,
    { reviewId: "r2", noteId: "n1", userId: "tim", rating: 3, reviewedAt: secondReviewDate },
    PARAMS,
  );
  assertEquals(secondReviewRow.elapsedDays, 4);
});

Deno.test("suspending a never-reviewed note creates a card_state row from nothing", () => {
  const result = buildSuspendMutation(null, "n1", true);
  assertEquals(result.suspended, true);
  assertEquals(result.noteId, "n1");
  assertEquals(result.stability, null); // still genuinely new — nothing invented
});

Deno.test("suspending an already-reviewed note leaves its FSRS state untouched", () => {
  const reviewed = newCardState({ stability: 8.5, difficulty: 5.2, reps: 3, state: 2 });
  const result = buildSuspendMutation(reviewed, "n1", true);
  assertEquals(result.suspended, true);
  assertEquals(result.stability, 8.5);
  assertEquals(result.reps, 3);
});

Deno.test("unsuspending is the same operation with the opposite boolean", () => {
  const suspended = newCardState({ suspended: true, stability: 8.5 });
  const result = buildSuspendMutation(suspended, "n1", false);
  assertEquals(result.suspended, false);
  assertEquals(result.stability, 8.5);
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
