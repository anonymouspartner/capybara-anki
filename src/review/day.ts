/**
 * When one study day ends and the next begins.
 *
 * Everything that counts "today" — the daily new/review limits, the stats
 * histogram, the streak — needs one answer to this, and it is not midnight UTC.
 * Anki's answer, which this matches: a day rolls over at a configurable local
 * hour, 4am by default, and "the current day doesn't count before rollover time"
 * (rslib/src/scheduler/timing.rs). Studying at 1am belongs to the day that just
 * ended, which is what anyone reviewing late at night actually means.
 *
 * This is expressed as a *day key* (`YYYY-MM-DD`) rather than an instant, on
 * purpose: comparing "which day is this review in" only ever needs the key, and
 * keys sidestep the one genuinely hard part of the problem — converting a local
 * wall-clock time back into a UTC instant across a DST seam. Nothing here ever
 * has to do that.
 *
 * DST is why `timeZone` is an IANA name and not a stored UTC offset: Eastern is
 * UTC-4 in July and UTC-5 in December, so an offset would be right for half the
 * year. `Intl` carries the zone database and gets the transitions right.
 */

/** Anki's default, and the reason 4am specifically: it is late enough to catch
 * night-owl reviewing, and early enough that it never lands on a US DST
 * transition (those happen at 2am), so the rollover instant is never ambiguous
 * or missing. */
export const DEFAULT_ROLLOVER_HOUR = 4;

export interface DayBoundary {
  /** IANA zone name (e.g. `America/New_York`). `null` means UTC — the behaviour
   * everything had before this existed, and still the right answer for a config
   * row nobody has set a zone on. */
  timeZone: string | null;
  /** Local hour, 0-23, at which the day rolls over. */
  rolloverHour: number;
}

export const UTC_MIDNIGHT: DayBoundary = { timeZone: null, rolloverHour: 0 };

interface CivilDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/** `hourCycle: "h23"` rather than `hour12: false`: the latter reports midnight as
 * hour 24 in some ICU builds, which would push every midnight-to-1am review into
 * the wrong day. Verified against this runtime before relying on it. */
function zonedParts(instant: Date, timeZone: string): CivilDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

function utcParts(instant: Date): CivilDateTime {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
    hour: instant.getUTCHours(),
  };
}

/** Civil-calendar arithmetic — deliberately not timezone-aware. These are
 * calendar dates, not instants, so "the day before 2026-03-08" is 2026-03-07 no
 * matter what the clocks did that night. */
function civilAddDays(year: number, month: number, day: number, delta: number): string {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Which study day an instant falls in, as `YYYY-MM-DD`.
 *
 * An unknown or malformed zone falls back to UTC rather than throwing: `Intl`
 * raises `RangeError` on a bad zone name, and a stats screen that 500s because
 * someone typed a bad timezone is worse than one that quietly uses UTC.
 */
export function ankiDayKey(instant: Date, boundary: DayBoundary): string {
  const parts = resolveParts(instant, boundary.timeZone);
  return parts.hour < boundary.rolloverHour
    ? civilAddDays(parts.year, parts.month, parts.day, -1)
    : civilAddDays(parts.year, parts.month, parts.day, 0);
}

function resolveParts(instant: Date, timeZone: string | null): CivilDateTime {
  if (timeZone === null) return utcParts(instant);
  try {
    return zonedParts(instant, timeZone);
  } catch {
    return utcParts(instant);
  }
}

/** Step a day key by whole days, for walking a histogram window or a streak
 * backwards. Pure calendar arithmetic, same reasoning as `civilAddDays`. */
export function addDays(dayKey: string, delta: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return civilAddDays(year, month, day, delta);
}
