import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { Shelf } from "@/lib/shelves";
import { printing } from "../../../.storybook/fake/fixtures";
import { ShelfHeading, type ShelfDropMark, type ShelfHeadingProps } from "./ShelfHeading";
import { FOLD_PAUSED_REASON } from "./ShelfToolbar";

/** A shelf as `buildShelves` hands one over. Not exported: CSF indexes every named export. */
function shelfOf(over: Partial<Shelf> & { id: number; name: string }): Shelf {
  return {
    kind: "folder",
    group: "own",
    pathIds: [over.id],
    path: [over.name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
    ...over,
  };
}

const BINDER = shelfOf({ id: 3, name: "Trade binder" });

/** Five real fixture printings, so the peek draws the workbench's synthetic art. */
const PEEK = [
  printing("lea", "161"),
  printing("lea", "288"),
  printing("mh2", "138"),
  printing("fut", "153"),
  printing("c21", "263"),
].map((card) => ({ cardId: card.id, name: card.name }));

/** The six marks, in the order the `DropMarks` story stacks them. */
const MARKS: readonly ShelfDropMark[] = ["none", "armed", "over", "before", "after", "inside"];

/**
 * The heading as a page draws it, with the real `useContextMenu` wired to its three doors — so the
 * `⋯`, a right-click and Shift+F10 all open a menu here, off the provider `.storybook/preview.tsx`
 * mounts. Its rows are the collection's, minus Rename, plus the keyboard's reorder (spec §3.2).
 */
function Harness({
  withMenu = true,
  ...props
}: Omit<ShelfHeadingProps, "menu"> & { withMenu?: boolean }) {
  const { menu, menuKey, menuClick } = useContextMenu();
  const build = (): MenuItem[] => [
    { kind: "action", id: "move", label: "Move to folder…", onSelect: () => {} },
    { kind: "action", id: "up", label: "Move up", onSelect: () => {} },
    { kind: "action", id: "down", label: "Move down", onSelect: () => {} },
    { kind: "separator", id: "before-delete" },
    { kind: "action", id: "delete", label: "Delete…", onSelect: () => {} },
  ];
  return (
    <ShelfHeading
      {...props}
      menu={
        withMenu
          ? { onContextMenu: menu(build), onKeyDown: menuKey(build), onClick: menuClick(build) }
          : undefined
      }
    />
  );
}

const meta = {
  title: "Shelves/Heading",
  component: Harness,
  tags: ["autodocs"],
  args: {
    shelf: BINDER,
    stat: "42 cards · $2,490.00 · 3 unpriced",
    peek: PEEK,
    onToggle: fn(),
    onOpen: fn(),
    onAddFolder: fn(),
    onRename: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[56rem] max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "One shelf's heading: the row above the cards filed directly in one folder. The chevron " +
          "and the name both fold the shelf, the → at the far right opens the folder, and a reader's " +
          "own folder offers Add folder, Rename and the ⋯ menu. Collapsed, it peeks at the shelf's first cards. It is also a drop " +
          "target for cards and folders and a drag source for folders — the six marks are in " +
          "**Drop marks**.",
      },
    },
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 3 })).toHaveAccessibleName("Trade binder");
    await expect(canvas.getByRole("button", { name: "Collapse Trade binder" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(canvasElement.querySelector("[data-shelf-peek]")).toBeNull();
    // The name folds (issue #599); the → opens.
    await userEvent.click(canvas.getByRole("button", { name: "Trade binder" }));
    await expect(args.onToggle).toHaveBeenCalledTimes(1);
    await expect(args.onOpen).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Open Trade binder" }));
    await expect(args.onOpen).toHaveBeenCalledWith(3);
  },
};

export const CollapsedWithPeek: Story = {
  args: { shelf: { ...BINDER, collapsed: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Expand Trade binder" })).toBeInTheDocument();
    const strip = canvasElement.querySelector("[data-shelf-peek]")!;
    await expect(strip).toHaveAttribute("aria-hidden", "true");
    await expect(strip.querySelectorAll("img")).toHaveLength(4);
  },
};

/** Past the three-level indent the heading names its path from the deepest indented ancestor. */
export const DeepPath: Story = {
  args: {
    shelf: shelfOf({
      id: 23,
      name: "Showcase",
      depth: 4,
      indent: 3,
      pathIds: [20, 21, 22, 23],
      path: ["Staples", "Fetchlands", "Foils", "Showcase"],
      lead: ["Fetchlands", "Foils"],
      leadIds: [21, 22],
    }),
    stat: "6 cards · $1,120.00",
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 6 })).toHaveAccessibleName(
      "Fetchlands Foils Showcase",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Foils" }));
    await expect(args.onOpen).toHaveBeenCalledWith(22);
  },
};

