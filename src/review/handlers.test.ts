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
  undoLastReview,
} from "./handlers.ts";
import { cardKey, InMemoryStore } from "./store.ts";
import { DEFAULT_LEECH_ACTION, DEFAULT_LEECH_THRESHOLD } from "./leech.ts";
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
    leechThreshold: DEFAULT_LEECH_THRESHOLD,
    leechAction: DEFAULT_LEECH_ACTION,
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

/** A store that counts how many times each read was called, so the queue
 * endpoint's cost can be asserted rather than assumed. The count is the point:
 * this endpoint used to issue two reads per due card, which is invisible in
 * every correctness test and is exactly what made opening a deck slow. */
class CountingStore extends InMemoryStore {
  calls: Record<string, number> = {};

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  override getNote(noteId: string) {
    this.count("getNote");
    return super.getNote(noteId);
  }

  override getCardState(noteId: string, cardKind: Parameters<InMemoryStore["getCardState"]>[1]) {
    this.count("getCardState");
    return super.getCardState(noteId, cardKind);
  }

  override getNotes(noteIds: string[]) {
    this.count("getNotes");
    return super.getNotes(noteIds);
  }

  override getCardStates(items: Parameters<InMemoryStore["getCardStates"]>[0]) {
    this.count("getCardStates");
    return super.getCardStates(items);
  }
}

Deno.test("getDueQueueWithPreviews reads in batches, not once per card", async () => {
  const store = new CountingStore();
  seedConfig(store, "u1", { dailyNewLimit: 100, dailyReviewLimit: 100 });
  for (let i = 0; i < 40; i++) seedNote(store, `n${i}`, { lemma: `word${i}` });

  const cards = await getDueQueueWithPreviews(store, "u1", NOW);

  assertEquals(cards.length, 40, "every seeded card should be offered");
  // The whole point: constant, not proportional to the queue.
  assertEquals(store.calls.getNotes, 1);
  assertEquals(store.calls.getCardStates, 1);
  assertEquals(store.calls.getNote ?? 0, 0);
  assertEquals(store.calls.getCardState ?? 0, 0);
});

Deno.test("getDueQueueWithPreviews still renders content and previews correctly", async () => {
  const batched = new CountingStore();
  seedConfig(batched, "u1", { dailyNewLimit: 100, dailyReviewLimit: 100 });
  seedNote(batched, "n1", { lemma: "новий", gloss: "new" });
  seedNote(batched, "n2", { lemma: "старий", gloss: "old", hasSpelling: true });
  // A card mid-way through its life, so the preview has real prior state to read
  // rather than always taking the new-card path.
  batched.cardStates.set(cardKey("n1", "recall"), {
    noteId: "n1",
    cardKind: "recall",
    due: new Date(NOW.getTime() - 86_400_000),
    stability: 5,
    difficulty: 5,
    state: 2,
    reps: 3,
    lapses: 0,
    lastReview: new Date(NOW.getTime() - 6 * 86_400_000),
    learningStep: 0,
    suspended: false,
    lastUserId: "u1",
  });

  const cards = await getDueQueueWithPreviews(batched, "u1", NOW);

  // D17: the hasSpelling note contributes two independently-scheduled cards.
  assertEquals(cards.length, 3);
  const spelling = cards.find((c) => c.cardKind === "spelling");
  assertEquals(spelling?.lemma, "старий");
  const n1 = cards.find((c) => c.id === "n1")!;
  assertEquals(n1.gloss, "new");
  // A review card's four previews must be ordered Again <= Hard <= Good <= Easy;
  // reading the wrong card's state would break this silently.
  assertEquals(n1.preview.again.getTime() <= n1.preview.hard.getTime(), true);
  assertEquals(n1.preview.hard.getTime() <= n1.preview.good.getTime(), true);
  assertEquals(n1.preview.good.getTime() <= n1.preview.easy.getTime(), true);
});

Deno.test("getDueQueueWithPreviews skips a note deleted out from under the queue", async () => {
  const store = new CountingStore();
  seedConfig(store, "u1", { dailyNewLimit: 100, dailyReviewLimit: 100 });
  seedNote(store, "n1");
  seedNote(store, "n2");
  // Selected into the queue, then gone before its content is read — the race a
  // second device deleting a card produces.
  const items = await getDueQueue(store, "u1", NOW);
  assertEquals(items.length, 2);
  store.notes.delete("n2");

  const cards = await getDueQueueWithPreviews(store, "u1", NOW);
  assertEquals(cards.map((c) => c.id), ["n1"]);
});

