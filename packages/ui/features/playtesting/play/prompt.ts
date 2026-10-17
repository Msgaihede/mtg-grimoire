/**
 * The engine's questions in words — the prompt panel's title and each answer's label.
 *
 * **The wire is generic on purpose** (`playtest/view.rs`' `PlaytestPrompt`): phase's engine has
 * well over a hundred kinds of question, and each is sent as its own name and its answers' facts
 * — the cards and players an answer points at, a number, a yes or a no. So the words are here,
 * for the kinds a game meets most, and any other kind falls back to its own name split into words
 * ("ChooseRingBearer" → "Choose ring bearer"), which is clumsy but never wrong.
 */
import type { GameCard, PlaytestCardRef, PlaytestOption, PlaytestPrompt } from "@/lib/ipc";
import { opponentNumber } from "./players";

/** "TriggerTargetSelection" → "Trigger target selection". */
export function words(kind: string): string {
  const split = kind
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return split.charAt(0).toUpperCase() + split.slice(1);
}

const TITLES: Record<string, string> = {
  TargetSelection: "Choose a target",
  TriggerTargetSelection: "Choose a target",
  MultiTargetSelection: "Choose targets",
  ModeChoice: "Choose a mode",
  AbilityModeChoice: "Choose a mode",
  OptionalEffectChoice: "Do you want to…?",
  DiscardChoice: "Discard",
  DiscardToHandSize: "Discard",
  ScryChoice: "Scry",
  SurveilChoice: "Surveil",
  SearchChoice: "Search your library",
  CastChoice: "How do you cast it?",
  AbilityChoice: "Which ability?",
  ChooseXValue: "Choose X",
  NamedChoice: "Choose",
  OptionalCostChoice: "Pay the optional cost?",
  AlternativeCastChoice: "Which cost do you pay?",
  UnlessPayment: "Pay?",
  ReplacementChoice: "Choose a replacement effect",
  OrderTriggers: "Put your triggers in order",
};

/** What the reader is choosing, for the questions whose title alone does not say it. */
const HELP: Record<string, string> = {
  OrderTriggers: "Pick which one resolves first",
  ReplacementChoice: "Pick the effect that applies",
};

/** The panel's title for a kind of question. */
export function promptTitle(kind: string): string {
  return TITLES[kind] ?? words(kind);
}

/** A line under the title saying what an answer decides, when the title does not. */
export function promptHelp(kind: string): string | null {
  return HELP[kind] ?? null;
}

/**
 * The cards an answer names, in the order the panel shows them. An order of triggers is sent as
 * phase places them on the stack — the first placed resolves last — and is shown the way the
 * reader thinks of it: the first to resolve first.
 */
export function optionCards(
  option: Pick<PlaytestOption, "cards">,
  prompt: Pick<PlaytestPrompt, "kind">,
): PlaytestCardRef[] {
  return prompt.kind === "OrderTriggers" ? [...option.cards].reverse() : option.cards;
}

/** A card standing for one of its abilities, named by its card — or, between two different
 *  abilities of cards of one name, by the ability's words, since the name tells them apart no
 *  more. Two of one ability are the same either way round, and keep the name. */
function abilityName(ref: PlaytestCardRef, refs: readonly PlaytestCardRef[]): string {
  const twin = refs.some(
    (other) => other !== ref && other.name === ref.name && other.text !== ref.text,
  );
  return twin && ref.text !== null ? ref.text : ref.name;
}

/** One answer, as the panel's row says it: the line, and a dim second fact when there is one. */
export interface OptionLabel {
  text: string;
  hint: string | null;
}

/** The questions whose answers differ by their kind more than by what they point at. */
const BY_KIND = new Set(["CastChoice", "AbilityChoice"]);

/**
 * One answer's words, from its facts: a named choice's own word first, then a yes or a no, a
 * number, the cards it points at, the players. A target answer that points at nothing is the one
 * that stops choosing ("No more targets"). The board's own two questions — how to cast, which
 * ability — say the answer's kind beside it, since every answer names the same card.
 * An alternative cost's answers are the keyword's cost by its name ("Overload") and the printed
 * "Mana cost" (issue #1072).
 *
 * A player is "You" or "Opponent", and at a four-player table (`opponents` of 3) the opponent's
 * number too: "Opponent 2".
 */
