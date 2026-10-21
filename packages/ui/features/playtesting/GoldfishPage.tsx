import { useCallback, useEffect, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeckVariant } from "@/lib/ipc";
import { deckDetailQuery } from "@/features/decks/deckQuery";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { keepGame, keptGame } from "./keptGame";
import { EndGameDialog } from "./play/EndGameDialog";
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
 * **The host holds one game**, so a goldfish dealt while the Playtesting page keeps a game
 * (`./keptGame.ts`, issue #1322) would put that one away: while it is underway this asks first,
 * and Keep it goes back to the deck with nothing dealt. A kept game the engine has ended is put
 * away without a question.
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
  /** Nothing kept is underway, or the reader has said to end it: the board may deal. */
  const [clear, setClear] = useState(() => !(keptGame()?.inPlay() ?? false));
  useEffect(() => {
    if (!clear) return;
    // Over or ended, the kept game is the one the deal below replaces on the host.
    keptGame()?.end();
    keepGame(null);
  }, [clear]);

  if (!clear) {
    return (
      <EndGameDialog
        open
        title="End your Playtesting game?"
        confirmLabel="End it and goldfish"
        cancelLabel="Keep it"
        onConfirm={() => setClear(true)}
        onCancel={back}
      >
        A game is underway on the Playtesting page. Goldfishing this deck puts that game away for
        good.
      </EndGameDialog>
    );
  }

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
