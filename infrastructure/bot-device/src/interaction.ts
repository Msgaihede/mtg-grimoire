/**
 * **An interaction, answered from what the device holds** (the Discord spec §13.7). The
 * signature has been checked by the time this runs (`index.ts`); this parses the interaction,
 * asks the engine, and draws the answer. It never pulls: a pull is an alarm's.
 */
import { deckFormat, deckReply } from "./deck";
import { choices, holdingReply, pong, privately, refused, type Reply } from "./render";
import type { TransferCard } from "@grimoire/ui/features/transfer/TransferCard";
import type { Answer, BotStatus, Choice, DeckSummary, Engine, Holding } from "./types";

const PING = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;

interface Option {
  name: string;
  type: number;
  value?: unknown;
  options?: Option[];
  focused?: boolean;
}

interface Interaction {
  type: number;
  data?: { name?: unknown; options?: Option[] };
}

/** What a reader is told while the bot has not finished joining. */
export const NOT_PAIRED =
  "MTG Grimoire's bot is still joining your sync group. Finish switching Discord on in MTG Grimoire → Settings → Integrations, then try again.";
/** …and once it has, before its first pull has landed. */
export const NOT_YET =
  "MTG Grimoire's bot is still fetching your collection for the first time. Try again in a minute.";
/** What any failure inside the engine is, to a reader. Its own words go nowhere: no logs. */
export const ENGINE_FAILED =
  "MTG Grimoire's bot could not read your collection just now. Try again in a moment.";
const UNKNOWN = "That command is not one MTG Grimoire's bot answers.";

/** The options a subcommand was given, or the command's own when it has none. */
function optionsOf(interaction: Interaction): Option[] {
  const top = interaction.data?.options ?? [];
  const sub = top.find((o) => o.type === 1);
  return sub?.options ?? top;
}

function subcommand(interaction: Interaction): string | null {
  return (interaction.data?.options ?? []).find((o) => o.type === 1)?.name ?? null;
}

function stringOption(options: Option[], name: string): string | null {
  const value = options.find((o) => o.name === name)?.value;
  return typeof value === "string" ? value : null;
}

function read<T>(text: string): T | null {
  const parsed = JSON.parse(text) as Answer<T>;
  if ("err" in parsed) throw new Error(parsed.err);
  return parsed.ok;
}

/** A random multipart boundary. */
function boundary(): string {
  return `grimoire-${crypto.randomUUID()}`;
}

/**
 * Answer one interaction's body. `status` is the device's own (`engine.status()`), read by the
 * caller, which also decides freshness. `makeBoundary` is for a test.
 */
export function answer(
  engine: Engine,
  status: BotStatus,
  body: string,
  makeBoundary: () => string = boundary,
): Reply {
  let interaction: Interaction;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    interaction = parsed as Interaction;
  } catch {
    return refused(400, "the interaction is not JSON");
  }
  if (interaction.type === PING) return pong();
  const name = interaction.data?.name;
  const asking = interaction.type === AUTOCOMPLETE;
  if (!asking && interaction.type !== APPLICATION_COMMAND) {
    return refused(400, "not an interaction this device answers");
  }
  if (!status.paired) return asking ? choices([]) : privately(NOT_PAIRED);
  try {
    if (asking) return autocomplete(engine, interaction, name);
    if (status.lastPullAt === null) return privately(NOT_YET);
    const options = optionsOf(interaction);
    if ((name === "collection" || name === "wishlist") && subcommand(interaction) === "search") {
      const card = stringOption(options, "card") ?? "";
      if (card.trim() === "") return privately("Name a card to look up.");
      const found = read<Holding>(
        name === "collection" ? engine.collection_by_name(card) : engine.wishlist_by_name(card),
      );
      return holdingReply(name, card, found);
    }
    if (name === "deck") {
      const deck = stringOption(options, "deck") ?? "";
      if (deck.trim() === "") return privately("Name a deck to post.");
      const list = read<{ deck: DeckSummary; cards: TransferCard[] }>(engine.deck_cards(deck));
      if (list === null) return privately("None of your decks is called that.");
      return deckReply(
        list.deck,
        list.cards,
        deckFormat(stringOption(options, "format")),
        makeBoundary(),
      );
    }
    return privately(UNKNOWN);
  } catch {
    return asking ? choices([]) : privately(ENGINE_FAILED);
  }
}

function autocomplete(engine: Engine, interaction: Interaction, name: unknown): Reply {
  const focused = optionsOf(interaction).find((o) => o.focused === true);
  const typed = typeof focused?.value === "string" ? focused.value : "";
  let kind: string | null = null;
  if ((name === "collection" || name === "wishlist") && focused?.name === "card") kind = name;
  if (name === "deck" && focused?.name === "deck") kind = "deck";
  if (kind === null) return choices([]);
  return choices(read<Choice[]>(engine.names(kind, typed, 25)) ?? []);
}