export function optionLabel(
  option: PlaytestOption,
  prompt: Pick<PlaytestPrompt, "kind"> & Partial<Pick<PlaytestPrompt, "keyword">>,
  opponents = 1,
): OptionLabel {
  if (option.kind === "ChooseAlternativeCast")
    return { text: costText(option, prompt), hint: null };
  if (prompt.kind === "OrderTriggers" && option.cards.length > 0) {
    const refs = optionCards(option, prompt);
    const [first, ...rest] = refs.map((ref) => abilityName(ref, refs));
    return {
      text: `${first} resolves first`,
      hint: rest.length === 0 ? null : `then ${rest.join(", then ")}`,
    };
  }
  // A card standing for one of its abilities (a replacement effect) is said with the ability.
  const ability = option.cards.length === 1 ? option.cards[0].text : null;
  const hint = BY_KIND.has(prompt.kind) ? words(option.kind) : ability;
  const players = option.players.map((p) =>
    p === "you" ? "You" : opponents > 1 ? `Opponent ${opponentNumber(p)}` : "Opponent",
  );
  const cards = option.cards.map((c) => c.name);
  const text =
    option.label ??
    (option.yes === null ? null : option.yes ? "Yes" : "No") ??
    numberText(option.number, prompt.kind) ??
    (cards.length > 0 || players.length > 0 ? [...cards, ...players].join(", ") : null) ??
    (option.kind === "ChooseTarget" ? "No more targets" : (hint ?? words(option.kind)));
  // The hint repeats nothing: when the line is already the kind's words, it goes.
  return { text, hint: hint === text ? null : hint };
}

/** An alternative cost's two answers: the keyword's cost ("Overload") or the printed one. */
function costText(
  option: Pick<PlaytestOption, "label">,
  prompt: Partial<Pick<PlaytestPrompt, "keyword">>,
): string {
  if (option.label === "Normal") return "Mana cost";
  if (option.label === "Alternative")
    return prompt.keyword ? words(prompt.keyword) : "Alternative cost";
  return option.label ?? words("ChooseAlternativeCast");
}

/** A number as the question means it: X's value, a mode, an ability. Modes and abilities are
 *  sent as indexes from 0, and a reader counts them from 1. */
function numberText(n: number | null, kind: string): string | null {
  if (n === null) return null;
  if (kind === "ChooseXValue") return `X = ${n}`;
  if (kind === "ModeChoice" || kind === "AbilityModeChoice") return `Mode ${n + 1}`;
  if (kind === "AbilityChoice") return `Ability ${n + 1}`;
  return String(n);
}

/**
 * An answer in full, for its row's tooltip: each ability it names with its words, in the order
 * shown — the row itself has room for names only. `null` when the row already says it all.
 */
export function optionDetail(
  option: Pick<PlaytestOption, "cards">,
  prompt: Pick<PlaytestPrompt, "kind">,
): string | null {
  const refs = optionCards(option, prompt);
  if (!refs.some((ref) => ref.text !== null)) return null;
  const line = (ref: PlaytestCardRef) =>
    ref.text === null ? ref.name : `${ref.name}: ${ref.text}`;
  if (refs.length === 1) return line(refs[0]);
  return refs.map((ref, i) => `${i + 1}. ${line(ref)}`).join("\n");
}

/**
 * The cards on the table a click answers with: each option that names exactly one card makes that
 * card pickable, and picking it sends that option. The first option to name a card keeps it. A
 * card standing for one of its abilities is not the card — two answers can name one card's two
 * replacement effects — so it is answered from the panel alone.
 */
export function pickableCards(prompt: PlaytestPrompt | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const option of prompt?.options ?? []) {
    if (option.cards.length !== 1 || option.cards[0].text !== null) continue;
    const id = option.cards[0].id;
    if (!out.has(id)) out.set(id, option.index);
  }
  return out;
}

/**
 * A card an answer names, as the table's pieces draw a card: the one on the table with its id
 * when there is one (its state, its counters), and otherwise the name and picture alone — a card
 * in a library being searched, a spell on the stack.
 */
export function cardOfRef(
  ref: Pick<PlaytestCardRef, "id" | "name" | "cardId">,
  table: readonly GameCard[],
): GameCard {
  return (
    table.find((c) => c.id === ref.id) ?? {
      id: ref.id,
      cardId: ref.cardId,
      name: ref.name,
      typeLine: "",
      lane: "other",
      manaValue: 0,
      isLand: false,
      isToken: false,
      isCommander: false,
      tapped: false,
      counters: [],
      power: null,
      toughness: null,
      tax: 0,
      attachedTo: null,
      foretold: false,
      canForetell: false,
      castable: false,
    }
  );
}
