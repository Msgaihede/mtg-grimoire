import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANA_VALUES } from "@/components/FilterChips";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { FacetResponse, SearchSortKey } from "@/lib/ipc";
import type { TagChip } from "@/features/tags/tagFilters";
import type { SortSpec } from "@/lib/sort";
import { openDropdown, pickOption } from "@/test-dropdown";
import { LAYER } from "@/lib/layers";
import { stubNarrowWindow } from "@/test-viewport";
import type { TagToken } from "./tagQuery";
import { FilterBar } from "./FilterBar";
import { ANY_CARD, FORMATS } from "./useCardSearch";

const search = (over: Record<string, unknown> = {}) =>
  ({
    text: "",
    setText: vi.fn(),
    format: "",
    setFormat: vi.fn(),
    // The picker draws the search's own list, not the shared constant — see the seeded-format
    // cases at the foot of this file. `FORMATS` is what the hook answers a caller that asked
    // for no default, so it is what the stub carries and every case here reads as it always did.
    formats: FORMATS,
    // This stub stands for the **card search**, which is the one surface `Any card` is a real row
    // on — see `FilterSurface.anyCard`. The collection and the wishlist leave it off, and their
    // own page suites are where the two-rung ladder is asserted.
    anyCard: true,
    colors: [] as string[],
    toggleColor: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    manaX: false,
    toggleManaX: vi.fn(),
    // The tagger syntax's five members. Empty on every case here but the ones that override
    // them: `TagQueryRow` draws nothing at all with no tags typed, so the row this suite has
    // always measured is exactly the row it measures now.
    tagChips: [] as TagChip[],
    tagNotFound: [] as TagToken[],
    tagsResolving: false,
    removeTagChip: vi.fn(),
    toggleTagChipMode: vi.fn(),
    replaceTagToken: vi.fn(),
    // The sort's four members, in the shape `useCardSearch` hands them over. `sortSelection` is
    // a **controlled** select's value and has to be a string on every render an override does
    // not touch: `undefined` would make the picker uncontrolled, and React says so once, on the
    // render it changes, which is nowhere near the case that would have caused it.
    sort: [] as SortSpec<SearchSortKey>,
    sortSelection: "" as SearchSortKey | "",
    setSortKey: vi.fn(),
    flipSortDir: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    // The tray's own filters. **Every setter is here, and since 2026-08-25 that is structural
    // rather than tidy**: `FilterSurface`'s optional half is what tells a surface that *cannot*
    // ask a question from one that is not currently asking it, so `FilterTray` draws a cell only
    // when its own setter is — and a stub missing one would silently lose the cell rather than the
    // assertion. `owned` and `allPrintings` keep their unfiltered *values* (`undefined` and
    // `false`), which is what the row reads them as.
    rarities: [] as string[],
    toggleRarity: vi.fn(),
    setOwned: vi.fn(),
    allPrintings: false,
    toggleAllPrintings: vi.fn(),
    priceMin: undefined as number | undefined,
    priceMax: undefined as number | undefined,
    setPriceRange: vi.fn(),
    // **Not optional in the stub, because it is not optional in the hook.** The price field's
    // caption and the price chip's figures are both drawn in the marketplace's own currency, so a
    // stub without one crashes the whole component rather than losing one assertion — which is
    // what it did the first time this row grew a price filter.
    marketplace: { id: "tcgplayer", label: "TCGplayer", currency: "usd", feed: false },
    ...over,
    /**
     * **Which way the list runs — the *hook's* answer since 2026-08-25, not the row's.**
     *
     * `FilterBar` derived this from `sortSelection === ""` until the deck editor's Collection tab
     * started drawing the same row. That test is a rule about the **card search's** empty spec,
     * which is `Best match` and has no direction; the collection's empty spec is name order,
     * which has one — so derived in the component, one of the two surfaces is drawn with a dead
     * arrow. `useCardSearch` and `useCollectionSearch` each answer for themselves now.
     *
     * **Computed after the spread rather than defaulted before it**, which is what keeps the
     * cases below unchanged: every one of them says which way the list runs by overriding `sort`,
     * exactly as it did when the row read that array itself. An explicit `sortDir` still wins,
     * for the case that wants the two to disagree.
     */
    sortDir:
      "sortDir" in over
        ? over.sortDir
        : ((over.sort ?? []) as SortSpec<SearchSortKey>)[0]?.dir,
  }) as unknown as Parameters<typeof FilterBar>[0]["search"];

/**
 * Open the filter tray, and hand back the panel.
 *
 * Set, Format, Owned, Rarity, Price and Printings are behind a disclosure since the row was
 * redesigned, so a case about any of them opens it first. The four controls that never fold away
 * — the search box, the colours, the mana values and the sort — need none of this.
 */
async function openTray(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: /^Show filters/ }));
  return screen.getByRole("button", { name: /^Hide filters/ });
}

/** The direction button, matched on a **prefix**: its accessible name carries the direction and
 *  grows a reason when there is none to flip, so the exact enabled string fails on the row this
 *  suite opens with and would read as "the button is not there". */
const dirButton = () => screen.getByRole("button", { name: /^Sort direction/ });

/**
 * Records, for every Escape that reaches `window`'s bubble phase, whether something nearer the
 * reader had already spent it.
 *
 * That is the whole of what a filter box's Escape rule is *about*, rather than a detail of it:
 * every rung of `useDismissOnEscape` listens on `window` and every one of them returns early on
 * `defaultPrevented`, so "the box consumed this press" and "the layer behind it stayed open" are
 * one fact, readable in one place. Asserting only that `setText("")` ran would pass just as well
 * on a handler that cleared the box *and* let the press through to close the deck behind it.
 */
function watchEscapeAtWindow(): { prevented: boolean[]; stop: () => void } {
  const prevented: boolean[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") prevented.push(e.defaultPrevented);
  };
  window.addEventListener("keydown", onKey);
  return { prevented, stop: () => window.removeEventListener("keydown", onKey) };
}

vi.mock("./SetCombobox", () => ({
  SetCombobox: () => <div data-testid="set-combobox" />,
}));

/**
 * The direction button's tooltip binding — kept **first in this file**, deliberately, rather
 * than beside the rest of "its sort picker" below. That used to cost nothing; since the sort and
 * format pickers became `<Dropdown>`, it costs a false red.
 *
 * **jsdom's `:focus-visible` modality is one flag on the shared `window`, not scoped to a
 * render.** A real click anywhere earlier in this file's run — and every `pickOption`/
 * `openDropdown` call below is one, now that a picker is a `<button>` a reader presses rather
 * than a `<select>` a reader silently reassigns — leaves it on "pointer" for every render after
 * it, including one that has not been born yet. A `userEvent.tab()` normally restores "keyboard"
 * for the element it lands on; empirically it does not here once a prior test has both clicked a
 * `<Dropdown>` row *and* let the shell's own `dismiss()` hand focus back to the trigger
 * programmatically (`Dropdown.tsx`'s close path) — a `fireEvent.keyDown` warm-up before the
 * `.focus()`/`user.tab()` pair does not recover it either, tried and reverted. That shape is the
 * jsdom cross-test artifact `tooltip.test.tsx`'s "opens on focus with no delay" already names for
 * the same reason ("a synthetic `fireEvent.keyDown` + `.focus()` version lived here briefly and
 * was flaky"); this file just did not have a `<Dropdown>` click early enough to meet it before
 * 2026-08-25.
 *
 * So this describe runs before the first one that clicks anything, which is `describe("FilterBar",
 * ...)` below — its "offers the printings no format allows as a row of the format select" is the
 * first `pickOption` in the file. **Nothing about the assertions changed; only where they sit.**
 */
describe("FilterBar, its sort direction tooltip binding", () => {
  /**
   * The wrapper's whole reason to exist, and the one state nothing else covers: this suite has
   * no `TooltipProvider` above it anywhere else, and `FilterBar.stories.tsx`'s `SortedDescending`
   * — the only other wrapper coverage in the app — hovers only the *enabled* button. A real
   * `disabled` attribute fires no pointer events at all, so `FilterBar.tsx` binds the tooltip to
   * the `<span>` around the button rather than to the button itself; a browser then delivers the
   * hover to that span, which is what this fires on. **This is the test that fails if the
   * wrapper is ever removed and the binding moves onto the button directly** — nothing would be
   * listening on the span any more, and firing on the disabled button itself proves nothing (a
   * real browser never delivers a hover there, and jsdom does not hit-test to tell the two cases
   * apart).
   */
  it("still opens the direction tooltip by hover while the button is disabled", async () => {
    render(
      <TooltipProvider>
        <FilterBar search={search()} />
      </TooltipProvider>,
    );
    const button = dirButton();
    expect(button).toBeDisabled();

    fireEvent.pointerEnter(button.parentElement as HTMLElement);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Sort direction — Best match has no direction",
    );
  });

  /**
   * Important 3's fix, evidenced live rather than through the shared component's own unit
   * tests: `useTooltip.ts`'s `onFocus` used to hand the wrapping `<span>` above to
   * `TooltipProvider.focus()`, which tests `:focus-visible` on whatever anchor it is given — and
   * a `<span>` with no `tabIndex` is never itself the focused element, so Tab landing on this
   * *enabled* button opened nothing at all. `e.target`, the button React reports as actually
   * focused, is what fixes it — proven here with a real `userEvent.tab()` from the control just
   * before it in the row, the same path a keyboard reader takes.
   */
  it("opens the direction tooltip on Tab once an order is picked", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <FilterBar
          search={search({ sortSelection: "name", sort: [{ key: "name", dir: "asc" }] })}
        />
      </TooltipProvider>,
    );
    const button = dirButton();
    expect(button).not.toBeDisabled();

    screen.getByRole("button", { name: "Sort results" }).focus();
    await user.tab();
    expect(button).toHaveFocus();

    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull());
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Sort direction: ascending — press for descending",
    );
  });
});

