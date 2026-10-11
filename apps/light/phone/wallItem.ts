import type { FakeCard } from "@grimoire/fake/cards";
import { formatPrice } from "@grimoire/ui/lib/prices";
import type { WallItem } from "./CardWall";

/**
 * A fixture printing as the phone face's wall draws it — the shape `items.ts`' `searchItem` gives
 * a search result, filled from the corpus's own row, so the art, the chin and the price are a
 * real card's. `items.ts` itself takes the IPC DTOs, and `items.test.ts` holds what it picks out
 * of each; a story built on this is about the wall, not about that mapping. Unmarked, held once
 * and named by its printing, as a search result for a card not owned is.
 *
 * **Here and not in the fake's `fixtures.ts`, where it was until 2026-10-08**: it builds this
 * app's type, and a fake that imported that type depended on an app. Not in a story file either
 * — every export of one is indexed as a story (`packages/fake/fixtures.ts`'s header) — and not in
 * `testing.tsx`, which imports Vitest and so cannot be reached from a story. The card is imported
 * as a type, so `fence.test.ts` sees no edge from the phone face to the fake here.
 */
export function wallItem(card: FakeCard, over: Partial<WallItem> = {}): WallItem {
  return {
    key: card.id,
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: {
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      printingTitle: card.setName,
    },
    finish: null,
    money: formatPrice(card.priceUsd, "usd"),
    count: 1,
    pressLabel: `${card.name}, ${card.setCode.toUpperCase()} ${card.collectorNumber}`,
    ...over,
  };
}
