import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import type { Finish } from "@/lib/finish";
import type { PriceMoverWindow } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { printing } from "../../../../.storybook/fake/fixtures";

import { NO_HISTORY_SENTENCE, PriceHistoryDialog } from "./PriceHistoryDialog";

/**
 * **The Alpha Lightning Bolt, `lea 161`, nonfoil** — a copy the `starter` collection owns and
 * TCGplayer prices, so the fake's `price_history` answers a remembered line for it. Looked up by
 * `(setCode, collectorNumber)` rather than a pasted id, so a regenerated corpus fails this file at
 * load instead of opening the popup on a printing nothing knows.
 */
const ALPHA_BOLT = printing("lea", "161").id;

/**
 * **The Mystical Archive Bolt, `sta 105`, etched** — the seed's one etched copy and a Japanese
 * printing sold three ways, so the art column draws three price cells and the subtitle names the
 * copy by its finish rather than assuming foil.
 */
const ARCHIVE_BOLT = printing("sta", "105").id;

/**
 * **Alpha Ancestral Recall, `lea 47`** — owned by nobody in `starter` and quoted by no TCGplayer
 * price, so there is no remembered day *and* no price today: the empty state at its emptiest.
 */
const ALPHA_RECALL = printing("lea", "47").id;

/**
 * The popup, opened the way the app opens it — through the store, never through a prop.
 *
 * `PriceHistoryDialog` takes nothing: it reads `priceHistory` and is mounted once at `App` level,
 * so a story opens it the way a widget row does. **`useState`'s lazy initializer rather than an
 * effect**, `CardDetailModal.stories.tsx`'s answer and for its reason: an effect runs after the
 * first paint, so the story would draw one frame of a closed dialog before it opened.
 */
function Popup({
  cardId,
  finish,
  range,
}: {
  cardId: string;
  finish: Finish;
  /** The request's `window`, named `range` so it does not shadow the global in a component. */
  range: PriceMoverWindow;
}) {
  useState(() => {
    useAppStore.getState().openPriceHistory({ cardId, finish, window: range });
    return null;
  });
  return <PriceHistoryDialog />;
}

/**
 * One frame per story. **`transform: translateZ(0)`** makes `position: fixed` resolve against this
 * box rather than the viewport — every dialog story's trick — so the scrim fills the frame and
 * `Dialog`'s `max-w-full` clamps the panel to it, and the container queries inside measure the
 * width the panel really got. A 390px frame therefore draws the phone fold whatever the browser
 * window is doing.
 */
function Frame({
  width,
  height,
  ...request
}: {
  cardId: string;
  finish: Finish;
  range: PriceMoverWindow;
  width: number;
  height: number;
}) {
  return (
    <div
      style={{ transform: "translateZ(0)", width, height }}
      className="relative overflow-hidden rounded-lg border border-border bg-bg"
    >
      <Popup {...request} />
    </div>
  );
}

const meta = {
  title: "Home/PriceHistoryDialog",
  component: Frame,
  tags: ["autodocs"],
  args: { cardId: ALPHA_BOLT, finish: "nonfoil", range: "30d", width: 1000, height: 820 },
  // Keyed on everything the initializer reads, so a change in Controls mounts a fresh host and
  // writes a fresh request rather than editing a store the mounted popup is already reading.
  render: (args) => (
    <Frame key={`${args.cardId}:${args.finish}:${args.range}:${args.width}`} {...args} />
  ),
  parameters: {
    docs: {
      // **Each story gets its own frame**, which is the one thing that gives it its own
      // `useAppStore`: every story here writes `priceHistory` during render, and inline a docs page
      // mounts them all at once and the last one to render owns the store for every heading.
      story: { inline: false, height: "900px" },
      description: {
        component:
          "The Price movers widget's popup: one owned copy's price over a range, beside the card " +
          "it is the price of.\n\n" +
          "**The left column is the card details popup's own** — `CardModalArt`, with its frame, " +
          "chin, view controls and per-finish price cells — and the heading, the footer buttons, " +
          "the ceiling and the artist credit are that modal's too. The right-hand column is this " +
          "popup's: the range (in the widget's own words), the figures in the price cells' " +
          "style, where today sits between the range's low and high, and the line.\n\n" +
          "**Money is gold and a move is a fill** — the home page's two colour rules, so the " +
          "popup and the row it opened from agree about what gold and green mean.",
      },
    },
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * `@min-[900px]/card`: **two columns, `[20rem_1fr]`** — the card modal's art column at the card
 * modal's width, and the history beside it. Opened on thirty days, as a widget set to a month opens
 * it; the switch re-measures in place.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: /price history of lightning bolt/i });
    const panel = within(dialog);

    await expect(await panel.findByText("Change over 30 days")).toBeInTheDocument();
    await userEvent.click(panel.getByRole("radio", { name: "7 days" }));
    await expect(await panel.findByText("Change over 7 days")).toBeInTheDocument();
    await expect(panel.getByRole("radio", { name: "7 days" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};

/**
 * `@min-[640px]/card`: **two columns, `[18.75rem_1fr]`** — the card modal's own 640 width, where
 * the two popups draw one panel.
 */
export const Narrow: Story = {
  args: { width: 764 },
};

/**
 * The phone fold: **full-bleed, one column, one scroller** — the picture, then the range, the
 * figures and the line, stacked in a single thumb-driven scroll with every control at 44px.
 */
export const Phone: Story = {
  args: { width: 390, height: 844 },
};

/**
 * An etched copy over a week. The subtitle names the finish the row was about, the art column
 * opens on the etched sheen (`openedAs`), and its three price cells sit under the picture beside
 * the history's own.
 */
export const EtchedWeek: Story = {
  args: { cardId: ARCHIVE_BOLT, finish: "etched", range: "7d" },
};

/**
 * **Nothing remembered yet** — its own sentence, and never *nothing moved*: the first refresh after
 * install has no yesterday to compare with, and that heals by itself. This copy is unpriced today
 * as well, so there is no *Now* to quote either; the card, its credit and the footer still stand.
 */
export const NoHistoryYet: Story = {
  args: { cardId: ALPHA_RECALL, finish: "nonfoil" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NO_HISTORY_SENTENCE)).toBeInTheDocument();
    await expect(canvas.queryByText(/^Change over/)).not.toBeInTheDocument();
  },
};
