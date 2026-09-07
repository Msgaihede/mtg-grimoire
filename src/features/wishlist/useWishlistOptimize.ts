import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type WishlistOptimizePlan,
  type WishlistQuery,
  type WishOptimizeApplyItem,
} from "@/lib/ipc";

/**
 * The question the sweep is asked — every field of the list's own query except the paging and the
 * order.
 *
 * **`limit`/`offset` are ignored by the command and `sort` cannot matter**, which is why neither
 * is in this type. The plan covers the whole query rather than the visible page (that is
 * {@link WishlistOptimizePlan}'s own promise, and what makes `considered` equal the `Wishes`
 * figure in the header), and it answers a *set* rather than a list — so a reader flipping the
 * table's sort must not refetch a plan that cannot come back different. `useWishlist`'s `filters`
 * satisfies this exactly, and is handed over whole.
 */
export type OptimizeQuery = Omit<WishlistQuery, "limit" | "offset" | "sort">;

/**
 * The key the plan is cached under.
 *
 * **`["wishlist", …]`**, so the one `invalidateQueries({ queryKey: ["wishlist"] })` that every
 * wishlist write in this app already fires reaches it — the page's `settleWhole`, the folder
 * writes, the card menu's add. A plan is a statement about rows that any of those can move, and a
 * narrower root here would be the app's twelfth wishlist write settling differently from the other
 * eleven.
 *
 * **The query object *is* the key's last segment, rather than a hand-spelled list of strings.**
 * `useWishlist`'s list key spells out fourteen segments because it is built from fourteen separate
 * pieces of local state; this one is handed one object that is already the payload, and TanStack
 * hashes it stably (its `hashKey` stringifies with sorted keys), so two readers asking the same
 * question share one entry. Spelling it out again would be a second copy of the payload with its
 * own chance of leaving a field out — and the field it would leave out is `marketplace`, which
 * decides every figure in the answer and which `src/CLAUDE.md` requires in the key of every priced
 * query. Here it cannot be left out, because it is the payload.
 */
export function optimizePlanKey(query: OptimizeQuery) {
  return ["wishlist", "optimize", query] as const;
}

/**
 * What re-pointing the list on screen to its cheapest printings would change, and the press that
 * commits the rows the reader leaves ticked.
 *
 * Two commands rather than one, which is issue #352's whole shape: `wishlist_optimize_plan` writes
 * nothing, so the reader can read what would happen and untick the parts they disagree with before
 * anything moves.
 *
 * **Nothing is fetched until the dialog is open.** `enabled` is the gate and `open` is what it
 * means — `usePullPlan`'s rule, for its reason: this is the widest read this page makes, and a
 * surface nobody has opened has no business asking for it on every filter keystroke. It is a gate
 * on a mounted query rather than a conditionally mounted hook, so a reader who shuts the dialog
 * and reopens it on the same list pays nothing.
 *
 * @param query The list's own filters, folder and marketplace — see {@link OptimizeQuery}.
 * @param open Whether the dialog is up.
 */
export function useWishlistOptimize(query: OptimizeQuery, open: boolean) {
  const queryClient = useQueryClient();

  const plan = useQuery({
    queryKey: optimizePlanKey(query),
    // `limit`/`offset` are required by `WishlistQuery` and ignored by this command; `0` is the
    // list's own "use the default" and is the honest thing to send for a field the answer does not
    // depend on. Spelled here rather than in the caller so no surface has to know it.
    queryFn: (): Promise<WishlistOptimizePlan> =>
      ipc.wishlistOptimizePlan({ ...query, limit: 0, offset: 0 }),
    enabled: open,
  });

  /**
   * Commit the ticked rows — one transaction, and the whole list re-read afterwards.
   *
   * **`settleWhole`'s two roots, because this is that same write made in bulk.** A repointed wish
   * changes its printing, its set, its language and its unit price, which moves the list, the
   * header's two figures and the subtotal on every folder card above it — none of it arithmetic
   * this page could redo — and a *merge* answers about a row that no longer exists at all. And
   * `["cards", "search"]` for `WishRow`'s other end: a search result draws `wishlisted` per
   * printing, so a sweep moves the heart off one printing and onto another on every wall showing
   * that card.
   *
   * **Both ways, deliberately.** `wishlist_optimize_apply` is all-or-nothing, so a refusal has
   * written nothing — but the commonest refusal is a row another surface has already moved, which
   * is exactly the state the list on screen is wrong about. The re-read costs one query over a
   * list of tens of rows either way.
   */
  const apply = useMutation({
    mutationFn: (items: WishOptimizeApplyItem[]) => ipc.wishlistOptimizeApply(items),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });

  return { plan, apply };
}
