import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { WishlistQuery } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

const wishlistList = vi.hoisted(() => vi.fn());
/** `useMarketplace()` reads this too. An unmocked command is a rejected query that silently
 *  resolves to the default, so it is answered explicitly — `WishlistPage.test.tsx`'s reason. */
const getMarketplace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { wishlistList, getMarketplace },
}));

import { activeFilterCount, useWishlist, type WishlistFilterState } from "./useWishlist";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const lastQuery = () =>
  wishlistList.mock.calls[wishlistList.mock.calls.length - 1][0] as WishlistQuery;

beforeEach(() => {
  wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  /**
   * Flatten lives in the app store now, and the app store is a **module singleton** — so unlike
   * every `useState` in this hook it is not handed back fresh to each `renderHook`. A test that
   * left it on would hand the next one a flattened list, and the failure would land wherever the
   * file happens to run that test rather than where the bug is.
   *
   * The whole initial state rather than the one field, which is `store.test.ts`'s idiom: it
   * cannot go stale when the default moves, and it resets anything a later test starts using.
   */
  useAppStore.setState(useAppStore.getInitialState());
});

/**
 * `folderId` and `flatten` are navigation, not filters — `useWishlist.ts`'s doc comments say
 * why at each field. This is the test that holds the boundary: `WishlistFilterState` never
 * grew a fourth and fifth field for them, so this checks the *hook's* `activeCount` rather
 * than `activeFilterCount` itself, which never sees either one.
 */
describe("folderId and flatten are not filters", () => {
  it("does not count opening a folder or flattening the list", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    expect(result.current.activeCount).toBe(0);

    act(() => result.current.openFolder(3));
    act(() => result.current.toggleFlatten());

    expect(result.current.activeCount).toBe(0);
  });

  /** Same check with a real filter on, so a bug that folded navigation into the count would
   *  not hide behind "both read zero". */
  it("still counts only the real filters once navigation is also on", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });

    act(() => result.current.setText("bolt"));
    act(() => result.current.openFolder(3));
    act(() => result.current.toggleFlatten());

    expect(result.current.activeCount).toBe(1);
  });

  /** `resetAll` is written next to the exclusion in `useWishlist.ts` on purpose — this is the
   *  test that keeps the comment honest. The sort survives a reset for the same reason.
   *
   *  **It matters more now that `flatten` is store state, not less.** `resetAll` is a list of
   *  `set*` calls over this hook's own `useState`s, and the one thing it must never grow is a
   *  reach into the store: `wishlistFlattened` is persisted, so clearing it would throw away a
   *  preference that outlives the session. Asserted at the store as well as at the hook. */
  it("resetAll clears every filter and leaves folderId and flatten standing", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });

    act(() => {
      result.current.setText("bolt");
      result.current.toggleFulfilled();
      result.current.toggleNeedsReview();
      result.current.openFolder(3);
      result.current.toggleFlatten();
    });
    expect(result.current.activeCount).toBe(3);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.text).toBe("");
    expect(result.current.fulfilled).toBeUndefined();
    expect(result.current.needsReview).toBeUndefined();
    // The part `resetAll` must not touch.
    expect(result.current.folderId).toBe(3);
    expect(result.current.flatten).toBe(true);
    // …and the store still holds it, which is the half a `flatten` read off a stale render could
    // not tell you. This is the assertion a `resetAll` that reset the store would fail.
    expect(useAppStore.getState().wishlistFlattened).toBe(true);
  });
});

/**
 * Flatten moved out of `useState` and into the app store (`wishlistFlattened`), so that it is
 * remembered across launches. The hook's shape did not move with it — `{ flatten, toggleFlatten }`
 * is still the whole of what `WishlistPage` and the filter bar see — and these are the three
 * things the move had to buy and could not have been true before it.
 */
describe("flatten lives in the app store", () => {
  /** Both directions: the hook reports what the store holds, and the toggle writes back. The
   *  store write is the one a reader cannot make — nothing on screen sets this field outright —
   *  so it stands in for the launch that hands the hook a remembered `true`. */
  it("reports the store's flatten and writes back through it", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    expect(result.current.flatten).toBe(false);

    // The store moving is enough — the hook subscribes to the field rather than copying it.
    act(() => useAppStore.setState({ wishlistFlattened: true }));
    expect(result.current.flatten).toBe(true);

    act(() => result.current.toggleFlatten());
    expect(useAppStore.getState().wishlistFlattened).toBe(false);
    expect(result.current.flatten).toBe(false);

    act(() => result.current.toggleFlatten());
    expect(useAppStore.getState().wishlistFlattened).toBe(true);
    expect(result.current.flatten).toBe(true);
  });

  /**
   * **The wishlist opens unflattened, where the collection opens flattened** — its own field
   * rather than a second reader of the cabinet's, and this is where the two would be caught
   * having become one. A shopping list's folders are how the reader groups what they are saving
   * *for*, and someone who flattened their binder was not saying anything about that.
   */
  it("starts unflattened, because that is what the store remembers by default", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });

    expect(result.current.flatten).toBe(false);
    expect(useAppStore.getInitialState().wishlistFlattened).toBe(false);
    // …and nothing reaches the wire, which is the `flatten || undefined` rule this list keeps.
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().flatten).toBeUndefined();
  });

  /**
   * The point of the move, stated as the thing `useState` could not do: two mounted hooks are two
   * subscribers to one field, so a press on either agrees on both. Under `useState` each had a
   * switch of its own and this read `true, false`.
   */
  it("agrees with a second hook mounted over the same store", () => {
    const first = renderHook(() => useWishlist(), { wrapper });
    const second = renderHook(() => useWishlist(), { wrapper });

    act(() => first.result.current.toggleFlatten());

    expect(first.result.current.flatten).toBe(true);
    expect(second.result.current.flatten).toBe(true);

    act(() => second.result.current.toggleFlatten());

    expect(first.result.current.flatten).toBe(false);
    expect(second.result.current.flatten).toBe(false);
  });

  /**
   * The wire, from the store rather than from a press — a remembered `true` has to reach
   * `ipc.wishlistList` on the view's *first* request, which is the one thing a test that only
   * ever toggles cannot see. `folderId` still rides along beside it here, because this list's
   * backend reads the two together where the collection's drops the id.
   */
  it("sends a remembered flatten on the very first request", async () => {
    useAppStore.setState({ wishlistFlattened: true });
    renderHook(() => useWishlist(), { wrapper });

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().flatten).toBe(true);
  });
});

