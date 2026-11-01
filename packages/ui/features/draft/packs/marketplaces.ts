/**
 * **Which marketplaces Open Packs prices at** (issue #1446): one or several, and a card is worth
 * the lowest price any of them quotes.
 *
 * **The app's marketplace until the reader picks**, and the reader's pick after that. The setting
 * in Settings is one marketplace and every other price surface draws from it alone
 * (`useMarketplace`); this page alone may name several, so the choice is the page's own and the
 * app's setting is never written from here.
 *
 * **Remembered across launches in `localStorage`, per device** — `apps/light/phone/wallDensity.ts`'
 * arrangement, and `lib/notifications.ts`' reason for not putting it in SQLite: `app_meta` is what
 * device sync carries, and a way of looking at one page is this machine's. A host that refuses the
 * store (a private window) keeps it for the session, and an unreadable value is no pick at all.
 *
 * **One currency at a time.** The app holds no exchange rate, so "the lowest of $2 and €1.80" is
 * not a sum this page can do. Picking a marketplace in the other currency therefore starts the
 * selection over from it rather than adding it — the same rule the session's tally keeps
 * (`ProductStage`'s `tallyMemory`: a switch of currency starts it over rather than adding dollars
 * to euros).
 */
import {
  MARKETPLACE_LIST,
  MARKETPLACES,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";
import { useMarketplace } from "@/lib/useMarketplace";
import {
  effectiveMarketplaces,
  toggleMarketplace,
  usePackMarketplaceStore,
} from "./marketplacePick";

/** One row of the picker. */
export interface MarketplaceChoice {
  marketplace: Marketplace;
  /** Not pressable: this build cannot quote it, or this host cannot ask it. */
  disabled: boolean;
}

/**
 * The page's marketplaces, every row the picker offers, and the press that changes them.
 *
 * **Choosing a feed with nothing in it fetches it**, as `useMarketplace().select` does and for its
 * reason: the reader has just asked for prices this app does not have. Only on a status the app
 * has read, and only for a feed that has never landed a row.
 */
export function usePackMarketplaces(): {
  marketplaces: Marketplace[];
  choices: MarketplaceChoice[];
  toggle: (id: MarketplaceId) => void;
} {
  const { marketplace, feeds, refresh } = useMarketplace();
  const stored = usePackMarketplaceStore((s) => s.stored);
  const keep = usePackMarketplaceStore((s) => s.keep);

  const feedOf = (id: MarketplaceId) => feeds.find((f) => f.marketplace.id === id);
  const usable = (id: MarketplaceId) => feedOf(id)?.reachable !== false;
  const marketplaces = effectiveMarketplaces(stored, marketplace, usable);
  const choices = MARKETPLACE_LIST.map((m) => ({
    marketplace: m,
    disabled: !m.priced || !usable(m.id),
  }));

  const toggle = (id: MarketplaceId) => {
    if (!MARKETPLACES[id].priced || !usable(id)) return;
    const current = marketplaces.map((m) => m.id);
    const next = toggleMarketplace(current, id);
    keep(next);
    const status = feedOf(id)?.status ?? null;
    if (!current.includes(id) && status !== null && (status.rowCount ?? 0) === 0) refresh(id);
  };

  return { marketplaces, choices, toggle };
}
