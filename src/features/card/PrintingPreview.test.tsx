import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, Printing, PrintingsResponse } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { fireDragEvent } from "@/test-drag";

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
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
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
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
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
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    cardPrintings: (o: string, marketplace: MarketplaceId) => cardPrintings(o, marketplace),
  },
}));
import { CardDetailPane } from "./CardDetailPane";
import { previewBox, PREVIEW_DWELL_MS } from "./PrintingPreview";
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
  return qc;
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
 * Where the picture goes — the half of this feature jsdom cannot see, since every rectangle in
 * it is zero.
 *
 * The fixtures are rectangles **measured in the running window** on 2026-08-06 (Lightning Bolt,
 * 62 printings, the pane docked at the right of a 1280 × 800 and then a 1024 × 768 window), so
 * a regression here is a regression against something that was true on screen.
 */
describe("previewBox", () => {
  /** The pane at 1280 × 800: 710px of it, below the ribbon. */
  const PANE = { top: 70, bottom: 780, left: 876, right: 1260, width: 384 };
  /** A printings row halfway down it, 335px of content between the pane's padding. */
  const ROW = { top: 409, bottom: 441, left: 893, right: 1228, width: 335 };

  it("hangs the full-size picture under the row, right-aligned to it", () => {
    // 240 wide is the cap; 334 is 240 × 936/672, the `display` variant's own shape.
    expect(previewBox(ROW, PANE)).toEqual({ top: 445, left: 988, width: 240, height: 334 });
  });

  it("flips it above a row too near the foot of the pane", () => {
    const low = { ...ROW, top: 700, bottom: 732 };
    const box = previewBox(low, PANE);
    expect(box.height).toBe(334);
    // Ending 4px above the row rather than starting 4px below it, and still inside the pane.
    expect(box.top + box.height).toBe(low.top - 4);
    expect(box.top).toBeGreaterThanOrEqual(PANE.top);
  });

  /**
   * The 15px clip, which only the running window found: at the 1024 × 768 floor a row halfway
   * down the pane has 323px above it and 323px below, so a 334px picture fits **neither** side
   * — `shouldFlipUp` says "open the way it reads" and the pane cuts the bottom off it.
   */
  it("shrinks to the room a short pane leaves rather than being cut off by it", () => {
    const short = { ...PANE, bottom: 748 };
    const row = { ...ROW, top: 393, bottom: 425 };
    const box = previewBox(row, short);

    expect(box.width).toBe(229);
    expect(box.height).toBe(318);
    // The whole of it inside the pane, which is the only claim that matters.
    expect(box.top).toBeGreaterThanOrEqual(short.top);
    expect(box.top + box.height).toBeLessThanOrEqual(short.bottom);
  });

  it("never asks for a negative box when there is no room at all", () => {
    const box = previewBox(ROW, { ...PANE, top: 409, bottom: 441 });
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });
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
   * source and these rows carry their printing with them — which is now, so the press goes
   * through `test-drag`'s own event: a bare `fireEvent.dragStart` at a registered `cardDraggable`
   * has no `dataTransfer`, and the library says so on stderr rather than starting anything.
   */
  it("cancels the dwell when the row starts a drag", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(200);
    fireDragEvent(row, "dragstart");

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
   * A press is the reader doing something other than reading, and it is how every other layer
   * in this pane is opened — so it takes the picture down before that layer goes up. This is
   * the *first* half of "never the pane's second open layer"; the guard below is the second.
   */
  it("takes it down on a press inside the row", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.pointerDown(row));

    expect(preview()).toBeNull();
    // And it does not come back on the same still pointer: a press ended the dwell, it did not
    // postpone it.
    tick(10_000);
    expect(preview()).toBeNull();
  });

  /**
   * The keyboard's press. A control inside a row is activated with Enter or Space, and the
   * layer that opens is drawn inside that same row — so the caret never leaves it and no blur
   * arrives. Without this the picture would sit over the popup the press just opened.
   */
  it("takes it down on Enter in the row, where no blur would", async () => {
    await openPane();
    const add = screen.getByRole("button", { name: /\(M10 146\)/ });

    act(() => add.focus());
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.keyDown(add, { key: "Enter" }));

    expect(preview()).toBeNull();
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
   * …and only for a **layer**. The guard above is a whole-pane query, which makes it a kill
   * switch if it is aimed at the wrong attribute: this app writes a bare `aria-expanded` on
   * plain disclosures that stay open for minutes — a rail, a Maybe pile, an archived list, a
   * "why" — and the day this pane grows one (an expanded Rulings section) every preview in it
   * would stop appearing with nothing on screen or in the suite to say why. So the guard reads
   * the popup's own signature, both attributes, and a disclosure is none of its business.
   */
  it("is not suppressed by a disclosure that is merely open", async () => {
    await openPane();

    // A future section of this pane, in the shape the app already writes them: expanded, and
    // not a layer — no `aria-haspopup`.
    const rulings = document.createElement("button");
    rulings.setAttribute("aria-expanded", "true");
    rulings.textContent = "Rulings";
    screen.getByRole("complementary", { name: /card details/i }).append(rulings);

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);

    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));
  });

  /**
   * A picture measured against a row that has left the document is a 0×0 box at the top of the
   * pane — invisible, and still an `"inner"` layer holding the next Escape press. Nothing tells
   * a hover that its element was unmounted, so the list says so when its rows are replaced.
   */
  it("goes down with the rows it was measured against", async () => {
    const qc = await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    // What a refetch does: the same query, a different list. (`p2` is gone from it, so React
    // cannot reuse the row the picture was hung on.)
    act(() => {
      // The marketplace is the last segment of the key — `card_printings` prices every row with
      // it, so two marketplaces are two lists. Nothing here has chosen one.
      qc.setQueryData(["card", "printings", "o1", "tcgplayer"], {
        items: [printing(), printing({ id: "p4", setCode: "2ed", collectorNumber: "162" })],
        total: 2,
      });
      // Query-core batches every observer notification through a `setTimeout(…, 0)`, and the
      // clock is frozen — so without this the cache holds the new list and nothing has been
      // told about it yet.
      vi.advanceTimersByTime(0);
    });

    expect(preview()).toBeNull();
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
