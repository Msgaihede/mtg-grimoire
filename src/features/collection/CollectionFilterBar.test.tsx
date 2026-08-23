import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { CollectionFilterBar } from "./CollectionFilterBar";
import type { Collection } from "./useCollection";

/**
 * The real picker asks the backend for ~1 050 sets on the way up, and the one thing this
 * file has to say about it is that its `onToggle` reaches `collection.toggleSet` — so it
 * stands in as a button that toggles a set. Same stub as `FilterBar.test.tsx`'s.
 */
vi.mock("@/features/search/SetCombobox", () => ({
  SetCombobox: ({ onToggle }: { onToggle: (code: string) => void }) => (
    <button type="button" onClick={() => onToggle("lea")}>
      Sets
    </button>
  ),
}));

/** Every field the bar reads, as spies. Not the hook: what is under test is the wiring. */
const collection = (over: Record<string, unknown> = {}) =>
  ({
    text: "",
    setText: vi.fn(),
    format: "",
    setFormat: vi.fn(),
    colors: [] as string[],
    toggleColor: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    manaX: false,
    toggleManaX: vi.fn(),
    finishes: [] as string[],
    toggleFinish: vi.fn(),
    conditions: [] as string[],
    toggleCondition: vi.fn(),
    needsReview: undefined,
    setNeedsReview: vi.fn(),
    toggleNeedsReview: vi.fn(),
    sort: [],
    sortSelection: "name",
    setSortKey: vi.fn(),
    toggleSort: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    ...over,
  }) as unknown as Collection;

/** `+ New folder`'s handler. The page owns the layer that opens, so what this bar promises is
 *  only that the press reaches it — with the trigger element, which is how the page hands the
 *  caret back when the layer closes. */
const newFolder = vi.fn();

beforeEach(() => {
  newFolder.mockReset();
  // Both halves start equal, so the assertion below can tell which one the toggle wrote.
  useAppStore.setState({ collectionView: "table", searchView: "table" });
});

