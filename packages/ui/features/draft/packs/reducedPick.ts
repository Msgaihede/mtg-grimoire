/**
 * **Open Packs' own reduced price**: a sell percentage and a minimum card value, the two figures
 * Settings › Collection value holds for the collection (`lib/collectionValue.ts`), kept apart from
 * them. A reader who sells their collection at 80% may value a pack they are about to buy at 60%,
 * so this page neither reads the collection's setting nor writes it.
 *
 * **Remembered across launches in `localStorage`, per device** — `marketplacePick.ts`' arrangement
 * and its reasons: a way of pricing one page is this machine's, never `app_meta`. A host that
 * refuses the store keeps it for the session, and an unreadable value is no reduction at all.
 *
 * **The minimum is a number in whatever currency the page prices in**, and nothing converts it — the
 * collection's rule. Its box wears the current currency's sign.
 *
 * A module of its own importing nothing that reaches a host, for `marketplacePick.ts`' reason:
 * `test-setup.ts` and the fake's `installWorld` reset it.
 */
import { create } from "zustand";
import { DEFAULT_COLLECTION_VALUE } from "@/lib/collectionValue";
import type { CollectionValue } from "@/lib/ipc";

export const STORAGE_KEY = "grimoire.packs.reduced";

/** What the store held, or no reduction for nothing (or nothing readable). Each figure is checked
 *  on its own against the collection setting's bounds, so a bad one costs only itself. */
export function parseStored(raw: string | null): CollectionValue {
  if (raw === null) return DEFAULT_COLLECTION_VALUE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_COLLECTION_VALUE;
    const { sellPercent, minimumValue } = parsed as Record<string, unknown>;
    return {
      sellPercent:
        typeof sellPercent === "number" && sellPercent > 0 && sellPercent <= 100
          ? sellPercent
          : DEFAULT_COLLECTION_VALUE.sellPercent,
      minimumValue:
        typeof minimumValue === "number" && Number.isFinite(minimumValue) && minimumValue >= 0
          ? minimumValue
          : DEFAULT_COLLECTION_VALUE.minimumValue,
    };
  } catch {
    return DEFAULT_COLLECTION_VALUE;
  }
}

function readStored(): CollectionValue {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_COLLECTION_VALUE;
  }
}

interface StoredReduction {
  settings: CollectionValue;
  keep: (settings: CollectionValue) => void;
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
  usePackReducedStore.setState({ settings: DEFAULT_COLLECTION_VALUE });
}
