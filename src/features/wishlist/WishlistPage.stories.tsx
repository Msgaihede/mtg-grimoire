import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import { useAppStore, type SearchView } from "@/lib/store";
import { WishlistPage } from "./WishlistPage";

/**
 * The page, with the layout the store would be holding when a reader arrives at it.
 *
 * `wishlistView` lives in the store — where `"grid"` is the app's own default, because these are
 * cards the reader does not have yet and the picture is how you recognise what you are about to
 * buy — and `WishlistPage` reads it directly, so a story cannot pass it as a prop. `useState`'s
 * lazy initializer is `CollectionPage.stories.tsx`'s answer to that and for its reason: an effect
 * runs after the first paint, so a table story would render the wall for one frame first.
 *
 * **`"grid"`, not `"card"`.** The store's type is `SearchView = "table" | "grid"`, shared with
 * the other two lists; "card mode" is what the filter bar's toggle *calls* it — `LayoutToggle`'s
 * two buttons are named "Card view" and "Table view".
 *
 * **`flatten` is the second store field, and it is seeded here even though this page's default did
 * not move.** It used to be `useState` inside `useWishlist`; it is `wishlistFlattened` now, so it
 * outlives a story the way the layout does — and `CollectionPage.stories.tsx`'s copy of this note
 * carries the reason the two pages disagree about the default (that cabinet's root was narrowed to
 * "filed nowhere" and this one's was not). Written out rather than left implicit, so a story about
 * the cabinet cannot be quietly emptied by a default moving one file away. There is no setter to
 * call — the store publishes a **toggle** — so the seed is a plain `setState`, which deliberately
 * does not bump `flattenPulse` and so writes nothing back through `useFlattenPersistence`.
 */
function Page({ view, flatten }: { view: SearchView; flatten: boolean }) {
  useState(() => {
    useAppStore.getState().setWishlistView(view);
    useAppStore.setState({ wishlistFlattened: flatten });
  });
  return <WishlistPage />;
}

const meta = {
  title: "Wishlist/Page",
  component: Page,
  tags: ["autodocs"],
  // The app's own opening state for both: the wall, and the cabinet rather than the flat list.
  args: { view: "grid", flatten: false },
  // Keyed on both, so changing either in Controls remounts and the initializer above runs again
  // rather than writing to a store the mounted page is already subscribed to.
  render: (args) => <Page key={`${args.view}:${String(args.flatten)}`} {...args} />,
  decorators: [
    // The page is `h-full`, so it needs a parent with a height or the virtualiser is handed a
    // 0px window. 1032px is the content column at a **1280-wide** window: 1280 less the
    // sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px). Not the window
    // `tauri.conf.json` opens — that one is wider, and a story drawn at it would never show
    // the wall at the width the app's 1024px floor says it has to survive. The height is
    // chosen rather than derived: the ribbon above it is not a fixed number of pixels.
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      /**
       * **Each story on this page gets its own frame**, which is the one thing that gives it its
       * own `useAppStore`.
       *
       * Every story in this file writes `wishlistView` during render, and the store is a module
       * singleton that `.storybook/` cannot make per-story. Inline, an autodocs page mounts every
       * story at once and the last one to render would own the store for all of them — every
       * story below showing the same layout, and reading as a component that ignores its
       * arguments. `CollectionPage.stories.tsx` carries the long form of this note.
       */
      story: { inline: false, height: "680px" },
      description: {
        component:
          "The thin mirror of the collection: a shopping list, not an inventory — drawn as a " +
          "wall of art or as a table, and **it opens on the wall**, which is where it agrees " +
          "with the search rather than with the collection. These are cards the reader does not " +
          "have yet and may never have held, so the picture is how you recognise the thing you " +
          "are about to buy; the table is a press away for the trip where the question is what " +
          "it all costs.\n\n" +
          "Driven end to end by `.storybook/fake/`. `starterWishes` seeds **eight wishes: five " +
          "loose at the root and three filed into the three folders of `starterWishFolders`** " +
          "— so what every story here opens on is the root, and the filed three are behind a " +
          "folder card ({@link Folders}) or one press of Flatten away ({@link Flattened}).\n\n" +
          "**The five at the root are five different answers to “is this filled?”**, and every " +
          "one of them is arithmetic the fake really does rather than a number written into a " +
          "fixture — `wishlist::OWNED_SQL` is mirrored by `db.ts`'s `ownedAgainstWish`. Measured " +
          "2026-08-10 over " +
          '`readHandlers(seed("starter")).wishlist_list`: Counterspell 2 of 4, Jace 0 of 1, ' +
          "the **foil** Ragavan 0 of 1 with a nonfoil in the binder, Rhystic Study 0 of 1, and " +
          "the any-printing Sol Ring **2 of 1** — fulfilled twice over, because a wish naming no " +
          "printing is filled by every printing of the card.\n\n" +
          "**Zero deletes here, and every stepper on the page can now reach it.** " +
          "`wishlist_set_quantity(0)` removes the row — the fake's handler mirrors " +
          "`wishlist_entries`' own `CHECK (quantity > 0)` — because a wish for none of " +
          "something is not a wish. The floor was `min={1}` until issue #284, on the argument " +
          "that a stepper deleting a row when held down is a one-way door with no undo; what " +
          "overruled it is that a collection entry has deleted at zero since schema v24 and its " +
          "steppers have always been `min={0}`, so one gesture meant two different things on " +
          "two lists a press apart. All three places a wish's number is drawn — the tile's " +
          "stepper ({@link CopiesFromATile}), the table's cell and the pencil's panel " +
          "({@link EditingFromATile}) — floor at zero together. **Removal keeps its own named " +
          "control**, which is the route that says the word rather than the one a held button " +
          "arrives at: {@link Removed} is the story of it.\n\n" +
          "**It has a docked card search on its right since 2026-09-07** " +
          "({@link WithSearchColumn}), which is what closed the sentence this page's own empty " +
          "state used to end on — *“Add cards from search with the + on any row or tile”*, a view " +
          "sending the reader to another route to fill the list it is about. The column is " +
          "`WishlistSearchPanel` and is storied in full at `Wishlist/SearchPanel`; every `+` in " +
          "it files into **the drawer on screen**, and a tile dropped on a folder card files " +
          "there instead. Two `FilterBar`s are therefore mounted together on this page, told " +
          "apart by their boxes' names — `Search your wishlist` against `Search cards`.\n\n" +
          "**There is no `Large` story, and that is a fact about the seeds rather than about " +
          'this page.** `seed: "large"` builds 5 243 cards and 600 collection entries and ' +
          "**no wishes at all** — `largeSeed` says so in as many words, and " +
          "`wishlist_list` answers `total: 0` under it (measured 2026-08-10). A story named " +
          "`Large` would render the zero state {@link Empty} already covers, under a name " +
          "promising depth. Closing it means seeding wishes into `largeSeed`, which is a change " +
          "to a fixture every other story file reads.",
      },
    },
  },
} satisfies Meta<typeof Page>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The docked search column's `<section>`, by the name only it answers to. */
const PANEL_LABEL = "Add cards to your wishlist";

