/**
 * Transcribes a recorded pronunciation attempt via OpenAI Whisper — the same
 * `whisper-1`/`audio/transcriptions` call `capybara-bot`'s own voice-message
 * handling already makes (`OPENAI_API_KEY`, `FormData` with `file`/`model`/
 * `response_format: "verbose_json"`/an optional `language` hint), reused
 * deliberately rather than inventing a second way to talk to Whisper.
 */

import { TranscriptionError } from "./types.ts";

const MODEL = "whisper-1";

/** The subset of a Whisper call this module actually needs — narrow on purpose so
 * a test can inject a fake without a real network request, the same reasoning as
 * `src/scan/extract.ts`'s `MessagesClient`. */
export interface TranscribeClient {
  transcribe(audioBlob: Blob, languageHint?: string): Promise<{ text: string; language: string }>;
}

export function createWhisperClient(apiKey: string): TranscribeClient {
  return {
    async transcribe(audioBlob, languageHint) {
      const form = new FormData();
      form.append("file", audioBlob, "attempt.webm");
      form.append("model", MODEL);
      form.append("response_format", "verbose_json");
      if (languageHint) form.append("language", languageHint);

      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
      } catch (e) {
        throw new TranscriptionError(`Could not reach Whisper: ${(e as Error).message}`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        throw new TranscriptionError(`Whisper API error ${res.status}: ${body}`);
      }

      const data = await res.json();
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        throw new TranscriptionError("Whisper returned an empty transcript — try recording again, closer to the mic.");
      }
      return { text, language: typeof data.language === "string" ? data.language : "" };
    },
  };
}

function base64ToBlob(base64: string, mediaType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

export interface AudioAttempt {
  base64: string;
  mediaType: string;
}

/** Decodes the attempt and transcribes it, returning just the text — the caller
 * (`supabase/functions/pronounce/index.ts`) compares it against a note's target
 * text; this module has no opinion about scoring. */
export async function transcribeAudio(
  audio: AudioAttempt,
  client: TranscribeClient,
  languageHint?: string,
): Promise<string> {
  const blob = base64ToBlob(audio.base64, audio.mediaType);
  const { text } = await client.transcribe(blob, languageHint);
  return text;
}
