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

Deno.test("learning cards come before everything else", () => {
  // New cards are interspersed among reviews rather than appended after them (see
  // the interspersing tests below); with one of each there is only one way to
  // order them, so this test stays about the learning card jumping the queue.
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

// ---------------------------------------------------------------------------
// New/review interspersing — Anki's default new_mix (MixWithReviews)
// ---------------------------------------------------------------------------

Deno.test("new cards are spread through the reviews, not stacked after them", () => {
  const reviews = Array.from({ length: 8 }, (_, i) =>
    candidate({ noteId: `review-${i}`, state: 2, due: new Date(YESTERDAY.getTime() + i * 1000) }));
  const news = Array.from({ length: 3 }, (_, i) => candidate({ noteId: `new-${i}`, state: null }));

  const result = noteIds(selectDueQueue([...reviews, ...news], GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW));

  // Exactly Anki's own intersperser, whose test for 3-into-8 asserts this shape:
  // two from the longer list, then one from the shorter, evenly to the end.
  assertEquals(result, [
    "review-0", "review-1", "new-0",
    "review-2", "review-3", "new-1",
    "review-4", "review-5", "new-2",
    "review-6", "review-7",
  ]);
});

Deno.test("with more new cards than reviews, the new cards carry the queue and reviews are spread through them", () => {
  const reviews = Array.from({ length: 2 }, (_, i) =>
    candidate({ noteId: `review-${i}`, state: 2, due: new Date(YESTERDAY.getTime() + i * 1000) }));
  const news = Array.from({ length: 6 }, (_, i) => candidate({ noteId: `new-${i}`, state: null }));

  const result = noteIds(selectDueQueue([...reviews, ...news], GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW));

  assertEquals(result.length, 8);
  // Anki always draws from the longer list first, so a new card opens the session.
  assertEquals(result[0], "new-0");
  // And no three consecutive cards are all reviews or all new — that's the point.
  assertEquals(result.filter((id) => id.startsWith("new-")).length, 6);
});

Deno.test("interspersing never drops or duplicates a card", () => {
  const reviews = Array.from({ length: 7 }, (_, i) =>
    candidate({ noteId: `review-${i}`, state: 2, due: new Date(YESTERDAY.getTime() + i * 1000) }));
  const news = Array.from({ length: 5 }, (_, i) => candidate({ noteId: `new-${i}`, state: null }));

  const result = noteIds(selectDueQueue([...reviews, ...news], GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW));

  assertEquals(result.length, 12);
  assertEquals(new Set(result).size, 12);
});

Deno.test("interspersing preserves oldest-due-first among the reviews themselves", () => {
  // Mixing changes where new cards sit, never the relative order of the reviews.
  const reviews = [
    candidate({ noteId: "newest", state: 2, due: new Date("2026-09-16T11:00:00Z") }),
    candidate({ noteId: "oldest", state: 2, due: new Date("2026-09-10T12:00:00Z") }),
    candidate({ noteId: "middle", state: 2, due: new Date("2026-09-14T12:00:00Z") }),
  ];
  const result = noteIds(selectDueQueue(
    [...reviews, candidate({ noteId: "new-0", state: null })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  ));

  assertEquals(result.filter((id) => id !== "new-0"), ["oldest", "middle", "newest"]);
});

Deno.test("the daily new limit still caps how many new cards get mixed in", () => {
  const reviews = Array.from({ length: 5 }, (_, i) =>
    candidate({ noteId: `review-${i}`, state: 2, due: new Date(YESTERDAY.getTime() + i * 1000) }));
  const news = Array.from({ length: 10 }, (_, i) => candidate({ noteId: `new-${i}`, state: null }));

  const result = noteIds(selectDueQueue(
    [...reviews, ...news],
    { dailyNewLimit: 2, dailyReviewLimit: 100 },
    NO_LIMITS_TAKEN,
    NOW,
  ));

  assertEquals(result.filter((id) => id.startsWith("new-")).length, 2);
  assertEquals(result.length, 7);
});

// ---------------------------------------------------------------------------
// Learn-ahead — Anki's learn_ahead_secs, default 20 minutes
// ---------------------------------------------------------------------------

Deno.test("a learning card due in a few minutes is offered once nothing else is left", () => {
  const inFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);
  const result = noteIds(selectDueQueue(
    [
      candidate({ noteId: "learning-soon", state: 1, due: inFiveMinutes }),
      candidate({ noteId: "review-due", state: 2, due: YESTERDAY }),
    ],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  ));
  // Behind the genuinely-due card: learn-ahead is a fallback, not a queue-jump.
  assertEquals(result, ["review-due", "learning-soon"]);
});

Deno.test("a learning card due beyond the 20-minute window is not offered early", () => {
  const inHalfAnHour = new Date(NOW.getTime() + 30 * 60_000);
  const result = selectDueQueue(
    [candidate({ noteId: "learning-later", state: 1, due: inHalfAnHour })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("learn-ahead applies to relearning cards too, not just first-time learning", () => {
  const inTenMinutes = new Date(NOW.getTime() + 10 * 60_000);
  const result = noteIds(selectDueQueue(
    [candidate({ noteId: "relearning-soon", state: 3, due: inTenMinutes })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  ));
  assertEquals(result, ["relearning-soon"]);
});

Deno.test("a review card due in a few minutes is still not offered early — learn-ahead is learning-only", () => {
  const inFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);
  const result = selectDueQueue(
    [candidate({ noteId: "review-soon", state: 2, due: inFiveMinutes })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("a suspended learning card is not resurrected by learn-ahead", () => {
  const inFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);
  const result = selectDueQueue(
    [candidate({ noteId: "learning-soon", state: 1, due: inFiveMinutes, suspended: true })],
    GENEROUS_LIMITS,
    NO_LIMITS_TAKEN,
    NOW,
  );
  assertEquals(result, []);
});

Deno.test("the deck summary counts a learn-ahead card, so the row agrees with what pressing in offers", () => {
  const inFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);
  const candidates = [candidate({ noteId: "learning-soon", state: 1, due: inFiveMinutes })];

  const summary = summarizeDueQueue(candidates, GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW);
  assertEquals(summary, { learningCount: 1, reviewCount: 0, newCount: 0 });
  // The invariant this file has always held: the counts match the queue's length.
  assertEquals(selectDueQueue(candidates, GENEROUS_LIMITS, NO_LIMITS_TAKEN, NOW).length, 1);
});
