import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Columns3Cog,
  History,
  SquareArrowRightEnter,
  SquareArrowRightExit,
  Tag,
  Wrench,
} from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MenuItem } from "@/components/menu/types";
import type { DeckVariant } from "@/lib/ipc";
import {
  DeckHeaderBar,
  type BarAction,
  type BarWidth,
  type DeckHeaderBarProps,
} from "./DeckHeaderBar";

/** The Display button's whole name — the three answers the glyph stands for. */
const DISPLAY = "Display: Stacks, grouped by Category, sorted by Name";

/** A change that can be taken back, worded as `auditText` words it. */
const UNDO = "Undo — Removed 2 × Lightning Bolt";

/** One of `DeckEditor`'s three pickers as a submenu of radio rows, the first one checked. */
const picker = (id: string, label: string, choices: readonly string[]): MenuItem => ({
  kind: "submenu",
  id,
  label,
  items: choices.map((choice, i) => ({
    kind: "radio",
    id: choice,
    label: choice,
    checked: i === 0,
    onSelect: () => {},
  })),
});

/**
 * A stand-in for the rows `DeckEditor` builds. The real ones are the editor's — this component
 * draws whatever it is handed and decides none of them — so these only have to be the right
 * *shape*: the three pickers for Display.
 */
const displayRows = (): MenuItem[] => [
  picker("view", "View", ["Stacks", "Grid", "Table", "Text"]),
  picker("group", "Group by", ["Category", "Mana value", "Type"]),
  picker("sort", "Sort", ["Name", "Mana cost", "Price", "Type"]),
];

/** One of the header's verbs as `DeckEditor` hands it over, with its own glyph. */
const verb = (label: string, Icon: BarAction["Icon"], word = label): BarAction => ({
  label,
  word,
  Icon,
  expanded: false,
  open: fn(),
});

/**
 * The editor column's width at each rung — what `DeckEditor` measures for the rung it picks. The
 * app's 1024px floor, its own 1280px window, 1920 and 2560, each less the sidebar, `main`'s
 * padding and the page scrollbar.
 */
const COLUMN: Record<BarWidth, number> = { tight: 760, normal: 1017, wide: 1657, widest: 2297 };

/**
 * The bar with the two pieces of state its host owns held here, so the switch and the filter
 * answer a press the way they do in the editor.
 *
 * `filter` and the list are `DeckEditor`'s state and the bar only reports changes to them — so a
 * story rendering it bare would draw a filter nobody can type into and a switch that never
 * moves. The args still seed both and every callback still fires beneath the wrapper, so the
 * Actions panel shows the half a call site has to get right. (`QuickAdd.stories.tsx`'s `Field`
 * is the same arrangement one component over.)
 */
function Bar(args: DeckHeaderBarProps) {
  const [filter, setFilter] = useState(args.filter);
  const [variant, setVariant] = useState<DeckVariant>(args.lists?.variant ?? "live");
  const lists = args.lists;
  return (
    <DeckHeaderBar
      {...args}
      filter={filter}
      onFilter={(text) => {
        setFilter(text);
        args.onFilter(text);
      }}
      lists={
        lists && {
          ...lists,
          variant,
          onPick: (next) => {
            setVariant(next);
            lists.onPick(next);
          },
        }
      }
    />
  );
}

