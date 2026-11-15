import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { openDropdown, pickOption } from "@/test-dropdown";
import { FilterBar, STACK_PRINTINGS } from "./FilterBar";
import { TOKENS_AND_EXTRAS } from "./filterOptions";
import { useCardSearch, type CardSearch } from "./useCardSearch";

/** What a story switches on before the row is first drawn. Applied once; see {@link SearchFilters}. */
type Preset = (search: CardSearch) => void;

/**
 * The width the app really gives this row, and the arithmetic behind it.
 *
 * `AppShell` is a `w-52` sidebar (13rem = 208px, `AppShell.tsx:92`) beside a `main` with `p-5`
 * (20px a side, `AppShell.tsx:144`), so the row gets the window less 248px — before any
 * scrollbar, which `main`'s `overflow-auto` may add. `tauri.conf.json:16` opens the window at
 * 1280, which is 1032 here; `tauri.conf.json:18` will not let it below 1024, which is 776.
 */
const AT_1280 = "w-[1032px]";
const AT_MIN_WIDTH = "w-[776px]";

/**
 * `FilterBar` over the **real `useCardSearch`**, with a story's opening filters applied through
 * the hook's own setters.
 *
 * Every control on this row is controlled, so a story has to own the state it controls —
 * `FilterChips.stories.tsx`'s rule, one level up. What is different here is *whose* state:
 * `FilterBar`'s single prop is a `CardSearch`, and a hand-built one would be a second copy of
 * six toggle rules and the arithmetic (`activeFilterCount`, `useCardSearch.ts:93`) that the
 * Reset pill prints. Two of those rules are not obvious and would be copied wrong —
 * `toggleColor` makes colourless exclusive both ways (`useCardSearch.ts:125-129`), and
 * `toggleOwned` is a three-state cycle through one boolean — so the pills and the chips would
 * drift from the app while every story here stayed green. The hook is cheap: it queries the
 * seeded fake backend, and the 52-printing corpus answers at once.
 *
 * **The preset is applied from an effect, once.** The only initial state `useCardSearch` takes
 * is a default *format*, which this wrapper does not pass — so every filter a story here opens
 * on, that one included, is reached by pressing what a reader would press. An effect
 * rather than a `play`, because a `play` does not run on the docs page — Storybook renders the
 * stories there without autoplay — so a docs page built on plays would show six identical
 * untouched rows. The guard is a ref rather than a dependency array: the dependency would be
 * `search`, a new object every render, and the effect would re-apply its preset forever.
 */
function SearchFilters({
  preset,
  layoutToggle,
  width = AT_1280,
  px,
}: {
  preset?: Preset;
  /** `FilterBar`'s own prop, passed straight through. */
  layoutToggle?: boolean;
  /** A Tailwind width class for the box the row has to fit in — the whole subject of the
   *  wrapping stories, and a live control on every other one. */
  width?: string;
  /**
   * A width in pixels instead, for the band stories — set as a style and stated on the box as
   * `data-story-width`, which is what {@link reportStoryWidth} reads where nothing lays out.
   */
  px?: number;
}) {
  const search = useCardSearch();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !preset) return;
    applied.current = true;
    preset(search);
  });
  return (
    <div
      className={px === undefined ? width : undefined}
      style={px === undefined ? undefined : { width: px }}
      data-story-width={px}
    >
      <FilterBar search={search} layoutToggle={layoutToggle} />
    </div>
  );
}

/**
 * Every filter the search offers, on at once — six *kinds*, which is what the count pills say.
 *
 * Three colours rather than one, because the pill's whole subject is that they are one thing
 * that is on and not three. All three are coloured: `toggleColor` refuses to mix `C` with a
 * colour, so a preset that reached for colourless would silently drop the other two.
 */
const everything: Preset = (search) => {
  search.setText("bolt");
  search.setFormat("modern");
  for (const key of ["W", "U", "B"] as const) search.toggleColor(key);
  search.toggleManaValue(1);
  search.toggleSet("lea");
  search.toggleOwned();
};

/**
 * Open the Filters popup — Set, Format, Universe, Type, Rarity, Price, Finish, Border, Owned and
 * Include, which the bar keeps behind one button at every width (and the View cell, when the bar's
 * band moved the sort or the Grid/List pair into it).
 *
 * **Not something a `preset` can do**, and that is the tray working as designed: `trayOpen` is
 * `FilterBar`'s own state rather than the hook's, because the two surfaces that draw this row are
 * on screen together in the deck editor and a shared flag would open both at once. A preset
 * reaches the *search*; this reaches the row.
 */
async function openTray(canvas: ReturnType<typeof within>): Promise<void> {
  await userEvent.click(await canvas.findByRole("button", { name: /^Show filters/ }));
}

