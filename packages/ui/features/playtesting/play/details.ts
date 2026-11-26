import type {
  GameCard,
  PlaytestCondition,
  PlaytestConditionKind,
  PlaytestPaid,
  PlaytestPlayer,
  PlaytestStackItem,
  PlaytestView,
} from "@/lib/ipc";
import { shownName } from "../table/Inspect";
import { opponentNumber } from "./players";

/**
 * The words the board puts to the engine's presentation facts (issue #1747): a stack item's
 * modes, what was paid for it, whether it is a copy and what was revealed for it; the cards
 * exiled with a permanent; a player's conditions; the turns to come. The engine says which facts
 * hold (phase's `derive_views`, from the reader's seat); these only word them.
 */

/** A paid fact, in words: "X is 3", "Kicked twice", "Cast by flashback". */
export function paidLine(paid: PlaytestPaid): string {
  switch (paid.type) {
    case "x":
      return `X is ${paid.value}`;
    case "manaSpent":
      return `${paid.amount} mana spent`;
    case "colorsSpent":
      return `${paid.distinct} ${paid.distinct === 1 ? "color" : "colors"} of mana spent`;
    case "kicked":
      return paid.count === 1 ? "Kicked" : `Kicked ${times(paid.count)}`;
    case "additionalCost":
      return "Additional cost paid";
    case "variant":
      return `Cast by ${variantWords(paid.variant)}`;
    case "convoked":
      return `Convoked with ${paid.count} ${paid.count === 1 ? "creature" : "creatures"}`;
  }
}

function times(n: number): string {
  return n === 2 ? "twice" : `${n} times`;
}

/** phase's name for a way to cast (`Flashback`, `WithoutPayingManaCost`), as lower-case words. */
function variantWords(variant: string): string {
  const name = /^\w+/.exec(variant)?.[0] ?? variant;
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/**
 * What the stack says of one item beyond its name and words, one fact a line: that it is a copy,
 * its modes, what was paid, what was revealed for it, and how many events set a batched trigger
 * off. Empty when there is nothing more to say.
 */
export function stackFacts(
  item: Pick<PlaytestStackItem, "copy" | "modes" | "paid" | "revealed" | "causes">,
): string[] {
  const lines: string[] = [];
  if (item.copy) lines.push("A copy");
  for (const mode of item.modes) lines.push(`Mode: ${mode}`);
  for (const paid of item.paid) {
    // The mana spent is said only when nothing else says how it was paid for: an X spell's
    // total is its X and its cost, and the board shows the cost already.
    if (paid.type === "manaSpent" || paid.type === "colorsSpent") continue;
    lines.push(paidLine(paid));
  }
  if (item.revealed.length > 0) lines.push(`Revealed: ${item.revealed.join(", ")}`);
  if (item.causes.length > 1) lines.push(`Set off by ${item.causes.length} events at once`);
  return lines;
}

/** The short chip a stack card carries for its most telling fact: "Copy", "X=3", or none. */
export function stackChip(item: Pick<PlaytestStackItem, "copy" | "paid">): string | null {
  if (item.copy) return "Copy";
  const x = item.paid.find((p) => p.type === "x");
  return x === undefined ? null : `X=${x.value}`;
}

/**
 * What the board says of the cards exiled with a permanent (CR 607.2a), for the card pointed at:
 * a permanent's "Exiled with it: Tarmogoyf", an exiled card's "Exiled with Oblivion Ring". A
 * face-down card the reader may not look at is "a face-down card".
 */
export function exiledWithLines(
  view: Pick<PlaytestView, "exiledWith" | "you" | "opponents">,
  id: number,
): string[] {
  if (view.exiledWith.length === 0) return [];
  // The sources are on the battlefield, the cards they hold in exile.
  const cards = [view.you, ...view.opponents].flatMap((s) => [...s.battlefield, ...s.exile]);
  const named = (cardId: number): string | null => {
    const card = cards.find((c: GameCard) => c.id === cardId);
    if (card === undefined) return null;
    return card.name === "" ? "a face-down card" : shownName(card);
  };
  const lines: string[] = [];
  const held = view.exiledWith.find((link) => link.source === id);
  if (held !== undefined) {
    const names = held.cards.map(named).filter((n): n is string => n !== null);
    if (names.length > 0) lines.push(`Exiled with it: ${names.join(", ")}`);
  }
  for (const link of view.exiledWith) {
    if (!link.cards.includes(id)) continue;
    const source = named(link.source);
    if (source !== null) lines.push(`Exiled with ${source}`);
  }
  return lines;
}

const CONDITION_TEXT: Record<PlaytestConditionKind, { text: string; label: string }> = {
  cantWin: { text: "Can't win", label: "Can't win the game" },
  cantGainLife: { text: "No life gain", label: "Can't gain life" },
  cantLoseLife: { text: "No life loss", label: "Can't lose life" },
  cantPayLife: { text: "Can't pay life", label: "Can't pay life" },
  cantCast: { text: "Can't cast", label: "Can't cast spells" },
  cantActivate: { text: "Can't activate", label: "Can't activate abilities" },
  castOnlyFrom: { text: "Casts only from", label: "May cast spells only from" },
};

const ZONE_WORDS: Record<string, string> = {
  hand: "hand",
  battlefield: "battlefield",
  graveyard: "graveyard",
  exile: "exile",
  command: "command zone",
  libraryTop: "library",
  libraryBottom: "library",
};

/** A player's condition, as its badge's short text and its full words. */
export function conditionWords(condition: PlaytestCondition): { text: string; label: string } {
  const { text, label } = CONDITION_TEXT[condition.kind];
  if (condition.kind !== "castOnlyFrom") return { text, label };
  const zones = [...new Set(condition.zones.map((z) => ZONE_WORDS[z] ?? z))].join(" or ");
  return { text: `${text} ${zones}`, label: `${label} ${zones}` };
}

/** One player as the turn order names them: "You", "Opp 2" at a four-player table. */
function short(player: PlaytestPlayer, many: boolean): string {
  if (player === "you") return "You";
  return many ? `Opp ${opponentNumber(player)}` : "Opp";
}

/**
 * The turns to come after this one (`turnOrder` past its first slot), as the middle line names
 * them, an extra turn marked where a player comes twice in a row. Empty in a game of two.
 */
export function turnsToCome(
  view: Pick<PlaytestView, "turnOrder" | "opponents">,
): { key: string; text: string; extra: boolean; you: boolean }[] {
  const many = view.opponents.length > 1;
  return view.turnOrder.slice(1).map((player, i) => ({
    key: `${i}-${player}`,
    text: short(player, many),
    extra: view.turnOrder[i] === player,
    you: player === "you",
  }));
}