const meta = {
  title: "Decks/DeckHeaderBar",
  component: DeckHeaderBar,
  tags: ["autodocs"],
  render: (args) => <Bar {...args} />,
  args: {
    // Undocked: the header has scrolled away, which is the only state this component draws
    // anything in. Docked, it renders nothing at all — there is no story for an empty box.
    undocked: true,
    width: "normal",
    onTop: fn(),
    quickAddTarget: null,
    onQuickAdd: fn(),
    lists: { variant: "live", onPick: fn(), onCompare: fn(), comparing: false },
    undo: { label: UNDO, disabled: false, run: fn() },
    // Nothing undone yet, so nothing to redo: greyed with `aria-disabled`, still in the tab order.
    redo: { label: "Redo", disabled: true, run: fn() },
    displayName: DISPLAY,
    displayMenu: fn(displayRows),
    filter: "",
    onFilter: fn(),
    actions: {
      pair: [
        verb("Import cards", SquareArrowRightEnter, "Import"),
        verb("Export deck", SquareArrowRightExit, "Export"),
      ],
      rest: [
        verb("Categories", Columns3Cog),
        verb("Labels", Tag),
        verb("History", History),
        verb("Deck settings", Wrench),
      ],
    },
  },
  decorators: [
    /**
     * The page scroller, the editor column the bar is pinned into, and the deck under it.
     *
     * **The outer box is `AppShell`'s `main` in miniature** — `p-5` and a clip — because the
     * docked panel reaches back across exactly that padding to meet the scroller's edges; drawn
     * straight into a column with no padding around it, the story would clip the bar's first and
     * last 20px. **The inner one is `relative flex flex-col gap-3` because that is the column**:
     * the bar is a zero-height `sticky` child with `-mb-3` cancelling the column's own gap. The
     * width is the column's at the rung the story draws ({@link COLUMN}), and the height leaves
     * room under the bar for Quick add's five suggestions and its status chip.
     *
     * The piles are stand-ins drawn in the app's own tokens, there so the panel's shadow has
     * something to fall on: the bar is always drawn *over* the deck, never over glass.
     */
    (Story, { args }) => (
      <div className="overflow-hidden bg-bg p-5" style={{ width: COLUMN[args.width] + 40 }}>
        <div className="relative flex h-80 flex-col gap-3">
          <Story />
          <div aria-hidden="true" className="flex gap-2 px-2">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((pile) => (
              <div key={pile} className="flex w-48 flex-col">
                {[0, 1, 2, 3].map((card) => (
                  <div
                    key={card}
                    className="-mb-[250px] h-[290px] rounded-lg border border-border bg-surface last:mb-0"
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The deck editor's header, folded into one line and docked across the top of the " +
          "page while the header itself is scrolled away (issue #577). Docked — the header's " +
          "toolbar row on screen — it draws nothing; undocked, it carries the presses a reader " +
          "makes while working down the deck: back to the top, quick add, the two lists and " +
          "Compare, undo and redo, Display (View, Group by and Sort as one menu), the filter, " +
          "and the header's other verbs.\n\n" +
          "**It is a zero-height `sticky` box with the panel `absolute` inside**, `QuickZones`' " +
          "arrangement, so appearing costs the deck no layout — and the panel reaches back " +
          "across the scroller's 20px of padding, so it meets the top and both edges of the " +
          "window with a shadow cast down over the deck (issue #646). `DECK_BAR_CLEARANCE_PX` " +
          "is how far below the scroller's content edge it reaches, which is what the editor " +
          "offsets its other sticky surfaces by. It is mounted only while shown, stays while the " +
          "caret or a menu it opened is in it, and yields to a drag, when the quick zones take " +
          "the same strip.\n\n" +
          "**Four rungs, from the editor column's width**: `tight` and `normal` draw every press " +
          "as its glyph; `wide` (a 1920px window) puts each word beside its glyph; `widest` (a " +
          "2560px window) opens the `⋯` out into the header's six verbs as buttons.\n\n" +
          '**`role="group"`, not `role="toolbar"`**: a toolbar promises one tab stop and ' +
          "arrow keys between its controls, and two of these controls are text fields whose " +
          "arrows are the caret's.\n\n" +
          "**The stories cannot show the pinning.** A story has no page scroller for `sticky` to " +
          "pin against, so the bar sits where it would at the moment it undocks; that, the 53px " +
          "box and the zero-height claim are the live pass's to prove.",
      },
    },
  },
} satisfies Meta<typeof DeckHeaderBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The bar, addressed the way a screen reader finds it. */
const barIn = (canvasElement: HTMLElement) =>
  within(within(canvasElement).getByRole("group", { name: "Deck toolbar" }));

/**
 * A deck with a plan, on its Actual list, with one change to take back and none to redo.
 *
 * The switch answers a press — Theory takes the pressed state from Actual — and the filter is the
 * header's own state drawn a second time: typing here narrows the one deck.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const bar = barIn(canvasElement);

    const theory = bar.getByRole("button", { name: "Theory" });
    const actual = bar.getByRole("button", { name: "Actual" });
    await expect(actual).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(theory);
    await expect(theory).toHaveAttribute("aria-pressed", "true");
    await expect(actual).toHaveAttribute("aria-pressed", "false");
    await expect(args.lists?.onPick).toHaveBeenCalledWith("theory");

    const filter = bar.getByRole("searchbox", { name: "Filter this deck" });
    await userEvent.type(filter, "goblin");
    await expect(filter).toHaveValue("goblin");

    // Nothing to redo: greyed, and still a button a caret can land on.
    const redo = bar.getByRole("button", { name: "Redo" });
    await expect(redo).toHaveAttribute("aria-disabled", "true");
    await expect(redo).not.toHaveAttribute("disabled");
  },
};

/**
 * A deck with one list. No switch between lists, and nothing to compare — the header's own rule:
 * a two-way switch over a deck with one list is a control whose other half is empty by
 * construction. The divider that would lead into the switch goes with it.
 */
export const NoPlan: Story = {
  args: { lists: null },
  play: async ({ canvasElement }) => {
    const bar = barIn(canvasElement);
    await expect(bar.queryByRole("group", { name: "Deck list" })).toBeNull();
    await expect(bar.queryByRole("button", { name: "Compare" })).toBeNull();
    await expect(bar.getByRole("button", { name: "Back to the top" })).toBeVisible();
  },
};

/**
 * The editor column under `TIGHT_HEADER_PX`, at the app's 1024px window floor: the two fields
 * narrow — Quick add to 176px, the filter to 148px — and every control still fits one line.
 */
export const Tight: Story = {
  args: { width: "tight" },
  play: async ({ canvasElement }) => {
    const bar = barIn(canvasElement);
    await expect(bar.getByRole("combobox").classList.contains("w-44")).toBe(true);
    await expect(
      bar
        .getByRole("searchbox", { name: "Filter this deck" })
        .parentElement?.classList.contains("w-37"),
    ).toBe(true);
  },
};

/**
 * A 1920px window's column: every press carries its word beside its glyph, and both fields widen
 * to 320px — the room the icon-only bar left as an empty middle (issue #646). The names do not
 * move, so nothing that addresses a control changes with the width.
 */
export const Wide: Story = {
  args: { width: "wide" },
  play: async ({ canvasElement }) => {
    const bar = barIn(canvasElement);
    await expect(bar.getByRole("button", { name: "Back to the top" })).toHaveTextContent("Top");
    await expect(bar.getByRole("button", { name: "Compare" })).toHaveTextContent("Compare");
    await expect(bar.getByRole("button", { name: DISPLAY })).toHaveTextContent("Display");
    await expect(bar.getByRole("button", { name: "Deck actions" })).toHaveTextContent("Actions");
    await expect(bar.getByRole("combobox").classList.contains("w-80")).toBe(true);
  },
};

/**
 * A 2560px window's column: the `⋯` opens out into the header's six verbs — the joined
 * Import/Export pair and the four worded actions — each opening its layer back onto itself.
 */
export const Widest: Story = {
  args: { width: "widest" },
  play: async ({ args, canvasElement }) => {
    const bar = barIn(canvasElement);
    await expect(bar.queryByRole("button", { name: "Deck actions" })).toBeNull();
    const history = bar.getByRole("button", { name: "History" });
    await expect(history).toHaveTextContent("History");
    await userEvent.click(history);
    await expect(args.actions.rest[2].open).toHaveBeenCalledWith(history);
  },
};
