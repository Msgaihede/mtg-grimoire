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
 * Six grey controls and a splash of colour, with **no Reset all** — the rule lives in the
 * control (`FilterChips.tsx:222` returns `null` at zero) rather than in this row, so every view
 * that offers a reset offers the same one.
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
    await expect(canvas.queryByRole("button", { name: /^Reset all/ })).toBeNull();
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
 * **One thing this story found rather than showed:** the Reset all button's accessible name is
 * `"Reset all6"`, with no separator between the label and the badge. Measured 2026-08-09 with
 * `computeAccessibleName` from `dom-accessibility-api`, which is the resolver Testing Library's
 * `name` option uses. The badge is an inline `<span>` and the accname algorithm inserts nothing
 * between inline boxes. It is a defect in `FilterChips.ResetAll` and not in this row, so it is
 * reported rather than patched here — this task edits no component source.
 */
export const AllFiltersActive: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `findBy`, because the preset lands in an effect: the first query on this page has to wait
    // for the render it caused.
    //
    // **Matched on a prefix and asserted on the text, because the accessible name is
    // `"Reset all6"`** — measured 2026-08-09 by running `computeAccessibleName` from
    // `dom-accessibility-api` (the resolver Testing Library's `name` option uses) over
    // `<ResetAll count={6} />`. The badge is a `<span>`, `display: inline` gets no separator
    // from the accname algorithm, and the JSX text before it ends without one — so a screen
    // reader is read "Reset all6". It is a real (small) defect in `FilterChips.ResetAll` rather
    // than a fact about this story, and it is left to be *reported* rather than worked around:
    // no component source is edited by this task.
    const reset = await canvas.findByRole("button", { name: /^Reset all/ });
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
    await userEvent.click(await canvas.findByRole("button", { name: /^Reset all/ }));

    await expect(canvas.queryByRole("button", { name: /^Reset all/ })).toBeNull();
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
    await expect(await canvas.findByRole("button", { name: /^Reset all/ })).toHaveTextContent("6");
  },
};
