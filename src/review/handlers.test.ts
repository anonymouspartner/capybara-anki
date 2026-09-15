import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { deleteNote, editNote, getDueQueue, NotFoundError, setSuspended, submitReview } from "./handlers.ts";
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
    ...overrides,
  });
}

Deno.test("getDueQueue: a freshly seeded note with no reviews shows up as due", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue, ["n1"]);
});

Deno.test("getDueQueue: respects the daily new limit end to end", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedNote(store, "n2");
  seedConfig(store, "tim", { dailyNewLimit: 1 });

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue.length, 1);
});

Deno.test("submitReview then getDueQueue: an answered card with a future due date drops out of today's queue", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await submitReview(store, { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: NOW });

  const queue = await getDueQueue(store, "tim", NOW);
  assertEquals(queue, []); // its new due date is in the future relative to NOW
});

Deno.test("submitReview twice with the same reviewId is idempotent", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await submitReview(store, { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: NOW });
  await submitReview(store, { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: NOW });

  assertEquals(store.reviews.size, 1);
});

Deno.test("setSuspended then getDueQueue: a suspended note never appears", async () => {
  const store = new InMemoryStore();
  seedNote(store, "n1");
  seedConfig(store, "tim");

  await setSuspended(store, "n1", true);

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
  await submitReview(store, { reviewId: "r1", noteId: "n1", userId: "tim", rating: 3, reviewedAt: NOW });

  await deleteNote(store, "n1");

  assertEquals(await store.getNote("n1"), null);
  assertEquals(await store.getCardState("n1"), null);
  assertEquals(store.reviews.size, 0);
});

Deno.test("deleteNote: deleting a note that doesn't exist raises NotFoundError", async () => {
  const store = new InMemoryStore();
  await assertRejects(() => deleteNote(store, "missing"), NotFoundError);
});
