import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const flattenState = vi.hoisted(() => vi.fn());
const setFlattenState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ ipc: { flattenState, setFlattenState } }));

import { FLATTEN_SECTIONS, useAppStore, type FlattenSection } from "@/lib/store";
import { useFlattenPersistence } from "@/lib/useFlattenPersistence";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  flattenState.mockReset().mockResolvedValue({});
  setFlattenState.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Let the mount effect's `ipc.flattenState()` promise settle, inside `act` so the store write
 *  lands. */
async function settleRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The toggle for one page, which is what the switch presses. */
const PRESS: Record<FlattenSection, () => void> = {
  collection: () => useAppStore.getState().toggleCollectionFlattened(),
  wishlist: () => useAppStore.getState().toggleWishlistFlattened(),
};

/** What each page opens on before anything is stored — deliberately **not** the same answer, and
 *  `store.ts` carries the measurement. Written here as the pair rather than as two literals so a
 *  test below can say "still the default" without picking one. */
const DEFAULT: Record<FlattenSection, boolean> = { collection: true, wishlist: false };

describe("the launch read", () => {
  it("seeds the store from the stored row", async () => {
    flattenState.mockResolvedValue({ collection: false, wishlist: true });
    renderHook(() => useFlattenPersistence());

    await settleRead();

    expect(useAppStore.getState().collectionFlattened).toBe(false);
    expect(useAppStore.getState().wishlistFlattened).toBe(true);
  });

  /** A row naming one page leaves the other on the default it was built with — which is where
   *  the two differing defaults have to survive a read rather than collapsing into each other. */
  it("leaves a page the row says nothing about on its own default", async () => {
    flattenState.mockResolvedValue({ wishlist: true });
    renderHook(() => useFlattenPersistence());

    await settleRead();

    expect(useAppStore.getState().wishlistFlattened).toBe(true);
    expect(useAppStore.getState().collectionFlattened).toBe(DEFAULT.collection);
  });

  /**
   * Outside a Tauri window there is no command to call, and a `set_flatten_state` that answers
   * BUSY under a first-run sync is the same shape. Losing a stored switch is not worth an
   * unhandled rejection, let alone taking the app down — so both halves swallow, and this is the
   * assertion that the swallow exists rather than that it is spelled a particular way.
   */
  it("leaves both pages on their defaults when the read fails", async () => {
    flattenState.mockRejectedValue(new Error("no such command"));
    renderHook(() => useFlattenPersistence());

    await settleRead();

    expect(useAppStore.getState().collectionFlattened).toBe(DEFAULT.collection);
    expect(useAppStore.getState().wishlistFlattened).toBe(DEFAULT.wishlist);
  });

  /** A read that lands after the window is gone must not seed a store the next one will use —
   *  StrictMode's double mount is where that actually bites. */
  it("does not seed after unmount", async () => {
    let resolve: (v: Record<string, boolean>) => void = () => {};
    flattenState.mockReturnValue(
      new Promise<Record<string, boolean>>((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useFlattenPersistence());
    unmount();

    await act(async () => {
      resolve({ collection: false });
      await Promise.resolve();
    });

    expect(useAppStore.getState().collectionFlattened).toBe(DEFAULT.collection);
  });
});

describe("the write", () => {
  /**
   * **Both pages, each writing its own name and its own answer.** The subscriber picks the
   * boolean out of a record keyed by section, which is exactly the kind of mapping that goes
   * wrong in one arm and stays right in the other — so both are pressed rather than a
   * representative one, and each expects the value *its* default flips to.
   */
  it.each(FLATTEN_SECTIONS)("stores %s's own switch when it is pressed", async (section) => {
    renderHook(() => useFlattenPersistence());
    await settleRead();

    // **Press the other page first, and that line is load-bearing.** At the defaults the two
    // booleans agree once either is pressed — the collection flips to `false`, the wishlist flips
    // to `false` — so a subscriber that read one page's answer and wrote it under the *other*
    // page's name passed this test in both arms. It did, until this line; putting the two into
    // disagreement first is what makes the record lookup observable.
    const other: FlattenSection = section === "collection" ? "wishlist" : "collection";
    act(() => PRESS[other]());
    setFlattenState.mockClear();

    act(() => PRESS[section]());

    expect(setFlattenState).toHaveBeenCalledExactlyOnceWith(section, !DEFAULT[section]);
  });

  /** Pressing twice is a reader changing their mind, not a gesture continuing — so both presses
   *  are written, and the second says the opposite of the first. */
  it("writes every press, in both directions", async () => {
    renderHook(() => useFlattenPersistence());
    await settleRead();

    act(() => PRESS.collection());
    act(() => PRESS.collection());

    expect(setFlattenState.mock.calls).toEqual([
      ["collection", false],
      ["collection", true],
    ]);
  });

  /** The seed is a value arriving rather than a press happening, so it must not be written
   *  straight back — two round trips at launch telling the database what it just said. */
  it("writes nothing for the switches the launch read seeded", async () => {
    flattenState.mockResolvedValue({ collection: false, wishlist: true });
    renderHook(() => useFlattenPersistence());

    await settleRead();

    expect(setFlattenState).not.toHaveBeenCalled();
  });

  /**
   * A refused write keeps the reader's choice for the session and says nothing — the rejection
   * settles inside the hook rather than reaching a boundary.
   *
   * **Only the first half of that is checkable here, and the reason is worth writing down.**
   * Deleting the write's `.catch` leaves this file green: measured 2026-08-26 with a throwaway
   * probe, an uncaught `Promise.reject("busy")` is reported by vitest as an unhandled rejection
   * and fails the run, while an uncaught `vi.fn().mockRejectedValue("busy")` is **not** — vitest
   * attaches its own handler to whatever promise a mock returns in order to track its settled
   * result, so a mocked rejection can never *be* unhandled. The read's `.catch` above is caught
   * only because deleting it means rethrowing from a handler, which produces a fresh promise
   * vitest does not own.
   *
   * So this asserts what a reader can see — the switch they pressed is still the switch the page
   * is drawing — and deliberately not that the swallow is spelled `.catch`, which is
   * `useListViewPersistence.test.ts`' own line. The settle is here so the rejection lands inside
   * the test rather than after it.
   */
  it("swallows a refused write and keeps the switch", async () => {
    setFlattenState.mockRejectedValue("busy");
    renderHook(() => useFlattenPersistence());
    await settleRead();

    act(() => PRESS.collection());
    await settleRead();

    expect(useAppStore.getState().collectionFlattened).toBe(false);
  });

  /** The subscription is torn down, so a store this hook is done with cannot go on writing. */
  it("stops writing after unmount", async () => {
    const { unmount } = renderHook(() => useFlattenPersistence());
    await settleRead();
    unmount();

    act(() => PRESS.wishlist());

    expect(setFlattenState).not.toHaveBeenCalled();
  });
});
