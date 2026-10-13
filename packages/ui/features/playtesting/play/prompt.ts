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
  UnlessPayment: "Pay?",
  ReplacementChoice: "Choose a replacement effect",
  OrderTriggers: "Order triggers",
};

/** The panel's title for a kind of question. */
export function promptTitle(kind: string): string {
  return TITLES[kind] ?? words(kind);
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
 */
export function optionLabel(
  option: PlaytestOption,
  prompt: Pick<PlaytestPrompt, "kind">,
): OptionLabel {
  const hint = BY_KIND.has(prompt.kind) ? words(option.kind) : null;
  const players = option.players.map((p) => (p === "you" ? "You" : "Opponent"));
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
 * The cards on the table a click answers with: each option that names exactly one card makes that
 * card pickable, and picking it sends that option. The first option to name a card keeps it.
 */
export function pickableCards(prompt: PlaytestPrompt | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const option of prompt?.options ?? []) {
    if (option.cards.length !== 1) continue;
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
    }
  );
}
