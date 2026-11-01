/**
 * The Packs page's marketplace pick as it is **kept** — the store, what it reads and writes, and the
 * pure rules over it (issue #1446; the reasons are `marketplaces.ts`').
 *
 * **A module of its own, importing nothing that reaches a host**, because `test-setup.ts` and the
 * fake's `installWorld` reset it: a setup file that imported `useMarketplace` would load the real
 * `@/lib/ipc` ahead of every suite's `vi.mock` of it, and those mocks would quietly stop applying.
 */
import { create } from "zustand";
import {
  isMarketplaceId,
  MARKETPLACE_LIST,
  MARKETPLACES,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";

export const STORAGE_KEY = "grimoire.packs.marketplaces";

/** What the store held, or `null` for nothing (or nothing readable) — "the reader has not picked". */
export function parseStored(raw: string | null): MarketplaceId[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter(
      (v): v is MarketplaceId => typeof v === "string" && isMarketplaceId(v),
    );
    return ids.length > 0 ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}

function readStored(): MarketplaceId[] | null {
  try {
    return parseStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** In picker order, so the trigger and the stored list do not depend on the order of presses. */
function inPickerOrder(ids: readonly MarketplaceId[]): MarketplaceId[] {
  return MARKETPLACE_LIST.map((m) => m.id).filter((id) => ids.includes(id));
}

/**
 * The selection after a press on `id`.
 *
 * - **A picked one is dropped — unless it is the last.** There is always a marketplace to price
 *   at; an empty pick would be every figure on the page an em dash.
 * - **One in the selection's currency is added.**
 * - **One in the other currency replaces the selection** — see the module's note.
 */
export function toggleMarketplace(
  current: readonly MarketplaceId[],
  id: MarketplaceId,
): MarketplaceId[] {
  if (current.includes(id)) {
    return current.length > 1 ? current.filter((m) => m !== id) : [...current];
  }
  const currency = MARKETPLACES[id].currency;
  if (current.some((m) => MARKETPLACES[m].currency !== currency)) return [id];
  return inPickerOrder([...current, id]);
}

/**
 * What the page prices at: the stored pick, less any marketplace this build cannot quote or this
 * host cannot ask, or — when that leaves nothing, or the reader never picked — the app's own
 * marketplace. A pick of two currencies (a store written by hand) keeps the first one's.
 */
export function effectiveMarketplaces(
  stored: readonly MarketplaceId[] | null,
  fallback: Marketplace,
  usable: (id: MarketplaceId) => boolean,
): Marketplace[] {
  const kept = inPickerOrder((stored ?? []).filter((id) => MARKETPLACES[id].priced && usable(id)));
  if (kept.length === 0) return [fallback];
  const currency = MARKETPLACES[kept[0]].currency;
  return kept.map((id) => MARKETPLACES[id]).filter((m) => m.currency === currency);
}

interface StoredPick {
  /** `null` until the reader picks on this device — the app's marketplace is the answer then. */
  stored: MarketplaceId[] | null;
  keep: (ids: MarketplaceId[]) => void;
}

export const usePackMarketplaceStore = create<StoredPick>((set) => ({
  stored: readStored(),
  keep: (ids) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Kept for the session.
    }
    set({ stored: ids });
  },
}));

/** Forget the pick — a fresh device's state. For tests and stories. */
export function resetPackMarketplaces(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept.
  }
  usePackMarketplaceStore.setState({ stored: null });
}
