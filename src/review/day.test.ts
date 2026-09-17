import { assertEquals } from "jsr:@std/assert@^1";
import { addDays, ankiDayKey, DEFAULT_ROLLOVER_HOUR, type DayBoundary, UTC_MIDNIGHT } from "./day.ts";

const EASTERN: DayBoundary = { timeZone: "America/New_York", rolloverHour: DEFAULT_ROLLOVER_HOUR };

Deno.test("the rollover hour, not midnight, ends the day", () => {
  // 3:59am Eastern still belongs to the previous day; 4:00am starts the new one.
  // EDT in September, so 4am local is 08:00Z.
  assertEquals(ankiDayKey(new Date("2026-09-17T07:59:00Z"), EASTERN), "2026-09-16");
  assertEquals(ankiDayKey(new Date("2026-09-17T08:00:00Z"), EASTERN), "2026-09-17");
});

Deno.test("reviewing late at night counts toward the evening, not the next morning", () => {
  // The case that made the streak read 0: 11pm and 1am on the same sitting have
  // to land in the same bucket. 2026-09-16 23:00 EDT = 2026-09-17T03:00Z, and
  // 2026-09-17 01:00 EDT = 2026-09-17T05:00Z — different UTC days, same study day.
  const beforeMidnight = new Date("2026-09-17T03:00:00Z");
  const afterMidnight = new Date("2026-09-17T05:00:00Z");
  assertEquals(ankiDayKey(beforeMidnight, EASTERN), "2026-09-16");
  assertEquals(ankiDayKey(afterMidnight, EASTERN), "2026-09-16");
  assertEquals(ankiDayKey(beforeMidnight, EASTERN), ankiDayKey(afterMidnight, EASTERN));
});

Deno.test("the same instant lands in different days under UTC and Eastern", () => {
  // Precisely the bug: at 8pm Eastern it is already tomorrow in UTC, so the UTC
  // bucketing credited an evening's reviews to a day that hadn't started yet.
  const eveningEastern = new Date("2026-09-17T00:30:00Z"); // 2026-09-16 20:30 EDT
  assertEquals(ankiDayKey(eveningEastern, UTC_MIDNIGHT), "2026-09-17");
  assertEquals(ankiDayKey(eveningEastern, EASTERN), "2026-09-16");
});

Deno.test("DST: the rollover follows the wall clock across both seams", () => {
  // Eastern is UTC-4 in summer and UTC-5 in winter, so a stored offset would be
  // wrong for half the year. 4am local is 08:00Z in July, 09:00Z in December.
  assertEquals(ankiDayKey(new Date("2026-07-01T07:59:00Z"), EASTERN), "2026-06-30");
  assertEquals(ankiDayKey(new Date("2026-07-01T08:00:00Z"), EASTERN), "2026-07-01");

  assertEquals(ankiDayKey(new Date("2026-12-01T08:59:00Z"), EASTERN), "2026-11-30");
  assertEquals(ankiDayKey(new Date("2026-12-01T09:00:00Z"), EASTERN), "2026-12-01");
});

Deno.test("DST: spring forward — the day the clocks skip 2am is still one day", () => {
  // 2026-03-08: 2am EST jumps to 3am EDT. 4am is chosen partly because it is
  // safely past that, so the rollover instant neither goes missing nor repeats.
  assertEquals(ankiDayKey(new Date("2026-03-08T06:59:00Z"), EASTERN), "2026-03-07"); // 1:59am EST
  assertEquals(ankiDayKey(new Date("2026-03-08T08:00:00Z"), EASTERN), "2026-03-08"); // 4:00am EDT
  // ...and the 23-hour day still advances by exactly one calendar day.
  assertEquals(addDays(ankiDayKey(new Date("2026-03-08T08:00:00Z"), EASTERN), -1), "2026-03-07");
});

Deno.test("DST: fall back — the repeated 1am hour doesn't produce a repeated day", () => {
  // 2026-11-01: 2am EDT falls back to 1am EST, so 1am happens twice. Both
  // instances are before the 4am rollover, so both belong to Oct 31.
  assertEquals(ankiDayKey(new Date("2026-11-01T05:00:00Z"), EASTERN), "2026-10-31"); // 1am EDT
  assertEquals(ankiDayKey(new Date("2026-11-01T06:00:00Z"), EASTERN), "2026-10-31"); // 1am EST again
  assertEquals(ankiDayKey(new Date("2026-11-01T09:00:00Z"), EASTERN), "2026-11-01"); // 4am EST
});

Deno.test("midnight reports as hour 0, not hour 24", () => {
  // Some ICU builds report midnight as hour 24 under hour12:false, which would
  // push every midnight review a day forward. day.ts uses hourCycle h23; this is
  // the test that keeps that true.
  assertEquals(ankiDayKey(new Date("2026-09-17T04:00:00Z"), EASTERN), "2026-09-16"); // 00:00 EDT
  assertEquals(ankiDayKey(new Date("2026-09-17T00:00:00Z"), UTC_MIDNIGHT), "2026-09-17");
});

Deno.test("a null timezone means UTC — what every row meant before this existed", () => {
  const boundary: DayBoundary = { timeZone: null, rolloverHour: 0 };
  assertEquals(ankiDayKey(new Date("2026-09-17T00:00:00Z"), boundary), "2026-09-17");
  assertEquals(ankiDayKey(new Date("2026-09-17T23:59:59Z"), boundary), "2026-09-17");
});

Deno.test("an unusable timezone falls back to UTC instead of throwing", () => {
  // Intl raises RangeError on an unknown zone. A stats screen that 500s because
  // someone typed a bad timezone is worse than one that quietly uses UTC.
  const broken: DayBoundary = { timeZone: "Not/AZone", rolloverHour: 0 };
  assertEquals(ankiDayKey(new Date("2026-09-17T12:00:00Z"), broken), "2026-09-17");
});

Deno.test("rolloverHour 0 reproduces plain local-midnight bucketing", () => {
  const midnightEastern: DayBoundary = { timeZone: "America/New_York", rolloverHour: 0 };
  assertEquals(ankiDayKey(new Date("2026-09-17T03:59:00Z"), midnightEastern), "2026-09-16"); // 11:59pm
  assertEquals(ankiDayKey(new Date("2026-09-17T04:00:00Z"), midnightEastern), "2026-09-17"); // 12:00am
});

Deno.test("addDays crosses month and year boundaries on the calendar, not the clock", () => {
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
  assertEquals(addDays("2026-01-01", -1), "2025-12-31");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addDays("2024-03-01", -1), "2024-02-29"); // leap year
  assertEquals(addDays("2026-09-17", 0), "2026-09-17");
});

Deno.test("Ukraine and Eastern disagree about which day an instant is in", () => {
  // Why the timezone is per-user and not per-instance: this app's two people are
  // an English/Ukrainian couple, and at 9pm Eastern it is already tomorrow
  // morning in Kyiv.
  const kyiv: DayBoundary = { timeZone: "Europe/Kyiv", rolloverHour: DEFAULT_ROLLOVER_HOUR };
  const instant = new Date("2026-09-17T01:00:00Z"); // 9pm Sep 16 EDT, 4am Sep 17 in Kyiv
  assertEquals(ankiDayKey(instant, EASTERN), "2026-09-16");
  assertEquals(ankiDayKey(instant, kyiv), "2026-09-17");
});
