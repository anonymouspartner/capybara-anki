/** One card extracted from a page photo — the TypeScript mirror of
 * `ukrainian-anki-scanner/claude_parser.py`'s `ExtractedCard`. Not yet a `NewNote`
 * (`src/review/types.ts`): language/deck/source are ingestion-path decisions
 * (`src/scan/import.ts`), not something the model call itself determines. */
export interface ExtractedCard {
  lemma: string;
  gloss: string;
  lemmaTranslation: string;
  partOfSpeech: string;
  example: string;
  exampleTranslation: string;
}

export type PageLanguage = "uk" | "en";

/** One page's cards plus the language the page is printed in, which decides the
 * deck they land in — a page is in one language, so this is per page, not per card. */
export interface PageExtraction {
  language: PageLanguage;
  cards: ExtractedCard[];
}

/** Which of the two languages a text is written in, by script — the same measure
 * capybara-bot uses to tell them apart. null for a text with no letters. */
export function scriptLanguage(text: string): PageLanguage | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return null;
  const cyrillic = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  return cyrillic / letters.length >= 0.5 ? "uk" : "en";
}

/** A page could not be turned into cards. Message is safe to show a user —
 * mirrors `claude_parser.PageExtractionError`. */
export class PageExtractionError extends Error {}
