import { assertEquals } from "jsr:@std/assert@^1";
import { selectDueQueue } from "./dueQueue.ts";
import type { DueCandidate } from "./types.ts";

const NOW = new Date("2026-09-16T12:00:00Z");
const YESTERDAY = new Date("2026-09-15T12:00:00Z");
const TOMORROW = new Date("2026-09-17T12:00:00Z");
const NO_LIMITS_TAKEN = { newTakenToday: 0, reviewTakenToday: 0 };
const GENEROUS_LIMITS = { dailyNewLimit: 100, dailyReviewLimit: 100 };

function candidate(overrides: Partial<DueCandidate>): DueCandidate {
  return { noteId: "n1", due: null, state: null, suspended: false, ...overrides };
}

Deno.test("a suspended card never appears, however overdue", () => {
  const result = selectDueQueue(
    [candidate({ noteId: "n1", state: 2, due: YESTERDAY, suspended: true })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("a review card due tomorrow does not show up today just because the queue is thin", () => {
  const result = selectDueQueue(
    [candidate({ noteId: "n1", state: 2, due: TOMORROW })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("learning cards come before review cards, both before new", () => {
  const result = selectDueQueue(
    [
      candidate({ noteId: "new-1", state: null }),
      candidate({ noteId: "review-1", state: 2, due: YESTERDAY }),
      candidate({ noteId: "learning-1", state: 1, due: YESTERDAY }),
    ],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, ["learning-1", "review-1", "new-1"]);
});

Deno.test("relearning cards (state 3) are treated the same as learning (state 1)", () => {
  const result = selectDueQueue(
    [
      candidate({ noteId: "review-1", state: 2, due: YESTERDAY }),
      candidate({ noteId: "relearning-1", state: 3, due: YESTERDAY }),
    ],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, ["relearning-1", "review-1"]);
});

Deno.test("review cards come back oldest-due-first", () => {
  const twoDaysAgo = new Date("2026-09-14T12:00:00Z");
  const result = selectDueQueue(
    [
      candidate({ noteId: "less-overdue", state: 2, due: YESTERDAY }),
      candidate({ noteId: "more-overdue", state: 2, due: twoDaysAgo }),
    ],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, ["more-overdue", "less-overdue"]);
});

Deno.test("a card with no card_state row at all (state null) counts as new", () => {
  const result = selectDueQueue(
    [candidate({ noteId: "n1", state: null, due: null })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, ["n1"]);
});

Deno.test("daily new limit caps how many new cards appear, once today's count is included", () => {
  const result = selectDueQueue(
    [
      candidate({ noteId: "new-1", state: null }),
      candidate({ noteId: "new-2", state: null }),
      candidate({ noteId: "new-3", state: null }),
    ],
    { dailyNewLimit: 2, dailyReviewLimit: 100 },
    { newTakenToday: 1, reviewTakenToday: 0 },
    NOW,
  );
  assertEquals(result.length, 1);
});

Deno.test("hitting the daily new limit already today shows zero new cards, not negative slots", () => {
  const result = selectDueQueue(
    [candidate({ noteId: "new-1", state: null })],
    { dailyNewLimit: 5, dailyReviewLimit: 100 },
    { newTakenToday: 9, reviewTakenToday: 0 },
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("daily review limit caps overdue review cards but never touches learning cards", () => {
  const result = selectDueQueue(
    [
      candidate({ noteId: "review-1", state: 2, due: YESTERDAY }),
      candidate({ noteId: "review-2", state: 2, due: YESTERDAY }),
      candidate({ noteId: "learning-1", state: 1, due: YESTERDAY }),
    ],
    { dailyNewLimit: 100, dailyReviewLimit: 1 },
    NO_LIMITS_TAKEN,
    NOW,
  );
  // Learning is never rate-limited (see dueQueue.ts's module docstring); only one
  // of the two review-state cards fits inside dailyReviewLimit: 1.
  assertEquals(result.length, 2);
  assertEquals(result[0], "learning-1");
});
