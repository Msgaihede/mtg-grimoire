/**
 * The wishlist's planner.
 *
 * **Pins a printing only when the file named one.** `1 Sol Ring` is a wish for the card;
 * `1 Sol Ring (LTC) 285` is a wish for that printing. Reading the file's own specificity is the
 * only honest answer available, it costs no control, and `WISHLIST_GRAIN` already models the
 * two as different rows rather than one being a looser version of the other.
 */
import type { DeckFinish, ImportResolveRow, WishlistImportItem } from "@/lib/ipc";
import type { ParsedList } from "../parse";
import type { HintMiss, UnmatchedLine } from "./deck";

export interface WishlistOptions {
  finish: DeckFinish;
}

/**
 * One wish the plan will send, in the plan's own words rather than the wire's.
 *
 * **Not `WishlistImportItem`, on purpose.** That DTO's `cardId` and `oracleId` are each
 * `string | undefined` — the shape a Rust `Option` takes over the wire — while what this
 * planner actually knows is `string | null`: a line that named no printing is not a line that
 * *forgot* to say `cardId`, it is a line whose wish is honestly "any printing", and `null` is
 * this app's own word for that everywhere else (`ParsedLine.setCode`, `WishRow.cardId`).
 * {@link toWishlistImportItems} is the one seam where the plan's `null` becomes the wire's
 * `undefined`, right before the commit — see `CollectionPlan` for why the collection's own
 * items need no equivalent seam.
 */
export interface WishlistPlanItem {
  /** `ImportMatch.oracleId` is itself nullable — an orphaned match names no oracle card. */
  oracleId: string | null;
  /** `null` is a wish for **any printing**, exactly as {@link WishlistImportItem.cardId}
   *  documents — not a looser version of a pinned wish, a different row of the grain. */
  cardId: string | null;
  quantity: number;
  preferredFinish: DeckFinish;
  notes: string | null;
}

export interface WishlistPlan {
  items: WishlistPlanItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParsedList["issues"];
  totalCards: number;
}

export function planWishlistImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  options: WishlistOptions,
): WishlistPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  const folded = new Map<string, WishlistPlanItem>();

  list.lines.forEach((line, index) => {
    const row = byIndex.get(index);
    const matched = row?.matched ?? null;
    if (matched === null) {
      unmatched.push({ lineNumber: line.lineNumber, raw: line.raw, name: line.name });
      return;
    }
    if (row?.hintMissed === true) {
      hintMisses.push({ lineNumber: line.lineNumber, name: line.name, used: printingOf(matched) });
    }

    const named = line.setCode !== null || line.collectorNumber !== null;
    const cardId = named ? matched.cardId : null;
    const finish = line.finish ?? options.finish;
    const key = `${matched.oracleId ?? ""} ${cardId ?? ""} ${finish ?? ""}`;
    const seen = folded.get(key);
    if (seen !== undefined) {
      seen.quantity += line.quantity;
      return;
    }
    folded.set(key, {
      oracleId: matched.oracleId,
      cardId,
      quantity: line.quantity,
      // `null` is "any finish" here, which is the wishlist's own meaning rather than the
      // collection's `nonfoil`.
      preferredFinish: finish,
      notes: line.extra.notes ?? null,
    });
  });

  const items = [...folded.values()];
  return {
    items,
    unmatched,
    hintMisses,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}

/**
 * The plan's own items, as `ipc.wishlistImportCommit` takes them — the one place `null` becomes
 * `undefined`. See {@link WishlistPlanItem} for why the plan does not simply hold the wire shape.
 */
export function toWishlistImportItems(
  items: readonly WishlistPlanItem[],
): WishlistImportItem[] {
  return items.map((item) => ({
    oracleId: item.oracleId ?? undefined,
    cardId: item.cardId ?? undefined,
    quantity: item.quantity,
    preferredFinish: item.preferredFinish ?? undefined,
    notes: item.notes ?? undefined,
  }));
}

/** The printing a line was answered with, as a card prints it — `collection.ts`'s own copy of
 *  `deck.ts`'s `printingOf`, kept local for the same reason: one line is not worth an import
 *  into a file whose own doc says it decides deck questions and nothing past that. */
function printingOf(match: { setCode: string; collectorNumber: string }): string {
  return `${match.setCode.toUpperCase()} ${match.collectorNumber}`;
}
