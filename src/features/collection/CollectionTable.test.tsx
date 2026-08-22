import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DECK_DRIVEN_REASON } from "@/lib/useDeckDrivenCollection";
import type { CollectionRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { CollectionTable } from "./CollectionTable";

/**
 * jsdom lays nothing out: `@tanstack/react-virtual` sizes its scroll container with
 * `offsetHeight` and scrolls through `Element.scrollTo`, neither of which jsdom implements.
 * The same stub `VirtualTable.test.tsx` and every table story use.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

/**
 * A row `useCollection` can actually hand this table in the one window M1 is about: the mode
 * flag has already flipped to hand-kept, but `keepPreviousData` is still showing the previous
 * mode's derived row — a `deck_cards.id`, no condition, and a `deckCount` the flag disagrees
 * with. `deckDriven` is passed `false` below to reproduce exactly that disagreement.
 */
const DERIVED_ROW: CollectionRow = {
  id: 42,
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
  // A derived row states no grade — this is the fact the finish cell already keys off, and
  // the one the stepper and the actions cell must now key off too.
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

function renderTable(rows: CollectionRow[], deckDriven: boolean) {
  return render(
    <CollectionTable
      rows={rows}
      total={rows.length}
      listKey="test"
      sort={[]}
      onSort={vi.fn()}
      onNeedNextPage={vi.fn()}
      onSetQuantity={vi.fn()}
      onRemove={vi.fn()}
      marketplace={MARKETPLACES.tcgplayer}
      deckDriven={deckDriven}
    />,
  );
}

describe("CollectionTable — the mid-flip window (M1)", () => {
  /**
   * `filterKey` folds the mode into the list query's key and that query uses
   * `keepPreviousData`, so the render right after a flip to **off** can be handed the previous
   * mode's rows — `deck_cards` ids — while `deckDriven` already reads `false`. Before the fix,
   * the stepper and the actions cell both branched on that stale flag: the stepper would be
   * enabled and a press would send `collection_set_quantity(<deck_cards.id>, n)` — a write to
   * an unrelated hidden hand-kept row.
   */
  it("keeps the stepper out of reach on a derived row even while the flag reads hand-kept", () => {
    renderTable([DERIVED_ROW], false);

    const stepper = screen.getByRole("spinbutton", {
      name: `Quantity of Lightning Bolt (Nonfoil) — ${DECK_DRIVEN_REASON}`,
    });
    expect(stepper).toHaveAttribute("aria-disabled", "true");
    expect(stepper).toHaveAttribute("readonly");
  });

  it("does not let a press on the greyed stepper reach onSetQuantity in that window", async () => {
    const onSetQuantity = vi.fn();
    const user = userEvent.setup();
    render(
      <CollectionTable
        rows={[DERIVED_ROW]}
        total={1}
        listKey="test"
        sort={[]}
        onSort={vi.fn()}
        onNeedNextPage={vi.fn()}
        onSetQuantity={onSetQuantity}
        onRemove={vi.fn()}
        marketplace={MARKETPLACES.tcgplayer}
        deckDriven={false}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: `Increase Quantity of Lightning Bolt (Nonfoil) — ${DECK_DRIVEN_REASON}`,
      }),
    );

    expect(onSetQuantity).not.toHaveBeenCalled();
  });

  /**
   * The other control the same window puts a wrong write behind: with the flag read instead of
   * the row, the actions cell would draw the Remove button — for a row at zero copies — over a
   * `deck_cards.id` the collection has no business deleting. `row.deckCount !== null` keeps the
   * deck-count cell in place instead, exactly as it would while the mode was still on.
   */
  it("still shows the deck count in Actions, and offers no removal, in that window", () => {
    renderTable([{ ...DERIVED_ROW, quantity: 0 }], false);

    expect(screen.getByText("3 decks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  /**
   * The other side of the same rule, so it is the row and not a fixed reading of `deckDriven`
   * that is doing the work: an ordinary hand-kept row (`deckCount: null`) behaves exactly as it
   * always has even while the flag reads derived — the mirror-image mid-flip window, going on.
   */
  it("leaves an ordinary hand-kept row editable even while the flag reads derived", () => {
    renderTable([{ ...DERIVED_ROW, deckCount: null, condition: "NM", quantity: 0 }], true);

    const stepper = screen.getByRole("spinbutton", {
      name: "Quantity of Lightning Bolt (Nonfoil, NM)",
    });
    expect(stepper).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /^Remove/ })).toBeInTheDocument();
    expect(screen.queryByText(/\d+ decks?/)).not.toBeInTheDocument();
  });
});
