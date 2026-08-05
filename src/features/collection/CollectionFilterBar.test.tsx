import { render, screen } from "@testing-library/react";
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
    finishes: [] as string[],
    toggleFinish: vi.fn(),
    conditions: [] as string[],
    toggleCondition: vi.fn(),
    needsReview: false,
    setNeedsReview: vi.fn(),
    sort: "name",
    setSort: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    ...over,
  }) as unknown as Collection;

beforeEach(() => {
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
    render(<CollectionFilterBar collection={c} />);

    // The box is controlled by a spy, so its value never moves off "" — one character is the
    // whole of what a keystroke can prove here.
    await userEvent.type(screen.getByLabelText(/search your collection/i), "b");
    await userEvent.selectOptions(screen.getByLabelText("Format"), "commander");
    await userEvent.click(screen.getByRole("button", { name: "Red" }));
    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));
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
    expect(c.toggleSet).toHaveBeenCalledWith("lea");
    expect(c.toggleFinish).toHaveBeenCalledWith("foil");
    expect(c.toggleCondition).toHaveBeenCalledWith("LP");
    // The one chip in this row whose state is a plain boolean, so its handler is the one
    // that can be wired to the wrong `set*` and still render green.
    expect(c.setNeedsReview).toHaveBeenCalledWith(true);
    expect(c.setSort).toHaveBeenCalledWith("price");
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

  /** Nothing to reset, nothing to say — an always-visible Reset is a control that is
   *  disabled most of the time, which reads as broken. */
  it("hides Reset all until something is filtered", () => {
    render(<CollectionFilterBar collection={collection()} />);

    expect(screen.queryByRole("button", { name: /reset all/i })).not.toBeInTheDocument();
  });
});
