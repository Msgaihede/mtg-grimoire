/**
 * A whole `TransferCard`, overridden per test.
 *
 * The defaults are a plain regular-finish printing on a surface with **no** categories and no
 * collection fields — `null` everywhere meaning "this surface does not have this fact", which is
 * what `availableFields` reads. A deck test overrides the three category fields; a collection
 * test overrides `condition` and friends.
 */
import type { TransferCard } from "./TransferCard";

export function transferCard(over: Partial<TransferCard> = {}): TransferCard {
  return {
    name: "Lightning Bolt",
    quantity: 1,
    setCode: "LEA",
    collectorNumber: "161",
    finish: null,
    lang: "en",
    categoryName: null,
    categoryKind: null,
    categoryActive: null,
    condition: null,
    tradelistQuantity: null,
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    grading: null,
    altered: null,
    signed: null,
    proxy: null,
    misprint: null,
    tags: null,
    notes: null,
    setName: null,
    rarity: null,
    typeLine: null,
    unitPrice: null,
    ...over,
  };
}
