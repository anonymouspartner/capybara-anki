/**
 * The `/scan` edge function — step 5 (docs/DESIGN.md §9, §4.1). Replaces
 * `ukrainian-anki-scanner`'s Streamlit upload-and-download flow with a straight
 * photo-in, notes-imported round trip: no CSV, no .apkg, no export/import tax
 * (D5). D10: no ingest review step — the extracted cards land in `notes`
 * immediately; `PATCH /sync/note/:id` (edit-in-place, D11) is the repair path for
 * anything the model got wrong.
 *
 * **Deployed** (2026-09-16), same real `PostgresStore` as `../sync/index.ts`
 * and `../pronounce/index.ts` (`../_shared/postgresStore.ts`, against the live
 * `anki_*` tables) — on an explicit, in-the-moment request, same as those files.
 *
 * Routes:
 *   POST /scan/page  → { imageBase64, mediaType, deck?, language? }
 *                       deck/language default to "Ukrainian"/"uk" — this pipeline
 *                       is a Ukrainian book-page scanner (its whole reason to
 *                       exist, per ukrainian-anki-scanner's own scope); the
 *                       override exists for whichever future deck turns out to
 *                       share the vocabulary schema (docs/DESIGN.md §7.5 finding 5).
 *                       Responds with `{ imported, rejected }` (src/scan/import.ts's
 *                       `ImportResult`) so the client can show what actually
 *                       landed, without gating the import on that display (D10).
 *
 * Auth: the same D13 bearer token as `/sync` (`../../../src/auth.ts`) — one device
 * token per person, not a per-request Anthropic key. The Claude API key is this
 * function's own secret (`ANTHROPIC_API_KEY`, capybara-bot's existing naming),
 * never something a client supplies (unlike the Streamlit app's sidebar text box,
 * which existed only because Streamlit has no server-side secret of its own).
 *
 * CORS: see `../sync/index.ts`'s own comment on this — same reasoning, `web/`
 * is a different origin now (GitHub Pages).
 */

import { createMessagesClient, extractVocabularyFromPage } from "../../../src/scan/extract.ts";
import { importExtractedCards, type NoteCreator } from "../../../src/scan/import.ts";
import { PageExtractionError } from "../../../src/scan/types.ts";
import { resolveUserId } from "../../../src/auth.ts";
import { PostgresStore } from "../_shared/postgresStore.ts";
import { CORS_HEADERS, corsPreflight } from "../_shared/cors.ts";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";

function getStore(): NoteCreator {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — see README for local dev");
  }
  return new PostgresStore(url, key);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

interface ScanPageBody {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  deck?: string;
  language?: "uk" | "en";
}

async function route(req: Request, store: NoteCreator, apiKey: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/scan/page") {
    const body: ScanPageBody = await req.json();
    if (!body.imageBase64 || !body.mediaType) {
      return json({ error: "imageBase64 and mediaType are required" }, 400);
    }

    let cards;
    try {
      cards = await extractVocabularyFromPage(
        { base64: body.imageBase64, mediaType: body.mediaType },
        createMessagesClient(apiKey),
      );
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        // The server's own key, not something the client can fix — never surface
        // key details, and log server-side for the maintainer to notice.
        console.error("scan: ANTHROPIC_API_KEY rejected:", e);
        return json({ error: "scanning is temporarily unavailable" }, 500);
      }
      if (e instanceof PageExtractionError) {
        return json({ error: e.message }, 422);
      }
      throw e;
    }

    const result = await importExtractedCards(store, cards, {
      deck: body.deck ?? "Ukrainian",
      language: body.language ?? "uk",
      source: "scan",
    });
    return json(result);
  }

  return json({ error: "not found" }, 404);
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  // Gates access only — a scanned note isn't attributed to whoever scanned it.
  // `notes` is a shared pool (D2), so unlike `/sync` there's no per-user id to
  // thread through to a store call here.
  if (!resolveUserId(req)) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "scanning is not configured" }, 500);

  try {
    return await route(req, getStore(), apiKey);
  } catch (e) {
    console.error("scan: unhandled error", e);
    return json({ error: "internal error" }, 500);
  }
});
