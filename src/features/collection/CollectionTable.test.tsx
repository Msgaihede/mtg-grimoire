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
  // Filed nowhere — the Folder column's em dash, and the state most of a collection is in.
  folderId: null,
  folderName: null,
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
   * Removal is offered on an emptied row and nowhere else. Since schema v24 the stepper does not
   * produce one — `collectionSetQuantity(id, 0)` deletes — so a row at zero comes from the entry
   * editor, the one write that still keeps the row it is editing, and this button is the only
   * thing in the app that clears it.
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
   * **The column `DeckCountCell` vacated says where the copy is filed** — one value already on the
   * row rather than a lazy per-row ipc call, which is the net deletion spec §7.1 asked for.
   *
   * `folderName` is the backend's own join, so the cell draws what the last read said the drawer
   * was called and never has to hold the folder list to find out.
   */
  it("names the folder a copy is filed in", () => {
    renderTable([{ ...ROW, folderId: 4, folderName: "Trade binder" }]);
    expect(screen.getByText("Trade binder")).toBeInTheDocument();
  });

  /**
   * A copy at the root reads an em dash and never the word "Collection": the breadcrumb says that
   * about the *level*, and repeating it down a column of four hundred rows would be a name for the
   * absence of filing rather than a folder.
   */
  it("draws an em dash for a copy at the root", () => {
    // Priced, so the Value cell is not drawing an em dash of its own: `ROW` has no `unitPrice`,
    // and two dashes would make `getByText` ambiguous — which reads as a missing dash rather than
    // as a second one.
    renderTable([{ ...ROW, unitPrice: 1.5 }]);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Collection")).not.toBeInTheDocument();
  });

  /**
   * **Both halves and the separator, always.** `collection_entries.condition` is
   * `TEXT NOT NULL DEFAULT 'NM'` and {@link CollectionRow.condition} is non-nullable to match, so
   * the "grade never stated" arm this cell and `copyLabel` used to carry could not be reached —
   * a row with no grade is not a state the backend can build. The test that pinned that arm
   * asserted a `condition: null` the DTO no longer admits.
   *
   * The grade is abbreviated in the cell and expanded in `sr-only` text beside it, so the two
   * spellings are both asserted here: `NM` is what a reader sees and `Near mint` is what is
   * announced.
   */
  it("draws the finish, the separator and the grade", () => {
    renderTable([ROW]);

    expect(screen.getByText("Nonfoil ·")).toBeInTheDocument();
    expect(screen.getByText("NM")).toBeInTheDocument();
    expect(screen.getByText("(Near mint)")).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt (Nonfoil, NM)" }),
    ).toBeInTheDocument();
  });
});
