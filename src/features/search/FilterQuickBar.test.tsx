import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { TagChip } from "@/features/tags/tagFilters";
import type { SearchSortKey } from "@/lib/ipc";
import type { SortSpec } from "@/lib/sort";
import type { FilterSurface } from "./FilterBar";
import { FilterQuickBar } from "./FilterQuickBar";
import type { TagToken } from "./queryLanguage";
import { FORMATS } from "./useCardSearch";

/**
 * The card search's surface, stubbed — `FilterBar.test.tsx`'s factory, every field, copied rather
 * than imported because that one is a local `const`. The bar draws the same `FilterTray` the row
 * does, and the tray draws a cell only where its own setter is wired, so a stub missing one would
 * silently lose a cell rather than an assertion. That file carries the reasoning for each field.
 */
const search = (over: Record<string, unknown> = {}) =>
  ({
    text: "",
    setText: vi.fn(),
    format: "",
    setFormat: vi.fn(),
    formats: FORMATS,
    anyCard: true,
    colors: [] as string[],
    toggleColor: vi.fn(),
    colorsStrict: false,
    toggleColorsStrict: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    manaX: false,
    toggleManaX: vi.fn(),
    tagChips: [] as TagChip[],
    tagNotFound: [] as TagToken[],
    tagsResolving: false,
    removeTagChip: vi.fn(),
    toggleTagChipMode: vi.fn(),
    replaceTagToken: vi.fn(),
    sort: [] as SortSpec<SearchSortKey>,
    sortSelection: "" as SearchSortKey | "",
    setSortKey: vi.fn(),
    flipSortDir: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    rarities: [] as string[],
    toggleRarity: vi.fn(),
    types: [] as string[],
    toggleType: vi.fn(),
    borders: [] as string[],
    toggleBorder: vi.fn(),
    finishes: [] as string[],
    toggleFinish: vi.fn(),
    setOwned: vi.fn(),
    allPrintings: false,
    toggleAllPrintings: vi.fn(),
    priceMin: undefined as number | undefined,
    priceMax: undefined as number | undefined,
    setPriceRange: vi.fn(),
    marketplace: { id: "tcgplayer", label: "TCGplayer", currency: "usd", feed: false },
    ...over,
    sortDir:
      "sortDir" in over
        ? over.sortDir
        : ((over.sort ?? []) as SortSpec<SearchSortKey>)[0]?.dir,
  }) as unknown as FilterSurface<string>;

/**
 * The tray's set cell is the one control in it that runs a query (`useQuery` over the set list),
 * and nothing here is about sets — `FilterBar.test.tsx` mocks it for the same reason, so neither
 * suite needs a `QueryClientProvider` to open the tray.
 */
vi.mock("./SetCombobox", () => ({
  SetCombobox: () => <div data-testid="set-combobox" />,
}));

const bar = () => screen.getByRole("group", { name: "Filter quick bar" });

/**
 * `FiltersButton`'s name, `Show filters — N active` or `Hide filters — N active`. Anchored, because a
 * bare `/filters/i` also matches Reset all's `Reset all — N filters active` on the same bar.
 */
const FILTERS = /^(Show|Hide) filters/;

