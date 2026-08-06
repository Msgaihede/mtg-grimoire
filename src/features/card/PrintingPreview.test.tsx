import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, Printing, PrintingsResponse } from "@/lib/ipc";

const detail: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  prices: '{"usd":"400.50","usd_foil":null,"usd_etched":null,"eur":null,"tix":null}',
  finishes: '["nonfoil"]',
  imageStatus: "highres_scan",
  faces: [],
};

const printing = (over: Partial<Printing> = {}): Printing => ({
  id: "p1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  prices: '{"usd":"400.50","usd_foil":null,"usd_etched":null,"eur":null,"tix":null}',
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
  ...over,
});

/** Three printings of one card: the pane's own, and two to dwell on. */
const PRINTINGS: PrintingsResponse = {
  items: [
    printing(),
    printing({ id: "p2", setCode: "m10", collectorNumber: "146", releasedAt: "2009-07-17" }),
    printing({ id: "p3", setCode: "sta", collectorNumber: "42", releasedAt: "2021-04-23" }),
  ],
  total: 3,
};

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string) => cardDetail(id),
    cardPrintings: (o: string) => cardPrintings(o),
  },
}));
import { CardDetailPane } from "./CardDetailPane";
import { PREVIEW_DWELL_MS } from "./PrintingPreview";
import { useAppStore } from "@/lib/store";

/**
 * The preview is the one image in the pane with no `alt` — it is redundant art over a row that
 * already says which printing it is, so a screen reader is told nothing twice. Which makes
 * "empty alt" both the contract and the way to find it, with no test-only mark in the DOM.
 */
const previews = () => Array.from(document.querySelectorAll<HTMLImageElement>('img[alt=""]'));
const preview = () => previews()[0] ?? null;

/** The row a printing is drawn in, found by the one control that names the printing. */
const rowOf = (setAndNumber: string) =>
  screen
    .getByRole("button", { name: new RegExp(`\\(${setAndNumber}\\)`) })
    .closest("li") as HTMLElement;

const onClose = vi.fn();

/**
 * The pane, open, with its printings list on screen — and the clock frozen from that point on.
 *
 * Real timers for the two queries, because `userEvent` and Testing Library's async wrapper
 * drain the microtask queue through a real `setTimeout(…, 0)` and only ever advance *jest*'s
 * fake clock (`SearchPage.test.tsx` says the same, having hung on it). Everything the dwell
 * itself does is `fireEvent` plus an explicit tick, so nothing here needs the wrapper.
 */
async function openPane() {
  cardDetail.mockResolvedValue(detail);
  cardPrintings.mockResolvedValue(PRINTINGS);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CardDetailPane cardId="p1" onClose={onClose} />
    </QueryClientProvider>,
  );
  await screen.findByText(/3 printings/);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** Move the frozen clock, and let React commit what that woke up. */
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  cardDetail.mockReset();
  cardPrintings.mockReset();
  onClose.mockReset();
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The printings list, read with the pointer: a quarter of a second on a row and that printing's
 * art appears beside it (spec §3).
 *
 * The delay is a **dwell**, not a transition — nothing fades in, nothing eases, and
 * `prefers-reduced-motion` therefore has nothing to turn off. What it buys is a list that can
 * be scanned: dragging the pointer down forty rows on the way to the scrollbar must not open
 * forty pictures.
 */
