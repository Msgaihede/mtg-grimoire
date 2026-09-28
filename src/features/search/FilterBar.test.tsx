import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MANA_VALUES } from "@/components/FilterChips";
import { CONDITION_LABEL, CONDITION_NOT_SET } from "@/lib/conditions";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { FacetResponse, SearchSortKey } from "@/lib/ipc";
import type { TagChip } from "@/features/tags/tagFilters";
import type { SortSpec } from "@/lib/sort";
import { openDropdown, pickOption } from "@/test-dropdown";
import type { TagToken } from "./queryLanguage";
import { FilterBar, StatedFiltersLine } from "./FilterBar";
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
    // **Required on `FilterSurface`, beside `colors`** — every surface that has colours can
    // answer it, so a stub without one is a shape no mounted surface has. `false` is the
    // unfiltered value, and the toggle it drives is the tray's `"exact"` cell, drawn whether or
    // not a colour is picked.
    colorsStrict: false,
    toggleColorsStrict: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    manaX: false,
    toggleManaX: vi.fn(),
    // The tag syntax's five members. Empty on every case here but the ones that override
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
    // The type cell's pair. Optional on `FilterSurface` and present here because `SEARCH_TRAY`
    // names the cell and `useCardSearch` answers it — the one case below that is about a surface
    // which *cannot* answer it overrides `toggleType` to `undefined` rather than leaving a hole
    // in the shape every other case shares.
    types: [] as string[],
    toggleType: vi.fn(),
    // The border and finish cells' pairs, present for the type pair's reason: `SEARCH_TRAY` names
    // both cells since issue #573 and `useCardSearch` answers both. On this surface the finish
    // chips ask what the printing was **published** in, which is why the card search stub carries
    // them at all — a case about a surface that answers neither overrides the setter to
    // `undefined`.
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
  // All eight, as a ready response always carries them — a chip greys on a counted zero and
  // stays live on an absent key, so a fixture missing one would be testing the wrong arm. They
  // do **not** sum to `total` and are not meant to: a card can be Artifact *and* Creature, and
  // the corpus holds types no chip offers.
  types: {
    Creature: 5,
    Planeswalker: 5,
    Instant: 5,
    Sorcery: 5,
    Artifact: 5,
    Enchantment: 5,
    Battle: 5,
    Land: 5,
  },
  // All three keys of each, as a ready response always carries them — the rarities' reason. Both
  // overlap rather than partition (a borderless full-art printing, a printing in nonfoil and
  // foil), so neither sums to `total`.
  borders: { regular: 5, borderless: 5, fullart: 5 },
  finishes: { nonfoil: 5, foil: 5, etched: 5 },
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
   * gated on `FilterSurface.anyCard`, which `useCardSearch` sets and — since token stacks
   * (2026-09-26), when its format started riding `formatParams` too — the deck search's
   * Collection tab (`useCollectionSearch`); the collection page and the wishlist never do.
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

  /**
   * Walk up to the nearest `@container/fb` box, by `classList` rather than by `closest()`.
   *
   * `@` and `/` are both characters a CSS selector has to escape, and a mis-escaped selector
   * matches nothing and *raises nothing* — it reads exactly like the ancestor being absent, which
   * is the very thing the case below exists to tell apart. `classList.contains` takes the literal
   * token and cannot be got wrong.
   */
  const containerBox = (el: Element): HTMLElement | null => {
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      if (node.classList.contains("@container/fb")) return node as HTMLElement;
    }
    return null;
  };

  /**
   * **The trap that has no other witness.** A container query resolves against the nearest
   * ancestor carrying `container-type`, so a tray moved out of the bar's `@container/fb` box
   * would leave four rules inside `FilterTray` with nothing to resolve against: the cell grid's
   * one-to-two-to-three columns at 640 and 900, and the rarity and condition chips' grid-to-flow
   * at 640 — which for the condition cell is a grid-to-*wrapping*-flow, since six chips do not fit
   * one line of that cell at the widths it is drawn at. They would fall to their base arrangement
   * **silently** — no error, no warning, and jsdom applies no container query, so not a red test
   * either.
   *
   * What jsdom *can* see is an ancestor's class. That is the whole of what this pins, and it is
   * enough: the query cannot be evaluated here, but the box it would be evaluated against can be
   * shown to exist — and to be the bar's own, the one holding the search box.
   */
  it("keeps the tray inside the bar's named container box", async () => {
    render(<FilterBar search={search()} />);

    // The panel found the way assistive tech finds it: through the button's own `aria-controls`.
    const toggle = await openTray();
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    const box = containerBox(panel);

    expect(box).not.toBeNull();
    expect(box).toBe(containerBox(screen.getByPlaceholderText("Search cards…")));
  });

  /**
   * **One row holds every control on the bar.** The arrangement is `order` plus a `basis-full`
   * break inside one flex container rather than a `<div>` per line, so the search box's own
   * parent is the box every other control on the bar is laid out in — and a control that had
   * been split off into a line of its own fails here by name.
   */
  it("lays every control on the bar out in the search box's own row", () => {
    render(<FilterBar search={search()} />);

    const row = screen.getByPlaceholderText("Search cards…").parentElement!;
    const onTheRow = {
      colours: screen.getByRole("group", { name: "Color identity" }),
      filters: screen.getByRole("button", { name: /^Show filters/ }),
      manaValues: screen.getByRole("group", { name: "Mana value" }),
      layout: screen.getByRole("group", { name: "Result layout" }),
      sort: screen.getByRole("button", { name: "Sort results" }),
      sortDirection: screen.getByRole("button", { name: /^Sort direction/ }),
    };
    const offTheRow = Object.entries(onTheRow)
      .filter(([, el]) => !row.contains(el))
      .map(([name]) => name);
    expect(offTheRow).toEqual([]);
  });
});

