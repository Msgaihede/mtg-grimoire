import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { FoldersWidget } from "./FoldersWidget";

/** The page's half of every widget's props — see `widgetProps.ts`. */
const CHROME = {
  editing: false,
  onRemove: fn(),
  onSpan: fn(),
  onConfig: fn(),
  onNudge: fn(),
  dragHandleRef: fn(),
};

const meta = {
  title: "Home/FoldersWidget",
  component: FoldersWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: the whole row, and no config — which is the fallback both
    // cabinets answer with the top-level drawers the reader made.
    widget: { id: "folders", kind: "folders", span: 2, config: null },
    ...CHROME,
  },
  decorators: [
    // `span: 2` is the whole grid row, and at that width the card draws its two cabinets side by
    // side (`md:grid-cols-2`). A narrower box would story the stacked arrangement only.
    (Story) => (
      <div className="w-[52rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Shortcuts to the drawers a reader keeps coming back to — the collection's filing " +
          "cabinet and the wishlist's, side by side, each folder with what is in it and what " +
          "it is worth.\n\n" +
          "**Both folder summaries are direct per folder and never recursive, so this widget " +
          "does the roll-up.** `collection_folder_summary` and `wishlist_folder_summary` " +
          "`GROUP BY folder_id` over their own entries and stop there, because SQL that walked " +
          "the tree would be a second implementation of arithmetic `buildFolderTree` already " +
          "does. A tile handed a raw lookup would draw `3 cards` over a binder holding twelve " +
          "in two sub-folders, and the reader would only catch it by opening the drawer.\n\n" +
          "**A folder the summary misses is a folder with nothing in it** — both commands " +
          "exclude the root and return no row at all for an empty folder — so the *list* is " +
          "the census and the summary is a lookup layered onto it. `0 cards` is the honest " +
          "face of an empty drawer.\n\n" +
          "**`CollectionFolderSummary.value` is `number | null` and is not flattened to zero.** " +
          "A tile is a small number under a name with no room for a page header's *n unpriced* " +
          "note, so a drawer full of cards the feed has never heard of draws an em dash rather " +
          "than reading as a drawer worth nothing — and the roll-up keeps that rule all the " +
          "way up the tree.\n\n" +
          "**The app's own folders are offered and labelled rather than hidden.** A `deck`-kind " +
          "group and `Recently removed` refuse every write, so no folder *picker* offers " +
          "them — but this is a shortcut rather than a destination, and both are worth " +
          "pinning. The fallback is `user` folders only, because twenty deck groups would bury " +
          "the two binders that matter.",
      },
    },
  },
} satisfies Meta<typeof FoldersWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing pinned: the top-level drawers the reader made, one cabinet each.
 *
 * The seed's collection cabinet is `Binder` (with `Trade binder` filed under it), `Someday`, a
 * group per deck and `Recently removed`; the fallback takes the two `user` folders at the top
 * level and leaves the app's own out. The wishlist's is `Ordered` (with `Backordered` under it)
 * and `Someday`.
 *
 * The `play` reads each tile's **written** name. A folder's name and its figures sit in two
 * elements with a `gap` between them, so a computed name would be `Binder12 cards · $30.00`;
 * both walls state the sentence outright, and WCAG 2.5.3 is what puts the visible name first.
 * `Binder`'s figure is the **roll-up** — its own cards plus everything filed under it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const folders = within(await canvas.findByRole("region", { name: "Folders" }));

    // Each cabinet is its own `<section>`, so a tile is addressed inside the wall it belongs to
    // rather than by hoping the two never share a folder name — `Someday` is in both.
    const collection = within(
      await folders.findByRole("region", { name: "Collection folders" }),
    );
    const wishlist = within(await folders.findByRole("region", { name: "Wishlist folders" }));

    await expect(
      await collection.findByRole("button", { name: /^Binder, collection folder, \d+ cards/ }),
    ).toBeInTheDocument();
    await expect(
      await wishlist.findByRole("button", { name: /^Ordered, wishlist folder, \d+ wish/ }),
    ).toBeInTheDocument();

    // A deck's group is a real folder and is pinnable, but the fallback is `user` folders only.
    await expect(
      collection.queryByRole("button", { name: /^Modern Goodstuff, deck folder/ }),
    ).not.toBeInTheDocument();
    await expect(
      collection.queryByRole("button", { name: /^Recently removed, removed cards/ }),
    ).not.toBeInTheDocument();
  },
};

/**
 * A pinned set that names the app's own folders — a deck's group and the removal drawer.
 *
 * **A shortcut may point at either where a destination picker may not**, and a deck's group must
 * not read as a binder the reader made: the tile says which it is in words as well as with a
 * glyph, and the word is what a screen reader gets.
 */
export const PinnedIncludingTheAppsOwn: Story = {
  args: {
    widget: {
      id: "folders",
      kind: "folders",
      span: 2,
      // Folder 4 is `Modern Goodstuff`'s own group and folder 8 is `Recently removed` — see
      // `.storybook/fake/seeds.ts`'s `starterCollectionFolders`, which mints one group per deck
      // after the two binders and puts the holding area last.
      config: { collectionFolderIds: [4], wishlistFolderIds: [2] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const folders = within(await canvas.findByRole("region", { name: "Folders" }));
    const collection = within(
      await folders.findByRole("region", { name: "Collection folders" }),
    );
    const wishlist = within(await folders.findByRole("region", { name: "Wishlist folders" }));

    // "deck folder" in the sentence, `Deck` in the badge beside the name.
    await expect(
      await collection.findByRole("button", { name: /^Modern Goodstuff, deck folder, / }),
    ).toBeInTheDocument();
    // A pinned set is drawn in the order it was pinned and holds only what was pinned.
    await expect(
      collection.queryByRole("button", { name: /^Binder, collection folder/ }),
    ).not.toBeInTheDocument();
    await expect(
      await wishlist.findByRole("button", { name: /^Backordered, wishlist folder, / }),
    ).toBeInTheDocument();
  },
};

/**
 * A cabinet nobody has filed anything into — and each wall answers for itself.
 *
 * **Three states and three different sentences**, per wall: a cabinet still being read must not
 * draw `0 cards` across the window the summary takes to answer, an empty cabinet is not an
 * error, and a refused read says what the backend said. Answering per wall is what stops a
 * wishlist the database would not read from blanking the collection beside it.
 */
export const NoFoldersYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const folders = within(await canvas.findByRole("region", { name: "Folders" }));
    await expect(
      await folders.findByText(
        "No collection folders to show — make one in your collection, then pin it here from Customize.",
      ),
    ).toBeInTheDocument();
    await expect(
      await folders.findByText(
        "No wishlist folders to show — make one in your wishlist, then pin it here from Customize.",
      ),
    ).toBeInTheDocument();
  },
};

/**
 * Customize on: the tray, and the two pickers behind the settings control.
 *
 * Both cabinets get their own picker, and each trigger says `Automatic` while nothing is pinned
 * — what the widget is actually doing, rather than a count of zero.
 */
export const Customizing: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const folders = within(await canvas.findByRole("region", { name: "Folders" }));
    await expect(folders.getByRole("button", { name: "Move Folders" })).toBeInTheDocument();
    await expect(folders.getByRole("button", { name: "Full width, Folders" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      folders.getByRole("button", { name: "Settings for Folders" }),
    ).toBeInTheDocument();
    await expect(folders.getByRole("button", { name: "Remove Folders" })).toBeInTheDocument();
  },
};
