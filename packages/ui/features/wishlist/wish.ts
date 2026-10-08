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
import { finishLabel, isFinish, type Finish } from "@/lib/finish";
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

/**
 * The finish this wish is **for**, where the app has an enum's word for it.
 *
 * Where the search derives this from the printing's own finish list, a wish simply says it: a
 * wish for the foil is a different wish and is not filled by the nonfoil. `isFinish` guards it
 * because `wishlist_entries.preferred_finish` is TEXT with a CHECK rather than an enum this side
 * knows. No preference answers `null`, which is right — "no preference" is not nonfoil.
 */
export const preferredFinishOf = (wish: WishRow): Finish | null => {
  const preferred = wish.preferredFinish;
  return preferred !== null && isFinish(preferred) ? preferred : null;
};

/**
 * The printing this wish is for **as the wall says it** — which is the table's sentence minus
 * whatever the chin's own glyph is already saying.
 *
 * The wall and the table draw the same fact into two different surroundings, and the right answer
 * differs for that reason alone. The table has no art, no chin and no glyph, so the word is the
 * only statement of the finish there and `printingOf` stays exactly as it is for it. The wall's
 * caption is now the chin's printing line, one gutter away from `FinishMark` — so `LEA · 161 ·
 * Foil ✦` said "Foil" twice, once in a word and once in a glyph whose accessible name is that
 * same word, on the surface with the least room in the app to say anything twice.
 *
 * **The word is dropped exactly where the glyph replaces it, and nowhere else** — which is why
 * this asks {@link preferredFinishOf} rather than testing `preferredFinish` for truthiness:
 *
 * * **`nonfoil` keeps its word.** `FinishMark` returns `null` for it — nonfoil is the finish a
 *   price is assumed to be — so a blanket drop would leave a wish *for the nonfoil* looking
 *   identical to a wish with no preference. Those are two different wishes and the whole of
 *   `WISH_PREFERRED_FINISH`'s note in `wishlist.rs` is that they must not be collapsed.
 * * **A value `isFinish` does not know keeps its word** for the same reason: `tileFinish` hands
 *   `CardGrid` a `null` for it (`WishlistGrid`), so no glyph is drawn and the caption is again the only statement.
 *
 * It is built by handing `printingOf` a row with the finish taken off rather than by rebuilding
 * the `SET · number` half here, so there is still exactly one definition of *which printing* —
 * and **"Any printing" therefore survives untouched**, which is the one thing this caption exists
 * to protect: a wish for the card is drawn as a printing it is not for, and no wall may caption
 * that picture with the cardboard's own name.
 */
export function wallPrinting(wish: WishRow): string {
  const spoken = preferredFinishOf(wish);
  return spoken !== null && spoken !== "nonfoil"
    ? printingOf({ ...wish, preferredFinish: null })
    : printingOf(wish);
}
