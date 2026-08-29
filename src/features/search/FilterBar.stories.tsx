import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID } from "@/components/tooltip/TooltipProvider";
import { openDropdown } from "@/test-dropdown";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";
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
  flatten = false,
  width = AT_1280,
}: {
  preset?: Preset;
  /** `FilterBar`'s own prop, passed straight through. */
  layoutToggle?: boolean;
  /**
   * Whether the row draws the **Flatten** switch — on where the list is filed into folders, which
   * is the wishlist and the collection and neither of the two surfaces `useCardSearch` stands for
   * here.
   *
   * **The state behind it is this wrapper's `useState`, and that is not the hand-built object this
   * file exists to avoid.** `FilterBar`'s `search` prop is a whole `CardSearch` with six toggle
   * rules and the badge's arithmetic behind it, which is why the real hook is used for that.
   * Flatten is a boolean with no third state, nothing derived from it and no arithmetic anywhere —
   * `useWishlist` holds exactly this `useState` — so a story owning it copies no rule that could
   * drift.
   */
  flatten?: boolean;
  /** A Tailwind width class for the box the row has to fit in — the whole subject of the
   *  wrapping stories, and a live control on every other one. */
  width?: string;
}) {
  const search = useCardSearch();
  const [flattened, setFlattened] = useState(false);
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !preset) return;
    applied.current = true;
    preset(search);
  });
  return (
    <div className={width}>
      <FilterBar
        search={search}
        layoutToggle={layoutToggle}
        flatten={
          flatten
            ? { pressed: flattened, onToggle: () => setFlattened((on) => !on) }
            : undefined
        }
      />
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

/**
 * Open the filter tray — Set, Format, Owned, Rarity, Price and Printings, which the row keeps
 * behind one disclosure at every width.
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
    // The badge is drawn only when there is something to count, so a quiet row's Filters button
    // is an icon and a word and nothing else.
    await expect(canvas.getByRole("button", { name: "Show filters — 0 active" })).toHaveTextContent(
      "Filters",
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
    // The count the tray's own button carries is the *search's*, not the tray's — the same six
    // Reset all wears, so the two cannot disagree about how much is on while the tray is shut.
    await expect(canvas.getByRole("button", { name: "Show filters — 6 active" })).toHaveTextContent(
      "6",
    );
    // Six chips under the rule for six kinds on, each stating its filter in words rather than in
    // the vocabulary of the control that set it — which is the whole point of the row: with the
    // tray shut, four of these six filters have no control on screen at all.
    for (const label of [
      "Colour: White, Blue, Black",
      "Mana value: 1",
      "Set: LEA",
      "Format: Modern",
      "Owned",
    ]) {
      await expect(
        canvas.getByRole("button", { name: `Remove filter — ${label}` }),
      ).toBeInTheDocument();
    }

    await openTray(canvas);
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
    await openTray(canvas);
    await userEvent.click(reset);

    // The button is still under the cursor that pressed it, greyed rather than gone — which is
    // the whole of why it is drawn at zero. Nothing on the row moved.
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(reset).toHaveAccessibleName("Reset all — 0 filters active");
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
 * above everything that is not, each half alphabetical by the word on screen, under the two
 * pinned rows "Any card" and "Any format". `FORMATS` writes Standard *first*; that order is a
 * fact about the keys and reaches the screen nowhere.
 *
 * 42 rather than the corpus' 45 paper printings, because `playableOnly` is on: the art card,
 * `Kozilek, Compleated` and `Little Girl` are legal in no format, and every row of that select
 * but its first — "Any card" — hides them.
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
    // state this passes through is also called "Red — N printings". 46 is the answer for a
    // red search: pressing Red again would clear the filter, so its own chip counts the whole
    // searchable corpus — paper and playable — rather than the red part of it.
    await canvas.findByRole("button", { name: "Red — 46 printings" }, { timeout: 5000 });

    // Empty over a red search, and saying so where a reader can hover it. The count rides in
    // the accessible name as well as the tooltip (`ValueChip`'s own rule), so the exact name —
    // not a prefix — is what proves the sentence rather than only that the row is greyed.
    for (const value of [5, 6, 7]) {
      const chip = canvas.getByRole("button", {
        name: `Mana value ${value} — nothing in this search`,
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
    // The two pinned rows lead, widest first — they are the ladder out of the alphabet below
    // them, and `Any card` is the row that can widen a search this narrow rather than merely
    // unnarrow it.
    await expect(options.map((o) => o.textContent)).toEqual([
      "Any card",
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
    // here passed against the *unfiltered* answer — "White — 18 printings" — which is the row
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
    // because there *is* something there — it just would not move; the exact accessible name
    // (`ManaChip`'s own `aria-label` and tooltip, one string spent twice) is what proves it.
    for (const colour of ["White", "Blue", "Black", "Red", "Green", "Colorless"]) {
      const chip = canvas.getByRole("button", { name: `${colour} — 1 printing` });
      await expect(chip).toHaveAttribute("aria-disabled", "true");
    }

    await openTray(canvas);
    await openDropdown(userEvent.setup(), "Format");
    const live = canvas
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-disabled") !== "true")
      .map((o) => o.textContent);
    // Neither pinned row is ever greyed: "Any format" is how a format filter is taken off, and
    // "Any card" is the one row that can *widen* a search greyed into a corner.
    await expect(live).toEqual(["Any card", "Any format", "Vintage"]);

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
 * what the greyed Reset all beside it is here to contradict: the badge reads 0 while the picker
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
      name: "Sort direction: descending — press for ascending",
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
      "Sort direction: descending — press for ascending",
    );
    await userEvent.unhover(direction);

    // The trigger's own text is the claim now — there is no `.value` on a button. A native
    // `<select>` whose value matched no `<option>` used to draw blank by picking the first row
    // while still reporting the old one; `Dropdown` cannot make that mistake, since a picker
    // that had lost its selection entirely draws its own em-dash placeholder rather than
    // reading as one nobody had touched.
    const sort = canvas.getByRole("button", { name: "Sort results" });
    await expect(sort).toHaveTextContent("Released");

    // A sort is not a filter: the badge does not count it and Reset all does not clear it.
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
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
    // **The sort pair included, and this is the one surface where that is a decision rather than
    // an inheritance.** `layoutToggle={false}` says "no second layout to switch to", which names
    // exactly the panel with no table and therefore no header to sort by — so fencing the picker
    // on this prop would take it away from the only place it is the only control. The button is
    // matched on a prefix: its name grows a reason when there is no order to flip, which is the
    // state this untouched row is in.
    await expect(canvas.getByLabelText("Sort results")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Sort direction/ })).toBeDisabled();
    // On the count, because the button no longer appears with the preset — it is already there.
    await expect(
      await canvas.findByRole("button", { name: "Reset all — 6 filters active" }),
    ).toHaveTextContent("6");
  },
};

/**
 * **Flatten, beside the layout pair** — the wishlist's and the collection's switch, and the two
 * ends of it in one story.
 *
 * It sat down beside the breadcrumb and the folder cards until now, on the argument that where a
 * reader is standing is navigation rather than a narrowing. That argument still holds and it is
 * not what decides the placement: this row has a hairline across it, and everything past that
 * hairline is a statement about how the results are **drawn** rather than about which ones there
 * are. Flatten is that kind of statement one level up — how much of the *tree* is on screen — and
 * both hooks already treat it that way, keeping it out of their filter state and out of
 * `resetAll`. So it goes where the other controls Reset all cannot reach already are.
 *
 * **The two are in one wrapper, which is a fact about wrapping and not about tidiness.** The row
 * is `flex-wrap`, so two adjacent items are two items the wrap may break between — and a Flatten
 * chip on the line above the pair it was moved next to would be the whole change undone. Drag the
 * width control down to the docked panel's 371px to watch the group move as one.
 *
 * The badge is the other half: the switch is **on** by the end of the play and Reset all still
 * reads zero, because none of this narrows anything.
 */
export const FlattenSwitch: Story = {
  args: { flatten: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = await canvas.findByRole("button", { name: "Flatten" });
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    // One wrapper, said as the tree rather than as a class: the pair's group is the chip's own
    // next sibling, so nothing can be ordered between them and no wrap can separate them.
    const layout = canvas.getByRole("group", { name: "Result layout" });
    await expect(chip.nextElementSibling).toBe(layout);

    await userEvent.click(chip);

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Flatten" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    // Nothing about the filing is a filter, so the press moved neither number on the row.
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAccessibleName(
      "Reset all — 0 filters active",
    );
  },
};

/**
 * Scryfall's tagger syntax, typed straight into the search box.
 *
 * `o:ramp -a:forest` is two questions and no free text at all: the parser lifts both terms out,
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
  args: { preset: (search) => search.setText("o:ramp -a:forest") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = await canvas.findByRole("group", { name: "Tags from the search box" });
    // Not "Picked tags", which is the Tags page's own row — that page draws both at once.
    await expect(within(chips).getByText("Ramp")).toBeInTheDocument();
    // Exclusion is said in words, never in a hue: gold already means "on" everywhere here, and
    // a red chip would read as an error, which an exclusion is not.
    await expect(within(chips).getByText("not Forest")).toBeInTheDocument();
    // The whole box is still the query, and it is still what the reader typed.
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("o:ramp -a:forest");
  },
};

/**
 * A tag name the taxonomy does not have.
 *
 * The wall behind this row is deliberately **empty** — `useCardSearch` refuses to run a search
 * whose tag name resolved to nothing, because answering it as though the term were not there
 * would show the unfiltered corpus in reply to a narrowing the reader asked for. Scryfall 404s
 * here and says no more; a reader who mistypes `o:remov` and is shown a silent empty wall
 * concludes their collection has no removal in it.
 *
 * So the note names the word and offers the tags that *are* called something like it, from
 * `tag_search` — the one command in the app that substring-matches, and therefore the only one
 * that can reach `removal` from `remov`. Pressing a suggestion rewrites that term in the box and
 * keeps the keyword the reader typed.
 */
export const UnknownTag: Story = {
  args: { preset: (search) => search.setText("o:remov") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const note = await canvas.findByRole("status");
    await expect(note).toHaveTextContent(/No oracle tag called .remov./);

    // The near misses, and what pressing one does to the query.
    const suggestion = await canvas.findByRole("button", { name: "Removal" });
    await userEvent.click(suggestion);

    await waitFor(async () => {
      await expect(canvas.getByLabelText("Search cards")).toHaveValue("o:removal");
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
 * `bolt a:lightning` sends `bolt` to FTS and the art tag beside it, so the two narrow together.
 * Sending the raw box instead would have the index hunting for a card whose text contains
 * `a:lightning`, which is no card: the wall would be empty and the tag filter would never have
 * been applied at all.
 */
export const TagBesideFreeText: Story = {
  args: { preset: (search) => search.setText("bolt a:lightning") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chips = await canvas.findByRole("group", { name: "Tags from the search box" });
    await expect(within(chips).getByText("Lightning")).toBeInTheDocument();
    // The word is still in the box: the chips are a reading of the query, not a replacement.
    await expect(canvas.getByLabelText("Search cards")).toHaveValue("bolt a:lightning");
    // And the text filter counts, so Reset all has something to clear.
    await expect(await canvas.findByRole("button", { name: /^Reset all/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * **The tray, open — every filter that is not on the bar.**
 *
 * Six fields in three columns: the set picker, the format ladder, the owned pair, the four
 * rarities, the price band and the printings mode. Four controls stay on the bar above it at
 * every width — the box you type in, the colours, the mana values and the order the results come
 * in — because those are the four a reader reaches for without looking.
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

    // The six fields, by their captions — the tray's own vocabulary, which is the only place in
    // the app a label sits above its control.
    //
    // `getAllByText`, because two of the six are said twice on purpose: `SetCombobox` and the
    // format select each carry a name of their own for assistive tech (an `sr-only` span and a
    // `<label>`), and the tray's caption is the *visible* one above it. One control, two
    // spellings of one word, and the caption is the half a sighted reader reads.
    for (const label of ["Set", "Format", "Owned", "Rarity", "Price (USD)", "Printings"]) {
      await expect(canvas.getAllByText(label).length).toBeGreaterThan(0);
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
      .map((n) => n.split(/[ —]/)[0]);
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
    await canvas.findByRole("button", { name: "Remove filter — Price: $2.00 – $40.00" });

    await openTray(canvas);
    await expect(canvas.getByLabelText("Lowest price")).toHaveValue("2");
    await expect(canvas.getByLabelText("Highest price")).toHaveValue("40");
    // The position is the mechanism and the price is what is spoken — a screen reader reading
    // "200" off a thousand-position track would be hearing the slider instead of the filter.
    await expect(canvas.getByRole("slider", { name: "Lowest price, slider" })).toHaveAttribute(
      "aria-valuetext",
      "$2.00",
    );

    // Pressing the chip takes the whole band off — one press, one fewer on the badge.
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove filter — Price: $2.00 – $40.00" }),
    );
    await waitFor(async () => {
      await expect(canvas.getByLabelText("Lowest price")).toHaveValue("");
    });
  },
};

/**
 * **The search, said in words** — and taken apart one filter at a time.
 *
 * This row is what the tray is paid for. Four of the six filters behind it have no control on
 * screen once it is shut, so without these chips a reader could be looking at a narrowed wall
 * with nothing to say why. One chip per *kind*, which is the same arithmetic the Reset all badge
 * prints: three colours are one chip, because a reader looking at `Reset all 3` over six chips
 * has been told two different things about one search.
 */
export const StatedFilters: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: "Reset all — 6 filters active" });

    const labels = () =>
      canvas
        .queryAllByRole("button", { name: /^Remove filter — / })
        .map((b) => b.getAttribute("aria-label")!.replace("Remove filter — ", ""));

    // Five chips against a badge of six: the sixth kind is the text in the box, which is on
    // screen with the words still in it and is the one filter a chip would only repeat.
    await expect(labels()).toEqual([
      "Colour: White, Blue, Black",
      "Mana value: 1",
      "Set: LEA",
      "Format: Modern",
      "Owned",
    ]);

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove filter — Colour: White, Blue, Black" }),
    );

    // The whole kind went, not one colour of it — and the badge followed.
    await waitFor(async () => {
      await expect(labels()).toEqual([
        "Mana value: 1",
        "Set: LEA",
        "Format: Modern",
        "Owned",
      ]);
    });
    await expect(
      canvas.getByRole("button", { name: "Reset all — 5 filters active" }),
    ).toBeInTheDocument();
  },
};

/**
 * The phone frame, and the two things it has to fake for the sheet to be drawn at all.
 *
 * **`matchMedia`, because the sheet is gated on the *window* rather than on a box.**
 * `useNarrowWindow` asks `window.matchMedia("(max-width: 390px)")` at read time — deliberately,
 * so that a caller can state the width — and a 390px `<div>` inside a 1200px canvas is not a
 * 390px window. Every other query keeps the platform's answer, which is `src/test-viewport.ts`'s
 * rule and not fastidiousness: `motion`'s `useReducedMotion` reads this same API, and a blanket
 * `true` would also tell it the reader had asked for reduced motion.
 *
 * It is patched **in the render body** because `useNarrowWindow` is read during the render of a
 * descendant — a layout effect runs a whole render too late, and the stub reports no `change`
 * event to re-render on. The mount effect re-applies it for `StrictMode`, whose mount → cleanup →
 * mount would otherwise leave the original restored and the story drawn as a desktop; the
 * cleanup is what keeps this out of the next story's world.
 *
 * **`contain: layout`, because `Dialog`'s scrim is a bare `fixed inset-0`.** A layout-contained
 * box is the containing block for every `fixed` descendant under it, so this is what makes the
 * sheet resolve against the phone rather than against the whole canvas. It is the same rule
 * `FilterBar` obeys from the other side — the sheet is mounted *outside* the bar's
 * `@container/fb` precisely so this does not happen by accident there — spent here on purpose.
 *
 * `p-5` is `AppShell`'s `main`, so the 40px of vertical the plan's budget charges is on screen.
 */
const phone = (Story: () => ReactElement) => {
  const original = useRef<typeof window.matchMedia | null>(null);
  const narrow = useRef(((query: string) => {
    if (!query.includes(`${PHONE_PX}px`)) return original.current!(query);
    return {
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia);
  if (original.current === null) {
    original.current = window.matchMedia;
    window.matchMedia = narrow.current;
  }
  useEffect(() => {
    const before = original.current!;
    window.matchMedia = narrow.current;
    return () => {
      window.matchMedia = before;
    };
  }, []);
  return (
    <div
      className="shrink-0 overflow-hidden bg-bg p-5 text-text"
      style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX, contain: "layout" }}
    >
      <Story />
    </div>
  );
};

/**
 * **The strip — what this row is on a phone with the sheet shut, and the whole of 9c's Task 2.**
 *
 * Measured on the device on 2026-08-29 (OnePlus, Chrome 152, portrait): the bar below drew
 * **381px of a 545px content box** and left the wall **99** — 0.42 of a tile row, so a reader saw
 * no whole card. With everything but the box and one button in the sheet it is **44**, and the
 * wall gets **436**: **1.84** rows at the shipped 237px row, which is two whole cards and most of
 * the next two. ⚠️ **Not two rows** — that needs 474 — whatever the option story's 390px-frame
 * arithmetic said.
 *
 * **Every filter in `everything` is on, and since 9c's Task 3 the strip says so in words**
 * (2026-08-29). For one day it said `6` and nothing else — the cost F3 was costed at — and `4` is
 * not a sentence: the failure that shape leaves standing is **Reset all counting a filter the
 * reader cannot see**. So the chips came back, on a scrolling second line with `Reset all` pinned
 * at the end of it, and the strip is **44 at rest and 96 with a filter on** — 1.84 tile rows of
 * wall against 1.62, two whole cards either way.
 *
 * **This story is the 96**, since `everything` turns five kinds on; `PhoneSheet` below is the same
 * strip with the sheet over it, and every unfiltered story on this page is the 44.
 *
 * **What this frame cannot show is the pin.** The strip is `sticky top-0` with `-mx-5 px-5`
 * against `AppShell`'s `main` — and deliberately **without** the `-mt-5 pt-5` twin, which cannot
 * engage in a layout where every page is `flex h-full flex-col` and would eat the last 8px, 4px
 * and 4px of the box above it on three of the four pages that draw this bar. The decorator below
 * is a `contain: layout` box with nothing scrolling inside it, so this is the strip at rest, which
 * is where a reader meets it. The `p-5` on the frame is `main`'s own, so the gutter those classes
 * exist to cover is at least on screen.
 */
export const PhoneStrip: Story = {
  args: { preset: everything, width: "w-full" },
  decorators: [phone],
  parameters: {
    // Its own iframe, for `PhoneSheet`'s reason: this story patches `window.matchMedia` for the
    // length of its own life, and rendered inline that patch would be live while every other
    // story on the docs page rendered.
    docs: { story: { inline: false, height: `${PHONE_HEIGHT_PX + 40}px` } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The first line. The badge on the button is how much is on; the second line below is what.
    await expect(canvas.getByLabelText("Search cards")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Show filters/ })).toHaveTextContent(
      "Filters",
    );

    // The second line, in the reader's own words — five chips against a badge of six, because the
    // sixth kind is the text in the box and a chip would only repeat what is already on screen.
    await expect(
      canvas
        .queryAllByRole("button", { name: /^Remove filter — / })
        .map((b) => b.getAttribute("aria-label")!.replace("Remove filter — ", "")),
    ).toEqual([
      "Colour: White, Blue, Black",
      "Mana value: 1",
      "Set: LEA",
      "Format: Modern",
      "Owned",
    ]);
    // Pinned beside them, not behind the disclosure the chips are about — a Reset all a reader
    // cannot see while looking at what it would undo is the same failure as a count they cannot
    // read.
    await expect(
      canvas.getByRole("button", { name: "Reset all — 6 filters active" }),
    ).toBeInTheDocument();

    // And nothing else — the colours, the mana values, the sort and the layout pair are all in
    // the sheet. `queryByRole` searches the whole canvas, so a control that had merely moved
    // would still be found.
    await expect(canvas.queryByRole("group", { name: "Color identity" })).toBeNull();
    await expect(canvas.queryByRole("group", { name: "Mana value" })).toBeNull();
    await expect(canvas.queryByRole("group", { name: "Result layout" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Sort results" })).toBeNull();
  },
};

/**
 * **The tray as a sheet — every width at or below the phone's, and nowhere else.**
 *
 * Measured on the device on 2026-08-29 (OnePlus, Chrome 152, portrait): the shut bar is 381px of
 * a 545px content box, the wall gets 99 — 0.42 of a tile row — and the *open* tray is **922px**,
 * four times the room there is. So on a phone the tray stops being a panel in the flow and
 * becomes a `Dialog`: `src/CLAUDE.md`'s shape for a surface that is **consulted** rather than
 * worked out of, which is exactly what this one is — a reader opens it, sets a filter, and goes
 * back to the wall.
 *
 * **The height is the shell's existing clamp, not a new prop.** `Dialog`'s only geometry prop is
 * `width`, and the height rule it would be reaching for is already written: the panel's
 * `max-h-full` against the scrim's `grid-rows-[minmax(0,1fr)]`. The tray scrolls inside the panel
 * rather than the panel growing off the bottom of the phone.
 *
 * Every other story on this page is the same component above the phone width, where nothing about
 * this branch renders at all — the row is drawn on five surfaces and four of them have no phone in
 * them.
 */
export const PhoneSheet: Story = {
  args: { preset: everything, width: "w-full" },
  decorators: [phone],
  parameters: {
    // **Its own iframe, and the frame above is why it needs one.** This story patches
    // `window.matchMedia` for the length of its own life; rendered inline, that patch would be
    // live in the preview window while every other story on this docs page rendered, and the
    // whole page would be drawn as a phone. `inline: false` is this repo's answer to exactly that
    // — the `useAppStore` rule in `.storybook/CLAUDE.md`, and `Dialog.stories.tsx`'s scrim — and
    // it is what keeps a world belonging to a story.
    docs: { story: { inline: false, height: `${PHONE_HEIGHT_PX + 40}px` } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTray(canvas);

    const sheet = await canvas.findByRole("dialog");
    // The controls are in the sheet and not in the flow — one tray, mounted in one of two places,
    // never two copies.
    await expect(within(sheet).getByRole("button", { name: "Format" })).toBeInTheDocument();
    await expect(within(sheet).getByRole("button", { name: "All printings" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: "Format" })).toHaveLength(1);
    // And the controls the strip shed are in here with it — the colours, the mana values, the
    // sort and the layout pair. One copy of each: the row is mounted here instead of in the flow,
    // never in both.
    await expect(within(sheet).getByRole("group", { name: "Color identity" })).toBeInTheDocument();
    await expect(within(sheet).getByRole("group", { name: "Mana value" })).toBeInTheDocument();
    await expect(within(sheet).getByRole("group", { name: "Result layout" })).toBeInTheDocument();
    await expect(within(sheet).getByRole("button", { name: "Sort results" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("group", { name: "Color identity" })).toHaveLength(1);

    // **The stated filters are not among them, since 9c's Task 3.** They are the strip's second
    // line, on the other side of this scrim, and so is `Reset all` — one copy of each, because two
    // mounted `ResetAll`s are two tab stops and two accessible names for one control. Asserting
    // the *absence* here is the assertion: `canvas.getByRole` searches the whole frame, so the
    // presence of a chip somewhere would pass in both worlds.
    await expect(within(sheet).queryAllByRole("button", { name: /^Remove filter — / })).toEqual([]);
    await expect(within(sheet).queryByRole("button", { name: /^Reset all/ })).toBeNull();
    await expect(canvas.getAllByRole("button", { name: /^Reset all/ })).toHaveLength(1);
    await expect(canvas.getAllByRole("button", { name: /^Remove filter — / })).toHaveLength(5);
    // The search box stays on the bar behind it — Task 2's strip is what it becomes, and this
    // story is what that task sheds into.
    await expect(sheet).not.toContainElement(canvas.getByLabelText("Search cards"));
  },
};
