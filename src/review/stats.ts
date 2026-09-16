/**
 * The stats screen's number-crunching (step 6, docs/DESIGN.md §9) — pure, over
 * already-fetched rows, the same split as `dueQueue.ts`: `handlers.ts`'s
 * `getStats` does the store round trip, this file only computes. Three numbers:
 * a day-by-day activity histogram, an overall success rate, and a current streak,
 * plus the collection's state composition (`StateCounts`, already store-computed).
 */

import type { DailyReviewCount, ReviewRow, StateCounts } from "./types.ts";

const MS_PER_DAY = 86_400_000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

function dateKey(d: Date): string {
  return startOfUtcDay(d).toISOString().slice(0, 10);
}

/** One zero-filled bucket per day in `[now - days + 1, now]`, oldest first — a day
 * with no reviews is a real zero, not a missing entry, so a chart can render a
 * fixed-width axis without the caller reconstructing the gaps itself. */
export function reviewsByDay(reviews: ReviewRow[], now: Date, days: number): DailyReviewCount[] {
  const buckets = new Map<string, DailyReviewCount>();
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKey(addDays(startOfUtcDay(now), -i));
    buckets.set(key, { date: key, again: 0, hard: 0, good: 0, easy: 0 });
  }
  for (const review of reviews) {
    const bucket = buckets.get(dateKey(review.reviewedAt));
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

/** Consecutive days with at least one review, walking back from today. Today not
 * having a review yet doesn't break a streak that's still active — only a missed
 * *prior* day does — so the walk starts at yesterday whenever today is still empty. */
export function currentStreak(reviews: ReviewRow[], now: Date): number {
  const daysWithReviews = new Set(reviews.map((r) => dateKey(r.reviewedAt)));
  let cursor = startOfUtcDay(now);
  if (!daysWithReviews.has(dateKey(cursor))) {
    cursor = addDays(cursor, -1);
  }
  let streak = 0;
  while (daysWithReviews.has(dateKey(cursor))) {
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
  cardCounts: StateCounts;
}

/** Assembles the full stats screen response from already-fetched rows. */
export function computeStats(
  reviews: ReviewRow[],
  cardCounts: StateCounts,
  now: Date,
  days: number,
): StatsResult {
  return {
    reviewsByDay: reviewsByDay(reviews, now, days),
    successRate: successRate(reviews),
    currentStreak: currentStreak(reviews, now),
    totalReviews: reviews.length,
    cardCounts,
  };
}
