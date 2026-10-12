import { useCallback, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeckVariant } from "@/lib/ipc";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { deckDetailQuery } from "@/features/decks/deckQuery";
import { useEdition } from "@/lib/edition";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { GoldfishBoard } from "./GoldfishBoard";
import { useGoldfishGame } from "./useGoldfishGame";

/**
 * The goldfish board as the Decks view's third state: a game of the open deck against a target
 * that does nothing, on phase.rs's rules engine (`crates/grimoire-play`).
 *
 * **It covers the whole window below the caption** — the rail and `main` both, as the artboard
 * draws it — at `LAYER.stage`, which is above the shell and below every popup and dialog, so the
 * board's own menus open over it and the caption stays uncovered. `App.tsx` mounts it in place of
 * the editor while the store's `goldfish` names the open deck; leaving is `setGoldfish(null)`,
 * which puts the editor back where the reader left it.
 *
 * **Escape is the way back** (the `Esc` on the back button), on the navigation rung, so a menu or
 * a dialog open over the board takes the key first.
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
  const game = useGoldfishGame(deckId, variant);
  const edition = useEdition();

  const back = useCallback(() => setGoldfish(null), [setGoldfish]);
  useDismissOnEscape({ layer: "navigation", onDismiss: back });

  return (
    <div
      role="region"
      aria-label="Goldfish"
      className={cn(
        "fixed inset-x-0 bottom-0",
        edition.caption ? BELOW_CAPTION : "top-0",
        LAYER.stage,
      )}
    >
      <GoldfishBoard
        deckName={deck.data?.deck.name ?? "Deck"}
        view={game.view}
        log={game.log}
        error={game.error}
        onAct={game.act}
        onBack={back}
        onNewGame={game.newGame}
      />
    </div>
  );
}
