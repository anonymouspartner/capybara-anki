import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  deleteNote,
  editNote,
  getDeckSummaries,
  getDueQueue,
  getDueQueueWithPreviews,
  getStats,
  NotFoundError,
  setSuspended,
  submitReview,
} from "./handlers.ts";
import { InMemoryStore } from "./store.ts";
import type { NoteRow, SchedulerConfigRow } from "./types.ts";

const NOW = new Date("2026-09-16T12:00:00Z");

function seedNote(store: InMemoryStore, id: string, overrides: Partial<NoteRow> = {}): void {
  store.notes.set(id, {
    id,
    lemma: "важкий",
    gloss: "hard",
    lemmaTranslation: null,
    partOfSpeech: "adj",
    language: "uk",
    example: null,
    exampleTranslation: null,
    audioUrl: null,
    deck: "Ukrainian",
    kind: "vocab",
    hasSpelling: false,
    ...overrides,
  });
}

function seedConfig(store: InMemoryStore, userId: string, overrides: Partial<SchedulerConfigRow> = {}): void {
  store.schedulerConfigs.set(userId, {
    userId,
    fsrsParams: [],
    desiredRetention: 0.9,
    learningSteps: [1, 10],
    dailyNewLimit: 40,
    dailyReviewLimit: 200,
    maxInterval: 36500,
    timeZone: null,
    rolloverHour: 4,
    ...overrides,
  });
}

/** Most tests only care about which notes came back — `cardKind` gets its own
 * dedicated D17 tests below. */
function noteIds(items: { noteId: string }[]): string[] {
  return items.map((i) => i.noteId);
}

Deno.test("getDueQueue: a freshly seeded note with no reviews shows up as due", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(noteIds(queue), ["n1"]);
  assertEquals(queue[0].cardKind, "recall");
});

Deno.test("getDueQueue: respects the daily new limit end to end", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim", { dailyNewLimit: 1 });

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue.length, 1);
});

Deno.test("submitReview then getDueQueue: a card answered into a days-away due date drops out of today's queue", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 4, // Easy graduates a new card straight to a multi-day interval
    reviewedAt: NOW,
  });

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue, []); // its new due date is days out, well past the learn-ahead window
});

Deno.test("submitReview then getDueQueue: a card left minutes away is still offered, but last", async () => {
  // Answering a new card Good puts it on a ~10 minute learning step, inside Anki's
  // 20-minute learn-ahead window — so it is offered again once nothing else is
  // left, rather than the session claiming there's nothing to study. It has to
  // come after the genuinely-due card, though: learn-ahead is the fallback, not a
  // queue-jump.
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim");

  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
  });

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue.map((i) => i.noteId), ["n2", "n1"]);
});

Deno.test("submitReview twice with the same reviewId is idempotent", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  const input = { reviewId: "r1", noteId: "n1", cardKind: "recall" as const, userId: "tim", rating: 3 as const, reviewedAt: NOW };
  await submitReview(store, input);
  await submitReview(store, input);

  assertEquals(store.reviews.size, 1);
});

Deno.test("setSuspended then getDueQueue: a suspended note never appears", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await setSuspended(store, "n1", "recall", true);

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue, []);
});

Deno.test("editNote: a valid edit is persisted", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");

  const result = await editNote(store, "n1", { gloss: "difficult" });
  assertEquals(result.ok, true);
  assertEquals((await store.getNote("n1"))?.gloss, "difficult");
});

Deno.test("editNote: an invalid edit is rejected and never reaches the store", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");

  const result = await editNote(store, "n1", { lemma: "" });
  assertEquals(result.ok, false);
  assertEquals((await store.getNote("n1"))?.lemma, "важкий"); // unchanged
});

Deno.test("editNote: editing a note that doesn't exist raises NotFoundError", async () => {
  const store = new InMemoryStore();
  await assertRejects(() => editNote(store, "missing", { gloss: "x" }), NotFoundError);
});

Deno.test("deleteNote: removes the note, its card_state, and its reviews", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");
  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
  });

  await deleteNote(store, "n1");

  assertEquals(await store.getNote("n1"), null);
  assertEquals(await store.getCardState("n1", "recall"), null);
  assertEquals(store.reviews.size, 0);
});

Deno.test("deleteNote: deleting a note that doesn't exist raises NotFoundError", async () => {
  const store = new InMemoryStore();
  await assertRejects(() => deleteNote(store, "missing"), NotFoundError);
});

Deno.test("getDueQueue: scoping to one deck excludes notes in other decks", async () => {
  const store = new InMemoryStore();
  seedNote(store, "uk-1", { deck: "Ukrainian" });
  seedNote(store, "en-1", { deck: "English" });
  seedConfig(store, "tim");

  const ukrainianQueue = await getDueQueue(store, "tim", NOW, "Ukrainian");
  assertEquals(noteIds(ukrainianQueue), ["uk-1"]);
});

