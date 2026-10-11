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
import type {
  CollectionFolder,
  HomeLayout,
  HomeWidget,
  PriceMoverScope,
  WishlistFolder,
} from "@/lib/ipc";
import { folderDescendants } from "@/lib/folderTree";

import { widgetConfig } from "./layout";
import { pickOf } from "./widgetSettings";

/** The id each checklist gives its cabinet's root — the copies or wishes filed in no folder. No
 *  folder has it: both folder tables' ids are `INTEGER PRIMARY KEY`. */
export const ROOT_FOLDER = 0;

/** One card the reader chose, with the words its row in the settings draws — kept beside the id so
 *  the list can be drawn without a read per card. */
export interface ChosenCard {
  id: string;
  name: string;
  setCode: string;
  collectorNumber: string;
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
    cards: config.cards.filter(isChosenCard),
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
 * The question this widget asks — `null` for everything the reader owns, else
 * {@link PriceMoverScope}: the chosen folders of each cabinet expanded through
 * {@link expandFolders}, and the chosen cards' ids, sorted.
 */
export function moverScopeOf(
  widget: HomeWidget,
  collectionFolders: readonly CollectionFolder[],
  wishlistFolders: readonly WishlistFolder[],
): PriceMoverScope | null {
  if (!measuresChosen(widget)) return null;
  const config = priceMoversConfig(widget);
  return {
    collectionFolders: expandFolders(config.collectionFolderIds, collectionFolders),
    wishlistFolders: expandFolders(config.wishlistFolderIds, wishlistFolders),
    cards: [...new Set(config.cards.map((card) => card.id))].sort(),
  };
}

/** Does this scope name anything at all? A scope naming nothing is never asked about. */
export function namesAnything(scope: PriceMoverScope): boolean {
  return scope.collectionFolders.length + scope.wishlistFolders.length + scope.cards.length > 0;
}
