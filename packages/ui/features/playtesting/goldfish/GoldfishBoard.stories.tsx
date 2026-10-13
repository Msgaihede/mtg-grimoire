import { useState, type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { GoldfishAction, GoldfishView } from "@/lib/ipc";
import { GoldfishBoard } from "./GoldfishBoard";
import { discardView, openingHandView, playLocally, turnNineView } from "./fixtures";
import type { LogLine } from "./log";
import type { Playmat } from "./types";

/**
 * The board, played locally: each action goes to `onAct` (recorded) and to `playLocally`, the
 * fixtures' outline of what the engine would answer, so a reader clicking through a story sees
 * the table move. The rules are Rust's and are not here — see `fixtures.ts`.
 */
function Played({
  start,
  onAct,
  log = [],
  playmat,
}: {
  start: GoldfishView;
  onAct: (a: GoldfishAction) => void;
  log?: LogLine[];
  playmat?: Playmat;
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
      initialPlaymat={playmat}
    />
  );
}

const TURN_NINE_LOG: LogLine[] = [
  { turn: 9, text: "The opponent took 7, down to 12", kind: "life" },
  { turn: 9, text: "Created 5 Treasure tokens", kind: "token" },
  { turn: 9, text: "Cast Consecrated Sphinx", kind: "cast" },
  { turn: 9, text: "Played Urza's Saga", kind: "land" },
  { turn: 9, text: "Drew Urza's Saga", kind: "draw" },
  { turn: 9, text: "Untapped · turn 9 begins", kind: "turn" },
  { turn: 8, text: "Cast Sol Ring", kind: "cast" },
  { turn: 8, text: "Played Command Tower", kind: "land" },
  { turn: 8, text: "Drew Sol Ring", kind: "draw" },
  { turn: 8, text: "Untapped · turn 8 begins", kind: "turn" },
  { turn: 0, text: "Kept seven", kind: "deal" },
  { turn: 0, text: "Shuffled and drew seven", kind: "deal" },
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

/** Space is the next turn's key, even with a card in hand focused from a click. */
export const SpaceForNextTurn: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Turn 9 ·/)).toBeVisible();
    await userEvent.keyboard(" ");
    await expect(args.onAct).toHaveBeenLastCalledWith({ type: "nextTurn" });
    await expect(canvas.getByText(/Turn 10 ·/)).toBeVisible();
  },
};

/**
 * Nine cards in hand at the end of the turn: the board asks which two are discarded, and the
 * turn passes once they are picked.
 */
export const DiscardToHandSize: Story = {
  args: { start: { ...turnNineView(), hand: discardView(2).hand } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Next turn/ }));
    const dialog = within(await canvas.findByRole("dialog", { name: "Discard to hand size" }));
    await expect(canvas.getByText(/Turn 9 ·/)).toBeInTheDocument();
    const [first, , third] = args.start.hand;
    await userEvent.click(dialog.getByRole("button", { name: first.name }));
    await userEvent.click(dialog.getByRole("button", { name: third.name }));
    await userEvent.click(dialog.getByRole("button", { name: "Discard 2 and end the turn" }));
    await expect(args.onAct).toHaveBeenLastCalledWith({
      type: "discard",
      ids: [first.id, third.id],
    });
    await expect(canvas.getByText(/Turn 10 ·/)).toBeVisible();
  },
};

/** The log, cut into turns under a heading each, newest first. */
export const LogByTurn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Log" }));
    const log = canvas.getByRole("region", { name: "Game log" });
    await expect(within(log).getByRole("heading", { name: "Turn 9" })).toBeVisible();
    await expect(within(log).getByRole("heading", { name: "Turn 8" })).toBeVisible();
    await expect(within(log).getByRole("heading", { name: "Opening hand" })).toBeVisible();
  },
};

/** A coloured felt behind the table (the game menu's Playmat). */
export const GreenFelt: Story = {
  args: { playmat: "green" },
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