Deno.test("a card that keeps being forgotten is announced as a leech", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "n1");

  // Drive a real card through the scheduler rather than hand-writing lapse
  // counts: what matters is that the announcement lines up with the lapses FSRS
  // itself records, not with a number this test made up.
  let clock = NOW.getTime();
  const answer = async (rating: 1 | 2 | 3 | 4) => {
    clock += 86_400_000;
    const result = await submitReview(store, {
      reviewId: crypto.randomUUID(),
      noteId: "n1",
      cardKind: "recall",
      userId: "u1",
      rating,
      reviewedAt: new Date(clock),
    });
    return result.becameLeech;
  };

  // Get it into review state first — a card failed during its learning steps
  // has not lapsed, which is Anki's distinction too.
  await answer(4);
  await answer(3);

  const announcements: number[] = [];
  for (let i = 0; i < 20; i++) {
    if (await answer(1)) {
      announcements.push(store.cardStates.get(cardKey("n1", "recall"))!.lapses);
    }
    await answer(3); // recover, so the next Again is a fresh lapse
  }

  // Default threshold 8, half-threshold 4: fires at 8, then 12, then 16...
  assertEquals(announcements.slice(0, 3), [8, 12, 16]);
  // 'tag' is the default action, so nothing about the card's scheduling moved.
  assertEquals(store.cardStates.get(cardKey("n1", "recall"))!.suspended, false);
});

Deno.test("the suspend action takes the leech out of rotation", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50, leechThreshold: 1, leechAction: "suspend" });
  seedNote(store, "n1");

  let clock = NOW.getTime();
  const answer = async (rating: 1 | 2 | 3 | 4) => {
    clock += 86_400_000;
    return await submitReview(store, {
      reviewId: crypto.randomUUID(),
      noteId: "n1",
      cardKind: "recall",
      userId: "u1",
      rating,
      reviewedAt: new Date(clock),
    });
  };

  await answer(4);
  await answer(3);
  assertEquals(store.cardStates.get(cardKey("n1", "recall"))!.suspended, false);

  const result = await answer(1);
  assertEquals(result.becameLeech, true);
  assertEquals(store.cardStates.get(cardKey("n1", "recall"))!.suspended, true);
  // And a suspended card is no longer offered.
  assertEquals((await getDueQueue(store, "u1", new Date(clock + 86_400_000))).length, 0);
});

Deno.test("a threshold of zero never announces a leech", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50, leechThreshold: 0 });
  seedNote(store, "n1");

  let clock = NOW.getTime();
  let announced = false;
  for (let i = 0; i < 30; i++) {
    clock += 86_400_000;
    const r = await submitReview(store, {
      reviewId: crypto.randomUUID(),
      noteId: "n1",
      cardKind: "recall",
      userId: "u1",
      rating: i % 2 === 0 ? 1 : 3,
      reviewedAt: new Date(clock),
    });
    announced ||= r.becameLeech;
  }
  assertEquals(announced, false);
});

Deno.test("undo puts the card back exactly where it was", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "n1");

  let clock = NOW.getTime();
  const answer = async (rating: 1 | 2 | 3 | 4) => {
    clock += 86_400_000;
    await submitReview(store, {
      reviewId: crypto.randomUUID(),
      noteId: "n1",
      cardKind: "recall",
      userId: "u1",
      rating,
      reviewedAt: new Date(clock),
    });
  };

  await answer(3);
  await answer(4);
  await answer(3);
  // Snapshot the real state, then answer once more and take it back. This is the
  // whole promise: not "close to", but byte-identical, fuzz included — which
  // only holds because fuzz is seeded on (card, reps) and reps winds back too.
  const before = { ...store.cardStates.get(cardKey("n1", "recall"))! };

  await answer(1);
  const afterAnswer = store.cardStates.get(cardKey("n1", "recall"))!;
  assertEquals(afterAnswer.lapses, before.lapses + 1);

  const result = await undoLastReview(store, "u1", "n1", "recall");
  assertEquals(result.rating, 1);
  assertEquals(store.cardStates.get(cardKey("n1", "recall")), before);
  // The log itself shrank — undo is the one operation that shortens it.
  assertEquals((await store.getReviewsForCard("u1", "n1", "recall")).length, 3);
});

Deno.test("undoing a card's only review makes it new again", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "n1");

  await submitReview(store, {
    reviewId: "r1",
    noteId: "n1",
    cardKind: "recall",
    userId: "u1",
    rating: 3,
    reviewedAt: NOW,
  });
  const result = await undoLastReview(store, "u1", "n1", "recall");

  assertEquals(result.cardState, null);
  // "Never reviewed" is the absence of a row, not a row of zeros.
  assertEquals(store.cardStates.has(cardKey("n1", "recall")), false);
  const queue = await getDueQueue(store, "u1", NOW);
  assertEquals(queue.length, 1, "it should be offered again as a new card");
});

