/**
 * What a Price movers widget measures, read off its `config` — everything the reader owns, or the
 * collection folders, wishlist folders and cards they chose (issue #906).
 *
 * **Its own module, apart from the widget**, because two places read it that draw nothing:
 * `useHomeLayout`, which hands every chosen card to `set_price_watch` so the snapshots remember its
 * price ({@link priceWatchOf}), and the widget's body, which turns the choices into the
 * `PriceMoverScope` the command reads ({@link moverScopeOf}). The layout hook importing the widget
 * would put the dropdowns and the card search in its graph for one pure function.
 */
import { isFinish, type Finish } from "@/lib/finish";
import type {
  CollectionFolder,
  HomeLayout,
  HomeWidget,
  PriceMoverPrinting,
  PriceMoverScope,
  WishlistFolder,
} from "@/lib/ipc";
import { folderDescendants } from "@/lib/folderTree";

import { widgetConfig } from "./layout";
import { pickOf } from "./widgetSettings";

/** The id each checklist gives its cabinet's root — the copies or wishes filed in no folder. No
 *  folder has it: both folder tables' ids are `INTEGER PRIMARY KEY`. */
export const ROOT_FOLDER = 0;

/**
 * One card the reader chose, with the words its row in the settings draws — kept beside the id so
 * the list can be drawn without a read per card.
 *
 * **A finish, or every finish (issue #1675).** `finish` absent is *Any finish*: the printing in
 * every finish it is priced in, which is what every card chosen before a card could carry a finish
 * means, and what a fresh choice starts at. `finishes` is what the printing is made in, kept beside
 * the id for the words' reason, so the row offers only those; a card chosen before it was kept has
 * none, and its row offers all three rather than guess.
 */
export interface ChosenCard {
  id: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  /** The one finish followed; absent for every finish. */
  finish?: Finish;
  /** The finishes the printing is made in; absent on a card chosen before they were kept. */
  finishes?: Finish[];
}

/** This widget's stored choices — what `Chosen` measures. */
export interface PriceMoversConfig {
  collectionFolderIds: number[];
  wishlistFolderIds: number[];
  cards: ChosenCard[];
}

function isChosenCard(value: unknown): value is ChosenCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card.id === "string" &&
    card.id !== "" &&
    typeof card.name === "string" &&
    typeof card.setCode === "string" &&
    typeof card.collectorNumber === "string"
  );
}

/**
 * A chosen card with only what this build can read of its finish: a finish it has never heard of
 * is *Any finish* rather than a card dropped — the card is still the reader's choice — and an
 * unknown word in `finishes` is left out, `parseFinishes`' rule.
 */
function narrowCard(card: ChosenCard): ChosenCard {
  const { id, name, setCode, collectorNumber } = card;
  const raw = card as unknown as Record<string, unknown>;
  const finish = typeof raw.finish === "string" && isFinish(raw.finish) ? raw.finish : undefined;
  const finishes = Array.isArray(raw.finishes)
    ? raw.finishes.filter((each): each is Finish => typeof each === "string" && isFinish(each))
    : undefined;
  return {
    id,
    name,
    setCode,
    collectorNumber,
    ...(finish === undefined ? {} : { finish }),
    ...(finishes === undefined ? {} : { finishes }),
  };
}

/**
 * The choices, narrowed — `savingsFolderIds`' rule: `widgetConfig`'s shape check is shallow, so a
 * hand-edited `["3"]` or a card with no id is dropped here the way a deleted folder is. A fresh
 * fallback per call, so no two widgets share one array.
 */
export function priceMoversConfig(widget: HomeWidget): PriceMoversConfig {
  const config = widgetConfig<{
    collectionFolderIds: unknown[];
    wishlistFolderIds: unknown[];
    cards: unknown[];
  }>(widget, { collectionFolderIds: [], wishlistFolderIds: [], cards: [] });
  const ids = (list: unknown[]) => list.filter((id): id is number => Number.isInteger(id));
  return {
    collectionFolderIds: ids(config.collectionFolderIds),
    wishlistFolderIds: ids(config.wishlistFolderIds),
    cards: config.cards.filter(isChosenCard).map(narrowCard),
  };
}

/** Whether this widget measures what its reader chose, rather than everything they own. */
export function measuresChosen(widget: HomeWidget): boolean {
  return pickOf(widget, "scope") === "chosen";
}

/**
 * Every card any Price movers widget on the page names, each once, sorted — what `useHomeLayout`
 * hands `set_price_watch` so the snapshots remember their prices.
 *
 * **A widget set back to `Everything you own` still counts**: its choices are kept while hidden,
 * and a card whose watch lapsed while hidden would come back with a hole in its history exactly
 * as long as it was away.
 */
export function priceWatchOf(layout: HomeLayout): string[] {
  const ids = new Set<string>();
  for (const widget of layout.widgets) {
    if (widget.kind !== "priceMovers") continue;
    for (const card of priceMoversConfig(widget).cards) ids.add(card.id);
  }
  return [...ids].sort();
}

/**
 * One cabinet's chosen folders, each with every folder filed inside it, as direct ids — the
 * question `PriceMoverScope` asks. An id no folder carries any more is dropped; {@link ROOT_FOLDER}
 * always stands. Sorted, so the key does not move when the same set is ticked in another order.
 */
function expandFolders(
  ids: readonly number[],
  folders: readonly (CollectionFolder | WishlistFolder)[],
): number[] {
  const known = new Set(folders.map((folder) => folder.id));
  const out = new Set<number>();
  for (const id of ids) {
    if (id === ROOT_FOLDER) {
      out.add(ROOT_FOLDER);
      continue;
    }
    if (!known.has(id)) continue;
    out.add(id);
    for (const inside of folderDescendants(folders, id)) out.add(inside);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The chosen cards that name one finish, as the scope's `printings` — each pair once, sorted by
 * card and then finish, so the key does not move when the same cards are chosen in another order.
 */
function printingsOf(cards: readonly ChosenCard[]): PriceMoverPrinting[] {
  const seen = new Map<string, PriceMoverPrinting>();
  for (const { id, finish } of cards) {
    if (finish !== undefined) seen.set(`${id}\u0000${finish}`, { cardId: id, finish });
  }
  // Keyed by card then finish, so sorting the keys is that order; no two keys are equal.
  return [...seen].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, printing]) => printing);
}

/**
 * The question this widget asks — `null` for everything the reader owns, else
 * {@link PriceMoverScope}: the chosen folders of each cabinet expanded through
 * {@link expandFolders}, the ids of the cards chosen at *Any finish*, sorted, and the cards chosen
 * as one finish as `printings` (issue #1675) — a chosen foil is the foil's move and not the plain
 * copy's.
 */
export function moverScopeOf(
  widget: HomeWidget,
  collectionFolders: readonly CollectionFolder[],
  wishlistFolders: readonly WishlistFolder[],
): PriceMoverScope | null {
  if (!measuresChosen(widget)) return null;
  const config = priceMoversConfig(widget);
  const anyFinish = config.cards.filter((card) => card.finish === undefined);
  return {
    collectionFolders: expandFolders(config.collectionFolderIds, collectionFolders),
    wishlistFolders: expandFolders(config.wishlistFolderIds, wishlistFolders),
    cards: [...new Set(anyFinish.map((card) => card.id))].sort(),
    printings: printingsOf(config.cards),
  };
}

/** Does this scope name anything at all? A scope naming nothing is never asked about. */
export function namesAnything(scope: PriceMoverScope): boolean {
  return (
    scope.collectionFolders.length +
      scope.wishlistFolders.length +
      scope.cards.length +
      scope.printings.length >
    0
  );
}
