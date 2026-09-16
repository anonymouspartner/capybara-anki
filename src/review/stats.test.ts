import { assertEquals } from "jsr:@std/assert@^1";
import { computeStats, currentStreak, reviewsByDay, successRate } from "./stats.ts";
import type { ReviewRow } from "./types.ts";

const NOW = new Date("2026-09-16T12:00:00Z"); // a Wednesday, mid-day UTC

function review(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: crypto.randomUUID(),
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
    elapsedDays: 1,
    scheduledDays: 1,
    ...overrides,
  };
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

Deno.test("reviewsByDay: zero-fills every day in the window, not just days with reviews", () => {
  const buckets = reviewsByDay([], NOW, 3);
  assertEquals(buckets.length, 3);
  assertEquals(buckets.every((b) => b.again + b.hard + b.good + b.easy === 0), true);
});

Deno.test("reviewsByDay: sorts reviews into the right day and rating bucket", () => {
  const reviews = [
    review({ reviewedAt: NOW, rating: 3 }), // today, good
    review({ reviewedAt: daysAgo(1), rating: 1 }), // yesterday, again
  ];
  const buckets = reviewsByDay(reviews, NOW, 2);
  assertEquals(buckets[1].good, 1); // today is the last entry (oldest first)
  assertEquals(buckets[0].again, 1);
});

Deno.test("reviewsByDay: a review outside the window is dropped, not overflowed into an edge bucket", () => {
  const reviews = [review({ reviewedAt: daysAgo(30) })];
  const buckets = reviewsByDay(reviews, NOW, 7);
  assertEquals(buckets.reduce((sum, b) => sum + b.again + b.hard + b.good + b.easy, 0), 0);
});

Deno.test("successRate: null with no reviews at all — not zero", () => {
  assertEquals(successRate([]), null);
});

Deno.test("successRate: Again doesn't count as retained, everything else does", () => {
  const reviews = [review({ rating: 1 }), review({ rating: 2 }), review({ rating: 3 }), review({ rating: 4 })];
  assertEquals(successRate(reviews), 0.75);
});

Deno.test("currentStreak: zero with no reviews ever", () => {
  assertEquals(currentStreak([], NOW), 0);
});

Deno.test("currentStreak: a review today and yesterday (and no earlier) is a streak of 2", () => {
  const reviews = [review({ reviewedAt: NOW }), review({ reviewedAt: daysAgo(1) })];
  assertEquals(currentStreak(reviews, NOW), 2);
});

Deno.test("currentStreak: not having reviewed yet today doesn't break an otherwise-active streak", () => {
  const reviews = [review({ reviewedAt: daysAgo(1) }), review({ reviewedAt: daysAgo(2) })];
  assertEquals(currentStreak(reviews, NOW), 2);
});

Deno.test("currentStreak: a gap day stops the count at the gap, not at zero", () => {
  const reviews = [review({ reviewedAt: NOW }), review({ reviewedAt: daysAgo(2) })]; // yesterday missing
  assertEquals(currentStreak(reviews, NOW), 1);
});

Deno.test("computeStats: assembles all four pieces from one review list and the store-provided card counts", () => {
  const cardCounts = { newCount: 5, learningCount: 1, reviewCount: 10, suspendedCount: 2 };
  const reviews = [review({ reviewedAt: NOW, rating: 3 })];
  const result = computeStats(reviews, cardCounts, NOW, 7);

  assertEquals(result.totalReviews, 1);
  assertEquals(result.successRate, 1);
  assertEquals(result.currentStreak, 1);
  assertEquals(result.cardCounts, cardCounts);
  assertEquals(result.reviewsByDay.length, 7);
});
