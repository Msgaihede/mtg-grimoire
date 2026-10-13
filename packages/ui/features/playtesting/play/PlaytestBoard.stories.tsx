import type { JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { PlaytestAction, PlaytestView } from "@/lib/ipc";
import type { LogLine } from "../goldfish/log";
import {
  attackStep,
  blockStep,
  castChoicePrompt,
  gameOver,
  openingHand,
  targetPrompt,
  turnFive,
  withStack,
} from "./fixtures";
import { PlaytestBoard } from "./PlaytestBoard";

/**
 * The board drawn from a fixture view, each action recorded (`onAct`). There is no engine and no
 * AI behind a story — a click is asked for, not played — so the stories show the table in each of
 * its stages, not the rules (`fixtures.ts`).
 */
function Board({
  view,
  onAct,
  busy = false,
  log = [],
  error = null,
}: {
  view: PlaytestView | null;
  onAct: (a: PlaytestAction) => void;
  busy?: boolean;
  log?: LogLine[];
  error?: string | null;
}): JSX.Element {
  return (
    <PlaytestBoard
      deckName="Simic Tempo"
      opponentName="Boros Aggro"
      view={view}
      log={log}
      error={error}
      busy={busy}
      onAct={onAct}
      onBack={() => {}}
      onNewGame={() => {}}
    />
  );
}

const LOG: LogLine[] = [
  { turn: 5, text: "Played Forest", kind: "land" },
  { turn: 5, text: "Drew Forest", kind: "draw" },
  { turn: 5, text: "Your turn 5 begins", kind: "turn" },
  { turn: 4, text: "The opponent attacked with Ragavan, Nimble Pilferer", kind: "combat" },
  { turn: 4, text: "You lost 2 life", kind: "life" },
  { turn: 4, text: "The opponent cast Boros Reckoner", kind: "cast" },
  { turn: 4, text: "The opponent drew a card", kind: "draw" },
  { turn: 4, text: "The opponent's turn 4 begins", kind: "turn" },
];

const meta = {
  title: "Playtesting/PlaytestBoard",
  component: Board,
  tags: ["autodocs"],
  args: { view: turnFive().view, onAct: fn(), log: LOG },
  decorators: [
    // The smallest window the board is drawn for: 1280 × 800, less the 34 px caption.
    (Story) => (
      <div className="h-[766px] w-[1280px]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The playtest board — a deck against another of the reader's decks, the opponent " +
          "played by phase.rs's AI. **Presentational**: a view in, actions out. The opponent's " +
          "half is the reader's turned round; the middle line holds the turn, the stack and the " +
          "combat. These stories record what the board asks; there is no engine behind them.",
      },
    },
  },
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Turn 5, the reader's first main phase: To combat, or End turn. */
export const YourMainPhase: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Turn 5 · Your main phase")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /To combat/ }));
    await expect(args.onAct).toHaveBeenLastCalledWith({ type: "pass" });
  },
};

/** A spell of each seat's on the stack, top first. */
export const StackInUse: Story = {
  args: { view: withStack().view },
};

/** Declaring attackers: a click marks an attacker; the button counts them. */
export const AttackStep: Story = {
  args: { view: attackStep().view },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const yours = canvas.getByRole("region", { name: "Your battlefield" });
    await userEvent.click(within(yours).getByRole("button", { name: /^Tarmogoyf/ }));
    await userEvent.click(canvas.getByRole("button", { name: /Attack with 1/ }));
    await expect(args.onAct).toHaveBeenLastCalledWith(expect.objectContaining({ type: "attack" }));
  },
};

/** Declaring blockers against the opponent's Ragavan. */
export const BlockStep: Story = {
  args: { view: blockStep().view },
};

/** Swords to Plowshares wants a target: the panel, and the targets lit on the table. */
export const TargetPrompt: Story = {
  args: { view: targetPrompt().view },
};

/** How to cast an adventurer. */
export const CastChoice: Story = {
  args: { view: castChoicePrompt().view },
};

/** The opponent's turn being played out. */
export const OpponentThinking: Story = {
  args: { view: { ...turnFive().view, active: "opponent", turn: 6 }, busy: true },
};

/** The engine refused an action: said in the middle line until the next. */
export const Refused: Story = {
  args: { error: "Sol Ring can't be cast: it is already on the battlefield." },
};

/** The opening hands. */
export const OpeningHand: Story = {
  args: { view: openingHand(), log: [] },
};

/** Game over: the reader won on turn 9. */
export const GameOver: Story = {
  args: { view: gameOver().view },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { name: "You won" })).toBeVisible();
  },
};

/** Before the engine has dealt. */
export const Dealing: Story = {
  args: { view: null, busy: true, log: [] },
};
