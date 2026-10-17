import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckSupport, type DeckVariant } from "@/lib/ipc";

/**
 * **What the rules engine plays of a deck, asked before a game** (issue #1078). phase.rs's parser
 * reads most cards whole; a card it reads only in part is still dealt and played, as a body with a
 * cost and a type, but the parts it could not read do nothing — so a deck full of them is a poor
 * test of itself, and the setup screen says so before the reader picks it.
 *
 * The verdict is Rust's (`grimoire-play`'s `support.rs`, phase's own `card_face_gaps`), and the
 * words are this file's: a gap arrives as phase's coverage label and {@link gapWords} turns it
 * into something a reader can follow.
 */

/** One deck in one of its lists, asked about. */
export interface SupportAsk {
  deckId: number;
  variant: DeckVariant;
}

/** What the setup knows of one deck and list: not yet, could not, or the engine's answer. */
export type SupportState =
  { state: "checking" } | { state: "failed" } | { state: "known"; support: DeckSupport };

export type SupportOf = (deckId: number, variant: DeckVariant) => SupportState;

const CHECKING: SupportState = { state: "checking" };

/** Under the `["decks"]` root, so any deck write marks every answer stale with the rest. */
export const supportKey = (ask: SupportAsk) =>
  ["decks", "playtestSupport", ask.deckId, ask.variant] as const;

const key = (ask: SupportAsk) => `${ask.deckId}:${ask.variant}`;

/**
 * Asks the engine about `now` at once — the decks picked in a seat, which the reader is looking
 * at — and about `then` **one deck at a time**, in order, for the marks in the deck lists.
 *
 * One at a time because each answer parses the deck's cards on the engine's stack, and the first
 * visit to the page asks about every deck the reader has: all at once, a seat's own question would
 * wait behind every other deck's. The host parses each card once per window, so after the first
 * sweep every answer is a lookup.
 */
export function usePlaytestSupport(
  now: readonly SupportAsk[],
  then: readonly SupportAsk[],
): SupportOf {
  const client = useQueryClient();
  const asks: (SupportAsk & { sweep: boolean })[] = [];
  const seen = new Set<string>();
  for (const [list, sweep] of [
    [now, false],
    [then, true],
  ] as const) {
    for (const ask of list) {
      if (seen.has(key(ask))) continue;
      seen.add(key(ask));
      asks.push({ ...ask, sweep });
    }
  }

  // The sweep's first unsettled ask is the one asked; the rest wait for it. `useQueries`
  // re-renders as each answer lands, and this walk then opens the next one.
  let open = true;
  const queries = asks.map((ask) => {
    const queryKey = supportKey(ask);
    const enabled = !ask.sweep || open;
    if (ask.sweep && (client.getQueryState(queryKey)?.status ?? "pending") === "pending") {
      open = false;
    }
    return {
      queryKey,
      queryFn: () => ipc.playtestSupport(ask.deckId, ask.variant),
      enabled,
    };
  });
  const results = useQueries({ queries });

  const byKey = new Map<string, SupportState>();
  asks.forEach((ask, i) => {
    const result = results[i];
    byKey.set(
      key(ask),
      result.data !== undefined
        ? { state: "known", support: result.data }
        : result.isError
          ? { state: "failed" }
          : CHECKING,
    );
  });
  return (deckId, variant) => byKey.get(key({ deckId, variant })) ?? CHECKING;
}

/** phase's coverage label kinds, in words. A kind not here is its own name, split into words. */
const KINDS: Record<string, string> = {
  Effect: "Effect",
  Trigger: "Trigger",
  Keyword: "Keyword",
  Static: "Static ability",
  Cost: "Cost",
  AdditionalCost: "Additional cost",
  CastingOption: "Casting option",
  GraveyardCastPermission: "Casting from a graveyard",
  TokenRulesText: "A token’s rules text",
  Swallow: "Clause read over",
  ParseWarning: "Parse warning",
  ResolverFeature: "Resolution",
};

/**
 * One gap in words: `Trigger:Whenever the moon is full` → `Trigger: Whenever the moon is full`,
 * `Effect:unrecognized_clause_head` → `Effect: unrecognized clause head`. `SilentDrop:2_of_3` is
 * phase counting the lines it read of the card's rules text, and says so.
 */
export function gapWords(gap: string): string {
  const colon = gap.indexOf(":");
  const kind = colon < 0 ? gap : gap.slice(0, colon);
  const detail =
    colon < 0
      ? ""
      : gap
          .slice(colon + 1)
          .replace(/_/g, " ")
          .trim();
  if (kind === "SilentDrop") {
    const lines = /^(\d+) of (\d+)$/.exec(detail);
    return lines
      ? `Reads ${lines[1]} of ${lines[2]} lines of rules text`
      : "Rules text left unread";
  }
  const words = KINDS[kind] ?? kind.replace(/(?<=[a-z])(?=[A-Z])/g, " ");
  return detail === "" ? words : `${words}: ${detail}`;
}

/** A deck's verdict in one sentence, for a tooltip and a seat. */
export function supportSentence(support: DeckSupport): string {
  const { cards, unsupported } = support;
  if (unsupported.length === 0) {
    return cards === 1
      ? "The rules engine plays its one card."
      : `The rules engine plays all ${cards} cards.`;
  }
  const partly = unsupported.length;
  return `The rules engine plays ${cards - partly} of ${cards} cards in full; ${partly === 1 ? "1 card is" : `${partly} cards are`} played only in part.`;
}
