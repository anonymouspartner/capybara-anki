import { assertEquals } from "jsr:@std/assert@^1";
import { deckOfCard, notesForDeck } from "./types.ts";

Deno.test("deckOfCard: shared decks split by language, per-language decks stay put", () => {
  assertEquals(deckOfCard("Ukrainian", "recall", "uk"), "Ukrainian");
  assertEquals(deckOfCard("Ukrainian", "spelling", "uk"), "Ukrainian Spelling");
  assertEquals(deckOfCard("English", "spelling", "en"), "English Spelling");
  assertEquals(deckOfCard("Grammar", "recall", "uk"), "Ukrainian Grammar");
  assertEquals(deckOfCard("Grammar", "recall", "en"), "English Grammar");
  assertEquals(deckOfCard("Pronunciation", "recall", "en"), "English Pronunciation");
  // An already-qualified stored name is left alone rather than doubled.
  assertEquals(deckOfCard("English Pronunciation", "recall", "en"), "English Pronunciation");
});

Deno.test("notesForDeck never narrows away a card deckOfCard would place in the deck", () => {
  const notes = [
    { deck: "Ukrainian", language: "uk" as const, hasSpelling: true },
    { deck: "English", language: "en" as const, hasSpelling: true },
    { deck: "Grammar", language: "uk" as const, hasSpelling: false },
    { deck: "Grammar", language: "en" as const, hasSpelling: false },
    { deck: "Pronunciation", language: "uk" as const, hasSpelling: false },
    { deck: "English Pronunciation", language: "en" as const, hasSpelling: false },
  ];
  const decks = new Set<string>();
  for (const n of notes) {
    decks.add(deckOfCard(n.deck, "recall", n.language));
    if (n.hasSpelling) decks.add(deckOfCard(n.deck, "spelling", n.language));
  }
  for (const deck of decks) {
    const scope = notesForDeck(deck);
    for (const n of notes) {
      const kinds = n.hasSpelling ? ["recall", "spelling"] as const : ["recall"] as const;
      const inDeck = kinds.some((k) => deckOfCard(n.deck, k, n.language) === deck);
      const passes = (!scope.language || scope.language === n.language) && (!scope.deck || scope.deck === n.deck);
      if (inDeck) assertEquals(passes, true, `${deck} must not filter out ${n.deck}/${n.language}`);
    }
  }
  assertEquals(notesForDeck("Ukrainian"), { deck: "Ukrainian" });
  assertEquals(notesForDeck("English Spelling"), { language: "en" });
  assertEquals(notesForDeck("Ukrainian Grammar"), { language: "uk" });
});
