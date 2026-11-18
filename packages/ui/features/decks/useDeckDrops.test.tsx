import { createRef, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import type { DeckOp } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { useWorkStore } from "@/lib/work";
import type { DeckWrite } from "./dnd";
import { useDeck } from "./useDeck";
import { alreadyFiledSentence, dropWork, useDeckDrops, type LastBatch } from "./useDeckDrops";

/**
 * `useDeckDrops`' multi-card drop (issue #1164): a drop of several cards is **one** `deck_apply`,
 * whatever mix of writes it carries, in the drop's order — over the Storybook fake's `starter`
 * world, so the batch goes through the real hook and the fake's real handler.
 */
async function openDrops() {
  const world = installWorld({ seed: "starter" });
  onTestFinished(world.mount());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={world.client}>{children}</QueryClientProvider>
  );
  const markAdded = vi.fn();
  const setLastBatch = vi.fn<(batch: LastBatch) => void>();
  const setCardSelection = vi.fn();
  const editorRef = createRef<HTMLElement>();
  const hook = renderHook(
    () => {
      const deck = useDeck(1, "live");
      const drops = useDeckDrops({
        deck,
        cards: deck.cards,
        markAdded,
        editorRef,
        setLastBatch,
        setCardSelection,
      });
      return { deck, drops };
    },
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.deck.deck?.id).toBe(1));
  const side = hook.result.current.deck.categories.find((c) => c.kind === "side")!.id;
  return { world, hook, side, markAdded, setLastBatch, setCardSelection };
}

