import { finishLabel } from "@/lib/finish";
import type { WishRow } from "@/lib/ipc";

/**
 * How a wish is read out — the three answers both the page and its table need.
 *
 * `missingOf` is the reason this is a file rather than three helpers in the table: the header's
 * "Still to buy" is summed over what is missing, and the row that says so is drawn by the table.
 * One definition, so the figure and the rows it is summed from cannot disagree on screen.
 */

/**
 * Which printing a wish is for, in the words spec §6 draws the distinction in.
 *
 * A wish with no `card_id` is for the *card*: a shopping list usually means "a Lightning
 * Bolt", not "the one from Alpha". Saying `LEA · 161` there would send the reader hunting a
 * particular piece of cardboard they never asked for.
 */
export function printingOf(row: WishRow): string {
  const printing = row.cardId
    ? `${row.setCode?.toUpperCase() ?? "—"} · ${row.collectorNumber ?? "—"}`
    : "Any printing";
  // Appended rather than given a column of its own: a finish is not a fact about the card,
  // it is the other half of *which* card this wish is for. Absent means no preference, which
  // is not the same as nonfoil and must not be drawn as it.
  return row.preferredFinish ? `${printing} · ${finishLabel(row.preferredFinish)}` : printing;
}

/**
 * The wish, named the way a control has to name it: uniquely.
 *
 * Two wishes for one card differ only by printing and finish, so a stepper called "Copies
 * wanted of Lightning Bolt" would be two identical controls in one list as far as a screen
 * reader or a voice driver is concerned.
 */
export function wishLabel(row: WishRow): string {
  const printing = row.cardId
    ? `${row.setCode?.toUpperCase() ?? "—"} ${row.collectorNumber ?? "—"}`
    : "any printing";
  const finish = row.preferredFinish ? `, ${finishLabel(row.preferredFinish)}` : "";
  return `${row.name} (${printing}${finish})`;
}

/** Copies still to find. Never negative: a wish over-covered is covered, not owed. */
export function missingOf(row: WishRow): number {
  return Math.max(0, row.quantity - row.ownedQuantity);
}
