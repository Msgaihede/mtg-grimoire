/**
 * Whether a printing is **not out yet**, and the chip the wall draws on one (issues #940, #965).
 *
 * The backend hands every result row its `releasedAt` and draws no conclusion: "unreleased" is a
 * comparison against today, and today is the reader's. The search's `playableOnly` keeps these
 * printings in the corpus by the engine's own UTC date (`filters::unreleased_sql`), so for a few
 * hours either side of midnight the two can disagree by a day — a card that is out in the
 * reader's evening and not yet in UTC, or the other way round. Neither direction hides a card
 * that exists; at worst a chip is a day early or late.
 */

/** `YYYY-MM-DD` in the reader's own time zone — the format Scryfall writes `released_at` in. */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Released strictly after `today`. A card dated today is out, as `upcoming_sets` reads it, and a
 * printing with no date is never unreleased — there is nothing to say it is coming.
 *
 * A string comparison, which is exact for zero-padded ISO dates and is the comparison SQLite makes.
 */
export function isUnreleased(releasedAt: string | null, today: string = localDay()): boolean {
  return releasedAt !== null && releasedAt > today;
}

/**
 * What an unreleased printing is marked with: its set code and its release date, `null` for a
 * printing that is out. Upper-case code, as the table's Set column and the chin print it.
 */
export function unreleasedStamp(
  setCode: string,
  releasedAt: string | null,
  today: string = localDay(),
): { set: string; date: string } | null {
  if (releasedAt === null || !isUnreleased(releasedAt, today)) return null;
  return { set: setCode.toUpperCase(), date: releasedAt };
}

/** The words a chip stands for, for a tooltip or a screen reader. */
export function unreleasedLabel(releasedAt: string): string {
  return `Unreleased — out ${releasedAt}`;
}

/** The words on the card's own chip — short enough for a 0.5× tile's bottom-left corner. */
export function releaseChipLabel(releasedAt: string): string {
  return `Releases ${releasedAt}`;
}