const meta = {
  title: "Search/FilterBar",
  // The wrapper, not `FilterBar`, so the props table below is the wrapper's three props rather
  // than the component's two. `component` has to be the thing the meta is typed over, and
  // typing this file over `FilterBar` would demand a whole `CardSearch` as a story arg — the
  // one object this file exists in order not to write by hand. `layoutToggle` is `FilterBar`'s
  // own prop and passes straight through; `preset` and `width` are the wrapper's.
  component: SearchFilters,
  tags: ["autodocs"],
  argTypes: { preset: { table: { disable: true }, control: false } },
  parameters: {
    docs: {
      description: {
        component:
          "Every filter the search view offers: the search box, the colours and the mana " +
          "values on the bar, then Filters, the sort, **Stack printings**, Grid/List and Reset, " +
          "and everything else in the Filters popup that drops over the results (the Filter " +
          "bar board, 2026-11). The controls are `FilterChips`' — the collection's row is built " +
          "from the same ones, so the two are the *same* row rather than lookalikes — and what " +
          "this file owns is the layout and which filters the search offers.\n\n" +
          "**The bar lays out by its own measured width** (`barBand`): `widest` ≥ 1500 puts " +
          "every word on its control; `roomy` 1100–1499 keeps the controls and names the icons " +
          "by tooltip; `normal` 980–1099 moves Grid/List into the popup's View cell; `tight` " +
          "800–979 moves the sort there too; `panel` < 800 is four lines. The `Band…` stories " +
          "draw each one. Every other width below is a window the app can really be: 1032px is " +
          "the 1280 default, 776px is the 1024 floor `tauri.conf.json` enforces, and 371px is " +
          "the deck editor's docked panel.\n\n" +
          "**Nothing on this page is a hand-written filter state.** Each story presses its own " +
          "opening filters through the real `useCardSearch`, so the count pills on Filters and " +
          "Reset are the real `activeFilterCount` and the colour chips obey the real " +
          "`toggleColor`. The colour chips are the app's one deliberate splash of colour, " +
          "which is why every other control on the row is grey.",
      },
    },
  },
} satisfies Meta<typeof SearchFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing on: the row a reader opens the app to.
 *
 * Grey controls and a splash of colour, with a **greyed Reset** already holding its
 * place at the end of them — the rule lives in the control rather than in this row, so every
 * view that offers a reset offers the same one. It is drawn here and dead because the search
 * box is `flex-1`: a Reset that arrived on the first press would take its width out of the box
 * and slide every chip in this row left, under the finger that just pressed one.
 *
 * The two `<label>`s are `sr-only`, and the assertions below are the only way to see them: a
 * search box with a placeholder and no label is a field a screen reader announces as "search",
 * and the format `<select>` has no visible text of its own at all.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Search cards")).toHaveAttribute(
      "placeholder",
      "Search cards…",
    );
    // **The count pill is drawn at 0** (the Filter bar board: a button never changes width when
    // it is used), grey until something is on — so a quiet row's Filters reads `Filters 0`.
    const filters = canvas.getByRole("button", { name: "Show filters, 0 active" });
    await expect(filters).toHaveTextContent("Filters");
    await expect(filters.querySelector("[data-count-pill]")).toHaveTextContent("0");
    // Stack printings is on the bar and pressed — one tile per card is the default wall.
    await expect(canvas.getByRole("button", { name: STACK_PRINTINGS })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await openTray(canvas);
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * Three kinds on — a word, two colours and a mana value.
 *
 * Gold border and gold text mark the controls that are doing something, and the pill counts
 * *kinds*: two colours are one thing that is on. The set picker and the format select are
 * untouched and stay grey, which is what makes the gold legible as a state rather than as
 * decoration.
 */
export const ActiveFilters: Story = {
  args: {
    preset: (search) => {
      search.setText("bolt");
      search.toggleColor("R");
      search.toggleColor("U");
      search.toggleManaValue(1);
    },
  },
};

/**
 * All six kinds at once, which is also the widest this row gets.
 *
 * The count pill is the claim: **six**, with three colour chips pressed, one mana value, one set and
 * one format. Kinds and not values, because the number captions a button that is about to clear
 * all of it and its job is to say how much is about to change.
 *
 * The Owned pair is the popup's last filter before Include, and last for a reason — everything
 * before it describes cardboard, and it describes the reader's relationship to it.
 *
 * **One thing this story found rather than showed, and it has since been fixed:** the Reset all
 * button's accessible name was `"Reset all6"`, with no separator between the label and the
 * badge — measured 2026-08-09 with `computeAccessibleName` from `dom-accessibility-api`, the
 * resolver Testing Library's `name` option uses. The badge is an inline `<span>` and the accname
 * algorithm inserts nothing between inline boxes. Reported rather than patched at the time
 * because that task edited no component source; patched when the button became always-drawn,
 * which would have made the sentence `"Reset all0"` on every quiet row in the app. The pill
 * (`CountPill`) is `aria-hidden` now and the count is spelled into the button's own name.
 */
export const AllFiltersActive: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `findBy`, because the preset lands in an effect: the first query on this page has to wait
    // for the render it caused — **and it waits on the count in the name.** The button is drawn
    // from the first render now, so a bare `/^Reset all/` would resolve against the row *before*
    // the preset and every assertion below would read a state this story is not about. The pill
    // is drawn rather than spoken; the visible label still leads the name (WCAG 2.5.3).
    const reset = await canvas.findByRole("button", { name: "Reset all: 6 filters active" });
    await expect(reset).toHaveTextContent("6");
    // Three chips pressed against a pill reading 6: this is the whole of "kinds, not values",
    // and it is invisible in a screenshot of a row full of gold.
    //
    // **Matched on a prefix**, because the fake answers `facet_cards` and a chip's accessible
    // name carries its count: "White — 3 printings". The label still comes first, which is
    // what WCAG 2.5.3 asks of it and what keeps this query readable.
    for (const colour of ["White", "Blue", "Black"]) {
      await expect(
        canvas.getByRole("button", { name: new RegExp(`^${colour}\\b`) }),
      ).toHaveAttribute("aria-pressed", "true");
    }
    // The count the tray's own button carries is the *search's*, not the tray's — the same six
    // Reset all wears, so the two cannot disagree about how much is on while the tray is shut.
    await expect(canvas.getByRole("button", { name: "Show filters, 6 active" })).toHaveTextContent(
      "6",
    );
    // Six chips under the rule for six kinds on, each stating its filter in words rather than in
    // the vocabulary of the control that set it — which is the whole point of the row: with the
    // tray shut, four of these six filters have no control on screen at all.
    for (const label of [
      "Color: White, Blue, Black",
      "Mana value: 1",
      "Set: LEA",
      "Format: Modern",
      "Owned",
    ]) {
      await expect(
        canvas.getByRole("button", { name: `Remove filter, ${label}` }),
      ).toBeInTheDocument();
    }

    await openTray(canvas);
    // The picker's label is a count of sets rather than their names: 64 codes will not fit on a
    // control that has to share a line with six colour chips.
    await expect(canvas.getByRole("button", { name: "Set" })).toHaveTextContent("1 set");
  },
};

/**
 * The row after Reset — which is **byte-for-byte {@link Default}**, and that is why this is
 * an interaction rather than a sixth static story.
 *
 * `resetAll` writes every filter back to the value it was created with (`useCardSearch.ts:283`),
 * so a story that rendered the end state would be a duplicate of the first one on this page
 * under a different name. What is worth showing is the press, and what is worth asserting is
 * that the reset is *total*: it is six separate setters, and a filter left off that list would
 * still be on here while the pill that counted it had vanished.
 *
 * On the docs page this renders in its opening state — six filters on — because Storybook does
 * not autoplay there. The canvas is where the press happens.
 */
