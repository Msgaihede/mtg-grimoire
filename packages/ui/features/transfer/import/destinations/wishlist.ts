/**
 * The wishlist's planner.
 *
 * **Pins a printing only when the file named one — or when there is no oracle card to wish for
 * instead.** `1 Sol Ring` is a wish for the card; `1 Sol Ring (LTC) 285` is a wish for that
 * printing. Reading the file's own specificity is the only honest answer available, it costs no
 * control, and `WISHLIST_GRAIN` already models the two as different rows rather than one being a
 * looser version of the other. But `ImportMatch.oracleId` is itself `string | null` — every
 * `reversible_card` printing has no top-level `oracle_id`, and a plain promo can carry a null one
 * too — and `wishlist::commit_import` refuses a row with **neither** id, inside one transaction
 * for the whole file: one such line rolls the entire import back. So a line whose match has no
 * oracle id pins the printing whether or not it named one, which is also what keeps two such
 * lines from folding into a single unwritable item carrying no ids at all — the fold key already
 * includes `cardId`, so pinning it is what tells two different null-oracle printings apart.
 */
import type { DeckFinish, ImportResolveRow, WishlistImportItem } from "@/lib/ipc";
import type { ParsedList } from "../parse";
import type { FoldedLine } from "./collection";
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
  /** Lines merged into an earlier line at the same wish — `CollectionPlan.folded`'s own shape,
   *  so a file that lands as fewer wishes than it has lines says which ones and why. */
  folded: FoldedLine[];
  parseIssues: ParsedList["issues"];
  totalCards: number;
}

/**
 * One wish while the file is still being read — the item, plus the notes every line at its key
 * has said so far. `collection.ts`'s `Pending`, for the one merged field a wish has: the item is
 * not finished until the last line is read, because patching the first line's item per line is
 * how the fold came to keep the first line's notes and drop the second's (issue #1176).
 */
interface Pending {
  /** The line number a later line is merged `into`. */
  into: number;
  item: WishlistPlanItem;
  notes: string[];
}

export function planWishlistImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  options: WishlistOptions,
): WishlistPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  const folded: FoldedLine[] = [];
  const pending = new Map<string, Pending>();

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
    // A null `oracleId` leaves nothing else to wish with — `WishInput`'s doc requires one
    // identifier or the other — so the printing is pinned even though the line named none.
    const cardId = named || matched.oracleId === null ? matched.cardId : null;
    const finish = line.finish ?? options.finish;
    const key = `${matched.oracleId ?? ""} ${cardId ?? ""} ${finish ?? ""}`;
    const notes = (line.extra.notes ?? "").trim();
    const seen = pending.get(key);
    if (seen !== undefined) {
      // **A second line at one wish is the same wish said twice, and its notes are kept beside
      // the first's** — the same wish in two folders exports as two rows, and a re-import that
      // kept only one row's note would lose the other's without a word. Counts add; distinct
      // notes join the way `collection.ts` joins them.
      folded.push({ lineNumber: line.lineNumber, into: seen.into, name: line.name });
      seen.item.quantity += line.quantity;
      if (notes !== "" && !seen.notes.includes(notes)) seen.notes.push(notes);
      return;
    }
    pending.set(key, {
      into: line.lineNumber,
      item: {
        oracleId: matched.oracleId,
        cardId,
        quantity: line.quantity,
        // `null` is "any finish" here, which is the wishlist's own meaning rather than the
        // collection's `nonfoil`.
        preferredFinish: finish,
        notes: null,
      },
      notes: notes === "" ? [] : [notes],
    });
  });

  const items = [...pending.values()].map(
    (p): WishlistPlanItem => ({ ...p.item, notes: p.notes.length === 0 ? null : p.notes.join("; ") }),
  );
  return {
    items,
    unmatched,
    hintMisses,
    folded,
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
