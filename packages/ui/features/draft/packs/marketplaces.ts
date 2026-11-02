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
 * **Dollars and euros together** (issue #1463). A pick of both is priced in the app's currency,
 * the other currency's prices converted at the European Central Bank's daily rate, which the
 * desktop host fetches only once such a pick is made (`packs_exchange_rate`). Which prices are
 * converted and by what is `currency.ts`' answer; this hook only asks for the rate when it is
 * needed.
 */
import {
  MARKETPLACE_LIST,
  MARKETPLACES,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";
import { useQuery } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { isMixed, pricingPlan, type PricingPlan, type RateState } from "./currency";
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
/** The rate's cache entry. Not under `["cards", "prices"]`: a price feed's refresh moves no rate. */
export const EXCHANGE_RATE_KEY = ["packs", "exchange-rate"] as const;

/**
 * The ECB's dollar rate, asked only while `needed` — a pick of two currencies. Kept an hour in
 * the page's cache; the host keeps the file six.
 */
export function useExchangeRate(needed: boolean): RateState {
  const query = useQuery({
    queryKey: EXCHANGE_RATE_KEY,
    queryFn: () => ipc.packsExchangeRate(),
    enabled: needed,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  if (query.data !== undefined) return { status: "ready", rate: query.data };
  if (query.isError) return { status: "failed", reason: ipcError(query.error) };
  return { status: "loading" };
}

export function usePackMarketplaces(): {
  marketplaces: Marketplace[];
  plan: PricingPlan;
  choices: MarketplaceChoice[];
  toggle: (id: MarketplaceId) => void;
} {
  const { marketplace, feeds, refresh } = useMarketplace();
  const stored = usePackMarketplaceStore((s) => s.stored);
  const keep = usePackMarketplaceStore((s) => s.keep);

  const feedOf = (id: MarketplaceId) => feeds.find((f) => f.marketplace.id === id);
  const usable = (id: MarketplaceId) => feedOf(id)?.reachable !== false;
  const marketplaces = effectiveMarketplaces(stored, marketplace, usable);
  const rate = useExchangeRate(isMixed(marketplaces));
  const plan = pricingPlan(marketplaces, marketplace.currency, rate);
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

  return { marketplaces, plan, choices, toggle };
}