export const Cleared: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Waited on the count, not on the button: the button is drawn before the preset lands, and
    // pressing it then would clear nothing and prove nothing.
    const reset = await canvas.findByRole("button", { name: "Reset all: 6 filters active" });
    await openTray(canvas);
    await userEvent.click(reset);

    // The button is still under the cursor that pressed it, greyed rather than gone — which is
    // the whole of why it is drawn at zero. Nothing on the row moved.
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(reset).toHaveAccessibleName("Reset all: 0 filters active");
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("");
    await expect(canvas.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    // Prefix matches throughout: every chip's accessible name now ends in the count the fake's
    // facets report for it, and the label is what has to come first.
    await expect(canvas.getByRole("button", { name: /^White\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: /^Mana value 1\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Set" })).toHaveTextContent("Any set");
    // Both halves of the owned pair are off. Two buttons rather than one cycling chip since the
    // tray gave them room, so "not owned" and "not missing" are two assertions and not one — the
    // state a single chip could only report by *becoming* the other question.
    for (const word of ["Owned", "Missing"]) {
      await expect(canvas.getByRole("button", { name: new RegExp(`^${word}\\b`) })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    // Nothing left to state: the rule stays, because Reset all lives under it and is drawn on
    // every row, but the caption and its chips are gone with the filters they described.
    await expect(canvas.queryByText("Filtering by")).not.toBeInTheDocument();
  },
};

/**
 * The greying, on an ordinary search: **one colour on, and four mana chips out of reach.**
 *
 * The rule is one sentence — *an option greys when turning it on would not change the result
 * set* — and this is the plain reading of it. 13 of the 42 printings this row searches over
 * are castable in red; none of them costs 4, 5, 6 or 7, so those four chips are drawn dim and
 * ignore a press. Standard goes with them in the format select — and **falls to the bottom of
 * it**, which is the second rule this row reads plainly: everything still pickable is listed
 * above everything that is not, each half alphabetical by the word on screen, under the one
 * pinned row "Any format". `FORMATS` writes Standard *first*; that order is a fact about the keys
 * and reaches the screen nowhere.
 *
 * Fewer than the corpus' paper printings, because `playableOnly` is on: the art card, `Kozilek,
 * Compleated`, `Little Girl` and the tokens are legal in no format, and every row of that select
 * hides them. The way back to them is not a row of it any more — it was `Any card` until the
 * Filter bar board (2026-11) — but the Include cell's **Tokens & extras** toggle, the same
 * `format` sentinel ({@link TokensAndExtras}).
 *
 * **The colour chips all stay live, and that is the interesting half.** `colors` is *subset*
 * semantics, so pressing White with Red already on asks for "castable in RW" — a **superset**,
 * which can only grow the result. A chip that greyed on "returns nothing" would be wrong here
 * in both directions, which is why `colorDisabled` asks a different question from
 * `optionDisabled`: it compares the size *after* the press against the size now.
 *
 * Nothing on this row is a hand-written count. The numbers come from the fake's `facet_cards`,
 * which derives them from the same filter mirror its `search_cards` uses — so a story that
 * disagreed with the results would be the two disagreeing, which is the bug worth catching.
 */
export const SomeUnavailable: Story = {
  args: { preset: (search) => search.toggleColor("R") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **The exact settled count, not a prefix.** The count rides in the accessible name, so
    // waiting on one is how a story waits for the facets — but the row wears the *previous*
    // search's counts while the next answer is in flight (`keepPreviousData`), and every
    // state this passes through is also called "Red — N printings". 47 is the answer for a
    // red search: pressing Red again would clear the filter, so its own chip counts the whole
    // searchable corpus — paper and playable — rather than the red part of it.
    await canvas.findByRole("button", { name: "Red: 47 printings" }, { timeout: 5000 });

    // Empty over a red search, and saying so where a reader can hover it. The count rides in
    // the accessible name as well as the tooltip (`ValueChip`'s own rule), so the exact name —
    // not a prefix — is what proves the sentence rather than only that the row is greyed.
    for (const value of [5, 6, 7]) {
      const chip = canvas.getByRole("button", {
        name: `Mana value ${value} (no results)`,
      });
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      // **`aria-disabled`, never the attribute.** A `disabled` button leaves the tab order,
      // and a filter row that greys as the reader types would shrink and grow under a
      // keyboard caret. Asserted here because it is invisible in a screenshot and is the
      // whole reason `ManaChip` guards its own `onClick` instead.
      await expect(chip).not.toBeDisabled();
    }
    // …and the ones that are not empty are untouched.
    for (const value of [0, 1, 2, 3, 4, 8]) {
      await expect(
        canvas.getByRole("button", { name: new RegExp(`^Mana value ${value}\\b`) }),
      ).not.toHaveAttribute("aria-disabled");
    }

    // Every colour stays pressable, including the four that are not in the result at all:
    // pressing one broadens. Red itself is *selected*, and a selected option is never greyed
    // whatever its count — that is the way out of a dead end.
    for (const colour of ["White", "Blue", "Black", "Red", "Green", "Colorless"]) {
      await expect(
        canvas.getByRole("button", { name: new RegExp(`^${colour}\\b`) }),
      ).not.toHaveAttribute("aria-disabled");
    }

    // The format picker is the one place a real `aria-disabled` is right — a row here is
    // never in the tab order either way, so there is nothing to strand.
    await openTray(canvas);
    await openDropdown(userEvent.setup(), "Format");
    const options = canvas.getAllByRole("option");
    const off = options
      .filter((o) => o.getAttribute("aria-disabled") === "true")
      .map((o) => o.textContent);
    await expect(off).toEqual(["Standard"]);
    // …and it is drawn *last*, which is the half of the ordering only a faceted story can
    // show: `FORMATS` writes Standard first, the alphabet would put it sixth, and the one
    // format this search has nothing legal in belongs under the six that would return cards.
    // Asserted as the whole sequence, because an ordering bug that swapped two rows past each
    // other satisfies every assertion about one row's position.
    // The one pinned row leads — the way out of the alphabet below it. `Any card` is gone from
    // the list: widening past every format is the Include cell's toggle now.
    await expect(options.map((o) => o.textContent)).toEqual([
      "Any format",
      "Commander",
      "Legacy",
      "Modern",
      "Pauper",
      "Pioneer",
      "Vintage",
      "Standard",
    ]);
  },
};

/**
 * One card left, and a row that is almost entirely out of reach — **with the way out still
 * open.**
 *
 * `lotus` finds Black Lotus and nothing else, and from there every question the row can ask
 * has the same answer. Eight of the nine mana chips are empty. Six of the seven formats are
 * empty; only Vintage is not, which is the correct answer about Black Lotus and not a fixture
 * coincidence. And **all six colour chips grey**, by the arm no other story reaches: Lotus is
 * colourless, subset semantics put a colourless card inside every colour, so pressing White
 * would return the same one card. `after === total` — the press would change nothing — so the
 * chip greys even though it returns something.
 *
 * The last assertion is the one that keeps this from being a trap. When a search greys most
 * of the row, `Reset` is the escape, and it is **live** because the text filter is on —
 * which is the assertion, now that the button is drawn on every row whether or not it can do
 * anything. A greyed row whose reset is also greyed is the failure mode the "a selected option
 * is never greyed" rule exists to prevent, and it is what an *unfiltered* empty corpus would
 * produce — which is why `facets::compute` answers a corpus of zero rows `ready: false` rather
 * than counting it honestly.
 */
export const MostlyUnavailable: Story = {
  args: { preset: (search) => search.setText("lotus") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **Waited on the exact count**, and the timeout is generous, because the search box is
    // debounced by `DEBOUNCE_MS` (300 ms) before a keystroke becomes a query. A prefix match
    // here passed against the *unfiltered* answer — "White — 18 printings" — which is the row
    // as it stands for the third of a second before the term lands, and every assertion below
    // then read a live chip and failed. That is the same window a reader can press into; the
    // live pass measured it at ~300–330 ms.
    await canvas.findByRole("button", { name: "White: 1 printing" }, { timeout: 5000 });

    // Only a nought is castable.
    await expect(canvas.getByRole("button", { name: /^Mana value 0\b/ })).not.toHaveAttribute(
      "aria-disabled",
    );
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await expect(
        canvas.getByRole("button", { name: new RegExp(`^Mana value ${value}\\b`) }),
      ).toHaveAttribute("aria-disabled", "true");
    }

    // The subset arm: every colour would return the same single colourless card, so pressing
    // one changes nothing and all six grey. The tooltip says the count rather than "nothing",
    // because there *is* something there — it just would not move; the exact accessible name
    // (`ManaChip`'s own `aria-label` and tooltip, one string spent twice) is what proves it.
    for (const colour of ["White", "Blue", "Black", "Red", "Green", "Colorless"]) {
      const chip = canvas.getByRole("button", { name: `${colour}: 1 printing` });
      await expect(chip).toHaveAttribute("aria-disabled", "true");
    }

    await openTray(canvas);
    await openDropdown(userEvent.setup(), "Format");
    const live = canvas
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-disabled") !== "true")
      .map((o) => o.textContent);
    // The pinned row is never greyed: "Any format" is how a format filter is taken off.
    await expect(live).toEqual(["Any format", "Vintage"]);
    // …and the one control that can *widen* a search greyed into a corner — the format picker's
    // old `Any card` row, the Include cell's toggle since the Filter bar board — stays live too.
    await expect(
      canvas.getByRole("button", { name: new RegExp(`^${TOKENS_AND_EXTRAS}\\b`) }),
    ).not.toHaveAttribute("aria-disabled");

    // The escape, and the whole reason this row is allowed to look like this. Presence is no
    // longer the claim — the button is on every row — so the claim is that it is *pressable*.
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).not.toHaveAttribute(
      "aria-disabled",
    );
  },
};

/**
 * The index still warming — and **every control live**, which is the whole of failing open.
 *
 * `facet_cards` answers a cold index `ready: false` with every map **empty** rather than
 * zeroed, and `facetsOrUndefined` collapses that to `undefined` at the door. Not-greyed means
 * "we don't know" and greyed means "this is empty", and only one of those is safe to guess
 * with no counts in hand — so the same row that {@link MostlyUnavailable} draws almost
 * entirely dim is drawn entirely live here, on the identical search.
 *
 * The second assertion is the one a screenshot cannot make: **no chip carries a count in its
 * accessible name**. `facetTitle` returns `undefined` for an absent count, so the chips keep
 * the plain labels they had before this feature existed. A response of zeros would have
 * greyed the lot *and* captioned every chip "nothing in this search"; this is how the two
 * are told apart.
 *
 * The fake has no warm-up of its own, so `fault: "indexCold"` is the only way to stand here —
 * the same state a real first launch is in for the ~767 ms its index takes to build, and for
 * the whole of the opening sync, where the corpus is empty and `compute` answers the same way.
 */
export const IndexCold: Story = {
  args: { preset: (search) => search.setText("lotus") },
  parameters: { fake: { fault: "indexCold" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The preset lands in an effect, so the first query waits for the render it caused —
    // **on the count in the name, not on the button.** The button itself is drawn from the
    // first render now, so `/^Reset all/` would resolve against the row *before* the preset
    // and every assertion below would read a state this story is not about.
    await canvas.findByRole("button", { name: "Reset all: 1 filter active" });
    // The tray's chips are swept too — the rarity row is faceted like the rest of the row, so a
    // cold index has to leave those live as well.
    await openTray(canvas);

    const chips = canvas.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    await expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) await expect(chip).not.toHaveAttribute("aria-disabled");

    for (const label of ["White", "Colorless", "Mana value 0", "Mana value 8 or more"]) {
      // Exact, not a prefix: an unfaceted chip's name is its label and nothing after it.
      await expect(canvas.getByRole("button", { name: label })).toBeInTheDocument();
    }

    await openDropdown(userEvent.setup(), "Format");
    const disabledOptions = canvas
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-disabled") === "true");
    await expect(disabledOptions).toHaveLength(0);
  },
};

/**
 * The picker mid-sort: **Released, newest first** — an order with no column to press.
 *
 * The row this pair exists for. The grid has no headers at all, and `Released` and `Mana value`
 * have no header even in the table (`SearchSortKey` says why: the search table already reaches
 * 1280px with the card pane open, and a seventh column would come out of Name). So before this,
 * a newest-first search was an order the app could not be put in from either layout.
 *
 * One press on the select is the whole gesture. `SEARCH_FIRST_DIR` opens `released` **descending**
 * — "newest first" is what pressing a release date means, the argument `price` carries and the
 * one behind the collection's `added` — so this is what the reader sees a moment after choosing
 * it, without touching the arrow.
 *
 * **Never gold**, unlike the format select two controls back. A list is always in *some* order,
 * so a sort cannot be inactive, and accent on this row means "a filter is on" — which is exactly
 * what the greyed Reset beside it is here to contradict: its pill reads 0 while the picker
 * is plainly doing something.
 *
 * The arrow is one `ArrowUp` turned half a turn and never `ArrowDown` swapped in — two components
 * in one slot is an unmount and a mount, so the indicator would teleport and the whole of what
 * the press means would be lost. Press it in the canvas to watch it turn.
 */
export const SortedDescending: Story = {
  args: { preset: (search) => search.setSortKey("released") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // **On the name, not on the button.** The preset lands in an effect and the pair is drawn
    // from the first render, so a query for the control itself would resolve against the
    // untouched row above and every assertion below would read a state this story is not about.
    // The name is what changes when the sort arrives, so it is what this waits on.
    const direction = await canvas.findByRole("button", {
      name: "Sort descending (click for ascending)",
    });
    await expect(direction).not.toBeDisabled();
    // The same sentence rides as the hover tooltip: there is no visible text on the button, so
    // a pointer has nothing else to get. Bound `describes: false` (the button's `aria-label`
    // already carries the sentence), so the panel carries no `role="tooltip"` — found by its
    // one stable id instead.
    await userEvent.hover(direction);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    await expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent(
      "Sort descending (click for ascending)",
    );
    await userEvent.unhover(direction);

    // The trigger's own text is the claim now — there is no `.value` on a button. A native
    // `<select>` whose value matched no `<option>` used to draw blank by picking the first row
    // while still reporting the old one; `Dropdown` cannot make that mistake, since a picker
    // that had lost its selection entirely draws its own em-dash placeholder rather than
    // reading as one nobody had touched.
    const sort = canvas.getByRole("button", { name: "Sort results" });
    await expect(sort).toHaveTextContent("Released");

    // A sort is not a filter: the pills do not count it and Reset does not clear it.
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * The narrowest window the app can be put in: 1024 wide, leaving this row 776px.
 *
 * **Under `tight`'s 800, so this is the `panel` band** — the deck editor's four lines: the search
 * box, the colours spread across theirs, the mana values stretched across theirs, then Filters,
 * the sort, Stack printings and Reset, with Grid/List in the Filters popup's View cell. Nothing
 * here is a media query: the band is read from the bar's own measured width (`barBand`), so the
 * same 776px reads the same way wherever the bar is mounted.
 */
export const NarrowestWindow: Story = {
  args: { preset: everything, width: AT_MIN_WIDTH },
};

/**
 * The deck editor's docked search panel — the one place this row is drawn without the layout
 * pair, and by a long way its narrowest home.
 *
 * `DeckSearchPanel.tsx:304` passes `layoutToggle={false}`, because that panel is a wall of art
 * with no table to switch to: the pair there would move the *search view's* stored preference
 * and change nothing the reader can see, which is a control that lies. Everything else on the
 * row is a statement about which cards to show and means the same thing in both places.
 *
 * 371px is the panel's own content box — `PANEL_WIDTH_PX = 384` (`DeckSearchPanel.tsx:39`) less
 * the `border-l` and `pl-3` it is drawn with (`DeckSearchPanel.tsx:259`) — and so the `panel`
 * band: see {@link BandPanel} for the four lines drawn with the popup open.
 */
export const DockedPanel: Story = {
  args: { layoutToggle: false, preset: everything, width: "w-[371px]" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // An absent control is indistinguishable from one that failed to render, so the absence is
    // the assertion. The group is what `LayoutToggle` wraps its pair in.
    await expect(canvas.queryByRole("group", { name: "Result layout" })).toBeNull();
    // …and the rest of the row is still there, which is the other half of the claim: this prop
    // drops one control and nothing else.
    await expect(canvas.getByRole("group", { name: "Color identity" })).toBeInTheDocument();
    // **The sort pair included, and this is the one surface where that is a decision rather than
    // an inheritance.** `layoutToggle={false}` says "no second layout to switch to", which names
    // exactly the panel with no table and therefore no header to sort by — so fencing the picker
    // on this prop would take it away from the only place it is the only control. The button is
    // matched on a pattern: its name becomes a reason when there is no order to flip, which is the
    // state this untouched row is in.
    await expect(canvas.getByLabelText("Sort results")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^(Sort (ascending|descending) \(|Best match has no sort direction)/ })).toBeDisabled();
    // On the count, because the button no longer appears with the preset — it is already there.
    await expect(
      await canvas.findByRole("button", { name: "Reset all: 6 filters active" }),
    ).toHaveTextContent("6");
  },
};

/**
 * Scryfall's tagger syntax, typed straight into the search box.
 *
 * `otag:ramp -atag:forest` is two questions and no free text at all: the parser lifts both terms out,
 * `tag_resolve` turns the names into slugs, and what is left for FTS is the empty string. The
 * chips under the row are what the box turned into — removable, and flippable between include
 * and exclude, because the box stays the one source of truth and both gestures rewrite the text
 * the reader can see.
 *
 * **The row is a column of two now.** It draws exactly the row it always did until a tag is
 * typed; `TagQueryRow` renders nothing at all before that, so no width is spent on a feature
 * most searches never use.
 */
export const TaggerSyntax: Story = {
  args: { preset: (search) => search.setText("otag:ramp -atag:forest") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = await canvas.findByRole("group", { name: "Tags from the search box" });
    // Not "Picked tags", which is the Tags page's own row — that page draws both at once.
    await expect(within(chips).getByText("Ramp")).toBeInTheDocument();
    // Exclusion is said in words, never in a hue: gold already means "on" everywhere here, and
    // a red chip would read as an error, which an exclusion is not.
    await expect(within(chips).getByText("not Forest")).toBeInTheDocument();
    // The whole box is still the query, and it is still what the reader typed.
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("otag:ramp -atag:forest");
  },
};

/**
 * A tag name the taxonomy does not have.
 *
 * The wall behind this row is deliberately **empty** — `useCardSearch` refuses to run a search
 * whose tag name resolved to nothing, because answering it as though the term were not there
 * would show the unfiltered corpus in reply to a narrowing the reader asked for. Scryfall 404s
 * here and says no more; a reader who mistypes `otag:remov` and is shown a silent empty wall
 * concludes their collection has no removal in it.
 *
 * So the note names the word and offers the tags that *are* called something like it, from
 * `tag_search` — the one command in the app that substring-matches, and therefore the only one
 * that can reach `removal` from `remov`. Pressing a suggestion rewrites that term in the box and
 * keeps the keyword the reader typed.
 */
export const UnknownTag: Story = {
  args: { preset: (search) => search.setText("otag:remov") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const note = await canvas.findByRole("status");
    await expect(note).toHaveTextContent(/No oracle tag called .remov./);

    // The near misses, and what pressing one does to the query.
    const suggestion = await canvas.findByRole("button", { name: "Removal" });
    await userEvent.click(suggestion);

    await waitFor(async () => {
      await expect(canvas.getByLabelText("Search cards")).toHaveValue("otag:removal");
    });
    // The note is gone with the name it was about, and the tag is a chip instead.
    await expect(canvas.queryByRole("status")).toBeNull();
    await expect(
      within(canvas.getByRole("group", { name: "Tags from the search box" })).getByText("Removal"),
    ).toBeInTheDocument();
  },
};

/**
 * A tag and a word in one query — the case the parser exists for.
 *
 * `bolt atag:lightning` sends `bolt` to FTS and the art tag beside it, so the two narrow together.
 * Sending the raw box instead would have the index hunting for a card whose text contains
 * `atag:lightning`, which is no card: the wall would be empty and the tag filter would never have
 * been applied at all.
 */
export const TagBesideFreeText: Story = {
  args: { preset: (search) => search.setText("bolt atag:lightning") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = await canvas.findByRole("group", { name: "Tags from the search box" });
    await expect(within(chips).getByText("Lightning")).toBeInTheDocument();
    // The word is still in the box: the chips are a reading of the query, not a replacement.
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("bolt atag:lightning");
    // And the text filter counts, so Reset all has something to clear.
    await expect(await canvas.findByRole("button", { name: /^Reset all/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * **`Exact` — the reading the colour chips get, as a round chip closing their group.**
 *
 * Loose is the default and the deckbuilder's question: two colours picked answer mono-R, mono-W,
 * RW *and* the colourless cards that fit in any deck. Pressed, the row reads "exactly these
 * colours" and answers the two-colour cards alone.
 *
 * **It was a tray cell from 2026-09-23 to 2026-09-28**, and before that a chip drawn only once a
 * colour was picked. It is on the bar again and always drawn — the colour chips' circle, press and
 * gold ring on the app's own surface, with a glyph that says the reading — `squares-intersect`
 * (AND) pressed, `squares-unite` (OR) not — so it reads as the same control without
 * reading as a seventh colour.
 *
 * **The pill still reads 1.** Strict modifies the colour filter rather than being one, so
 * `activeFilterCount` does not count it; what says it is on is the word inside the chip under the
 * rule — `Colour: exactly White, Blue` — and pressing that chip's × takes the flag off with the
 * colours it was about, because that chip is the one thing on screen that *names* the reading.
 */
export const StrictColours: Story = {
  args: {
    preset: (search) => {
      search.toggleColor("W");
      search.toggleColor("U");
      search.toggleColorsStrict();
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `findBy`, because the preset lands in an effect — and on the *pressed* toggle's own
    // sentence, so this resolves against the strict row rather than the loose one it passes
    // through. Scoped to the colour group with the tray shut, which is the assertion the move
    // is actually about and the one a query over the whole document cannot make.
    const toggle = await within(
      canvas.getByRole("group", { name: "Color identity" }),
    ).findByRole("button", {
      name: "Exact: color identity is exactly these colors",
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // One kind on, said twice and counted once — the whole of why this is not a chip of its own.
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Color: exactly White, Blue" }),
    ).toBeInTheDocument();
    await expect(
      // Singular: `ResetAll` words its own count through `plural`, so a hard-coded "filters"
      // here passes only at the counts nobody reaches first.
      canvas.getByRole("button", { name: "Reset all: 1 filter active" }),
    ).toHaveTextContent("1");
  },
};

/**
 * **The type cell** — eight chips in the tray, and the one filter on this row that is not a fact
 * about a *printing*.
 *
 * `Land Creature — Forest Dryad` is under **both** Land and Creature, because this filter asks
 * *does this card have this type* rather than which bucket it is in. `autoCategory.ts` files
 * Dryad Arbor under Land alone and `deckBuckets.ts` under Creature alone; each of those answers
 * one question with one bucket, and a reader pressing Creature who could not find an artifact
 * creature would have been told a falsehood.
 *
 * The order is the reading order — Creature first, Land last, which is how every decklist reads —
 * and deliberately not the alphabetical bit order the mask is stored in. A matching order and a
 * display order are two constants for `autoCategory.ts`' own reason: one constant cannot be both.
 *
 * **A wrapping flow rather than the rarity cell's grid**, and that is the narrowest surface's
 * rule rather than taste: eight chips do not fit one column of a 206px panel, where
 * `Planeswalker` alone is most of the cell's content box. Drag the width control down to 371px
 * and then past it to watch the group break onto as many lines as it needs. The counts are the
 * fake's own `facet_cards`, so a type nothing in the search has greys exactly as a rarity does.
 */
export const TypeChips: Story = {
  args: { preset: (search) => search.toggleType("Creature") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTray(canvas);

    const group = await canvas.findByRole("group", { name: "Type" });
    // The **text** and not the accessible name: the name carries the facet count wherever there
    // is one, and the sequence is what this asserts — two chips swapped past each other satisfy
    // any assertion about one being present.
    await expect(
      within(group)
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
    await expect(
      await within(group).findByRole("button", { name: /^Creature\b/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // One kind however many chips are pressed, the colours' and the rarities' rule.
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Type: Creature" }),
    ).toBeInTheDocument();
  },
};

/**
 * **The border and finish cells** (issue #573) — two questions about the cardboard itself.
 *
 * Border is `Regular`, `Borderless`, `Full art`, in that order because the order is the
 * information: the ordinary framed card first, then the two treatments that take the frame away.
 * They overlap rather than partition — a borderless full-art printing answers both of the last
 * two — so the counts in their tooltips do not sum to the search's.
 *
 * Finish on **this** surface asks what the printing was *published* in, Scryfall's `is:foil`: a
 * printing can be nonfoil only, foil only, both or etched. The collection's tray draws the same
 * cell and asks which finish a *copy* is; one cell, two questions, and the surface decides which.
 */
export const BorderAndFinish: Story = {
  args: {
    preset: (search) => {
      search.toggleBorder?.("borderless");
      search.toggleFinish?.("foil");
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTray(canvas);

    const border = await canvas.findByRole("group", { name: "Border" });
    // The text and not the name — the name carries a facet count wherever there is one.
    await expect(
      within(border)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Regular", "Borderless", "Full art"]);
    await expect(
      await within(border).findByRole("button", { name: /^Borderless\b/ }),
    ).toHaveAttribute("aria-pressed", "true");

    const finish = canvas.getByRole("group", { name: "Finish" });
    await expect(
      await within(finish).findByRole("button", { name: /^Foil\b/ }),
    ).toHaveAttribute("aria-pressed", "true");

    // One chip per kind under the rule, in the tray's words.
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Border: Borderless" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Finish: Foil" }),
    ).toBeInTheDocument();
  },
};

/**
 * **The Filters popup, open — every filter that is not on the bar.**
 *
 * Ten cells in three columns, in the Filter bar board's order (2026-11): the set picker, the
 * format picker, the Universe pair, the eight card types, the four rarities, the price band, the
 * three finishes a printing can be published in, the three borders, the Owned pair and — last —
 * Include, the **Tokens & extras** toggle. Universe, Finish, Border and Owned are joined button
 * groups (`JoinedChoices`); the longer lists stay chips. The popup drops over the results rather
 * than pushing them down, and what is on is stated under the bar once it closes.
 *
 * **No `Printings` cell any more**: `Stack printings` is on the bar at every width.
 *
 * The counts are the fake's own `facet_cards`, so the rarity chips grey exactly as the mana chips
 * beside them do and by the same rule: an option greys when turning it on would not change the
 * result set.
 */
export const TrayOpen: Story = {
  args: { preset: (search) => search.setText("bolt") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTray(canvas);

    // The ten cells, by their captions — the popup's own vocabulary, which is the only place
    // in the app a label sits above its control.
    //
    // `getAllByText`, because several are said twice on purpose: `SetCombobox` and the
    // format select each carry a name of their own for assistive tech (an `sr-only` span and a
    // `<label>`), and the tray's caption is the *visible* one above it. One control, two
    // spellings of one word, and the caption is the half a sighted reader reads.
    for (const label of [
      "Set",
      "Format",
      "Universe",
      "Type",
      "Rarity",
      "Price (USD)",
      "Finish",
      "Border",
      "Owned",
      "Include",
    ]) {
      await expect(canvas.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The printings switch is the bar's, never a cell here.
    await expect(canvas.queryByText("Printings")).toBeNull();
    await expect(canvas.getAllByRole("button", { name: STACK_PRINTINGS })).toHaveLength(1);
    // The four short choices are joined groups, each segment its own `aria-pressed` button.
    for (const group of ["Universe", "Finish", "Border", "Owned"]) {
      const buttons = within(canvas.getByRole("group", { name: group })).getAllByRole("button");
      await expect(buttons.length).toBeGreaterThan(1);
      for (const b of buttons) await expect(b).toHaveAttribute("aria-pressed");
    }
    // The money is the marketplace's, never a bare dollar: the caption reads `Price (USD)` on
    // TCGplayer and `Price (EUR)` on Cardmarket, over prices from two different tables.
    await expect(canvas.getByLabelText("Lowest price")).toHaveValue("");
    // Common through mythic, and **not** alphabetical: the order is the information, the way
    // Near Mint through Damaged is on the collection's condition chips.
    const rarities = canvas
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((n): n is string => !!n && /^(Common|Uncommon|Rare|Mythic)\b/.test(n))
      .map((n) => n.split(/[ :]/)[0]);
    await expect(rarities).toEqual(["Common", "Uncommon", "Rare", "Mythic"]);
  },
};

/**
 * The band narrowed by price, and the chip that says so.
 *
 * **An unpriced printing fails a bound end**, which is the one place this filter narrows more
 * than a reader might expect and is the honest reading: a shop that does not list a card has not
 * offered it for nothing. The number boxes are the filter and the handles are a way of reaching
 * it — a handle can only express the prices the ladder runs over, a box can express any of them.
 */
export const PriceBand: Story = {
  args: { preset: (search) => search.setPriceRange(2, 40) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The chip states the band before the tray is opened, which is the whole point of the row:
    // with the tray shut this filter has no control on screen at all.
    await canvas.findByRole("button", { name: "Remove filter, Price: $2.00 – $40.00" });

    await openTray(canvas);
    await expect(canvas.getByLabelText("Lowest price")).toHaveValue("2");
    await expect(canvas.getByLabelText("Highest price")).toHaveValue("40");
    // The position is the mechanism and the price is what is spoken — a screen reader reading
    // "200" off a thousand-position track would be hearing the slider instead of the filter.
    await expect(canvas.getByRole("slider", { name: "Lowest price, slider" })).toHaveAttribute(
      "aria-valuetext",
      "$2.00",
    );

    // Pressing the chip takes the whole band off — one press, one fewer on the pill. The popup
    // drops over the stated line now, so the chip is a press *outside* it: shut it first, the
    // way a reader has to, and look again.
    await userEvent.click(canvas.getByRole("button", { name: /^Hide filters/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove filter, Price: $2.00 – $40.00" }),
    );
    await waitFor(async () => {
      await expect(
        canvas.queryByRole("button", { name: /^Remove filter — Price/ }),
      ).not.toBeInTheDocument();
    });
    await openTray(canvas);
    await expect(canvas.getByLabelText("Lowest price")).toHaveValue("");
  },
};

/**
 * **The search, said in words** — and taken apart one filter at a time.
 *
 * This row is what the tray is paid for. Four of the six filters behind it have no control on
 * screen once it is shut, so without these chips a reader could be looking at a narrowed wall
 * with nothing to say why. One chip per *kind*, which is the same arithmetic the Reset pill
 * prints: three colours are one chip, because a reader looking at `Reset 3` over six chips
 * has been told two different things about one search.
 */
export const StatedFilters: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Reset all: 6 filters active" });

    const labels = () =>
      canvas
        .queryAllByRole("button", { name: /^Remove filter, / })
        .map((b) => b.getAttribute("aria-label")!.replace("Remove filter, ", ""));

    // Five chips against a pill of six: the sixth kind is the text in the box, which is on
    // screen with the words still in it and is the one filter a chip would only repeat.
    await expect(labels()).toEqual([
      "Color: White, Blue, Black",
      "Mana value: 1",
      "Set: LEA",
      "Format: Modern",
      "Owned",
    ]);

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove filter, Color: White, Blue, Black" }),
    );

    // The whole kind went, not one colour of it — and the pill followed.
    await waitFor(async () => {
      await expect(labels()).toEqual([
        "Mana value: 1",
        "Set: LEA",
        "Format: Modern",
        "Owned",
      ]);
    });
    await expect(
      canvas.getByRole("button", { name: "Reset all: 5 filters active" }),
    ).toBeInTheDocument();
  },
};

/**
 * **`Stack printings` — pressed, the default, is one tile per card.**
 *
 * It was `Show all printings` until the Filter bar board (2026-11), with the opposite meaning: a
 * switch that is *on* for the ordinary wall reads more plainly than one that has to be turned on to
 * leave it. The state underneath is unchanged — the hook's `allPrintings`, inverted by the control
 * — and it is **on the bar at every width** now, where it was a tray cell below 1040.
 *
 * A view mode rather than a filter, so neither pill counts it and Reset leaves it where it is:
 * the `play` un-stacks the wall, sets a word, presses Reset and finds the switch still off.
 */
export const StackPrintings: Story = {
  args: { preset: (search) => search.setText("bolt") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reset = await canvas.findByRole("button", { name: "Reset all: 1 filter active" });
    const stack = canvas.getByRole("button", { name: STACK_PRINTINGS });
    await expect(stack).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(stack);
    await expect(stack).toHaveAttribute("aria-pressed", "false");
    // Not counted: the pills still read the one filter the text is.
    await expect(reset).toHaveAccessibleName("Reset all: 1 filter active");
    await expect(
      canvas.getByRole("button", { name: "Show filters, 1 active" }),
    ).toBeInTheDocument();

    // And not cleared: Reset takes the word and leaves the wall un-stacked.
    await userEvent.click(reset);
    await expect(reset).toHaveAccessibleName("Reset all: 0 filters active");
    await expect(stack).toHaveAttribute("aria-pressed", "false");

    // No second copy in the popup — the switch has no cell there at any width.
    await openTray(canvas);
    await expect(canvas.getAllByRole("button", { name: STACK_PRINTINGS })).toHaveLength(1);
    await expect(canvas.queryByText("Printings")).toBeNull();
  },
};

/**
 * **Tokens & extras — the Include cell, and the printings no format allows.**
 *
 * The format picker's `Any card` row until the Filter bar board (2026-11), and the **same `format`
 * sentinel** (`ANY_CARD`) as a toggle of its own at the end of the popup. So it cannot stand beside
 * a named format: this story opens on Modern, turns the toggle on and watches the picker go back
 * to `Any format`; then picks Modern again and watches the toggle go off. "Modern, plus the
 * tokens" is a union the backend's `format` and `playableOnly` cannot spell, and a toggle that
 * stayed on under Modern while changing nothing would be a control that lies.
 *
 * It is a filter — it widens the wall — so it is counted and Reset clears it, and the stated line
 * says it as what it is, a corpus: `Showing: Tokens & extras`, never `Format:`.
 */
export const TokensAndExtras: Story = {
  args: { preset: (search) => search.setFormat("modern") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Remove filter, Format: Modern" });
    await openTray(canvas);

    const format = canvas.getByRole("button", { name: "Format" });
    await expect(format).toHaveTextContent("Modern");
    const extras = canvas.getByRole("button", { name: new RegExp(`^${TOKENS_AND_EXTRAS}\\b`) });
    await expect(extras).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(extras);
    await expect(extras).toHaveAttribute("aria-pressed", "true");
    // The format went back to `Any format` with the press — the two never stand on at once.
    await expect(format).toHaveTextContent("Any format");
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Showing: Tokens & extras" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Remove filter — Format:/ })).toBeNull();
    // One filter for one filter: the format's place in the count, not a second one beside it.
    await expect(
      canvas.getByRole("button", { name: "Reset all: 1 filter active" }),
    ).toBeInTheDocument();

    // The picker has no row for it, and picking a format turns it off.
    await pickOption(userEvent.setup(), "Format", /^Modern\b/);
    await waitFor(() => expect(extras).toHaveAttribute("aria-pressed", "false"));
    await expect(
      canvas.getByRole("button", { name: "Remove filter, Format: Modern" }),
    ).toBeInTheDocument();
  },
};

/**
 * **The bar's measured width, reported where nothing lays out** — for the `Band…` stories alone.
 *
 * `FilterBar` places its controls by `barBand(width)`, read from its own box's `ResizeObserver`.
 * In Storybook that is the browser's, and this does nothing. Under `stories.test.tsx` the page is
 * jsdom, whose observer `test-setup.ts` stubs to a no-op: the bar would stay unmeasured and draw
 * the `widest` band at every one of these widths, and a `play` about bands would assert nothing.
 * So where `document.body` has no width — no layout at all — this stands an observer in that
 * reports the nearest `data-story-width` ancestor's number to whatever it is asked to watch, the
 * way `FilterBar.test.tsx` reports a width by hand. Elements outside such a box are never
 * answered, so it cannot reach another story's tree; the returned cleanup puts the stub back.
 */
function reportStoryWidth(): () => void {
  if (document.body.getBoundingClientRect().width > 0) return () => {};
  const standing = globalThis.ResizeObserver;
  class Reporting {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const host = target.closest<HTMLElement>("[data-story-width]");
      if (host === null) return;
      const width = Number(host.dataset.storyWidth);
      queueMicrotask(() =>
        this.#callback(
          [{ target, contentRect: { width, height: 0 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        ),
      );
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = Reporting as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = standing;
  };
}

/** The popup the Filters button controls, or `null` while it is shut. */
function popupOf(canvas: ReturnType<typeof within>): HTMLElement | null {
  const filters = canvas.getByRole("button", { name: /^(Show|Hide) filters/ });
  const id = filters.getAttribute("aria-controls");
  return id === null ? null : filters.ownerDocument.getElementById(id);
}

/** Whether a control's visible word is drawn (the bands below `widest` hide it by class). */
async function expectWord(button: HTMLElement, word: string, drawn: boolean): Promise<void> {
  const span = within(button).getByText(word);
  if (drawn) await expect(span).not.toHaveClass("hidden");
  else await expect(span).toHaveClass("hidden");
}

/** One colour on, so the pills read gold and the stated line has a chip to draw. */
const oneColour: Preset = (search) => search.toggleColor("R");

/**
 * **Band: widest (≥ 1500), 1520px of bar — the Filters popup open.**
 *
 * One line with every word on its control — Filters, Stack printings, Reset — and hairlines
 * either side of the sort; Grid/List on the bar too. The popup drops from the bar over the
 * results (it does not push them down), three columns, with no View cell: nothing left the bar.
 */
export const BandWidest: Story = {
  args: { px: 1520, preset: oneColour },
  beforeEach: reportStoryWidth,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = await canvas.findByRole("button", { name: "Show filters, 1 active" });
    await expectWord(filters, "Filters", true);
    await expectWord(canvas.getByRole("button", { name: STACK_PRINTINGS }), STACK_PRINTINGS, true);
    await expectWord(canvas.getByRole("button", { name: /^Reset all/ }), "Reset", true);
    await expect(canvas.getByRole("group", { name: "Result layout" })).toBeInTheDocument();

    await userEvent.click(filters);
    const popup = popupOf(canvas);
    await expect(popup).not.toBeNull();
    // Nothing moved into the popup at this width, so it has no View cell and holds no sort.
    await expect(within(popup!).queryByText("View")).toBeNull();
    await expect(within(popup!).queryByRole("button", { name: "Sort results" })).toBeNull();
    await expect(within(popup!).getByText("Include")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Sort results" })).toBeInTheDocument();
  },
};

/**
 * **Band: roomy (1100–1499), 1200px of bar.**
 *
 * The same controls on the same line, the words gone: Filters, Stack printings and Reset are an
 * icon and a pill each, named by tooltip and by their accessible names, which do not change. The
 * popup is shut — this is the bar a reader sees most at a maximised 1440 window.
 */
export const BandRoomy: Story = {
  args: { px: 1200, preset: oneColour },
  beforeEach: reportStoryWidth,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = await canvas.findByRole("button", { name: "Show filters, 1 active" });
    // Waited on: the band arrives with the first measurement, after the first render.
    await waitFor(() => expectWord(filters, "Filters", false));
    await expectWord(canvas.getByRole("button", { name: STACK_PRINTINGS }), STACK_PRINTINGS, false);
    await expectWord(canvas.getByRole("button", { name: /^Reset all/ }), "Reset", false);
    // Sort and Grid/List are still the bar's.
    await expect(canvas.getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    await expect(canvas.getByRole("group", { name: "Result layout" })).toBeInTheDocument();
    await expect(popupOf(canvas)).toBeNull();
  },
};

/**
 * **Band: normal (980–1099), 1040px of bar — the Filters popup open.**
 *
 * Grid/List leave the bar for the popup's **View** cell, drawn last, after Include. Drawn once,
 * never twice with one hidden — so there is one `Result layout` group on the page, in the popup.
 */
export const BandNormal: Story = {
  args: { px: 1040, preset: oneColour },
  beforeEach: reportStoryWidth,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Show filters, 1 active" });
    await waitFor(() => expect(canvas.queryByRole("group", { name: "Result layout" })).toBeNull());
    await expect(canvas.getByRole("button", { name: "Sort results" })).toBeInTheDocument();

    await openTray(canvas);
    const popup = popupOf(canvas)!;
    await expect(within(popup).getByText("View")).toBeInTheDocument();
    await expect(within(popup).getByRole("group", { name: "Result layout" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("group", { name: "Result layout" })).toHaveLength(1);
    // The sort is still on the bar at this band.
    await expect(within(popup).queryByRole("button", { name: "Sort results" })).toBeNull();
  },
};

/**
 * **Band: tight (800–979), 840px of bar — the Filters popup open.**
 *
 * The sort leaves too, into the same View cell beside Grid/List, and the mana values tighten to
 * 24px chips. The bar keeps the search box, the colours, the mana values, Filters, Stack
 * printings and Reset.
 */
export const BandTight: Story = {
  args: { px: 840, preset: oneColour },
  beforeEach: reportStoryWidth,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Show filters, 1 active" });
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Sort results" })).toBeNull());
    await expect(canvas.getByRole("button", { name: STACK_PRINTINGS })).toBeInTheDocument();

    await openTray(canvas);
    const popup = popupOf(canvas)!;
    await expect(within(popup).getByText("View")).toBeInTheDocument();
    await expect(within(popup).getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    await expect(within(popup).getByRole("group", { name: "Result layout" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: "Sort results" })).toHaveLength(1);
  },
};

/**
 * **Band: panel (< 800), 384px — the deck editor's docked column — the Filters popup open.**
 *
 * Four lines: the search box; the six colours and Exact spread across theirs at 34px; the mana
 * values stretched across theirs; then Filters, the sort (filling the line), Stack printings and
 * Reset. `layoutToggle={false}`, as the docked panel passes it — there is no table to switch to —
 * so the popup has no View cell either. The popup's cells are one column here and scroll inside a
 * frame that fades out above its foot.
 */
export const BandPanel: Story = {
  args: { px: 384, layoutToggle: false, preset: oneColour },
  beforeEach: reportStoryWidth,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Show filters, 1 active" });
    // The colour line is the panel's own arrangement: spread edge to edge.
    await waitFor(() =>
      expect(canvas.getByRole("group", { name: "Color identity" })).toHaveClass("justify-between"),
    );
    // Every one of the fourth line's controls is still on the bar.
    await expect(canvas.getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: STACK_PRINTINGS })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toBeInTheDocument();
    await expect(canvas.queryByRole("group", { name: "Result layout" })).toBeNull();

    await openTray(canvas);
    const popup = popupOf(canvas)!;
    await expect(within(popup).getByText("Include")).toBeInTheDocument();
    await expect(within(popup).queryByText("View")).toBeNull();
  },
};