/**
 * The **page's own** copy of a control the sidebar draws too.
 *
 * Two `FilterBar`s are mounted on this page since 2026-09-07, and `FilterBar` names its own
 * controls — so `Show filters` and `Sort results` are each on screen twice. That is not a bug in
 * either row (a control means the same thing wherever it appears); what it means is that a play
 * reaching for one has to say which column it is about. The boxes themselves are already distinct
 * (`Search your wishlist` against `Search cards`), which is `FilterLabels`' whole reason.
 */
const pageControl = (canvas: ReturnType<typeof within>, name: RegExp | string): HTMLElement => {
  const found = canvas
    .getAllByRole("button", { name })
    .find((el: HTMLElement) => el.closest(`[aria-label="${PANEL_LABEL}"]`) === null);
  if (!found) throw new Error(`no page-side control named ${String(name)}`);
  return found;
};

/**
 * Five wishes, and the one number the view exists for.
 *
 * The total is counted over what each wish **wants**, which reverses what this story asserted
 * until 2026-09-08: it was summed over what was still missing, on the argument that a figure
 * charging the reader for cards already in the binder is a number nobody can act on. That
 * argument assumed the list knew what was in the binder, and it no longer asks. So $163.96 is all
 * four Counterspells plus Jace plus the foil Ragavan plus Rhystic Study.
 *
 * **And the unpriced note is on screen here now**, which is the same reversal from the other end:
 * the seed's Sol Ring has no price, and it used to be left out of the count because the binder
 * already covered it — a wish with nothing left to buy being nothing for a "could not price" note
 * to qualify. Every wish is a wish to buy now, so the one nobody quoted is counted.
 *
 * **One tile, not the two this story used to assert.** The page drew `Still to buy (USD)` beside
 * `Still to buy (EUR)` while there was no way for a reader to say which they were shopping in;
 * the marketplace setting is that way, so the figure follows it and the label carries the
 * currency. There is no euro node on screen here at all — this is the default world, which is
 * TCGplayer. The euro arithmetic is covered where it can be asserted against a chosen
 * marketplace rather than a world default: `WishlistPage.test.tsx`, and
 * `Collection/SummaryHeader`'s `InEuros`, whose header takes its marketplace as a prop.
 *
 * The unpriced counters stay two fields behind it, because the two currencies do not have the
 * same holes — `eur_etched` does not exist in Scryfall's data, so the same card can be priced in
 * dollars and unpriced in euros.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("$163.96")).toBeInTheDocument();
    await expect(canvas.getByText("Total cost (USD)")).toBeInTheDocument();
    await expect(canvas.getByText("1 unpriced")).toBeInTheDocument();
    await expect(canvas.queryByText("€94.62")).not.toBeInTheDocument();

    // Five wishes, five tiles. One per **wish** and never per card, which is the reverse of the
    // collection's wall: there two entries for one printing are one piece of art, and here a
    // foil wish and a nonfoil wish are two wishes with two prices.
    await expect(canvas.getByRole("group", { name: "Your wishlist" })).toBeInTheDocument();
    // How many copies the reader wants, in the tile's bottom-left corner. It read `2/4` — owned
    // over wanted — until 2026-09-08.
    await expect(canvas.getByText("×4")).toBeInTheDocument();

    // The one thing a picture must not settle: Sol Ring's wish names no printing, so it is drawn
    // as one — the newest of its oracle card — and captioned as what it actually is.
    await expect(canvas.getByText("Any printing")).toBeInTheDocument();

    // **The Needs review cell is behind the Filters disclosure**, with everything else this row
    // does not keep on the bar — so a shut tray is the state the page opens in and nothing on
    // screen carries that name. It used to be a chip drawn only where there was something to
    // filter; `WISHLIST_TRAY` in `WishlistPage.tsx` says why that rule did not survive the move.
    await expect(canvas.queryByRole("button", { name: "Needs review" })).toBeNull();
    await expect(pageControl(canvas, /^Show filters/)).toBeInTheDocument();
  },
};

/**
 * The same five wishes as a list — the layout for the trip where the question is what it all
 * costs, and where six columns of facts beat six pieces of art.
 *
 * It is one press from {@link Default} and one press back; nothing else about the list changes,
 * which is the whole claim these two stories make together. The header above them is the same
 * header, and the wishes are the same wishes.
 */
