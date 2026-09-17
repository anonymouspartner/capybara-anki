/**
 * Local-only demo server — NOT part of the deployed app, NOT `supabase/functions/
 * sync/`. Serves web/'s static files and the same JSON shapes /sync would, backed
 * by InMemoryStore with placeholder vocabulary (never real corpus content — this
 * file is committed and public).
 *
 * Exists to make web/app.js verifiable by actually running it, the same way the
 * migration CLI and FSRS replay were verified against real behavior rather than
 * left as code nobody had run. It is not a substitute for the real Postgres store
 * (supabase/functions/sync/index.ts's PostgresStore, not yet implemented) — it
 * proves the frontend works against the real handlers.ts/dueQueue.ts/mutations.ts,
 * nothing about Postgres itself.
 *
 * Run: deno run --allow-net --allow-read web/demo-server.ts
 * Then open the URL it prints — it includes the demo token in the fragment,
 * matching exactly how a real install link works (D13, §4.5).
 */

import {
  deleteNote,
  editNote,
  getDeckSummaries,
  getDueQueueWithPreviews,
  getStats,
  setSuspended,
  submitReview,
} from "../src/review/handlers.ts";
import { cardKey, InMemoryStore } from "../src/review/store.ts";
import type { CardStateRow, NoteRow } from "../src/review/types.ts";
import { importExtractedCards } from "../src/scan/import.ts";
import type { ExtractedCard } from "../src/scan/types.ts";
import { scoreAttempt } from "../src/pronunciation/score.ts";

const DEMO_TOKEN = "demo-token";
const DEMO_USER = "demo-user";

const store = new InMemoryStore();
store.schedulerConfigs.set(DEMO_USER, {
  userId: DEMO_USER,
  fsrsParams: [],
  desiredRetention: 0.9,
  learningSteps: [1, 10],
  dailyNewLimit: 40,
  dailyReviewLimit: 200,
  maxInterval: 36500,
  // The demo has no real person behind it, so it keeps the UTC fallback rather
  // than pretending to be somewhere.
  timeZone: null,
  rolloverHour: 4,
});

// Placeholder vocabulary only — never real corpus content. Chosen to exercise the
// UI's actual field set (four decks, D17's spelling card, D18's pronunciation
// note) — not to mean anything.
const demoNotes: NoteRow[] = [
  {
    id: "demo-1", lemma: "приклад", gloss: "example", lemmaTranslation: "example",
    partOfSpeech: "noun", language: "uk", deck: "Ukrainian",
    example: "Це приклад речення.", exampleTranslation: "This is an example sentence.",
    audioUrl: null, kind: "vocab", hasSpelling: false,
  },
  {
    id: "demo-2", lemma: "капібара", gloss: "capybara", lemmaTranslation: "capybara",
    partOfSpeech: "noun", language: "uk", deck: "Ukrainian",
    example: "Капібара — найбільший гризун у світі.",
    exampleTranslation: "The capybara is the world's largest rodent.",
    audioUrl: null, kind: "vocab", hasSpelling: false,
  },
  {
    id: "demo-3", lemma: "again", gloss: "one more time", lemmaTranslation: "знову",
    partOfSpeech: "adv", language: "uk", deck: "Ukrainian",
    example: "Спробуй ще раз.", exampleTranslation: "Try again.",
    audioUrl: null, kind: "vocab", hasSpelling: false,
  },
  {
    id: "demo-4", lemma: "hard", gloss: "difficult", lemmaTranslation: "важкий",
    partOfSpeech: "adj", language: "en", deck: "English",
    example: "That was a hard question.", exampleTranslation: "Це було важке питання.",
    audioUrl: null, kind: "vocab", hasSpelling: false,
  },
  // D17: a Capybara+-like note — real Anki data confirms notes like this produce
  // two independently-scheduled cards. hasSpelling gives it a second due item
  // without a second row in `notes`.
  {
    id: "demo-5", lemma: "письменниця", gloss: "female writer", lemmaTranslation: "writer",
    partOfSpeech: "noun", language: "uk", deck: "Ukrainian",
    example: "Вона відома письменниця.", exampleTranslation: "She is a famous writer.",
    audioUrl: null, kind: "vocab", hasSpelling: true,
  },
  // D17: plain vocabulary notes filed under Grammar need nothing special —
  // confirmed against a real export to share this exact schema.
  {
    id: "demo-6", lemma: "б", gloss: "conditional particle", lemmaTranslation: "would",
    partOfSpeech: "particle", language: "uk", deck: "Grammar",
    example: "Я б пішов.", exampleTranslation: "I would go.",
    audioUrl: null, kind: "vocab", hasSpelling: false,
  },
  // D18: a pronunciation note — same columns, reused: lemma<-TargetText,
  // lemmaTranslation<-Translation, gloss<-Hint, audioUrl<-ReferenceAudio.
  {
    id: "demo-7", lemma: "Доброго ранку", gloss: "a morning greeting", lemmaTranslation: "Good morning",
    partOfSpeech: null, language: "uk", deck: "Pronunciation",
    example: null, exampleTranslation: null,
    audioUrl: null, kind: "pronunciation", hasSpelling: false,
  },
];
for (const note of demoNotes) store.notes.set(note.id, note);

// One already-reviewed, currently-due card, so the deck list and review flow both
// have more than "all new" to show.
const dueYesterday: CardStateRow = {
  noteId: "demo-3", cardKind: "recall", due: new Date(Date.now() - 86_400_000), stability: 4.2,
  difficulty: 5.6, state: 2, reps: 2, lapses: 0,
  lastReview: new Date(Date.now() - 5 * 86_400_000), suspended: false, lastUserId: DEMO_USER,
};
store.cardStates.set(cardKey("demo-3", "recall"), dueYesterday);

