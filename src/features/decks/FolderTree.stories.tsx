import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckFolder } from "@/lib/ipc";
import { buildFolderTree } from "./folders";
import { DEFAULT_FOLDER_TREE_WIDTH_PX, FolderTree, type FolderTreeProps } from "./FolderTree";

/**
 * The decks page's filing cabinet, as a **column with a width**.
 *
 * The tree's own drawing — the rows, the nesting guides, the counts, the two drags — is the
 * gallery's subject and is on {@link file://./DecksPage.stories.tsx}'s `Folders` story, over a
 * real seeded backend. What is on this page is the one thing that page cannot show at four
 * widths at once: the column the tree is drawn *in*.
 *
 * The reader sizes it by pulling its right edge and folds it to a 36px rail with the chevron,
 * and both answers outlive the window — `app_meta.deck_folder_pane`, through
 * `useFolderPane`. It is the deck builder's docked card search column's control, on the
 * opposite edge of the page: `components/ResizeHandle` is literally the same component with
 * `side="left"`, so a reader who has learnt one has learnt the other.
 */

const FOLDERS: DeckFolder[] = [
  { id: 1, parentId: null, name: "Constructed", sortOrder: 0 },
  { id: 2, parentId: 1, name: "Commander", sortOrder: 0 },
  { id: 3, parentId: 1, name: "Modern brews and other long names", sortOrder: 1 },
  { id: 4, parentId: null, name: "Ideas", sortOrder: 1 },
];

/** Two decks in Commander, one in Modern, one loose — so no two rows read the same count and the
 *  root's own total disagrees with every folder under it, which is the point of drawing both. */
const DECKS = [
  { folderId: 2, archived: false },
  { folderId: 2, archived: false },
  { folderId: 3, archived: false },
  { folderId: null, archived: false },
];

/**
 * The tree with the page's half of the pair held for it — a width and a fold that the drag and
 * the chevron really move, the way `DecksPage` holds them through `useFolderPane`.
 *
 * **Stateful rather than a bare controlled render**, because the two gestures this page is about
 * are the two a static story cannot show: with the callbacks as spies alone, pulling the edge in
 * the workbench would log an action and move nothing. The args are still the seed — `render`
 * re-keys on them, so a control change re-mounts at the new width — and the spies still fire, so
 * the Actions panel says what the page would have been told to remember.
 */
function Tree({ width, collapsed, ...rest }: FolderTreeProps) {
  const [drawn, setDrawn] = useState(width);
  const [folded, setFolded] = useState(collapsed);
  return (
    <FolderTree
      {...rest}
      width={drawn}
      collapsed={folded}
      onResize={(next) => {
        rest.onResize(next);
        setDrawn(next);
      }}
      onCollapse={(next) => {
        rest.onCollapse(next);
        setFolded(next);
      }}
    />
  );
}

