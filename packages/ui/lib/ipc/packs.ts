/**
 * Booster data for the Draft & Packs page: one set's booster products and the sealed products that
 * hold them, as MTGJSON describes them, joined to this app's corpus
 * (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §2).
 *
 * **A domain of `../ipc.ts`**, read through `@/lib/ipc` only. The shapes are
 * `crates/grimoire-core/src/boosters.rs`', held field for field by `ipc.test.ts`; the command is the
 * desktop host's (`apps/desktop/src-tauri/src/packs/`), which fetches and caches MTGJSON's set file.
 *
 * **Facts only.** Which card a booster holds, what it is worth on average and how a pack compares
 * are `features/draft/booster/`'s conclusions. Prices are not here: a card is priced through
 * `printingPrices`, at the reader's marketplace.
 *
 * **A web or phone host refuses it** — it is on the desktop's `DESKTOP_ONLY` list, and the light
 * app draws no Draft & Packs page.
 */
import { invoke } from "./invoke";

/** One set's boosters and sealed products, and every card they can hold. */
export interface BoosterSet {
  /** Lower-case, as the corpus spells a set code. */
  code: string;
  name: string;
  releaseDate: string | null;
  products: BoosterProduct[];
  sealed: SealedProduct[];
  /** Every card any sheet or sealed product names, once. */
  cards: BoosterCard[];
  /** Milliseconds: when MTGJSON's file was fetched. */
  fetchedAt: number;
}

/** One kind of booster: `play`, `draft`, `set`, `collector`, … */
export interface BoosterProduct {
  /** MTGJSON's key for the product. */
  key: string;
  name: string;
  totalWeight: number;
  variants: BoosterVariant[];
  sheets: BoosterSheet[];
}

/** One way a booster of the product is put together, and how often. */
export interface BoosterVariant {
  weight: number;
  slots: BoosterSlot[];
}

/** `count` cards from the sheet named `sheet`. */
export interface BoosterSlot {
  sheet: string;
  count: number;
}

/** A print sheet: cards and their weights. */
export interface BoosterSheet {
  name: string;
  foil: boolean;
  /** Every card is in the slot, `weight` times, rather than drawn. */
  fixed: boolean;
  /** One booster may hold a card of this sheet twice. */
  allowDuplicates: boolean;
  /** MTGJSON's colour balancing for a slot of commons. */
  balanceColors: boolean;
  totalWeight: number;
  cards: SheetCard[];
}

/** A printing on a sheet, by Scryfall id. */
export interface SheetCard {
  cardId: string;
  weight: number;
}

/** A box, a case, a bundle: something sealed that holds boosters. */
export interface SealedProduct {
  uuid: string;
  name: string;
  category: string | null;
  subtype: string | null;
  packs: SealedPack[];
  sealed: SealedInner[];
  cards: SealedCard[];
}

/** `count` boosters of `product` from `set`. */
export interface SealedPack {
  set: string;
  product: string;
  count: number;
}

/** `count` of another sealed product, by its uuid. */
export interface SealedInner {
  uuid: string;
  set: string;
  count: number;
}

/** A card a sealed product always holds. */
export interface SealedCard {
  cardId: string;
  foil: boolean;
}

/** What the page draws for a card it may open. */
export interface BoosterCard {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
  typeLine: string | null;
  manaCost: string | null;
  cmc: number | null;
  /** Letters, `"WU"`, as the corpus stores them. */
  colors: string | null;
  /** `false`: known from MTGJSON alone — this corpus has no such printing, so no image and no price. */
  inCorpus: boolean;
}

export const packCommands = {
  /**
   * One set's booster data. Fetched from MTGJSON the first time and cached for a week; `refresh`
   * asks again now. Rejects in one sentence when the set has no boosters or MTGJSON cannot be
   * reached.
   */
  packsBoosterSet: (setCode: string, refresh: boolean) =>
    invoke<BoosterSet>("packs_booster_set", { setCode, refresh }),
};
