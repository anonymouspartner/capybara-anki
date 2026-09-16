/**
 * Turns a page's extracted cards into real `notes` rows. D10: no ingest review
 * step — scan, extract, import; edit-in-place (D11, `src/review/mutations.ts`'s
 * `validateNoteEdit`) is the only repair path afterward, so this reuses that same
 * validation rather than inventing separate import rules for the same invariant
 * ("a card needs something on its front").
 */

import { validateNoteEdit } from "../review/mutations.ts";
import type { NewNote } from "../review/types.ts";
import type { Store } from "../review/store.ts";
import type { ExtractedCard } from "./types.ts";

/** Only what this module actually calls — a scan-side `Store` can be a real
 * `Store` (tests use `InMemoryStore` directly) or, in the edge function, a
 * `PostgresStore` that only bothers implementing this one method (see
 * `supabase/functions/scan/index.ts`: `/scan` has no reason to also implement
 * `getDueCandidates`/etc. just to satisfy a wider interface it never calls). */
export type NoteCreator = Pick<Store, "createNote">;

export interface ImportOptions {
  deck: string;
  language: "uk" | "en";
  source: NewNote["source"];
}

export interface ImportResult {
  imported: Array<NewNote & { id: string }>;
  rejected: Array<{ card: ExtractedCard; errors: string[] }>;
}

/** Imports every card from one page, skipping (not throwing on) any that fail
 * `validateNoteEdit` — one bad card from a shaky OCR read shouldn't lose the rest
 * of an otherwise-good page. */
export async function importExtractedCards(
  store: NoteCreator,
  cards: ExtractedCard[],
  opts: ImportOptions,
): Promise<ImportResult> {
  const imported: ImportResult["imported"] = [];
  const rejected: ImportResult["rejected"] = [];

  for (const card of cards) {
    const newNote: NewNote = {
      lemma: card.lemma,
      gloss: card.gloss,
      lemmaTranslation: card.lemmaTranslation,
      partOfSpeech: card.partOfSpeech,
      language: opts.language,
      example: card.example,
      exampleTranslation: card.exampleTranslation,
      audioUrl: null,
      deck: opts.deck,
      // The scanner only ever produces plain vocabulary notes — a scanned photo
      // has no way to know a note should get a second Spelling card (D17), and
      // Pronunciation notes (D18) come from a different pipeline entirely.
      kind: "vocab",
      hasSpelling: false,
      source: opts.source,
    };

    const result = validateNoteEdit(newNote);
    if (!result.valid) {
      rejected.push({ card, errors: result.errors });
      continue;
    }

    const id = await store.createNote(newNote);
    imported.push({ ...newNote, id });
  }

  return { imported, rejected };
}
