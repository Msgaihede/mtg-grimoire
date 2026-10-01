import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerTrayChoice, ScannerTrayRow } from "@/lib/ipc";
import { AddedToast, LANDED_HOLD_MS, landedFrom } from "./AddedToast";

/** A resolved row with names this file controls, so an assertion can spell them. */
const row: ScannerTrayRow = {
  key: "row-1",
  cardId: "ltr-426",
  oracleId: "oliphaunt",
  name: "Oliphaunt",
  setCode: "ltr",
  collectorNumber: "426",
  finish: "nonfoil",
  quantity: 1,
  choices: [],
  addedAt: 1_000,
};

/** Three candidates, so the fan's "first two" is a choice the component had to make. */
const choices: ScannerTrayChoice[] = [
  { cardId: "mt-1", oracleId: "minas", name: "Minas Tirith", setCode: "ltr", collectorNumber: "256" },
  { cardId: "mt-2", oracleId: "minas", name: "Minas Tirith", setCode: "ltc", collectorNumber: "380" },
  { cardId: "mt-3", oracleId: "minas", name: "Minas Tirith", setCode: "pltr", collectorNumber: "256p" },
];

/** A row waiting on a pick, wearing its best candidate provisionally — as `rowFromDecision` builds one. */
const waiting: ScannerTrayRow = {
  ...row,
  key: "row-2",
  cardId: "mt-1",
  oracleId: "minas",
  name: "Minas Tirith",
  setCode: "ltr",
  collectorNumber: "256",
  choices,
};

describe("landedFrom", () => {
  it("calls a new row an add, and carries the row's own facts", () => {
    expect(landedFrom(row, false, false)).toEqual({
      stamp: "row-1:1000",
      kind: "added",
      cardId: "ltr-426",
      name: "Oliphaunt",
      setCode: "ltr",
      collectorNumber: "426",
      finish: "nonfoil",
      quantity: 1,
      choices: [],
    });
  });

  it("calls a bump a second copy, with the row's new quantity", () => {
    const landing = landedFrom({ ...row, quantity: 3 }, true, false);
    expect(landing.kind).toBe("again");
    expect(landing.quantity).toBe(3);
  });

  it("calls a re-read an update", () => {
    expect(landedFrom({ ...row, finish: "foil" }, false, true).kind).toBe("updated");
  });

  /** A question outranks a fact: a re-read that came back ambiguous is still a pick to make. */
  it("calls a row waiting on a pick a pick, however it arrived", () => {
    for (const [bumped, replaced] of [
      [false, false],
      [false, true],
    ] as const) {
      const landing = landedFrom(waiting, bumped, replaced);
      expect(landing.kind).toBe("pick");
      expect(landing.choices).toEqual(choices);
    }
  });

  /** `addDecision` refreshes `addedAt` on a bump, so one row landing twice is two stamps. */
  it("stamps each landing of one row apart", () => {
    const first = landedFrom(row, false, false);
    const second = landedFrom({ ...row, quantity: 2, addedAt: 2_000 }, true, false);
    expect(second.stamp).toBe("row-1:2000");
    expect(second.stamp).not.toBe(first.stamp);
  });
});

