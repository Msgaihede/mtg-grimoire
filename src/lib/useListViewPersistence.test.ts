import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listView = vi.hoisted(() => vi.fn());
const setListView = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ ipc: { listView, setListView } }));

import { LIST_SECTIONS, useAppStore, type ListSection } from "@/lib/store";
import { useListViewPersistence } from "@/lib/useListViewPersistence";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  listView.mockReset().mockResolvedValue({});
  setListView.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Let the mount effect's `ipc.listView()` promise settle, inside `act` so the store write lands. */
async function settleRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The setter for one section, which is what the toggle presses. */
const PRESS: Record<ListSection, (view: "grid" | "table") => void> = {
  search: (v) => useAppStore.getState().setSearchView(v),
  tags: (v) => useAppStore.getState().setTagsView(v),
  collection: (v) => useAppStore.getState().setCollectionView(v),
  wishlist: (v) => useAppStore.getState().setWishlistView(v),
};

describe("the launch read", () => {
  it("seeds the store from the stored row", async () => {
    listView.mockResolvedValue({ collection: "table", tags: "table" });
    renderHook(() => useListViewPersistence());

    await settleRead();

    expect(useAppStore.getState().collectionView).toBe("table");
    expect(useAppStore.getState().tagsView).toBe("table");
    // Untouched by the row, so still the default this app opens on.
    expect(useAppStore.getState().searchView).toBe("grid");
    expect(useAppStore.getState().wishlistView).toBe("grid");
  });

  /**
   * Outside a Tauri window there is no command to call, and a `set_list_view` that answers BUSY
   * under a first-run sync is the same shape. Losing a stored layout is not worth an unhandled
   * rejection, let alone taking the app down — so both halves swallow, and this is the assertion
   * that the swallow exists rather than that it is spelled a particular way.
   */
  it("leaves every list on its default when the read fails", async () => {
    listView.mockRejectedValue(new Error("no such command"));
    renderHook(() => useListViewPersistence());

    await settleRead();

    expect(useAppStore.getState().collectionView).toBe("grid");
  });

  /** A read that lands after the window is gone must not seed a store the next one will use —
   *  StrictMode's double mount is where that actually bites. */
  it("does not seed after unmount", async () => {
    let resolve: (v: Record<string, string>) => void = () => {};
    listView.mockReturnValue(
      new Promise<Record<string, string>>((r) => {
        resolve = r;
      }),
    );
    const { unmount } = renderHook(() => useListViewPersistence());
    unmount();

    await act(async () => {
      resolve({ collection: "table" });
      await Promise.resolve();
    });

    expect(useAppStore.getState().collectionView).toBe("grid");
  });
});

describe("the write", () => {
  /**
   * **Every section, and each writing its own name and its own word.** The subscriber picks the
   * layout out of a record keyed by section, which is exactly the kind of mapping that goes wrong
   * in one arm and stays right in the other three — so all four are pressed rather than a
   * representative one.
   */
  it.each(LIST_SECTIONS)("stores %s's own layout when its toggle is pressed", async (section) => {
    renderHook(() => useListViewPersistence());
    await settleRead();

    act(() => PRESS[section]("table"));

    expect(setListView).toHaveBeenCalledExactlyOnceWith(section, "table");
  });

  /**
   * **The press is the thing counted, not the value** — `store.ts`'s `listViewPulse`. A reader
   * pressing `Card view` on a list already showing art has made a choice, and a value-watcher
   * would write nothing for it. It reads as a control that did not take on the launch after.
   */
  it("writes even when the press does not move the layout", async () => {
    renderHook(() => useListViewPersistence());
    await settleRead();

    act(() => PRESS.search("grid"));

    expect(setListView).toHaveBeenCalledExactlyOnceWith("search", "grid");
  });

  /** The seed is a value arriving rather than a press happening, so it must not be written
   *  straight back — four round trips at launch telling the database what it just said. */
  it("writes nothing for the layouts the launch read seeded", async () => {
    listView.mockResolvedValue({ collection: "table", search: "table" });
    renderHook(() => useListViewPersistence());

    await settleRead();

    expect(setListView).not.toHaveBeenCalled();
  });

  /** A refused write keeps the reader's choice for the session and says nothing — the rejection
   *  settles inside the hook rather than reaching a boundary. */
  it("swallows a refused write and keeps the layout", async () => {
    setListView.mockRejectedValue("busy");
    renderHook(() => useListViewPersistence());
    await settleRead();

    act(() => PRESS.collection("table"));

    expect(useAppStore.getState().collectionView).toBe("table");
  });

  /** The subscription is torn down, so a store this hook is done with cannot go on writing. */
  it("stops writing after unmount", async () => {
    const { unmount } = renderHook(() => useListViewPersistence());
    await settleRead();
    unmount();

    act(() => PRESS.wishlist("table"));

    expect(setListView).not.toHaveBeenCalled();
  });
});
