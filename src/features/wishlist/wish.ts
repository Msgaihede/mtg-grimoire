/**
 * How a wish is read out — the two answers every surface that draws one needs.
 *
 * A file rather than two helpers in the table because the wall, the table and the panel behind a
 * tile's pencil all name the same wish, and a wish is named by *which printing* it is for: two
 * wishes for one card differ only by that and by the finish. One definition, so no two surfaces
 * can spell one wish two ways.
 *
 * **Nothing here asks what the reader already owns, and that is the rule rather than an
 * omission.** A wishlist is the reader's own list: they take a card off it when they acquire
 * one, so no figure on this page is a subtraction against `collection_entries`. `missingOf`
 * lived here until then, and the whole of what it computed — copies wanted minus copies owned —
 * is now simply copies wanted.
 */
import { finishLabel } from "@/lib/finish";
import type { WishRow } from "@/lib/ipc";

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
