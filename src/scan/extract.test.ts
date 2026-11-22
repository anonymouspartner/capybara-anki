import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { extractVocabularyFromPage, type MessagesClient } from "./extract.ts";
import { PageExtractionError } from "./types.ts";

const CARD = {
  lemma: "письменниця",
  gloss: "female writer",
  lemma_translation: "writer",
  part_of_speech: "noun",
  example: "Вона була відомою письменницею.",
  example_translation: "She was a famous writer.",
};

const IMAGE = { base64: "ZmFrZQ==", mediaType: "image/jpeg" as const };

/** Returns `[client, capturedParams]` — `capturedParams` fills in once the client
 * has actually been called, so a test can assert on it after awaiting the call. */
function respondingWith(
  cards: Array<Record<string, string>>,
  stopReason = "end_turn",
  pageLanguage: string | undefined = "uk",
): [MessagesClient, { params?: Record<string, unknown> }] {
  const captured: { params?: Record<string, unknown> } = {};
  const client: MessagesClient = {
    // deno-lint-ignore require-await
    create: async (params) => {
      captured.params = params;
      return {
        stop_reason: stopReason,
        content: [{ type: "tool_use", name: "record_vocabulary", input: { page_language: pageLanguage, cards } }],
      };
    },
  };
  return [client, captured];
}

function throwing(error: unknown): MessagesClient {
  return {
    create: () => Promise.reject(error),
  };
}

Deno.test("the request carries the image and a schema-strict tool definition", async () => {
  const [client, captured] = respondingWith([CARD]);
  await extractVocabularyFromPage(IMAGE, client);
  const params = captured.params!;

  assertEquals(params.model, "claude-sonnet-5");
  // deno-lint-ignore no-explicit-any
  const content = (params.messages as any[])[0].content;
  assertEquals(content[0].type, "image");
  assertEquals(content[0].source.media_type, "image/jpeg");

  // deno-lint-ignore no-explicit-any
  const tool = (params.tools as any[])[0];
  const cardSchema = tool.input_schema.properties.cards.items;
  assertEquals(cardSchema.additionalProperties, false);
  assertEquals(
    new Set(cardSchema.required),
    new Set(["lemma", "gloss", "lemma_translation", "part_of_speech", "example", "example_translation"]),
  );
});

Deno.test("an extracted card's fields map from the tool's snake_case to camelCase", async () => {
  const { cards: [card] } = await extractVocabularyFromPage(IMAGE, respondingWith([CARD])[0]);
  assertEquals(card.lemma, CARD.lemma);
  assertEquals(card.lemmaTranslation, CARD.lemma_translation);
  assertEquals(card.partOfSpeech, CARD.part_of_speech);
  assertEquals(card.exampleTranslation, CARD.example_translation);
});

Deno.test("a page with no highlights yields no cards", async () => {
  const { cards } = await extractVocabularyFromPage(IMAGE, respondingWith([])[0]);
  assertEquals(cards, []);
});

const EN_CARD = {
  lemma: "sorrow",
  gloss: "глибокий сум",
  lemma_translation: "скорбота",
  part_of_speech: "noun",
  example: "How shall I go in peace and without sorrow?",
  example_translation: "Як мені піти з миром і без скорботи?",
};

Deno.test("a Ukrainian page is reported as Ukrainian, an English page as English", async () => {
  assertEquals((await extractVocabularyFromPage(IMAGE, respondingWith([CARD])[0])).language, "uk");
  assertEquals(
    (await extractVocabularyFromPage(IMAGE, respondingWith([EN_CARD], "end_turn", "en")[0])).language,
    "en",
  );
});

Deno.test("the page's language is read off the text, not taken on the model's word", async () => {
  // The exact shape of the 2026-11-22 failure: English sentences, labelled Ukrainian.
  const page = await extractVocabularyFromPage(IMAGE, respondingWith([EN_CARD], "end_turn", "uk")[0]);
  assertEquals(page.language, "en");
});

Deno.test("the prompt asks for the page's language and translation into the other one", async () => {
  const [client, captured] = respondingWith([CARD]);
  await extractVocabularyFromPage(IMAGE, client);
  // deno-lint-ignore no-explicit-any
  const tool = (captured.params!.tools as any[])[0];
  assertEquals(tool.input_schema.properties.page_language.enum, ["uk", "en"]);
  assertEquals(tool.input_schema.required.includes("page_language"), true);
});

Deno.test("a truncated response is reported rather than silently returned short", async () => {
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, respondingWith([CARD], "max_tokens")[0]),
    PageExtractionError,
    "token limit",
  );
});

Deno.test("a bad API key propagates so the caller can report it once, not wrapped", async () => {
  const err = new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", {} as any);
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, throwing(err)),
    Anthropic.AuthenticationError,
  );
});

Deno.test("a server error becomes a readable message", async () => {
  const err = new Anthropic.InternalServerError(500, undefined, "boom", {} as any);
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, throwing(err)),
    PageExtractionError,
    "500",
  );
});

Deno.test("a rate limit after retries explains what to do", async () => {
  const err = new Anthropic.RateLimitError(429, undefined, "slow down", {} as any);
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, throwing(err)),
    PageExtractionError,
    "Rate limited",
  );
});

Deno.test("a connection failure becomes a readable message", async () => {
  const err = new Anthropic.APIConnectionError({ message: "network unreachable" });
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, throwing(err)),
    PageExtractionError,
    "Could not reach the API",
  );
});

Deno.test("no tool_use block in the response is reported, not silently empty", async () => {
  const client: MessagesClient = {
    // deno-lint-ignore require-await
    create: async () => ({ stop_reason: "end_turn", content: [{ type: "text" }] }),
  };
  await assertRejects(
    () => extractVocabularyFromPage(IMAGE, client),
    PageExtractionError,
    "no structured output",
  );
});
