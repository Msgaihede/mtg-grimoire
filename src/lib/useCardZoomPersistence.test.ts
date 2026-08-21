import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const cardZoom = vi.hoisted(() => vi.fn());
const setCardZoom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ ipc: { cardZoom, setCardZoom } }));

import {
  DEFAULT_SECTION_ZOOMS,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  type ZoomSection,
} from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { ZOOM_WRITE_DELAY_MS, useCardZoomPersistence } from "@/lib/useCardZoomPersistence";

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState(useAppStore.getInitialState());
  cardZoom.mockReset().mockResolvedValue({});
  setCardZoom.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the mount effect's `ipc.cardZoom()` promise settle, inside `act` so the store write lands. */
async function settleRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** One notch up on a section, as the wheel handler makes it. */
function gesture(section: ZoomSection) {
  act(() => {
    useAppStore.getState().zoomCards(section, 1);
  });
}

function runTimers() {
  act(() => {
    vi.advanceTimersByTime(ZOOM_WRITE_DELAY_MS);
  });
}

describe("reading the stored zooms at launch", () => {
  it("seeds every section the row has something to say about", async () => {
    cardZoom.mockResolvedValue({ deck: 0.7, printings: 1.8 });
    renderHook(() => useCardZoomPersistence());

    await settleRead();

    expect(useAppStore.getState().cardZoom.deck).toBe(0.7);
    expect(useAppStore.getState().cardZoom.printings).toBe(1.8);
    // A section the row said nothing about keeps the default it was built with — the backend
    // stores only what has been zoomed and deliberately invents nothing.
    expect(useAppStore.getState().cardZoom.search).toBe(DEFAULT_ZOOM);
  });

  /**
   * **The badge must not appear at launch.** It is a HUD about a gesture, and a size arriving from
   * storage is not one — a percentage floating over a wall nobody touched would read as the app
   * having done something.
   */
  it("raises no badge for a size it restored", async () => {
    cardZoom.mockResolvedValue({ search: 1.5 });
    renderHook(() => useCardZoomPersistence());

    await settleRead();

    expect(useAppStore.getState().cardZoom.search).toBe(1.5);
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(useAppStore.getState().zoomSection).toBeNull();
  });

  /**
   * The read is a round trip, so a reader can zoom inside it. Their gesture is the newer fact and
   * has to win — a wall snapping back to last session's size under their hand, with nothing on
   * screen saying why, is the failure this guard exists for.
   */
  it("drops the whole seed if the reader zoomed while it was in flight", async () => {
    let answer: (value: Record<string, number>) => void = () => {};
    cardZoom.mockReturnValue(
      new Promise<Record<string, number>>((resolve) => {
        answer = resolve;
      }),
    );
    renderHook(() => useCardZoomPersistence());

    gesture("search");
    expect(useAppStore.getState().cardZoom.search).toBe(1.1);

    await act(async () => {
      answer({ search: 0.5, deck: 0.5 });
      await Promise.resolve();
    });

    expect(useAppStore.getState().cardZoom.search).toBe(1.1);
    expect(useAppStore.getState().cardZoom.deck).toBe(DEFAULT_ZOOM);
  });

  /**
   * A stored value need not be a stop: an older or newer build's ladder, a hand-edited row, and
   * Rust's own bound, which checks 0.5–2 and deliberately does not know where the rungs are.
   */
  it("snaps an off-ladder value onto the ladder", async () => {
    cardZoom.mockResolvedValue({ deck: 1.37 });
    renderHook(() => useCardZoomPersistence());

    await settleRead();

    expect(useAppStore.getState().cardZoom.deck).toBe(1.4);
  });

  /** A key this build does not draw is dropped rather than written into a typed record. */
  it("ignores a section this build has never heard of", async () => {
    cardZoom.mockResolvedValue({ eighthWall: 1.5, deck: 1.5 });
    renderHook(() => useCardZoomPersistence());

    await settleRead();

    expect(useAppStore.getState().cardZoom).toEqual({ ...DEFAULT_SECTION_ZOOMS, deck: 1.5 });
  });

  /**
   * A read that fails leaves every wall at `DEFAULT_ZOOM`, which is a complete, drawable app.
   * Nothing surfaces it — there is no sentence worth interrupting a launch with.
   */
  it("leaves every section at its default when the read fails", async () => {
    cardZoom.mockRejectedValue(new Error("no backend"));
    renderHook(() => useCardZoomPersistence());

    await settleRead();

    expect(useAppStore.getState().cardZoom).toEqual({ ...DEFAULT_SECTION_ZOOMS });
  });

  /** Once, at mount. Nothing re-reads the row: every later change to it goes through the write. */
  it("reads the row exactly once", async () => {
    const { rerender } = renderHook(() => useCardZoomPersistence());
    await settleRead();
    rerender();
    gesture("deck");

    expect(cardZoom).toHaveBeenCalledTimes(1);
  });

  /** **The seed is not written straight back**, which is what hanging the writes off the pulse
   *  rather than off the value buys: seven round trips at launch, telling the database what it
   *  said a moment earlier. */
  it("writes nothing back for the sizes it just read", async () => {
    cardZoom.mockResolvedValue({ deck: 0.7, search: 1.5 });
    renderHook(() => useCardZoomPersistence());

    await settleRead();
    runTimers();

    expect(setCardZoom).not.toHaveBeenCalled();
  });
});