export const Table: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // What assistive tech is told the list is: every matching row plus the header
    // (`VirtualTable.tsx:181`), not the rows a virtualised list keeps in the DOM. A wishlist
    // total is counted in full, so there is no unknown-count case here — unlike the search's.
    await expect(await canvas.findByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "6",
    );
    // The Wanted column's stepper, which is what the table says about copies now: it drew an
    // `Owned` column reading `2 of 4 owned` beside it until 2026-09-08.
    await expect(
      canvas.getByRole("spinbutton", { name: /Copies wanted of Counterspell/ }),
    ).toHaveValue(4);
    await expect(canvas.queryByText(/owned/i)).toBeNull();
  },
};

/**
 * The cabinet, and the one arithmetic a folder card cannot get from the read it is drawn from.
 *
 * `wishlist_folder_summary` answers **direct** counts — this folder’s own wishes, never its
 * sub-folders’ — so the page sums a node’s children on the way up, the same arithmetic
 * `buildFolderTree` already does for a deck folder’s `count`. `Ordered` is the seed that makes
 * that visible: two wishes of its own and a sub-folder holding a third, so a card reading its
 * summary row raw would say **2** over a drawer holding three.
 *
 * `Someday` is the other half of it. An empty folder has no summary row **at all**, because that
 * read groups the wishes — so a card fed a raw `Map.get` renders nothing at all here, and the
 * default that turns a missing key into zeros is what draws “0 wishes”.
 *
 * Drilling in replaces the level rather than filtering it: `wishlist_list` takes the folder, so
 * the root’s five wishes go, `Ordered`’s two arrive, and the header above counts what is on
 * screen rather than the whole list.
 *
 * **`New folder` is the wall’s first tile**, where it used to be a button in a row beside the
 * breadcrumb. A reader looking for a drawer is already looking at the wall, so the drawer that is
 * not there yet belongs in the same place — and it is drawn among the folders of *this* level,
 * which is where it would file the new one. `NewFolderCard` carries the visual argument: a folder
 * card’s footprint exactly, and solid-bordered where every card beside it is dashed, because the
 * dash means “provisional container” on every screen in this app and a button is not one.
 *
 * **Pressing it names the folder in the tile itself** ({@link NamingAFolder}), and a folder card’s
 * `Rename…` does the same thing on that card. Nothing opens above the wall for either — the strip
 * that used to is down to the two questions no 62px tile can hold, `Move to folder…` and
 * `Delete…`.
 */