describe("FilterQuickBar", () => {
  it("draws nothing until shown", () => {
    render(<FilterQuickBar search={search()} shown={false} />, { wrapper: TooltipProvider });
    expect(screen.queryByRole("group", { name: "Filter quick bar" })).toBeNull();
  });

  it("writes to the page's own search", async () => {
    const s = search();
    render(<FilterQuickBar search={s} shown />, { wrapper: TooltipProvider });
    await userEvent.type(within(bar()).getByRole("searchbox", { name: "Search cards" }), "d");
    expect(s.setText).toHaveBeenCalledWith("d");
    await userEvent.click(within(bar()).getByRole("button", { name: "Red" }));
    expect(s.toggleColor).toHaveBeenCalledWith("R");
  });

  it("scrolls back to the top and hands the caret to the page's field", async () => {
    const main = document.createElement("main");
    main.style.overflowY = "auto";
    main.scrollTo = vi.fn();
    const field = document.createElement("input");
    field.id = "card-search-text";
    document.body.append(main, field);
    // Both stand outside RTL's own container, so its cleanup would leave them in the document —
    // and a stray `#card-search-text` would answer the id-stem case below on the bar's behalf.
    try {
      render(<FilterQuickBar search={search()} shown />, {
        wrapper: TooltipProvider,
        container: main.appendChild(document.createElement("div")),
      });
      await userEvent.click(within(bar()).getByRole("button", { name: "Back to the top" }));
      expect(main.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(document.activeElement).toBe(field);
    } finally {
      main.remove();
      field.remove();
    }
  });

  it("opens the tray under the bar and closes it on Escape, caret back on Filters", async () => {
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider });
    const filters = within(bar()).getByRole("button", { name: FILTERS });
    await userEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    const trayId = filters.getAttribute("aria-controls")!;
    expect(document.getElementById(trayId)).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(document.getElementById(trayId)).toBeNull();
    expect(document.activeElement).toBe(filters);
  });

  /**
   * **The tray lays out in columns only inside an `@container/fb` box**, because its grid is
   * `@min-[640px]/fb:grid-cols-2 @min-[900px]/fb:grid-cols-3` and a query naming a container no
   * ancestor is resolves to nothing — one column at every width. jsdom applies no container query,
   * so this pins the *structure*: the container is an ancestor of the tray, inside the bar, and
   * it is **not** the tray's scroller nor inside it. A container is the containing block for
   * `fixed` descendants, and every popup in the tray draws in a `fixed` frame, so a container on
   * the scroller would have the scroller clip them.
   */
  it("hangs the tray inside a filter-row container that is not its scroller", async () => {
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider });
    const filters = within(bar()).getByRole("button", { name: FILTERS });
    await userEvent.click(filters);
    const tray = document.getElementById(filters.getAttribute("aria-controls")!)!;
    const container = tray.closest<HTMLElement>('[class~="@container/fb"]');
    expect(container).not.toBeNull();
    expect(bar().contains(container)).toBe(true);
    expect(container!.classList.contains("overflow-y-auto")).toBe(false);
    const scroller = tray.closest<HTMLElement>(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    // The scroller sits inside the container, never the other way round.
    expect(scroller).not.toBe(container);
    expect(container!.contains(scroller)).toBe(true);
  });

  it("closes the tray on a press outside the bar", async () => {
    render(
      <>
        <button>elsewhere</button>
        <FilterQuickBar search={search()} shown />
      </>,
      { wrapper: TooltipProvider },
    );
    const filters = within(bar()).getByRole("button", { name: FILTERS });
    await userEvent.click(filters);
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(filters).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the tray when the bar leaves", async () => {
    const s = search();
    const { rerender } = render(<FilterQuickBar search={s} shown />, { wrapper: TooltipProvider });
    await userEvent.click(within(bar()).getByRole("button", { name: FILTERS }));
    (document.activeElement as HTMLElement).blur();
    rerender(<FilterQuickBar search={s} shown={false} />);
    rerender(<FilterQuickBar search={s} shown />);
    expect(within(bar()).getByRole("button", { name: FILTERS })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("the bar's tray uses its own id stem, so it cannot collide with the page row's", async () => {
    render(<FilterQuickBar search={search()} shown />, { wrapper: TooltipProvider });
    await userEvent.click(within(bar()).getByRole("button", { name: FILTERS }));
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.some((id) => id.startsWith("card-search-qb"))).toBe(true);
    expect(ids).not.toContain("card-search-sort");
    expect(ids).not.toContain("card-search-text");
    // The tray's own field, named: the bar's sort id alone would satisfy the `-qb` check above
    // even if the tray were handed the page row's stem.
    expect(ids).toContain("card-search-qb-format");
    expect(ids).not.toContain("card-search-format");
  });

  it("greys Reset all at zero and resets otherwise", async () => {
    const zero = search();
    const { unmount } = render(<FilterQuickBar search={zero} shown />, {
      wrapper: TooltipProvider,
    });
    const reset = within(bar()).getByRole("button", { name: /reset all/i });
    expect(reset).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(reset);
    expect(zero.resetAll).not.toHaveBeenCalled();
    unmount();
    const some = search({ activeCount: 2 });
    render(<FilterQuickBar search={some} shown />, { wrapper: TooltipProvider });
    await userEvent.click(
      within(bar()).getByRole("button", { name: "Reset all — 2 filters active" }),
    );
    expect(some.resetAll).toHaveBeenCalled();
  });

  it("draws a page's lead after Top", () => {
    render(<FilterQuickBar search={search()} shown lead={<span>picked tags here</span>} />, {
      wrapper: TooltipProvider,
    });
    expect(within(bar()).getByText("picked tags here")).toBeInTheDocument();
  });

  it("the folded mana-value press says what is picked and opens the chips", async () => {
    render(<FilterQuickBar search={search({ manaValues: [5, 4], manaX: true })} shown />, {
      wrapper: TooltipProvider,
    });
    const press = within(bar()).getByRole("button", { name: "Mana value — 4, 5, X" });
    // jsdom applies no stylesheet, so the inline group — hidden only by a container query — is
    // already in the tree. Counting before the press is what makes this a check on the popup
    // rather than one the inline chips pass on its behalf.
    const before = screen.getAllByRole("group", { name: "Mana value" }).length;
    await userEvent.click(press);
    expect(press).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("group", { name: "Mana value" }).length).toBeGreaterThan(before);
  });
});
