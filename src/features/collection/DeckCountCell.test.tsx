import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import type { CollectionRow } from "@/lib/ipc";

const collectionRowDecks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionRowDecks },
}));

import { DeckCountCell } from "./DeckCountCell";

/** A derived row: no condition, a deck count, and a quantity that is the decks' sum. */
const ROW: CollectionRow = {
  id: 7,
  cardId: "c1",
  name: "Lightning Bolt",
  oracleId: "o1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  layout: "normal",
  finish: "nonfoil",
  condition: null,
  quantity: 5,
  tradelistQuantity: 0,
  unitPrice: null,
  purchasePrice: null,
  purchaseCurrency: null,
  acquiredAt: null,
  acquisitionSource: null,
  serialNumber: null,
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  tags: "[]",
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
  promoTypes: null,
  legalities: null,
  deckCount: 3,
};

/**
 * The two providers this cell needs, and neither is scenery.
 *
 * `useTooltip` answers a **no-op** where no `TooltipProvider` is above it, so a cell rendered
 * bare would bind nothing and pass every hover assertion below by never being asked. And the
 * panel's contents are a component that reads the cache — `TooltipProvider` renders `content`
 * inside itself, which is exactly why it is mounted under `QueryClientProvider` in `App`.
 */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Hover, and wait for the panel the provider draws at the app root. */
async function hover(anchor: HTMLElement): Promise<HTMLElement> {
  fireEvent.pointerEnter(anchor);
  await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
    timeout: TOOLTIP_OPEN_MS + 1000,
  });
  return document.getElementById(TOOLTIP_PANEL_ID) as HTMLElement;
}

beforeAll(() => {
  // `TooltipPanel` measures itself as it mounts, and jsdom lays nothing out.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 24 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 120 });
});

beforeEach(() => {
  collectionRowDecks.mockReset().mockResolvedValue([
    { deckId: 1, deckName: "Burn", quantity: 3 },
    { deckId: 2, deckName: "Boros Aggro", quantity: 2 },
  ]);
});

describe("DeckCountCell", () => {
  /** Plural by default, and the count comes from the row rather than from any query. */
  it("says how many decks the copies are spread across", () => {
    wrap(<DeckCountCell row={ROW} />);

    expect(screen.getByText("3 decks")).toBeInTheDocument();
  });

  /** A reader with one deck must not be told "1 decks". */
  it("says one deck in the singular", () => {
    wrap(<DeckCountCell row={{ ...ROW, deckCount: 1 }} />);

    expect(screen.getByText("1 deck")).toBeInTheDocument();
    expect(screen.queryByText("1 decks")).not.toBeInTheDocument();
  });

  /**
   * `null` is a **hand-kept** row, where this cell is not drawn at all — the collection has no
   * such fact to report. Nothing rather than a "0 decks" that would be a claim about a row
   * nobody asked this question of.
   */
  it("draws nothing on a row with no deck count", () => {
    const { container } = wrap(<DeckCountCell row={{ ...ROW, deckCount: null }} />);

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * **The names are fetched on hover, never with the page**, and this is the half of that which
   * can regress silently: the count is free in the row, the names are a query each, and a
   * 100-row page would otherwise carry several hundred deck names nobody looks at. A cell that
   * called `useQuery` unconditionally would draw identically and pass every other case here.
   */
  it("does not ask which decks until the pointer rests on the count", async () => {
    wrap(<DeckCountCell row={ROW} />);
    // Well past the open delay, so this is "it never asked" rather than "it has not asked yet".
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 150));

    expect(collectionRowDecks).not.toHaveBeenCalled();
  });

  /**
   * And on hover it asks, with the row's own three keys.
   *
   * `finish` goes through verbatim: `"nonfoil"` is the *collection's* spelling and the deck
   * table's `NULL` is coalesced at the backend's end, so a translation here would be a second
   * place for that mapping to live and to drift.
   */
  it("lists the decks and their copies once the panel is open", async () => {
    wrap(<DeckCountCell row={ROW} />);

    const panel = await hover(screen.getByText("3 decks"));

    await waitFor(() => expect(panel).toHaveTextContent("3 × Burn"));
    expect(panel).toHaveTextContent("2 × Boros Aggro");
    expect(collectionRowDecks).toHaveBeenCalledWith("c1", "nonfoil", "en");
  });

  /**
   * A panel that is already open and empty reads as a bug in the hover, so the refusal is said
   * rather than swallowed. Not an alert and not coloured: nothing is broken about the row, and
   * the count that opened the panel is still true.
   */
  it("says so when the decks cannot be read", async () => {
    collectionRowDecks.mockRejectedValue(new Error("nope"));
    wrap(<DeckCountCell row={ROW} />);

    const panel = await hover(screen.getByText("3 decks"));

    await waitFor(() => expect(panel).toHaveTextContent(/could not read which decks/i));
  });

  /**
   * `describes: false`, so the panel carries no `role="tooltip"` and no `aria-describedby`.
   *
   * Its text is asynchronous — pointing a description at a panel reading "Loading…" is worse
   * than pointing at nothing — and the count itself, the fact this cell exists for, is plain
   * text in the accessibility tree either way. Probed by the one stable id the provider ever
   * draws, because a `describes: false` panel has no role to query by.
   */
  it("binds the panel as a hint rather than as a description", async () => {
    wrap(<DeckCountCell row={ROW} />);
    const anchor = screen.getByText("3 decks");

    await hover(anchor);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(anchor).not.toHaveAttribute("aria-describedby");
  });
});