Deno.test("undo does not reach across to a partner's answer", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "tim", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedConfig(store, "vika", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "n1");

  await submitReview(store, {
    reviewId: "r-vika",
    noteId: "n1",
    cardKind: "recall",
    userId: "vika",
    rating: 3,
    reviewedAt: NOW,
  });

  // Tim has never answered this card, so there is nothing of his to undo —
  // Vika's answer must not be what gets deleted.
  await assertRejects(
    () => undoLastReview(store, "tim", "n1", "recall"),
    NotFoundError,
  );
  assertEquals((await store.getReviewsForCard("vika", "n1", "recall")).length, 1);
});

Deno.test("undo takes back the answer but not a suspension", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50, leechThreshold: 1, leechAction: "suspend" });
  seedNote(store, "n1");

  let clock = NOW.getTime();
  const answer = async (rating: 1 | 2 | 3 | 4) => {
    clock += 86_400_000;
    return await submitReview(store, {
      reviewId: crypto.randomUUID(),
      noteId: "n1",
      cardKind: "recall",
      userId: "u1",
      rating,
      reviewedAt: new Date(clock),
    });
  };
  await answer(4);
  await answer(3);
  assertEquals((await answer(1)).becameLeech, true);
  assertEquals(store.cardStates.get(cardKey("n1", "recall"))!.suspended, true);

  await undoLastReview(store, "u1", "n1", "recall");
  // The answer is taken back; the judgement about the card is not. Suspension is
  // not part of the fold, here as everywhere else.
  assertEquals(store.cardStates.get(cardKey("n1", "recall"))!.suspended, true);
});

Deno.test("a spelling card lives in the Spelling deck, not its note's deck", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "plain", { deck: "Ukrainian", hasSpelling: false });
  seedNote(store, "both", { deck: "Ukrainian", hasSpelling: true });
  seedNote(store, "en", { deck: "English", language: "en", hasSpelling: true });

  // The deck list matches what AnkiDroid shows: Spelling is its own row.
  const decks = await store.getDecks("u1");
  assertEquals(decks.sort(), ["English", "Spelling", "Ukrainian"]);

  // Ukrainian holds only the recall cards of its notes...
  const ukrainian = await getDueQueue(store, "u1", NOW, "Ukrainian");
  assertEquals(ukrainian.map((i) => `${i.noteId}/${i.cardKind}`).sort(), [
    "both/recall",
    "plain/recall",
  ]);

  // ...and Spelling gathers the spelling cards from every note deck.
  const spelling = await getDueQueue(store, "u1", NOW, "Spelling");
  assertEquals(spelling.map((i) => `${i.noteId}/${i.cardKind}`).sort(), [
    "both/spelling",
    "en/spelling",
  ]);

  // Unscoped is still everything, and nothing is counted twice.
  const all = await getDueQueue(store, "u1", NOW);
  assertEquals(all.length, 5);
});

Deno.test("deck summaries agree with what pressing into the deck offers", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 50, dailyReviewLimit: 50 });
  seedNote(store, "a", { deck: "Ukrainian", hasSpelling: true });
  seedNote(store, "b", { deck: "Ukrainian", hasSpelling: false });

  const summaries = await getDeckSummaries(store, "u1", NOW);
  for (const summary of summaries) {
    const queue = await getDueQueue(store, "u1", NOW, summary.deck);
    assertEquals(
      summary.newCount + summary.learningCount + summary.reviewCount,
      queue.length,
      `${summary.deck}: the row's counts must match the queue it opens`,
    );
  }
  assertEquals(summaries.find((s) => s.deck === "Spelling")?.newCount, 1);
  assertEquals(summaries.find((s) => s.deck === "Ukrainian")?.newCount, 2);
});

Deno.test("a spelling answer counts against the Spelling deck's daily limit only", async () => {
  const store = new InMemoryStore();
  seedConfig(store, "u1", { dailyNewLimit: 1, dailyReviewLimit: 50 });
  seedNote(store, "a", { deck: "Ukrainian", hasSpelling: true });
  seedNote(store, "b", { deck: "Ukrainian", hasSpelling: false });

  await submitReview(store, {
    reviewId: "r1",
    noteId: "a",
    cardKind: "spelling",
    userId: "u1",
    rating: 3,
    reviewedAt: NOW,
  });

  // Spelling's one-new-card allowance is spent...
  assertEquals((await store.getDailyCounts("u1", NOW, "Spelling")).newTakenToday, 1);
  // ...but Ukrainian's is untouched, because that answer wasn't in Ukrainian.
  assertEquals((await store.getDailyCounts("u1", NOW, "Ukrainian")).newTakenToday, 0);
});
