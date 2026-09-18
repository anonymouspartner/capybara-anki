/**
 * Which cards are due for review, right now, for one person. "Card" here means
 * `(noteId, cardKind)` (D17) — almost always one card per note, except a
 * `Capybara+` note's real second `Spelling` card, scheduled independently.
 *
 * Not a full port of Anki's v3 scheduler — its gather/review-order settings are
 * genuinely complex and nothing in docs/DESIGN.md commits to reproducing them.
 * What it does now match is the part a reviewer actually feels, taken from
 * Anki's own defaults (rslib/src/deckconfig/mod.rs, rslib/src/scheduler/queue/):
 *
 *   1. Learning/relearning cards due now (state 1 or 3) — these are mid-relearning
 *      short-interval steps; leaving them mixed in with everything else would let a
 *      card that's supposed to come back in ten minutes get buried for a day.
 *   2. Review cards due now (state 2), oldest-due-first — the most overdue card is
 *      the one most at risk of being forgotten — with new cards (no card_state row,
 *      or a row with `state` null) *interspersed evenly among them*, up to whatever
 *      of the day's `dailyNewLimit` isn't already used. That interleaving is Anki's
 *      default (`new_mix: MixWithReviews`), and the reason this file stopped simply
 *      appending new cards last: with a real backlog, "last" means a new word is
 *      only ever reached on a day the whole review queue gets cleared.
 *   3. Learning cards due within the next `LEARN_AHEAD_MS`, once everything above
 *      is exhausted — Anki's `learn_ahead_secs`, default 1200.
 *
 * All of it respects `suspended` and `buried` (both excluded outright — see
 * `DueCandidate.buried`'s docstring for why a bury's expiry is never this
 * file's problem) and "due now" (a card due tomorrow doesn't show up early just
 * because the queue is thin today) — step 3 being the one deliberate, bounded
 * exception Anki itself makes.
 *
 * `selectDueQueue` (an ordered id list, for reviewing) and `summarizeDueQueue` (bucket
 * counts, for a deck-list screen) share the same categorization on purpose — a deck
 * row showing "3 new, 1 due" has to agree with what pressing into that deck actually
 * offers, or the two would drift apart the first time this policy changes.
 */

import type { DailyCounts, DueCandidate, DueItem, QueueLimits, QueueSummary } from "./types.ts";

/** Anki's `learn_ahead_secs` default, 20 minutes (rslib/src/config/mod.rs). A
 * learning card due inside this window is offered once the rest of the queue is
 * empty, rather than being told there's nothing left to study while a card is two
 * minutes from coming back. */
const LEARN_AHEAD_MS = 1_200_000;

interface Categorized {
  learning: DueCandidate[];
  review: DueCandidate[];
  newCards: DueCandidate[];
  /** Learning cards not due yet but within `LEARN_AHEAD_MS`. Counted separately
   * from `learning` because they're only reachable after everything else. */
  learnAhead: DueCandidate[];
}

function categorize(
  candidates: DueCandidate[],
  limits: QueueLimits,
  counts: DailyCounts,
  now: Date,
): Categorized {
  const eligible = candidates.filter((c) => !c.suspended && !c.buried);
  const isDueNow = (c: DueCandidate) => c.due !== null && c.due.getTime() <= now.getTime();
  const isLearning = (c: DueCandidate) => c.state === 1 || c.state === 3;

  const learning = eligible
    .filter((c) => isLearning(c) && isDueNow(c))
    .sort(byDueAscending);

  const learnAhead = eligible
    .filter((c) =>
      isLearning(c) && !isDueNow(c) &&
      c.due !== null && c.due.getTime() <= now.getTime() + LEARN_AHEAD_MS
    )
    .sort(byDueAscending);

  const review = eligible
    .filter((c) => c.state === 2 && isDueNow(c))
    .sort(byDueAscending);
  const remainingReviewSlots = Math.max(limits.dailyReviewLimit - counts.reviewTakenToday, 0);

  const remainingNewSlots = Math.max(limits.dailyNewLimit - counts.newTakenToday, 0);
  const newCards = eligible.filter((c) => c.state === null || c.state === 0);

  return {
    learning,
    review: review.slice(0, remainingReviewSlots),
    newCards: newCards.slice(0, remainingNewSlots),
    learnAhead,
  };
}

/**
 * Anki's `Intersperser` (rslib/src/scheduler/queue/builder/intersperser.rs),
 * ported: mix two lists of unequal length as evenly as possible, drawing from the
 * longer one first and spacing the shorter one's items out across it — including
 * the gaps at the start and end, not just between items.
 *
 * Ported rather than approximated with "every Nth card" because the spacing at
 * the edges is the whole point: 3 new cards among 8 reviews land after the 2nd,
 * 4th and 6th review, leaving reviews at both ends, rather than three new cards
 * bunched at the front or the back. The test below pins the exact sequence.
 */
function intersperse<T>(one: T[], two: T[]): T[] {
  const ratio = (one.length + 1) / (two.length + 1);
  const out: T[] = [];
  let oneIdx = 0;
  let twoIdx = 0;

  while (oneIdx < one.length || twoIdx < two.length) {
    if (oneIdx === one.length) {
      out.push(two[twoIdx++]);
    } else if (twoIdx === two.length) {
      out.push(one[oneIdx++]);
    } else if ((twoIdx + 1) * ratio < oneIdx + 1) {
      out.push(two[twoIdx++]);
    } else {
      out.push(one[oneIdx++]);
    }
  }
  return out;
}

export function selectDueQueue(
  candidates: DueCandidate[],
  limits: QueueLimits,
  counts: DailyCounts,
  now: Date,
): DueItem[] {
  const { learning, review, newCards, learnAhead } = categorize(candidates, limits, counts, now);
  return [...learning, ...intersperse(review, newCards), ...learnAhead]
    .map((c) => ({ noteId: c.noteId, cardKind: c.cardKind }));
}

/** Same categorization as `selectDueQueue`, as counts — what a deck-list row shows
 * without pulling every note's content just to count them.
 *
 * `learningCount` includes the learn-ahead cards, matching Anki, whose own learn
 * count is "due now plus anything inside the learn-ahead cutoff" — a deck showing
 * 0 that still hands you a card when you press into it is worse than one showing
 * the card it's about to offer. Interspersing doesn't change any count, only the
 * order, so `reviewCount`/`newCount` are unaffected by it. */
export function summarizeDueQueue(
  candidates: DueCandidate[],
  limits: QueueLimits,
  counts: DailyCounts,
  now: Date,
): QueueSummary {
  const { learning, review, newCards, learnAhead } = categorize(candidates, limits, counts, now);
  return {
    learningCount: learning.length + learnAhead.length,
    reviewCount: review.length,
    newCount: newCards.length,
  };
}

function byDueAscending(a: DueCandidate, b: DueCandidate): number {
  // Both are known non-null here — only ever called on the isDueNow-filtered arrays.
  return (a.due as Date).getTime() - (b.due as Date).getTime();
}
