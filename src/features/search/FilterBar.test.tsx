import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MANA_VALUES } from "@/components/FilterChips";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { FacetResponse, SearchSortKey } from "@/lib/ipc";
import type { TagChip } from "@/features/tags/tagFilters";
import type { SortSpec } from "@/lib/sort";
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
    ...over,
  }) as unknown as Parameters<typeof FilterBar>[0]["search"];

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
    render(<FilterBar search={search({ setFormat })} />);

    const select = screen.getByLabelText("Format") as HTMLSelectElement;
    expect(select).toHaveValue("");
    expect(select.selectedOptions[0]).toHaveTextContent("Any format");
    expect(screen.queryByRole("button", { name: /unplayable/i })).toBeNull();

    await userEvent.selectOptions(select, ANY_CARD);

    expect(setFormat).toHaveBeenCalledWith(ANY_CARD);
  });

  /**
   * A controlled `<select>` never has its `value` assigned by React — `react-dom` walks the
   * options setting `selected`, and on no match it silently picks the first row that is not
   * disabled. Both halves are asserted because they fail differently, and `getByRole` would
   * catch neither: a present-but-unselected option passes it.
   */
  it("shows Any card as picked when it is", () => {
    render(<FilterBar search={search({ format: ANY_CARD })} />);

    const select = screen.getByLabelText("Format") as HTMLSelectElement;
    expect(select).toHaveValue(ANY_CARD);
    expect(select.selectedOptions[0]).toHaveTextContent("Any card");
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
  sets: { lea: 5 },
  owned: { owned: 3, missing: 37 },
  total: 40,
  ready: true,
  ...over,
});

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
  it("leaves every control live while the index is still building", () => {
    render(<FilterBar search={search()} />);

    for (const name of [/^Mana value 7\b/, /^Cards with X\b/, /^White\b/, /^Owned\b/]) {
      expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
    }
    expect(screen.getByRole("option", { name: "Modern" })).not.toBeDisabled();
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

  /** Native `<option disabled>` — the one place a real `disabled` is right, because a listbox
   *  option is not a tab stop to lose. */
  it("greys a format nothing in this search is legal in", () => {
    render(
      <FilterBar search={search({ facets: facets({ formats: { modern: 0, legacy: 4 } }) })} />,
    );

    expect(screen.getByRole("option", { name: "Modern" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Legacy" })).not.toBeDisabled();
    // Never, either of them: they are how you get back to no format at all, and `Any card` is
    // the only row that can *widen* a search that has greyed itself into nothing.
    expect(screen.getByRole("option", { name: "Any format" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "Any card" })).not.toBeDisabled();
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
  it("counts the Owned chip without ever greying it", () => {
    const { rerender } = render(
      <FilterBar search={search({ facets: facets({ owned: { owned: 0, missing: 40 } }) })} />,
    );

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
  /** Every `<option>` the select draws, in document order. The **sequence** is the behaviour
   *  under test, so each of these asserts the whole list: two formats swapped past each other
   *  pass any assertion about one row's presence, and did.
   *
   *  Scoped to the format select rather than the document. This row has carried a second
   *  `<select>` since the sort picker landed beside it, and a bare `screen.getAllByRole` would
   *  hand every case below eight sort orders it has never heard of. */
  const formatOrder = () =>
    within(screen.getByLabelText("Format"))
      .getAllByRole("option")
      .map((o) => o.textContent);

  /**
   * A reader hunting for "Modern" hunts under M. `FORMATS` is authored in the order the formats
   * rank, which is knowledge a `<select>` never shows, so with nothing greyed the dropdown has
   * to read as one plain alphabet — and with no facets in hand `optionDisabled` answers false
   * for every key, which is the path that has to fall out of the grouping rather than be a
   * special case somebody has to remember.
   */
  it("reads alphabetically while the index is still building", () => {
    render(<FilterBar search={search()} />);

    expect(formatOrder()).toEqual([
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
  it("opens on Any format with Any card above it", () => {
    render(<FilterBar search={search()} />);

    expect(formatOrder().slice(0, 2)).toEqual(["Any card", "Any format"]);
    expect(screen.getByLabelText("Format")).toHaveValue("");
  });

  /**
   * The whole point of the sinking: what can be picked is what is seen first. A format nothing
   * in this search is legal in is kept rather than dropped — it says the search has nothing
   * there, and a list that shed rows as the facets landed would jump under the cursor — but it
   * has no business sitting between two formats that would return cards.
   */
  it("floats the pickable formats above the greyed ones, each half alphabetical", () => {
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

    expect(formatOrder()).toEqual([
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
    expect(screen.getByRole("option", { name: "Vintage" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "Legacy" })).toBeDisabled();
  });

  /**
   * `optionDisabled`'s "a selected option is never greyed" rule, reaching the ordering.
   * A picked format can be at zero — a search narrowed after the fact empties it — and it is
   * the one row the reader needs, because changing it is how they get their cards back.
   * Sinking it would file that row below every row they cannot use.
   */
  it("keeps the selected format above the greyed ones even at zero", () => {
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

    expect(formatOrder()).toEqual([
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
    expect(screen.getByRole("option", { name: "Vintage" })).not.toBeDisabled();
  });

  /**
   * The dead end — a search so narrow that every format greys at once, which one card and a
   * text filter is enough to reach. Both pinned rows are outside the sorted list, so they are
   * first and pickable here exactly as they are everywhere else: neither is a format, and they
   * are how a reader who has filtered themselves into nothing gets out.
   */
  it("pins both non-format rows first even when nothing at all is legal", () => {
    render(
      <FilterBar
        search={search({
          facets: facets({ formats: Object.fromEntries(FORMATS.map((f) => [f.value, 0])) }),
        })}
      />,
    );

    expect(formatOrder()).toEqual([
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
    expect(screen.getByRole("option", { name: "Any format" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "Any card" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "Commander" })).toBeDisabled();
  });

  /** The deck editor's docked panel opens on the format of the deck being edited, and the hook
   *  seeds its `formats` with that key when the shared list has never carried it. */
  const seeded = (over: Record<string, unknown> = {}) =>
    search({ formats: [...FORMATS, { value: "historic", label: "Historic" }], ...over });

  /**
   * The whole reason the list is the search's own. A `<select>` whose `value` matches no
   * `<option>` does not draw blank — React selects the first row that is not disabled, which is
   * the pinned `Any format`, while the filter it names goes on narrowing the results
   * underneath. Both halves are asserted because they fail differently: `value` reads back
   * `""` from a controlled select given a key none of its options carry, and the option's own
   * text is the whole of what the reader can see. Neither is `getByRole` — a
   * present-but-unselected option would pass that and be exactly the bug this prevents.
   */
  it("draws a format the shared list does not carry, and shows it as picked", () => {
    render(<FilterBar search={seeded({ format: "historic" })} />);

    const select = screen.getByLabelText("Format") as HTMLSelectElement;
    expect(select).toHaveValue("historic");
    expect(select.selectedOptions[0]).toHaveTextContent("Historic");
    expect(screen.getByRole("option", { name: "Historic" })).not.toBeDisabled();
  });

  /** It is a format like every other once it arrives, so it files under H rather than riding
   *  the top as the newcomer — a reader hunting for it hunts where the alphabet says. */
  it("sorts the seeded format into the alphabet rather than pinning it", () => {
    render(<FilterBar search={seeded({ format: "historic" })} />);

    expect(formatOrder()).toEqual([
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
  it("keeps both pinned rows first when a seeded format would collate above them", () => {
    render(
      <FilterBar
        search={search({
          format: "alchemy",
          formats: [...FORMATS, { value: "alchemy", label: "Alchemy" }],
        })}
      />,
    );

    expect(formatOrder()).toEqual([
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
    expect(screen.getByLabelText("Format")).toHaveValue("alchemy");
  });

  /** The seeded row greys by the rule every other row greys by — one `optionDisabled` answer,
   *  and no arm of it that only the seven written-down keys reach. */
  it("greys the seeded format when this search has nothing legal in it", () => {
    render(
      <FilterBar
        search={seeded({ facets: facets({ formats: { ...facets().formats, historic: 0 } }) })}
      />,
    );

    expect(screen.getByRole("option", { name: "Historic" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Modern" })).not.toBeDisabled();
    // And it sinks below the pickable half rather than holding its slot under H.
    expect(formatOrder()).toEqual([
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
  });
});

/**
 * The sort picker and its direction button — the pair that gives the **grid** an order to be in.
 *
 * Everything here is asserted against the stub's four sort members rather than against a real
 * `useCardSearch`, so what these cases pin is the contract between the two: which key the select
 * sends, which term the arrow reads, and that neither invents a sort of its own.
 */
describe("FilterBar, its sort picker", () => {
  /** Every `<option>` the sort select draws, in document order. Scoped, because the format
   *  select beside it draws nine more and a bare `screen.getAllByRole` mixes the two lists. */
  const sortOrder = () =>
    within(screen.getByLabelText("Sort results"))
      .getAllByRole("option")
      .map((o) => o.textContent);

  /**
   * **`Sort results`, and this is the case that stops it being shortened back to `Sort`.**
   *
   * The collection's twin is a bare `Sort` and this one may not copy it, because this row is
   * drawn on two surfaces and one of them already has a `Sort`: the deck editor's toolbar sorts
   * the deck, this sorts the search results, and with the docked panel open both lists are on
   * screen at once. Two comboboxes with one name is a control that cannot be addressed
   * unambiguously — by a screen reader walking the form, by voice control, or by a
   * `getByLabelText` that starts throwing "found multiple" the day a test opens that panel.
   *
   * The absence of the bare name is asserted beside the presence of the long one, because that
   * is the half that fails when somebody shortens it: `Sort results` would still be *found* by a
   * substring query, and only an exact one says which word is drawn.
   */
  it("names the picker for the list it sorts, not for the act of sorting", () => {
    render(<FilterBar search={search()} layoutToggle={false} />);

    expect(screen.getByRole("combobox", { name: "Sort results" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Sort")).toBeNull();
  });

  /**
   * The row a reader opens the app on. `Default order` is not one of the orders — it is the
   * absence of one, which for this view means relevance when there is a query and name when
   * there is not — so it is pinned above them rather than sorted in.
   *
   * **`toHaveValue`, never the text of the selected option.** A controlled `<select>` whose
   * `value` matches no `<option>` does not draw blank: `react-dom` walks the options setting
   * `selected` and on no match picks the first row that is not disabled, which here is this very
   * row — so a picker that had lost its selection entirely would read exactly like one that is
   * correctly untouched.
   */
  it("opens on Default order, pinned above the orders", () => {
    render(<FilterBar search={search()} />);

    expect(screen.getByLabelText("Sort results")).toHaveValue("");
    expect(sortOrder()[0]).toBe("Default order");
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
  it("offers the orders alphabetically, under the pinned Default order", () => {
    render(<FilterBar search={search()} />);

    expect(sortOrder()).toEqual([
      "Default order",
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
    render(<FilterBar search={search({ setSortKey })} />);

    await userEvent.selectOptions(screen.getByLabelText("Sort results"), "manaValue");

    expect(setSortKey).toHaveBeenCalledWith("manaValue");
  });

  /** …and back out again, which on the grid is the **only** way out of a sort: the third press
   *  that clears one is a press on a table header the grid does not draw. Selected by element
   *  rather than by value, because `""` as a value string is not a match Testing Library can
   *  resolve unambiguously. */
  it("sends the empty key when the reader picks Default order back", async () => {
    const setSortKey = vi.fn();
    render(
      <FilterBar
        search={search({
          setSortKey,
          sortSelection: "price",
          sort: [{ key: "price", dir: "desc" }],
        })}
      />,
    );

    const select = screen.getByLabelText("Sort results");
    const back = within(select).getByRole("option", { name: "Default order" });
    await userEvent.selectOptions(select, back);

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
  it("disables the direction button while the list is in its default order", () => {
    render(<FilterBar search={search()} />);

    const button = dirButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Sort direction — no order picked");
  });

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
      "Sort direction — no order picked",
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

    screen.getByLabelText("Sort results").focus();
    await user.tab();
    expect(button).toHaveFocus();

    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull());
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Sort direction: ascending — press for descending",
    );
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

    expect(screen.getByLabelText("Sort results")).toHaveValue("rarity");
  });

  /** A Shift-built second key belongs to the table and is none of this row's business: the
   *  select shows the **first** term and the arrow shows that term's direction. */
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

    expect(screen.getByLabelText("Sort results")).toHaveValue("rarity");
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
    expect(screen.getByLabelText("Sort results")).toBeInTheDocument();
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

    const select = screen.getByLabelText("Sort results");
    expect(select.classList.contains("text-accent")).toBe(false);
    expect(select.classList.contains("border-accent")).toBe(false);
    expect(select.classList.contains("text-dim")).toBe(true);
    expect(dirButton().classList.contains("text-accent")).toBe(false);
    expect(dirButton().classList.contains("border-accent")).toBe(false);
  });
});