describe("FilterBar", () => {
  /**
   * The direction is explicit: real symbols, not letters in circles. The glyph comes from
   * the bundled `mana-font`, so the class is the assertion — a letter `W` rendered as text
   * would pass a text query and be exactly the generic thing this replaced.
   */
  it("draws the colour filter with real mana symbols", () => {
    render(<FilterBar search={search()} />);

    const white = screen.getByRole("button", { name: "White" });
    expect(white.querySelector(".ms.ms-w")).not.toBeNull();
    expect(white).toHaveAttribute("aria-pressed", "false");
    // Colourless is a chip like the others, not an afterthought.
    expect(
      screen.getByRole("button", { name: "Colorless" }).querySelector(".ms.ms-c"),
    ).not.toBeNull();
  });

  it("shows which colours are on", () => {
    render(<FilterBar search={search({ colors: ["U"] })} />);

    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles a colour", async () => {
    const toggleColor = vi.fn();
    render(<FilterBar search={search({ toggleColor })} />);

    await userEvent.click(screen.getByRole("button", { name: "Green" }));

    expect(toggleColor).toHaveBeenCalledWith("G");
  });

  it("offers mana values 0 through 8 or more", async () => {
    const toggleManaValue = vi.fn();
    render(<FilterBar search={search({ toggleManaValue })} />);

    expect(screen.getByRole("button", { name: "Mana value 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mana value 8 or more" })).toHaveTextContent("8+");

    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));

    expect(toggleManaValue).toHaveBeenCalledWith(3);
  });

  /**
   * X is the tenth chip of the same group, and it is a *second axis* over it rather than a
   * tenth value: `cmc` counts `{X}` as zero, so `{X}{B}{B}{B}` sits in the 3 bucket and
   * answers this chip as well. The two are OR'd, so both being on is a real state and the row
   * has to show it — a chip that cleared its neighbours would be a different filter.
   */
  it("offers X at the end of the mana values, additively", async () => {
    const toggleManaX = vi.fn();
    const toggleManaValue = vi.fn();
    render(
      <FilterBar search={search({ manaValues: [3], manaX: true, toggleManaX, toggleManaValue })} />,
    );

    const chip = screen.getByRole("button", { name: "Cards with X in their mana cost" });
    expect(chip).toHaveTextContent("X");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Mana value 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(chip);

    expect(toggleManaX).toHaveBeenCalled();
    expect(toggleManaValue).not.toHaveBeenCalled();
  });

  /**
   * Drawn from the first render and greyed until there is something to clear. The search box
   * is `flex-1`, so a Reset that appeared on the first press would take its width out of the
   * box and slide all nine colour chips left — under the finger that just pressed one.
   */
  it("draws Reset all greyed until something is filtered", () => {
    render(<FilterBar search={search()} />);

    expect(screen.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * The printings no format allows are a **row of the format select**, not a chip beside it —
   * and the row that reaches them is the one the select does *not* open on, which is the one
   * thing about this control a reader cannot see. So the assertion is the pair together: what
   * is drawn as picked, and what asking for the wider corpus actually sends.
   *
   * There is deliberately no `Unplayable` button left to find. The chip and this select were
   * moving one axis in opposite directions, and their one combined state — "Modern, and also
   * the art cards" — was a filter contradicting itself.
   */
  it("offers the printings no format allows as a row of the format select", async () => {
    const setFormat = vi.fn();
    const user = userEvent.setup();
    render(<FilterBar search={search({ setFormat })} />);

    await openTray();

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    expect(screen.queryByRole("button", { name: /unplayable/i })).toBeNull();

    await pickOption(user, "Format", "Any card");

    expect(setFormat).toHaveBeenCalledWith(ANY_CARD);
  });

  /**
   * The trigger's own text is the whole of what the reader sees — a `<Dropdown>` given a value
   * that matches nothing falls back to its own placeholder dash rather than to a stale label
   * (`DEFAULT_PLACEHOLDER`, `Dropdown.tsx`), so reading the drawn text is what tells "Any card is
   * correctly picked" apart from "the value did not match and this is the dash instead".
   */
  it("shows Any card as picked when it is", async () => {
    render(<FilterBar search={search({ format: ANY_CARD })} />);

    await openTray();

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any card");
  });

  /**
   * Gold means "this is not where the control opens" — a wider claim than "a filter is on",
   * since `Any card` is a *widening* and lights the same way. `Any format` is the default and the
   * only value that reads as untouched.
   *
   * `classList.contains`, never `className.includes`: the trigger's own quiet state carries a
   * `hover:` variant of `text-text`, and a substring match would pass on that without the control
   * ever being gold.
   */
  it("draws the format picker gold once it names anything but Any format", async () => {
    const { rerender } = render(<FilterBar search={search()} />);
    await openTray();

    const untouched = screen.getByRole("button", { name: "Format" });
    expect(untouched.classList.contains("border-accent")).toBe(false);
    expect(untouched.classList.contains("text-accent")).toBe(false);

    rerender(<FilterBar search={search({ format: "modern" })} />);
    const named = screen.getByRole("button", { name: "Format" });
    expect(named.classList.contains("border-accent")).toBe(true);
    expect(named.classList.contains("text-accent")).toBe(true);

    // `Any card` is the widening row rather than the default, and it lights the same way.
    rerender(<FilterBar search={search({ format: ANY_CARD })} />);
    const widened = screen.getByRole("button", { name: "Format" });
    expect(widened.classList.contains("border-accent")).toBe(true);
  });

  /** The format trigger's half of the check above the sort picker's — see that test's comment
   *  for why `getByRole`'s resolved name alone cannot prove `labelledBy` is wired. */
  it("wires the format trigger's name through aria-labelledby, not only a label jsdom would resolve anyway", async () => {
    render(<FilterBar search={search()} />);
    await openTray();

    const trigger = screen.getByRole("button", { name: "Format" });
    const labelId = trigger.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent("Format");
  });

  it("counts what Reset all would clear, and clears it", async () => {
    const resetAll = vi.fn();
    render(<FilterBar search={search({ activeCount: 3, colors: ["W"], resetAll })} />);

    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("3");
    expect(reset).not.toHaveAttribute("aria-disabled");

    await userEvent.click(reset);

    expect(resetAll).toHaveBeenCalled();
  });

  /**
   * A box with text in it owns exactly one Escape — the rule `clearFieldOnEscape` states,
   * checked here because *whether this field is wired to it* is a fact about this field.
   *
   * The caret is put in the box by a **click**, the way a reader puts it there, rather than by
   * handing the field to `user.type` — a flow started from a programmatic focus tests a caret
   * nobody can produce.
   */
  it("spends one Escape emptying the box, and keeps that press off the layers behind", async () => {
    const user = userEvent.setup();
    const setText = vi.fn();
    const escapes = watchEscapeAtWindow();
    try {
      render(<FilterBar search={search({ text: "goblin", setText })} />);

      await user.click(screen.getByRole("searchbox", { name: /search cards/i }));
      await user.keyboard("{Escape}");

      expect(setText).toHaveBeenCalledWith("");
      expect(escapes.prevented).toEqual([true]);
    } finally {
      escapes.stop();
    }
  });

  /**
   * An empty box has nothing to undo, so the press is not its: it reaches `window` untouched,
   * where the view behind — a deck to close, a folder to go up out of — is waiting for it. This
   * half is what makes the `"navigation"` rung safe to have at all, so it is the half worth
   * pinning even on a view that has nothing to navigate.
   */
  it("lets Escape through an empty box", async () => {
    const user = userEvent.setup();
    const setText = vi.fn();
    const escapes = watchEscapeAtWindow();
    try {
      render(<FilterBar search={search({ text: "", setText })} />);

      await user.click(screen.getByRole("searchbox", { name: /search cards/i }));
      await user.keyboard("{Escape}");

      expect(setText).not.toHaveBeenCalled();
      expect(escapes.prevented).toEqual([false]);
    } finally {
      escapes.stop();
    }
  });
});

/**
 * Everything answers, and nothing is at zero — the baseline a story overrides one key of.
 *
 * `total` is 40 against colour counts of 10, so no colour is at either end of the rule and
 * the whole row starts live. It is **printings**, and it is deliberately not the number the
 * results caption prints: the list collapses printings into cards and this count does not.
 */
const facets = (over: Partial<FacetResponse> = {}): FacetResponse => ({
  colors: { W: 10, U: 10, B: 10, R: 10, G: 10, C: 10 },
  manaValues: Object.fromEntries(MANA_VALUES.map((v) => [String(v), 5])),
  // A field beside that map rather than a key inside it: X is not a mana value, and a
  // sentinel key would be one the backend, the fake and this fixture all had to agree was
  // not a number. Five, like the values, so the whole group starts live.
  manaX: 5,
  formats: Object.fromEntries(FORMATS.map((f) => [f.value, 5])),
  // All four keys, as a ready response always carries them — a chip greys on a counted zero and
  // stays live on an absent key, so a fixture missing one would be testing the wrong arm.
  rarities: { common: 5, uncommon: 5, rare: 5, mythic: 5 },
  sets: { lea: 5 },
  owned: { owned: 3, missing: 37 },
  total: 40,
  ready: true,
  ...over,
});

/** Every rarity counted, so a case overriding one is overriding exactly one. */
const ALL_RARITIES = { common: 5, uncommon: 5, rare: 5, mythic: 5 };

/**
 * What the row says it is filtering by, in document order.
 *
 * The **sequence** is part of the behaviour — the chips read left to right in the order the
 * filters are counted — so this hands back the whole list and each case asserts all of it. Two
 * chips swapped past each other satisfy any assertion about one being present.
 */
const chipLabels = () =>
  screen
    .queryAllByRole("button", { name: /^Remove filter — / })
    .map((b) => b.getAttribute("aria-label")!.replace("Remove filter — ", ""));

describe("FilterBar, greyed by its facets", () => {
  /**
   * `aria-disabled`, **not** `disabled`: a disabled button leaves the tab order, and a
   * keyboard reader would watch the filter row shrink and grow as they type. The chip stays
   * focusable, keeps saying whether it is pressed, and ignores the press.
   */
  it("greys a mana value nothing in this search costs, and keeps it reachable", async () => {
    const toggleManaValue = vi.fn();
    render(
      <FilterBar
        search={search({
          toggleManaValue,
          facets: facets({ manaValues: { ...facets().manaValues, "7": 0 } }),
        })}
      />,
    );

    const chip = screen.getByRole("button", { name: /^Mana value 7\b/ });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Mana value 6\b/ })).not.toHaveAttribute(
      "aria-disabled",
    );

    await userEvent.click(chip);

    expect(toggleManaValue).not.toHaveBeenCalled();
  });

  /**
   * The X chip greys by the rule its neighbours grey by and for the same reason: Rust counts
   * it off the same `Skip::Mana` base the 0–8 counts come from, so a zero here means "nothing
   * in this search has an X in its cost" exactly as a zero on `7` means nothing costs seven.
   * The only difference is the shape of the answer — a field beside the map rather than a key
   * in it — which is why `countDisabled` exists rather than a second rule written next to it.
   */
  it("greys X when nothing in this search has one, and keeps it reachable", async () => {
    const toggleManaX = vi.fn();
    render(<FilterBar search={search({ toggleManaX, facets: facets({ manaX: 0 }) })} />);

    const chip = screen.getByRole("button", { name: /^Cards with X in their mana cost\b/ });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).not.toBeDisabled();
    // Its neighbours are untouched: one zero is one chip, never the group.
    expect(screen.getByRole("button", { name: /^Mana value 3\b/ })).not.toHaveAttribute(
      "aria-disabled",
    );

    await userEvent.click(chip);

    expect(toggleManaX).not.toHaveBeenCalled();
  });

  /** The way out of a dead end stays open here too: pressing an X chip that is already on is
   *  how the reader gets rid of the filter that emptied their search. */
  it("never greys X while it is switched on", () => {
    render(<FilterBar search={search({ manaX: true, facets: facets({ manaX: 0 }) })} />);

    expect(
      screen.getByRole("button", { name: /^Cards with X in their mana cost\b/ }),
    ).not.toHaveAttribute("aria-disabled");
  });

  /** One sentence in one voice: X's tooltip is built by the same `facetTitle` as every other
   *  chip's, off the label the chip itself spells, so the greyed row reads as one row. */
  it("captions X in the same sentence as its neighbours", () => {
    const { rerender } = render(<FilterBar search={search({ facets: facets({ manaX: 812 }) })} />);

    // **The count is part of the accessible name, not only the tooltip** — every colour and
    // mana chip beside it spends one string as both (`aria-label="White — 10 printings"`), so
    // a `title` a screen reader never reaches is not where this row keeps its numbers. X reads
    // the same way or it is a tenth chip that says less than the nine.
    const counted = screen.getByRole("button", {
      name: "Cards with X in their mana cost — 812 printings",
    });
    expect(counted).toHaveTextContent("X");

    rerender(<FilterBar search={search({ facets: facets({ manaX: 0 }) })} />);

    expect(
      screen.getByRole("button", {
        name: "Cards with X in their mana cost — nothing in this search",
      }),
    ).toHaveTextContent("X");
  });

  /**
   * A cold index, a failed query and the first render all arrive here as no facets at all,
   * because `useCardSearch` collapses `ready: false` to `undefined` before the row ever sees
   * it (`facetsOrUndefined`). Not-greyed means "we don't know".
   *
   * X is in this list for a reason the others are not: its count is a number, so a cold
   * response carries `0` where the maps carry an absent key, and it is the one chip that
   * would grey if a raw response ever reached this row.
   */
  it("leaves every control live while the index is still building", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    await openTray();

    for (const name of [/^Mana value 7\b/, /^Cards with X\b/, /^White\b/, /^Owned\b/]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
    }

    await openDropdown(user, "Format");
    expect(screen.getByRole("option", { name: "Modern" })).not.toHaveAttribute("aria-disabled");
  });

  /**
   * The colour chips are the exception, and the likeliest thing to get wrong. `colors` is
   * subset semantics, so pressing one *broadens*: the question is whether the result set
   * would change, not whether it would empty. `W` here brings in nothing new (its count is
   * the whole result set) and `B` would empty it; both grey, for opposite reasons.
   */
  it("greys a colour that would change nothing and one that would empty the list", () => {
    render(
      <FilterBar
        search={search({ facets: facets({ colors: { W: 40, U: 22, B: 0, R: 10, G: 10, C: 10 } }) })}
      />,
    );

    expect(screen.getByRole("button", { name: /^White\b/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Black\b/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Blue\b/ })).not.toHaveAttribute("aria-disabled");
  });

  /** The way out of a dead end stays open: a chip that is already on is never greyed, however
   *  its count reads. Blue's count is the whole result set here — pressing it turns the filter
   *  *off*, which is the one press the reader needs. */
  it("never greys a colour that is switched on", () => {
    render(
      <FilterBar
        search={search({
          colors: ["U"],
          facets: facets({ colors: { W: 40, U: 40, B: 40, R: 40, G: 40, C: 40 } }),
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /^Blue\b/ })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /^White\b/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /** `aria-disabled`, not the native attribute — a dropdown row is never in the tab order to lose
   *  either way, but it is a `<li>` rather than a form tag, so `toBeDisabled()` would pass here
   *  whichever way the row actually reads: it checks only the native `disabled` attribute on a
   *  form-associated element, and a `role="option"` `<li>` never carries one. */
  it("greys a format nothing in this search is legal in", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar search={search({ facets: facets({ formats: { modern: 0, legacy: 4 } }) })} />,
    );

    await openTray();
    await openDropdown(user, "Format");

    expect(screen.getByRole("option", { name: "Modern" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("option", { name: "Legacy" })).not.toHaveAttribute("aria-disabled");
    // Never, either of them: they are how you get back to no format at all, and `Any card` is
    // the only row that can *widen* a search that has greyed itself into nothing.
    expect(screen.getByRole("option", { name: "Any format" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("option", { name: "Any card" })).not.toHaveAttribute("aria-disabled");
  });

  /**
   * Counts ride in the tooltip and the accessible name, never on the chips: a mana chip is a
   * 36px square and a colour chip a round symbol, and a numeral turns either into a different
   * control. The name has to *begin* with the label the chip draws (WCAG 2.5.3).
   */
  it("carries the count in the tooltip and the name, and not on the chip", () => {
    render(
      <FilterBar
        search={search({
          facets: facets({
            colors: { W: 12481, U: 10, B: 10, R: 10, G: 10, C: 10 },
            manaValues: { ...facets().manaValues, "7": 0 },
          }),
        })}
      />,
    );

    const white = screen.getByRole("button", { name: "White — 12,481 printings" });
    expect(white.textContent).toBe("");

    const seven = screen.getByRole("button", { name: "Mana value 7 — nothing in this search" });
    // The numeral on the chip is the chip's own label, not a count.
    expect(seven).toHaveTextContent("7");
  });

  /** The Owned chip is never greyed — one button cycling off → owned → missing → off, and
   *  greying it would strand whoever is mid-cycle. It carries its count anyway. */
  it("counts the Owned chip without ever greying it", async () => {
    const { rerender } = render(
      <FilterBar search={search({ facets: facets({ owned: { owned: 0, missing: 40 } }) })} />,
    );

    await openTray();

    const chip = screen.getByRole("button", { name: "Owned — nothing in this search" });
    expect(chip).not.toHaveAttribute("aria-disabled");

    // Mid-cycle, the word on the chip changes and the count follows it.
    rerender(
      <FilterBar
        search={search({ owned: false, facets: facets({ owned: { owned: 3, missing: 37 } }) })}
      />,
    );
    expect(screen.getByRole("button", { name: "Missing — 37 printings" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("FilterBar, its format options in order", () => {
  /** Every row the format picker draws, in document order — opened first, since the shell only
   *  renders its rows while the panel is up. The **sequence** is the behaviour under test, so
   *  each of these asserts the whole list: two formats swapped past each other pass any
   *  assertion about one row's presence, and did.
   *
   *  Scoped to the format listbox rather than the document. Nothing else is open in these cases,
   *  but a bare `screen.getAllByRole("option")` would still mix it with a sort or a set listbox
   *  the moment one of those opened first. */
  async function formatOrder(user: UserEvent): Promise<(string | null)[]> {
    await openDropdown(user, "Format");
    return within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
  }

  /**
   * A reader hunting for "Modern" hunts under M. `FORMATS` is authored in the order the formats
   * rank, which is knowledge a dropdown never shows, so with nothing greyed the list has to read
   * as one plain alphabet — and with no facets in hand `optionDisabled` answers false for every
   * key, which is the path that has to fall out of the grouping rather than be a special case
   * somebody has to remember.
   */
  it("reads alphabetically while the index is still building", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
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
   * The two pinned rows are a **ladder, widest first**, and it is the one ordering in this list
   * that is not alphabetical and not faceted: every card, every card legal *somewhere*, then one
   * named format. `Any card` collates above `Any format` by accident of the alphabet, which is
   * exactly why this is asserted rather than left to fall out — a reader predicts the ladder,
   * and the alphabet agreeing with it here is not what puts it in that order.
   */
  it("opens on Any format with Any card above it", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    await openTray();

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    expect((await formatOrder(user)).slice(0, 2)).toEqual(["Any card", "Any format"]);
  });

  /**
   * **The ladder is two rungs on a surface that does not narrow its corpus**, and this is the
   * case the row shipped without.
   *
   * `Any card` is not a format — it is the row that puts back the printings *no* format allows,
   * and it only means anything where every other row of the picker rides `playableOnly`
   * (`formatParams`). The collection and the wishlist filter by nothing of the kind, and drawing
   * it there set `format` to the `any-card` sentinel, which their backends read as a legalities
   * key nothing matches: the list went empty and the control said `Any card`. So the row is
   * gated on `FilterSurface.anyCard`, which only `useCardSearch` sets.
   *
   * Asserted as an absence *and* as the first row, because "not in the list" alone would pass on
   * a build that drew it somewhere further down.
   */
  it("leaves Any card out where the surface does not narrow the corpus", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search({ anyCard: undefined })} />);

    await openTray();

    // `formatOrder` opens the panel, which is the only place the rows exist now: a `Dropdown`
    // draws nothing until its trigger is pressed, so the absence below is asserted against an
    // open listbox rather than against a closed control that has no rows either way.
    const order = await formatOrder(user);
    expect(order[0]).toBe("Any format");
    expect(order).not.toContain("Any card");
    expect(screen.queryByRole("option", { name: "Any card" })).not.toBeInTheDocument();
  });

  /**
   * The whole point of the sinking: what can be picked is what is seen first. A format nothing
   * in this search is legal in is kept rather than dropped — it says the search has nothing
   * there, and a list that shed rows as the facets landed would jump under the cursor — but it
   * has no business sitting between two formats that would return cards.
   */
  it("floats the pickable formats above the greyed ones, each half alphabetical", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        search={search({
          facets: facets({
            formats: {
              standard: 5,
              pioneer: 0,
              modern: 5,
              legacy: 0,
              vintage: 5,
              pauper: 0,
              commander: 5,
            },
          }),
        })}
      />,
    );

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Commander",
      "Modern",
      "Standard",
      "Vintage",
      "Legacy",
      "Pauper",
      "Pioneer",
    ]);
    // The split is the greying itself and not a second reading of the counts that could drift
    // from it — one `optionDisabled` answer decides both the half and the attribute.
    expect(screen.getByRole("option", { name: "Vintage" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("option", { name: "Legacy" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * `optionDisabled`'s "a selected option is never greyed" rule, reaching the ordering.
   * A picked format can be at zero — a search narrowed after the fact empties it — and it is
   * the one row the reader needs, because changing it is how they get their cards back.
   * Sinking it would file that row below every row they cannot use.
   */
  it("keeps the selected format above the greyed ones even at zero", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        search={search({
          format: "vintage",
          facets: facets({
            formats: {
              standard: 5,
              pioneer: 0,
              modern: 0,
              legacy: 0,
              vintage: 0,
              pauper: 0,
              commander: 0,
            },
          }),
        })}
      />,
    );

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Standard",
      "Vintage",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
    ]);
    expect(screen.getByRole("option", { name: "Vintage" })).not.toHaveAttribute("aria-disabled");
  });

  /**
   * The dead end — a search so narrow that every format greys at once, which one card and a
   * text filter is enough to reach. Both pinned rows are outside the sorted list, so they are
   * first and pickable here exactly as they are everywhere else: neither is a format, and they
   * are how a reader who has filtered themselves into nothing gets out.
   */
  it("pins both non-format rows first even when nothing at all is legal", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        search={search({
          facets: facets({ formats: Object.fromEntries(FORMATS.map((f) => [f.value, 0])) }),
        })}
      />,
    );

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Standard",
      "Vintage",
    ]);
    expect(screen.getByRole("option", { name: "Any format" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("option", { name: "Any card" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("option", { name: "Commander" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /** The deck editor's docked panel opens on the format of the deck being edited, and the hook
   *  seeds its `formats` with that key when the shared list has never carried it. */
  const seeded = (over: Record<string, unknown> = {}) =>
    search({ formats: [...FORMATS, { value: "historic", label: "Historic" }], ...over });

  /**
   * The whole reason the list is the search's own. A `<Dropdown>` whose `value` matches no
   * option does not silently keep drawing whatever was last picked — it falls back to its own
   * placeholder dash (`DEFAULT_PLACEHOLDER`, `Dropdown.tsx`), which would read as "no format at
   * all" while the filter it names goes on narrowing the results underneath. Both halves are
   * asserted because they fail differently: the trigger's own text is the whole of what the
   * reader sees, and a present-but-unpicked option in the listbox would still satisfy a bare
   * `getByRole` presence check — which is exactly the bug this guards against.
   */
  it("draws a format the shared list does not carry, and shows it as picked", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={seeded({ format: "historic" })} />);

    await openTray();
    await openDropdown(user, "Format");

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Historic");
    expect(screen.getByRole("option", { name: "Historic" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  /** It is a format like every other once it arrives, so it files under H rather than riding
   *  the top as the newcomer — a reader hunting for it hunts where the alphabet says. */
  it("sorts the seeded format into the alphabet rather than pinning it", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={seeded({ format: "historic" })} />);

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Commander",
      "Historic",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Standard",
      "Vintage",
    ]);
  });

  /**
   * The pin is outside the sort, and a seeded format is the first thing that can prove it:
   * `Alchemy` collates *above* both pinned rows (`Al` before `An`), so a list that sorted them
   * in with the rest would file a format above the way out of the filter, where nothing else in
   * this suite would notice. Neither pinned row is a format, and both are first whatever the
   * alphabet hands them.
   */
  it("keeps both pinned rows first when a seeded format would collate above them", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        search={search({
          format: "alchemy",
          formats: [...FORMATS, { value: "alchemy", label: "Alchemy" }],
        })}
      />,
    );

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Alchemy",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Standard",
      "Vintage",
    ]);
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Alchemy");
  });

  /** The seeded row greys by the rule every other row greys by — one `optionDisabled` answer,
   *  and no arm of it that only the seven written-down keys reach. */
  it("greys the seeded format when this search has nothing legal in it", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        search={seeded({ facets: facets({ formats: { ...facets().formats, historic: 0 } }) })}
      />,
    );

    await openTray();

    expect(await formatOrder(user)).toEqual([
      "Any card",
      "Any format",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Standard",
      "Vintage",
      "Historic",
    ]);
    // And it sinks below the pickable half rather than holding its slot under H.
    expect(screen.getByRole("option", { name: "Historic" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("option", { name: "Modern" })).not.toHaveAttribute("aria-disabled");
  });
});

/**
 * The sort picker and its direction button — the pair that gives the **grid** an order to be in.
 *
 * Everything here is asserted against the stub's four sort members rather than against a real
 * `useCardSearch`, so what these cases pin is the contract between the two: which key the picker
 * sends, which term the arrow reads, and that neither invents a sort of its own.
 */
describe("FilterBar, its sort picker", () => {
  /** Every row the sort picker draws, in document order — opened first, since the shell only
   *  renders its rows while the panel is up. Scoped to its own listbox, because the format
   *  dropdown beside it draws nine rows of its own and a bare `screen.getAllByRole` would mix
   *  the two lists the moment both were open. */
  async function sortOrder(user: UserEvent): Promise<(string | null)[]> {
    await openDropdown(user, "Sort results");
    return within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
  }

  /**
   * **`Sort results`, and this is the case that stops it being shortened back to `Sort`.**
   *
   * The collection's twin is a bare `Sort` and this one may not copy it, because this row is
   * drawn on two surfaces and one of them already has a `Sort`: the deck editor's toolbar sorts
   * the deck, this sorts the search results, and with the docked panel open both lists are on
   * screen at once. Two controls with one name is a control that cannot be addressed
   * unambiguously — by a screen reader walking the form, by voice control, or by a
   * `getByRole("button", { name: "Sort" })` that starts throwing "found multiple" the day a test
   * opens that panel.
   *
   * The absence of the bare name is asserted beside the presence of the long one, because that
   * is the half that fails when somebody shortens it: `Sort results` would still be *found* by a
   * substring query, and only an exact one says which word is drawn.
   */
  it("names the picker for the list it sorts, not for the act of sorting", () => {
    render(<FilterBar search={search()} layoutToggle={false} />);

    expect(screen.getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
  });

  /**
   * **`aria-labelledby`, checked directly — not merely that `getByRole` resolves a name.**
   *
   * `<button>` is an HTML "labelable" element (`isLabelableElement` in `dom-accessibility-api`'s
   * own source lists `"button"` beside `"select"`), so a `<label for>` reaches its accessible
   * name on its own, with **no** `aria-labelledby` wired at all — in jsdom and in a real browser
   * alike; this is not a jsdom quirk. So `getByRole("button", { name: "Sort results" })` keeps
   * finding the trigger whether or not `labelledBy` is actually passed — proven by deleting the
   * prop from `FilterBar.tsx` and re-running this file: all 66 cases stayed green. That is why the
   * naming rule this row exists to satisfy (`Dropdown.tsx`'s `SharedProps.labelledBy` doc) is not
   * "does a label reach the button" — it already does — but "does the name come from a connection
   * this markup states outright, rather than one a later refactor could quietly break by moving
   * the label or letting the `for`/`id` pair drift apart". Reading the attribute directly is what
   * a dropped `labelledBy` can still fail here, whatever the implicit label association goes on
   * doing for the *other* cases in this file.
   */
  it("wires the sort trigger's name through aria-labelledby, not only a label jsdom would resolve anyway", () => {
    render(<FilterBar search={search()} />);

    const trigger = screen.getByRole("button", { name: "Sort results" });
    const labelId = trigger.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent("Sort results");
  });

  /**
   * The row a reader opens the app on. `Best match` is not one of the seven columns — it is the
   * search's own ranking, relevance when there is a query and name when there is not — so it is
   * pinned above them rather than sorted in.
   *
   * **The name is load-bearing and issue #213 is why.** It read `Default order` until then, which
   * named the empty sort spec rather than the order it produces, and a reader on the alphabetical
   * opening wall took it for the name of alphabetical order. `Name`, two rows below, is the one
   * that really is alphabetical.
   *
   * **The trigger's own text, not merely a checked value.** A `<Dropdown>` whose `value` matches
   * no option falls back to its own placeholder dash rather than to this row's label — so if the
   * picker ever lost its selection entirely, the trigger would read `—` rather than `Best match`.
   * Checking the drawn text is what tells "correctly untouched" apart from "silently reset".
   */
  it("opens on Best match, pinned above the orders", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    expect(screen.getByRole("button", { name: "Sort results" })).toHaveTextContent("Best match");
    expect((await sortOrder(user))[0]).toBe("Best match");
  });

  /**
   * Issue #213's fix, stated as the thing that was wrong: the pinned row and the alphabetical
   * row are two different rows with two different names, and neither of them says `Default`.
   *
   * A `not.toContain` over the whole list rather than a check on row 0, because the failure this
   * guards against is the old string coming back *anywhere* — a merge restoring the option, a
   * story fixture, a second picker copied off this one.
   */
  it("names the alphabetical order Name and never calls anything Default", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    const rows = await sortOrder(user);
    expect(rows).toContain("Name");
    expect(rows).toContain("Best match");
    expect(rows.some((r) => /default/i.test(r ?? ""))).toBe(false);
  });

  /**
   * Alphabetical by the words on screen, which is the one order an option list in this app is
   * drawn in (`lib/options.ts`). `SEARCH_SORT_OPTIONS` is declared in the order the orders were
   * reasoned about — the table's five columns, then the two with no column at all — and a picker
   * that showed that would be showing the author's notes.
   *
   * The whole sequence rather than a spot check: two rows swapped past each other satisfy any
   * assertion about one row's presence. `Mana value` and `Released` are the two orders no header
   * can reach, and they are in here as ordinary rows, pinned nowhere.
   */
  it("offers the orders alphabetically, under the pinned Best match", async () => {
    const user = userEvent.setup();
    render(<FilterBar search={search()} />);

    expect(await sortOrder(user)).toEqual([
      "Best match",
      "Mana value",
      "Name",
      "Price",
      "Rarity",
      "Released",
      "Set",
      "Type",
    ]);
  });

  /**
   * Picking a row *replaces* the sort with that one term, which is the hook's job. This row's
   * job is to send the key it drew, spelled the way Rust's `SEARCH_SORTS` whitelist spells it —
   * an unrecognised key is dropped silently at the far end, so a typo here is a control that
   * does nothing and no test anywhere goes red for it.
   */
  it("sends the key a picked order names", async () => {
    const setSortKey = vi.fn();
    const user = userEvent.setup();
    render(<FilterBar search={search({ setSortKey })} />);

    await pickOption(user, "Sort results", "Mana value");

    expect(setSortKey).toHaveBeenCalledWith("manaValue");
  });

  /** …and back out again, which on the grid is the **only** way out of a sort: the third press
   *  that clears one is a press on a table header the grid does not draw. */
  it("sends the empty key when the reader picks Best match back", async () => {
    const setSortKey = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        search={search({
          setSortKey,
          sortSelection: "price",
          sort: [{ key: "price", dir: "desc" }],
        })}
      />,
    );

    await pickOption(user, "Sort results", "Best match");

    expect(setSortKey).toHaveBeenCalledWith("");
  });

  /**
   * There is no direction in the view's own order to flip, and the button says *that* rather
   * than claiming one — a button announcing "ascending" over a relevance-ordered list would be
   * describing a sort that is not there.
   *
   * The **real `disabled`**, against this row's `aria-disabled` rule, and the reason is inside
   * that rule: it is about a row greying as the reader *types*, where a control leaving the tab
   * order shrinks the row out from under a keyboard caret. This one can only grey from the
   * select beside it, which is where the caret already is when it happens.
   */
  it("disables the direction button while the list is ranked by Best match", () => {
    render(<FilterBar search={search()} />);

    const button = dirButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Sort direction — Best match has no direction");
  });

  /** The name says the state **and** what pressing does, because an arrow is the whole of what
   *  is drawn on the button — an arrow pointing up reads as "this is ascending" to one reader
   *  and "press to go up" to the next. One string, spent as the name and — since the tooltip
   *  sweep — as the hover tooltip too (`FilterBar.tsx`'s wrapped `useTooltip` binding). */
  it("enables the direction button once an order is picked, and says which way it runs", () => {
    render(
      <FilterBar search={search({ sortSelection: "name", sort: [{ key: "name", dir: "asc" }] })} />,
    );

    const button = dirButton();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAccessibleName("Sort direction: ascending — press for descending");
  });

  it("says the other sentence when the list runs the other way", () => {
    render(
      <FilterBar
        search={search({ sortSelection: "price", sort: [{ key: "price", dir: "desc" }] })}
      />,
    );

    expect(dirButton()).toHaveAccessibleName("Sort direction: descending — press for ascending");
  });

  /** The press is `flipSortDir` and nothing else. That call rewrites the **first** term in place,
   *  so a Shift-built second key stays where the table's headers put it — a button that reached
   *  for `setSortKey` instead would silently throw the rest of the sort away. */
  it("flips the direction on a press, without rebuilding the sort", async () => {
    const flipSortDir = vi.fn();
    const setSortKey = vi.fn();
    render(
      <FilterBar
        search={search({
          flipSortDir,
          setSortKey,
          sortSelection: "name",
          sort: [{ key: "name", dir: "asc" }],
        })}
      />,
    );

    await userEvent.click(dirButton());

    expect(flipSortDir).toHaveBeenCalledTimes(1);
    expect(setSortKey).not.toHaveBeenCalled();
  });

  /** A disabled `<button>` takes no click at all, which is the whole reason the attribute is
   *  right here: there is no handler left to guard, unlike every `aria-disabled` chip on this
   *  row. */
  it("ignores a press while there is no order to flip", async () => {
    const flipSortDir = vi.fn();
    render(<FilterBar search={search({ flipSortDir })} />);

    await userEvent.click(dirButton());

    expect(flipSortDir).not.toHaveBeenCalled();
  });

  /**
   * The other end of one piece of state. The table's headers write into the same spec, so a
   * header press has to show up here — without it the two controls would be two sorts, and the
   * reader would be told two different things about one list.
   */
  it("reads back the key a table header put in the spec", () => {
    render(
      <FilterBar
        search={search({ sortSelection: "rarity", sort: [{ key: "rarity", dir: "asc" }] })}
      />,
    );

    expect(screen.getByRole("button", { name: "Sort results" })).toHaveTextContent("Rarity");
  });

  /** A Shift-built second key belongs to the table and is none of this row's business: the
   *  trigger shows the **first** term and the arrow shows that term's direction. */
  it("shows the first term of a multi-key sort and ignores the rest", () => {
    render(
      <FilterBar
        search={search({
          sortSelection: "rarity",
          sort: [
            { key: "rarity", dir: "desc" },
            { key: "price", dir: "asc" },
          ],
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Sort results" })).toHaveTextContent("Rarity");
    expect(dirButton()).toHaveAccessibleName("Sort direction: descending — press for ascending");
  });

  /**
   * One arrow, turned over — never `ArrowDown` swapped in for `ArrowUp`. Two components in one
   * slot is an unmount and a mount, so the indicator *teleports* and the whole of what the press
   * means is lost.
   *
   * Asserted as **element identity** across the flip, the way this repo asserts every "same
   * element, changed" claim: the two drawings are otherwise indistinguishable in the DOM, so a
   * swap would satisfy every other case in this file. The rotation itself is a `motion` style
   * and is deliberately not asserted — `SortableHeader` pins the same fact in words too.
   */
  it("turns one arrow rather than swapping a second one in", () => {
    const { rerender } = render(
      <FilterBar search={search({ sortSelection: "name", sort: [{ key: "name", dir: "asc" }] })} />,
    );

    const ascending = dirButton().querySelector("svg");
    expect(ascending).not.toBeNull();

    rerender(
      <FilterBar
        search={search({ sortSelection: "name", sort: [{ key: "name", dir: "desc" }] })}
      />,
    );

    expect(dirButton().querySelectorAll("svg")).toHaveLength(1);
    expect(dirButton().querySelector("svg")).toBe(ascending);
  });

  /** A sort is not a filter: the badge does not count it and Reset all does not clear it. A
   *  sorted, unfiltered search is therefore a greyed Reset all beside a live direction button,
   *  which is the one drawing that says both halves at once. */
  it("does not count the sort as a filter", () => {
    render(
      <FilterBar
        search={search({ sortSelection: "released", sort: [{ key: "released", dir: "desc" }] })}
      />,
    );

    expect(screen.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(dirButton()).not.toBeDisabled();
  });

  /**
   * `layoutToggle` is not the fence, and this is the case that says so. The deck editor's docked
   * panel passes `layoutToggle={false}` because it is a wall of art with no table to switch to —
   * which makes it exactly the surface with no other way to sort at all, so the pair rides there
   * unconditionally. The absence of the layout group is asserted beside it, because a pair that
   * happened to be drawn on a row that still had its toggle would prove nothing.
   */
  it("draws the picker on the surface that has no layout pair", () => {
    render(<FilterBar search={search()} layoutToggle={false} />);

    expect(screen.queryByRole("group", { name: "Result layout" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    expect(dirButton()).toBeInTheDocument();
  });

  /**
   * **Never gold.** A list is always in *some* order, so a sort cannot be inactive, and accent
   * on this row means "a filter is on" — which the format select two controls back really does
   * mean and this one must not.
   *
   * `classList.contains`, never `className.includes`: the row's quiet controls carry `hover:`
   * variants of these same colours, and a substring match passes on a variant without the
   * control ever being in the state.
   */
  it("never draws the sort in the filter-active colour", () => {
    render(
      <FilterBar
        search={search({ sortSelection: "price", sort: [{ key: "price", dir: "desc" }] })}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Sort results" });
    expect(trigger.classList.contains("text-accent")).toBe(false);
    expect(trigger.classList.contains("border-accent")).toBe(false);
    expect(trigger.classList.contains("text-dim")).toBe(true);
    expect(dirButton().classList.contains("text-accent")).toBe(false);
    expect(dirButton().classList.contains("border-accent")).toBe(false);
  });
});

/**
 * The shape of the redesign, and the only claim on this page that is about *absence*.
 *
 * Four controls never fold away — the box you type in, the colours, the mana values, and the
 * order the results come in — because those are the four a reader reaches for without looking.
 * Everything else is one press in. Asserted from both sides: a control that quietly stayed on the
 * bar would pass any test about the tray holding it.
 */
describe("FilterBar, its tray", () => {
  const ON_THE_BAR = [
    () => screen.getByPlaceholderText("Search cards…"),
    () => screen.getByRole("button", { name: "White" }),
    () => screen.getByRole("button", { name: "Mana value 3" }),
    () => screen.getByRole("button", { name: "Sort results" }),
  ];

  it("keeps four controls on the bar and folds the rest away", async () => {
    render(<FilterBar search={search()} />);

    for (const found of ON_THE_BAR) expect(found()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Format" })).toBeNull();
    expect(screen.queryByTestId("set-combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Owned\b/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rare cards\b/ })).toBeNull();
    expect(screen.queryByLabelText("Lowest price")).toBeNull();
    expect(screen.queryByRole("button", { name: "All printings" })).toBeNull();

    const toggle = await openTray();

    for (const found of ON_THE_BAR) expect(found()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Format" })).toBeInTheDocument();
    expect(screen.getByTestId("set-combobox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Owned\b/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rare cards\b/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Lowest price")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All printings" })).toBeInTheDocument();
    // The panel is the button's, said in the markup rather than only in the layout — an
    // `aria-controls` pointing at nothing is a promise to assistive tech that is not kept.
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeInTheDocument();
  });

  /**
   * **The count is the whole search's, not the tray's.** It is the same number Reset all wears,
   * so the two cannot disagree about how much is on while the tray is shut — and a reader who has
   * pressed three colours is never looking at a Filters button reading zero.
   */
  it("carries the search's own count, and draws no badge at zero", async () => {
    const { rerender } = render(<FilterBar search={search()} />);

    const quiet = screen.getByRole("button", { name: "Show filters — 0 active" });
    expect(quiet).toHaveTextContent("Filters");
    expect(quiet).not.toHaveTextContent("0");

    rerender(<FilterBar search={search({ activeCount: 3, colors: ["W"] })} />);

    expect(screen.getByRole("button", { name: "Show filters — 3 active" })).toHaveTextContent("3");
  });

  it("says whether it is open, and shuts again on a second press", async () => {
    render(<FilterBar search={search()} />);

    const toggle = screen.getByRole("button", { name: /^Show filters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /^Hide filters/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: /^Hide filters/ }));
    expect(screen.queryByRole("button", { name: "Format" })).toBeNull();
  });
});

/**
 * The tray as a **sheet** below the phone width — 9c's Task 1.
 *
 * Measured on the device on 2026-08-29 (OnePlus, Chrome 152, portrait): the shut bar is 381px of
 * a 545px content box and the wall gets 99, which is 0.42 of a tile row; the *open* tray is
 * **922px**, four times the room there is. So on a phone the tray stops being a panel in the flow
 * and becomes a `Dialog` — `src/CLAUDE.md`'s shape for a surface that is *consulted* rather than
 * worked out of.
 *
 * **Every case here states a width, because none of them can measure one.** jsdom's `matchMedia`
 * never matches (`src/test-setup.ts`), which is what silently puts every other case in this file
 * in the desktop shape; `stubNarrowWindow` is how a case says otherwise. And jsdom applies no
 * container query and loads no stylesheet, so nothing below is about a pixel — these are
 * assertions about **which box a control is in**, which is the half of this change the suite can
 * actually referee.
 */
describe("FilterBar, its tray as a sheet", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Walk up to the nearest `@container/fb` box, by `classList` rather than by `closest()`.
   *
   * `@` and `/` are both characters a CSS selector has to escape, and a mis-escaped selector
   * matches nothing and *raises nothing* — it reads exactly like the ancestor being absent, which
   * is the very thing these cases exist to tell apart. `classList.contains` takes the literal
   * token and cannot be got wrong.
   */
  const containerBox = (el: Element): HTMLElement | null => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      if (node.classList.contains("@container/fb")) return node as HTMLElement;
    }
    return null;
  };

  /** The tray panel itself, found the way assistive tech finds it: through the button's own
   *  `aria-controls`. */
  const trayPanel = (toggle: HTMLElement) =>
    document.getElementById(toggle.getAttribute("aria-controls")!);

  it("puts the tray's controls inside a dialog below the phone width", async () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);

    // Nothing is mounted until it is asked for — a sheet is a `Dialog`, and a closed `Dialog`
    // renders no panel at all.
    expect(screen.queryByRole("dialog")).toBeNull();

    const toggle = await openTray();
    const sheet = screen.getByRole("dialog");

    expect(within(sheet).getByRole("button", { name: "Format" })).toBeInTheDocument();
    expect(within(sheet).getByTestId("set-combobox")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /^Owned\b/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /^Rare cards\b/ })).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Lowest price")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "All printings" })).toBeInTheDocument();

    // The panel the button names is the one in the sheet, not a second copy left in the flow —
    // two mounted trays would be two tab stops and two accessible names per filter.
    const panel = trayPanel(toggle);
    expect(panel).not.toBeNull();
    expect(sheet).toContainElement(panel);
    expect(screen.getAllByRole("button", { name: "Format" })).toHaveLength(1);
  });

  /**
   * **The half that guards the other four surfaces**, and the one this task's mutation step
   * removes the gate to see fail. `FilterBar` is the one filter row for the search page, the Tags
   * page, both tabs of the deck editor's docked panel, the collection and the wishlist — four of
   * which have no phone in them. A sheet reaching a 1500px bar would take every control on it
   * behind a modal nobody asked for, and every existing case in this file would still pass:
   * `screen.getByRole` searches the whole document, so a control in a dialog is a control it
   * finds. **The absence of the dialog is therefore the assertion**, not the presence of the
   * controls.
   */
  it("leaves the tray in the flow at every other width", async () => {
    stubNarrowWindow(false);
    render(<FilterBar search={search()} />);

    const toggle = await openTray();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Format" })).toBeInTheDocument();
    expect(trayPanel(toggle)).not.toBeNull();
  });

  /**
   * **The trap that has no other witness.** A container query resolves against the nearest
   * ancestor carrying `container-type`, and a `Dialog` panel is not inside the bar's
   * `@container/fb` box — so moving the tray into the sheet without giving the sheet a container
   * of its own would leave four rules inside `FilterTray` with nothing to resolve against: the
   * cell grid's one-to-two-to-three columns at 640 and 900, and the rarity and condition chips'
   * grid-to-flow at 640. They would fall to their base arrangement **silently** — no error, no
   * warning, and jsdom applies no container query, so not a red test either.
   *
   * What jsdom *can* see is an ancestor's class. That is the whole of what this pins, and it is
   * enough: the query cannot be evaluated here, but the box it would be evaluated against can be
   * shown to exist.
   */
  it("keeps the tray inside a named container box in both places", async () => {
    stubNarrowWindow(true);
    const { unmount } = render(<FilterBar search={search()} />);

    const sheetPanel = trayPanel(await openTray())!;
    const sheetContainer = containerBox(sheetPanel);
    expect(sheetContainer).not.toBeNull();
    // The sheet's own, not the bar's — a `Dialog` panel is nowhere near the bar's box, so an
    // ancestor found here has to be one the sheet brought with it.
    expect(screen.getByRole("dialog")).toContainElement(sheetContainer);

    unmount();
    stubNarrowWindow(false);
    render(<FilterBar search={search()} />);

    expect(containerBox(trayPanel(await openTray())!)).not.toBeNull();
  });

  /**
   * **The scrim is `fixed inset-0` and carries no correction of its own**, unlike the dropdowns —
   * whose `usePopupPlacement` measures a zero-size frame precisely so it can subtract whatever
   * containing block it landed in. `container-type: inline-size` applies layout containment, and
   * a layout-contained box is the containing block for every `fixed` descendant under it: a sheet
   * mounted inside the bar would stretch to the *bar's* box rather than to the window, and would
   * scrim the filter row it came out of instead of the view behind it.
   *
   * **jsdom computes no containment and would report this as working.** The structure is what
   * can be asserted, so the structure is what is asserted.
   */
  it("mounts the sheet outside the bar's own container box", async () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);
    await openTray();

    const sheet = screen.getByRole("dialog");
    // The bar's box is the one holding the search field; the sheet must not be inside it.
    const bar = containerBox(screen.getByPlaceholderText("Search cards…"))!;
    expect(bar).not.toBeNull();
    expect(bar).not.toContainElement(sheet);
  });

  /** The way out is the shell's, so it is worth one case that the shell is really carrying it:
   *  Escape closes the sheet, and the bar's own button reads shut again afterwards. */
  it("closes the sheet on Escape and says so on the bar", async () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);
    await openTray();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^Show filters/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

/**
 * **The strip — the search box, one `Filters` button, and nothing else below the phone width.**
 *
 * Measured on the device on 2026-08-29 (OnePlus, Chrome 152, portrait): the shut bar was **381px
 * of a 545px content box** and the wall got **99**, which is 0.42 of a tile row — a reader saw no
 * whole card. With everything else in the sheet the bar is **44** and the wall gets **436**:
 * **1.84** rows at the shipped 237px row, so two whole cards and most of the next two. ⚠️ It is
 * deliberately **not** two rows, which would need 474.
 *
 * **Not one of those numbers was taken here and not one of them can be checked here.** jsdom has
 * no layout engine, applies no container query and loads no stylesheet, so every case below is
 * about *which box a control is in* or *which class it carries*. The pixels came from the phone
 * and go back to it.
 */
describe("FilterBar, its strip", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The box the search field is drawn in — the strip below the phone width, the bar's own wrapped
   * row above it.
   *
   * Reached through the field rather than through a test id, because the field is one of the two
   * controls that *are* the strip: a strip that had lost it fails here as a missing element rather
   * than as a missing attribute on a box that should not have existed.
   */
  const fieldBox = () => screen.getByPlaceholderText("Search cards…").parentElement!;

  /**
   * Everything the strip sheds, each by the name a reader would address it with — and as an
   * object, so a failure names the control rather than printing a wall of markup.
   */
  const shed = () => ({
    colours: screen.queryByRole("group", { name: "Color identity" }),
    manaValues: screen.queryByRole("group", { name: "Mana value" }),
    layout: screen.queryByRole("group", { name: "Result layout" }),
    sort: screen.queryByRole("button", { name: "Sort results" }),
    sortDirection: screen.queryByRole("button", { name: /^Sort direction/ }),
    resetAll: screen.queryByRole("button", { name: /^Reset all/ }),
    flatten: screen.queryByRole("button", { name: "Flatten" }),
  });

  const namesOf = (keep: (el: HTMLElement | null) => boolean) =>
    Object.entries(shed())
      .filter(([, el]) => keep(el))
      .map(([name]) => name);

  /**
   * **`queryBy*` searches the whole document, not the strip** — which is what makes this the
   * assertion rather than a `within(strip)` sweep: a control that had merely moved somewhere else
   * on the page would still be found. With the sheet shut there is nowhere else for one to be.
   *
   * `flatten` is passed, or two of the seven would be absent for the ordinary reason that nothing
   * asked for them and the case would pass on a bar that never drew them.
   */
  it("leaves the search box and Filters on the bar below the phone width, and nothing else", () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} flatten={{ pressed: false, onToggle: vi.fn() }} />);

    expect(screen.getByLabelText("Search cards")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Show filters/ })).toBeInTheDocument();
    expect(namesOf((el) => el !== null)).toEqual([]);
  });

  /**
   * The other half: shed is not lost. Every control is in the sheet, **and there is exactly one of
   * each** — the arrangement is `order` and a `basis-full` break rather than a copy per place
   * precisely because two mounted copies are two tab stops and two accessible names per filter.
   */
  it("hands every one of them to the sheet, one copy of each", async () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} flatten={{ pressed: false, onToggle: vi.fn() }} />);

    await openTray();
    const sheet = screen.getByRole("dialog");

    expect(namesOf((el) => el === null)).toEqual([]);
    for (const control of Object.values(shed())) expect(sheet).toContainElement(control);

    expect(screen.getAllByRole("group", { name: "Color identity" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Sort results" })).toHaveLength(1);
    // And the two that stay stayed: the strip is what the reader presses to get back here.
    expect(sheet).not.toContainElement(screen.getByLabelText("Search cards"));
    expect(sheet).not.toContainElement(screen.getByRole("button", { name: /^Hide filters/ }));
  });

  /**
   * **The half that guards the other four surfaces.** This row is the search page's bar, the Tags
   * page's, both tabs of the deck editor's docked panel, the collection's and the wishlist's —
   * and four of those have no phone in them. A strip reaching a 1500px bar would take ten controls
   * off it and put them behind a disclosure nobody asked for.
   */
  it("keeps every control on the bar at every other width", () => {
    stubNarrowWindow(false);
    render(<FilterBar search={search()} flatten={{ pressed: false, onToggle: vi.fn() }} />);

    expect(namesOf((el) => el === null)).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // One box holding the field *and* the colours, which is the row rather than the strip — and
    // nothing about it is pinned. The class check is what would catch a strip whose gate leaked
    // while its contents happened to look right.
    expect(fieldBox()).toContainElement(screen.getByRole("group", { name: "Color identity" }));
    expect(fieldBox().classList.contains("sticky")).toBe(false);
  });

  /**
   * **The pin, as classes — because there is nothing else about it a test here can see.**
   *
   * `position: sticky` resolves against the **scroller's padding box**, and the scroller is
   * `AppShell`'s `main`: `relative min-h-0 flex-1 overflow-auto p-5`. A strip pinned there sits
   * flush against the top of that padding box, 20px above where the content begins at rest — so
   * without `-mx-5 px-5` the wall would scroll through the 20px columns either side. `bg-bg` is
   * the other half of the same requirement: a translucent strip is one the wall is legible
   * through.
   *
   * **`-mt-5 pt-5` is deliberately absent, and its absence is the assertion.** The vertical bleed
   * is the horizontal one's twin and it is *not* symmetric in cost: `-mx-5` paints `bg-bg` over
   * `main`'s own `bg-bg` gutters and is invisible at rest, while `-mt-5` reaches 20px up and
   * paints over whatever is above. On three of the four pages that carry this bar something is —
   * `TagChips` at `gap-3`, the collection's summary header and the wishlist's `FigureRow` at
   * `gap-4` — so it would eat the last 8px, 4px and 4px of those boxes. **And the pin cannot
   * engage in this layout at all**: every page is `flex h-full flex-col`, so a section exactly
   * fills `main` and `main` never scrolls. A cost with no matching benefit, so it is out until
   * something makes `main` scroll — and it goes back in that commit, not before.
   *
   * **jsdom has no layout engine and applies no stylesheet**, so a strip missing any of this
   * would be reported as working by every other case in this file. The numbers above were
   * measured on the device on 2026-08-29 and the classes are what stands in for them here.
   */
  it("pins the strip against the scroller's padding box, opaquely", () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);

    const { classList } = fieldBox();
    const wanted = ["sticky", "top-0", "-mx-5", "px-5", "bg-bg"];
    expect(wanted.filter((cls) => !classList.contains(cls))).toEqual([]);
    // The vertical bleed, pinned as absent for the reason above. Asserting the negative is the
    // only way this decision survives somebody "completing the set" from the horizontal pair.
    expect(classList.contains("-mt-5")).toBe(false);
  });

  /**
   * **The rung, and it has to come from `LAYER`.**
   *
   * `src/lib/layers.ts` names `header` for exactly this pairing — a sticky header against the
   * content scrolling under it — and its own doc's example is a table header against this filter
   * bar. `layers.test.ts` sweeps `src/` for a literal `z-` class, so a bare number would be caught
   * there; **a rung dropped outright would not be**, because a missing class is not a class the
   * sweep can see. This is the case that catches that one.
   */
  it("draws the strip at the layer scale's header rung", () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);

    expect(fieldBox().classList.contains(LAYER.header)).toBe(true);
  });

  /**
   * **44 is where the strip's height comes from, and neither control says so at its own site.**
   *
   * Both are built on `FILTER_SHAPE` — module-private to `@/components/FilterChips`, pinned by
   * that file's own suite — whose `coarse:min-h-[var(--target-min)]` is the floor a finger gets
   * and a pointer does not. The class is spelled out here because the constant cannot be
   * imported; what this case is about is that **both** of the two controls left on the bar carry
   * it, since between them they are the whole of the strip's height.
   */
  it("keeps both of the strip's controls at the finger's floor", () => {
    stubNarrowWindow(true);
    render(<FilterBar search={search()} />);

    const floor = "coarse:min-h-[var(--target-min)]";
    expect(screen.getByLabelText("Search cards").classList.contains(floor)).toBe(true);
    expect(
      screen.getByRole("button", { name: /^Show filters/ }).classList.contains(floor),
    ).toBe(true);
  });
});

describe("FilterBar, its rarity chips", () => {
  /**
   * Common through mythic, and **not alphabetical** — the order is the information, the way Near
   * Mint through Damaged is on the collection's condition chips. `sortOptions`' second kind of
   * exemption, and the one place on this row it applies.
   */
  it("offers the four rarities in the order a card is printed at them", async () => {
    render(<FilterBar search={search()} />);
    await openTray();

    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((n): n is string => !!n && n.endsWith(" cards"));
    expect(names).toEqual([
      "Common cards",
      "Uncommon cards",
      "Rare cards",
      "Mythic cards",
    ]);
  });

  it("shows which rarities are on, and toggles one", async () => {
    const toggleRarity = vi.fn();
    render(<FilterBar search={search({ rarities: ["rare"], toggleRarity })} />);
    await openTray();

    expect(screen.getByRole("button", { name: /^Rare\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Mythic\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: /^Mythic\b/ }));

    expect(toggleRarity).toHaveBeenCalledWith("mythic");
  });

  /**
   * The row's one greying rule, one dimension further along: greyed means "turning this on would
   * not change the result set". `aria-disabled` and never the attribute, so the chip keeps its tab
   * stop and a reader sweeping the tray still hears the option and its count.
   */
  it("greys a rarity nothing in this search is printed at, and keeps it reachable", async () => {
    const toggleRarity = vi.fn();
    render(
      <FilterBar
        search={search({ toggleRarity, facets: facets({ rarities: { ...ALL_RARITIES, mythic: 0 } }) })}
      />,
    );
    await openTray();

    const mythic = screen.getByRole("button", { name: "Mythic — nothing in this search" });
    expect(mythic).toHaveAttribute("aria-disabled", "true");
    expect(mythic).not.toBeDisabled();

    await userEvent.click(mythic);
    expect(toggleRarity).not.toHaveBeenCalled();
  });

  /** A selected option is never greyed — that is the way out of a dead end (`facets.ts`). */
  it("never greys a rarity that is switched on", async () => {
    render(
      <FilterBar
        search={search({
          rarities: ["mythic"],
          facets: facets({ rarities: { ...ALL_RARITIES, mythic: 0 } }),
        })}
      />,
    );
    await openTray();

    expect(screen.getByRole("button", { name: /^Mythic\b/ })).not.toHaveAttribute("aria-disabled");
  });
});

/**
 * The chips under the rule — the search, said in words.
 *
 * This is what the tray is paid for. Four of the six filters behind it have no control on screen
 * at all once it is shut, so without these a reader could be looking at a narrowed wall with
 * nothing to say why.
 */
describe("FilterBar, the filters it states", () => {
  it("says nothing at all when nothing is filtered", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByText("Filtering by")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    // The rule and Reset all stay, because that button is drawn on every row and greyed at zero.
    expect(screen.getByRole("button", { name: /^Reset all/ })).toBeInTheDocument();
  });

  /**
   * **One chip per *kind*, and the same kinds `activeFilterCount` counts.** Three colours are one
   * chip, because the number on Reset all and the number of chips under the bar have to be the
   * same number — a reader looking at `Reset all 3` over six chips has been told two different
   * things about one search.
   */
  it("states each kind once, in the reader's words rather than the payload's", async () => {
    render(
      <FilterBar
        search={search({
          colors: ["U", "R"],
          manaValues: [2, 8],
          manaX: true,
          sets: ["lea", "dom"],
          format: "commander",
          rarities: ["rare", "mythic"],
          owned: false,
          priceMin: 2,
          priceMax: 40,
        })}
      />,
    );

    expect(screen.getByText("Filtering by")).toBeInTheDocument();
    expect(chipLabels()).toEqual([
      // WUBRG order and the colours' own names — `Colour: U, R` is the payload, and the payload
      // is not what the reader pressed.
      "Colour: Blue, Red",
      // One chip for the whole OR group, X included: it is one entry in the count for the same
      // reason it is one question on the row.
      "Mana value: 2, 8+, X",
      // Upper-cased and sorted, which is how a set code is printed on the card.
      "Set: DOM, LEA",
      "Format: Commander",
      "Rarity: Rare, Mythic",
      "Missing",
      "Price: $2.00 – $40.00",
    ]);
  });

  /**
   * `Any card` is not a format — it is the corpus the search is drawn from — so its chip may not
   * read `Format: Any card`, which would state a format filter that is not on.
   */
  it("calls the widening row what it is", () => {
    render(<FilterBar search={search({ format: ANY_CARD })} />);

    expect(chipLabels()).toEqual(["Showing: Any card"]);
  });

  /** Half a band is a sentence, never a range with a hole in it. */
  it("says a one-ended price band in words", () => {
    const { rerender } = render(<FilterBar search={search({ priceMin: 5 })} />);
    expect(chipLabels()).toEqual(["Price: from $5.00"]);

    rerender(<FilterBar search={search({ priceMax: 5 })} />);
    expect(chipLabels()).toEqual(["Price: up to $5.00"]);
  });

  /** The marketplace's own money, never a bare dollar sign. */
  it("prices the band where the view prices everything else", () => {
    render(
      <FilterBar
        search={search({
          priceMin: 5,
          marketplace: { id: "cardmarket", label: "Cardmarket", currency: "eur", feed: false },
        })}
      />,
    );

    expect(chipLabels()).toEqual(["Price: from €5.00"]);
  });

  /**
   * Pressing a chip takes its **whole kind** off, which is what makes it the exact inverse of the
   * count: one press, one fewer on the badge.
   */
  it("clears a whole kind when its chip is pressed", async () => {
    const toggleColor = vi.fn();
    const toggleManaValue = vi.fn();
    const toggleManaX = vi.fn();
    const setPriceRange = vi.fn();
    render(
      <FilterBar
        search={search({
          colors: ["U", "R"],
          toggleColor,
          manaValues: [2, 8],
          manaX: true,
          toggleManaValue,
          toggleManaX,
          priceMin: 2,
          setPriceRange,
        })}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Colour: Blue, Red" }),
    );
    expect(toggleColor.mock.calls.map(([c]) => c)).toEqual(["U", "R"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Mana value: 2, 8+, X" }),
    );
    expect(toggleManaValue.mock.calls.map(([v]) => v)).toEqual([2, 8]);
    expect(toggleManaX).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Remove filter — Price: from $2.00" }));
    expect(setPriceRange).toHaveBeenCalledWith(undefined, undefined);
  });
});

/**
 * Two buttons rather than the one cycling chip the bar used to carry.
 *
 * A chip in a row has space for one word, so it cycled off → Owned → Missing → off and the word on
 * it was what said which of the two questions was being asked — which meant the state the reader
 * was *not* in was invisible until they had pressed through to it. The tray has room for both.
 */
describe("FilterBar, its owned pair", () => {
  it("draws both questions, and shows which one is on", async () => {
    const setOwned = vi.fn();
    render(<FilterBar search={search({ owned: true, setOwned })} />);
    await openTray();

    expect(screen.getByRole("button", { name: /^Owned\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Missing\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    // The opposite question is one press away and does not go through "off" to get there.
    await userEvent.click(screen.getByRole("button", { name: /^Missing\b/ }));
    expect(setOwned).toHaveBeenCalledWith(false);
  });

  /** Pressing the one that is already on is how the filter comes off — the cycle's third step. */
  it("clears the filter on a second press of the same button", async () => {
    const setOwned = vi.fn();
    render(<FilterBar search={search({ owned: true, setOwned })} />);
    await openTray();

    await userEvent.click(screen.getByRole("button", { name: /^Owned\b/ }));

    expect(setOwned).toHaveBeenCalledWith(true);
  });

  /** Never greyed, whatever the counts say — the tooltip carries them instead. */
  it("counts both sides without greying either", async () => {
    render(
      <FilterBar search={search({ facets: facets({ owned: { owned: 0, missing: 40 } }) })} />,
    );
    await openTray();

    const owned = screen.getByRole("button", { name: "Owned — nothing in this search" });
    const missing = screen.getByRole("button", { name: "Missing — 40 printings" });
    expect(owned).not.toHaveAttribute("aria-disabled");
    expect(missing).not.toHaveAttribute("aria-disabled");
  });
});

/**
 * **Flatten rides this row, and it rides the half of it that is not about filtering.**
 *
 * The switch used to sit down beside the breadcrumb and the folder cards, on the argument that
 * where a reader is standing is navigation rather than a narrowing. That argument is intact and it
 * is not what decides the placement: the bar has a hairline across it, and everything past that
 * hairline — the sort, the grid-or-table pair — is a statement about how the results are *drawn*
 * rather than about which ones there are. Flatten is exactly that kind of statement, one level up:
 * how much of the *tree* is drawn. Both hooks already keep it outside their filter state and out
 * of `resetAll`, which is the same property the controls past the hairline have — so the cases
 * below are the two halves of that claim: it is next to the pair, and Reset all cannot reach it.
 *
 * The prop is `FilterBar`'s own rather than a member of `FilterSurface`, because only two of the
 * surfaces that draw this row have any filing at all. Which is why the first case is an absence.
 */
describe("FilterBar, its Flatten switch", () => {
  /**
   * **The absence is the assertion**, and it is the case that keeps this control off the surfaces
   * with no cabinet: the card search, the Tags page and the deck editor's docked panel are lists
   * of Scryfall's printings, where there is no filing to ignore and a Flatten chip would be a
   * switch that does nothing. The layout pair is asserted beside it, because a row that had failed
   * to render at all would satisfy the absence just as well.
   */
  it("draws no Flatten switch where nothing passed one", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByRole("button", { name: "Flatten" })).toBeNull();
    expect(screen.getByRole("group", { name: "Result layout" })).toBeInTheDocument();
  });

  /**
   * One press either way — there is no third state to walk — so the whole of the control is the
   * state it reports and the call it makes. `toHaveBeenCalledTimes(1)` rather than a bare
   * `toHaveBeenCalled`, because a chip that fires its handler twice per press is a switch that
   * ends a press exactly where it started and would satisfy the looser matcher.
   */
  it("reports whether the filing is being ignored, and toggles it on a press", async () => {
    const onToggle = vi.fn();
    render(<FilterBar search={search()} flatten={{ pressed: false, onToggle }} />);

    const chip = screen.getByRole("button", { name: "Flatten" });
    expect(chip).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(chip);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  /** The other half of the state, drawn: a chip whose `pressed` was hard-wired to `false` would
   *  pass the case above and lie on every flattened list. */
  it("draws the switch on when the filing is being ignored", () => {
    render(<FilterBar search={search()} flatten={{ pressed: true, onToggle: vi.fn() }} />);

    expect(screen.getByRole("button", { name: "Flatten" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * **Reset all does not reach it, which is the whole argument for where it sits.**
   *
   * Both hooks keep `flatten` outside their filter state and their `resetAll` deliberately leaves
   * it alone — clearing a search must not also drop the reader back into a filing they had stepped
   * out of. This is that rule checked at the control rather than at the hook: the press reaches
   * `resetAll` and nothing else.
   *
   * `activeCount: 3` and not the default 0, or the case is vacuous: Reset all is drawn at zero and
   * greyed, and its handler returns early on an empty count — so a bar with nothing filtered would
   * pass this while wired to call every setter on the page.
   */
  it("keeps Flatten out of Reset all", async () => {
    const onToggle = vi.fn();
    const resetAll = vi.fn();
    render(
      <FilterBar
        search={search({ activeCount: 3, colors: ["W"], resetAll })}
        flatten={{ pressed: true, onToggle }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^Reset all/ }));

    expect(resetAll).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Flatten" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * **The badge counts filters, and this is not one.** The number on Reset all and the number on
   * the Filters button are the same number and both come from the surface's own
   * `activeFilterCount` — so a switch that is on has to leave both where they were and state
   * nothing under the rule either. `Reset all — 1 filter active` over a search that narrows
   * nothing is the row telling a reader something untrue about their own list, and the chip under
   * the rule would offer to remove a filing.
   */
  it("does not count Flatten as a filter", () => {
    render(<FilterBar search={search()} flatten={{ pressed: true, onToggle: vi.fn() }} />);

    expect(screen.getByRole("button", { name: /^Reset all/ })).toHaveAccessibleName(
      "Reset all — 0 filters active",
    );
    expect(screen.getByRole("button", { name: /^Show filters/ })).toHaveAccessibleName(
      "Show filters — 0 active",
    );
    expect(chipLabels()).toEqual([]);
  });

  /**
   * **One wrapper for the switch and the pair, and this is the case the move was for.**
   *
   * The row is `flex-wrap`, so two controls that are merely adjacent in the markup are two items
   * the wrap is free to break between — and a Flatten chip on the line above the pair it was put
   * beside is precisely the arrangement this replaced. The DOM relationship is what says they
   * cannot: one parent, and the chip is the group's own previous sibling, so nothing has been
   * ordered between them either.
   *
   * **The relationship rather than the classes.** A class assertion here would be checking the
   * spelling of a wrapper instead of the fact that there is one — and jsdom applies no container
   * query and loads no stylesheet, so it could not tell a wrapper that holds at 206px from one
   * that does not. What a test can see is the tree, and the tree is what the wrapping rests on.
   */
  it("keeps the switch and the layout pair in one wrapper", () => {
    render(<FilterBar search={search()} flatten={{ pressed: false, onToggle: vi.fn() }} />);

    const chip = screen.getByRole("button", { name: "Flatten" });
    const layout = screen.getByRole("group", { name: "Result layout" });

    expect(chip.parentElement).toBe(layout.parentElement);
    expect(layout.previousElementSibling).toBe(chip);
  });
});
