import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipContext, type TooltipApi } from "@/components/tooltip/useTooltip";
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

/**
 * The same entry filed in a **deck's group** — the folder the app owns on a deck's behalf since
 * schema v25, and the first of the two places the quantity may not be stepped.
 *
 * A different card and a different count from {@link ROW} on purpose: the fence has to be visible
 * discriminating between two rows of one list, and two rows sharing a name would collide in every
 * `getByRole` name query on the page.
 */
const DECK_FOLDER_ID = 7;
const IN_A_DECK: CollectionRow = {
  ...ROW,
  id: 43,
  cardId: "c2",
  name: "Counterspell",
  folderId: DECK_FOLDER_ID,
  folderName: "Meren, the Slavemaster",
  quantity: 3,
};

/**
 * The page's own sentence for a deck's group, written out here rather than imported from the
 * component — the table's contract is that it prints *whatever the caller returned*, so a test
 * that read back the string the implementation prints would only prove one variable reached
 * itself. Its grammar is `PickCopies`' `blockedReason`: where you are, then what to do instead.
 */
const IN_A_DECK_REASON = `In ${IN_A_DECK.folderName}. Cut the card from the deck to change how many you hold.`;

/** Blocked exactly where the page blocks — a copy filed in a deck's group, and nowhere else. */
const blockDeckGroup = (row: CollectionRow) =>
  row.folderId === DECK_FOLDER_ID ? IN_A_DECK_REASON : null;

function renderTable(
  rows: CollectionRow[],
  handlers: {
    onSetQuantity?: () => void;
    onRemove?: () => void;
    quantityBlocked?: (row: CollectionRow) => string | null;
    /** Mounted only where a test is about the hover panel; everything else takes the no-op API. */
    tooltip?: TooltipApi;
  } = {},
) {
  const table = (
    <CollectionTable
      rows={rows}
      total={rows.length}
      listKey="test"
      sort={[]}
      onSort={vi.fn()}
      onNeedNextPage={vi.fn()}
      onSetQuantity={handlers.onSetQuantity ?? vi.fn()}
      onRemove={handlers.onRemove ?? vi.fn()}
      quantityBlocked={handlers.quantityBlocked}
      marketplace={MARKETPLACES.tcgplayer}
    />
  );
  return render(
    handlers.tooltip ? (
      <TooltipContext.Provider value={handlers.tooltip}>{table}</TooltipContext.Provider>
    ) : (
      table
    ),
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
   * **The quantity control belongs to a normal folder and to nothing else** (issue #284). A row
   * filed in a deck's group is what the deck physically holds, so a stepper there would change the
   * deck without `deck_cards` being touched — and `collection::set_quantity` has no folder fence
   * of its own to catch it afterwards, which makes this the guard rather than a second opinion.
   *
   * Asserted as *no control at all* rather than as a greyed one, because those are different
   * claims: a `disabled` stepper is still a `spinbutton` in the accessibility tree and would pass
   * a "the stepper is gone" test written any other way.
   */
  it("draws a blocked row's copies as plain text instead of a stepper", () => {
    renderTable([IN_A_DECK], { quantityBlocked: blockDeckGroup });

    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Increase/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Decrease/ })).not.toBeInTheDocument();
    // The count is still on the row: the reader is being told what they hold, not that the
    // number has become unavailable.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  /**
   * **The reason reaches a screen reader as text**, which is the `Finish · condition` cell's route
   * rather than the Value header's: that header can put its sentence in the *column's* name
   * because it is true of every row, and this one is about one row. The tooltip cannot carry it
   * alone — `aria-describedby` is wired only while the panel is open, and the panel opens on a
   * pointer or on the anchor taking focus, which a `<span>` in a row whose tab stop is the row
   * never does.
   */
  it("puts a blocked row's reason in the accessibility tree beside the number", () => {
    renderTable([IN_A_DECK], { quantityBlocked: blockDeckGroup });

    const reason = screen.getByText(IN_A_DECK_REASON);
    expect(reason).toHaveClass("sr-only");
  });

  /**
   * The same sentence for the pointer, through `useTooltip()`'s spread — never a `title`, which
   * `src/CLAUDE.md` forbids outright and which no test in this file would otherwise notice.
   *
   * `describes: false` is asserted with it for the `<abbr>` cell's reason one column over: the
   * `sr-only` twin already puts the sentence in the accessibility tree, so a panel that also wired
   * `aria-describedby` would have it announced twice.
   */
  it("binds a blocked row's reason to the number as a tooltip, not a title", () => {
    const tooltip: TooltipApi = { enter: vi.fn(), focus: vi.fn(), leave: vi.fn() };
    renderTable([IN_A_DECK], { quantityBlocked: blockDeckGroup, tooltip });

    const number = screen.getByText("3");
    expect(number).not.toHaveAttribute("title");

    fireEvent.pointerEnter(number);
    expect(tooltip.enter).toHaveBeenCalledWith(
      number,
      IN_A_DECK_REASON,
      expect.objectContaining({ describes: false }),
    );
  });

  /**
   * **A fence between two rows of one list, not a table drawn one way throughout.** Both rows are
   * on screen for this: the predicate is asked per row, and a mount that blocked the whole column
   * the moment one row was blocked would pass any test that rendered the blocked row alone.
   */
  it("leaves a row the predicate clears alone", async () => {
    const onSetQuantity = vi.fn();
    const user = userEvent.setup();
    renderTable([ROW, IN_A_DECK], { onSetQuantity, quantityBlocked: blockDeckGroup });

    expect(screen.getByText(IN_A_DECK_REASON)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Increase Quantity of Lightning Bolt (Nonfoil, NM)" }),
    );
    expect(onSetQuantity).toHaveBeenCalledWith(ROW, 6);
    expect(onSetQuantity).toHaveBeenCalledTimes(1);
  });

  /**
   * **The opt-in guarantee.** No predicate is every story, every read-only mount and every
   * consumer of this table before the folders existed — so the table invents no fence of its own,
   * not even for the row that is sitting in a deck's group and would be blocked the moment a
   * caller asked.
   */
  it("steps every row when no predicate is passed", () => {
    renderTable([ROW, IN_A_DECK]);

    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(
      screen.getByRole("spinbutton", { name: "Quantity of Counterspell (Nonfoil, NM)" }),
    ).toBeInTheDocument();
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

  /**
   * **Issue #353.** The mark used to be gated on the copy having a *treatment* name, which was
   * right only while a treatment had a glyph of its own. Now that the glyph is the finish, that
   * gate would have drawn the foil icon on the Surge Foil row and nothing on the plain foil row
   * above it — one fact, two pictures, inside one table.
   *
   * The plain copy is still unmarked, which is the rule every surface in the app keeps: nonfoil
   * is the finish a card is assumed to be.
   */
  it("marks a foil row whether or not the copy has a name of its own", () => {
    renderTable([
      { ...ROW, finish: "foil" },
      { ...ROW, id: 44, cardId: "c3", name: "Counterspell", finish: "foil", promoTypes: '["halofoil"]' },
      { ...ROW, id: 45, cardId: "c4", name: "Giant Growth" },
    ]);

    expect(screen.getByLabelText("Foil")).toBeInTheDocument();
    expect(screen.getByLabelText("Halo Foil")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nonfoil")).toBeNull();
  });
});
