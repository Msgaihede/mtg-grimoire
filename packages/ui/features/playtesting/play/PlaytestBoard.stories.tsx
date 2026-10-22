import { useCallback, useEffect, useState, type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { GameCard, PlaytestAction, PlaytestHappened, PlaytestView } from "@/lib/ipc";
import { appendLog, type LogLine } from "../table/log";
import type { Playmat } from "../table/types";
import {
  GOLDFISH,
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
  goldfishCommanderDead,
  goldfishDead,
  goldfishOpeningHand,
  goldfishTurn,
  castPick,
  keepPick,
  openingHand,
  optionalEffectPrompt,
  playLocally,
  replayStep,
  respondStep,
  scryPick,
  targetPrompt,
  turnFive,
  withAttachments,
  withEmblems,
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
  initialPlaymat,
  returnTo,
}: {
  view: PlaytestView | null;
  onAct: (a: PlaytestAction) => void;
  busy?: boolean;
  log?: LogLine[];
  error?: string | null;
  /** Facts to pop once the board is drawn (the damage story). */
  happened?: PlaytestHappened[];
  /** One deck a duel, three a four-player table; `["Goldfish"]` against the goldfish. */
  opponentNames?: readonly string[];
  initialPlaymat?: Playmat;
  returnTo?: "setup" | "deck";
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
      initialPlaymat={initialPlaymat}
      returnTo={returnTo}
    />
  );
}

/**
 * A goldfish game, played locally: each action goes to `onAct` (recorded) and to `playLocally`,
 * the fixtures' outline of what the engine would answer to the sandbox's moves, so a reader
 * clicking through the story sees the table move — and the Sandbox chip turn it off and on. The
 * rules are Rust's and are not here: a play is a placement, and the stage button only records.
 */
function Played({
  view: start,
  onAct,
  log = [],
  initialPlaymat,
}: {
  view: PlaytestView;
  onAct: (a: PlaytestAction) => void;
  log?: LogLine[];
  initialPlaymat?: Playmat;
}): JSX.Element {
  const [view, setView] = useState(start);
  return (
    <PlaytestBoard
      deckName="Kenrith"
      opponentNames={GOLDFISH}
      view={view}
      log={log}
      error={null}
      busy={false}
      onAct={(a) => {
        onAct(a);
        setView((v) => playLocally(v, a));
      }}
      onBack={() => {}}
      onNewGame={() => setView(start)}
      initialPlaymat={initialPlaymat}
      returnTo="deck"
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
          "The board — a deck against the goldfish (an opponent that does nothing and never " +
          "loses), or against another of the reader's decks played by phase.rs's AI. " +
          "**Presentational**: a view in, actions out. The opponent's half is the reader's " +
          "turned round; the middle line holds the turn, the stack and the combat. The Sandbox " +
          "chip says whether the hand may change the game outside the rules. These stories " +
          "record what the board asks; there is no engine behind them (the goldfish's answer " +
          "the sandbox's moves in outline, so the table can be handled).",
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

/** Cards the rules engine plays only in part wear a red border, in the hand and on the table
 *  (issue #1093): here the Sphinx in hand and the Sol Ring on the battlefield. */
export const PartlyPlayed: Story = {
  args: (() => {
    const { view } = turnFive();
    const GAPS = ["Trigger:Whenever an opponent draws a card"];
    const mark = (names: string[]) => (c: GameCard) =>
      names.includes(c.name) ? { ...c, gaps: GAPS } : c;
    return {
      view: {
        ...view,
        you: {
          ...view.you,
          hand: view.you.hand.map(mark(["Consecrated Sphinx"])),
          battlefield: view.you.battlefield.map(mark(["Sol Ring"])),
        },
      },
    };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: /^Consecrated Sphinx, played only in part\./ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Sol Ring, played only in part" }),
    ).toBeVisible();
  },
};

/** Each effect on a card is a chip of its own, what happened and where from (issue #1327):
 *  Tarmogoyf made a Demon with a dies trigger by Clavileño, and pumped by Giant Growth. Resting
 *  on it opens the preview, which says each in full. */
export const EffectsOnACard: Story = {
  args: (() => {
    const { view, goyf } = turnFive();
    const from = { lost: [], losesAbilities: false, power: null, toughness: null };
    const affected: GameCard = {
      ...goyf,
      power: 6,
      toughness: 7,
      typeLine: "Creature — Lhurgoyf Demon",
      effects: [
        {
          ...from,
          kind: "type",
          source: "Clavileño, First of the Blessed",
          gained: ["Demon"],
          abilities: [],
        },
        {
          ...from,
          kind: "ability",
          source: "Clavileño, First of the Blessed",
          gained: [],
          abilities: [
            "When ~ dies, draw a card and create a tapped 4/3 white and black Vampire Demon creature token with flying.",
          ],
        },
        {
          ...from,
          kind: "modifyPt",
          source: "Giant Growth",
          gained: [],
          abilities: [],
          power: 3,
          toughness: 3,
        },
      ],
    };
    return {
      view: {
        ...view,
        you: {
          ...view.you,
          battlefield: view.you.battlefield.map((c) => (c.id === goyf.id ? affected : c)),
        },
      },
    };
  })(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+Demon · Clavileño, First of the Blessed")).toBeVisible();
    await expect(canvas.getByText("+3/+3 · Giant Growth")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /^Tarmogoyf, \+Demon from Clavileño/ }),
    ).toBeVisible();
  },
};

