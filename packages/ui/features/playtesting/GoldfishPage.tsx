import { useCallback, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeckVariant } from "@/lib/ipc";
import { deckDetailQuery } from "@/features/decks/deckQuery";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { PlaytestPage } from "./play/PlaytestPage";

/** The goldfish's name on its plate: it has no deck to be named by. */
const GOLDFISH_NAMES = ["Goldfish"] as const;

/**
 * The deck editor's way onto the board — the Decks view's third state: a game of the open deck
 * against **the goldfish**, a seat that does nothing and never loses, on phase.rs's rules engine
 * (`crates/grimoire-play`).
 *
 * **A thin wrapper over the one board.** Goldfishing is a playtest with no opponent decks
 * (`opponents: []`), so this is `PlaytestPage` with the goldfish's picks, its plate named
 * "Goldfish", and a way back to the deck (`returnTo="deck"`) rather than to the Playtesting
 * page's setup. Everything else — the frame below the caption at `LAYER.stage`, the game's life,
 * Escape as the way back (and as a replay's skip) — is `PlaytestPage`'s, so it is registered once,
 * there.
 *
 * `App.tsx` mounts it in place of the editor while the store's `goldfish` names the open deck;
 * leaving is `setGoldfish(null)`, which puts the editor back where the reader left it.
 */
export function GoldfishPage({
  deckId,
  variant,
}: {
  deckId: number;
  variant: DeckVariant;
}): JSX.Element {
  const setGoldfish = useAppStore((s) => s.setGoldfish);
  const { marketplace } = useMarketplace();
  // The editor's own read of this deck, already cached: the board needs only its name.
  const deck = useQuery(deckDetailQuery(deckId, variant, marketplace.id));
  const back = useCallback(() => setGoldfish(null), [setGoldfish]);

  return (
    <PlaytestPage
      // A fresh object each render is fine: the game hook deals on the picks' values.
      picks={{ deckId, variant, opponents: [] }}
      deckName={deck.data?.deck.name ?? "Deck"}
      opponentNames={GOLDFISH_NAMES}
      returnTo="deck"
      onBack={back}
    />
  );
}
