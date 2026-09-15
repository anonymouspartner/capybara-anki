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
  getDueQueue,
  setSuspended,
  submitReview,
} from "../src/review/handlers.ts";
import { InMemoryStore } from "../src/review/store.ts";
import type { NoteRow } from "../src/review/types.ts";

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
});

// Placeholder vocabulary only — never real corpus content. Chosen to exercise the
// UI's actual field set, not to mean anything.
const demoNotes: NoteRow[] = [
  {
    id: "demo-1", lemma: "приклад", gloss: "example", lemmaTranslation: "example",
    partOfSpeech: "noun", language: "uk",
    example: "Це приклад речення.", exampleTranslation: "This is an example sentence.",
    audioUrl: null,
  },
  {
    id: "demo-2", lemma: "капібара", gloss: "capybara", lemmaTranslation: "capybara",
    partOfSpeech: "noun", language: "uk",
    example: "Капібара — найбільший гризун у світі.",
    exampleTranslation: "The capybara is the world's largest rodent.",
    audioUrl: null,
  },
  {
    id: "demo-3", lemma: "hard", gloss: "difficult", lemmaTranslation: "важкий",
    partOfSpeech: "adj", language: "en",
    example: "That was a hard question.", exampleTranslation: "Це було важке питання.",
    audioUrl: null,
  },
];
for (const note of demoNotes) store.notes.set(note.id, note);

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
      : "application/octet-stream";
    return new Response(file, { headers: { "content-type": contentType } });
  } catch {
    return json({ error: "not found" }, 404);
  }
}

Deno.serve({ port: 8787 }, async (req) => {
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/sync")) return serveStatic(url.pathname);

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${DEMO_TOKEN}`) return json({ error: "unauthorized" }, 401);

  const noteId = url.pathname.match(/\/sync\/note\/([^/]+)$/)?.[1];

  if (req.method === "GET" && url.pathname === "/sync/due") {
    const ids = await getDueQueue(store, DEMO_USER, new Date());
    const notes = await Promise.all(ids.map((id) => store.getNote(id)));
    return json(notes.filter((n): n is NoteRow => n !== null));
  }
  if (req.method === "POST" && url.pathname === "/sync/review") {
    const body = await req.json();
    await submitReview(store, {
      reviewId: body.reviewId, noteId: body.noteId, userId: DEMO_USER,
      rating: body.rating, reviewedAt: new Date(body.reviewedAt),
    });
    return json({ ok: true });
  }
  if (req.method === "POST" && url.pathname === "/sync/suspend") {
    const body = await req.json();
    await setSuspended(store, body.noteId, body.suspended);
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