/** A spell of each seat's on the stack, top first, each with a dotted arrow at its target: the
 *  reader's Counterspell at the Bolt, the Bolt at the reader's plate (issue #1071). */
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

/** A "you may" in an activated ability: the ability's words beside the yes and the no, so the
 *  reader knows what they agree to (issue #1328). */
export const OptionalEffect: Story = {
  args: { view: optionalEffectPrompt().view },
};

/** Two triggers at once: each answer is an order, said first-to-resolve first, with pictures. Two
 *  Delvers' triggers read alike either way round, so the two orders are one answer. */
export const OrderTriggers: Story = {
  args: { view: orderTriggersPrompt().view },
};

/** One ability's second trigger asking for its target: the header says which creature set it off,
 *  and the tooltip the trigger's words (issue #1076). */
export const TriggerTargetWithCause: Story = {
  args: {
    view: {
      ...targetPrompt().view,
      prompt: {
        ...targetPrompt().view.prompt!,
        kind: "TriggerTargetSelection",
        source: "Impact Tremors",
        sourceText: "Whenever a creature you control enters, it deals 1 damage to any target.",
        cause: { event: "ZoneChanged", id: 70, name: "Grizzly Bears", player: "you" },
        cancellable: false,
      },
    },
  },
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

/** The opponent's Lightning Bolt on the stack and the reader may respond: asked about large over
 *  their table (Let it resolve), with Pass and Pass turn at the foot. */
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

/** Issue #1073: an Equipment and an Aura tucked under the creatures they are attached to, the
 *  reader's Aura on the opponent's creature drawn on the opponent's table. */
export const Attachments: Story = {
  args: { view: withAttachments().view },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const yours = canvas.getByRole("region", { name: "Your battlefield" });
    const theirs = canvas.getByRole("region", { name: "The opponent's battlefield" });
    await expect(
      within(yours).getByRole("button", { name: "Bonesplitter, attached to Tarmogoyf" }),
    ).toBeVisible();
    await expect(
      within(theirs).getByRole("button", {
        name: "Pacifism, attached to Ragavan, Nimble Pilferer",
      }),
    ).toBeVisible();
  },
};

/** Issue #1333: each seat's emblems at the back row's far end, past the artifacts and Equipment —
 *  the reader's on the right, the opponent's on their left. */
export const Emblems: Story = {
  args: { view: withEmblems().view },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const yours = canvas.getByRole("region", { name: "Your battlefield" });
    const theirs = canvas.getByRole("region", { name: "The opponent's battlefield" });
    await expect(
      within(yours).getByRole("img", { name: /^Emblem from Sorin, Lord of Innistrad/ }),
    ).toBeVisible();
    await expect(
      within(theirs).getByRole("img", { name: /^Emblem from Chandra, Torch of Defiance/ }),
    ).toBeVisible();
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

/** Keep creatures with total power 4 or less; one that would pass the cap is drawn dim. */
export const KeepPick: Story = {
  args: { view: keepPick().view },
};

/**
 * "You may cast a spell from your graveyard" (issue #1329): asked as a yes or a no first, and
 * "Choose a card" shows the graveyard's cards to pick from.
 */
export const CastPick: Story = {
  args: { view: castPick().view },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Cast a spell from your graveyard?" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Choose a card" }));
    await expect(canvas.getByRole("heading", { name: "Choose up to 1 to cast" })).toBeVisible();
  },
};

/** One deck in each of three opponents' seats. */
const POD = ["Boros Aggro", "Thrasios & Tymna", "Bruna Angels"];

/**
 * A four-player Commander table (issue #994): three opponent areas side by side over the
 * reader's table, in turn order from the left — Opponent 2 on three poison, Opponent 3 out. Each
 * plate counts the commander damage its player has taken (issue #1336), one mark a commander:
 * Kenrith's 14 on Opponent 2, the 21 in red that put Opponent 3 out, and the reader's 6 and 4
 * from Thrasios and Tymna.
 */
