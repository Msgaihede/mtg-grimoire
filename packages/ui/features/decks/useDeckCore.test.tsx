import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { ORACLE_TAGGED_NAMES } from "@grimoire/fake/db";
import { installWorld } from "@grimoire/fake/world";
import type { DeckCard, EntryChange } from "@/lib/ipc";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useDeckCore, type DeckAddRequest, type DeckAnchor } from "./useDeckCore";

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

/**
 * The batched writes (`deck_apply`): one command for a multi-card gesture, filed by the very rule
 * the single add files by.
 */
describe("useDeckCore's batched writes", () => {
  /** Two hooks over one `starter` world — deck 1 for the batch, deck 2 for the single adds it is
   *  held to — with deck 1's adds pointed at its Sideboard when `defaultSide` says so. Set on the
   *  row before anything reads it, so no cached answer predates it. */
  async function openPair({ defaultSide = false } = {}) {
    const world = installWorld({ seed: "starter" });
    onTestFinished(world.mount());
    const side = world.db.deckCategories.find(
      (c) => c.deckId === 1 && c.kind === "side" && c.variant === "live",
    )!.id;
    if (defaultSide) world.db.decks.find((d) => d.id === 1)!.defaultCategoryId = side;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={world.client}>{children}</QueryClientProvider>
    );
    const batch = renderHook(() => useDeckCore(1, "live"), { wrapper });
    const single = renderHook(() => useDeckCore(2, "live"), { wrapper });
    await waitFor(() => expect(batch.result.current.deck?.id).toBe(1));
    await waitFor(() => expect(single.result.current.deck?.id).toBe(2));
    return { world, batch, single, side };
  }

  /** Thirty adds with a type line and no pile: every tagged card the corpus has, ordinary cards
   *  after them, and two repeats — so the one tag read has duplicates to drop. */
  function thirtyAdds(world: ReturnType<typeof installWorld>): DeckAddRequest[] {
    const playable = world.db.cards.filter(
      (c) => c.typeLine !== null && !/\b(Token|Emblem)\b/.test(c.typeLine),
    );
    const tagged = playable.filter((c) => ORACLE_TAGGED_NAMES.includes(c.name));
    const rest = playable.filter((c) => !ORACLE_TAGGED_NAMES.includes(c.name));
    const picked = [...tagged, ...rest].slice(0, 28);
    return [...picked, picked[0], picked[1]].map((c) => ({
      cardId: c.id,
      typeLine: c.typeLine,
      quantity: 1,
    }));
  }

  /** What a pile is called, read off the world's own rows. */
  const pileName = (world: ReturnType<typeof installWorld>, categoryId: number | null) =>
    world.db.deckCategories.find((c) => c.id === categoryId)?.name;

  /** The `["decks"]` invalidations a write fired — the re-read the batch exists to make once. */
  function countDeckInvalidations(world: ReturnType<typeof installWorld>) {
    const spy = vi.spyOn(world.client, "invalidateQueries");
    return () =>
      spy.mock.calls.filter(([filters]) => (filters?.queryKey as unknown[])?.[0] === "decks")
        .length;
  }

  it("adds thirty cards in one deck_apply and one tag read, filed where addCard files them", async () => {
    const { world, batch, single } = await openPair();
    const cards = thirtyAdds(world);
    expect(cards).toHaveLength(30);

    // The single adds first, each one press — the answer the batch is held to.
    const alone: string[] = [];
    for (const card of cards) {
      const change: EntryChange = await single.result.current.addCard.mutateAsync(card);
      const row = world.db.deckCards.find((dc) => dc.id === change.id)!;
      alone.push(pileName(world, row.categoryId)!);
    }

    const apply = vi.spyOn(world.scope.commands, "deck_apply");
    const tags = vi.spyOn(world.scope.commands, "oracle_tags_for_printings");
    const addOne = vi.spyOn(world.scope.commands, "deck_add_card");
    const decksRead = countDeckInvalidations(world);

    const outcome = await batch.result.current.addCards.mutateAsync({ cards });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(addOne).not.toHaveBeenCalled();
    expect(tags.mock.calls.length).toBeLessThanOrEqual(1);
    // Asked once per printing, never once per line.
    const asked = (tags.mock.calls[0]?.[0] as { cardIds: string[] } | undefined)?.cardIds ?? [];
    expect(new Set(asked).size).toBe(asked.length);
    expect(decksRead()).toBe(1);

    expect(outcome.landed).toBe(30);
    expect(outcome.results).toHaveLength(30);
    expect(outcome.results.map((r) => pileName(world, r.categoryId))).toEqual(alone);
  });

  it("honours the deck's default pile, once for the batch, and lets a named pile win", async () => {
    const { world, batch, side } = await openPair({ defaultSide: true });
    const main = world.db.deckCategories.find(
      (c) => c.deckId === 1 && c.kind === "main" && c.variant === "live",
    )!.id;
    const [a, b, c] = thirtyAdds(world);

    const outcome = await batch.result.current.addCards.mutateAsync({
      cards: [
        { ...a, deckDefault: true },
        { ...b, deckDefault: true, categoryId: main },
        // No `deckDefault`: the Auto arm, which is the quick zones' explicit choice.
        c,
      ],
    });

    expect(outcome.results[0].categoryId).toBe(side);
    expect(outcome.results[1].categoryId).toBe(main);
    expect(outcome.results[2].categoryId).not.toBe(side);
  });

  it("reports a refused op in its own result while the rest land", async () => {
    const { world, batch, side } = await openPair();
    const bolt = batch.result.current.cards.find((c) => c.name === "Lightning Bolt")!;
    const decksRead = countDeckInvalidations(world);

    const outcome = await batch.result.current.applyOps.mutateAsync({
      ops: [
        {
          op: "move",
          cardId: bolt.cardId,
          fromCategoryId: bolt.categoryId,
          toCategoryId: side,
          toCategoryName: null,
          finish: bolt.finish,
        },
        // No such row: refused alone.
        { op: "setLabel", cardId: "no-such-card", categoryId: side, finish: null, labelId: null },
        {
          op: "add",
          cardId: bolt.cardId,
          categoryId: bolt.categoryId,
          categoryName: null,
          finish: bolt.finish,
          quantity: 1,
        },
      ],
    });

    expect(outcome.landed).toBe(2);
    expect(outcome.results[0]).toEqual({ change: null, categoryId: side, refusal: null });
    expect(outcome.results[1].refusal).toEqual(expect.any(String));
    expect(outcome.results[2].refusal).toBeNull();
    expect(decksRead()).toBe(1);
    await waitFor(() =>
      expect(
        batch.result.current.cards.filter((c) => c.cardId === bolt.cardId).map((c) => c.categoryId),
      ).toEqual(expect.arrayContaining([side, bolt.categoryId])),
    );
  });

  it("sends nothing for an empty batch", async () => {
    const { world, batch } = await openPair();
    const apply = vi.spyOn(world.scope.commands, "deck_apply");

    expect(await batch.result.current.applyOps.mutateAsync({ ops: [] })).toEqual({
      results: [],
      landed: 0,
      collectionMoved: false,
    });
    expect(await batch.result.current.addCards.mutateAsync({ cards: [] })).toMatchObject({
      landed: 0,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
