import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CollectionFilterBar } from "./CollectionFilterBar";
import { useCollection, type Collection } from "./useCollection";

/** What a story switches on before the rows are first drawn. Applied once; see {@link CollectionFilters}. */
type Preset = (collection: Collection) => void;

/**
 * The widths the app really gives these two rows.
 *
 * `AppShell` is a `w-52` sidebar (13rem = 208px, `AppShell.tsx:92`) beside a `main` with `p-5`
 * (20px a side, `AppShell.tsx:144`), so the rows get the window less 248px — before any
 * scrollbar, which `main`'s `overflow-auto` may add. `tauri.conf.json:16` opens the window at
 * 1280, which is 1032 here; `tauri.conf.json:18` will not let it below 1024, which is 776.
 *
 * There is no narrow home to add to that pair, unlike the search's row: `CollectionPage.tsx:410`
 * draws this above the split that the card detail pane docks into, so the pane takes width from
 * the table below and never from this.
 */
const AT_1280 = "w-[1032px]";
const AT_MIN_WIDTH = "w-[776px]";

/**
 * `CollectionFilterBar` over the **real `useCollection`**, with a story's opening filters
 * applied through the hook's own setters.
 *
 * The search row's wrapper, for its reasons (`FilterBar.stories.tsx`): a hand-built `Collection`
 * would be a second copy of eight toggle rules plus the arithmetic behind the Reset all badge
 * (`activeFilterCount`, `useCollection.ts:84`), and it would have to reproduce `sortSelection`'s
 * three-way answer as well — which is what {@link CustomSort} is about, and exactly the kind of
 * derived value a fixture gets subtly wrong while every story stays green.
 *
 * The preset lands in an effect, once, because `useCollection` takes no initial state and a
 * `play` would leave the docs page showing six untouched rows (Storybook does not autoplay
 * there). The guard is a ref rather than a dependency array: the dependency would be
 * `collection`, a new object every render.
 */
function CollectionFilters({
  preset,
  width = AT_1280,
}: {
  preset?: Preset;
  /** A Tailwind width class for the box the rows have to fit in — the subject of
   *  {@link NarrowestWindow}, and a live control on every other story. */
  width?: string;
}) {
  const collection = useCollection();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !preset) return;
    applied.current = true;
    preset(collection);
  });
  return (
    <div className={width}>
      {/* `+ New folder` opens a layer the *page* owns and this workbench does not hold, so the
          press is reported rather than acted on — the same trade every other write-shaped prop in
          this file makes. */}
      <CollectionFilterBar collection={collection} onNewFolder={fn()} />
    </div>
  );
}

/**
 * All eight kinds of filter this view offers, on at once.
 *
 * Eight and not six: the collection asks three questions a search cannot — what the copy is
 * (finish), what state it is in (condition), and whether a sync left a question against it —
 * and gives up the search's `owned`, which is a statement about the collection it *is*.
 *
 * Three colours rather than one, because the badge counts kinds and not values. All three are
 * coloured: `toggleColor` refuses to mix `C` with a colour (`useCardSearch.ts:125-129`, which
 * this hook imports rather than reimplements).
 */
const everything: Preset = (collection) => {
  collection.setText("bolt");
  collection.setFormat("modern");
  for (const key of ["W", "U", "B"] as const) collection.toggleColor(key);
  collection.toggleManaValue(1);
  collection.toggleSet("lea");
  collection.toggleFinish("foil");
  collection.toggleCondition("LP");
  collection.toggleNeedsReview();
};