export const Renaming: Story = {
  args: { renaming: { initial: "Trade binder", onCommit: fn(), onCancel: fn() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("textbox", { name: "Rename Trade binder" })).toHaveValue(
      "Trade binder",
    );
    await expect(canvas.queryByRole("button", { name: "Manage Trade binder" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Rename Trade binder" })).toBeNull();
    await expect(canvas.getByText("42 cards · $2,490.00 · 3 unpriced")).toBeInTheDocument();
  },
};

/** Spec §3.8: the new folder appears where it will live, named on the line its name will occupy. */
export const Adding: Story = {
  args: {
    shelf: shelfOf({ id: -1, name: "", depth: 1, indent: 1 }),
    stat: "",
    peek: [],
    withMenu: false,
    renaming: { initial: "", onCommit: fn(), onCancel: fn(), mode: "create" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("textbox", { name: "Folder name" })).toHaveValue("");
    await expect(canvas.getByRole("button", { name: "Create folder" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^(Expand|Collapse)/ })).toBeNull();
  },
};

export const Locked: Story = {
  args: {
    shelf: shelfOf({ id: 5, name: "Display case", locked: true, collapsed: true }),
    stat: "4 cards · $414.47",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img", { name: "Locked" })).toBeInTheDocument();
  },
};

/** App-owned: no Add folder, no Rename, no drag — whatever the page passes. */
export const DeckGroup: Story = {
  args: {
    shelf: shelfOf({
      id: 40,
      name: "Modern Goodstuff",
      kind: "deck",
      group: "decks",
      collapsed: true,
    }),
    stat: "60 cards · $412.50",
    withMenu: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 4 })).toHaveAccessibleName(
      "Modern Goodstuff",
    );
    await expect(canvas.queryByRole("button", { name: /^Add folder/ })).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Rename/ })).toBeNull();
  },
};

export const ManagedFolder: Story = {
  args: {
    shelf: shelfOf({ id: 50, name: "Rhystic Testbed", kind: "managed", group: "managed" }),
    stat: "5 cards · $220.09",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Managed")).toBeInTheDocument();
  },
};

/** Root shelf: its name folds, and Add folder creates at the collection root (issue #778). */
export const NotSorted: Story = {
  args: {
    shelf: shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" }),
    stat: "7 cards · $9.82",
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Not sorted" }));
    await expect(args.onToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole("button", { name: "Add folder in Not sorted" }));
    await expect(args.onAddFolder).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole("button", { name: "Manage Not sorted" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Rename Not sorted" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Open Not sorted" })).toBeNull();
    await expect(canvas.getByRole("heading", { level: 3 })).toHaveAccessibleName("Not sorted");
  },
};

/**
 * While a filter is on, collapse is suspended (spec §3.4): the chevron is refused in the open —
 * dimmed, still a tab stop, the reason on hover and as its description — and a press writes
 * nothing. The name folds too, so it is refused in the same words without dimming. The rest of the
 * heading is not about folding and works as ever.
 */
export const FoldPaused: Story = {
  args: { foldPaused: FOLD_PAUSED_REASON },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const chevron = canvas.getByRole("button", { name: "Collapse Trade binder" });
    await expect(chevron).toHaveAttribute("aria-disabled", "true");
    await expect(chevron).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
    await userEvent.click(chevron);
    await userEvent.click(canvas.getByRole("button", { name: "Trade binder" }));
    await expect(args.onToggle).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Open Trade binder" }));
    await expect(args.onOpen).toHaveBeenCalledWith(3);
  },
};

/**
 * Every mark a heading can wear, one per row: eligible (the edge goes faintly gold), a card over it
 * (full gold and a wash), a folder landing before or after (the 2px line, `FolderDropLine`), and a
 * folder going inside (the wash, no line). No drag is driven — the page decides the mark, and
 * `useShelfDrag.test.tsx` drives the real gesture.
 */
export const DropMarks: Story = {
  render: (args) => (
    <div className="flex flex-col gap-2">
      {MARKS.map((mark, i) => (
        <Harness
          key={mark}
          {...args}
          shelf={shelfOf({ id: 100 + i, name: `Dropping: ${mark}` })}
          dropMark={mark}
        />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const rowOf = (mark: ShelfDropMark) =>
      canvasElement.querySelector(`[data-shelf-heading="${100 + MARKS.indexOf(mark)}"]`)!;
    await expect(rowOf("none")).not.toHaveClass("border-accent/45");
    await expect(rowOf("armed")).toHaveClass("border-accent/45");
    await expect(rowOf("over")).toHaveClass("bg-accent/15");
    await expect(rowOf("inside")).toHaveClass("bg-accent/15");
    await expect(rowOf("before").querySelector('[data-folder-drop-line="before"]')).not.toBeNull();
    await expect(rowOf("after").querySelector('[data-folder-drop-line="after"]')).not.toBeNull();
  },
};
