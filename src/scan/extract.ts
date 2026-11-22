/**
 * Extracts yellow-highlighted vocabulary from a photo of a book page, Ukrainian or
 * English (the model reports which; translations go into the other) —
 * the TypeScript port of `ukrainian-anki-scanner/claude_parser.py` (docs/DESIGN.md
 * §4.1, D6). Ported almost mechanically: same model, same prompt, the same five
 * failure branches (the two SDKs share an error-class hierarchy closely enough
 * that the mapping is one-to-one).
 *
 * One real thing this port found, checked directly against the actual package
 * rather than assumed from the Python SDK's surface: `@anthropic-ai/sdk@0.39.0`'s
 * `Messages` class has no `.parse()`/structured-output helper (confirmed by
 * fetching and reading its actual export list) — so this uses forced tool-use
 * instead, the one structured-output method the underlying HTTP API supports
 * identically regardless of which SDK convenience methods exist around it.
 *
 * What moved to the browser instead of porting (D8): image prep (EXIF
 * orientation, downscaling). This function receives an already-oriented,
 * already-downscaled JPEG and does no image processing of its own.
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";
import { PageExtractionError, scriptLanguage } from "./types.ts";
import type { ExtractedCard, PageExtraction, PageLanguage } from "./types.ts";

const MODEL = "claude-sonnet-5";
// Thinking is adaptive by default and its tokens count against max_tokens (see
// claude_parser.py's own note on this) — a densely highlighted page needs real
// room for both the reasoning and the cards themselves.
const MAX_TOKENS = 16000;
const MAX_RETRIES = 4;

const SYSTEM_PROMPT =
  "You are a meticulous Ukrainian–English lexicographer building flashcards from " +
  "photos of printed book pages. A page is in Ukrainian or in English. You read " +
  "both accurately — Ukrainian orthography included: the letters і, ї, є and the " +
  "apostrophe — and you never invent a word that is not visible on the page.";

// The page's own language decides which way everything is translated. This was
// Ukrainian-only until 2026-11-22, when an English page was scanned: the prompt
// asked for English translations of what was already English, so each card came
// back with its "translation" a copy of itself, and the import filed it under
// Ukrainian. Nothing failed, which is why it took a person reviewing to notice.
const PROMPT = `Find every word or phrase marked with YELLOW highlighter on this book page.

First decide what language the page is printed in: Ukrainian ("uk") or English ("en").
Every translation you give goes into the OTHER one — a Ukrainian page gets English
translations, an English page gets Ukrainian translations. A translation is never in
the page's own language.

For each highlighted word or phrase:
- Give its lemma (dictionary base form), not the inflected form printed on the page.
- Copy the full sentence it appears in, verbatim from the page, keeping the inflected form.
- Translate that sentence into the other language, and gloss the lemma in the other language.
- If a highlighted run spans several words that work as one unit (a fixed phrase or
  idiom), treat it as a single card with part_of_speech "expression".

Rules:
- Only yellow-highlighted text. Ignore underlining, margin notes, and unmarked text.
- If a word is highlighted more than once on the page, return it once.
- Transcribe exactly what is printed. If a highlighted word is cut off or illegible,
  leave it out rather than guessing.
- If nothing on the page is highlighted, return an empty list of cards.`;

const TOOL_NAME = "record_vocabulary";

// additionalProperties:false plus a full required list, same as the Python side's
// pydantic model, is what makes this schema-strict rather than merely JSON-shaped.
const TOOL_SCHEMA = {
  type: "object",
  properties: {
    page_language: {
      type: "string",
      enum: ["uk", "en"],
      description: "The language the page is printed in: 'uk' for Ukrainian, 'en' for English",
    },
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lemma: {
            type: "string",
            description:
              "Dictionary base form of the highlighted word, in the page's language (e.g. 'письменниця', not 'письменницею'; 'descend', not 'descended'). For a highlighted multi-word expression, the whole expression in its base form.",
          },
          gloss: { type: "string", description: "Short definition or gloss in the OTHER language (not the page's), a few words at most" },
          lemma_translation: {
            type: "string",
            description: "Primary direct translation of the base form into the OTHER language (not the page's)",
          },
          part_of_speech: {
            type: "string",
            description:
              "Lowercase part of speech: noun, verb, adjective, adverb, pronoun, preposition, conjunction, particle, numeral, or expression",
          },
          example: {
            type: "string",
            description:
              "The complete sentence containing the highlighted word, copied verbatim from the page in its original inflected form",
          },
          example_translation: {
            type: "string",
            description: "Accurate translation of the full example sentence into the OTHER language (not the page's)",
          },
        },
        required: ["lemma", "gloss", "lemma_translation", "part_of_speech", "example", "example_translation"],
        additionalProperties: false,
      },
    },
  },
  required: ["page_language", "cards"],
  additionalProperties: false,
};

/** The subset of the SDK's `messages` resource this module actually calls —
 * narrow on purpose so a test can inject a fake without constructing a real
 * `Anthropic` client, the same reasoning as `Store` elsewhere in this repo: the
 * real thing and the test double both just need to satisfy this shape. */