const meta = {
  title: "Collection/FilterBar",
  // The wrapper, not `CollectionFilterBar` — see `FilterBar.stories.tsx`'s meta for why, which
  // is the same reason: typing this file over the component would demand a whole `Collection`
  // object as a story arg.
  component: CollectionFilters,
  tags: ["autodocs"],
  argTypes: { preset: { table: { disable: true }, control: false } },
  parameters: {
    docs: {
      description: {
        component:
          "Every filter the collection view offers, in **two** rows, and the line between them " +
          "is a real one: the first holds what is *printed on the card* — its name, its " +
          "colours, its cost, its set, in the same order and the same controls as the search's " +
          "row — and the second holds everything that is about a card without being on it.\n\n" +
          "Thirty controls in one `flex-wrap` would break wherever they happened to run out of " +
          "window, which is how a filter row ends up with a lone format picker stranded on a " +
          "line of its own. Both containers still wrap (`CollectionFilterBar.tsx:37` and " +
          "`:72`); the split decides *where* the first break falls.\n\n" +
          "**Nothing here is a hand-written filter state.** Each story presses its opening " +
          "filters through the real `useCollection`, so the Reset all badge is the real " +
          "`activeFilterCount`, the sort select shows the real `sortSelection`, and Reset all " +
          "clears exactly what the hook clears.",
      },
    },
  },
} satisfies Meta<typeof CollectionFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing filtered: the rows a reader arrives at.
 *
 * Two controls are on and neither is a filter. The sort select is **never gold** — a sort is
 * always on, there is no unsorted, so a state colour there would say "a filter is active" about
 * a control that cannot be inactive — and the layout pair is the collection's own, not the
 * search's, which is why the two views can open on different layouts.
 *
 * All three `<label>`s on these rows are `sr-only` — the search box, the format select and the
 * sort select — so the assertions below are the only way to see them.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Search your collection")).toHaveAttribute(
      "placeholder",
      "Search your collection…",
    );
    await expect(canvas.getByLabelText("Format")).toHaveValue("");
    // An empty sort spec reads as the default it is — name order — rather than as "Custom…".
    await expect(canvas.getByLabelText("Sort")).toHaveValue("name");
    // Drawn and dead rather than absent: a Reset that arrived on the first press would take
    // its width out of the `flex-1` search box and slide the row being pressed.
    await expect(canvas.getByRole("button", { name: /^Reset all/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // The condition grades are drawn as abbreviations and *spoken* as words: `DMG` is
    // vocabulary, and five spelled-out grades are 400px of chrome above the table they filter.
    await expect(canvas.getByRole("button", { name: "DMG, damaged" })).toHaveTextContent("DMG");
  },
};

/**
 * Three kinds on, two of them from the second row.
 *
 * Foil and Lightly played are the two filters a search cannot offer at all: they are questions
 * about the copy in the binder rather than about the card that was printed.
 */
export const ActiveFilters: Story = {
  args: {
    preset: (collection) => {
      collection.setText("bolt");
      collection.toggleFinish("foil");
      collection.toggleCondition("LP");
    },
  },
};

/**
 * All eight kinds at once — the fullest these rows get, at the app's own width.
 *
 * The badge reads **8** with three colour chips pressed, which is the whole of "kinds, not
 * values": the number captions a button that is about to clear all of it, and its job is to say
 * how much is about to change.
 *
 * The needs-review chip is the second of the two three-state controls in the app (the search's
 * Owned is the other), and its *label* is what says which state is on: pressed it reads "Needs
 * review", pressed again "Not flagged", and off it is back to "Needs review" unpressed. One
 * press from the preset lands it on the first of those.
 */
export const AllFiltersActive: Story = {
  args: { preset: everything },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // `findBy` on the first query: the preset lands in an effect, so this waits for the render
    // it caused — **and it waits on the count**, because the button itself is drawn from the
    // first render, so a bare `/^Reset all/` would resolve against the rows before the preset.
    // The badge is drawn rather than spoken; the name carries the count in words.
    await expect(
      await canvas.findByRole("button", { name: "Reset all — 8 filters active" }),
    ).toHaveTextContent("8");
    for (const colour of ["White", "Blue", "Black"]) {
      await expect(canvas.getByRole("button", { name: colour })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    await expect(canvas.getByRole("button", { name: "Needs review" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/**
 * Reset all, and the one control on these rows it deliberately leaves alone.
 *
 * `resetAll` clears eight filters and **not the sort** (`useCollection.ts:301-310`) — how the
 * reader reads is not what they are looking at — so this story arrives with a sort of "Highest
 * price" and still has it afterwards. That is the assertion worth having: the sort surviving is
 * invisible next to eight controls going grey, and a reset that took it with them would look
 * exactly the same in a screenshot.
 *
 * On the docs page this renders in its opening state, filters and all, because Storybook does
 * not autoplay stories there.
 */
export const Cleared: Story = {
  args: {
    preset: (collection) => {
      everything(collection);
      collection.setSortKey("price");
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByLabelText("Sort")).toHaveValue("price");

    const reset = canvas.getByRole("button", { name: /^Reset all/ });
    await userEvent.click(reset);

    // Still under the cursor that pressed it, greyed rather than gone.
    await expect(reset).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByLabelText("Search your collection")).toHaveValue("");
    await expect(canvas.getByLabelText("Format")).toHaveValue("");
    await expect(canvas.getByRole("button", { name: "Foil" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "LP, lightly played" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(canvas.getByRole("button", { name: "Needs review" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The survivor.
    await expect(canvas.getByLabelText("Sort")).toHaveValue("price");
  },
};

/**
 * A sort the select has no option for, and the word it puts in its own box for it.
 *
 * Four of the seven sortable columns are on the select; **Value and Finish are not**, because
 * the select's five entries are named for what they answer rather than for a column — "Highest
 * price" is the *unit* price, while the Value header sorts by unit × copies, which is the
 * figure that cell prints. Pressing either of those two headers therefore leaves `sortSelection`
 * as `""` (`useCollection.ts:283-287`), and the select renders a disabled "Custom…" it can be
 * read but not chosen from.
 *
 * Present at all because a `<select>` showing nothing looks broken, and disabled because
 * picking it would be picking the sort you already have.
 *
 * It sits **above** the five, outside the alphabetical order they are drawn in
 * (`lib/options.ts`): it says what the control is doing rather than naming an order to pick,
 * so it belongs where the reader is already looking. Alphabetically it would land first today
 * as well — which is the reason to pin it rather than to trust that.
 */
export const CustomSort: Story = {
  args: { preset: (collection) => collection.toggleSort("value", false) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sort = await canvas.findByLabelText("Sort");
    await expect(sort).toHaveValue("");
    // Both halves of the claim: the option exists, and it cannot be picked. Neither is legible
    // in a screenshot of a `<select>` that simply reads "Custom…".
    const custom = within(sort).getByRole("option", { name: "Custom…" });
    await expect(custom).toBeDisabled();
    // And the five real orders are still all there to switch to — as a sequence rather than
    // a count, because the order they are drawn in is the claim above and a length of 6 is
    // equally true of the constant passed straight through.
    await expect(
      within(sort)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Custom…",
      "Highest price",
      "Most copies",
      "Name",
      "Recently added",
      "Set and number",
    ]);
  },
};

/**
 * The narrowest window the app can be put in: 1024 wide, leaving these rows 776px.
 *
 * Both containers wrap, so the second row is where the break shows first — it carries the
 * format select, three finish chips, five condition grades, the flag chip, the sort select,
 * Reset all and the layout pair.
 */
export const NarrowestWindow: Story = {
  args: { preset: everything, width: AT_MIN_WIDTH },
};
