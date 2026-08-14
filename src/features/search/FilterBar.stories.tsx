import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FilterBar } from "./FilterBar";
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
 * Reset all badge prints. Two of those rules are not obvious and would be copied wrong —
 * `toggleColor` makes colourless exclusive both ways (`useCardSearch.ts:125-129`), and
 * `toggleOwned` is a three-state cycle through one boolean — so the badge and the chips would
 * drift from the app while every story here stayed green. The hook is cheap: it queries the
 * seeded fake backend, and the 43-printing corpus answers at once.
 *
 * **The preset is applied from an effect, once.** `useCardSearch` takes no initial state, so
 * "two colours are on" can only be reached by pressing what a reader would press. An effect
 * rather than a `play`, because a `play` does not run on the docs page — Storybook renders the
 * stories there without autoplay — so a docs page built on plays would show six identical
 * untouched rows. The guard is a ref rather than a dependency array: the dependency would be
 * `search`, a new object every render, and the effect would re-apply its preset forever.
 */
function SearchFilters({
  preset,
  layoutToggle,
  width = AT_1280,
}: {
  preset?: Preset;
  /** `FilterBar`'s own prop, passed straight through. */
  layoutToggle?: boolean;
  /** A Tailwind width class for the box the row has to fit in — the whole subject of the
   *  wrapping stories, and a live control on every other one. */
  width?: string;
}) {
  const search = useCardSearch();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !preset) return;
    applied.current = true;
    preset(search);
  });
  return (
    <div className={width}>
      <FilterBar search={search} layoutToggle={layoutToggle} />
    </div>
  );
}

/**
 * Every filter the search offers, on at once — six *kinds*, which is what the badge counts.
 *
 * Three colours rather than one, because the badge's whole subject is that they are one thing
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
          "Every filter the search view offers, in one wrapping row. The controls are " +
          "`FilterChips`' — the collection's row is built from the same five, so the two are " +
          "the *same* row rather than lookalikes — and what this file owns is the layout and " +
          "which filters the search offers.\n\n" +
          "**The wrapping lives here.** `flex-wrap` is on this component's own container " +
          "(`FilterBar.tsx:45`) and on nothing `FilterChips` exports, so how a full row breaks " +
          "across lines is a question only these stories can answer. Every width below is a " +
          "window the app can really be: 1032px is the 1280 default, 776px is the 1024 floor " +
          "`tauri.conf.json` enforces, and 371px is the deck editor's docked panel.\n\n" +
          "**Nothing on this page is a hand-written filter state.** Each story presses its own " +
          "opening filters through the real `useCardSearch`, so the Reset all badge is the " +
          "real `activeFilterCount` and the colour chips obey the real `toggleColor`. The " +
          "colour chips are the app's one deliberate splash of colour, which is why every " +
          "other control on the row is grey.",
      },
    },
  },
} satisfies Meta<typeof SearchFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing on: the row a reader opens the app to.
 *
 * Six grey controls and a splash of colour, with a **greyed Reset all** already holding its
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
    await expect(canvas.getByLabelText("Format")).toHaveValue("");
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * Three kinds on — a word, two colours and a mana value.
 *
 * Gold border and gold text mark the controls that are doing something, and the badge counts
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
 * The badge is the claim: **six**, with three colour chips pressed, one mana value, one set and
 * one format. Kinds and not values, because the number captions a button that is about to clear
 * all of it and its job is to say how much is about to change.
 *
 * The Owned chip is last on the row, and last for a reason — everything left of it describes
 * cardboard, and it describes the reader's relationship to it.
 *
 * **One thing this story found rather than showed, and it has since been fixed:** the Reset all
 * button's accessible name was `"Reset all6"`, with no separator between the label and the
 * badge — measured 2026-08-09 with `computeAccessibleName` from `dom-accessibility-api`, the
 * resolver Testing Library's `name` option uses. The badge is an inline `<span>` and the accname
 * algorithm inserts nothing between inline boxes. Reported rather than patched at the time
 * because that task edited no component source; patched when the button became always-drawn,
 * which would have made the sentence `"Reset all0"` on every quiet row in the app. The badge is
 * `aria-hidden` now and the count is spelled into the button's own name.
 */
export const AllFiltersActive: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `findBy`, because the preset lands in an effect: the first query on this page has to wait
    // for the render it caused — **and it waits on the count in the name.** The button is drawn
    // from the first render now, so a bare `/^Reset all/` would resolve against the row *before*
    // the preset and every assertion below would read a state this story is not about. The badge
    // is drawn rather than spoken; the visible label still leads the name (WCAG 2.5.3).
    const reset = await canvas.findByRole("button", { name: "Reset all — 6 filters active" });
    await expect(reset).toHaveTextContent("6");
    // Three chips pressed against a badge reading 6: this is the whole of "kinds, not values",
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
    // The picker's label is a count of sets rather than their names: 64 codes will not fit on a
    // control that has to share a line with six colour chips.
    await expect(canvas.getByRole("button", { name: "Set" })).toHaveTextContent("1 set");
  },
};