describe("FilterBar, its rarity chips", () => {
  /**
   * Common through mythic, and **not alphabetical** — the order is the information, the way Near
   * Mint through Damaged is on the collection's condition chips (which since schema v35 are led
   * by an ungraded chip that is not on that scale at all — it sits in front of it because it is
   * the *default*, not because it is a sixth grade). `sortOptions`' second kind of exemption, and
   * the one place on this row it applies.
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
 * The tray's `Exact` cell — **the reading the five colour chips on the bar get**.
 *
 * Loose is the default and the deckbuilder's question: `RW` answers mono-R, mono-W, RW and the
 * colourless cards that fit in any deck. Strict is the issue's ask said out loud — the RW cards
 * alone — and it is a *modifier* on the colour filter rather than a filter of its own, which is
 * why it is not in the badge's count and why the strip states it inside the colour chip.
 *
 * **It was a sixth chip in the colour group until 2026-09-23, drawn only while a colour was
 * picked, and most of this block used to assert when it was on screen at all.** Those cases are
 * inverted rather than deleted: the whole point of the move is that there is no longer a screen
 * on which a reader is looking for a control that is not drawn. What the old draw condition
 * bought — no dead control over an empty colour row — is bought on the wire instead now, by each
 * hook's `strictParam`, which is that hook's own suite to assert.
 */
describe("FilterBar, its Exact cell", () => {
  /** Matched on a **prefix**: the toggle's accessible name is its own `title`, which names the
   *  state as well as the label, and the sentence changes with the press. */
  const exact = () => screen.queryByRole("button", { name: /^Exact\b/ });

  /** **The bar itself draws none of it**, which is the half of the move a query over the whole
   *  document cannot see: with the tray shut there is no `Exact` anywhere, and in particular not
   *  in the colour group it used to be the sixth chip of. */
  it("is behind the disclosure and not on the bar", () => {
    render(<FilterBar search={search({ colors: ["W"] })} />);

    expect(exact()).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Color identity" })).queryByRole("button", {
        name: /^Exact\b/,
      }),
    ).toBeNull();
  });

  /** **Drawn with nothing picked at all**, which is the whole of what changed. The old chip was
   *  rendered only once a colour was picked, so a reader had to press a colour to discover the
   *  control that says what pressing a colour means. */
  it("draws the Exact toggle with no colour picked, unpressed", async () => {
    render(<FilterBar search={search()} />);
    await openTray();

    expect(exact()).toHaveAttribute("aria-pressed", "false");
  });

  /** …and pressed, over that same empty row. It filters nothing there — each hook's
   *  `strictParam` is what keeps it off the wire — but the control states what the reader set,
   *  which is what a toggle that is always on screen owes them. */
  it("draws it pressed when strict is on with no colour picked", async () => {
    render(<FilterBar search={search({ colors: [], colorsStrict: true })} />);
    await openTray();

    expect(exact()).toHaveAttribute("aria-pressed", "true");
  });

  /** Under a `Colour` caption, so the cell says what it is the reading *of*. The one word on the
   *  toggle cannot, and the chips it modifies are a disclosure away on the bar. */
  it("stands under the Colour caption", async () => {
    render(<FilterBar search={search({ colors: ["W"] })} />);
    const tray = await openTray();

    const cell = screen.getByText("Colour").parentElement!;
    expect(within(cell).getByRole("button", { name: /^Exact\b/ })).toBeInTheDocument();
    expect(tray).toBeInTheDocument();
  });

  it("presses through to the surface's own toggle", async () => {
    const toggleColorsStrict = vi.fn();
    render(<FilterBar search={search({ colors: ["W"], toggleColorsStrict })} />);
    await openTray();

    await userEvent.click(exact()!);

    expect(toggleColorsStrict).toHaveBeenCalledTimes(1);
  });

  /**
   * The two readings said in words, because the toggle is one word and the word does not say
   * which of them is on. `ToggleChip`'s `title` *is* the accessible name, so the sentence is what
   * a screen reader hears and what a pointer gets — and the visible label still leads it, which
   * is what WCAG 2.5.3 asks.
   */
  it("says which reading is on, in words, at both ends of the press", async () => {
    const { unmount } = render(<FilterBar search={search({ colors: ["W", "U"] })} />);
    await openTray();
    expect(exact()).toHaveAccessibleName(
      "Exact — cards whose colour identity fits within these colours",
    );
    unmount();

    render(<FilterBar search={search({ colors: ["W", "U"], colorsStrict: true })} />);
    await openTray();
    const on = exact()!;
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(on).toHaveAccessibleName(
      "Exact — cards whose colour identity is exactly these colours",
    );
  });

  /**
   * The strip states strict **inside the colour chip** rather than as a chip of its own.
   *
   * One chip per kind is this row's whole arithmetic — the number under the bar and the number on
   * Reset all have to be the same number — and strict is not a kind: it is which reading the
   * colour filter gets. A chip of its own would put a second entry under a badge still counting
   * one.
   */
  it("names the active colour filter as exact when strict is on", () => {
    render(
      <FilterBar search={search({ colors: ["W", "U"], colorsStrict: true, activeCount: 1 })} />,
    );

    expect(chipLabels()).toEqual(["Colour: exactly White, Blue"]);
  });

  it("leaves the word out when the colours are read loosely", () => {
    render(<FilterBar search={search({ colors: ["W", "U"], activeCount: 1 })} />);

    expect(chipLabels()).toEqual(["Colour: White, Blue"]);
  });

  /**
   * The × clears the whole kind, and the flag is part of it — **because the chip it is on names
   * the reading**. `Colour: exactly White, Blue` is what the reader is pressing, so an undo that
   * left `exactly` standing would be the statement and its own × disagreeing about what was
   * cleared.
   *
   * This is *not* the rule `toggleColorFilter` dropped on 2026-09-23, and the two are worth
   * telling apart. Unpressing the last colour chip is a press about one colour and now leaves the
   * reading alone; this is a press on a sentence with the word in it.
   */
  it("clears the strict flag along with the colours it was about", async () => {
    const toggleColor = vi.fn();
    const toggleColorsStrict = vi.fn();
    render(
      <FilterBar
        search={search({
          colors: ["W", "U"],
          colorsStrict: true,
          toggleColor,
          toggleColorsStrict,
          activeCount: 1,
        })}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Colour: exactly White, Blue" }),
    );

    expect(toggleColor.mock.calls.map(([c]) => c)).toEqual(["W", "U"]);
    expect(toggleColorsStrict).toHaveBeenCalledTimes(1);
  });

  /** …and it is not pressed on a row that was never strict, which is what keeps the × a *clear*
   *  rather than a toggle: pressing it must never turn strict on. */
  it("does not touch the flag when the colours were read loosely", async () => {
    const toggleColorsStrict = vi.fn();
    render(<FilterBar search={search({ colors: ["W"], toggleColorsStrict, activeCount: 1 })} />);

    await userEvent.click(screen.getByRole("button", { name: "Remove filter — Colour: White" }));

    expect(toggleColorsStrict).not.toHaveBeenCalled();
  });
});