describe("CollectionFilterBar", () => {
  /**
   * Thirty controls over one state object is where a copy-paste swap hides: a colour chip
   * calling `toggleManaValue`, or the sort `<select>` calling `setFormat`, renders green and
   * filters by the wrong thing. Every control, once, against the field it is named for.
   *
   * Batched deliberately — this is one fact about one component, and thirteen `it`s
   * repeating the same render would be ceremony. Finish and condition also reach the query
   * end-to-end in `CollectionPage.test.tsx`; the Needs-review chip does not, which is
   * exactly why it is here.
   */
  it("wires every control to the filter it is named for", async () => {
    const c = collection({ activeCount: 2 });
    render(<CollectionFilterBar collection={c} onNewFolder={newFolder} />);

    // The box is controlled by a spy, so its value never moves off "" — one character is the
    // whole of what a keystroke can prove here.
    await userEvent.type(screen.getByLabelText(/search your collection/i), "b");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "commander");
    await userEvent.click(screen.getByRole("button", { name: "Red" }));
    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Cards with X in their mana cost" }));
    await userEvent.click(screen.getByRole("button", { name: "Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "Foil" }));
    await userEvent.click(screen.getByRole("button", { name: /^LP/ }));
    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "price");
    await userEvent.click(screen.getByRole("button", { name: /reset all/i }));

    expect(c.setText).toHaveBeenCalledWith("b");
    expect(c.setFormat).toHaveBeenCalledWith("commander");
    expect(c.toggleColor).toHaveBeenCalledWith("R");
    expect(c.toggleManaValue).toHaveBeenCalledWith(3);
    // Its own field, not a tenth mana value — so the two presses above land on two different
    // callbacks, and `toggleManaValue` heard exactly the one that was a numeral.
    expect(c.toggleManaX).toHaveBeenCalled();
    expect(c.toggleManaValue).toHaveBeenCalledTimes(1);
    expect(c.toggleSet).toHaveBeenCalledWith("lea");
    expect(c.toggleFinish).toHaveBeenCalledWith("foil");
    expect(c.toggleCondition).toHaveBeenCalledWith("LP");
    expect(c.toggleNeedsReview).toHaveBeenCalled();
    expect(c.setSortKey).toHaveBeenCalledWith("price");
    expect(c.resetAll).toHaveBeenCalled();
    // Reset all clears the filters and not the layout: how the reader reads is not what they
    // are looking at.
    expect(useAppStore.getState().collectionView).toBe("table");

    // The layout is the one control on this row that is not a filter — it is the store's,
    // and it is the *collection's* half of the store, never the search's.
    await userEvent.click(screen.getByRole("button", { name: "Card view" }));

    expect(useAppStore.getState().collectionView).toBe("grid");
    expect(useAppStore.getState().searchView).toBe("table");
  });

  /**
   * The chip's *label* is what says which state is on — the wishlist's rule, and it is what
   * makes one three-state chip readable at all: an unpressed chip cannot mean "not flagged"
   * and also be the same chip that means it when pressed.
   */
  it("says which of the three needs-review states is on", () => {
    const { rerender } = render(<CollectionFilterBar collection={collection()} onNewFolder={newFolder} />);
    expect(screen.getByRole("button", { name: "Needs review" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    rerender(<CollectionFilterBar collection={collection({ needsReview: true })} onNewFolder={newFolder} />);
    expect(screen.getByRole("button", { name: "Needs review" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(<CollectionFilterBar collection={collection({ needsReview: false })} onNewFolder={newFolder} />);
    const complement = screen.getByRole("button", { name: "Not flagged" });
    expect(complement).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * The same chip the search's row draws, minus the sentence a count would add to it.
   *
   * **This bar is deliberately not facet-aware** — it wires no counts to any control — so the
   * X chip keeps the plain label it was born with and nothing here ever greys. Worth asserting
   * rather than assuming: the chip takes four props on the search's side, and a row that had
   * quietly started passing a `xDisabled` it computed itself would grey a filter over counts
   * this view has never asked for.
   */
  it("shows the X chip on, with no count and nothing greyed", () => {
    render(<CollectionFilterBar collection={collection({ manaX: true })} onNewFolder={newFolder} />);

    const chip = screen.getByRole("button", { name: "Cards with X in their mana cost" });
    expect(chip).toHaveTextContent("X");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).not.toHaveAttribute("aria-disabled");
  });

  /** Every `<option>`'s text, in the order the reader scrolls past them. */
  const optionsOf = (label: string) =>
    within(screen.getByLabelText(label))
      .getAllByRole("option")
      .map((o) => o.textContent);

  /**
   * Alphabetical by the words on screen, which is the one order an option list in this app
   * is drawn in (`lib/options.ts`): a reader hunting Modern looks under M, not in the
   * position somebody decided the formats rank in — knowledge the list itself never shows.
   *
   * The assertion is the whole sequence rather than a spot check, because `FORMATS` is
   * shared with the search's picker and declared in that ranking order: a bar that had
   * quietly gone back to mapping the constant would still put a real format under every
   * option, and only the sequence says which list is being read.
   *
   * "Any format" stays first, outside the sort — it is the absence of the filter and not a
   * format. Nothing on screen distinguishes that from it merely sorting first today, which
   * is exactly why it is pinned *and* asserted: rename it to "No format filter" and a
   * sorted-in version would land between Modern and Pauper, where nobody would look for it.
   */
  it("offers the formats alphabetically, under a pinned Any format", () => {
    render(<CollectionFilterBar collection={collection()} onNewFolder={newFolder} />);

    expect(optionsOf("Format")).toEqual([
      "Any format",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Standard",
      "Vintage",
    ]);
  });

  /**
   * The same rule over the sort orders, and they are the harder half: these are named for
   * what they *answer* ("Recently added", "Highest price"), so their declaration order in
   * `COLLECTION_SORTS` is a train of thought rather than anything a reader can see, and a
   * picker that showed it would be showing the author's notes.
   *
   * "Custom…" is pinned above them for the reason "Any format" is — it is the state of the
   * control, not an order to pick — and it appears only when the sort came from a header
   * this select has no option for, which is what the second render is.
   */
  it("offers the sort orders alphabetically, under a pinned Custom…", () => {
    const { rerender } = render(<CollectionFilterBar collection={collection()} onNewFolder={newFolder} />);

    const orders = ["Highest price", "Most copies", "Name", "Recently added", "Set and number"];
    expect(optionsOf("Sort")).toEqual(orders);

    rerender(<CollectionFilterBar collection={collection({ sortSelection: "" })} onNewFolder={newFolder} />);

    expect(optionsOf("Sort")).toEqual(["Custom…", ...orders]);
    // Still the unpickable placeholder it was before the sort moved it: a native `<option>`
    // is the house rule's one exception to `aria-disabled`.
    expect(
      within(screen.getByLabelText("Sort")).getByRole("option", { name: "Custom…" }),
    ).toBeDisabled();
  });

  /** Drawn from the first render and greyed until there is something to clear: a Reset that
   *  arrived on the first press would take its width out of the `flex-1` search box above and
   *  slide the row that is being pressed. */
  it("draws Reset all greyed until something is filtered", () => {
    render(<CollectionFilterBar collection={collection()} onNewFolder={newFolder} />);

    expect(screen.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * The Finish and Condition groups are asserted in the same breath, because the two are
   * built the same way three lines apart and a change written around the wrong
   * `role="group"` would go unnoticed by a test that only looked for one of them.
   */
  it("draws the finish and condition chip groups", () => {
    render(<CollectionFilterBar collection={collection()} onNewFolder={newFolder} />);

    expect(screen.getByRole("group", { name: "Condition" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Finish" })).toBeInTheDocument();
  });
});
