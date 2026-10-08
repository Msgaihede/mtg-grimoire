import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { printing } from "@grimoire/fake/fixtures";
import { CardWall, type WallItem } from "./CardWall";
import { wallItem } from "./wallItem";

// By set and number rather than by index: `CARDS` is generated, and a regeneration may reorder it.
const BOLT = wallItem(printing("lea", "161"));
/** `mp2 8` — a foil-only printing, so the foil tile draws a copy that exists. */
const SPHINX = wallItem(printing("mp2", "8"), {
  finish: "foil",
  pressLabel: `${printing("mp2", "8").name}, MP2 8, Foil`,
});
const FEW: WallItem[] = [
  BOLT,
  wallItem(printing("lea", "288")),
  wallItem(printing("mh2", "138")),
  SPHINX,
  wallItem(printing("pcy", "45"), { count: 3 }),
  wallItem(printing("c21", "263")),
  wallItem(printing("fut", "153")),
];

/**
 * A phone's width, and a height for the wall to scroll in. **The wall needs both**: it is a
 * `flex-1` scroller inside the shell's `main`, and in a box of no height it virtualises down to
 * no row at all. The width is a parameter so the 800px check every phone page gets is one story.
 */
const meta = {
  title: "Phone/CardWall",
  component: CardWall,
  tags: ["autodocs"],
  args: {
    label: "Search results",
    items: FEW,
    onOpen: fn(),
    resetKey: "few",
  },
  decorators: [
    (Story, { parameters }) => (
      <div
        className="flex h-[36rem] max-w-full flex-col overflow-hidden bg-bg"
        style={{ width: (parameters.phoneWidth as number | undefined) ?? 360 }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The phone face's one list: a virtualised wall of `CardTile`s, two columns at 360px " +
          "and more as the width allows. Every page of the phone face hands it `WallItem`s — " +
          "`items.ts` turns each of the four DTOs into one — and a press opens the card's sheet. " +
          "A count above one is a tag on the art **and** the end of the tile's name, because the " +
          "tag itself is hidden from a screen reader.",
      },
    },
  },
} satisfies Meta<typeof CardWall>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Seven tiles at 360px — a foil one, and one held three times. A press hands the item on. */
export const Phone: Story = {
  play: async ({ canvasElement, args }) => {
    const wall = within(canvasElement).getByRole("list", { name: "Search results" });
    // Through `waitFor`: the first render draws no row until the scroller has been measured.
    const bolt = await waitFor(() => within(wall).getByRole("button", { name: BOLT.pressLabel }));
    await userEvent.click(bolt);
    await expect(args.onOpen).toHaveBeenCalledWith(BOLT);
    // The count is said in the name, since the tag on the art is `aria-hidden`.
    await expect(within(wall).getByRole("button", { name: /, 3 copies$/ })).toBeInTheDocument();
  },
};

/** The same wall at 800px, the widest a phone page is drawn — more columns, the same tiles. */
export const Wide: Story = {
  parameters: { phoneWidth: 800 },
};

/**
 * A tile with no card to draw — a wish whose card the corpus no longer has. It draws the named
 * frame, and is still a button: the wall makes every tile one.
 */
export const Unpictured: Story = {
  args: {
    items: [
      wallItem(printing("lea", "288"), { key: "gone", cardId: null, money: undefined }),
      BOLT,
    ],
    resetKey: "unpictured",
  },
};

/** Nothing to draw. The wall says nothing of its own; the page above it owns the sentence. */
export const Empty: Story = {
  args: { items: [], resetKey: "empty" },
};
