/**
 * Leeches — cards that keep being forgotten.
 *
 * Anki's idea, ported: once a card has lapsed enough times it stops being worth
 * the time it costs, and it says so rather than letting the card quietly eat
 * review after review forever. This collection has a concrete reason to want it:
 * 56 Again ratings across 3,789 reviews means failure is rare, so the handful of
 * cards producing those failures are exactly the ones worth surfacing, and they
 * are currently invisible among 1,000+ notes.
 *
 * The rule is `leech_threshold_met` from rslib/src/scheduler/states/review.rs,
 * kept exactly, including the part that is easy to miss:
 *
 *     lapses >= threshold && (lapses - threshold) % ceil(threshold / 2) == 0
 *
 * It fires **at** the threshold and then **every half-threshold after**, not
 * once and never again. A card that has lapsed 8, 12, 16 times keeps announcing
 * itself, because a leech that was unsuspended and still isn't sticking is
 * still a leech. Anki's own unit test pins 3 → fires at 3, 5, 7, …, and the
 * test beside this file pins the same sequence.
 *
 * `threshold = 0` disables the check outright, matching Anki.
 */

/** Anki's default (rslib/src/deckconfig/mod.rs). */
export const DEFAULT_LEECH_THRESHOLD = 8;

/**
 * What to do when a card becomes a leech.
 *
 * Anki offers the same two. `'tag'` is the default there and here: suspending
 * is the more drastic of the two, and on a shared couple's collection a card
 * that silently vanishes mid-session is worse than one that announces itself
 * and carries on. There is no tags table in this schema, so `'tag'` means "tell
 * the reviewer, change no scheduling" — the announcement *is* the action.
 */
export type LeechAction = "tag" | "suspend";

export const DEFAULT_LEECH_ACTION: LeechAction = "tag";

/**
 * Whether a card crossing into `lapses` has just become (or re-become) a leech.
 *
 * Takes the lapse count *after* the answer. Callers additionally check that the
 * count actually moved, so a card sitting at 8 lapses doesn't re-announce on
 * every subsequent Good — see `buildReviewMutation`.
 */
export function isLeechAt(lapses: number, threshold: number = DEFAULT_LEECH_THRESHOLD): boolean {
  if (threshold <= 0) return false;
  if (lapses < threshold) return false;
  const halfThreshold = Math.max(Math.ceil(threshold / 2), 1);
  return (lapses - threshold) % halfThreshold === 0;
}
