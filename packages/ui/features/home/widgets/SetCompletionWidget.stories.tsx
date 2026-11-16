import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import {
  NOTHING_CHOSEN,
  SetCompletionWidget,
  SetCompletionWidgetSettings,
} from "./SetCompletionWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `setCompletion` widget at a footprint, with a config. */
function sets(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "setCompletion", kind: "setCompletion", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell — with the set
 * checklist the page hands this kind as its `extraSettings`, so the settings popover is the shipped
 * one.
 */
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
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          onConfig={onConfig}
          onRemove={fn()}
          extraSettings={<SetCompletionWidgetSettings widget={widget} onConfig={onConfig} />}
        >
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

/** The set names in drawn order. */
function drawnNames(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

const meta = {
  title: "Home/SetCompletionWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: two cells by two, recently changed first, tracks on.
    widget: sets(2, 2),
  },
  parameters: {
    docs: {
      description: {
        component:
          "How close each set the reader collects is to complete. `set_completion` counts the " +
          "**distinct collector numbers** held — inside the set's printed size, and of every " +
          "number the set has; which one is drawn, which sets and in what order are this body's.\n\n" +
          "**Every set has a denominator** (issue #1692). Scryfall has published no printed size " +
          "since early 2023, so such a set — and Alpha, which never printed one — is measured " +
          "against **every printing it has**, says so on its hint, and draws a figure and a track " +
          "like any other. `Count against → Every printing` measures every set that way.\n\n" +
          "**`Recently changed` is the default order**, so the set a reader just added to is the " +
          "first row. Token and promo sets wait for `Token & promo sets`; `Which sets → Chosen…` " +
          "opens a checklist at the foot of the settings. A row opens its set on the Search page. " +
          "**A percentage never rounds up to done** — it is floored, and a set barely started " +
          "reads `<1%`.\n\n" +
          "On a two-cell tile the figure moves under the name, `WidgetRow`'s rule.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default tile: the percentage under each name, and a track under that — every row has one. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Set completion" }));
    const list = await card.findByRole("list", { name: "Sets" });
    await expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
    await expect(within(list).queryByText("—")).toBeNull();
  },
};

/**
 * A panel ordered by cards held: captions, figures and tracks. `starter` holds three numbers of
 * Modern Horizons 2 against its 303, and two of Alpha — which prints no size, so it is measured
 * against its 295 printings rather than drawn as an em dash.
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
    await expect(within(alpha).getByText("2 of 295")).toBeInTheDocument();
    await expect(within(alpha).queryByText("—")).toBeNull();
  },
};

/** Every set measured whole: Modern Horizons 2's three numbers against all 492 of its printings. */
export const EveryPrinting: Story = {
  args: { widget: sets(3, 5, { sort: "cards", measure: "all" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Set completion" }));
    const mh2 = (await card.findByText("Modern Horizons 2")).closest("li") as HTMLElement;
    await expect(within(mh2).getByText("3 of 492")).toBeInTheDocument();
  },
};

/** Two chosen sets and nothing else, from the checklist at the foot of the settings. */
export const ChosenSets: Story = {
  args: { widget: sets(3, 4, { scope: "chosen", setCodes: ["lea", "mh2"], sort: "name" }) },
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByRole("list", { name: "Sets" });
    await expect(drawnNames(list)).toEqual(["Limited Edition Alpha", "Modern Horizons 2"]);
  },
};

/** `Chosen…` with nothing ticked yet asks for a choice. */
export const NothingChosen: Story = {
  args: { widget: sets(3, 3, { scope: "chosen" }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(NOTHING_CHOSEN)).toBeInTheDocument();
  },
};

/** Alphabetical, with the tracks switched off. */
export const AlphabeticalWithoutBars: Story = {
  args: { widget: sets(3, 5, { sort: "name", bars: false }) },
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByRole("list", { name: "Sets" });
    const names = drawnNames(list);
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
      await canvas.findByText("No sets yet. Sets you own cards from show up here."),
    ).toBeInTheDocument();
  },
};
