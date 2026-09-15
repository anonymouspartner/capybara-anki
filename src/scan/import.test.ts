import { assertEquals } from "jsr:@std/assert@^1";
import { importExtractedCards } from "./import.ts";
import { InMemoryStore } from "../review/store.ts";
import type { ExtractedCard } from "./types.ts";

const CARD: ExtractedCard = {
  lemma: "письменниця",
  gloss: "female writer",
  lemmaTranslation: "writer",
  partOfSpeech: "noun",
  example: "Вона була відомою письменницею.",
  exampleTranslation: "She was a famous writer.",
};

const OPTS = { deck: "Ukrainian", language: "uk" as const, source: "scan" as const };

Deno.test("a valid card is imported and immediately readable from the store", async () => {
  const store = new InMemoryStore();
  const result = await importExtractedCards(store, [CARD], OPTS);

  assertEquals(result.rejected, []);
  assertEquals(result.imported.length, 1);
  const [{ id }] = result.imported;
  const stored = await store.getNote(id);
  assertEquals(stored?.lemma, CARD.lemma);
  assertEquals(stored?.deck, "Ukrainian");
  assertEquals(stored?.language, "uk");
});

Deno.test("a card with an empty lemma is rejected, not imported — same rule edit-in-place uses", async () => {
  const store = new InMemoryStore();
  const badCard: ExtractedCard = { ...CARD, lemma: "   " };
  const result = await importExtractedCards(store, [badCard], OPTS);

  assertEquals(result.imported, []);
  assertEquals(result.rejected.length, 1);
  assertEquals(store.notes.size, 0);
});

Deno.test("one bad card doesn't block the rest of the page's good cards", async () => {
  const store = new InMemoryStore();
  const goodCard: ExtractedCard = { ...CARD, lemma: "капібара" };
  const badCard: ExtractedCard = { ...CARD, lemma: "" };
  const result = await importExtractedCards(store, [badCard, goodCard], OPTS);

  assertEquals(result.imported.length, 1);
  assertEquals(result.rejected.length, 1);
  assertEquals(result.imported[0].lemma, "капібара");
});

Deno.test("deck/language/source come from the import options, not the card", async () => {
  const store = new InMemoryStore();
  const result = await importExtractedCards(store, [CARD], {
    deck: "English",
    language: "en",
    source: "scan",
  });
  assertEquals(result.imported[0].deck, "English");
  assertEquals(result.imported[0].language, "en");
  assertEquals(result.imported[0].source, "scan");
});
