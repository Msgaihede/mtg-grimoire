import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { MIN_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";
import { buildFolderTree, type FolderNode } from "@/lib/folderTree";
import { CollectionSearchPanel } from "./CollectionSearchPanel";

/**
 * The cabinet the `+`'s override picker offers — **the reader's own drawers and nothing else.**
 *
 * Built through `buildFolderTree` rather than written out as `FolderNode` literals, because
 * `depth`, `count` and `children` are that function's arithmetic and a hand-written node is a
 * fixture free to disagree with the shape the page passes. Deck groups and `Recently removed` are
 * absent here as they are there: nothing may be filed into either by hand.
 */
const FOLDERS = [
  { id: 1, parentId: null, name: "Binder", sortOrder: 0 },
  { id: 2, parentId: 1, name: "Trade binder", sortOrder: 0 },
];
const NODES: readonly FolderNode[] = buildFolderTree(FOLDERS, []);

/**
 * The page's own naming of a destination. `null` is the root, and its word is the list's own —
 * never "no folder", which would describe the same drawer the breadcrumb calls Collection.
 *
 * **Read off the flat rows rather than off {@link NODES}**, which is `CollectionPage`'s own
 * arrangement (`folderNames`, a `Map` over the flat list) and is a correctness point rather than a
 * convenience: `buildFolderTree` returns the *roots*, with everything else nested inside
 * `children`, so a `find` over the returned array can only ever name a top-level drawer.
 */
const folderName = (id: number | null) =>
  id === null ? "Collection" : (FOLDERS.find((f) => f.id === id)?.name ?? null);

/**
 * The panel with the three facts the page hands it, and nothing else.
 *
 * **`folderId` is an arg rather than something this wrapper derives**, which is the deck panel
 * wrapper's rule read across: where the reader is standing is a fact about the *page* — a
 * `useState` inside `useCollection`, moved by a folder card and reset by Flatten — and a wrapper
 * that re-derived it would be a second, agreeing copy of a rule this component deliberately does
 * not own.
 */
function Panel({ folderId }: { folderId: number | null }) {
  return (
    <CollectionSearchPanel folderId={folderId} folderNodes={NODES} folderName={folderName} />
  );
}

const meta = {
  title: "Collection/SearchPanel",
  component: Panel,
  tags: ["autodocs"],
  args: { folderId: null },
  render: (args) => <Panel key={String(args.folderId)} {...args} />,
  decorators: [
    // The panel is a flex column with `min-h-0`, so it needs a parent with a height or its wall
    // has none — and a flex row, because that is the row it shares with the binder. 384px is its
    // own opening width; the 36px beside it is what the rail collapses to, so both states fit the
    // same box.
    (Story) => (
      <div className="flex h-[640px] w-[420px] justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The collection's docked card search — **the path by which a card the reader does not " +
          "own yet gets into the drawer they are standing in.**\n\n" +
          "Chrome from `features/search/CardSearchPanel`, wall from " +
          "`features/search/CardSearchBody` — the same two the deck editor draws, and their own " +
          "pages are where the disclosure, the splitter and the three drawn states are " +
          "storied. What is left here is the **collection**: the destination is the page's open " +
          "folder rather than a choice made in the popup, the `+` is `AddToCollectionButton` " +
          "locked to the collection, and a tile can be dragged onto a folder card instead.\n\n" +
          "**`folderId` is required and `null` means the root.** Absent and `null` are different " +
          "on the wire — absent is a surface that has never thought about folders (the search " +
          "page, the Tags wall), and this one always has, even when the answer is the root.\n\n" +
          "**The drag is not driven in any of these plays.** Storybook has no WRY OLE drop " +
          "target and the shipped window runs with `dragDropEnabled: false`, so a green drag " +
          "here would prove nothing — that is the deck panel's standing decision and it applies " +
          "unchanged. `CollectionSearchPanel.test.tsx` reads the record back out of dnd-kit's " +
          "own store instead, and `CollectionPage.test.tsx` drives the drop onto a folder card.",
      },
    },
  },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The column at rest, filing at the root.
 *
 * **Railed at rest, and opened by the press a reader would use.** A database nobody has expressed a
 * preference in rails this column (`DEFAULT_SEARCH_OPEN`): the page already draws a `FilterBar` of
 * its own, and below 544px the panel is an overlay rather than a rail, so opening open would put
 * two filter rows on screen unasked and cover the binder on a small window. Measured at seven
 * widths in the shipped window on 2026-09-07. The rail is the affordance and the press is
 * remembered, so this play walks in the way a first-time reader does rather than seeding the cache
 * behind the control.
 *
 * The `+`'s name states the destination before the press — `DeckSearchPanel`'s rule (`Add Ancient
 * Tomb to Land`) — and at the root that destination is the **list's** own word.
 */
export const Docked: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your collection" });
    await userEvent.click(within(panel).getByRole("button", { name: "Expand card search" }));
    await expect(
      await within(panel).findByRole("button", { name: "Collapse card search" }),
    ).toHaveAttribute("aria-expanded", "true");

    // Narrowed to one card, so the tile this play is about is the one on screen rather than
    // whichever the corpus happens to sort first.
    await userEvent.type(
      within(panel).getByRole("searchbox", { name: "Search cards" }),
      "Ancient Tomb",
    );
    await expect(
      await within(panel).findByRole("button", { name: /^Add Ancient Tomb .* to Collection$/ }),
    ).toBeInTheDocument();
  },
};

