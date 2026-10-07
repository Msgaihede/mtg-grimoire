import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKS, TRAY_ROWS, VERDICTS } from "./fixtures";
import type { ScannerDecision, ScannerFinishPref, ScannerTrayRow } from "./types";
import { FLASH_MS, useTrayLanding } from "./useTrayLanding";

/** A tray as the hook reads it: `latest()` is whatever the last write left, as `useTray`'s is. */
function trayOf(rows: ScannerTrayRow[] = []) {
  let now = rows;
  const setRows = vi.fn((next: ScannerTrayRow[]) => {
    now = next;
  });
  return { latest: () => now, setRows, write: (next: ScannerTrayRow[]) => (now = next) };
}

/** A Fast decision — the fixture's — and the same card decided in Exact with rivals. */
const RESOLVED = VERDICTS.decided.decision as ScannerDecision;
const AMBIGUOUS = VERDICTS.exactAmbiguous.decision as ScannerDecision;

function mount(tray: ReturnType<typeof trayOf>, pref: ScannerFinishPref = "detect") {
  return renderHook(({ finish }) => useTrayLanding(tray, finish), {
    initialProps: { finish: pref },
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useTrayLanding", () => {
  it("says nothing before a card has landed", () => {
    const { result } = mount(trayOf());
    expect(result.current.lastAdded).toBeNull();
    expect(result.current.landed).toBeNull();
    expect(result.current.flashKey).toBeNull();
  });

  it("lands a decision as the tray's newest row, and remembers what to say about it", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision(RESOLVED));

    expect(tray.setRows).toHaveBeenCalledTimes(1);
    const [row] = tray.latest();
    expect(row).toMatchObject({
      cardId: RESOLVED.printing,
      name: "Storm of Saruman",
      quantity: 1,
      // Detect, a printing sold two ways, and a dot on the collector line.
      finish: "nonfoil",
    });
    expect(result.current.lastAdded).toEqual({
      name: "Storm of Saruman",
      setCode: "LTR",
      collectorNumber: "72",
      bumpedTo: null,
      replaced: false,
    });
    expect(result.current.landed).toMatchObject({ kind: "added", name: "Storm of Saruman" });
    expect(result.current.flashKey).toBe(row.key);
  });

  it("builds on the tray as it is, not as a render drew it", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    // A card another writer put in the tray after this hook's last render — the pump writes
    // between two renders, and nothing here has re-rendered since.
    tray.write([TRAY_ROWS[1]]);
    act(() => result.current.onDecision(RESOLVED));
    expect(tray.latest().map((row) => row.name)).toEqual(["Storm of Saruman", "Urza's Saga"]);
  });

  it("counts a second copy onto the newest row, and says how many", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision(RESOLVED));
    act(() => result.current.onDecision(RESOLVED));
    expect(tray.latest()).toHaveLength(1);
    expect(tray.latest()[0].quantity).toBe(2);
    expect(result.current.lastAdded).toMatchObject({ bumpedTo: 2, replaced: false });
    expect(result.current.landed).toMatchObject({ kind: "again", quantity: 2 });
  });

  it("stamps the finish the Defaults hold as the card lands, so a change moves only the next card", () => {
    const tray = trayOf();
    const { result, rerender } = mount(tray, "foil");
    act(() => result.current.onDecision(RESOLVED));
    expect(tray.latest()[0].finish).toBe("foil");

    rerender({ finish: "etched" });
    act(() => result.current.onDecision({ ...RESOLVED, printing: "another-printing" }));
    expect(tray.latest().map((row) => row.finish)).toEqual(["etched", "foil"]);
  });

  it("leaves a finish it cannot read for the reader", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision({ ...RESOLVED, finish_mark: MARKS.unmeasured }));
    expect(tray.latest()[0].finish).toBe("unknown");
  });

  it("lands an ambiguous decision as a row waiting on a pick", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision(AMBIGUOUS));
    expect(tray.latest()[0].choices).toHaveLength(3);
    expect(result.current.landed).toMatchObject({ kind: "pick" });
  });

  it("rewrites the newest row for a second opinion, and says updated rather than added", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision(RESOLVED));
    const key = tray.latest()[0].key;
    act(() =>
      result.current.onDecision({ ...RESOLVED, printing: "the-other-printing", replaces_previous: true }),
    );
    expect(tray.latest()).toHaveLength(1);
    expect(tray.latest()[0]).toMatchObject({ key, cardId: "the-other-printing", quantity: 1 });
    expect(result.current.lastAdded).toMatchObject({ replaced: true, bumpedTo: null });
    expect(result.current.landed).toMatchObject({ kind: "updated" });
  });

  it("marks the row for the flash and unmarks it after the hold, restarting the hold on each card", () => {
    const tray = trayOf();
    const { result } = mount(tray);
    act(() => result.current.onDecision(RESOLVED));
    act(() => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(result.current.flashKey).not.toBeNull();

    // A second card inside the first's hold: its own whole hold, not the remainder of the first.
    act(() => result.current.onDecision({ ...RESOLVED, printing: "another-printing" }));
    const second = tray.latest()[0].key;
    act(() => vi.advanceTimersByTime(FLASH_MS - 1));
    expect(result.current.flashKey).toBe(second);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.flashKey).toBeNull();
    // What to say about the last card is never taken back.
    expect(result.current.lastAdded).not.toBeNull();
  });

  it("puts the landed card away when the overlay says its hold is over", () => {
    const { result } = mount(trayOf());
    act(() => result.current.onDecision(RESOLVED));
    expect(result.current.landed).not.toBeNull();
    act(() => result.current.clearLanded());
    expect(result.current.landed).toBeNull();
  });

  it("leaves no timer behind when the view goes", () => {
    const { result, unmount } = mount(trayOf());
    act(() => result.current.onDecision(RESOLVED));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
