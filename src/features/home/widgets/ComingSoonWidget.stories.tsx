import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget, UpcomingSets } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ComingSoonFace, ComingSoonWidget } from "./ComingSoonWidget";

/** The grid's target cell. Not exported, for CSF. */
const CELL = 104;

/**
 * An answer, **constructed** — the sets are invented and describe no real release. The fake's
 * `waiting` world holds three unreleased sets, one per window, which is what every other story
 * here reads; five are drawn from this instead so a whole row has four columns to fill and wraps
 * into a second, which no world the fake stands up can show. `OptimizeWishlistDialog.stories.tsx`
 * is the precedent for a constructed answer. Not exported, for CSF.
 */
const ANNOUNCED: UpcomingSets = {
  today: "2026-09-26",
  sets: [
    { code: "gls", name: "Glass Tides", releasedAt: "2026-09-27", previewed: 12, inDecks: 0 },
    { code: "trk", name: "Horizon Trek", releasedAt: "2026-10-08", previewed: 79, inDecks: 3 },
    { code: "emb", name: "Ember Court", releasedAt: "2026-10-30", previewed: 41, inDecks: 0 },
    { code: "ash", name: "Echoes of Ash", releasedAt: "2026-12-04", previewed: 5, inDecks: 1 },
    { code: "vlt", name: "Vault Relics", releasedAt: "2026-12-18", previewed: 164, inDecks: 7 },
  ],
};

function coming(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "comingSoon", kind: "comingSoon", x: 0, y: 0, w, h, config };
}

function fitOf(widget: HomeWidget) {
  return makeFit({
    w: widget.w,
    h: widget.h,
    widthPx: spanPx(widget.w, CELL),
    heightPx: spanPx(widget.h, CELL),
    density: widgetDensity(widget),
  });
}

/** The whole body inside the real card, reading through the fake. */
function Framed({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const fit = fitOf(widget);
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: fit.widthPx, height: fit.heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={onConfig}
          onRemove={fn()}
        >
          <ComingSoonWidget
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

/** The face inside the real card, drawn from {@link ANNOUNCED} — see there for why. */
function FramedFace({ widget, still = false }: { widget: HomeWidget; still?: boolean }) {
  const fit = fitOf(widget);
  return (
    <div className="p-2">
      <div style={{ width: fit.widthPx, height: fit.heightPx }}>
        <WidgetCard
          widget={widget}
          fit={fit}
          editing={false}
          still={still}
          onConfig={fn()}
          onRemove={fn()}
        >
          <ComingSoonFace answer={ANNOUNCED} days={90} fit={fit} still={still} />
        </WidgetCard>
      </div>
    </div>
  );
}

const meta = {
  title: "Home/ComingSoonWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The kind's default footprint: four cells by two, ninety days.
    widget: coming(4, 2),
  },
  parameters: {
    // The one world with anything announced: `Foretold Frontiers` 12 days out, `Vigil of the
    // Drowned` 40, `Lumen Reach` 200 — so 30, 90 and a year each answer a different list.
    fake: { seed: "waiting" },
    docs: {
      description: {
        component:
          "Sets with previewed cards that have not released yet, soonest first — read from " +
          "`cards` rather than `sets`, which the browser build never fills. Two count figures " +
          "(body ink, not gold) and a row per set whose caption is its code, how far off it is " +
          "in UTC days from the read's own date, how many of its cards are out and — only when " +
          "there are some — how many your decks already play. A press shows the set in the " +
          "search with the format picker on `Any card`.\n\n" +
          "Every story reads through the fake's `waiting` world, which holds three invented " +
          "sets past the workbench's clock, except the whole-row story: five sets across four columns " +
          "is more than any world holds, so that face is drawn from a **constructed** answer. " +
          "The last two stories are the starter world, whose corpus has nothing unreleased but " +
          "a token the read leaves out — the empty sentence, in the window's own words.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default footprint: the figures, and a row for each of the two sets inside ninety days. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(
      await card.findByRole("button", {
        name: "Foretold Frontiers · FTF · in 12 days · 4 seen · 2 in your decks",
      }),
    ).toBeInTheDocument();
    // No deck plays anything in it, so the caption stops at what has been seen.
    await expect(
      card.getByRole("button", { name: "Vigil of the Drowned · VGD · in 40 days · 2 seen" }),
    ).toBeInTheDocument();
    await expect(card.getByText("Previewed so far")).toBeInTheDocument();
  },
};

/** The widest window, a cell taller: the set two hundred days out joins the other two. */
export const AYear: Story = {
  args: { widget: coming(4, 3, { window: 365 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(
      await card.findByRole("button", {
        name: "Lumen Reach · LMR · in 200 days · 1 seen · 1 in your decks",
      }),
    ).toBeInTheDocument();
  },
};

/** A two-cell tile: the caption keeps the code and the day. */
export const Tile: Story = {
  args: { widget: coming(2, 3) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(await card.findByText("FTF · in 12 days")).toBeInTheDocument();
  },
};

/** A catalogue preview: the rows as pictures, nothing to press. */
export const Still: Story = {
  args: { still: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(await card.findByText("Foretold Frontiers")).toBeInTheDocument();
    await expect(card.queryByRole("button", { name: /^Foretold Frontiers · / })).toBeNull();
  },
};

/** A whole row, three tall: five constructed sets, four columns across. */
export const WholeRow: Story = {
  args: { widget: coming(8, 3) },
  render: (args) => <FramedFace {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Coming soon" }));
    await expect(
      card.getByRole("button", { name: "Vault Relics · VLT · in 83 days · 164 seen · 7 in your decks" }),
    ).toBeInTheDocument();
  },
};

/** The starter world, which has nothing announced: the window's own words. */
export const NothingAnnounced: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Nothing announced for the next 90 days."),
    ).toBeInTheDocument();
  },
};

/** The widest window says `year`, not `365 days`. */
export const NothingInAYear: Story = {
  args: { widget: coming(4, 2, { window: 365 }) },
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Nothing announced for the next year.")).toBeInTheDocument();
  },
};
