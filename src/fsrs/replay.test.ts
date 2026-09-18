import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { applyReview, replayCardState } from "./replay.ts";
import type { FsrsSchedulerParams, ReviewEvent } from "./types.ts";

// Matches Tim's real, verified scheduler_config (docs/DESIGN.md §7.3) — an empty
// fsrsParams array is the actual state of the real collection, not a contrived edge
// case, so it's the default here rather than something bolted on as an afterthought.
// learningSteps: [1, 10] is likewise the real, verified value for both users — and
// happens to equal ts-fsrs's own built-in default (1m, 10m), so every existing
// assertion below is unaffected by learning_steps now actually being wired through.
const REAL_PARAMS: FsrsSchedulerParams = {
  fsrsParams: [],
  desiredRetention: 0.9,
  maxInterval: 36500,
  learningSteps: [1, 10],
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

Deno.test("learningStep is 0 on a fresh card and after graduating to Review", () => {
  const midLearning = applyReview(null, review("2026-01-01T12:00:00Z", 3), REAL_PARAMS);
  assertEquals(midLearning.state, 1); // Learning
  assertEquals(midLearning.learningStep, 1, "one of REAL_PARAMS.learningSteps' two steps completed");

  const graduated = applyReview(midLearning, { reviewedAt: midLearning.due, rating: 3 }, REAL_PARAMS);
  assertEquals(graduated.state, 2); // Review
  assertEquals(graduated.learningStep, 0, "resets once a card leaves Learning");
});

Deno.test("resuming a card mid-steps continues where it left off, not from step 0", () => {
  // The whole reason FsrsCardState carries learningStep at all (see its
  // docstring): replayCardState must reach the exact state applyReview reaches
  // one review at a time, same property the "replaying from scratch agrees..."
  // tests below assert for every other field. If learningStep didn't round-trip,
  // a card paused after its first Good (still on step 1 of 2) would look
  // indistinguishable from brand new on the next review, and get scheduled by
  // step 1 (10m) again instead of advancing to step 2 and graduating.
  const reviews = [review("2026-01-01T12:00:00Z", 3), review("2026-01-01T12:10:00Z", 3)];
  const replayed = replayCardState(reviews, REAL_PARAMS);
  const incremental = applyReview(
    applyReview(null, reviews[0], REAL_PARAMS),
    reviews[1],
    REAL_PARAMS,
  );
  if (replayed === null) throw new Error("expected a card state");
  assertEquals(replayed.state, incremental.state);
  assertEquals(replayed.learningStep, incremental.learningStep);
  assertEquals(replayed.state, 2, "two Goods through a two-step sequence graduates to Review");
});

Deno.test("learningSteps: [] is Anki's real 'no short-term steps' state — graduates immediately", () => {
  const params: FsrsSchedulerParams = { ...REAL_PARAMS, learningSteps: [] };
  const result = applyReview(null, review("2026-01-01T12:00:00Z", 3), params);
  assertEquals(result.state, 2, "a single Good with no learning steps goes straight to Review");
});

Deno.test("learningSteps: null falls back to ts-fsrs's own default, not to no-steps", () => {
  // null (never configured) and a real [] (Anki's own "FSRS manages it" value)
  // must not be conflated — conflating them would make every not-yet-migrated
  // user silently behave as if they'd deliberately turned learning steps off.
  const params: FsrsSchedulerParams = { ...REAL_PARAMS, learningSteps: null };
  const result = applyReview(null, review("2026-01-01T12:00:00Z", 3), params);
  assertEquals(result.state, 1, "ts-fsrs's built-in default steps (1m, 10m) still apply");
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
  // If anything non-reproducible leaked into scheduling, two runs of the exact
  // same history could disagree, which would quietly break every migration
  // re-run (D15) and every "replay to recover" story in §4.3. Fuzz is the obvious
  // candidate, so the seeded case below guards it specifically; this covers the
  // unseeded path, where fuzz is off entirely.
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

// ---------------------------------------------------------------------------
// Interval fuzz (imported from Anki — see replay.ts's buildScheduler)
// ---------------------------------------------------------------------------

Deno.test("fuzz stays deterministic — a seeded replay is still bit-identical every run", () => {
  // The whole reason fuzz can be enabled at all. Anki's fuzz is a seeded draw,
  // not a random one, so it is a pure function of the card and its rep count —
  // §4.3's "card_state is a fold over reviews" survives it. If this ever fails,
  // fuzz has to go back off; a card_state that can't be rebuilt from its reviews
  // is not a cache any more.
  const reviews = [
    review("2026-01-01T00:00:00Z", 3),
    review("2026-01-05T00:00:00Z", 2),
    review("2026-01-09T00:00:00Z", 4),
    review("2026-02-02T00:00:00Z", 3),
  ];
  const first = replayCardState(reviews, REAL_PARAMS, "note-abc|recall");
  const second = replayCardState(reviews, REAL_PARAMS, "note-abc|recall");
  assertEquals(first, second);
});

Deno.test("replaying from scratch agrees with applying one at a time — with fuzz on too", () => {
  // Same property as the unseeded test above, re-asserted for the seeded path:
  // the seed depends on the card's rep count, which advances as the replay runs,
  // so incremental and from-scratch have to walk the identical seed sequence.
  const seed = "note-abc|recall";
  const reviews = [
    review("2026-01-01T00:00:00Z", 3),
    review("2026-01-05T00:00:00Z", 3),
    review("2026-01-30T00:00:00Z", 1),
    review("2026-02-01T00:00:00Z", 3),
  ];

  let incremental = null;
  for (const r of reviews) {
    incremental = applyReview(incremental, r, REAL_PARAMS, seed);
  }

  assertEquals(replayCardState(reviews, REAL_PARAMS, seed), incremental);
});

Deno.test("fuzz spreads cards answered together across different days", () => {
  // The reason this was imported at all. Without fuzz every card graduating on
  // the same rating gets the identical interval, so a session's worth of new
  // cards comes back as one lump on one day, then again, and again. Measured
  // before the change: 40 cards learned in one sitting all landed on a single
  // day. Seeding per card is what breaks up the lump.
  // Three Goods, not two: FSRS-6's defaults graduate a card in REAL_PARAMS's
  // {1m, 10m} steps to a 2.0-day first review interval, and Anki's own fuzz
  // ranges (see the next test) don't touch anything under 2.5 days at all — so a
  // graduation-only scenario landed inside the "correctly never fuzzed" range and
  // would fail for the wrong reason. One more Good clears it (verified directly:
  // 11 days), which is what this test actually needs to exercise fuzz at all.
  const learn = (seed: string | undefined) => {
    let state = applyReview(null, review("2026-01-01T12:00:00Z", 3), REAL_PARAMS, seed);
    state = applyReview(state, { reviewedAt: state.due, rating: 3 }, REAL_PARAMS, seed);
    state = applyReview(state, { reviewedAt: state.due, rating: 3 }, REAL_PARAMS, seed);
    return state.due.toISOString().slice(0, 10);
  };

  const unfuzzed = new Set(Array.from({ length: 40 }, () => learn(undefined)));
  assertEquals(unfuzzed.size, 1, "without a seed, every card should land on the same day");

  const fuzzed = new Set(Array.from({ length: 40 }, (_, i) => learn(`note-${i}|recall`)));
  if (fuzzed.size < 2) {
    throw new Error(`expected seeded cards to spread over several days, got ${fuzzed.size}`);
  }
});

Deno.test("fuzz never moves a card outside Anki's own fuzz range for that interval", () => {
  // Anki's ranges, read off rslib/src/scheduler/states/fuzz.rs: nothing under
  // 2.5 days is fuzzed at all, and above that the spread is 1 day plus 0.15/day
  // between 2.5-7, 0.1/day between 7-20, 0.05/day beyond. A seed that pushed a
  // card outside that would mean ts-fsrs and Anki had diverged on the algorithm.
  const unfuzzed = applyReview(null, review("2026-01-01T12:00:00Z", 4), REAL_PARAMS);
  const baselineDays = Math.round(
    (unfuzzed.due.getTime() - new Date("2026-01-01T12:00:00Z").getTime()) / 86_400_000,
  );
  // 1 day + 0.15*(7-2.5) + 0.1*(20-7) + 0.05*(baseline-20), per the ranges above.
  const delta = 1 + 0.15 * (Math.min(baselineDays, 7) - 2.5) +
    0.1 * Math.max(Math.min(baselineDays, 20) - 7, 0) +
    0.05 * Math.max(baselineDays - 20, 0);

  for (let i = 0; i < 200; i++) {
    const state = applyReview(null, review("2026-01-01T12:00:00Z", 4), REAL_PARAMS, `note-${i}|recall`);
    const days = Math.round((state.due.getTime() - new Date("2026-01-01T12:00:00Z").getTime()) / 86_400_000);
    if (days < Math.round(baselineDays - delta) || days > Math.round(baselineDays + delta)) {
      throw new Error(
        `seed note-${i} scheduled ${days}d, outside Anki's fuzz range ` +
          `[${Math.round(baselineDays - delta)}, ${Math.round(baselineDays + delta)}] around ${baselineDays}d`,
      );
    }
  }
});