/**
 * The type cell — eight chips, and the one filter on this row that is not a fact about a
 * *printing*.
 *
 * **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
 * (`Land Creature — Forest Dryad`) is under both Land and Creature here, where `autoCategory.ts`
 * files it under Land alone and `deckBuckets.ts` under Creature alone. Those two each answer
 * *one* question with one bucket; a filter answers a different question, and a reader pressing
 * Creature who could not find an artifact creature has been told a falsehood. That rule is the
 * backend's, so what this file is the authority on is which words are drawn, in which order, and
 * which of them grey.
 */
describe("FilterBar, its type chips", () => {
  /** Every type counted, so a case overriding one is overriding exactly one. */
  const ALL_TYPES = {
    Creature: 5,
    Planeswalker: 5,
    Instant: 5,
    Sorcery: 5,
    Artifact: 5,
    Enchantment: 5,
    Battle: 5,
    Land: 5,
  };

  const group = () => screen.getByRole("group", { name: "Type" });

  /**
   * A `tray` naming a cell the surface cannot answer draws **nothing** rather than a dead
   * control — `FilterSurface`'s optional half, and the rule that lets the wishlist skip the price
   * band. `SEARCH_TRAY` names `type` on every surface that takes the default, so this is the only
   * thing standing between a backend with no type filter and eight chips that do not work.
   */
  it("draws the type cell only where the surface answers it", async () => {
    render(<FilterBar search={search({ toggleType: undefined })} />);
    await openTray();

    expect(screen.queryByRole("group", { name: "Type" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Creature\b/ })).toBeNull();
  });

  /**
   * Creature first and Land last, which is how every decklist reads — `deckBuckets.ts`' order and
   * deliberately **not** `cardtypes.rs`' alphabetical bit order, which is storage and would put
   * Artifact and Battle in front of the two types a reader reaches for first.
   *
   * The whole sequence rather than a spot check: two chips swapped past each other satisfy any
   * assertion about one being present. The **text** and not the accessible name, because the name
   * carries a facet count wherever there is one — the condition cell's own matcher.
   */
  it("draws all eight type chips in reading order", async () => {
    render(<FilterBar search={search()} />);
    await openTray();

    expect(
      within(group())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "Creature",
      "Planeswalker",
      "Instant",
      "Sorcery",
      "Artifact",
      "Enchantment",
      "Battle",
      "Land",
    ]);
  });

  it("shows which types are on, and toggles one", async () => {
    const toggleType = vi.fn();
    render(<FilterBar search={search({ types: ["Land"], toggleType })} />);
    await openTray();

    expect(screen.getByRole("button", { name: /^Land\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Creature\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: /^Creature\b/ }));

    // The word and not a key: `picked_types` matches `TYPE_KEYS` exactly and drops anything it
    // does not recognise, so a chip sending a different spelling filters nothing and nothing
    // anywhere goes red for it.
    expect(toggleType).toHaveBeenCalledWith("Creature");
  });

  /**
   * The row's one greying rule, one dimension further along. `aria-disabled` and never the
   * attribute, so the chip keeps its tab stop and a reader sweeping the tray still hears the
   * option and its count — and **the name carries the reason**, which is what a `getByRole` on
   * the bare word would miss.
   */
  it("greys a type nothing in this search has, and keeps it reachable", async () => {
    const toggleType = vi.fn();
    render(
      <FilterBar
        search={search({ toggleType, facets: facets({ types: { ...ALL_TYPES, Battle: 0 } }) })}
      />,
    );
    await openTray();

    const battle = screen.getByRole("button", { name: "Battle — nothing in this search" });
    expect(battle).toHaveAttribute("aria-disabled", "true");
    expect(battle).not.toBeDisabled();

    await userEvent.click(battle);
    expect(toggleType).not.toHaveBeenCalled();
  });

  /** A selected option is never greyed — that is the way out of a dead end (`facets.ts`), and the
   *  rarity cell's own arm read over this map. */
  it("never greys a type that is switched on", async () => {
    render(
      <FilterBar
        search={search({
          types: ["Battle"],
          facets: facets({ types: { ...ALL_TYPES, Battle: 0 } }),
        })}
      />,
    );
    await openTray();

    expect(screen.getByRole("button", { name: /^Battle\b/ })).not.toHaveAttribute("aria-disabled");
  });

  /**
   * **This row and the badge are one arithmetic**, which is what makes the chip worth its place:
   * the type chips are in the tray, so with the tray shut a type filter has no control on screen
   * at all, and a `Reset all 1` over nothing under the rule would be a reader told a number with
   * no sentence behind it.
   *
   * `CARD_TYPES`' own order rather than the order they were pressed, the rarities' rule — the
   * statement reads the same however the reader got to it.
   */
  it("states the picked types as one chip, in reading order", () => {
    render(
      <FilterBar search={search({ types: ["Land", "Creature"], activeCount: 1 })} />,
    );

    expect(chipLabels()).toEqual(["Type: Creature, Land"]);
  });

  /** One press takes the whole kind off — the inverse of the count. */
  it("takes every picked type off in one press", async () => {
    const toggleType = vi.fn();
    render(
      <FilterBar search={search({ types: ["Creature", "Land"], toggleType, activeCount: 1 })} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Type: Creature, Land" }),
    );

    expect(toggleType.mock.calls.map(([t]) => t)).toEqual(["Creature", "Land"]);
  });

  /** Nothing stated where the surface cannot answer the question — the strip is gated on the
   *  setter, like every other optional kind on it. */
  it("states no type filter on a surface that has no type chips", () => {
    render(
      <FilterBar
        search={search({ types: ["Creature"], toggleType: undefined, activeCount: 0 })}
      />,
    );

    expect(chipLabels()).toEqual([]);
  });
});