/**
 * The row after Reset all — which is **byte-for-byte {@link Default}**, and that is why this is
 * an interaction rather than a sixth static story.
 *
 * `resetAll` writes every filter back to the value it was created with (`useCardSearch.ts:283`),
 * so a story that rendered the end state would be a duplicate of the first one on this page
 * under a different name. What is worth showing is the press, and what is worth asserting is
 * that the reset is *total*: it is six separate setters, and a filter left off that list would
 * still be on here while the badge that counted it had vanished.
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
    const reset = await canvas.findByRole("button", { name: "Reset all — 6 filters active" });
    await userEvent.click(reset);

    // The button is still under the cursor that pressed it, greyed rather than gone — which is
    // the whole of why it is drawn at zero. Nothing on the row moved.
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(reset).toHaveAccessibleName("Reset all — 0 filters active");
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("");
    await expect(canvas.getByLabelText("Format")).toHaveValue("");
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
    // The three-state chip is back to asking the first of its two questions, and the *label* is
    // what says so — an unpressed "Owned" cannot be mistaken for a pressed "Missing".
    await expect(canvas.getByRole("button", { name: /^Owned\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

/**
 * The greying, on an ordinary search: **one colour on, and four mana chips out of reach.**
 *
 * The rule is one sentence — *an option greys when turning it on would not change the result
 * set* — and this is the plain reading of it. 13 of the 38 printings this row searches over
 * are castable in red; none of them costs 4, 5, 6 or 7, so those four chips are drawn dim and
 * ignore a press. Standard goes with them in the format select — and **falls to the bottom of
 * it**, which is the second rule this row reads plainly: everything still pickable is listed
 * above everything that is not, each half alphabetical by the word on screen, under a pinned
 * "Any format". `FORMATS` writes Standard *first*; that order is a fact about the keys and
 * reaches the screen nowhere.
 *
 * 38 rather than the corpus' 41 paper printings, because `playableOnly` is on: the art card,
 * `Kozilek, Compleated` and `Little Girl` are legal in no format and the search view hides
 * them unless the Unplayable chip is pressed.
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
    // state this passes through is also called "Red — N printings". 38 is the answer for a
    // red search: pressing Red again would clear the filter, so its own chip counts the whole
    // searchable corpus — paper and playable — rather than the red part of it.
    await canvas.findByRole("button", { name: "Red — 38 printings" }, { timeout: 5000 });

    // Empty over a red search, and saying so where a reader can hover it.
    for (const value of [4, 5, 6, 7]) {
      const chip = canvas.getByRole("button", { name: new RegExp(`^Mana value ${value}\\b`) });
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      await expect(chip).toHaveAttribute("title", `Mana value ${value} — nothing in this search`);
      // **`aria-disabled`, never the attribute.** A `disabled` button leaves the tab order,
      // and a filter row that greys as the reader types would shrink and grow under a
      // keyboard caret. Asserted here because it is invisible in a screenshot and is the
      // whole reason `ManaChip` guards its own `onClick` instead.
      await expect(chip).not.toBeDisabled();
    }
    // …and the ones that are not empty are untouched.
    for (const value of [0, 1, 2, 3, 8]) {
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

    // The format select is the one place a real `disabled` is right — a native `<option>` is
    // not a tab stop there is anything to lose.
    const format = canvas.getByLabelText("Format") as HTMLSelectElement;
    const off = [...format.options].filter((o) => o.disabled).map((o) => o.value);
    await expect(off).toEqual(["standard"]);
    // …and it is drawn *last*, which is the half of the ordering only a faceted story can
    // show: `FORMATS` writes Standard first, the alphabet would put it sixth, and the one
    // format this search has nothing legal in belongs under the six that would return cards.
    // Asserted as the whole sequence, because an ordering bug that swapped two rows past each
    // other satisfies every assertion about one row's position.
    await expect([...format.options].map((o) => o.value)).toEqual([
      "",
      "commander",
      "legacy",
      "modern",
      "pauper",
      "pioneer",
      "vintage",
      "standard",
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
 * of the row, `Reset all` is the escape, and it is **live** because the text filter is on —
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
    // here passed against the *unfiltered* answer — "White — 14 printings" — which is the row
    // as it stands for the third of a second before the term lands, and every assertion below
    // then read a live chip and failed. That is the same window a reader can press into; the
    // live pass measured it at ~300–330 ms.
    await canvas.findByRole("button", { name: "White — 1 printing" }, { timeout: 5000 });

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
    // because there *is* something there — it just would not move.
    for (const colour of ["White", "Blue", "Black", "Red", "Green", "Colorless"]) {
      const chip = canvas.getByRole("button", { name: new RegExp(`^${colour}\\b`) });
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      await expect(chip).toHaveAttribute("title", `${colour} — 1 printing`);
    }

    const format = canvas.getByLabelText("Format") as HTMLSelectElement;
    const live = [...format.options].filter((o) => !o.disabled).map((o) => o.value);
    // "Any format" is never greyed — it is how a format filter is taken off.
    await expect(live).toEqual(["", "vintage"]);

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
    await canvas.findByRole("button", { name: "Reset all — 1 filter active" });

    const chips = canvas.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
    await expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) await expect(chip).not.toHaveAttribute("aria-disabled");

    for (const label of ["White", "Colorless", "Mana value 0", "Mana value 8 or more"]) {
      // Exact, not a prefix: an unfaceted chip's name is its label and nothing after it.
      await expect(canvas.getByRole("button", { name: label })).toBeInTheDocument();
    }

    const format = canvas.getByLabelText("Format") as HTMLSelectElement;
    await expect([...format.options].filter((o) => o.disabled)).toHaveLength(0);
  },
};

/**
 * The narrowest window the app can be put in: 1024 wide, leaving this row 776px.
 *
 * This is the story the wrapping exists for. Nothing here is a media query — one `flex-wrap`
 * container and a search box that is `min-w-56 flex-1`, so the box takes what is left of the
 * first line and the rest of the row breaks where it runs out.
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
 * the `border-l` and `pl-3` it is drawn with (`DeckSearchPanel.tsx:259`).
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
    // On the count, because the button no longer appears with the preset — it is already there.
    await expect(
      await canvas.findByRole("button", { name: "Reset all — 6 filters active" }),
    ).toHaveTextContent("6");
  },
};