Deno.test("getDueQueue: no deck argument combines every deck", async () => {
  const store = new InMemoryStore();
  seedNote(store, "uk-1", { deck: "Ukrainian" });
  seedNote(store, "en-1", { deck: "English" });
  seedConfig(store, "tim");

  const combined = await getDueQueue(store, "tim", NOW);
  assertEquals(new Set(noteIds(combined)), new Set(["uk-1", "en-1"]));
});

Deno.test("D17: a hasSpelling note offers both a recall and a spelling due item", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { hasSpelling: true });
  seedConfig(store, "tim");

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue.length, 2);
  assertEquals(new Set(queue.map((i) => i.cardKind)), new Set(["recall", "spelling"]));
});

Deno.test("D17: reviewing a note's spelling card doesn't affect its recall card's schedule", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { hasSpelling: true });
  seedConfig(store, "tim");

  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "spelling",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
  });

  const queue = await getDueQueue(store, "tim", NOW);
  // Recall is untouched and still new, so it comes first. Spelling was just
  // answered onto a ~10 minute learning step, which keeps it in the session as a
  // learn-ahead card at the very end — what matters for D17 is that answering one
  // card moved only that card's schedule.
  assertEquals(queue.map((i) => i.cardKind), ["recall", "spelling"]);
  assertEquals((await store.getCardState("n1", "recall"))?.state ?? null, null);
});

Deno.test("D17: suspending a note's spelling card leaves its recall card reviewable", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { hasSpelling: true });
  seedConfig(store, "tim");

  await setSuspended(store, "n1", "spelling", true);

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue.length, 1);
  assertEquals(queue[0].cardKind, "recall");
});

Deno.test("getDeckSummaries: one row per deck, counts matching what getDueQueue would offer", async () => {
  const store = new InMemoryStore();
  seedNote(store, "uk-1", { deck: "Ukrainian" });
  seedNote(store, "uk-2", { deck: "Ukrainian" });
  seedNote(store, "en-1", { deck: "English" });
  seedConfig(store, "tim");

  const summaries = await getDeckSummaries(store, "tim", NOW);
  const byDeck = Object.fromEntries(summaries.map((s) => [s.deck, s]));

  assertEquals(byDeck["Ukrainian"].newCount, 2);
  assertEquals(byDeck["English"].newCount, 1);
});

Deno.test("getDeckSummaries: a deck's daily new limit is independent of another deck's", async () => {
  const store = new InMemoryStore();
  seedNote(store, "uk-1", { deck: "Ukrainian" });
  seedNote(store, "en-1", { deck: "English" });
  seedConfig(store, "tim", { dailyNewLimit: 1 });
  // Use up Ukrainian's allowance only.
  await submitReview(store, {
    reviewId: "r1",
    noteId: "uk-1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
  });

  const summaries = await getDeckSummaries(store, "tim", NOW);
  const byDeck = Object.fromEntries(summaries.map((s) => [s.deck, s]));

  assertEquals(byDeck["Ukrainian"].newCount, 0); // allowance used, and it's due tomorrow anyway
  assertEquals(byDeck["English"].newCount, 1); // untouched
});

Deno.test("getDueQueueWithPreviews: attaches note content and a four-rating preview to each due card", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { lemma: "важкий", gloss: "hard" });
  seedConfig(store, "tim");

  const cards = await getDueQueueWithPreviews(store, "tim", NOW);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].lemma, "важкий");
  assertEquals(cards[0].gloss, "hard");
  assertEquals(cards[0].cardKind, "recall");
  // Again <= Hard <= Good <= Easy, same invariant mutations.test.ts checks directly.
  const { again, hard, good, easy } = cards[0].preview;
  if (!(again.getTime() <= hard.getTime())) throw new Error("Again should not outlast Hard");
  if (!(hard.getTime() <= good.getTime())) throw new Error("Hard should not outlast Good");
  if (!(good.getTime() <= easy.getTime())) throw new Error("Good should not outlast Easy");
});

Deno.test("getDueQueueWithPreviews: respects deck scoping like getDueQueue", async () => {
  const store = new InMemoryStore();
  seedNote(store, "uk-1", { deck: "Ukrainian" });
  seedNote(store, "en-1", { deck: "English" });
  seedConfig(store, "tim");

  const cards = await getDueQueueWithPreviews(store, "tim", NOW, "Ukrainian");
  assertEquals(cards.map((c) => c.id), ["uk-1"]);
});

