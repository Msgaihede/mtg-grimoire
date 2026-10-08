import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import type { DeckCard } from "@/lib/ipc";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useDeckCore, type DeckAnchor } from "./useDeckCore";

/**
 * `useDeckCore` is `useDeck`'s body with the app store taken out — the light app's phone face
 * writes through it. `useDeck.test.ts` pins what every mutation does; what is pinned here is the
 * one thing the split added: **the card surface's address is the anchor's business**, handed in,
 * and a caller that hands none touches no store.
 *
 * Over the Storybook fake's `starter` world, whose deck 1 holds four Lightning Bolts in
 * `Main deck` and has a Sideboard to move them into.
 */
async function open(anchor?: DeckAnchor) {
  const world = installWorld({ seed: "starter" });
  onTestFinished(world.mount());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={world.client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useDeckCore(1, "live", anchor), { wrapper });
  await waitFor(() => expect(hook.result.current.deck?.id).toBe(1));
  const bolt = hook.result.current.cards.find((c) => c.name === "Lightning Bolt") as DeckCard;
  const side = hook.result.current.categories.find((c) => c.kind === "side");
  return { hook, bolt, side: side?.id as number };
}

/** An anchor whose three arms record what they were told. */
function spyAnchor() {
  return {
    moved: vi.fn<DeckAnchor["moved"]>(),
    planRemoval: vi.fn<DeckAnchor["planRemoval"]>(() => null),
    removed: vi.fn<DeckAnchor["removed"]>(),
  };
}

describe("useDeckCore", () => {
  it("tells the anchor where a moved row went, with the row it was", async () => {
    const anchor = spyAnchor();
    const { hook, bolt, side } = await open(anchor);

    await hook.result.current.moveCard.mutateAsync({
      cardId: bolt.cardId,
      from: bolt.categoryId,
      to: side,
      finish: bolt.finish,
    });

    expect(anchor.moved).toHaveBeenCalledWith(
      {
        deckId: 1,
        variant: "live",
        cardId: bolt.cardId,
        categoryId: bolt.categoryId,
        finish: bolt.finish,
      },
      { categoryId: side, categoryName: "Sideboard" },
    );
  });

  it("plans a removal before the row leaves the cache, and reports it gone after", async () => {
    const anchor = spyAnchor();
    const { hook, bolt } = await open(anchor);

    await hook.result.current.setQuantity.mutateAsync({
      cardId: bolt.cardId,
      categoryId: bolt.categoryId,
      finish: bolt.finish,
      quantity: 0,
      held: { deckCardId: bolt.id, quantity: bolt.quantity },
    });

    expect(anchor.planRemoval).toHaveBeenCalledTimes(1);
    expect(anchor.removed).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: bolt.cardId, categoryId: bolt.categoryId }),
      null,
    );
  });

  it("touches no store when it is handed no anchor", async () => {
    // The desktop's card modal open on this very row: `useDeck` would move it, and the phone face's
    // write must not — it has no modal, and the store is the desktop's.
    const open_: PaneDeckContext = {
      deckId: 1,
      categoryId: 0,
      categoryName: "",
      cardId: "",
      variant: "live",
      finish: null,
    };
    const { hook, bolt, side } = await open();
    const context = { ...open_, cardId: bolt.cardId, categoryId: bolt.categoryId };
    useAppStore.getState().openCardFromDeck(context);

    await hook.result.current.moveCard.mutateAsync({
      cardId: bolt.cardId,
      from: bolt.categoryId,
      to: side,
      finish: bolt.finish,
    });

    expect(useAppStore.getState().paneDeckContext).toEqual(context);
    useAppStore.getState().setSelectedCardId(null);
  });
});
