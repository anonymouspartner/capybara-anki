import { assertEquals } from "jsr:@std/assert@^1";
import { scoreAttempt } from "./score.ts";

Deno.test("an exact match scores 'right'", () => {
  const result = scoreAttempt("Доброго ранку", "Доброго ранку");
  assertEquals(result.bucket, "right");
  assertEquals(result.rating, 3);
  assertEquals(result.similarity, 1);
});

Deno.test("case and punctuation differences don't count against a match", () => {
  const result = scoreAttempt("доброго, ранку!", "Доброго ранку");
  assertEquals(result.bucket, "right");
});

Deno.test("a close-but-imperfect attempt scores 'close', not 'right' or 'wrong'", () => {
  // Similarity ~0.62 — recognizably an attempt at the target, well short of a
  // match but nowhere near unrelated.
  const result = scoreAttempt("Добре ранок", "Доброго ранку");
  assertEquals(result.bucket, "close");
  assertEquals(result.rating, 2);
});

Deno.test("a completely different transcript scores 'wrong'", () => {
  const result = scoreAttempt("капібара любить воду", "Доброго ранку");
  assertEquals(result.bucket, "wrong");
  assertEquals(result.rating, 1);
});

Deno.test("scoring never produces a rating of 4 (Easy) — this method can't earn that confidence", () => {
  const result = scoreAttempt("Доброго ранку", "Доброго ранку");
  if ((result.rating as number) === 4) throw new Error("expected rating to never be Easy");
});

Deno.test("extra whitespace is normalized away", () => {
  const result = scoreAttempt("  Доброго   ранку  ", "Доброго ранку");
  assertEquals(result.bucket, "right");
});

Deno.test("two empty strings are vacuously identical, not a divide-by-zero crash", () => {
  const result = scoreAttempt("", "");
  assertEquals(result.similarity, 1);
});
