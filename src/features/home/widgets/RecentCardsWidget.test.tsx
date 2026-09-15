import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one read this body makes, stood in front of an intact mirror — `DecksWidget.test.tsx`'s
 * shape and for its reason: a wholesale `vi.fn()` object would erase every other command on
 * `ipc`. Cases with data seed the cache through the exported key, so the mock only ever answers
 * the two states a cache cannot hold — a read still out, and a read refused.
 */
const recentCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, recentCards } };
});

import type { HomeWidget, RecentCard } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { makeFit, type WidgetFit } from "../fit";
import { recentCardsKey } from "../keys";
import {
  artHeight,
  CAPTION_PX,
  EMPTY,
  RECENT_CARDS_READ,
  RecentCardsWidget,
  STRIP_BAR_PX,
  tileCount,
} from "./RecentCardsWidget";

function card(n: number): RecentCard {
  return { cardId: `c${n}`, name: `Card ${n}`, setCode: "lea", viewedAt: 1_800_000_000 - n };
}

function widget(config: unknown = null, w = 4, h = 2): HomeWidget {
  return { id: "recentCards", kind: "recentCards", x: 0, y: 0, w, h, config };
}

/** A footprint drawn at the default layout's 104px cell. */
function fitFor(w: number, h: number): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: w * 104 + (w - 1) * 12,
    heightPx: h * 104 + (h - 1) * 12,
    density: "comfortable",
  });
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw({
  config = null,
  w = 4,
  h = 2,
  still = false,
}: { config?: unknown; w?: number; h?: number; still?: boolean } = {}) {
  return render(
    <RecentCardsWidget
      widget={widget(config, w, h)}
      fit={fitFor(w, h)}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  recentCards.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useAppStore.setState(useAppStore.getInitialState());
});

describe("tileCount", () => {
  // The design's rule: the reader's count, two a cell of width at most, never fewer than two.
  it("caps the reader's count at two tiles a cell and floors it at two", () => {
    expect(tileCount(8, 4)).toBe(8);
    expect(tileCount(8, 3)).toBe(6);
    expect(tileCount(8, 2)).toBe(4);
    expect(tileCount(4, 8)).toBe(4);
    expect(tileCount(8, 1)).toBe(2);
  });
});

describe("artHeight", () => {
  // The caption line and the strip's bar are both taken off the body whether or not they are
  // drawn — the art must not move when the names are switched off or the strip overflows.
  it("takes the caption and the scrollbar off the body, and a still draws no bar", () => {
    const fit = fitFor(4, 2);
    expect(artHeight(fit, false)).toBe(Math.floor(fit.bodyHeightPx - CAPTION_PX - STRIP_BAR_PX));
    expect(artHeight(fit, true)).toBe(Math.floor(fit.bodyHeightPx - CAPTION_PX));
  });
});

describe("RecentCardsWidget", () => {
  it("says it is reading while the read is out", () => {
    recentCards.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(screen.getByText("Reading the cards you opened…")).toBeInTheDocument();
  });

  it("says what opening a card will do when nothing has been opened", async () => {
    draw();
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    recentCards.mockRejectedValue("the database is locked");
    draw();
    expect(
      await screen.findByText("Could not read the cards you opened — the database is locked"),
    ).toBeInTheDocument();
  });

  // One read whatever the box: the key carries the widget's largest count, not the tile count.
  it("reads the most any setting draws and cuts it to the tiles that fit", async () => {
    recentCards.mockResolvedValue(Array.from({ length: 8 }, (_, i) => card(i + 1)));
    draw({ w: 2 });
    const tiles = await screen.findAllByRole("button");
    expect(tiles).toHaveLength(4);
    expect(recentCards).toHaveBeenCalledWith(RECENT_CARDS_READ);
  });

  it("draws the reader's count when the box has room for more", () => {
    qc.setQueryData(recentCardsKey(RECENT_CARDS_READ), [1, 2, 3, 4, 5, 6, 7, 8].map(card));
    draw({ config: { count: 4 }, w: 8 });
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("names each tile by its card and set, and opens the card on a press", async () => {
    qc.setQueryData(recentCardsKey(RECENT_CARDS_READ), [card(1), card(2)]);
    draw();
    const tile = screen.getByRole("button", { name: "Card 2 · LEA" });
    expect(tile).toHaveAccessibleName("Card 2 · LEA");

    await userEvent.click(tile);

    expect(useAppStore.getState().selectedCardId).toBe("c2");
    // Opening a card is the modal's job and the view stays where it is.
    expect(useAppStore.getState().activeView).toBe(useAppStore.getInitialState().activeView);
  });

  // Hidden, not removed: the caption keeps its line so switching names does not move the art.
  it("hides the names without taking their line away", () => {
    qc.setQueryData(recentCardsKey(RECENT_CARDS_READ), [card(1)]);
    draw({ config: { names: false } });
    const caption = within(screen.getByRole("list")).getByText("Card 1");
    expect(caption).toHaveStyle({ visibility: "hidden" });
  });

  it("sizes every tile from the body's height at five by seven", () => {
    qc.setQueryData(recentCardsKey(RECENT_CARDS_READ), [card(1)]);
    draw();
    const height = artHeight(fitFor(4, 2), false);
    const item = screen.getByRole("listitem");
    expect(item).toHaveStyle({ width: `${Math.round((height * 5) / 7)}px` });
  });

  // A catalogue preview opens nothing and scrolls nothing.
  it("draws a still as pictures rather than presses, clipped rather than scrolling", () => {
    qc.setQueryData(recentCardsKey(RECENT_CARDS_READ), [card(1), card(2)]);
    draw({ still: true });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Recently viewed cards" });
    expect(list.classList.contains("overflow-hidden")).toBe(true);
    expect(list.classList.contains("overflow-x-auto")).toBe(false);
  });
});