export const Folders: Story = {
  // The cabinet is the subject, and no wall is drawn at all while the list is flattened.
  args: { flatten: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Three seeded folders, two of them at the root — and the recursive total on the one that
    // holds a sub-folder.
    const ordered = await canvas.findByRole("button", { name: /^Ordered folder, 3 wishes/ });

    // First in the wall, asserted by position: a tile appended after the drawers is a control a
    // reader has to scroll the band to find, and not having to is the whole of the move.
    const wall = canvas.getByRole("list", { name: "Folders" });
    const cards = within(wall).getAllByRole("listitem");
    await expect(
      within(cards[0]).getByRole("button", { name: "New folder" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Someday folder, 0 wishes" }),
    ).toBeInTheDocument();

    await userEvent.click(ordered);

    // The breadcrumb names where the reader is standing, and the last segment is not a link.
    const trail = await canvas.findByRole("navigation", { name: "Wishlist folders" });
    await expect(within(trail).getByText("Ordered")).toHaveAttribute("aria-current", "page");
    await expect(
      await canvas.findByRole("button", { name: /^Backordered folder, 1 wish/ }),
    ).toBeInTheDocument();

    // The level, not a filter over the whole list: the root’s wishes are not here.
    await waitFor(async () => {
      await expect(canvas.queryByText("Ragavan, Nimble Pilferer")).toBeNull();
    });
  },
};

/**
 * **A cabinet with nothing in it — and the one tile that can change that.**
 *
 * This is the state every reader meets first, and until `New folder` moved into the wall it was
 * the state the wall was *not* drawn over: the band was gated on "this level holds drawers", which
 * was free while the button sat in a row of its own and became a trap door the moment it did not.
 * A wishlist nobody has filed would have had no folder card, therefore no wall, therefore no way
 * to make a first folder — a cabinet only somebody who already had one could open. The gate is
 * `!flatten` now, and {@link Flattened} is the other end of it.
 *
 * `seed: "empty"` is the only seeded world with no wishlist folders in it, so it is also the only
 * one that can show this. The page draws the tile alone, at a folder card's own height —
 * `FOLDER_CARD_HEIGHT`, the measured `min-h` that stops the band collapsing to a 20px strip when
 * there is no card beside it to stretch against — and no breadcrumb at all, because there is no
 * trail and nowhere for it to lead.
 *
 * **The floor lives in `FolderNameField` now rather than in `NewFolderCard`, and this story is
 * why it had to move**: the tile *becomes* the field when it is pressed, so a field sized only by
 * its own content would shrink the wall the moment a reader used it — and here, with nothing else
 * in the wall to stretch against, there would be nothing to hide it.
 */
export const EmptyCabinet: Story = {
  // {@link Folders}' reason: flattened there is no wall, so the trap door this story guards
  // would be invisible rather than closed.
  args: { flatten: false },
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const wall = await canvas.findByRole("list", { name: "Folders" });
    await expect(within(wall).getAllByRole("listitem")).toHaveLength(1);
    await expect(canvas.queryByRole("navigation", { name: "Wishlist folders" })).toBeNull();

    // And it reaches something: a tile over an empty wall that opened nothing would look right in
    // every screenshot and still be the trap door.
    await userEvent.click(within(wall).getByRole("button", { name: "New folder" }));

    // The tile *is* the field — asserted by containment rather than by finding an input somewhere
    // on the page, which is what a field back in a strip above the wall would also satisfy.
    const field = await canvas.findByLabelText("New folder name");
    await expect(within(wall).getAllByRole("listitem")[0]).toContainElement(field);
    // Nothing above the wall says which level this is. The strip printed `in Wishlist` here, for a
    // reader who could not see which level it was drawn over; the wall the field stands in is that
    // sentence now.
    await expect(canvas.queryByText("in Wishlist")).toBeNull();
  },
};

/**
 * **The field the tile becomes**, drawn where the folder it is naming will be.
 *
 * This is the state a screenshot of the wall could not previously show, because the field was
 * never in the wall: pressing `+ New folder` opened a bordered strip under the breadcrumb with an
 * input, `Create folder` and `Cancel` in words, and a line reading *in Wishlist*. Every one of
 * those re-established a context the reader could already see — the level is the wall they are
 * looking at, and the thing being named is going to appear in it — so the strip said, at the size
 * of a second panel, what the wall says by being on screen.
 *
 * What is worth looking at here rather than reading: the name is typed **on the line the folder's
 * name will occupy**, at the same track and the same footprint, so nothing reflows when the field
 * opens and nothing moves when it closes; ✓ and ✕ take the corner a folder card gives its `⋯`,
 * which is the one place on a card a reader has been taught to find its controls; and the tile
 * keeps its **solid** border while the drawers beside it stay dashed, because it is still a
 * control holding no folder yet. `FolderNameField` has the whole argument and its own stories
 * carry the field's states; what only this page can show is the field *in the wall*, with the
 * drawers it will stand beside on either side of it.
 */
export const NamingAFolder: Story = {
  // {@link Folders}' reason — there is no wall to draw the field in while the list is flattened.
  args: { flatten: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: /^Ordered folder/ });

    const wall = canvas.getByRole("list", { name: "Folders" });
    await userEvent.click(within(wall).getByRole("button", { name: "New folder" }));

    const field = await canvas.findByLabelText("New folder name");
    const cards = within(wall).getAllByRole("listitem");
    // In the tile's own `<li>` — the claim a query that only found the input would pass without,
    // since a field back in a strip above the wall is also "on the page".
    await expect(cards[0]).toContainElement(field);
    // The control it replaced is out of the tree rather than sitting behind the field: two ways to
    // start naming one folder is one of them doing nothing.
    await expect(within(wall).queryByRole("button", { name: "New folder" })).toBeNull();
    // And the drawers are still drawers — one field is open at a time across the whole wall.
    await expect(
      within(cards[1]).getByRole("button", { name: /^Ordered folder/ }),
    ).toBeInTheDocument();
  },
};