const meta = {
  title: "Decks/FolderTree",
  component: FolderTree,
  tags: ["autodocs"],
  args: {
    width: DEFAULT_FOLDER_TREE_WIDTH_PX,
    collapsed: false,
    maxWidth: 420,
    onResize: fn(),
    onCollapse: fn(),
    nodes: buildFolderTree(FOLDERS, DECKS),
    totalDecks: DECKS.length,
    selectedId: 2,
    onSelect: fn(),
    drag: null,
    canDropIn: () => false,
    onDropIn: fn(),
    canDropFolder: () => false,
    onDropFolder: fn(),
    naming: null,
    onOpenNew: fn(),
    onOpenRename: fn(),
    onCloseNaming: fn(),
    onName: fn(),
    busy: false,
    failure: null,
    pending: false,
    rowMenu: () => ({ onContextMenu: fn(), onKeyDown: fn() }),
    menuOpenerRef: { current: null },
  },
  // Keyed on the two args a control can change, so the stateful wrapper re-seeds instead of
  // holding whatever the last gesture left. Nothing a *gesture* changes is in the key, so a drag
  // is not interrupted by its own result.
  render: (args) => <Tree key={`${args.width}-${String(args.collapsed)}`} {...args} />,
  decorators: [
    // The desk row the tree is docked in: a flex row with a height, because the column is
    // `flex-none` in a `min-h-0 flex-1` row and has no height of its own. The dashed block
    // stands in for the wall of decks — what a wider tree costs is exactly what that block
    // loses, which is the comparison this whole page is about. `gap-5` is the decks page's own.
    //
    // **The width is a parameter rather than a second decorator on the one story that wants a
    // narrow row.** Storybook composes a story's own decorators *inside* the meta's, so a story
    // declaring one would be drawn in a 340px desk nested in a 720px desk — two dashed blocks,
    // and a narrow row that is not narrow.
    (Story, context) => (
      <div
        className="flex h-[420px] gap-5 bg-bg p-4"
        style={{ width: (context.parameters.deskWidth as number | undefined) ?? 720 }}
      >
        <Story />
        <div className="min-w-0 flex-1 rounded-lg border border-dashed border-border/60" />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The decks page's folder tree, drawn as a column the reader owns the width of.\n\n" +
          "**Hover the right edge to see the grip.** At rest that edge is the hairline the " +
          "column already had — the one piece of chrome it adds — because a permanent handle " +
          "down a border this app spent care making quiet would be a second line saying the " +
          "same thing. The cursor is `col-resize` across a 9px strip that straddles the border, " +
          "4px of it out in the desk's own gap. It is `components/ResizeHandle` with " +
          "`side=\"left\"` — the deck builder's card search column is the same control on the " +
          "opposite edge, so **Right widens here where Left widens there**, and Home and End go " +
          "to the two ends of the range on both.\n\n" +
          "**The floor is 176px and it is measured rather than chosen**: the heading row spends " +
          "89px on its chevron, its `+`, the gaps and the nav's own padding and hairline, and a " +
          "top-level folder row spends 134 on its guide gutter, glyph, gaps, count and the " +
          "reserved column for its `+`. So 176 gives the word `Folders` the 76 it needs with " +
          "11px to spare and a folder's name 42 — four characters and an ellipsis. It was 160 " +
          "for one commit, hand-counted and 9px optimistic, which drew the heading itself as " +
          "`FOLDE…`. `maxWidth` is the page's " +
          "measurement — `min(half the window, what the desk can spare over one deck tile at " +
          "the reader's zoom)` — and is hard-coded at 420 here, a story having neither a desk " +
          "nor a window to derive it from.\n\n" +
          "**Folded, the rows are gone rather than hidden.** A folder list that was merely " +
          "invisible would still be a tab stop per row and a drop target per row for a deck " +
          "nobody can see landing — so `Rail` draws 36px of chevron over the word `Folders` " +
          "turned on its side, and a deck is filed from the wall's own folder cards or the " +
          "tile's `Move to folder…` while it is shut.\n\n" +
          "**`roomy` and `collapsed` are two different facts and `NoRoom` is why they are kept " +
          "apart.** A narrow window is a measurement and a press is a choice, so a railing for " +
          "want of room never writes back through `onCollapse` — fold the two together and the " +
          "first reader who narrows their window loses the tree for good, because widening it " +
          "again would give them nothing.\n\n" +
          "**The drag itself is not asserted in any play here and none attempts it.** jsdom " +
          "ships no `PointerEvent`, so a `userEvent.pointer` on this handle carries no " +
          "`clientX` and the resize reads `undefined` — `FolderTree.test.tsx` drives it with a " +
          "hand-built `MouseEvent` for exactly that reason. What a play can honestly settle is " +
          "the keyboard half, the range the splitter reports, and what the rail draws.",
      },
    },
  },
} satisfies Meta<typeof FolderTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The tree as every install opens it: 208px, which is the `w-52` this column shipped with and was
 * laid out against, so a reader who never touches the edge sees exactly what they always saw.
 *
 * `Commander` is the open drawer, and the rail down its leading edge is what makes the current row
 * findable in a cabinet of twenty without reading the names. The counts are what a row *holds*,
 * everything under it included — `Constructed` reads 3 over two children holding 2 and 1 — so the
 * root's own total and a folder's disagreeing is the whole reason both are drawn.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole("navigation", { name: "Folders" });
    await expect(tree).toHaveStyle({ width: "208px" });

    await expect(canvas.getByRole("button", { name: "All decks, 4 decks" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Commander, 2 decks" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Ideas, 0 decks" })).toBeVisible();

    // The splitter reports the width in px — the unit the reader is actually choosing — and this
    // column's own range. 176 and 420 are written out rather than read back off the constants
    // they came from: an assertion that reads its own constant passes for whatever that constant
    // becomes, the wrong value included.
    const handle = canvas.getByRole("separator", { name: "Resize folders" });
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuenow", "208");
    await expect(handle).toHaveAttribute("aria-valuemin", "176");
    await expect(handle).toHaveAttribute("aria-valuemax", "420");
    // A caret can reach it, which is the half a pointer-only splitter loses outright: there is no
    // other control anywhere that sets this width.
    await expect(handle).toHaveAttribute("tabindex", "0");
  },
};

/**
 * The same tree pulled out to 320px, which is what a reader with deep nesting does.
 *
 * The width is bought from the wall beside it and from nothing else — the dashed block in these
 * stories is the decks, and it is 112px narrower here than in {@link Open}. What the extra width
 * buys is the long name reading in full instead of truncating, which is the whole of why somebody
 * drags this edge.
 *
 * The play moves the edge with the **keyboard**, which is the half a story can honestly drive:
 * Right widens on a left-docked column, one 24px step per press, and Home goes to the floor.
 */
