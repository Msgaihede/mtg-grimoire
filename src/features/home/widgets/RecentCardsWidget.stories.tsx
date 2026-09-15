import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { RecentCardsWidget } from "./RecentCardsWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `recentCards` widget at a footprint, with a config. */
function recent(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "recentCards", kind: "recentCards", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, in a box the card's footprint covers at the target cell — so a
 * story shows exactly the tiles the page would draw at that size.
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
        >
          <RecentCardsWidget
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
  title: "Home/RecentCardsWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: four cells by two, and no config — eight cards, names on.
    widget: recent(4, 2),
  },
  parameters: {
    // A tile's press writes `selectedCardId`, the one store field a play here touches — so each
    // story renders in its own frame on the docs page rather than sharing that write.
    docs: {
      story: { inline: false, height: "280px" },
      description: {
        component:
          "The last cards the reader opened, as a strip of whole card faces — each a press that " +
          "opens the card again. **The recorder is the card modal's**: every surface that opens a " +
          "card writes `selectedCardId`, the modal is the only thing that draws one, and it " +
          "records each distinct card once.\n\n" +
          "**Full cards, never crops.** A tile draws the `grid` image with its printed credit, " +
          "which is Scryfall's artist rule met by construction.\n\n" +
          "**The tile is sized from the measured body**, not from container units: the art is the " +
          "body's height less the caption line and the strip's scrollbar, and both are reserved " +
          "whether or not they are drawn — so switching names off does not move the art. The " +
          "fake derives the list from the collection, newest row first.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Four by two: as many tiles as the reader's count allows, newest first. `starter`'s newest row
 * is the ungraded Japanese Lightning Bolt, so that is the first tile — and a press opens it.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Recently viewed" }));
    const tiles = await card.findAllByRole("button", { name: /· [A-Z0-9]+$/ });

    await expect(tiles[0]).toHaveAccessibleName("Lightning Bolt · STA");
    await expect(tiles).toHaveLength(8);

    await userEvent.click(tiles[0]);
    await waitFor(() => expect(useAppStore.getState().selectedCardId).not.toBeNull());
  },
};

/** Names switched off: the captions keep their line, so the art stays exactly where it was. */
export const NamesOff: Story = {
  args: { widget: recent(4, 2, { names: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Recently viewed" }));
    const list = await card.findByRole("list", { name: "Recently viewed cards" });
    // The captions are the elements carrying a `visibility` of their own; a frame whose picture
    // has not arrived prints the name too, and that one is not a caption.
    const captions = within(list)
      .getAllByText("Lightning Bolt")
      .filter((el) => el.style.visibility !== "");
    await expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) await expect(caption).toHaveStyle({ visibility: "hidden" });
  },
};

/** Two cells wide: never more than two tiles a cell, and the strip scrolls sideways for the rest
 *  of the count. A taller card draws taller tiles. */
export const TallTile: Story = {
  args: { widget: recent(2, 3, { count: 6 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Recently viewed" }));
    await expect(await card.findAllByRole("button", { name: /· [A-Z0-9]+$/ })).toHaveLength(4);
  },
};

/** A first launch: nothing has been opened, so the strip says what will fill it. */
export const NothingOpenedYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Cards you open anywhere in the app will appear here."),
    ).toBeInTheDocument();
  },
};

/** A catalogue preview: pictures rather than presses, clipped rather than scrolling. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Recently viewed" }));
    await card.findByRole("list", { name: "Recently viewed cards" });
    await expect(card.queryByRole("button", { name: /· [A-Z0-9]+$/ })).not.toBeInTheDocument();
  },
};