/**
 * Flatten — every wish at once, wherever it is filed.
 *
 * The switch is not a filter and `resetAll` never touches it: it says how much of the tree is on
 * screen — which is why it rides the **filter bar** past that row’s second hairline, beside the
 * grid-or-table pair, where every control is about how the list is drawn rather than which rows
 * are in it. The breadcrumb stayed down with the cabinet, because where the reader is standing is
 * a place rather than a way of drawing.
 *
 * While it is on the whole wall goes — no folder card, no drill-down and no “New folder” tile,
 * the last because it lives *in* that wall now and a flattened list has no current folder to
 * create one inside. Every wish is captioned with the folder it is in instead, because without
 * that the flattened list is just the old list with more rows in it.
 *
 * Eight rows plus the header, which is the whole of `starterWishes`: the five at the root and the
 * three the folder cards were standing in front of.
 */
export const Flattened: Story = {
  // Off to begin with, so the press below is a real flip rather than whatever the store was
  // holding. It is also this page's default — said out loud because the collection's is not.
  args: { view: "table", flatten: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Counterspell");
    await expect(canvas.getByRole("button", { name: /^Ordered folder/ })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Flatten" }));

    await waitFor(async () => {
      await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
        "aria-rowcount",
        "9",
      );
    });
    await expect(canvas.queryByRole("button", { name: /^Ordered folder/ })).toBeNull();
    // The list itself, not only the cards in it: the tile is an `<li>` of this `<ul>`.
    await expect(canvas.queryByRole("list", { name: "Folders" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "New folder" })).toBeNull();

    // Where each one is filed, in the caption beside its printing — `Wishlist` for the root.
    await expect(canvas.getAllByText("Filed in").length).toBeGreaterThan(0);
  },
};

/**
 * Everything else a wish can be edited into, from a tile.
 *
 * The panel is the tile's answer to a 170px caption: which printing, which folder, and the named
 * removal, in the same anchored popup the search wall's quick-add hangs off — opening from the
 * tile's left edge so the first column's panel is not clipped by a scroller that cannot be
 * scrolled left. **It is the only route to two of those writes**, and on an any-printing wish it
 * is the only route to any of them, which is why the pencil is drawn on every tile.
 *
 * **The number is no longer among them alone.** It is still here, and it is now also on the tile
 * in front of the pencil ({@link CopiesFromATile}) — the same control, the same accessible name
 * and the same floor, because a wish's copy count is one write however the reader reaches it.
 *
 * The stepper here is the table's stepper, `min={0}` included: zero deletes a wish, and since
 * issue #284 that is a press the reader may make rather than a floor the UI holds them above.
 * Removal is still the press at the foot of the panel, offered on every wish — crossing a line
 * off a shopping list is what a shopping list is for, and it is the route that says so in words.
 */
export const EditingFromATile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Edit Counterspell .* on your wishlist/ }),
    );

    const panel = await canvas.findByRole("dialog", { name: "Edit Counterspell" });
    await expect(
      within(panel).getByRole("spinbutton", { name: "Copies wanted of Counterspell (MH2 267)" }),
    ).toHaveValue(4);
    await expect(
      within(panel).getByRole("button", { name: /Remove Counterspell .* from your wishlist/ }),
    ).toBeInTheDocument();
  },
};