describe("useDeckDrops' multi-card drop", () => {
  it("sends a drop that mixes search cards and deck rows as one deck_apply, in order", async () => {
    const { world, hook, side, markAdded, setLastBatch, setCardSelection } = await openDrops();
    const [row] = hook.result.current.deck.cards;
    const outside = world.db.cards.filter(
      (c) =>
        c.typeLine !== null &&
        !/\b(Token|Emblem)\b/.test(c.typeLine) &&
        !hook.result.current.deck.cards.some((d) => d.cardId === c.id),
    );
    const apply = vi.spyOn(world.scope.commands, "deck_apply");
    const tags = vi.spyOn(world.scope.commands, "oracle_tags_for_printings");
    const single = ["deck_add_card", "deck_move_card"].map((name) =>
      vi.spyOn(world.scope.commands, name as "deck_add_card"),
    );
    const writes: DeckWrite[] = [
      { write: "add", cardId: outside[0].id, categoryId: side },
      { write: "move", cardId: row.cardId, from: row.categoryId, to: side, finish: row.finish },
      { write: "auto-add", cardId: outside[1].id, typeLine: outside[1].typeLine },
    ];

    act(() => hook.result.current.drops.applyDrops(writes));

    await waitFor(() => expect(setLastBatch).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledTimes(1);
    for (const spy of single) expect(spy).not.toHaveBeenCalled();
    expect(tags.mock.calls.length).toBeLessThanOrEqual(1);
    const ops = (apply.mock.calls[0][0] as { ops: DeckOp[] }).ops;
    expect(ops.map((o) => [o.op, o.cardId])).toEqual([
      ["add", outside[0].id],
      ["move", row.cardId],
      ["add", outside[1].id],
    ]);
    // The landed mark for each add, from the ids in the batch's answer.
    expect(markAdded).toHaveBeenCalledTimes(2);
    expect(setLastBatch.mock.calls[0][0]).toMatchObject({
      toasted: false,
      write: { isError: false, isSuccess: true },
    });
    expect(setCardSelection).toHaveBeenCalledWith(null);
    // A drag inside the editor takes no toast.
    expect(useNotifications.getState().notices).toHaveLength(0);
  });

  it("files a partial refusal as 'N of M' with the first refusal, for the banner", async () => {
    const { world, hook, side, setLastBatch } = await openDrops();
    const [a, b] = hook.result.current.deck.cards;
    vi.spyOn(world.scope.commands, "deck_apply").mockImplementation(((args: { ops: DeckOp[] }) => ({
      results: args.ops.map((_, i) => ({
        change: null,
        categoryId: i === 0 ? null : side,
        refusal: i === 0 ? "That card is not in the pile any more." : null,
      })),
      landed: args.ops.length - 1,
      collectionMoved: false,
    })) as never);

    act(() =>
      hook.result.current.drops.applyDrops(
        [a, b].map((r) => ({
          write: "move",
          cardId: r.cardId,
          from: r.categoryId,
          to: side,
          finish: r.finish,
        })),
      ),
    );

    await waitFor(() => expect(setLastBatch).toHaveBeenCalled());
    expect(setLastBatch.mock.calls[0][0].write).toMatchObject({
      isError: true,
      error: "1 of 2 cards wasn't changed — That card is not in the pile any more.",
    });
  });

  it("raises the busy indicator while a batch is out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const { world, hook, side } = await openDrops();
    const [a, b] = hook.result.current.deck.cards;
    let land: () => void = () => {};
    vi.spyOn(world.scope.commands, "deck_apply").mockImplementation(
      (args: { ops: DeckOp[] }) =>
        new Promise((resolve) => {
          land = () =>
            resolve({
              results: args.ops.map(() => ({ change: null, categoryId: side, refusal: null })),
              landed: args.ops.length,
              collectionMoved: false,
            });
        }) as never,
    );

    act(() =>
      hook.result.current.drops.applyDrops(
        [a, b].map((r) => ({
          write: "move",
          cardId: r.cardId,
          from: r.categoryId,
          to: side,
          finish: r.finish,
        })),
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(useWorkStore.getState().busy?.label).toBe("Moving 2 cards to “Sideboard”…");
    land();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(useWorkStore.getState().busy).toBeNull();
  });
});

describe("useDeckDrops' applyWrites", () => {
  /**
   * The busy sentence counts **what is sent** and names the pile the caller hands it (issue #1164
   * review): a refile whose row has gone is dropped from the batch and was still counted, and the
   * quick category's new pile was not yet among the deck's piles, so its line named none.
   */
  it("counts what it sends and names a pile the caller just made", async () => {
    const { world, hook } = await openDrops();
    const [a, b] = hook.result.current.deck.cards;
    vi.spyOn(world.scope.commands, "deck_apply").mockImplementation(
      () => new Promise(() => {}) as never,
    );
    const fresh = { id: 999_999, name: "Fresh pile" };

    act(() => {
      void hook.result.current.drops.applyWrites(
        [
          ...[a, b].map((r): DeckWrite => ({
            write: "move",
            cardId: r.cardId,
            from: r.categoryId,
            to: fresh.id,
            finish: r.finish,
          })),
          { write: "auto-refile", cardId: "gone", from: a.categoryId, finish: null },
        ],
        true,
        fresh,
      );
    });

    expect(useWorkStore.getState().live.map((w) => w.label)).toContain(
      "Moving 2 cards to “Fresh pile”…",
    );
  });
});

describe("dropWork", () => {
  const piles = [{ id: 7, name: "Sideboard" }] as unknown as Parameters<typeof dropWork>[1];
  it("names the one pile every card goes to, or counts", () => {
    const move = (to: number): DeckWrite => ({
      write: "move",
      cardId: "a",
      from: 1,
      to,
      finish: null,
    });
    const remove: DeckWrite = { write: "remove", cardId: "a", categoryId: 1, finish: null };
    expect(dropWork([move(7), move(7)], piles)).toBe("Moving 2 cards to “Sideboard”…");
    expect(dropWork([remove, remove, remove], piles)).toBe("Removing 3 cards…");
    expect(
      dropWork(
        [
          { write: "auto-add", cardId: "a", typeLine: null },
          { write: "auto-add", cardId: "b", typeLine: null },
        ],
        piles,
      ),
    ).toBe("Adding 2 cards…");
    expect(dropWork([move(7), { write: "add", cardId: "b", categoryId: 7 }], piles)).toBe(
      "Filing 2 cards into “Sideboard”…",
    );
  });
});

describe("alreadyFiledSentence", () => {
  it("says one card by name and a set with a count", () => {
    expect(alreadyFiledSentence([{ name: "Bolt", category: "Removal" }])).toBe(
      "“Bolt” is already in “Removal”",
    );
    expect(
      alreadyFiledSentence([
        { name: "Bolt", category: "Removal" },
        { name: "Shock", category: "Removal" },
      ]),
    ).toBe("2 cards are already in “Removal”");
    expect(
      alreadyFiledSentence([
        { name: "Bolt", category: "Removal" },
        { name: "Ponder", category: "Draw" },
      ]),
    ).toBe("2 cards are already where Auto files them");
  });
});
