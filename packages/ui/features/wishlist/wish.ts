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
 * is now simply copies wanted. {@link collectionQueryOf} is the one reader of the collection here,
 * and it subtracts nothing: it names the copies the owned chips report, so a press can show them.
 */
import { shelfFolderOf } from "@/features/collection/collectionShelfModel";
import { finishLabel, isFinish, type Finish } from "@/lib/finish";
import { trailOf } from "@/lib/folderTree";
import type { CollectionFolder, WishOwnedPlace, WishRow } from "@/lib/ipc";
import { UNFILED_NAME, type ShelfKind } from "@/lib/shelves";

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

/**
 * Which of a wish's owned copies a chip is about (issue #988): the printing the wish is for, or
 * the same card in another printing. An any-printing wish is answered by every printing, so all
 * its copies are `"exact"`. `"card"` is both together — the in-use chip's reading when its copies
 * span printings (issue #1054).
 */
export type OwnedSide = "exact" | "other" | "card";

/** A value the query box reads as one token — quoted when it holds a space, with whichever quote
 *  it does not contain (`unquote` in `queryLanguage.ts` takes either). */
export function queryToken(value: string): string {
  if (!/[\s"'()]/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/**
 * The collection search that shows the copies one of a wish's owned chips counts — in the box's
 * own syntax, so the reader lands on a filter they can read and edit rather than on a hidden one.
 *
 * `!name` is the card (both faces of a double-faced one, `exact_name_clause`), and a pinned
 * wish's printing is its set, number and language. `"other"` is the card minus that printing, as
 * one negated group, and `"card"` is the card in every printing. A pinned wish missing its set or
 * number names the card alone rather than guess a printing.
 */
export function collectionQueryOf(wish: WishRow, side: OwnedSide): string {
  const card = `!${queryToken(wish.name)}`;
  if (side === "card") return card;
  if (wish.cardId === null || wish.setCode === null || wish.collectorNumber === null) return card;
  const printing = [
    `e:${queryToken(wish.setCode)}`,
    `cn:${queryToken(wish.collectorNumber)}`,
    ...(wish.lang ? [`lang:${queryToken(wish.lang)}`] : []),
  ].join(" ");
  return side === "exact" ? `${card} ${printing}` : `${card} -(${printing})`;
}

/** One collection folder holding some of the copies an owned chip counts (issue #1055). */
export interface OwnedPlace {
  /** The collection folder's id, or `null` for `Not sorted`. */
  folderId: number | null;
  /** The shelf glyph the collection's own walls draw this folder with. */
  kind: ShelfKind;
  /** Its names from the root of the collection — `["Binder", "Staples"]`, or `["Not sorted"]`. */
  path: string[];
  count: number;
}

/** `shelfFolderOf` asks for the effective locks; a glyph does not depend on them. */
const NO_LOCKS: ReadonlySet<number> = new Set();

/**
 * Where the copies one of a wish's owned chips counts are filed, in the collection's own words
 * (issue #1055) — {@link WishRow.ownedPlaces} for one side, with each folder's path named from
 * the collection's folder list, the most copies first and then by path.
 *
 * The glyph is `shelfFolderOf`'s mapping (`user` a folder, `deck` a deck's group, any other kind
 * app-owned), so a chip's tooltip draws a drawer with the mark its shelf heading has.
 *
 * `held` narrows to the places that are (or are not) free to use (issue #1054) —
 * {@link WishOwnedPlace.held}; absent reads every place.
 *
 * **A folder the list does not know is left out rather than guessed at** — the list not having
 * answered yet, or a folder deleted between the two reads. Its copies are still in the chip's
 * count; the tooltip only declines to name a drawer it cannot.
 */
export function ownedPlacesOf(
  wish: Pick<WishRow, "ownedPlaces">,
  side: OwnedSide,
  folders: readonly CollectionFolder[],
  held?: boolean,
): OwnedPlace[] {
  const places: OwnedPlace[] = [];
  for (const place of wish.ownedPlaces) {
    if (held !== undefined && place.held !== held) continue;
    const count = placeCount(place, side);
    if (count <= 0) continue;
    if (place.folderId === null) {
      places.push({ folderId: null, kind: "unfiled", path: [UNFILED_NAME], count });
      continue;
    }
    const trail = trailOf(folders, place.folderId);
    const folder = trail[trail.length - 1];
    if (folder === undefined) continue;
    const { kind } = shelfFolderOf(folder, NO_LOCKS);
    places.push({ folderId: place.folderId, kind, path: trail.map((f) => f.name), count });
  }
  return places.sort(
    (a, b) => b.count - a.count || a.path.join("\u0000").localeCompare(b.path.join("\u0000")),
  );
}

/** One place's copies on one side — `"card"` is both printings' together. */
function placeCount(place: WishOwnedPlace, side: OwnedSide): number {
  return side === "exact"
    ? place.exact
    : side === "other"
      ? place.other
      : place.exact + place.other;
}

/**
 * How many of a wish's owned copies are **held** — filed in a deck's group or a locked folder, so
 * owned but not free to use (issue #1054) — per side. {@link WishRow.ownedExact} less `exact` is
 * what the `Own` chip counts; the two summed are the lighter `In use` chip.
 */
export function heldOf(wish: Pick<WishRow, "ownedPlaces">): { exact: number; other: number } {
  let exact = 0;
  let other = 0;
  for (const place of wish.ownedPlaces) {
    if (!place.held) continue;
    exact += place.exact;
    other += place.other;
  }
  return { exact, other };
}