describe("openFolder", () => {
  it("moves folderId and sends it on the wire, without turning flatten on", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());

    act(() => result.current.openFolder(3));

    expect(result.current.folderId).toBe(3);
    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    // Sent only when `true` — `useWishlist.ts`'s rule for `flatten`, the same one `text`
    // already follows. Opening a folder must not smuggle it on.
    expect(lastQuery().flatten).toBeUndefined();
  });

  /** The root is a real destination (`null`), but the backend already defaults an absent
   *  field to it — so the untouched hook, and a folder closed back to `null`, both omit the
   *  field rather than spell out what the other end would infer anyway. */
  it("omits folderId at the root, including after leaving a folder", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().folderId).toBeUndefined();

    act(() => result.current.openFolder(3));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));

    act(() => result.current.openFolder(null));

    expect(result.current.folderId).toBeNull();
    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
  });
});

describe("toggleFlatten", () => {
  it("sends flatten on the wire once it is on", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().flatten).toBeUndefined();

    act(() => result.current.toggleFlatten());

    expect(result.current.flatten).toBe(true);
    await waitFor(() => expect(lastQuery().flatten).toBe(true));

    act(() => result.current.toggleFlatten());

    expect(result.current.flatten).toBe(false);
    await waitFor(() => expect(lastQuery().flatten).toBeUndefined());
  });
});

/**
 * Both fields join `listKey`, which `queryKeyString` mirrors — the scroll reset's whole
 * mechanism. Two folders, or a folder and the flattened view of the same tree, have to be two
 * different lists or a drill-down would render the folder just left for a moment.
 */
describe("listKey", () => {
  it("keys the query on folderId, so two folders never share a cached page", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    const root = result.current.queryKeyString;

    act(() => result.current.openFolder(3));
    const three = result.current.queryKeyString;
    expect(three).not.toBe(root);

    act(() => result.current.openFolder(5));
    const five = result.current.queryKeyString;
    expect(five).not.toBe(three);

    act(() => result.current.openFolder(null));
    expect(result.current.queryKeyString).toBe(root);
  });

  it("keys the query on flatten, distinctly from any one folder", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    const root = result.current.queryKeyString;

    act(() => result.current.toggleFlatten());
    const flat = result.current.queryKeyString;
    expect(flat).not.toBe(root);

    act(() => result.current.openFolder(3));
    const flatInFolderThree = result.current.queryKeyString;
    expect(flatInFolderThree).not.toBe(flat);
    expect(flatInFolderThree).not.toBe(root);
  });
});

// `activeFilterCount` still takes neither `folderId` nor `flatten` — they are navigation rather
// than filters, which is the point above and is what survived the row growing. This is the one
// direct check on the exported function, since nothing else in the tree calls it.
const NONE = {
  text: "",
  format: "",
  colors: [],
  sets: [],
  manaValues: [],
  manaX: false,
  rarities: [],
  fulfilled: undefined,
  needsReview: undefined,
} satisfies WishlistFilterState;

describe("activeFilterCount", () => {
  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(NONE)).toBe(0);
  });

  /** Kinds, not values — the badge tells the reader how much is about to change, and "two
   *  rarities" is one thing that is on. */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...NONE, text: "bolt" })).toBe(1);
    expect(activeFilterCount({ ...NONE, format: "modern" })).toBe(1);
    expect(activeFilterCount({ ...NONE, colors: ["R", "U"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, sets: ["lea"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, rarities: ["rare", "mythic"] })).toBe(1);
    // `false` — "the wishes nothing covers" — is a filter too, and is the list's usual question.
    // Compared against `undefined`, never tested for truthiness.
    expect(activeFilterCount({ ...NONE, fulfilled: false })).toBe(1);
    expect(activeFilterCount({ ...NONE, needsReview: true })).toBe(1);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...NONE, text: "   " })).toBe(0);
  });

  /** X is the last chip of the mana-value group and is OR'd with the numerals, so it is that same
   *  kind — but an X-only filter still has to be seen, or Reset all would hide over a list that
   *  is filtered. */
  it("counts the X chip with the mana values it sits among", () => {
    expect(activeFilterCount({ ...NONE, manaX: true })).toBe(1);
    expect(activeFilterCount({ ...NONE, manaValues: [1], manaX: true })).toBe(1);
  });

  /** Eight, where it was three until the three card views started drawing one `FilterBar`.
   *  Reset all has to reach every one of them, so the count has to see every one of them. */
  it("sees all eight kinds the wishlist offers", () => {
    expect(
      activeFilterCount({
        text: "bolt",
        format: "modern",
        colors: ["R"],
        sets: ["lea"],
        manaValues: [1],
        manaX: true,
        rarities: ["rare"],
        fulfilled: false,
        needsReview: true,
      }),
    ).toBe(8);
  });
});
