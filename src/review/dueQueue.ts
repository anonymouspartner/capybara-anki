/**
 * Which notes are due for review, right now, for one person.
 *
 * This is a real design decision, not a port of Anki's own queue algorithm — Anki's
 * v3 scheduler's gather/interleave behavior is genuinely complex (separate "gather
 * order" and "review order" settings, configurable new/review mixing), and nothing
 * in docs/DESIGN.md commits to reproducing it. The policy here is deliberately
 * simple and stated plainly so it can be changed later without touching the data
 * model at all — `selectDueQueue` only reads `DueCandidate`/`QueueLimits`/
 * `DailyCounts`, all already-public shapes:
 *
 *   1. Learning/relearning cards due now (state 1 or 3) — these are mid-relearning
 *      short-interval steps; leaving them mixed in with everything else would let a
 *      card that's supposed to come back in ten minutes get buried for a day.
 *   2. Review cards due now (state 2), oldest-due-first — the most overdue card is
 *      the one most at risk of being forgotten.
 *   3. New cards (no card_state row, or a row with `state` null), up to whatever
 *      of the day's `dailyNewLimit` isn't already used.
 *
 * All three respect `suspended` (excluded outright) and "due now" (a card due
 * tomorrow doesn't show up early just because the queue is thin today).
 */

import type { DailyCounts, DueCandidate, QueueLimits } from "./types.ts";

export function selectDueQueue(
  candidates: DueCandidate[],
  limits: QueueLimits,
  counts: DailyCounts,
  now: Date,
): string[] {
  const eligible = candidates.filter((c) => !c.suspended);

  const isDueNow = (c: DueCandidate) => c.due !== null && c.due.getTime() <= now.getTime();

  const learning = eligible
    .filter((c) => (c.state === 1 || c.state === 3) && isDueNow(c))
    .sort(byDueAscending);

  const review = eligible
    .filter((c) => c.state === 2 && isDueNow(c))
    .sort(byDueAscending);

  const remainingReviewSlots = Math.max(limits.dailyReviewLimit - counts.reviewTakenToday, 0);
  const reviewTaken = review.slice(0, remainingReviewSlots);

  const remainingNewSlots = Math.max(limits.dailyNewLimit - counts.newTakenToday, 0);
  const newCards = eligible
    .filter((c) => c.state === null || c.state === 0)
    .slice(0, remainingNewSlots);

  return [...learning, ...reviewTaken, ...newCards].map((c) => c.noteId);
}

function byDueAscending(a: DueCandidate, b: DueCandidate): number {
  // Both are known non-null here — only ever called on the isDueNow-filtered arrays.
  return (a.due as Date).getTime() - (b.due as Date).getTime();
}
