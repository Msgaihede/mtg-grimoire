import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import {
  DEFAULT_MARKETPLACE,
  resolveMarketplace,
  type Marketplace,
  type MarketplaceId,
} from "@/lib/marketplace";

export const MARKETPLACE_KEY = ["marketplace"];

/**
 * Which marketplace the app is quoting, and the one write that changes it.
 *
 * TanStack Query rather than the zustand store: `store.ts` scopes itself to UI state and hands
 * anything backed by the database to Query, and this setting lives in `app_meta` so it
 * outlives the process.
 *
 * **`staleTime: Infinity` and no refetch on the switch.** Rust returns both currencies on
 * every priced row, so changing marketplace changes which field a cell *reads* — not what the
 * backend was asked. Every price surface re-renders off the cache it already has, with no
 * network, no spinner and no gap. Invalidating the price queries here would undo exactly that.
 *
 * There is no first-paint flash of the wrong currency either, and it is structural rather than
 * lucky: no price is on screen until its own (far more expensive) query resolves, and this one
 * is issued alongside them.
 */
export function useMarketplace() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: MARKETPLACE_KEY,
    queryFn: () => ipc.getMarketplace(),
    staleTime: Infinity,
  });

  const select = useMutation({
    mutationFn: (id: MarketplaceId) => ipc.setMarketplace(id),
    // Write the answer straight into the cache. The command has already committed it, so a
    // refetch would only ask the database to repeat itself.
    onSuccess: (_result, id) => queryClient.setQueryData(MARKETPLACE_KEY, id),
  });

  return {
    /** Never null — an unset or unrecognised stored id resolves to the default. */
    marketplace: resolveMarketplace(query.data ?? DEFAULT_MARKETPLACE),
    /** Convenience: what every price function in this app actually takes. */
    currency: resolveMarketplace(query.data ?? DEFAULT_MARKETPLACE).currency,
    select: (id: MarketplaceId) => select.mutate(id),
    selecting: select.isPending,
    error: select.error ? ipcError(select.error) : null,
  };
}

export type MarketplaceState = ReturnType<typeof useMarketplace>;
export type { Marketplace };