export const Dragged: Story = {
  args: { width: 320 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole("navigation", { name: "Folders" });
    await expect(tree).toHaveStyle({ width: "320px" });

    const handle = canvas.getByRole("separator", { name: "Resize folders" });
    handle.focus();

    // 320 + 24. Right widens because this column is docked against the row's left edge — the key
    // moves the *separator*, which is what the role says this is.
    await userEvent.keyboard("{ArrowRight}");
    await expect(tree).toHaveStyle({ width: "344px" });

    // Home is the floor, and it does not turn over with the side: the narrowest a column may be
    // is a fact about the range rather than about which way the reader is pushing.
    await userEvent.keyboard("{Home}");
    await expect(tree).toHaveStyle({ width: "176px" });
  },
};

/**
 * Folded to its rail — 36px of chevron over the word `Folders` turned on its side.
 *
 * **One root across the fold**: the `<nav>`, the heading row and the chevron are the same nodes
 * in both states, so the caret handed back to that button is not dropped one commit later around
 * a freshly mounted copy of it. Only the rows mount and unmount, and they really do unmount — a
 * hidden list would still be a tab stop per row.
 *
 * The chevron **names the result rather than the state**: `aria-expanded` already says which way
 * round it is, and a reader who has just heard "collapsed" wants to know what pressing it will do
 * about that.
 */
export const Rail: Story = {
  args: { collapsed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tree = await canvas.findByRole("navigation", { name: "Folders" });
    const chevron = canvas.getByRole("button", { name: "Expand folders" });
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    // No rows at all, and no edge to pull: a strip down a rail would be an affordance for a width
    // the column has given up.
    await expect(canvas.queryByRole("button", { name: /^Commander, / })).toBeNull();
    await expect(canvas.queryByRole("separator", { name: "Resize folders" })).toBeNull();
    // The heading turns rather than disappearing, so 36px of chrome still says what this column
    // is instead of leaving a bare chevron to be guessed at.
    await expect(canvas.getByRole("heading", { name: "Folders" })).toBeVisible();

    await userEvent.click(chevron);

    // One press brings the whole cabinet back, at the width it was folded from — and the
    // chevron is the same element, renamed for what pressing it would now do.
    await expect(canvas.queryByRole("button", { name: "Expand folders" })).toBeNull();
    await expect(chevron).toHaveAccessibleName("Collapse folders");
    await expect(canvas.getByRole("button", { name: "Commander, 2 decks" })).toBeVisible();
    await expect(tree).toHaveStyle({ width: "208px" });
  },
};

/**
 * A desk row with no room for the tree **and** a deck tile side by side — the phone, and a
 * narrow window on a desktop.
 *
 * The rail is drawn whatever the reader chose, and **the press is refused rather than recorded**:
 * a railing is a measurement about a narrow window and not something anybody asked for, so
 * `onCollapse` is never called here. Fold the two facts together and the first reader who
 * narrows their window loses the tree permanently — the measurement writes itself back as a
 * choice, and widening the window again gives them nothing.
 *
 * `aria-disabled` and a press that does nothing, never the `disabled` attribute: a disabled
 * button leaves the tab order, which would hang the reason on a hover a keyboard reader cannot
 * perform — a rail that cannot be opened and never says why. The reason is on the app's one
 * tooltip, and it carries this page's own remedies rather than the deck editor's, because there
 * is no card pane here to close.
 */
export const NoRoom: Story = {
  args: { roomy: false },
  parameters: { deskWidth: 340 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // **`Expand folders`, over a column that is already a rail** — the name is read off what is
    // *drawn*, so it agrees with the `aria-expanded="false"` beside it rather than contradicting
    // it. The reader's stored answer here is still "open", and naming *that* announced
    // "Collapse folders, collapsed" — a control at odds with the state word next to it. What the
    // control cannot do is said by `aria-disabled` and the tooltip instead, which is where a
    // refusal belongs and what a reader meets before pressing anything. Hover it in the workbench
    // for the reason, which names this page's own remedies rather than the deck editor's.
    const chevron = await canvas.findByRole("button", { name: "Expand folders" });

    await expect(chevron).toHaveAttribute("aria-disabled", "true");
    // Reachable while it refuses — the whole reason it is not `disabled`.
    await expect(chevron).toBeEnabled();
    await expect(canvas.queryByRole("separator", { name: "Resize folders" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Commander, / })).toBeNull();

    await userEvent.click(chevron);

    // Nothing was stored, so the tree comes back the moment the room does — and the control has
    // not renamed itself either, because neither the drawing nor the reader's answer moved.
    await expect(args.onCollapse).not.toHaveBeenCalled();
    await expect(chevron).toHaveAccessibleName("Expand folders");
    await expect(canvas.queryByRole("separator", { name: "Resize folders" })).toBeNull();
  },
};