describe("AddedToast", () => {
  it("says a new card was added, and names its printing", () => {
    render(<AddedToast card={landedFrom(row, false, false)} onDone={vi.fn()} />);
    expect(screen.getByText("Added to scanned cards")).toBeInTheDocument();
    expect(screen.getByText("Oliphaunt")).toBeInTheDocument();
    expect(screen.getByText("LTR · 426 · Nonfoil")).toBeInTheDocument();
  });

  it("says a second copy was added, with the row's count", () => {
    render(<AddedToast card={landedFrom({ ...row, quantity: 3 }, true, false)} onDone={vi.fn()} />);
    expect(screen.getByText("Added again")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.queryByText("Added to scanned cards")).toBeNull();
  });

  it("says a re-read changed the printing", () => {
    render(<AddedToast card={landedFrom({ ...row, finish: "foil" }, false, true)} onDone={vi.fn()} />);
    expect(screen.getByText("Printing updated")).toBeInTheDocument();
    expect(screen.getByText("LTR · 426 · Foil")).toBeInTheDocument();
  });

  it("asks for a pick, fans the first two candidates and names no printing", () => {
    const { container } = render(
      <AddedToast card={landedFrom(waiting, false, false)} onDone={vi.fn()} />,
    );
    expect(screen.getByText("Pick a printing")).toBeInTheDocument();
    expect(screen.getByText("Minas Tirith")).toBeInTheDocument();
    expect(screen.getByText("3 printings match — pick in the tray")).toBeInTheDocument();
    // The provisional printing is a guess, so the line that would state it is not drawn.
    expect(screen.queryByText(/LTR · 256/)).toBeNull();

    const pictures = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(pictures).toHaveLength(2);
    expect(pictures[0]).toContain("/grid/mt-1/0");
    expect(pictures[1]).toContain("/grid/mt-2/0");
  });

  it("draws one whole card for a settled landing", () => {
    const { container } = render(
      <AddedToast card={landedFrom(row, false, false)} onDone={vi.fn()} />,
    );
    const pictures = container.querySelectorAll("img");
    expect(pictures).toHaveLength(1);
    expect(pictures[0].getAttribute("src")).toContain("/grid/ltr-426/0");
  });

  /**
   * The Match strip is the view's live region and says the same thing; two live regions for one
   * landing would read every scan twice.
   */
  it("keeps the whole overlay out of the accessibility tree", () => {
    const { container } = render(
      <AddedToast card={landedFrom(row, false, false)} onDone={vi.fn()} />,
    );
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Oliphaunt").closest('[aria-hidden="true"]')).toBe(
      container.firstElementChild,
    );
    // `hidden: true`, or a live region inside the hidden layer would pass for absent.
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
  });

  it("draws nothing at all without a landing", () => {
    const { container } = render(<AddedToast card={null} onDone={vi.fn()} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-landed-flash]")).toBeNull();
  });

  /** Keyed on the stamp: a second copy of the same row must flash again, so it is a new element. */
  it("flashes the camera's edge once per landing, in the colour the kind means", () => {
    const { container, rerender } = render(
      <AddedToast card={landedFrom(row, false, false)} onDone={vi.fn()} />,
    );
    const first = container.querySelector("[data-landed-flash]");
    expect(first?.classList.contains("ring-ok")).toBe(true);

    rerender(
      <AddedToast card={landedFrom({ ...row, quantity: 2, addedAt: 2_000 }, true, false)} onDone={vi.fn()} />,
    );
    const second = container.querySelector("[data-landed-flash]");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    rerender(<AddedToast card={landedFrom(waiting, false, false)} onDone={vi.fn()} />);
    const pick = container.querySelector("[data-landed-flash]");
    expect(pick?.classList.contains("ring-accent")).toBe(true);
    expect(pick?.classList.contains("ring-ok")).toBe(false);
  });

  /** Real timers here: the exit settles on motion's own promise, which `waitFor` polls for. */
  it("lets the card leave when the landing is put away", async () => {
    const { container, rerender } = render(
      <AddedToast card={landedFrom(row, false, false)} onDone={vi.fn()} />,
    );
    rerender(<AddedToast card={null} onDone={vi.fn()} />);
    expect(container.querySelector("[data-landed-flash]")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Oliphaunt")).toBeNull());
  });
});

/**
 * The hold. Only `setTimeout` is faked — `requestAnimationFrame` is left real so `motion` is never
 * mid-anything, `CardStack.test.tsx`'s arrangement — and nothing here drives `userEvent`, which
 * hangs under Vitest's fake timers.
 */
describe("AddedToast's hold", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it("asks to be put away once the hold is over, and not before", () => {
    const onDone = vi.fn();
    render(<AddedToast card={landedFrom(row, false, false)} onDone={onDone} />);
    tick(LANDED_HOLD_MS - 1);
    expect(onDone).not.toHaveBeenCalled();
    tick(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("starts the hold over for a new landing", () => {
    const onDone = vi.fn();
    const { rerender } = render(<AddedToast card={landedFrom(row, false, false)} onDone={onDone} />);
    tick(LANDED_HOLD_MS - 500);
    rerender(
      <AddedToast card={landedFrom({ ...row, quantity: 2, addedAt: 2_000 }, true, false)} onDone={onDone} />,
    );
    tick(LANDED_HOLD_MS - 1);
    expect(onDone).not.toHaveBeenCalled();
    tick(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  /** A caller passing a fresh arrow each render gets the newest one called, on the first clock. */
  it("does not restart the hold for a new callback on the same landing", () => {
    const landing = landedFrom(row, false, false);
    const before = vi.fn();
    const after = vi.fn();
    const { rerender } = render(<AddedToast card={landing} onDone={before} />);
    tick(LANDED_HOLD_MS - 500);
    rerender(<AddedToast card={landing} onDone={after} />);
    tick(500);
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
  });

  it("stops the clock when it unmounts", () => {
    const onDone = vi.fn();
    const { unmount } = render(<AddedToast card={landedFrom(row, false, false)} onDone={onDone} />);
    unmount();
    tick(LANDED_HOLD_MS * 2);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("runs no clock without a landing", () => {
    const onDone = vi.fn();
    render(<AddedToast card={null} onDone={onDone} />);
    tick(LANDED_HOLD_MS * 2);
    expect(onDone).not.toHaveBeenCalled();
  });
});
