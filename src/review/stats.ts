/**
 * The stats screen's number-crunching (step 6, docs/DESIGN.md §9) — pure, over
 * already-fetched rows, the same split as `dueQueue.ts`: `handlers.ts`'s
 * `getStats` does the store round trip, this file only computes. Three numbers:
 * a day-by-day activity histogram, an overall success rate, and a current streak,
 * plus the collection's state composition (`StateCounts`, already store-computed).
 */

import { addDays, ankiDayKey, type DayBoundary } from "./day.ts";
import type { DailyReviewCount, ReviewRow, StateCounts } from "./types.ts";

/** One zero-filled bucket per day in `[now - days + 1, now]`, oldest first — a day
 * with no reviews is a real zero, not a missing entry, so a chart can render a
 * fixed-width axis without the caller reconstructing the gaps itself.
 *
 * Days here are study days (see day.ts), not UTC days: a review at 1am local
 * belongs to the evening that ran into it, the same as it would in Anki. */
export function reviewsByDay(
  reviews: ReviewRow[],
  now: Date,
  days: number,
  boundary: DayBoundary,
): DailyReviewCount[] {
  const today = ankiDayKey(now, boundary);
  const buckets = new Map<string, DailyReviewCount>();
  for (let i = days - 1; i >= 0; i--) {
    const key = addDays(today, -i);
    buckets.set(key, { date: key, again: 0, hard: 0, good: 0, easy: 0 });
  }
  for (const review of reviews) {
    const bucket = buckets.get(ankiDayKey(review.reviewedAt, boundary));
    if (!bucket) continue; // outside the requested window
    if (review.rating === 1) bucket.again++;
    else if (review.rating === 2) bucket.hard++;
    else if (review.rating === 3) bucket.good++;
    else bucket.easy++;
  }
  return [...buckets.values()];
}

/** Fraction of reviews rated anything but Again — `null` (not `0`) with no reviews
 * at all, since "0% success" and "no data yet" are different things a stats screen
 * should say differently. */
export function successRate(reviews: ReviewRow[]): number | null {
  if (reviews.length === 0) return null;
  const retained = reviews.filter((r) => r.rating !== 1).length;
  return retained / reviews.length;
}

/**
 * How many reviews were rated Again, all time.
 *
 * Exists because `successRate` alone can't answer the question it looks like it
 * answers: whether there is enough evidence of *forgetting* to personalise the
 * FSRS weights. Fitting the model needs failures specifically, and a rate hides
 * how few there are — 98.5% success reads as "excellent" whether it comes from
 * 56 lapses or 5. Running the real optimiser against this collection at 56
 * lapses produced weights that scored better on log loss and scheduled a card
 * 23 years out after five Good answers, because a history with almost no
 * failures teaches FSRS that nothing is ever forgotten. This count is the number
 * to watch before trying again.
 *
 * Deliberately not the same thing as Anki's per-card `lapses` counter, which
 * only counts a *review* card failing, not a card failed during its learning
 * steps. This is every Again, which is the quantity the optimiser actually
 * trains on.
 */
export function lapseCount(reviews: ReviewRow[]): number {
  return reviews.filter((r) => r.rating === 1).length;
}

/** Consecutive days with at least one review, walking back from today. Today not
 * having a review yet doesn't break a streak that's still active — only a missed
 * *prior* day does — so the walk starts at yesterday whenever today is still empty. */
export function currentStreak(reviews: ReviewRow[], now: Date, boundary: DayBoundary): number {
  const daysWithReviews = new Set(reviews.map((r) => ankiDayKey(r.reviewedAt, boundary)));
  let cursor = ankiDayKey(now, boundary);
  if (!daysWithReviews.has(cursor)) {
    cursor = addDays(cursor, -1);
  }
  let streak = 0;
  while (daysWithReviews.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export interface StatsResult {
  reviewsByDay: DailyReviewCount[];
  successRate: number | null;
  currentStreak: number;
  totalReviews: number;
  /** All-time count of Again ratings — see `lapseCount`. */
  lapseCount: number;
  cardCounts: StateCounts;
}

/** Assembles the full stats screen response from already-fetched rows. */
export function computeStats(
  reviews: ReviewRow[],
  cardCounts: StateCounts,
  now: Date,
  days: number,
  boundary: DayBoundary,
): StatsResult {
  return {
    reviewsByDay: reviewsByDay(reviews, now, days, boundary),
    successRate: successRate(reviews),
    currentStreak: currentStreak(reviews, now, boundary),
    totalReviews: reviews.length,
    lapseCount: lapseCount(reviews),
    cardCounts,
  };
}
