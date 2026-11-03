/**
 * **Open Packs' own reduced price**: a sell percentage and a minimum card value, the two figures
 * Settings › Collection value holds for the collection (`lib/collectionValue.ts`), kept apart from
 * them. A reader who sells their collection at 80% may value a pack they are about to buy at 60%,
 * so this page neither reads the collection's setting nor writes it.
 *
 * **And a bulk price** (issue #1477): what each card under the minimum is worth instead of nothing —
 * a store's bulk rate. It counts only while a minimum is set. The collection's setting has a bulk
 * price too, and this one is apart from it like the other two.
 *
 * **Remembered across launches in `localStorage`, per device** — `marketplacePick.ts`' arrangement
 * and its reasons: a way of pricing one page is this machine's, never `app_meta`. A host that
 * refuses the store keeps it for the session, and an unreadable value is no reduction at all.
 *
 * **The minimum and the bulk price are numbers in whatever currency the page prices in**, and
 * nothing converts them — the collection's rule. Their boxes wear the current currency's sign.
 *
 * A module of its own importing nothing that reaches a host, for `marketplacePick.ts`' reason:
 * `test-setup.ts` and the fake's `installWorld` reset it.
 */
import { create } from "zustand";
import { DEFAULT_COLLECTION_VALUE } from "@/lib/collectionValue";
import type { CollectionValue } from "@/lib/ipc";

export const STORAGE_KEY = "grimoire.packs.reduced";

/** The page's figures: the collection setting's shape, kept apart from it. */
export type PackReduction = CollectionValue;

/** No reduction: every card counted, at full price, and no bulk price. */
export const DEFAULT_PACK_REDUCTION: PackReduction = DEFAULT_COLLECTION_VALUE;

/** A price figure the store may hold: a finite number of zero or more. */
function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** What the store held, or no reduction for nothing (or nothing readable). Each figure is checked
 *  on its own against the collection setting's bounds, so a bad one costs only itself — and a
 *  device that kept its figures before the bulk price existed reads as none. */
export function parseStored(raw: string | null): PackReduction {
  if (raw === null) return DEFAULT_PACK_REDUCTION;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PACK_REDUCTION;
    const { sellPercent, minimumValue, bulkPrice } = parsed as Record<string, unknown>;
    return {
      sellPercent:
        typeof sellPercent === "number" && sellPercent > 0 && sellPercent <= 100
          ? sellPercent
          : DEFAULT_PACK_REDUCTION.sellPercent,
      minimumValue: isPrice(minimumValue) ? minimumValue : DEFAULT_PACK_REDUCTION.minimumValue,
      bulkPrice: isPrice(bulkPrice) ? bulkPrice : DEFAULT_PACK_REDUCTION.bulkPrice,
    };
  } catch {
    return DEFAULT_PACK_REDUCTION;
  }
}

function readStored(): PackReduction {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PACK_REDUCTION;
  }
}

interface StoredReduction {
  settings: PackReduction;
  keep: (settings: PackReduction) => void;
}

export const usePackReducedStore = create<StoredReduction>((set) => ({
  settings: readStored(),
  keep: (settings) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Kept for the session.
    }
    set({ settings });
  },
}));

/** Forget the figures — a fresh device's state. For tests and stories. */
export function resetPackReduced(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept.
  }
  usePackReducedStore.setState({ settings: DEFAULT_PACK_REDUCTION });
}
