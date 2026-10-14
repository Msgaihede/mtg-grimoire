import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  TooltipProvider,
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
} from "@/components/tooltip/TooltipProvider";
import type { DeckCard, DeckElsewherePlace } from "@/lib/ipc";
import {
  elsewhereFor,
  OwnedElsewhereContext,
  ownedElsewhereMap,
  placeLabel,
  ShortfallFigure,
  type OwnedElsewhereMap,
} from "./ShortfallFigure";

/**
 * Issue #986: the missing figure in a deck card's chin is red when the reader owns the card
 * nowhere else, gold when copies sit elsewhere in the collection, and its tooltip names where.
 */

/** The panel, by id: the figure's tooltip is `describes: false`, so it carries no `tooltip` role —
 *  the card's own button already says the shortage in words. */
function panel(): HTMLElement {
  const node = document.getElementById(TOOLTIP_PANEL_ID);
  if (node === null) throw new Error("No tooltip is open");
  return node;
}

/** Only the three fields the figure reads; the rest of a row is nothing it looks at. */
const bolt = { oracleId: "o-bolt", ownedQuantity: 1, quantity: 4 } as DeckCard;

const root: DeckElsewherePlace = { folderId: null, name: null, kind: null, quantity: 1 };
const binder: DeckElsewherePlace = { folderId: 7, name: "Binder", kind: "user", quantity: 3 };
const burn: DeckElsewherePlace = { folderId: 9, name: "Burn", kind: "deck", quantity: 2 };

function mount(map: OwnedElsewhereMap | null, provided = true) {
  const figure = <ShortfallFigure card={bolt} />;
  const ui: ReactNode = provided ? (
    <OwnedElsewhereContext.Provider value={map}>{figure}</OwnedElsewhereContext.Provider>
  ) : (
    figure
  );
  render(<TooltipProvider>{ui}</TooltipProvider>);
  return screen.getByText("1/4");
}

describe("placeLabel", () => {
  it("calls the root the Collection, a deck's group by its deck, and a binder by its name", () => {
    expect(placeLabel(root)).toBe("Collection");
    expect(placeLabel(burn)).toBe("Burn (deck)");
    expect(placeLabel(binder)).toBe("Binder");
  });
});

describe("elsewhereFor", () => {
  it("knows nothing until there is an answer, and a missing key is owned nowhere", () => {
    expect(elsewhereFor(bolt, null)).toBeNull();
    expect(elsewhereFor(bolt, ownedElsewhereMap([]))).toEqual([]);
    expect(elsewhereFor({ oracleId: null }, ownedElsewhereMap([]))).toEqual([]);
    expect(
      elsewhereFor(bolt, ownedElsewhereMap([{ oracleId: "o-bolt", places: [binder] }])),
    ).toEqual([binder]);
  });
});

describe("ShortfallFigure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is red, as it always was, with no provider or no answer yet", () => {
    expect(mount(null, false)).toHaveClass("text-destructive");
    cleanup();
    expect(mount(null)).not.toHaveAttribute("data-elsewhere");
  });

  it("is red when the reader owns the card nowhere else", () => {
    const figure = mount(ownedElsewhereMap([]));
    expect(figure).toHaveClass("text-destructive");
    expect(figure).toHaveAttribute("data-elsewhere", "none");

    fireEvent.pointerEnter(figure);
    act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));
    expect(panel()).toHaveTextContent("No other copies anywhere in your collection");
  });

  it("is gold when copies sit elsewhere, and the tooltip names every place", () => {
    const figure = mount(ownedElsewhereMap([{ oracleId: "o-bolt", places: [root, binder, burn] }]));
    expect(figure).toHaveClass("text-accent");
    expect(figure).not.toHaveClass("text-destructive");
    expect(figure).toHaveAttribute("data-elsewhere", "owned");

    fireEvent.pointerEnter(figure);
    act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));
    const open = panel();
    expect(open).toHaveTextContent("You own 1 of the 4 this deck wants");
    expect(open).toHaveTextContent("1 in Collection");
    expect(open).toHaveTextContent("3 in Binder");
    expect(open).toHaveTextContent("2 in Burn (deck)");
  });
});
