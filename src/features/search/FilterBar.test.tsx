import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MANA_VALUES } from "@/components/FilterChips";
import type { FacetResponse } from "@/lib/ipc";
import { FilterBar } from "./FilterBar";
import { FORMATS } from "./useCardSearch";

const search = (over: Record<string, unknown> = {}) =>
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
    activeCount: 0,
    resetAll: vi.fn(),
    ...over,
  }) as unknown as Parameters<typeof FilterBar>[0]["search"];

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

  /** Nothing to reset, nothing to say — an always-visible Reset is a control that is
   *  disabled most of the time, which reads as broken. */
  it("hides Reset all until something is filtered", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByRole("button", { name: /reset all/i })).not.toBeInTheDocument();
  });

  it("counts what Reset all would clear, and clears it", async () => {
    const resetAll = vi.fn();
    render(<FilterBar search={search({ activeCount: 3, colors: ["W"], resetAll })} />);

    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("3");

    await userEvent.click(reset);

    expect(resetAll).toHaveBeenCalled();
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
   * A cold index, a failed query and the first render all arrive here as no facets at all,
   * because `useCardSearch` collapses `ready: false` to `undefined` before the row ever sees
   * it (`facetsOrUndefined`). Not-greyed means "we don't know".
   */
  it("leaves every control live while the index is still building", () => {
    render(<FilterBar search={search()} />);

    for (const name of [/^Mana value 7\b/, /^White\b/, /^Owned\b/]) {
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
    render(<FilterBar search={search({ facets: facets({ formats: { modern: 0, legacy: 4 } }) })} />);

    expect(screen.getByRole("option", { name: "Modern" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Legacy" })).not.toBeDisabled();
    // Never: it is how you get back to no format at all.
    expect(screen.getByRole("option", { name: "Any format" })).not.toBeDisabled();
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
    expect(white).toHaveAttribute("title", "White — 12,481 printings");
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
    expect(
      screen.getByRole("button", { name: "Missing — 37 printings" }),
    ).not.toHaveAttribute("aria-disabled");
  });
});

describe("FilterBar, its format options in order", () => {
  /** Every `<option>` the select draws, in document order. The **sequence** is the behaviour
   *  under test, so each of these asserts the whole list: two formats swapped past each other
   *  pass any assertion about one row's presence, and did. */
  const formatOrder = () => screen.getAllByRole("option").map((o) => o.textContent);

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
   * text filter is enough to reach. "Any format" is pinned outside the sorted list, so it is
   * first and pickable here exactly as it is everywhere else: it is the answer "no filter"
   * rather than a format, and it is how a reader who has filtered themselves into nothing
   * gets out.
   */
  it("pins Any format first even when nothing at all is legal", () => {
    render(
      <FilterBar
        search={search({
          facets: facets({ formats: Object.fromEntries(FORMATS.map((f) => [f.value, 0])) }),
        })}
      />,
    );

    expect(formatOrder()).toEqual([
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
    expect(screen.getByRole("option", { name: "Commander" })).toBeDisabled();
  });
});
