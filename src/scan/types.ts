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

/** A page could not be turned into cards. Message is safe to show a user —
 * mirrors `claude_parser.PageExtractionError`. */
export class PageExtractionError extends Error {}