describe("writing a gesture back", () => {
  it("stores the section and the size it settled on", async () => {
    renderHook(() => useCardZoomPersistence());
    await settleRead();

    gesture("collection");
    runTimers();

    expect(setCardZoom).toHaveBeenCalledExactlyOnceWith("collection", 1.1);
  });

  /**
   * The debounce, which is the shape of the whole thing: a rolled wheel and a trackpad pinch both
   * arrive as a run of events tens of ms apart, and a write per notch would be a run of
   * read-modify-writes for a value obsolete before it committed.
   */
  it("collapses a run of notches into one write of the value they settled on", async () => {
    renderHook(() => useCardZoomPersistence());
    await settleRead();

    for (let i = 0; i < 5; i++) {
      gesture("search");
      act(() => {
        vi.advanceTimersByTime(ZOOM_WRITE_DELAY_MS - 1);
      });
    }
    expect(setCardZoom).not.toHaveBeenCalled();

    runTimers();

    expect(setCardZoom).toHaveBeenCalledExactlyOnceWith("search", 1.5);
  });

  /**
   * **The case a value-watcher would miss.** `stepZoom` answers a gesture at 200% with 200%
   * forever, so `cardZoom` never moves — a debounce keyed off the value would never restart and
   * the write would land in the middle of a gesture the reader is still making.
   */
  it("writes once after a run of gestures the clamp swallowed", async () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, deck: MAX_ZOOM } });
    renderHook(() => useCardZoomPersistence());
    await settleRead();

    gesture("deck");
    gesture("deck");
    runTimers();

    expect(setCardZoom).toHaveBeenCalledExactlyOnceWith("deck", MAX_ZOOM);
  });

  /** One timer per section, so two walls zoomed in turn are both remembered. */
  it("keeps a separate timer for each section", async () => {
    renderHook(() => useCardZoomPersistence());
    await settleRead();

    gesture("deck");
    gesture("deckSearch");
    runTimers();

    expect(setCardZoom).toHaveBeenCalledTimes(2);
    expect(setCardZoom).toHaveBeenCalledWith("deck", 1.1);
    expect(setCardZoom).toHaveBeenCalledWith("deckSearch", 1.1);
  });

  /**
   * `set_card_zoom` answers BUSY while a sync holds the write connection, which a first run spends
   * whole minutes in. Nothing is surfaced and nothing is retried: the size the reader chose stands
   * for this session, and only the next launch's starting size is lost.
   */
  it("says nothing when the write is refused", async () => {
    setCardZoom.mockRejectedValue(new Error("busy"));
    renderHook(() => useCardZoomPersistence());
    await settleRead();

    gesture("search");
    runTimers();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useAppStore.getState().cardZoom.search).toBe(1.1);
  });

  /** A pending timer must not fire into a window that has gone — in a suite it would fire into
   *  the next test, which is how a debounce becomes a cross-test leak. */
  it("drops a pending write when the hook unmounts", async () => {
    const { unmount } = renderHook(() => useCardZoomPersistence());
    await settleRead();

    gesture("search");
    unmount();
    runTimers();

    expect(setCardZoom).not.toHaveBeenCalled();
  });

  /** And it stops listening: a gesture after the unmount schedules nothing at all. */
  it("stops writing once it has unmounted", async () => {
    const { unmount } = renderHook(() => useCardZoomPersistence());
    await settleRead();
    unmount();

    gesture("search");
    runTimers();

    expect(setCardZoom).not.toHaveBeenCalled();
  });
});