export const FourPlayer: Story = {
  args: { view: fourPlayer().view, opponentNames: POD, log: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("region", { name: "Opponent 2's battlefield" })).toBeVisible();
    await expect(
      canvas.getByLabelText("21 commander damage from Kenrith, the Returned King, lethal"),
    ).toBeVisible();
    await expect(
      canvas.getByLabelText("6 commander damage from Thrasios, Triton Hero"),
    ).toBeVisible();
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

/** The sandbox on against the AI: the reader's cards handled by hand, and the opponent's
 *  permanents' menus — tap, counters, a copy, a move — though never dragged. */
export const SandboxOn: Story = {
  args: { view: { ...turnFive().view, sandbox: true } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: "Sandbox" });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    await expect(args.onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: false });
  },
};

/** The game log from the turn-nine goldfish game, cut into turns, newest first. */
const GOLDFISH_LOG: LogLine[] = [
  { turn: 17, text: "The opponent took 7, down to 12", kind: "life" },
  { turn: 17, text: "Created 5 Treasure tokens", kind: "token" },
  { turn: 17, text: "Cast Consecrated Sphinx", kind: "cast" },
  { turn: 17, text: "Played Urza's Saga", kind: "land" },
  { turn: 17, text: "Drew Urza's Saga", kind: "draw" },
  { turn: 17, text: "Your turn 17 begins", kind: "turn" },
  { turn: 16, text: "The opponent drew a card and passed", kind: "draw" },
  { turn: 16, text: "The opponent's turn 16 begins", kind: "turn" },
  { turn: 15, text: "Cast Sol Ring", kind: "cast" },
  { turn: 15, text: "Played Command Tower", kind: "land" },
  { turn: 15, text: "Your turn 15 begins", kind: "turn" },
  { turn: 0, text: "Kept seven", kind: "deal" },
  { turn: 0, text: "Shuffled and drew seven", kind: "deal" },
];

/**
 * Against the goldfish (the artboard *Goldfish · the table, turn 9*: the reader's ninth turn, the
 * game's seventeenth): a busy table across from the goldfish's empty one, the sandbox on. Played
 * locally — tap, drag, right-click, draw.
 */
export const Goldfish: Story = {
  args: { view: goldfishTurn() },
  render: (args) => <Played view={args.view!} onAct={args.onAct} log={GOLDFISH_LOG} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Opponent · Goldfish")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Sandbox" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("button", { name: /Back to the Kenrith deck/ })).toBeVisible();
  },
};

/** The goldfish game's log, cut into turns under a heading each, newest first. */
export const GoldfishLog: Story = {
  args: { view: goldfishTurn() },
  render: (args) => <Played view={args.view!} onAct={args.onAct} log={GOLDFISH_LOG} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Log" }));
    const log = canvas.getByRole("region", { name: "Game log" });
    await expect(within(log).getByRole("heading", { name: "Turn 17" })).toBeVisible();
    await expect(within(log).getByRole("heading", { name: "Opening hand" })).toBeVisible();
  },
};

/**
 * The goldfish dead to commander damage (issue #1336): Kenrith's 21 in red on its plate, which
 * says the reader's turn it would have died on though its life is still 12.
 */
export const GoldfishCommanderDamage: Story = {
  args: { view: goldfishCommanderDead() },
  render: (args) => <Played view={args.view!} onAct={args.onAct} log={GOLDFISH_LOG} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Dead on your turn 8")).toBeVisible();
  },
};

/** A crowded goldfish table: thirty more lands, and every row still one row. */
export const GoldfishCrowded: Story = {
  args: { view: goldfishTurn({ extraLands: 30 }) },
  render: (args) => <Played view={args.view!} onAct={args.onAct} />,
};

/** A green felt behind the goldfish game (the game menu's Playmat). */
export const GoldfishGreenFelt: Story = {
  args: { view: goldfishTurn() },
  render: (args) => <Played view={args.view!} onAct={args.onAct} initialPlaymat="green" />,
};

/** The goldfish game's opening hand: mulligan 2, the first free, one card to the bottom. */
export const GoldfishOpeningHand: Story = {
  args: { view: goldfishOpeningHand(), opponentNames: GOLDFISH, log: [], returnTo: "deck" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Opening hand" })).toBeVisible();
    const hand = canvas.getByRole("group", { name: "Opening hand" });
    await userEvent.click(within(hand).getAllByRole("button")[5]);
    await userEvent.click(canvas.getByRole("button", { name: /keep 6/i }));
    await expect(args.onAct).toHaveBeenCalledWith(expect.objectContaining({ type: "keep" }));
  },
};

/** The goldfish at 0 since the reader's eighth turn: the plate says when, with a gold edge, and
 *  the game goes on. */
export const GoldfishDead: Story = {
  args: { view: goldfishDead(), opponentNames: GOLDFISH, returnTo: "deck" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Dead on your turn 8")).toBeVisible();
  },
};

/** The engine playing the goldfish game on: no AI to think, so it says so. */
export const GoldfishPlayingOn: Story = {
  args: { view: goldfishTurn(), opponentNames: GOLDFISH, busy: true, returnTo: "deck" },
};
