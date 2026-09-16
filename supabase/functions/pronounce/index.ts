/**
 * The `/pronounce` edge function — D18's scoring half. Transcribes a recorded
 * attempt via OpenAI Whisper (the same `OPENAI_API_KEY`/`whisper-1` pattern
 * `capybara-bot`'s own voice-message handling already uses) and compares it
 * against the note's target text (`lemma`, per D18's field mapping), producing
 * D14's three-bucket score mapped onto an FSRS rating.
 *
 * Deliberately writes nothing itself: the response is `{ transcript, similarity,
 * bucket, rating }`, and the client takes that `rating` to the exact same
 * `POST /sync/review` every other card uses (with `cardKind: 'recall'` —
 * pronunciation notes never have a spelling card). One path ever mutates
 * `card_state`, not two.
 *
 * **Deployed** (2026-09-16), same real `PostgresStore` as `../sync/index.ts`
 * (`../_shared/postgresStore.ts`, against the live `anki_*` tables) — on an
 * explicit, in-the-moment request, same as that file.
 *
 * Routes:
 *   POST /pronounce/score → { noteId, audioBase64, mediaType } →
 *                            { transcript, similarity, bucket, rating }
 *
 * Auth: the same D13 bearer token as `/sync` and `/scan` (`../../../src/auth.ts`).
 *
 * CORS: see `../sync/index.ts`'s own comment on this — same reasoning, `web/`
 * is a different origin now (GitHub Pages).
 */

import { createWhisperClient, transcribeAudio } from "../../../src/pronunciation/transcribe.ts";
import { scoreAttempt } from "../../../src/pronunciation/score.ts";
import { TranscriptionError } from "../../../src/pronunciation/types.ts";
import type { NoteRow } from "../../../src/review/types.ts";
import { resolveUserId } from "../../../src/auth.ts";
import { PostgresStore } from "../_shared/postgresStore.ts";
import { CORS_HEADERS, corsPreflight } from "../_shared/cors.ts";

/** Only what this function actually needs — reading one note's target text.
 * `PostgresStore` implements the full `Store`, a strict superset of this. */
export interface NoteReader {
  getNote(noteId: string): Promise<NoteRow | null>;
}

function getStore(): NoteReader {
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

interface ScoreBody {
  noteId: string;
  audioBase64: string;
  mediaType: string;
}

async function route(req: Request, store: NoteReader, apiKey: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/pronounce/score") {
    const body: ScoreBody = await req.json();
    if (!body.noteId || !body.audioBase64 || !body.mediaType) {
      return json({ error: "noteId, audioBase64 and mediaType are required" }, 400);
    }

    const note = await store.getNote(body.noteId);
    if (!note) return json({ error: "note not found" }, 404);
    if (note.kind !== "pronunciation") {
      return json({ error: "this note isn't a pronunciation note" }, 400);
    }

    let transcript: string;
    try {
      transcript = await transcribeAudio(
        { base64: body.audioBase64, mediaType: body.mediaType },
        createWhisperClient(apiKey),
        note.language,
      );
    } catch (e) {
      if (e instanceof TranscriptionError) return json({ error: e.message }, 422);
      throw e;
    }

    return json(scoreAttempt(transcript, note.lemma));
  }

  return json({ error: "not found" }, 404);
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  if (!resolveUserId(req)) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "pronunciation scoring is not configured" }, 500);

  try {
    return await route(req, getStore(), apiKey);
  } catch (e) {
    console.error("pronounce: unhandled error", e);
    return json({ error: "internal error" }, 500);
  }
});