/**
 * **How many copies, changed on the tile** — issue #284, and the half of the wall that was
 * missing.
 *
 * The table has always edited the number in place, because a shopping list is where the number
 * of copies is *maintained*. The wall drew the pencil and nothing else, so the same change cost
 * three presses on one drawing of the list and one on the other. The stepper is `size="xs"` over
 * the art beside the pencil, `tone="art"` for the backing that keeps a 1px outline legible over
 * an illustration, and `focus="inset"` because the frame it stands in clips its own corners.
 *
 * Counterspell is the subject because it is the seeded root wish with a number to move in both
 * directions — 4 wanted against 2 owned. Rhystic Study is the other half of the story at 1,
 * which is where the floor is worth looking at: since issue #284 its `Decrease` is **live**
 * rather than greyed, and the press it would take is the removal
 * (`wishlist_set_quantity(0)` → `remove_wish`). This play stops short of making it — a wish
 * leaving the list is {@link Removed}, which drives the control that says the word.
 *
 * Both controls live in `CardGrid`'s action strip, which is revealed on hover and on
 * focus-within and is **never removed from the tab order**: "visible on hover" is not a state a
 * keyboard has, which is also why `userEvent` reaches them here with no hover of its own.
 */
export const CopiesFromATile: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const counterspell = "Copies wanted of Counterspell (MH2 267)";

    await expect(await canvas.findByRole("spinbutton", { name: counterspell })).toHaveValue(4);

    await userEvent.click(canvas.getByRole("button", { name: `Increase ${counterspell}` }));

    // Optimistic on the row's own number and then confirmed by the answer — `patchWish` twice,
    // which is what lets a reader hold `+` without the box computing from a stale value.
    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: counterspell })).toHaveValue(5);
    });

    // The pencil is still beside it, so the printing, the folder and the named removal are all
    // still one press from the tile: the stepper is an addition rather than a rearrangement.
    await expect(
      canvas.getByRole("button", { name: /^Edit Counterspell .* on your wishlist/ }),
    ).toBeInTheDocument();

    // The floor, on the wish already sitting on it. Enabled is the whole assertion — what the
    // press would do belongs to {@link Removed}.
    await expect(
      canvas.getByRole("button", { name: "Decrease Copies wanted of Rhystic Study (PCY 45)" }),
    ).toBeEnabled();
  },
};

/**
 * A flagged wish on the wall — **listed, counted, and asking to be looked at**, which is the rule
 * `needs_review` is written under and therefore something no layout may drop.
 *
 * The table has a band across the row for the reconciler's sentence. A card has corners, so the
 * flag shares the top-left chip with the cost, and the whole sentence rides as its tooltip — the
 * same arrangement the band already makes for its own truncation, since the second half of that
 * sentence is what to do about it.
 */
export const FlaggedOnTheWall: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const flag = await canvas.findByText("Needs review", { selector: "span" });
    // The reconciler's sentence rides as a tooltip now, not a `title` — describing (the default
    // `describes: true`, since nothing else on the tile carries the sentence as text), so the
    // panel carries `role="tooltip"` once hovered.
    await userEvent.hover(flag);
    const reviewTooltip = await canvas.findByRole("tooltip", undefined, {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    await expect(reviewTooltip).toHaveTextContent(
      "Scryfall removed this printing from its database",
    );
  },
};

/**
 * A foil wish reading nothing owned, with a nonfoil of the same printing in the binder.
 *
 * This is why finish is part of what makes two wishes two wishes: the printing column carries
 * set, number **and** finish, because those three together are what identify a wish.
 *
 * **The count that used to prove it is gone.** This story asserted `0 of 1 owned` on the foil
 * wish beside a binder holding one nonfoil Ragavan — `ownedAgainstWish` narrowing by the wish's
 * `preferredFinish`. The wishlist compares itself to the collection nowhere since 2026-09-08, so
 * what is left to assert here is the statement itself: the row says which finish it is for, in
 * words, and no row on this page says anything about the binder.
 */
export const FoilWishUnfilled: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The printing column is the one column here that cannot be given a fixed width and stay
    // honest, because it carries three facts.
    const row = (await canvas.findByText("MH2 · 138 · Foil")).closest('[role="row"]');
    await expect(row).not.toBeNull();
    // The row states the finish and says nothing about the nonfoil Damaged Ragavan sitting one
    // view away in the binder — which the seed still holds, so this is an absence with a fixture
    // behind it rather than one that would pass over an empty collection.
    await expect(within(row as HTMLElement).queryByText(/owned/i)).toBeNull();
    // And the same three ride in the stepper's accessible name, which is the half no screenshot
    // shows: two wishes for one card differ only by printing and finish, so "Copies wanted of
    // Ragavan, Nimble Pilferer" alone would be two identical controls in one list as far as a
    // screen reader or a voice driver is concerned.
    await expect(
      canvas.getByRole("spinbutton", {
        name: "Copies wanted of Ragavan, Nimble Pilferer (MH2 138, Foil)",
      }),
    ).toHaveValue(1);
  },
};

