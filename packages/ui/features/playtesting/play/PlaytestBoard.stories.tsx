import { useCallback, useEffect, useState, type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { PlaytestAction, PlaytestHappened, PlaytestView } from "@/lib/ipc";
import { appendLog, type LogLine } from "../goldfish/log";
import {
  attackStep,
  blockStep,
  castChoicePrompt,
  orderTriggersPrompt,
  combatArrowsView,
  damageHappened,
  discardPick,
  fourPlayer,
  fourPlayerAttack,
  fourPlayerCombat,
  fourPlayerLost,
  gameOver,
  openingHand,
  replayStep,
  respondStep,
  scryPick,
  targetPrompt,
  turnFive,
  withStack,
} from "./fixtures";
import { playtestLines } from "./log";
import { replayEntries, useReplay, type ReplayEntry } from "./useReplay";
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
  happened,
  opponentNames = ["Boros Aggro"],
}: {
  view: PlaytestView | null;
  onAct: (a: PlaytestAction) => void;
  busy?: boolean;
  log?: LogLine[];
  error?: string | null;
  /** Facts to pop once the board is drawn (the damage story). */
  happened?: PlaytestHappened[];
  /** One deck a duel, three a four-player table. */
  opponentNames?: string[];
}): JSX.Element {
  // Handed over a moment after the first paint, as a step's facts arrive after its view.
  const [later, setLater] = useState<PlaytestHappened[] | undefined>(undefined);
  useEffect(() => {
    if (happened === undefined) return;
    const t = window.setTimeout(() => setLater(happened), 300);
    return () => window.clearTimeout(t);
  }, [happened]);
  return (
    <PlaytestBoard
      deckName="Simic Tempo"
      opponentNames={opponentNames}
      view={view}
      log={log}
      error={error}
      busy={busy}
      onAct={onAct}
      onBack={() => {}}
      onNewGame={() => {}}
      happened={later}
    />
  );
}

/**
 * The opponent's turn played back from fake frames (`replayStep`), as `usePlaytestGame` plays a
 * step's frames: a beat every 450 ms, the log and the pops fed as it goes, Skip to end it.
 * "Replay again" starts over.
 */
function Replayed({ onAct }: { onAct: (a: PlaytestAction) => void }): JSX.Element {
  const [{ start, step }] = useState(replayStep);
  const [view, setView] = useState<PlaytestView>(start);
  const [log, setLog] = useState<LogLine[]>([]);
  const [happened, setHappened] = useState<readonly PlaytestHappened[]>([]);
  const apply = useCallback((e: ReplayEntry) => {
    setView(e.view);
    setHappened(e.quiet ? [] : e.happened);
    setLog((old) => appendLog(old, playtestLines(e.happened, e.view.turn)));
  }, []);
  const replay = useReplay(apply);
  const { play } = replay;
  const again = useCallback(() => {
    setView(start);
    setLog([]);
    window.setTimeout(() => play(replayEntries(step, step.frames)), 600);
  }, [play, start, step]);
  useEffect(() => {
    const t = window.setTimeout(() => play(replayEntries(step, step.frames)), 600);
    return () => window.clearTimeout(t);
  }, [play, step]);
  return (
    <PlaytestBoard
      deckName="Simic Tempo"
      opponentNames={["Boros Aggro"]}
      view={view}
      log={log}
      error={null}
      busy={false}
      onAct={onAct}
      onBack={() => {}}
      onNewGame={again}
      happened={happened}
      replaying={replay.replaying}
      onSkip={replay.skip}
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
    // The whole canvas, as the board fills the window below the caption: measured at 1280 × 766
    // (1280 × 800 less the 34 px caption) and 1440 × 866.
    (Story) => (
      <div className="h-screen w-screen">
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
    await expect(canvas.getByRole("group", { name: "Turn 5 · Your main phase" })).toBeVisible();
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
    await userEvent.click(within(yours).getByRole("button", { name: /^Llanowar Elves/ }));
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

/** Two triggers at once: each answer is an order, said first-to-resolve first, with pictures. */
export const OrderTriggers: Story = {
  args: { view: orderTriggersPrompt().view },
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

/** Combat after blocks: Tarmogoyf at the opponent, Delver at Jace, Ragavan blocking Delver —
 *  arrows from each attacker to its target and from the blocker to its attacker. */
export const CombatArrows: Story = {
  args: { view: combatArrowsView().view },
};

/** Damage lands: "−3" over Tarmogoyf, "−4" over Ragavan, the opponent's −3 and your +2. */
export const DamagePops: Story = {
  args: (() => {
    const t = turnFive();
    return { view: t.view, happened: damageHappened(t) };
  })(),
};

/** The opponent's turn played back from frames, a beat every 450 ms; Space, Escape or Skip ends it. */
export const Replay: Story = {
  render: (args) => <Replayed onAct={args.onAct} />,
};

/** The opponent's Lightning Bolt on the stack and the reader may respond: Pass, or Pass turn. */
export const Respond: Story = {
  args: { view: respondStep().view },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Pass turn" }));
    await expect(args.onAct).toHaveBeenLastCalledWith({ type: "endTurn" });
  },
};

/** The stops popover, open: the opponent's upkeep is a stop, the reader's mains always are. */
export const Stops: Story = {
  args: { view: respondStep().view },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Stops" }));
  },
};

/** Aiming an attack: Tarmogoyf picked, Jace lit as what it may attack instead of the player. */
export const AimAttack: Story = {
  args: { view: attackStep().view },
  play: async ({ canvasElement }) => {
    const yours = within(canvasElement).getByRole("region", { name: "Your battlefield" });
    await userEvent.click(within(yours).getByRole("button", { name: /^Tarmogoyf/ }));
  },
};

/** Scry 3: Keep on top, in order, and Bottom. */
export const ScryPick: Story = {
  args: { view: scryPick().view },
};

/** Discard exactly two; the land cannot be picked. */
export const DiscardPick: Story = {
  args: { view: discardPick().view },
};

/** One deck in each of three opponents' seats. */
const POD = ["Boros Aggro", "Thrasios & Tymna", "Bruna Angels"];

/**
 * A four-player Commander table (issue #994): three opponent areas side by side over the
 * reader's table, in turn order from the left — Opponent 2 on three poison, Opponent 3 out.
 */
export const FourPlayer: Story = {
  args: { view: fourPlayer().view, opponentNames: POD, log: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("region", { name: "Opponent 2's battlefield" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Opponent 3 · Bruna Angels" })).toHaveAttribute(
      "data-out",
      "true",
    );
  },
};

/** Aiming at a four-player table: the Elves picked, each opponent still in a plate to click. */
export const FourPlayerAttack: Story = {
  args: { view: fourPlayerAttack().view, opponentNames: POD, log: [] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const yours = canvas.getByRole("region", { name: "Your battlefield" });
    await userEvent.click(within(yours).getByRole("button", { name: /^Llanowar Elves/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Attack Opponent 2" }));
    await userEvent.click(canvas.getByRole("button", { name: /Attack with 1/ }));
    await expect(args.onAct).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attacks: [expect.objectContaining({ player: "opponent2" })],
      }),
    );
  },
};

/** One AI attacking another: Opponent 2's Lurrus at Opponent 1, the arrow between their areas. */
export const FourPlayerCombat: Story = {
  args: { view: fourPlayerCombat().view, opponentNames: POD, log: [] },
};

/** The reader out of a four-player game: "You lost", though the others play on. */
export const FourPlayerLost: Story = {
  args: { view: fourPlayerLost().view, opponentNames: POD, log: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { name: "You lost" })).toBeVisible();
  },
};