/**
 * The border cell (issue #573) — three chips over the printing's frame, the type cell's shape one
 * dimension along.
 */
describe("FilterBar, its border chips", () => {
  /** Every border counted, so a case overriding one is overriding exactly one. */
  const ALL_BORDERS = { regular: 5, borderless: 5, fullart: 5 };
  const group = () => screen.getByRole("group", { name: "Border" });

  /** Absent rather than dead where the surface cannot answer it — the type cell's rule. */
  it("draws the border cell only where the surface answers it", async () => {
    render(<FilterBar search={search({ toggleBorder: undefined })} />);
    await openTray();

    expect(screen.queryByRole("group", { name: "Border" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Borderless\b/ })).toBeNull();
  });

  /**
   * The ordinary card first, then the two treatments that take the frame away — `BORDERS`' order,
   * which is `sortOptions`' order-is-the-information exemption; sorted, `Borderless` would lead.
   * The whole sequence, and the text rather than the name, which carries a facet count wherever
   * there is one.
   */
  it("draws three border chips, the ordinary card first", async () => {
    render(<FilterBar search={search()} />);
    await openTray();

    expect(
      within(group())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Regular", "Borderless", "Full art"]);
  });

  it("shows which borders are on, and toggles one by its id", async () => {
    const toggleBorder = vi.fn();
    render(<FilterBar search={search({ borders: ["fullart"], toggleBorder })} />);
    await openTray();

    expect(within(group()).getByRole("button", { name: "Full art" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group()).getByRole("button", { name: "Borderless" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(within(group()).getByRole("button", { name: "Borderless" }));

    // The id and never the label: `filters::picked_borders` drops anything it does not know, so
    // a chip sending `Borderless` would filter nothing and nothing would go red for it.
    expect(toggleBorder).toHaveBeenCalledWith("borderless");
  });

  /** `aria-disabled` and never the attribute, and the name carries the reason. */
  it("greys a border nothing in this search has, and keeps it reachable", async () => {
    const toggleBorder = vi.fn();
    render(
      <FilterBar
        search={search({
          toggleBorder,
          facets: facets({ borders: { ...ALL_BORDERS, borderless: 0 } }),
        })}
      />,
    );
    await openTray();

    const borderless = within(group()).getByRole("button", { name: /^Borderless\b/ });
    expect(borderless).toHaveAccessibleName("Borderless — nothing in this search");
    expect(borderless).toHaveAttribute("aria-disabled", "true");
    expect(borderless).not.toBeDisabled();
    const regular = within(group()).getByRole("button", { name: /^Regular\b/ });
    expect(regular).toHaveAccessibleName("Regular — 5 printings");
    expect(regular).not.toHaveAttribute("aria-disabled");

    await userEvent.click(borderless);
    expect(toggleBorder).not.toHaveBeenCalled();
  });

  /** The way out of a dead end never greys — `facets.ts`' selected arm. */
  it("never greys a border that is switched on", async () => {
    render(
      <FilterBar
        search={search({
          borders: ["borderless"],
          facets: facets({ borders: { ...ALL_BORDERS, borderless: 0 } }),
        })}
      />,
    );
    await openTray();

    expect(within(group()).getByRole("button", { name: /^Borderless\b/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  /** One chip for the kind, in `BORDERS`' order however they were pressed, in the tray's words. */
  it("states the picked borders as one chip, and takes them all off in one press", async () => {
    const toggleBorder = vi.fn();
    render(
      <FilterBar
        search={search({ borders: ["fullart", "regular"], toggleBorder, activeCount: 1 })}
      />,
    );

    expect(chipLabels()).toEqual(["Border: Regular, Full art"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Border: Regular, Full art" }),
    );
    expect(toggleBorder.mock.calls.map(([b]) => b)).toEqual(["fullart", "regular"]);
  });

  /** Gated on the setter, like every other optional kind on the strip. */
  it("states no border filter on a surface that has no border chips", () => {
    render(
      <FilterBar
        search={search({ borders: ["regular"], toggleBorder: undefined, activeCount: 0 })}
      />,
    );

    expect(chipLabels()).toEqual([]);
  });
});

/**
 * The finish cell on the **card search** (issue #573), where it asks what the printing was
 * published in. It was absent from this surface until then; the collection's own suite covers the
 * copy's reading, which draws the same cell with `facets` undefined.
 */
describe("FilterBar, its finish chips", () => {
  /** Every finish counted, so a case overriding one is overriding exactly one. */
  const ALL_FINISHES = { nonfoil: 5, foil: 5, etched: 5 };
  const group = () => screen.getByRole("group", { name: "Finish" });

  it("draws the finish cell on the card search, and toggles a finish by its id", async () => {
    const toggleFinish = vi.fn();
    render(<FilterBar search={search({ finishes: ["foil"], toggleFinish })} />);
    await openTray();

    expect(
      within(group())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Nonfoil", "Foil", "Etched"]);
    expect(within(group()).getByRole("button", { name: "Foil" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(within(group()).getByRole("button", { name: "Etched" }));
    expect(toggleFinish).toHaveBeenCalledWith("etched");
  });

  it("draws no finish cell where the surface does not answer it", async () => {
    render(<FilterBar search={search({ toggleFinish: undefined })} />);
    await openTray();

    expect(screen.queryByRole("group", { name: "Finish" })).toBeNull();
  });

  /** Counted as printings published in each finish, and greyed on a counted zero. */
  it("greys a finish nothing in this search was published in, but never a pressed one", async () => {
    const toggleFinish = vi.fn();
    const zeroEtched = facets({ finishes: { ...ALL_FINISHES, etched: 0 } });
    const { rerender } = render(
      <FilterBar search={search({ toggleFinish, facets: zeroEtched })} />,
    );
    await openTray();

    const etched = within(group()).getByRole("button", { name: /^Etched\b/ });
    expect(etched).toHaveAccessibleName("Etched — nothing in this search");
    expect(etched).toHaveAttribute("aria-disabled", "true");
    const foil = within(group()).getByRole("button", { name: /^Foil\b/ });
    expect(foil).toHaveAccessibleName("Foil — 5 printings");
    expect(foil).not.toHaveAttribute("aria-disabled");
    await userEvent.click(etched);
    expect(toggleFinish).not.toHaveBeenCalled();

    rerender(
      <FilterBar search={search({ finishes: ["etched"], toggleFinish, facets: zeroEtched })} />,
    );
    expect(within(group()).getByRole("button", { name: /^Etched\b/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  /**
   * A copy surface has no facet command and hands `facets` over as `undefined`, so every chip is
   * live and carries its plain word — `facets.ts`' fail-open arm, which is what keeps a copy's
   * question from being greyed by a printing's count.
   */
  it("stays live with its plain words where there are no facets", async () => {
    render(<FilterBar search={search({ facets: undefined })} tray={["finish"]} />);
    await openTray();

    for (const name of ["Nonfoil", "Foil", "Etched"]) {
      const chip = within(group()).getByRole("button", { name: new RegExp(`^${name}\\b`) });
      expect(chip).toHaveAccessibleName(name);
      expect(chip).not.toHaveAttribute("aria-disabled");
    }
  });

  it("states the picked finishes as one chip, in the tray's order", () => {
    render(<FilterBar search={search({ finishes: ["etched", "foil"], activeCount: 1 })} />);

    expect(chipLabels()).toEqual(["Finish: Foil, Etched"]);
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
    // No line under the bar at all — but Reset all stays, on the bar, greyed at zero.
    expect(screen.getByRole("button", { name: /^Reset all/ })).toBeInTheDocument();
  });

  /**
   * **Reset all is on the bar, in the same row as the box, and not on the line of chips** (the
   * header redesign, 2026-09-27). That line used to be drawn unconditionally for this button's
   * sake alone; with the button on the bar, the line can come and go with the chips without
   * anything beside a pressed control moving. Both halves are asserted, because a Reset all
   * mounted in both places would pass either one alone.
   */
  it("keeps Reset all on the bar's own row, never on the line of chips", () => {
    render(<FilterBar search={search({ colors: ["U"], rarities: ["rare"], activeCount: 2 })} />);

    const reset = screen.getByRole("button", { name: /^Reset all/ });
    const row = screen.getByLabelText("Search cards").parentElement!;
    expect(row).toContainElement(reset);
    expect(screen.getByText("Filtering by").parentElement).not.toContainElement(reset);
    expect(screen.getAllByRole("button", { name: /^Reset all/ })).toHaveLength(1);
  });

  /**
   * **`statesFilters={false}` hands the chips to the page** — the collection and the wishlist draw
   * them in their path row with `StatedFiltersLine`, so the bar must draw none of its own or the
   * page would state every filter twice.
   */
  it("draws no line of chips when the page states them itself", () => {
    render(
      <FilterBar
        search={search({ colors: ["U"], rarities: ["rare"], activeCount: 2 })}
        statesFilters={false}
      />,
    );

    expect(screen.queryByText("Filtering by")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
    // Reset all is the bar's, not the line's, so it stays.
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

  /**
   * **A wrapped block under the bar, and never a line of the bar's own row.** An appearing chip
   * under the bar moves only the wall, where on the row it would take its width out of a `flex-1`
   * search box and slide nine colour chips left under the finger that had just pressed one. The
   * chips wrap onto further lines as they grow rather than running out of the box. `Reset all` is
   * the other way round since 2026-09-27 — on the row, drawn from the first paint so it never
   * appears — and "keeps Reset all on the bar's own row", in this block, pins that half.
   */
  it("wraps the chips in a block of their own, off the bar's row", () => {
    render(<FilterBar search={search({ colors: ["U", "R"], activeCount: 1 })} />);

    const block = screen.getByRole("button", {
      name: "Remove filter — Colour: Blue, Red",
    }).parentElement!;
    expect(block.classList.contains("flex-wrap")).toBe(true);

    const row = screen.getByPlaceholderText("Search cards…").parentElement!;
    expect(row).not.toContainElement(block);
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
 * **There is no Flatten switch on any surface** (folder-shelves spec, decision 2): the collection
 * and the wishlist are drawn as shelves, and the chip that ignored the filing went with the band it
 * was the escape from. The layout pair is asserted beside the absence, because a row that failed
 * to render at all would satisfy the absence just as well.
 */
describe("FilterBar, after Flatten", () => {
  it("draws no Flatten switch, and keeps the layout pair past the hairline", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByRole("button", { name: "Flatten" })).toBeNull();
    expect(screen.getByRole("group", { name: "Result layout" })).toBeInTheDocument();
  });
});

/**
 * The condition cell, and the one chip in it that is not an abbreviation.
 *
 * **This cell had no case in this file at all until schema v35**, which is why it could ship
 * drawing a chip that read `NONE`: `SEARCH_TRAY` does not list `condition` — the card search is
 * over every printing Scryfall has published, and a printing has no grade — so every case above
 * renders a bar this cell is not on. It reaches a reader through the collection's and the
 * wishlist's own trays, whose page suites assert what those pages do with the *filter* rather
 * than what this row draws for it.
 *
 * So the stub below opts in explicitly, on both halves: `tray` names the cell, and `conditions` /
 * `toggleCondition` are what `FilterSurface` reads to decide the control exists at all — a tray
 * naming a cell the surface cannot answer draws nothing rather than a dead control, which is the
 * rule that lets the wishlist skip the price band.
 */
describe("FilterBar, its condition chips", () => {
  const withConditions = (over: Record<string, unknown> = {}) =>
    search({ conditions: [] as string[], toggleCondition: vi.fn(), ...over });

  /**
   * Five grades are drawn as the code and *spoken* as the word — `ToggleChip`'s `hint`, and the
   * argument is that `NM`/`LP`/`MP`/`HP`/`DMG` are what every marketplace listing prints, while
   * five spelled-out grades are 400px of chrome above the table they filter.
   *
   * **The sixth is not an abbreviation of anything.** No listing prints `NONE`; a reader has
   * never seen those four letters, so expanding them into a phrase would be explaining a code
   * they were never shown. It takes the plain treatment the first paragraph of `ToggleChip`'s doc
   * describes as the default — the label spelled out, no `hint` — and the storage token never
   * reaches the page.
   */
  it("spells out the grade that abbreviates nothing, and abbreviates the five that do not", async () => {
    render(<FilterBar search={withConditions()} tray={["condition"]} />);
    await openTray();

    const group = screen.getByRole("group", { name: "Condition" });
    const notSet = within(group).getByRole("button", { name: CONDITION_LABEL.NONE });

    // The visible text *is* the accessible name here, which is what says no `hint` was passed:
    // a hinted chip carries its expansion in an `aria-label`, as the `NM` chip below does.
    expect(notSet).not.toHaveAttribute("aria-label");
    expect(within(group).getByRole("button", { name: "NM, near mint" })).toBeInTheDocument();
    expect(group).not.toHaveTextContent(CONDITION_NOT_SET);
  });

  /**
   * The default leads the scale it is not a member of — `CONDITIONS`' own order, and the reason
   * is that a default a reader has to scroll past five grades to find is a default in name only.
   * The database ranks it the other way (`NM 0 … DMG 4, NONE 5`) because a sorted column is the
   * scale read *as* a scale; neither order is derived from the other.
   */
  it("offers the ungraded chip first and the scale behind it", async () => {
    render(<FilterBar search={withConditions()} tray={["condition"]} />);
    await openTray();

    const names = within(screen.getByRole("group", { name: "Condition" }))
      .getAllByRole("button")
      .map((b) => b.textContent);

    expect(names).toEqual([CONDITION_LABEL.NONE, "NM", "LP", "MP", "HP", "DMG"]);
  });

  /**
   * The summary chip under the bar reads the same words as the control that made it.
   *
   * It joined **raw storage codes** before this cell had a sixth value, which was invisible while
   * every code was also a word a reader recognises. `Condition: Not set, LP` is the whole of what
   * `conditionChip` being shared between the two sites buys — the tray and this row cannot come
   * to disagree, because there is one function deciding.
   */
  it("names the picked grades in the chip the way the tray named them", () => {
    render(
      <FilterBar
        search={withConditions({ conditions: [CONDITION_NOT_SET, "LP"] })}
        tray={["condition"]}
      />,
    );

    expect(chipLabels()).toEqual([`Condition: ${CONDITION_LABEL.NONE}, LP`]);
  });
});

/**
 * **The chips a page places itself** — the collection's and the wishlist's path row (2026-09-27).
 * The row is a fixed height, so the line has to scroll rather than wrap.
 */
describe("StatedFiltersLine", () => {
  it("states each filter kind as a removable chip, on one scrolling line", async () => {
    const toggleColor = vi.fn();
    render(
      <StatedFiltersLine
        search={search({ colors: ["U"], rarities: ["rare"], activeCount: 2, toggleColor })}
      />,
    );

    expect(screen.getByText("Filtering by")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Remove filter — Colour: Blue" });
    expect(screen.getByRole("button", { name: /^Remove filter — Rarity/ })).toBeInTheDocument();
    const { classList } = chip.parentElement!;
    expect(classList.contains("overflow-x-auto")).toBe(true);
    expect(classList.contains("flex-wrap")).toBe(false);

    await userEvent.click(chip);
    expect(toggleColor).toHaveBeenCalledWith("U");
  });

  it("draws nothing while nothing is filtered", () => {
    const { container } = render(<StatedFiltersLine search={search()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