/**
 * **The filter tray offers no way to ask about the collection**, which is what replaced the
 * `FulfilledAndUnfulfilled` story that stood here.
 *
 * That one drove the `Fulfilled` / `Still missing` chip both ways round — one chip, three states,
 * the word on it saying which was on. The chip is gone with every other comparison this list made
 * against the binder: a wishlist is the reader's own, and they take a card off it when they
 * acquire one. A story that merely stopped pressing the chip would prove nothing, so this opens
 * the tray and asserts the absence, alongside a chip that **is** there — without which the play
 * would pass over a tray that failed to open at all.
 */
export const NoCollectionFilter: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Sol Ring");

    // Behind the Filters disclosure since this page started drawing the shared row — the box, the
    // colours, the order and the layout pair are what stay on the bar.
    await userEvent.click(pageControl(canvas, /^Show filters/));

    await expect(canvas.getByRole("button", { name: "Needs review" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Still missing" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Fulfilled" })).toBeNull();
  },
};

/**
 * A shopping list nobody has written on yet.
 *
 * "Nothing on your wishlist yet. Add cards from search with the + on any row or tile." — a
 * statement about the wishlist, naming the control that fills it. `statusOf` chooses it on
 * `activeCount === 0`; with a filter on, the same empty list says "No wishes match these
 * filters", which is a statement about the filters instead.
 *
 * Both money figures read an em dash rather than $0.00 — a list that claims to be worth nothing
 * is worse than one that has not said.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Nothing on your wishlist yet. Add cards from search with the + on any row or tile.",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * A wish a sync left a question against — **listed, counted, and asking to be looked at**.
 *
 * The reconciler walks `wishlist_entries` as well as `collection_entries`, so its sentence is a
 * band under the row it belongs to, drawn across the whole row because it is a sentence and not a
 * column. The row grows by `REVIEW_HEIGHT` and the virtualiser is told so through `extraHeight` —
 * a list told every row is the same height would overlap the one below it by exactly that band.
 *
 * The seeded sentence is `reconcile::flag_deleted`'s, copied verbatim with its date into
 * `.storybook/fake/seeds.ts`’s own seed function. It is the flagged row's *whole* explanation, and the second
 * half of it is what to do about it — which is why the band carries the sentence as a `title` as
 * well, and why a screen reader gets all of it either way.
 *
 * The **Needs review** cell is in the filter tray, which this play opens — it is drawn there
 * whether or not anything is flagged, where the chip it replaces appeared only once something
 * was ({@link Default} is the same page with the tray shut). `WISHLIST_TRAY` carries the reason:
 * a control that comes and goes costs a *row* the reader's attention, and costs a shut tray
 * nothing at all.
 */
export const NeedsReview: Story = {
  args: { view: "table" },
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Scryfall removed this printing from its database on 2026-07-31\./),
    ).toBeInTheDocument();
    // The flag lists and never hides: the five unflagged wishes are still here with it, and the
    // count in the header still counts all six.
    await expect(canvas.getByText("Counterspell")).toBeInTheDocument();
    await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "7",
    );
    await userEvent.click(pageControl(canvas, /^Show filters/));
    await expect(canvas.getByRole("button", { name: "Needs review" })).toBeInTheDocument();
  },
};

/**
 * A write the database refused.
 *
 * `db.ts`'s `BUSY` is `collection::BUSY` verbatim, raised by `refuseIfBusy` at the top of
 * every write handler and by no read handler — which is why the list underneath is untouched.
 * The alert is a `role="alert"` of its own rather than a line folded into the status above it:
 * that one describes the list, and this one describes something the reader just did to it.
 *
 * **Counterspell rather than one of the four wishes at quantity 1, and the reason moved with the
 * floor.** It used to be that `min={1}` left Decrease disabled on those rows, so a press on one
 * would have proved nothing about a refusal. Since issue #284 the floor is `0` and that press
 * lands — but it lands as a *removal*, which is a different write, and a row that is on its way
 * out has no number for the rollback to put back. This story is about a **quantity change**
 * being refused, so it needs a wish with a number to return to: 4.
 *
 * The stepper is optimistic on the row's own number, so this also exercises the rollback:
 * `onError` restores the snapshot `onMutate` took, and the box goes back to 4.
 */