// A handful of backdated reviews purely for the stats screen demo (step 6) — never
// real study history, just enough days of activity that the histogram/streak/
// success-rate show real shapes on first load instead of an all-zero screen.
// Inserted directly into the map (not via submitReview) since these predate
// "today" and so can't affect today's daily new/review limits either way.
const DAY_MS = 86_400_000;
for (let i = 0; i < 6; i++) {
  store.reviews.set(`demo-review-${i}`, {
    id: `demo-review-${i}`,
    noteId: "demo-3",
    cardKind: "recall",
    userId: DEMO_USER,
    rating: i === 2 ? 1 : 3, // one Again in the middle, Good otherwise
    reviewedAt: new Date(Date.now() - i * DAY_MS),
    elapsedDays: 1,
    scheduledDays: 1,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function serveStatic(pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;
  try {
    const file = await Deno.readFile(new URL(`.${path}`, import.meta.url));
    const contentType = path.endsWith(".js")
      ? "text/javascript"
      : path.endsWith(".html")
      ? "text/html"
      : path.endsWith(".css")
      ? "text/css"
      : "application/octet-stream";
    return new Response(file, { headers: { "content-type": contentType } });
  } catch {
    return json({ error: "not found" }, 404);
  }
}

Deno.serve({ port: 8787 }, async (req) => {
  const url = new URL(req.url);

  // web/config.js sends every real API call to the production Supabase project
  // (a different origin) except when running against this demo server, where
  // it deliberately uses bare same-origin paths instead — this server serves
  // both the static shell and a fake API from one process, so there's no
  // cross-origin/prefix concern to model here at all.
  //
  // "/scan/" (trailing slash), not a bare "/scan" prefix — "/scan.html"/"/scan.js"
  // are static files this same check would otherwise wrongly route into the
  // auth-gated API branch below (caught by curling them directly, not by eye).
  const apiPrefixes = ["/sync/", "/scan/", "/pronounce/"];
  if (!apiPrefixes.some((p) => url.pathname.startsWith(p))) {
    return serveStatic(url.pathname);
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${DEMO_TOKEN}`) return json({ error: "unauthorized" }, 401);

  const noteId = url.pathname.match(/\/sync\/note\/([^/]+)$/)?.[1];

  if (req.method === "POST" && url.pathname === "/scan/page") {
    const body = await req.json();
    if (!body.imageBase64 || !body.mediaType) {
      return json({ error: "imageBase64 and mediaType are required" }, 400);
    }
    // No real Claude call in the demo (extractVocabularyFromPage is unit-tested
    // against a fake client in src/scan/extract.test.ts) — a canned card stands in
    // so the rest of the pipeline (importExtractedCards, the same code the real
    // edge function calls) is verifiable end-to-end without an API key.
    const cannedCards: ExtractedCard[] = [{
      lemma: "сторінка",
      gloss: "page",
      lemmaTranslation: "page",
      partOfSpeech: "noun",
      example: "Відкрий цю сторінку.",
      exampleTranslation: "Open this page.",
    }];
    const result = await importExtractedCards(store, cannedCards, {
      deck: body.deck ?? "Ukrainian",
      language: body.language ?? "uk",
      source: "scan",
    });
    return json(result);
  }

  if (req.method === "POST" && url.pathname === "/pronounce/score") {
    const body = await req.json();
    if (!body.noteId || !body.audioBase64 || !body.mediaType) {
      return json({ error: "noteId, audioBase64 and mediaType are required" }, 400);
    }
    const note = await store.getNote(body.noteId);
    if (!note) return json({ error: "note not found" }, 404);
    // No real Whisper call in the demo (transcribeAudio is unit-tested separately
    // against a fake client in src/pronunciation/transcribe.test.ts) — scoreAttempt
    // itself is real, just fed a canned "perfect" transcript so the record → score
    // → continue flow is verifiable without a microphone or an API key.
    return json(scoreAttempt(note.lemma, note.lemma));
  }

  if (req.method === "GET" && url.pathname === "/sync/decks") {
    return json(await getDeckSummaries(store, DEMO_USER, new Date()));
  }
  if (req.method === "GET" && url.pathname === "/sync/due") {
    const deck = url.searchParams.get("deck") ?? undefined;
    return json(await getDueQueueWithPreviews(store, DEMO_USER, new Date(), deck));
  }
  if (req.method === "GET" && url.pathname === "/sync/stats") {
    const daysParam = Number(url.searchParams.get("days"));
    const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : undefined;
    return json(await getStats(store, DEMO_USER, new Date(), days));
  }
  if (req.method === "POST" && url.pathname === "/sync/review") {
    const body = await req.json();
    await submitReview(store, {
      reviewId: body.reviewId, noteId: body.noteId, cardKind: body.cardKind ?? "recall", userId: DEMO_USER,
      rating: body.rating, reviewedAt: new Date(body.reviewedAt),
    });
    return json({ ok: true });
  }
  if (req.method === "POST" && url.pathname === "/sync/suspend") {
    const body = await req.json();
    await setSuspended(store, body.noteId, body.cardKind ?? "recall", body.suspended);
    return json({ ok: true });
  }
  if (req.method === "PATCH" && noteId) {
    return json(await editNote(store, noteId, await req.json()));
  }
  if (req.method === "DELETE" && noteId) {
    await deleteNote(store, noteId);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
});

console.log(`Demo running: http://localhost:8787/#t=${DEMO_TOKEN}`);
