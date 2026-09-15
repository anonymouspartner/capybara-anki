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
): [MessagesClient, { params?: Record<string, unknown> }] {
  const captured: { params?: Record<string, unknown> } = {};
  const client: MessagesClient = {
    // deno-lint-ignore require-await
    create: async (params) => {
      captured.params = params;
      return {
        stop_reason: stopReason,
        content: [{ type: "tool_use", name: "record_vocabulary", input: { cards } }],
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
  const [card] = await extractVocabularyFromPage(IMAGE, respondingWith([CARD])[0]);
  assertEquals(card.lemma, CARD.lemma);
  assertEquals(card.lemmaTranslation, CARD.lemma_translation);
  assertEquals(card.partOfSpeech, CARD.part_of_speech);
  assertEquals(card.exampleTranslation, CARD.example_translation);
});

Deno.test("a page with no highlights yields no cards", async () => {
  const cards = await extractVocabularyFromPage(IMAGE, respondingWith([])[0]);
  assertEquals(cards, []);
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
