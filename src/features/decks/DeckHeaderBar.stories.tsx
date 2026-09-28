import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MenuItem } from "@/components/menu/types";
import type { DeckVariant } from "@/lib/ipc";
import { DeckHeaderBar, type DeckHeaderBarProps } from "./DeckHeaderBar";

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
 * *shape*: the three pickers for Display, and the header's verbs for `⋯`.
 */
const displayRows = (): MenuItem[] => [
  picker("view", "View", ["Stacks", "Grid", "Table", "Text"]),
  picker("group", "Group by", ["Category", "Mana value", "Type"]),
  picker("sort", "Sort", ["Name", "Mana cost", "Price", "Type"]),
];
const actionRows = (): MenuItem[] =>
  ["Categories", "Labels", "History", "Import cards", "Export deck", "Deck settings"].map(
    (label) => ({ kind: "action", id: label, label, onSelect: () => {} }),
  );

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
    tight: false,
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
    actionsMenu: fn(actionRows),
  },
  decorators: [
    /**
     * The editor column the bar is pinned into, and the deck scrolling under it.
     *
     * **`relative flex flex-col gap-3`, because that is the box the bar is designed for**: it is a
     * zero-height `sticky` child with `-mb-3` cancelling the column's own gap, and its panel is
     * `absolute inset-x-0` — so without a positioned column of a real width it would be as wide as
     * the page, and without the gap the negative margin would pull the deck up by 12px. The width
     * is the editor column's at the two sizes the bar is drawn for — 1020 roomy, 760 tight, the
     * latter being the app's 1024px window floor — and the height leaves room under the bar for
     * Quick add's ten suggestions, the count under them and its status chip — `h-[28rem]`, which
     * was `h-80` and clipped the list once it went from five rows to ten (issue #648).
     *
     * The piles are stand-ins drawn in the app's own tokens, there so the panel's blur and shadow
     * have something to read against: the bar is always drawn *over* the deck, never over glass.
     */
    (Story, { args }) => (
      <div
        className="relative flex h-[28rem] flex-col gap-3 overflow-hidden bg-bg"
        style={{ width: args.tight ? 760 : 1020 }}
      >
        <Story />
        <div aria-hidden="true" className="flex gap-2 px-2">
          {[0, 1, 2, 3, 4].map((pile) => (
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
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The deck editor's header, folded into one line and pinned to the top of the page " +
          "while the header itself is scrolled away (issue #577). Docked — the header's toolbar " +
          "row on screen — it draws nothing; undocked, it carries the presses a reader makes " +
          "while working down the deck: back to the top, quick add, the two lists and Compare, " +
          "undo and redo, Display (View, Group by and Sort as one menu), the filter, and the " +
          "header's other verbs behind `⋯`.\n\n" +
          "**It is a zero-height `sticky` box with the panel `absolute` inside**, `QuickZones`' " +
          "arrangement, so appearing costs the deck no layout; `DECK_BAR_CLEARANCE_PX` is how far " +
          "down the page it reaches, which is what the editor offsets its other sticky surfaces " +
          "by. It is mounted only while shown, stays while the caret or a menu it opened is in " +
          "it, and yields to a drag, when the quick zones take the same strip.\n\n" +
          '**`role="group"`, not `role="toolbar"`**: a toolbar promises one tab stop and ' +
          "arrow keys between its controls, and two of these controls are text fields whose " +
          "arrows are the caret's.\n\n" +
          "**The stories cannot show the pinning.** A story has no page scroller for `sticky` to " +
          "pin against, so the bar sits where it would at the moment it undocks; that, the 50px " +
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
  args: { tight: true },
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
