import { assertEquals } from "jsr:@std/assert@^1";
import { selectDueQueue, summarizeDueQueue } from "./dueQueue.ts";
import type { DueCandidate } from "./types.ts";

const NOW = new Date("2026-09-16T12:00:00Z");
const YESTERDAY = new Date("2026-09-15T12:00:00Z");
const TOMORROW = new Date("2026-09-17T12:00:00Z");
const NO_LIMITS_TAKEN = { newTakenToday: 0, reviewTakenToday: 0 };
const GENEROUS_LIMITS = { dailyNewLimit: 100, dailyReviewLimit: 100 };

function candidate(overrides: Partial<DueCandidate>): DueCandidate {
  return { noteId: "n1", cardKind: "recall", due: null, state: null, suspended: false, ...overrides };
}

/** Most tests here only care about which notes came back and in what order —
 * `cardKind` gets its own dedicated test below (D17). */
function noteIds(result: { noteId: string }[]): string[] {
  return result.map((r) => r.noteId);
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
  assertEquals(noteIds(result), ["learning-1", "review-1", "new-1"]);
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
  assertEquals(noteIds(result), ["relearning-1", "review-1"]);
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
  assertEquals(noteIds(result), ["more-overdue", "less-overdue"]);
});

Deno.test("a card with no card_state row at all (state null) counts as new", () => {
  const result = selectDueQueue(
    [candidate({ noteId: "n1", state: null, due: null })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(noteIds(result), ["n1"]);
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
  assertEquals(result[0].noteId, "learning-1");
});

Deno.test("D17: a note with a recall and a spelling candidate can appear twice, once per cardKind", () => {
  const result = selectDueQueue(
    [
      candidate({ noteId: "n1", cardKind: "recall", state: null }),
      candidate({ noteId: "n1", cardKind: "spelling", state: null }),
    ],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result.length, 2);
  assertEquals(new Set(result.map((r) => r.cardKind)), new Set(["recall", "spelling"]));
  assertEquals(result.every((r) => r.noteId === "n1"), true);
});

Deno.test("summarizeDueQueue: counts match what selectDueQueue would actually offer", () => {
  const candidates = [
    candidate({ noteId: "learning-1", state: 1, due: YESTERDAY }),
    candidate({ noteId: "review-1", state: 2, due: YESTERDAY }),
    candidate({ noteId: "review-2", state: 2, due: TOMORROW }), // not due yet
    candidate({ noteId: "new-1", state: null }),
    candidate({ noteId: "new-2", state: null }),
    candidate({ noteId: "suspended-1", state: 2, due: YESTERDAY, suspended: true }),
  ];
  const summary = summarizeDueQueue(candidates, GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW);
  const queue = selectDueQueue(candidates, GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW);

  assertEquals(summary, { learningCount: 1, reviewCount: 1, newCount: 2 });
  assertEquals(queue.length, summary.learningCount + summary.reviewCount + summary.newCount);
});

Deno.test("summarizeDueQueue: respects the same daily limits selectDueQueue does", () => {
  const summary = summarizeDueQueue(
    [candidate({ noteId: "new-1", state: null }), candidate({ noteId: "new-2", state: null })],
    { dailyNewLimit: 1, dailyReviewLimit: 100 },
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(summary.newCount, 1);
});