export const Busy: Story = {
  args: { view: "table" },
  parameters: { fake: { fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const label = "Copies wanted of Counterspell (MH2 267)";
    await userEvent.click(await canvas.findByRole("button", { name: `Decrease ${label}` }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "Could not change your wishlist — The card database is busy finishing a sync. " +
        "Try that again in a moment.",
    );
    await waitFor(async () => {
      await expect(canvas.getByRole("spinbutton", { name: label })).toHaveValue(4);
    });
  },
};

/**
 * Crossing a line off the list.
 *
 * **Removal is offered on every row here, where the collection offers it only on an emptied
 * one.** The two lists mean opposite things by deletion: losing a
 * collection entry loses the record of something owned — its condition, its price, the story of
 * where it came from — while crossing a line off a shopping list is what a shopping list is for.
 *
 * The row removed is the any-printing Sol Ring, whose accessible name is the whole of what
 * distinguishes it: `wishLabel` writes "any printing" where a pinned wish writes its set and
 * number, because a wish with no `card_id` is for the *card* and there is no printing to name.
 * (It is also the reason that row is not a drag source and not clickable: there is no printing
 * for a drop or a pane to be about.)
 *
 * The header moves with it. Every page carries the same count of the whole list, so `patchWish`
 * decrements each page's copy — otherwise the figure the *first* page feeds would go on counting
 * a wish that is gone.
 */
export const Removed: Story = {
  args: { view: "table" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Sol Ring");

    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Sol Ring (any printing) from your wishlist" }),
    );

    await waitFor(async () => {
      await expect(canvas.queryByText("Sol Ring")).toBeNull();
    });
    await expect(canvas.getByRole("table", { name: "Your wishlist" })).toHaveAttribute(
      "aria-rowcount",
      "5",
    );
    // A removal that succeeded says nothing: the row going is the whole report.
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * The page as it actually opens since 2026-09-07: **the list and a docked card search sharing one
 * row.**
 *
 * The column is `WishlistSearchPanel`, storied in full at `Wishlist/SearchPanel`; what this story
 * is about is the *page* around it — the row that had to be invented, since this view was
 * `flex-col` from its root down and had nothing to hang a column off.
 *
 * **Three things are being claimed here and only a browser can settle them.** The figures band and
 * the page's own `FilterBar` stay **full width above** the row, because that bar lays itself out in
 * four container bands and taking width off it rearranges the bar rather than shortening it. The
 * list side carries `min-w-0`, without which a flex item cannot shrink below its own min-content
 * and the overhang becomes a horizontal scrollbar across the whole app — `ManaValueChips` shipped
 * exactly that once, at 25px, invisible to the suite and to a screenshot. And the two filter rows
 * are separately addressable, which is what `FilterLabels` exists for: the page's box is
 * `Search your wishlist` and the column's is `Search cards`.
 */
export const WithSearchColumn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const column = canvas.getByRole("region", { name: PANEL_LABEL });
    // **Railed at rest** — `DEFAULT_SEARCH_OPEN` opens only the deck's column and rails the two
    // lists', because this page already draws a `FilterBar` of its own and below 544px the panel
    // is an overlay rather than a rail. Measured at seven widths in the shipped window on
    // 2026-09-07. So the two-filter-rows case below is one this play has to *ask* for, which is
    // the honest reading of it: it is what a reader who wants both sees, not what they arrive to.
    await userEvent.click(within(column).getByRole("button", { name: /card search$/ }));
    await expect(
      await within(column).findByRole("button", { name: /card search$/ }),
    ).toHaveAttribute("aria-expanded", "true");

    // Two rows, two names, and neither reaches the other's field.
    await expect(canvas.getByLabelText(/search your wishlist/i)).toBeInTheDocument();
    await expect(await within(column).findByLabelText("Search cards")).toBeInTheDocument();

    // **The page's own wall, awaited** — it is gated on `wishlist_list` answering, so a synchronous
    // query here asks before there is anything to find. The two walls carry different names by
    // construction rather than by agreement: this one passes `label="Your wishlist"` and
    // `CardSearchBody` passes none, so the column's is `CardGrid`'s default `Search results`.
    const list = await canvas.findByRole("group", { name: "Your wishlist" });

    // Nothing overhangs. Storybook is a real browser, so unlike the suite this is read off the box
    // rather than off a class — and the page's own scroller is what an overhang would reach.
    const row = column.parentElement!.parentElement!;
    await expect(row.scrollWidth).toBe(row.clientWidth);
    await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);

    // And the destination is the page: at the root that is the list's own name, never "no folder".
    // Asked of **one card**, because the column draws a quick-add per tile and the corpus's default
    // browse is 37 of them — a `.+` here is a question with 37 honest answers. `Ancient Tomb` is the
    // row `Wishlist/SearchPanel` and `Decks/SearchPanel` both reach for.
    await expect(
      await within(column).findByRole("button", {
        name: /^Add Ancient Tomb \(.+\) to Wishlist$/,
      }),
    ).toBeInTheDocument();
  },
};
