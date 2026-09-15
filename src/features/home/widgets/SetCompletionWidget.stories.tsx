import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { SetCompletionWidget } from "./SetCompletionWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `setCompletion` widget at a footprint, with a config. */
function sets(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "setCompletion", kind: "setCompletion", x: 0, y: 0, w, h, config };
}

/** The body inside the real card, at the footprint's size on the target cell. */
function Framed({ widget }: { widget: HomeWidget }) {
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
        <WidgetCard widget={widget} fit={fit} editing={false} onConfig={onConfig} onRemove={fn()}>
          <SetCompletionWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={false}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/SetCompletionWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: two cells by two, nearest-complete first, tracks on.
    widget: sets(2, 2),
  },
  parameters: {
    docs: {
      description: {
        component:
          "How close each set the reader collects is to complete. `set_completion` counts the " +
          "**distinct collector numbers** held inside the set's printed size; the order is this " +
          "body's, from the `Order` pick.\n\n" +
          "**A set with no printed size is not 0 % complete.** Alpha prints no denominator, so its " +
          "row says how many cards are held, draws an em dash and no track, and sorts last by " +
          "completeness. **A percentage never rounds up to done** — it is floored, and a set " +
          "barely started reads `<1%`.\n\n" +
          "On a two-cell tile the figure moves under the name, `WidgetRow`'s rule.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default tile: the percentage under each name, and a track under that. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Set completion" }));
    await expect(await card.findByText("Modern Horizons 2")).toBeInTheDocument();
  },
};

/**
 * A panel ordered by cards held: captions, figures and tracks. `starter` holds three numbers of
 * Modern Horizons 2 against its 303, and two of Alpha, which prints no size at all.
 */
export const MostCardsOnAPanel: Story = {
  args: { widget: sets(3, 5, { sort: "cards" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Set completion" }));
    const mh2 = (await card.findByText("Modern Horizons 2")).closest("li") as HTMLElement;
    await expect(within(mh2).getByText("3 of 303")).toBeInTheDocument();
    await expect(within(mh2).getByText("<1%")).toBeInTheDocument();
    const alpha = card.getByText("Limited Edition Alpha").closest("li") as HTMLElement;
    await expect(within(alpha).getByText("2 cards")).toBeInTheDocument();
    await expect(within(alpha).getByText("—")).toBeInTheDocument();
  },
};

/** Alphabetical, with the tracks switched off. */
export const AlphabeticalWithoutBars: Story = {
  args: { widget: sets(3, 5, { sort: "name", bars: false }) },
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByRole("list", { name: "Sets" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
    await expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    // No track anywhere: the accent fill is the track's and nothing else's in a row.
    await expect(list.querySelector(".bg-accent")).toBeNull();
  },
};

/** An empty collection has no sets, and says where they will come from. */
export const NoSetsYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("No sets yet — the sets your cards come from will appear here."),
    ).toBeInTheDocument();
  },
};