/**
 * The same column with a drawer open on the page beside it.
 *
 * `folderId` is the eleventh term of the row's storage grain, so a press here is an add **into**
 * `Trade binder` and never an add followed by a move — filing one printing into two drawers is two
 * rows, which is the whole reason the field travels with the write.
 *
 * The reader can still send one card somewhere else: the popup carries a `Change folder…` control
 * over {@link NODES}, and that override is thrown away the moment the page's own default moves,
 * because walking into another drawer is a statement about the destination that outranks a choice
 * made about a different one.
 */
export const InAFolder: Story = {
  args: { folderId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your collection" });
    // Railed at rest — see {@link Docked}. The body is not merely hidden but unmounted, so the
    // searchbox below does not exist until this press.
    await userEvent.click(within(panel).getByRole("button", { name: "Expand card search" }));

    await userEvent.type(
      await within(panel).findByRole("searchbox", { name: "Search cards" }),
      "Ancient Tomb",
    );
    const add = await within(panel).findByRole("button", {
      name: /^Add Ancient Tomb .* to Trade binder$/,
    });

    // And the popup behind it is pinned to the collection: a chip pair offering the wishlist here
    // would change which page the results the reader is looking at belong to, and it would offer
    // the collection's folder tree for a wishlist add.
    await userEvent.click(add);
    const popup = await canvas.findByRole("button", { name: "Add to collection" });
    await expect(popup).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Wishlist" })).toBeNull();
    await expect(canvas.getByRole("button", { name: /^Change folder for/ })).toBeInTheDocument();
  },
};

/**
 * The panel at the narrowest it goes — **the width it has to survive, and the one nobody designs
 * at.**
 *
 * `MIN_PANEL_WIDTH_PX` is 206, measured from one 150px card and the chrome around it, and a reader
 * drags the column there. Its content box is **193px**, and the one thing this width forbids is an
 * *overhang*: a flex item cannot shrink below its own min-content, and this page scrolls inside
 * `AppShell`'s `overflow-auto` `main` — so a control that will not fit puts a horizontal scrollbar
 * across the whole window. `ManaValueChips` shipped exactly that once.
 *
 * **Storybook is a real browser, so this is read off the box rather than off a class.** Under
 * `src/stories.test.tsx` every rectangle is zero and the three assertions below are `0 === 0` —
 * true, and true of nothing.
 *
 * `maxWidth` is the *page's* cap in the app (`min(⌊viewport / 2⌋, deskWidth − DESK_GAP −
 * LIST_FLOOR)`); here the decorator's box is what pins it, because this component takes the number
 * rather than measuring it.
 */
export const Narrow: Story = {
  decorators: [
    // `MIN_PANEL_WIDTH_PX` exactly, so the panel has no room to be wider than its floor.
    (Story) => (
      <div className="flex h-[640px] justify-end" style={{ width: MIN_PANEL_WIDTH_PX }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = canvas.getByRole("region", { name: "Add cards to your collection" });
    const toggle = within(panel).getByRole("button", { name: /card search$/ });

    // Both the chevron and the title are drawn: the layout is an answer about width, never a
    // control being dropped.
    await expect(toggle).toBeVisible();

    // Railed at rest — see {@link Docked} — and this story is about what the *open* panel measures
    // at its floor, so it presses first. The element is the same one across the press, which is
    // what lets the row below be read off it either way.
    await userEvent.click(toggle);

    // Nothing overhangs — the panel, its title row, and the filter row under it, which is the
    // piece most likely to break at this width because it is the one with ten chips in it.
    const row = toggle.parentElement!;
    await expect(panel.scrollWidth).toBe(panel.clientWidth);
    await expect(row.scrollWidth).toBe(row.clientWidth);
    const filters = (await within(panel).findByRole("searchbox", { name: "Search cards" }))
      .parentElement!;
    await expect(filters.scrollWidth).toBe(filters.clientWidth);
  },
};
