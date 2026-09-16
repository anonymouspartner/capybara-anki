/**
 * D14/D18's scoring: a transcript versus a note's target text, reduced to one of
 * three honest buckets rather than a percentage that would imply more precision
 * than Whisper-plus-string-comparison actually has.
 *
 * Similarity is normalized Levenshtein distance over lowercased, punctuation-
 * stripped text — crude, but crude is the point (D14's own rationale): a real
 * phoneme assessment would score pronunciation, this only confirms Whisper heard
 * roughly the right words. Good enough to gate "did you say something close to
 * the target," not good enough to pretend otherwise.
 */

import type { PronunciationBucket } from "./types.ts";

const RIGHT_THRESHOLD = 0.85;
const CLOSE_THRESHOLD = 0.55;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Standard edit-distance DP — the number of single-character insertions,
 * deletions, or substitutions to turn `a` into `b`. */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) dist[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1, // deletion
        dist[i][j - 1] + 1, // insertion
        dist[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return dist[rows - 1][cols - 1];
}

/** 1.0 for identical (normalized) strings, 0.0 for maximally different — edit
 * distance scaled by the longer string's length so a similarity threshold means
 * roughly the same thing regardless of target length. */
function similarity(a: string, b: string): number {
  const normA = normalize(a);
  const normB = normalize(b);
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1; // both empty — vacuously identical
  return 1 - levenshtein(normA, normB) / maxLen;
}

export interface ScoreResult {
  transcript: string;
  similarity: number;
  bucket: PronunciationBucket;
  /** D18: the bucket, mapped onto the same 1-4 rating `submitReview` expects, so
   * the client's next call is the exact same `/sync/review` every other card
   * uses. Never 4 (Easy) — a string-similarity check earns "right," not "trivially
   * easy," which real phoneme assessment might justify but this method can't. */
  rating: 1 | 2 | 3;
}

export function scoreAttempt(transcript: string, targetText: string): ScoreResult {
  const sim = similarity(transcript, targetText);
  const bucket: PronunciationBucket = sim >= RIGHT_THRESHOLD ? "right" : sim >= CLOSE_THRESHOLD ? "close" : "wrong";
  const rating = bucket === "right" ? 3 : bucket === "close" ? 2 : 1;
  return { transcript, similarity: sim, bucket, rating };
}
