import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { FoldersWidget, FoldersWidgetSettings } from "./FoldersWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `folders` widget at a footprint, with a config. */
function folders(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "folders", kind: "folders", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, in a box the card's footprint covers at the target cell — so a
 * story shows exactly the rows the page would draw at that size.
 */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx,
    heightPx,
    density: widgetDensity(widget),
  });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
          extraSettings={<FoldersWidgetSettings widget={widget} onConfig={onConfig} />}
        >
          <FoldersWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={still}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/FoldersWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: four cells by two and no config — both cabinets, each falling
    // back to the top-level drawers the reader made.
    widget: folders(4, 2),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Shortcuts to the drawers a reader keeps coming back to — the collection's and the " +
          "wishlist's, each folder with what is in it and what it is worth.\n\n" +
          "**Both folder summaries are direct per folder and never recursive, so this widget " +
          "does the roll-up.** A row handed a raw lookup would draw `3 cards` over a binder " +
          "holding twelve in two sub-folders.\n\n" +
          "**A folder the summary misses is a folder with nothing in it**, so the *list* is the " +
          "census and the summary is a lookup layered onto it. **`null` money is an em dash**, " +
          "all the way up the tree.\n\n" +
          "**The app's own folders are offered and labelled rather than hidden** — a deck's group " +
          "and `Recently removed` are worth pinning as shortcuts — but the fallback is `user` " +
          "folders only. `Cabinets` narrows the card to one side; `Show which cabinet` is the " +
          "caption; and on a `Both` card the two cabinets share the rows the box holds.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Nothing pinned: the top-level drawers the reader made, both cabinets sharing the box.
 *
 * The seed's collection cabinet is `Binder` (with `Trade binder` filed under it), `Someday`, a
 * group per deck and `Recently removed`; the fallback takes the two `user` folders at the top
 * level. The wishlist's is `Ordered` (with `Backordered` under it) and `Someday`. The `play` reads
 * each row's **written** name, with `Binder`'s figure the roll-up.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Folders" }));

    await expect(
      await card.findByRole("button", { name: /^Binder, collection folder, \d+ cards/ }),
    ).toBeInTheDocument();
    await expect(
      await card.findByRole("button", { name: /^Ordered, wishlist folder, \d+ wish/ }),
    ).toBeInTheDocument();
    // A deck's group is a real folder and is pinnable, but the fallback is `user` folders only.
    await expect(
      card.queryByRole("button", { name: /^Modern Goodstuff, deck folder/ }),
    ).not.toBeInTheDocument();
  },
};

/**
 * A pinned set that names the app's own folders — a deck's group — beside a wishlist drawer.
 *
 * Folder 4 is `Modern Goodstuff`'s own group — see `.storybook/fake/seeds.ts`'s
 * `starterCollectionFolders`, which mints one group per deck after the two binders. It draws with
 * the layered glyph in dim and says `Deck folder` in its caption, so it cannot read as a binder.
 */
export const PinnedIncludingTheAppsOwn: Story = {
  args: {
    widget: folders(4, 3, { collectionFolderIds: [4], wishlistFolderIds: [2] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Folders" }));

    await expect(
      await card.findByRole("button", { name: /^Modern Goodstuff, deck folder, / }),
    ).toBeInTheDocument();
    await expect(
      card.queryByRole("button", { name: /^Binder, collection folder/ }),
    ).not.toBeInTheDocument();
    await expect(
      await card.findByRole("button", { name: /^Backordered, wishlist folder, / }),
    ).toBeInTheDocument();
  },
};

/** The collection only, captions off: one line a row, the heart and the wishlist gone. */
export const CollectionOnlyBare: Story = {
  args: { widget: folders(3, 3, { cabinets: "collection", captions: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Folders" }));
    await expect(
      await card.findByRole("button", { name: /^Binder, collection folder/ }),
    ).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /wishlist folder/ })).not.toBeInTheDocument();
  },
};

/** A two-cell tile: the folder's whole face moves under its name. */
export const Tile: Story = {
  args: { widget: folders(2, 3) },
};

/**
 * A cabinet nobody has filed anything into — and each cabinet answers for itself, in its own
 * sentence.
 */
export const NoFoldersYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Folders" }));
    await expect(
      await card.findByText(
        "No collection folders to show — make one in your collection, then pin it here from Customize.",
      ),
    ).toBeInTheDocument();
    await expect(
      await card.findByText(
        "No wishlist folders to show — make one in your wishlist, then pin it here from Customize.",
      ),
    ).toBeInTheDocument();
  },
};

/** A catalogue preview: pictures of rows, nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Folders" }));
    await expect(await card.findByText("Binder")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Binder,/ })).toBeNull();
  },
};

/**
 * The two pin pickers on their own, as the card's settings popover draws them. Each trigger says
 * `Automatic` while nothing is pinned — what the widget is actually doing, rather than a count of
 * zero.
 */
export const PinPickers: Story = {
  render: () => (
    <div className="w-[268px] p-2">
      <FoldersWidgetSettings widget={folders(4, 2)} onConfig={fn()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Collection folders" }),
    ).toHaveTextContent("Automatic");
    await expect(canvas.getByRole("button", { name: "Wishlist folders" })).toHaveTextContent(
      "Automatic",
    );
  },
};