Deno.test("getDueQueueWithPreviews: a hasSpelling note's two cards each get their own preview", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { hasSpelling: true });
  seedConfig(store, "tim");

  const cards = await getDueQueueWithPreviews(store, "tim", NOW);
  assertEquals(cards.length, 2);
  assertEquals(cards.every((c) => c.id === "n1"), true);
  assertEquals(new Set(cards.map((c) => c.cardKind)), new Set(["recall", "spelling"]));
});

Deno.test("getStats: reflects reviews actually submitted through submitReview, end to end", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: NOW,
  });

  const stats = await getStats(store, "tim", NOW);
  assertEquals(stats.totalReviews, 1);
  assertEquals(stats.currentStreak, 1);
  assertEquals(stats.successRate, 1);
  // The reviewed note is no longer "new" — submitReview moved its card_state on.
  assertEquals(stats.cardCounts.newCount, 0);
});

Deno.test("getStats: cardCounts covers every note regardless of review history", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim");

  const stats = await getStats(store, "tim", NOW);
  assertEquals(stats.cardCounts.newCount, 2);
  assertEquals(stats.totalReviews, 0);
  assertEquals(stats.successRate, null);
});

Deno.test("getStats: a hasSpelling note's two cards both count toward cardCounts", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1", { hasSpelling: true });
  seedConfig(store, "tim");

  const stats = await getStats(store, "tim", NOW);
  assertEquals(stats.cardCounts.newCount, 2); // recall + spelling, both new
});

// ---------------------------------------------------------------------------
// Day rollover (day.ts) — reaching the daily limits end to end
// ---------------------------------------------------------------------------

Deno.test("a 1am review counts toward the previous study day, so it doesn't eat today's new limit", () => {
  // The discriminating case. 2026-09-17T05:00Z is 1am EDT on the 17th, which is
  // before the 4am rollover, so it belongs to the 16th. Under the old UTC
  // bucketing both instants are "the 17th" and the review would wrongly consume
  // one of today's new cards.
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim", { timeZone: "America/New_York", dailyNewLimit: 1 });

  const lateNight = new Date("2026-09-17T05:00:00Z"); // 1:00am EDT, study day = the 16th
  const nextMidday = new Date("2026-09-17T16:00:00Z"); // 12:00pm EDT, study day = the 17th

  return submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: lateNight,
  }).then(async () => {
    const counts = await store.getDailyCounts("tim", nextMidday);
    assertEquals(counts, { newTakenToday: 0, reviewTakenToday: 0 });

    // ...so today's single new-card slot is still unspent and n2 is offered.
    // n1 is in the queue too, but as an overdue learning card (answered onto a
    // ~10 minute step at 1am, long past by midday) — not as a new one.
    const queue = await getDueQueue(store, "tim", nextMidday);
    assertEquals(noteIds(queue).includes("n2"), true);
    assertEquals((await store.getCardState("n1", "recall"))?.state, 1);
  });
});

Deno.test("an 8pm review counts toward today even though it is already tomorrow in UTC", () => {
  // The mirror case. 2026-09-17T00:30Z is 8:30pm EDT on the 16th. UTC calls that
  // the 17th; Eastern calls it the 16th, and so should the limit.
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim", { timeZone: "America/New_York", dailyNewLimit: 1 });

  const evening = new Date("2026-09-17T00:30:00Z"); // 8:30pm EDT on the 16th
  const laterThatEvening = new Date("2026-09-17T02:00:00Z"); // 10:00pm EDT, same study day

  return submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "tim",
    rating: 3,
    reviewedAt: evening,
  }).then(async () => {
    const counts = await store.getDailyCounts("tim", laterThatEvening);
    assertEquals(counts.newTakenToday, 1);

    // The limit of 1 is spent, so the second note is held back until tomorrow.
    const queue = await getDueQueue(store, "tim", laterThatEvening);
    assertEquals(noteIds(queue).includes("n2"), false);
  });
});

Deno.test("getStats: a streak survives a late-night session that UTC would split in two", async () => {
  // What the user actually saw: a streak reading 0 while AnkiDroid, on the same
  // history, still counted it.
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim", { timeZone: "America/New_York" });

  // Three consecutive Eastern evenings, each at 9pm EDT — which is 01:00Z the
  // NEXT UTC day every time.
  for (const [i, iso] of ["2026-09-15T01:00:00Z", "2026-09-16T01:00:00Z", "2026-09-17T01:00:00Z"].entries()) {
    await submitReview(store, {
      reviewId: `r${i}`,
      noteId: "n1",
      cardKind: "recall",
      userId: "tim",
      rating: 3,
      reviewedAt: new Date(iso),
    });
  }

  // Now: 10pm EDT on the 16th — the third session's own study day.
  const stats = await getStats(store, "tim", new Date("2026-09-17T02:00:00Z"));
  assertEquals(stats.currentStreak, 3);
});
