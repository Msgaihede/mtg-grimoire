import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipContext, type TooltipApi } from "@/components/tooltip/useTooltip";
import { CONDITION_LABEL, CONDITION_NOT_SET } from "@/lib/conditions";
import type { CollectionRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { SHELF_INDENT_PX, SHELF_RAIL_OFFSET_PX, layoutShelves } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { CollectionTable, type CollectionTableShelves } from "./CollectionTable";

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
  // Filed nowhere — Not sorted's shelf, when the table is shelved.
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
const IN_A_DECK_REASON = `In ${IN_A_DECK.folderName}. Remove it from the deck to change the quantity.`;

/** Blocked exactly where the page blocks — a copy filed in a deck's group, and nowhere else. */
const blockDeckGroup = (row: CollectionRow) =>
  row.folderId === DECK_FOLDER_ID ? IN_A_DECK_REASON : null;

function renderTable(
  rows: CollectionRow[],
  handlers: {
    onSetQuantity?: () => void;
    onRemove?: () => void;
    quantityBlocked?: (row: CollectionRow) => string | null;
    /** The shelves (spec §3.10) — absent is the flat table every other case draws. */
    shelves?: CollectionTableShelves;
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
      shelves={handlers.shelves}
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
   * **Both halves and the separator, for a row whose grade the reader stated.**
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
   * **The other arm, which is new rather than newly tested.** Both halves used to be
   * unconditional and the comment above them said why: `collection_entries.condition` is
   * `TEXT NOT NULL` and {@link CollectionRow.condition} is non-nullable to match, so a row
   * carrying no grade was not a state the backend could build. Schema v35 moved the column's
   * *default* onto the `NONE` sentinel, and an add that states no grade — the popup opened and
   * left alone, either menu's one press, an import line whose file is silent — lands on it. It is
   * the commonest row in a collection nobody has graded by hand.
   *
   * Three absences and one presence, because each of the three is a different way of drawing the
   * sentinel by accident: the storage token itself, the separator with nothing after it, and the
   * `<abbr>`/`sr-only` pair expanding a grade to a word the reader never chose. What is left is
   * the finish, on its own.
   */
  it("prints the finish alone for a copy whose grade was never stated", () => {
    renderTable([{ ...ROW, condition: CONDITION_NOT_SET }]);

    expect(screen.getByText("Nonfoil")).toBeInTheDocument();
    expect(screen.queryByText("Nonfoil ·")).not.toBeInTheDocument();
    expect(screen.queryByText(CONDITION_NOT_SET)).not.toBeInTheDocument();
    expect(screen.queryByText(`(${CONDITION_LABEL.NONE})`)).not.toBeInTheDocument();
    expect(document.querySelector("abbr")).toBeNull();
  });

  /**
   * `copyLabel`'s half of the same rule, and the half a screen reader hears.
   *
   * Every control on this row is named for the copy it acts on, so the sentinel reaches two
   * accessible names rather than one cell. `Lightning Bolt (Nonfoil, NONE)` would say a storage
   * token out loud and `Lightning Bolt (Nonfoil, )` would trail a comma into nothing — the
   * parenthesis carries the finish and stops.
   *
   * At **zero copies**, because that is the only row that draws both controls at once: removal is
   * offered on an emptied row and nowhere else (see the case above), and one row is what keeps the
   * two names unambiguous — two rows of one card would collide in every `getByRole` name query.
   */
  it("names a control on an ungraded row by its finish alone", () => {
    renderTable([{ ...ROW, condition: CONDITION_NOT_SET, quantity: 0 }]);

    expect(
      screen.getByRole("spinbutton", { name: "Quantity of Lightning Bolt (Nonfoil)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Remove Lightning Bolt (Nonfoil) from your collection",
      }),
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

  /**
   * **The Folder column is gone, and the removal went back to a narrow strip of its own** (spec
   * §3.10). On a shelved table every row sits under the band of the shelf it is filed in, and that
   * band names the drawer and wears its lock — so a column repeating the band's word on every row
   * under it would be the same fact forty times. Six columns still: the sixth is the removal's
   * `srOnlyHeader` strip, which is what `DeckCountCell` left before folders.
   */
  it("draws no Folder column, and keeps the removal in a strip of its own", () => {
    renderTable([{ ...ROW, folderId: 4, folderName: "Trade binder" }]);

    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    expect(screen.queryByRole("columnheader", { name: "Folder" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByText("Trade binder")).toBeNull();
  });

  /**
   * **The shelves as bands**: a label, each heading, an empty folder's box, and each shelf's rows
   * under its own heading — the same layout table the wall is drawn from (`layoutShelves`, one
   * column), so the two drawings of one list cannot disagree about what is where.
   */
  it("draws a band per label, heading and empty shelf, and each shelf's rows under its heading", () => {
    const shelf = (over: Partial<Shelf> & Pick<Shelf, "id" | "name">): Shelf => ({
      kind: "folder",
      group: "own",
      pathIds: [over.id],
      path: [over.name],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
      ...over,
    });
    const unfiled = shelf({ id: 0, name: "Not sorted", kind: "unfiled" });
    const binder = shelf({ id: 4, name: "Trade binder" });
    const empty = shelf({ id: 5, name: "Sealed" });
    const deck = shelf({ id: 20, name: "Burn", kind: "deck", group: "decks", collapsed: true });
    const inBinder = { ...ROW, id: 51, folderId: 4, folderName: "Trade binder", name: "Counterspell" };
    renderTable([], {
      shelves: {
        layout: layoutShelves(
          [
            { shelf: unfiled, tileCount: 1 },
            { shelf: binder, tileCount: 1 },
            { shelf: empty, tileCount: 0 },
            { shelf: deck, tileCount: 0 },
          ],
          1,
        ).rows,
        rowsOf: (id) => (id === 0 ? [ROW] : id === 4 ? [inBinder] : []),
        complete: true,
        renderHeading: (s) => <span>{`${s.name} heading`}</span>,
        renderLabel: (group) => <span>{`${group} label`}</span>,
        renderEmpty: (s) => <span>{`${s.name} is empty`}</span>,
        renderSticky: () => null,
      },
    });

    const drawn = screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-rowindex") !== "1")
      .map((row) =>
        row.hasAttribute("data-band")
          ? row.textContent
          : row.textContent?.includes("Counterspell")
            ? "row:Counterspell"
            : "row:Lightning Bolt",
      );
    expect(drawn).toEqual([
      "Not sorted heading",
      "row:Lightning Bolt",
      "Trade binder heading",
      "row:Counterspell",
      "Sealed heading",
      "Sealed is empty",
      "decks label",
      "Burn heading",
    ]);
  });

  /**
   * **While pages remain, the table stops after the shelf holding the last loaded row.** The list
   * is paged in shelf order, so every later shelf's band would stand over rows that have not
   * arrived — and `VirtualTable` counts bands as rows when it decides to ask for the next page, so
   * two dozen empty headings after page one kept it from asking until the reader had scrolled deep
   * into them. The wishlist's `shelfTable` rule; with nothing loaded, the edge is the first shelf
   * the first page is filling. Once the list is complete, every shelf is drawn again.
   */
  it("draws no band past the last loaded row's shelf while a next page remains", () => {
    const shelf = (over: Partial<Shelf> & Pick<Shelf, "id" | "name">): Shelf => ({
      kind: "folder",
      group: "own",
      pathIds: [over.id],
      path: [over.name],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
      ...over,
    });
    const layout = layoutShelves(
      [
        { shelf: shelf({ id: 0, name: "Not sorted", kind: "unfiled" }), tileCount: 2 },
        { shelf: shelf({ id: 4, name: "Trade binder" }), tileCount: 3 },
        { shelf: shelf({ id: 5, name: "Sealed" }), tileCount: 0 },
        {
          shelf: shelf({ id: 20, name: "Burn", kind: "deck", group: "decks", collapsed: true }),
          tileCount: 0,
        },
      ],
      1,
    ).rows;
    const drawnWith = (loaded: CollectionRow[], complete: boolean) => {
      const { unmount } = renderTable([], {
        shelves: {
          layout,
          rowsOf: (id) => (id === 0 ? loaded : []),
          complete,
          renderHeading: (s) => <span>{`${s.name} heading`}</span>,
          renderLabel: (group) => <span>{`${group} label`}</span>,
          renderEmpty: (s) => <span>{`${s.name} is empty`}</span>,
          renderSticky: () => null,
        },
      });
      const drawn = screen
        .getAllByRole("row")
        .filter((row) => row.getAttribute("aria-rowindex") !== "1")
        .map((row) => (row.hasAttribute("data-band") ? row.textContent : "row"));
      unmount();
      return drawn;
    };

    // Page one holds Not sorted's first row; Trade binder's three have not arrived.
    expect(drawnWith([ROW], false)).toEqual(["Not sorted heading", "row"]);
    // Nothing loaded yet: the first shelf expecting rows is the one being filled.
    expect(drawnWith([], false)).toEqual(["Not sorted heading"]);
    // Every page in: the whole cabinet again, the empty box and the shut deck group included.
    expect(drawnWith([ROW], true)).toEqual([
      "Not sorted heading",
      "row",
      "Trade binder heading",
      "Sealed heading",
      "Sealed is empty",
      "decks label",
      "Burn heading",
    ]);
  });

  /**
   * **The rows are keyed on the layout, the lookup and the paging flag — not on the object that
   * carries them.** The page builds that object around drawings that close over its mutations, and
   * a `useMutation` result is new every render, so the object is new on every keystroke. A render
   * that hands the same three inputs with new drawings must not rebuild the row list (asked here
   * of `rowsOf`, which only the rebuild calls) — and must still draw the new drawings, which are
   * read at draw time.
   */
  it("rebuilds no rows when only the drawings change, and draws the new drawings", () => {
    const only: Shelf = {
      id: 0,
      kind: "unfiled",
      group: "own",
      name: "Not sorted",
      pathIds: [0],
      path: ["Not sorted"],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
    };
    const rowsOf = vi.fn(() => [ROW]);
    const first: CollectionTableShelves = {
      layout: layoutShelves([{ shelf: only, tileCount: 1 }], 1).rows,
      rowsOf,
      complete: true,
      renderHeading: (s) => <span>{`${s.name} heading`}</span>,
      renderLabel: () => null,
      renderEmpty: () => null,
      renderSticky: () => null,
    };
    const table = (shelves: CollectionTableShelves) => (
      <CollectionTable
        rows={[]}
        total={1}
        listKey="test"
        sort={[]}
        onSort={vi.fn()}
        onNeedNextPage={vi.fn()}
        onSetQuantity={vi.fn()}
        onRemove={vi.fn()}
        marketplace={MARKETPLACES.tcgplayer}
        shelves={shelves}
      />
    );
    const { rerender } = render(table(first));
    expect(screen.getByText("Not sorted heading")).toBeInTheDocument();
    const built = rowsOf.mock.calls.length;

    // What a keystroke hands down: the same layout, lookup and flag in a new object, with new
    // drawings because the page's callbacks were rebuilt around new mutation objects.
    rerender(table({ ...first, renderHeading: (s) => <span>{`${s.name} redrawn`}</span> }));

    expect(rowsOf.mock.calls.length).toBe(built);
    expect(screen.getByText("Not sorted redrawn")).toBeInTheDocument();
  });

  /** Nothing over a heading that is its own bar — `stickyBand`'s caller rule (Task 5). At rest the
   *  first row under the column header is the first heading, so the anchor holds nothing. */
  it("draws no sticky bar while a heading is the row under the column header", () => {
    const renderSticky = vi.fn(() => <span>sticky</span>);
    const only: Shelf = {
      id: 0,
      kind: "unfiled",
      group: "own",
      name: "Not sorted",
      pathIds: [0],
      path: ["Not sorted"],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
    };
    renderTable([], {
      shelves: {
        layout: layoutShelves([{ shelf: only, tileCount: 1 }], 1).rows,
        rowsOf: () => [ROW],
        complete: true,
        renderHeading: () => <span>heading</span>,
        renderLabel: () => null,
        renderEmpty: () => null,
        renderSticky,
      },
    });
    expect(screen.queryByText("sticky")).toBeNull();
  });

  /**
   * **The sticky bar's Top scrolls the table's scroller, which is not the table while the bar is
   * live** — `VirtualTable` moves the scroll container onto a plain `div` around the
   * `role="table"` element, so a Top aimed at the table itself would scroll nothing at all.
   *
   * Asserted on the scroller's `scrollTop` after the press, never on a `scrollTo` spy: this file
   * stubs `scrollTo` on every element, so a spy would pass over a handler that scrolled the wrong
   * box. jsdom keeps no scroll position of its own, so the scroller is given one to hold.
   */
  it("scrolls the table's own scroller back to the top from the sticky bar", async () => {
    const user = userEvent.setup();
    const only: Shelf = {
      id: 0,
      kind: "unfiled",
      group: "own",
      name: "Not sorted",
      pathIds: [0],
      path: ["Not sorted"],
      depth: 0,
      indent: 0,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
    };
    const loose = Array.from({ length: 6 }, (_, i) => ({ ...ROW, id: 100 + i, cardId: `c${i}` }));
    renderTable([], {
      shelves: {
        layout: layoutShelves([{ shelf: only, tileCount: loose.length }], 1).rows,
        rowsOf: () => loose,
        complete: true,
        renderHeading: () => <span>heading</span>,
        renderLabel: () => null,
        renderEmpty: () => null,
        renderSticky: (_shelf, scrollToTop) => (
          <button type="button" onClick={scrollToTop}>
            Top
          </button>
        ),
      },
    });
    const scroller = screen.getByRole("table").parentElement as HTMLElement;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (next: number) => {
        top = next;
      },
    });

    // Two rows down: the header's bottom edge is over a data row, so the bar is drawn.
    top = 100;
    fireEvent.scroll(scroller);
    await user.click(await screen.findByRole("button", { name: "Top" }));

    expect(scroller.scrollTop).toBe(0);
  });

  /**
   * **The rails** (spec §3.3, the table's half): one 1px line per level of indent, in the band's
   * content and in the first cell of every row under it, standing where the wall's stand — so a
   * shelf two folders down reads as two lines down its left side in either view.
   */
  it("draws one rail per level of indent on a nested shelf's band and on each of its rows", () => {
    const nested: Shelf = {
      id: 11,
      kind: "folder",
      group: "own",
      name: "Foils",
      pathIds: [4, 9, 11],
      path: ["Trade binder", "Showcase", "Foils"],
      depth: 2,
      indent: 2,
      lead: [],
      leadIds: [],
      headless: false,
      collapsed: false,
      locked: false,
    };
    const inFoils = { ...ROW, id: 61, folderId: 11, folderName: "Foils", name: "Counterspell" };
    renderTable([], {
      shelves: {
        layout: layoutShelves([{ shelf: nested, tileCount: 1 }], 1).rows,
        rowsOf: () => [inFoils],
        complete: true,
        renderHeading: (s) => <span>{`${s.name} heading`}</span>,
        renderLabel: () => null,
        renderEmpty: () => null,
        renderSticky: () => null,
      },
    });

    const band = screen.getByText("Foils heading").closest("[data-band]") as HTMLElement;
    const row = screen.getByText("Counterspell").closest('[role="row"]') as HTMLElement;
    for (const drawn of [band, row]) {
      const rails = [...drawn.querySelectorAll<HTMLElement>("[data-shelf-rail]")];
      expect(rails.map((rail) => parseFloat(rail.style.left))).toEqual([
        SHELF_RAIL_OFFSET_PX,
        SHELF_RAIL_OFFSET_PX + SHELF_INDENT_PX,
      ]);
    }
  });

  it("draws no rail on a shelf directly under the level", () => {
    renderTable([], {
      shelves: {
        layout: layoutShelves(
          [
            {
              shelf: {
                id: 4,
                kind: "folder",
                group: "own",
                name: "Trade binder",
                pathIds: [4],
                path: ["Trade binder"],
                depth: 0,
                indent: 0,
                lead: [],
                leadIds: [],
                headless: false,
                collapsed: false,
                locked: false,
              },
              tileCount: 1,
            },
          ],
          1,
        ).rows,
        rowsOf: () => [ROW],
        complete: true,
        renderHeading: (s) => <span>{`${s.name} heading`}</span>,
        renderLabel: () => null,
        renderEmpty: () => null,
        renderSticky: () => null,
      },
    });
    expect(document.querySelector("[data-shelf-rail]")).toBeNull();
  });
});

/**
 * **The table's half of the caret's return** (live pass, check 8): a heading band that never
 * changes which folder it draws, and a requested heading brought into view (`revealShelfId`,
 * handed to `VirtualTable` as `revealIndex`).
 */
describe("CollectionTable's heading bands", () => {
  /** A reader's folder at the top level, with one row filed in it. */
  const folderShelf = (id: number, name: string): Shelf => ({
    id,
    kind: "folder",
    group: "own",
    name,
    pathIds: [id],
    path: [name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
  });
  const rowIn = (shelf: Shelf): CollectionRow => ({
    ...ROW,
    id: 1000 + shelf.id,
    cardId: `c-${shelf.id}`,
    name: `${shelf.name} card`,
    folderId: shelf.id,
    folderName: shelf.name,
  });
  const shelvesOf = (
    order: readonly Shelf[],
    over: Partial<CollectionTableShelves> = {},
  ): CollectionTableShelves => {
    const byId = new Map(order.map((shelf) => [shelf.id, [rowIn(shelf)]]));
    return {
      layout: layoutShelves(
        order.map((shelf) => ({ shelf, tileCount: 1 })),
        1,
      ).rows,
      rowsOf: (id) => byId.get(id) ?? [],
      complete: true,
      renderHeading: (s) => <button type="button">{`Manage ${s.name}`}</button>,
      renderLabel: () => null,
      renderEmpty: () => null,
      renderSticky: () => null,
      ...over,
    };
  };
  const table = (shelves: CollectionTableShelves) => (
    <CollectionTable
      rows={[]}
      total={shelves.layout.length}
      listKey="test"
      sort={[]}
      onSort={vi.fn()}
      onNeedNextPage={vi.fn()}
      onSetQuantity={vi.fn()}
      onRemove={vi.fn()}
      marketplace={MARKETPLACES.tcgplayer}
      shelves={shelves}
    />
  );

  /**
   * **A move is not a relabel.** `VirtualTable` keys its rows by position, so a Move up used to hand
   * the moved folder's old place — its heading, `⋯` and all — to the folder that took it, and the
   * caret the menu had just put back on that `⋯` stayed on a control that now named another
   * folder. Keyed by the shelf, the old heading goes with its folder.
   */
  it("never redraws one folder's heading as another's", () => {
    const binder = folderShelf(3, "Trade binder");
    const sealed = folderShelf(4, "Sealed");
    const { rerender } = render(table(shelvesOf([binder, sealed])));
    const before = screen.getByRole("button", { name: "Manage Trade binder" });

    rerender(table(shelvesOf([sealed, binder])));

    expect(before.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: "Manage Trade binder" })).not.toBe(before);
  });

  /**
   * **A requested heading is brought into view** — a moved folder's, or Add folder's draft — which
   * on a long table is a band the virtualiser has not drawn. jsdom is made to scroll for this case:
   * the reveal is a `scrollTo`, clamped by the virtualiser to `scrollHeight`, which jsdom answers as 0.
   */
  it("reveals the heading band of the shelf it is asked for", async () => {
    const order = Array.from({ length: 40 }, (_, i) => folderShelf(100 + i, `F${i}`));
    const scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, to: ScrollToOptions | number, y?: number) {
        this.scrollTop = typeof to === "number" ? (y ?? 0) : (to.top ?? this.scrollTop);
        this.dispatchEvent(new Event("scroll"));
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1_000_000,
    });
    try {
      const { rerender } = render(table(shelvesOf(order)));
      expect(screen.queryByRole("button", { name: "Manage F39" })).toBeNull();

      rerender(table(shelvesOf(order, { revealShelfId: 139 })));

      expect(await screen.findByRole("button", { name: "Manage F39" })).toBeInTheDocument();
    } finally {
      if (scrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollTo);
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});
