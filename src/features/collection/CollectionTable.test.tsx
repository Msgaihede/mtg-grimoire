import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

/** An ordinary hand-kept entry — one printing, one finish, one grade the reader stated. */
const ROW: CollectionRow = {
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
  condition: "NM",
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
};

function renderTable(
  rows: CollectionRow[],
  handlers: { onSetQuantity?: () => void; onRemove?: () => void } = {},
) {
  return render(
    <CollectionTable
      rows={rows}
      total={rows.length}
      listKey="test"
      sort={[]}
      onSort={vi.fn()}
      onNeedNextPage={vi.fn()}
      onSetQuantity={handlers.onSetQuantity ?? vi.fn()}
      onRemove={handlers.onRemove ?? vi.fn()}
      marketplace={MARKETPLACES.tcgplayer}
    />,
  );
}

describe("CollectionTable", () => {
  /**
   * The stepper writes straight through — a collection table is where quantities are
   * *maintained*, and nothing on this table takes that away from a row.
   */
  it("hands a stepper press to onSetQuantity", async () => {
    const onSetQuantity = vi.fn();
    const user = userEvent.setup();
    renderTable([ROW], { onSetQuantity });

    const stepper = screen.getByRole("spinbutton", {
      name: "Quantity of Lightning Bolt (Nonfoil, NM)",
    });
    expect(stepper).not.toHaveAttribute("aria-disabled");

    await user.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Nonfoil, NM)" }),
    );
    expect(onSetQuantity).toHaveBeenCalledWith(ROW, 6);
  });

  /**
   * Removal is offered on an emptied row and nowhere else. Zero copies is a state the stepper
   * can reach and nothing else can leave: the backend keeps the row until something says
   * delete, and this button is the only thing in the app that does.
   */
  it("offers the removal on a row at zero copies", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const empty = { ...ROW, quantity: 0 };
    renderTable([empty], { onRemove });

    await user.click(
      screen.getByRole("button", {
        name: "Remove Lightning Bolt (Nonfoil, NM) from your collection",
      }),
    );
    expect(onRemove).toHaveBeenCalledWith(empty);
  });

  it("offers no removal on a row that still holds copies", () => {
    renderTable([ROW]);
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
  });

  /**
   * A row whose grade was never stated draws the finish alone: the separator goes with the
   * missing half, because a dangling middle dot before nothing reads as a rendering fault.
   * The test is the DTO's own `null`, which is the fact about *this row*.
   */
  it("drops the separator on a row with no condition", () => {
    renderTable([{ ...ROW, condition: null }]);

    expect(screen.getByText("Nonfoil")).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt (Nonfoil)" }),
    ).toBeInTheDocument();
  });
});