describe("the printings list preview", () => {
  it("draws the row's art once the pointer has rested on it for a quarter second", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));

    // One millisecond short is nothing at all: a pointer crossing the row has not asked.
    tick(PREVIEW_DWELL_MS - 1);
    expect(preview()).toBeNull();

    tick(1);
    // The row's own printing, front face, at the size the pane's own art is fetched in.
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));
  });

  it("never draws it for a pointer that left before the quarter second was up", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(200);
    fireEvent.mouseLeave(row);

    // Not "later", ever: a cancelled dwell is a cleared timer, not a deferred one.
    tick(10_000);
    expect(preview()).toBeNull();
  });

  it("takes it down the instant the pointer leaves", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.mouseLeave(row));

    // No wait on the way out — the reader has moved on, and the picture is over the rows they
    // moved on to.
    expect(preview()).toBeNull();
  });

  /**
   * Keyboard parity, on the same clock. The row is not focusable itself — its controls are — so
   * the caret arriving anywhere inside it is the keyboard's version of the pointer resting on
   * it, and the caret leaving is the keyboard's version of moving away.
   */
  it("draws the same art on the same dwell when the caret arrives in the row", async () => {
    await openPane();
    const add = screen.getByRole("button", { name: /\(M10 146\)/ });

    act(() => add.focus());
    tick(PREVIEW_DWELL_MS - 1);
    expect(preview()).toBeNull();

    tick(1);
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));

    act(() => add.blur());
    expect(preview()).toBeNull();
  });

  /**
   * A row that is being dragged is not a row being read. The listener is on the row rather than
   * on any drag machinery, so it is already right for the day every card surface becomes a drag
   * source and these rows carry their printing with them.
   */
  it("cancels the dwell when the row starts a drag", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(200);
    fireEvent.dragStart(row);

    tick(10_000);
    expect(preview()).toBeNull();
  });

  /**
   * The Escape handshake, one rung further in than it has ever been in this pane: the preview
   * is an `"inner"` layer and consumes the press in the capture phase, so the pane underneath —
   * which returns early on a press something else has taken — stays open. The second press has
   * nothing in front of it and closes the card, which is where it was always going.
   */
  it("closes on Escape without taking the pane with it, and lets the next press through", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(first));

    expect(first.defaultPrevented).toBe(true);
    expect(preview()).toBeNull();
    expect(screen.getByRole("complementary", { name: /card details/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(second));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * What the preview is: decoration. The row beneath it already names the printing, so an
   * `alt` here would read the same card twice, and the wrapper is hidden outright so nothing
   * about a floating picture reaches a reader who cannot see it.
   *
   * And nothing on it animates. The 250 ms is a dwell, not a transition — the whole motion
   * budget is the mana line — so there is no fade to turn off under `prefers-reduced-motion`.
   */
  it("draws the art as decoration, with nothing that animates", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);

    const art = preview() as HTMLImageElement;
    expect(art).toHaveAttribute("alt", "");
    const frame = art.closest("[aria-hidden='true']");
    expect(frame).not.toBeNull();
    for (const element of [art, frame as HTMLElement]) {
      expect(element.className).not.toMatch(/transition|animate|duration|fade/);
    }
  });

  /**
   * The other half of "never the pane's second open layer" — the half a press cannot cover.
   *
   * With the quick-add popup open, hovering a *different* row moves no focus and presses
   * nothing, so without a guard the dwell runs and puts a card image over the finish chips the
   * reader is choosing from. Two `"inner"` layers, which `useDismissOnEscape` does not order.
   * Measured in the running window before the guard existed.
   */
  it("stays out of the way of a layer the reader already opened", async () => {
    await openPane();

    act(() => void fireEvent.click(screen.getByRole("button", { name: /\(M10 146\)/ })));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.mouseEnter(rowOf("STA 42"));
    tick(PREVIEW_DWELL_MS);

    expect(preview()).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  /**
   * One timer for the list, not one per row: the pointer travelling from row to row restarts
   * the same dwell, so a reader who ran down twenty rows sees nothing, and there is never a
   * second picture to close.
   */
  it("moves the one preview between rows rather than opening a second", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(previews()).toHaveLength(1);

    act(() => {
      fireEvent.mouseLeave(rowOf("M10 146"));
      fireEvent.mouseEnter(rowOf("STA 42"));
    });

    // Gone with the row it belonged to, and the new row's dwell starts from zero.
    expect(previews()).toHaveLength(0);
    tick(PREVIEW_DWELL_MS - 1);
    expect(previews()).toHaveLength(0);

    tick(1);
    expect(previews()).toHaveLength(1);
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p3/0"));
  });
});
