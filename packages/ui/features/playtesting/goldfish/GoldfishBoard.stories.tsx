import { useState, type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { GoldfishAction, GoldfishView } from "@/lib/ipc";
import { GoldfishBoard } from "./GoldfishBoard";
import { openingHandView, playLocally, turnNineView } from "./fixtures";
import type { LogLine } from "./log";

/**
 * The board, played locally: each action goes to `onAct` (recorded) and to `playLocally`, the
 * fixtures' outline of what the engine would answer, so a reader clicking through a story sees
 * the table move. The rules are Rust's and are not here — see `fixtures.ts`.
 */
function Played({
  start,
  onAct,
  log = [],
}: {
  start: GoldfishView;
  onAct: (a: GoldfishAction) => void;
  log?: LogLine[];
}): JSX.Element {
  const [view, setView] = useState(start);
  return (
    <GoldfishBoard
      deckName="Kenrith"
      view={view}
      log={log}
      error={null}
      onAct={(a) => {
        onAct(a);
        setView((v) => playLocally(v, a));
      }}
      onBack={() => {}}
      onNewGame={() => setView(start)}
    />
  );
}

const TURN_NINE_LOG: LogLine[] = [
  { turn: 9, text: "The opponent took 7, down to 12" },
  { turn: 9, text: "Created 5 Treasure tokens" },
  { turn: 9, text: "Cast Consecrated Sphinx" },
  { turn: 9, text: "Played Urza's Saga" },
  { turn: 9, text: "Drew Urza's Saga" },
  { turn: 9, text: "Untapped · turn 9 begins" },
];

const meta = {
  title: "Playtesting/GoldfishBoard",
  component: Played,
  args: { start: turnNineView(), onAct: fn(), log: TURN_NINE_LOG },
  decorators: [
    // The board fills the window below the caption; 1440 × 866 is the artboard's frame.
    (Story) => (
      <div className="h-[866px] w-[1440px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The goldfish board — a game of a deck against a target that does nothing, on " +
          "phase.rs's rules engine. **Presentational**: a view in, actions out. These stories " +
          "answer actions with `fixtures.ts`' outline of the engine, so they show the table, " +
          "not the rules (`docs/reference/goldfish.md`).",
      },
    },
  },
} satisfies Meta<typeof Played>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The artboard *Goldfish · the table, turn 9*. */
export const TurnNine: Story = {};

/** Next turn: the board asks for it and the table moves on. */
export const NextTurn: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("region", { name: "Battlefield" })).toBeVisible();
    await expect(canvas.getByText("Turn 9 · 16 mana open · hand 4")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Next turn/ }));
    await expect(args.onAct).toHaveBeenLastCalledWith({ type: "nextTurn" });
    await expect(canvas.getByText(/Turn 10 ·/)).toBeVisible();
  },
};

/** The artboard *Goldfish · opening hand*: mulligan 2, the first free, one card to the bottom. */
export const OpeningHand: Story = {
  args: { start: openingHandView(), log: [{ turn: 0, text: "Mulligan 2 · drew seven" }] },
};

/** Picking the card to bottom and keeping six. */
export const KeepingSix: Story = {
  args: { start: openingHandView(), log: [{ turn: 0, text: "Mulligan 2 · drew seven" }] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Opening hand" })).toBeVisible();
    const hand = canvas.getByRole("group", { name: "Opening hand" });
    await userEvent.click(within(hand).getAllByRole("button")[5]);
    await userEvent.click(canvas.getByRole("button", { name: /keep 6/i }));
    await expect(args.onAct).toHaveBeenCalledWith(expect.objectContaining({ type: "keep" }));
  },
};

/** A crowded table: thirty more lands, and every row still one row. */
export const CrowdedTable: Story = {
  args: { start: turnNineView({ extraLands: 30 }) },
};

/** The goldfish at 0: the plate says when, with a gold edge, and the game goes on. */
export const OpponentDead: Story = {
  args: { start: { ...turnNineView(), opponentLife: 0 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Opponent · dead on turn 9")).toBeVisible();
  },
};

/** Before the engine has dealt: the table says so. */
export const Dealing: Story = {
  render: () => (
    <GoldfishBoard
      deckName="Kenrith"
      view={null}
      log={[]}
      error={null}
      onAct={() => {}}
      onBack={() => {}}
      onNewGame={() => {}}
    />
  ),
};
