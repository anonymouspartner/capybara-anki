import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { applyReview, replayCardState } from "./replay.ts";
import type { FsrsSchedulerParams, ReviewEvent } from "./types.ts";

// Matches Tim's real, verified scheduler_config (docs/DESIGN.md §7.3) — an empty
// fsrsParams array is the actual state of the real collection, not a contrived edge
// case, so it's the default here rather than something bolted on as an afterthought.
const REAL_PARAMS: FsrsSchedulerParams = {
  fsrsParams: [],
  desiredRetention: 0.9,
  maxInterval: 36500,
};

function review(reviewedAt: string, rating: ReviewEvent["rating"]): ReviewEvent {
  return { reviewedAt: new Date(reviewedAt), rating };
}

Deno.test("no reviews produces no card state — a new note has no row yet", () => {
  const result = replayCardState([], REAL_PARAMS);
  assertEquals(result, null);
});

Deno.test("a single review produces a real, populated state", () => {
  const result = replayCardState([review("2026-01-01T00:00:00Z", 3)], REAL_PARAMS);
  if (result === null) throw new Error("expected a card state");
  assertEquals(result.reps, 1);
  assertEquals(result.lapses, 0);
  if (!(result.stability > 0)) throw new Error(`expected stability > 0, got ${result.stability}`);
});

Deno.test("an empty fsrsParams array works — Anki's 'no personalized weights yet' state", () => {
  // The whole point of REAL_PARAMS.fsrsParams being [] here: this must not throw,
  // and must not silently produce a zeroed-out, meaningless card. ts-fsrs auto-fills
  // to its built-in defaults — confirmed by hand against the installed version
  // before this module was written; this test is what keeps that confirmed.
  const result = replayCardState([review("2026-01-01T00:00:00Z", 3)], REAL_PARAMS);
  if (result === null) throw new Error("expected a card state");
  if (!(result.stability > 0)) {
    throw new Error(`expected empty fsrsParams to still fall back to real defaults, got stability=${result.stability}`);
  }
});

Deno.test("a lapse (Again) increments lapses and moves the card to Relearning", () => {
  const reviews = [
    review("2026-01-01T00:00:00Z", 3), // Good
    review("2026-01-05T00:00:00Z", 3), // Good
    review("2026-01-20T00:00:00Z", 1), // Again — a lapse
  ];
  const result = replayCardState(reviews, REAL_PARAMS);
  if (result === null) throw new Error("expected a card state");
  assertEquals(result.lapses, 1);
  assertEquals(result.state, 3); // Relearning
  assertEquals(result.reps, 3);
});

Deno.test("replaying from scratch agrees with applying reviews one at a time", () => {
  // This is §4.3's actual claim under test: card_state is a fold over reviews, so
  // rebuilding it from nothing must reach the exact same place as advancing it
  // incrementally, review by review, the way a live ingest path would. If these
  // ever disagree, the "delete card_state and replay to recover" safety property
  // in docs/DESIGN.md §4.3 is false.
  const reviews = [
    review("2026-01-01T00:00:00Z", 3),
    review("2026-01-05T00:00:00Z", 3),
    review("2026-01-20T00:00:00Z", 1),
    review("2026-01-21T00:00:00Z", 3),
    review("2026-02-10T00:00:00Z", 4),
  ];

  const replayed = replayCardState(reviews, REAL_PARAMS);

  let incremental = null;
  for (const r of reviews) {
    incremental = applyReview(incremental, r, REAL_PARAMS);
  }

  assertEquals(replayed, incremental);
});

Deno.test("input order doesn't matter — replay sorts by reviewedAt itself", () => {
  const inOrder = [
    review("2026-01-01T00:00:00Z", 3),
    review("2026-01-05T00:00:00Z", 3),
    review("2026-01-20T00:00:00Z", 1),
  ];
  const shuffled = [inOrder[2], inOrder[0], inOrder[1]];

  assertEquals(replayCardState(inOrder, REAL_PARAMS), replayCardState(shuffled, REAL_PARAMS));
});

Deno.test("replay is deterministic — same log in, bit-identical state out, every time", () => {
  // Guards enable_fuzz: false specifically. FSRS fuzz exists to spread real
  // reviews across a study session; if it leaked into replay, two runs of the
  // exact same history could disagree, which would quietly break every migration
  // re-run (D15) and every "replay to recover" story in §4.3.
  const reviews = [
    review("2026-01-01T00:00:00Z", 3),
    review("2026-01-05T00:00:00Z", 2),
    review("2026-01-09T00:00:00Z", 4),
  ];
  const first = replayCardState(reviews, REAL_PARAMS);
  const second = replayCardState(reviews, REAL_PARAMS);
  assertEquals(first, second);
});

Deno.test("different scheduler params produce different state — params are not ignored", () => {
  const reviews = [review("2026-01-01T00:00:00Z", 3), review("2026-01-05T00:00:00Z", 3)];
  const low = replayCardState(reviews, { ...REAL_PARAMS, desiredRetention: 0.7 });
  const high = replayCardState(reviews, { ...REAL_PARAMS, desiredRetention: 0.97 });
  assertNotEquals(low, high);
});
