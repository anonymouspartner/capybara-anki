import { assertEquals } from "jsr:@std/assert@^1";
import { DEFAULT_LEECH_THRESHOLD, isLeechAt } from "./leech.ts";

Deno.test("matches Anki's own leech_threshold unit test (threshold 3)", () => {
  // rslib/src/scheduler/states/review.rs, mod test::leech_threshold
  assertEquals(isLeechAt(0, 3), false);
  assertEquals(isLeechAt(1, 3), false);
  assertEquals(isLeechAt(2, 3), false);
  assertEquals(isLeechAt(3, 3), true);
});

Deno.test("fires again every half threshold, rounding up", () => {
  // threshold 3 -> half is ceil(1.5) = 2, so 3, 5, 7, 9...
  assertEquals([3, 4, 5, 6, 7, 8, 9].map((n) => isLeechAt(n, 3)), [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
  ]);
  // threshold 8 (the default) -> half is 4, so 8, 12, 16...
  assertEquals([8, 9, 10, 11, 12, 15, 16].map((n) => isLeechAt(n, 8)), [
    true,
    false,
    false,
    false,
    true,
    false,
    true,
  ]);
});

Deno.test("a threshold of zero disables leeches entirely", () => {
  for (const lapses of [0, 1, 8, 100]) assertEquals(isLeechAt(lapses, 0), false);
  assertEquals(isLeechAt(50, -1), false);
});

Deno.test("threshold 1 flags every lapse", () => {
  assertEquals([1, 2, 3].map((n) => isLeechAt(n, 1)), [true, true, true]);
});

Deno.test("the default threshold is Anki's", () => {
  assertEquals(DEFAULT_LEECH_THRESHOLD, 8);
  assertEquals(isLeechAt(8), true);
  assertEquals(isLeechAt(7), false);
});