export interface MessagesClient {
  create(params: Record<string, unknown>): Promise<{
    stop_reason: string;
    content: Array<{ type: string; name?: string; input?: unknown }>;
  }>;
}

/** `maxRetries` matches claude_parser.py's own `MAX_RETRIES` passed to the SDK
 * constructor — transport-level retries (429s honour retry-after, 5xx and
 * connection errors back off exponentially) handled by the SDK, not reimplemented
 * here. */
export function createMessagesClient(apiKey: string): MessagesClient {
  // The real SDK's `create` is overloaded on stream/non-stream request shapes,
  // which TypeScript can't structurally match against this interface's
  // deliberately loose `Record<string, unknown>` parameter — the runtime shape is
  // exactly what this module sends either way, so this cast is the adapter
  // boundary, not a hidden type hole.
  return new Anthropic({ apiKey, maxRetries: MAX_RETRIES }).messages as unknown as MessagesClient;
}

interface PageImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png";
}

/** What language a page's cards are in, read off the text itself rather than
 * taken from the model's word for it: the sentences were copied verbatim from the
 * page, so their script IS the page's language. `declared` only breaks the tie
 * for a page with nothing to measure. */
function pageLanguage(cards: ExtractedCard[], declared: unknown): PageLanguage {
  const printed = cards.map((c) => `${c.lemma} ${c.example}`).join(" ");
  return scriptLanguage(printed) ?? (declared === "en" ? "en" : "uk");
}

/** Extracts every highlighted card from one page photo, and the language the
 * page is in. Raises
 * `PageExtractionError` with a message safe to show a user. `Anthropic.
 * AuthenticationError`/`PermissionDeniedError` are left to propagate, exactly
 * claude_parser.py's own contract — a caller processing several pages can then
 * report a bad key once instead of once per page. */
export async function extractVocabularyFromPage(
  image: PageImage,
  client: MessagesClient,
): Promise<PageExtraction> {
  // deno-lint-ignore no-explicit-any
  let response: any;
  try {
    response = await client.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.base64 },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
      tools: [{
        name: TOOL_NAME,
        description: "Record every highlighted vocabulary card found on the page.",
        input_schema: TOOL_SCHEMA,
      }],
      tool_choice: { type: "tool", name: TOOL_NAME },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw e;
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new PageExtractionError(
        "Rate limited by the API even after retrying. Process fewer pages at once, or wait a minute and try again.",
      );
    }
    if (e instanceof Anthropic.APIConnectionError) {
      throw new PageExtractionError(`Could not reach the API: ${(e as Error).message}`);
    }
    if (e instanceof Anthropic.APIError) {
      throw new PageExtractionError(`API error ${e.status}: ${e.message}`);
    }
    throw e;
  }

  // Mirrors claude_parser.py's own truncation check, ahead of looking at content
  // at all: a truncated response is the one failure that can look like success,
  // since a forced tool-use call can still return a syntactically valid-looking
  // (but incomplete) `input` rather than raising on half-written JSON.
  if (response.stop_reason === "max_tokens") {
    throw new PageExtractionError(
      "The response hit the token limit, so this page's cards are incomplete. " +
        "Try photographing fewer highlights per page.",
    );
  }

  const toolUse = response.content.find(
    (block: { type: string; name?: string }) => block.type === "tool_use" && block.name === TOOL_NAME,
  );
  if (!toolUse) {
    throw new PageExtractionError("The model returned no structured output for this page.");
  }

  const input = toolUse.input as { page_language?: unknown; cards: Array<Record<string, string>> };
  const cards: ExtractedCard[] = input.cards.map((card) => ({
    lemma: card.lemma,
    gloss: card.gloss,
    lemmaTranslation: card.lemma_translation,
    partOfSpeech: card.part_of_speech,
    example: card.example,
    exampleTranslation: card.example_translation,
  }));
  return { language: pageLanguage(cards, input.page_language), cards };
}
