import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { transcribeAudio, type TranscribeClient } from "./transcribe.ts";
import { TranscriptionError } from "./types.ts";

const AUDIO = { base64: btoa("fake audio bytes"), mediaType: "audio/webm" };

function respondingWith(text: string, language = "uk"): TranscribeClient {
  return {
    // deno-lint-ignore require-await
    transcribe: async () => ({ text, language }),
  };
}

Deno.test("transcribeAudio returns the client's transcript text", async () => {
  const text = await transcribeAudio(AUDIO, respondingWith("Доброго ранку"));
  assertEquals(text, "Доброго ранку");
});

Deno.test("the base64 audio is decoded back to its original bytes before reaching the client", async () => {
  let received: Blob | undefined;
  const client: TranscribeClient = {
    transcribe: async (blob) => {
      received = blob;
      return { text: "ok", language: "uk" };
    },
  };
  await transcribeAudio(AUDIO, client);
  const bytes = new Uint8Array(await received!.arrayBuffer());
  const decoded = new TextDecoder().decode(bytes);
  assertEquals(decoded, "fake audio bytes");
  assertEquals(received!.type, "audio/webm");
});

Deno.test("a language hint is passed through to the client", async () => {
  let receivedHint: string | undefined;
  const client: TranscribeClient = {
    transcribe: async (_blob, hint) => {
      receivedHint = hint;
      return { text: "ok", language: "uk" };
    },
  };
  await transcribeAudio(AUDIO, client, "uk");
  assertEquals(receivedHint, "uk");
});

Deno.test("a transcription failure propagates as TranscriptionError", async () => {
  const client: TranscribeClient = {
    transcribe: () => Promise.reject(new TranscriptionError("Whisper API error 500: boom")),
  };
  await assertRejects(() => transcribeAudio(AUDIO, client), TranscriptionError, "500");
});
