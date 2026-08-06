import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ipc, ipcError, type SyncProgressEvent } from "@/lib/ipc";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

/**
 * `invoke` matches arguments *by name* against the Rust command's parameters, so a
 * wrapper that spells one of them differently fails at runtime with a deserialization
 * error and no type error anywhere. These pin the three names Rust declares:
 * `search_cards(req)`, `sync_run(force)`, `sync_status()`.
 */
describe("ipc argument names match the Rust command signatures", () => {
  it("sends a search under `req`", async () => {
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    const res = await ipc.searchCards({ text: "bolt", limit: 50, offset: 0 });

    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { text: "bolt", limit: 50, offset: 0 },
    });
    expect(res).toEqual({ items: [], total: 0, totalIsCapped: false });
  });

  it("sends the throttle override under `force`", async () => {
    invoke.mockResolvedValue({ updated: false, cardCount: 7, updatedAt: null });

    await ipc.syncRun(true);

    expect(invoke).toHaveBeenCalledWith("sync_run", { force: true });
  });

  it("asks for status with no arguments", async () => {
    invoke.mockResolvedValue({
      cardCount: 1,
      lastCheckAt: null,
      bulkUpdatedAt: null,
      lastError: null,
      lastIngestSkipped: 12,
      dataDir: "d",
      syncing: false,
    });

    const res = await ipc.syncStatus();

    expect(invoke).toHaveBeenCalledWith("sync_status");
    // Pinned rather than assumed: spec §8 requires the skipped-line count reach the user,
    // and a field this side spells differently is `undefined` with no type error anywhere.
    expect(res.lastIngestSkipped).toBe(12);
  });

  it("sends the new filters under the names Rust deserializes", async () => {
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    await ipc.searchCards({ sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 });

    // `search.rs` renames to camelCase, so `manaValues` — not `mana_values` — is the
    // spelling that lands in `SearchRequest.mana_values`.
    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 },
    });
  });

  it("takes no arguments for the set list", async () => {
    invoke.mockResolvedValue([]);
    await ipc.listSets();
    expect(invoke).toHaveBeenCalledWith("list_sets");
  });

  it("sends a card id under `id` and an oracle id under `oracleId`", async () => {
    invoke.mockResolvedValue(null);
    await ipc.cardDetail("p1");
    expect(invoke).toHaveBeenCalledWith("card_detail", { id: "p1" });

    invoke.mockResolvedValue({ items: [], total: 0 });
    const printings = await ipc.cardPrintings("o1");
    // Tauri maps a camelCase key onto the `oracle_id` parameter; spelling it
    // `oracle_id` here would be the runtime deserialization error no type can catch.
    expect(invoke).toHaveBeenCalledWith("card_printings", { oracleId: "o1" });
    // Not a bare array: `card::list_printings` caps the page at 400 and answers
    // `PrintingsResponse`, whose `total` is the only thing that says a list was truncated.
    // A mirror typed as `Printing[]` would read `.length` as the whole story and the
    // compiler would agree with it.
    expect(printings).toEqual({ items: [], total: 0 });
  });

  /**
   * The ten writes and reads Plan 3 added, in one table.
   *
   * Every one of them is a name `invoke` matches positionally-by-key against the Rust
   * command's parameters — `collection_add(entry)`, `collection_update(id, patch)`,
   * `wishlist_add(wish)` — and a wrapper that spells one of them `input` or `body` is a
   * runtime deserialization error that no type in this file would catch.
   */
  it("sends every collection write under the name its command declares", async () => {
    invoke.mockResolvedValue({ id: 1, quantity: 4, removed: false });

    await ipc.collectionAdd({ cardId: "p1", finish: "foil", quantity: 4 });
    expect(invoke).toHaveBeenCalledWith("collection_add", {
      entry: { cardId: "p1", finish: "foil", quantity: 4 },
    });

    await ipc.collectionSetQuantity(7, 0);
    expect(invoke).toHaveBeenCalledWith("collection_set_quantity", { id: 7, quantity: 0 });

    await ipc.collectionUpdate(7, { condition: "LP" });
    expect(invoke).toHaveBeenCalledWith("collection_update", { id: 7, patch: { condition: "LP" } });

    await ipc.collectionRemove(7);
    expect(invoke).toHaveBeenCalledWith("collection_remove", { id: 7 });
  });

  it("sends both collection reads under `query`", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });
    await ipc.collectionList({ sort: "set", limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { sort: "set", limit: 100, offset: 0 },
    });

    invoke.mockResolvedValue({ totalCards: 0 });
    // The header is taken over the *same* filters as the list it captions, which is why
    // both take one query shape rather than the summary taking a narrower one.
    await ipc.collectionSummary({ finishes: ["foil"], limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_summary", {
      query: { finishes: ["foil"], limit: 100, offset: 0 },
    });
  });

  it("sends every wishlist command under the name its command declares", async () => {
    invoke.mockResolvedValue({ id: 2, quantity: 1, removed: false });

    // `wish`, not `entry`: the two modules name their input differently and Tauri matches
    // by name, so the one that is copied from the other is the one that fails at runtime.
    await ipc.wishlistAdd({ oracleId: "o1", name: "Lightning Bolt", quantity: 1 });
    expect(invoke).toHaveBeenCalledWith("wishlist_add", {
      wish: { oracleId: "o1", name: "Lightning Bolt", quantity: 1 },
    });

    await ipc.wishlistSetQuantity(2, 3);
    expect(invoke).toHaveBeenCalledWith("wishlist_set_quantity", { id: 2, quantity: 3 });

    await ipc.wishlistRemove(2);
    expect(invoke).toHaveBeenCalledWith("wishlist_remove", { id: 2 });

    invoke.mockResolvedValue({ items: [], total: 0 });
    await ipc.wishlistList({ fulfilled: false, limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("wishlist_list", {
      query: { fulfilled: false, limit: 100, offset: 0 },
    });
  });

  it("sends a prefetch batch under `cardIds` and `variant`", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.prefetchImages(["p1", "p2"], "grid");

    // `prefetch_images(card_ids, variant)` — Tauri maps the camelCase key onto
    // `card_ids`, and `variant` is parsed by `Variant::parse`, which rejects anything
    // outside the four WEBP names with an error rather than silently prefetching nothing.
    expect(invoke).toHaveBeenCalledWith("prefetch_images", {
      cardIds: ["p1", "p2"],
      variant: "grid",
    });
  });

  /**
   * The three deck **reads**.
   *
   * `format_specs_list` is the odd one out and is pinned for it: it takes only the managed
   * state, so an argument object here would be a deserialization error rather than a type
   * error — `prewarm_collection`'s trap, in the module that added ten commands beside it.
   */
  it("sends every deck read under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckList();
    expect(invoke).toHaveBeenCalledWith("deck_list");

    invoke.mockResolvedValue(null);
    await ipc.deckGet(3);
    expect(invoke).toHaveBeenCalledWith("deck_get", { id: 3 });

    invoke.mockResolvedValue([]);
    await ipc.formatSpecs();
    expect(invoke).toHaveBeenCalledWith("format_specs_list");
  });

  /**
   * The four writes over a whole deck. `deck`, not `input` or `entry`: three modules now
   * name their one-object payload differently (`entry`, `wish`, `deck`) and Tauri matches
   * by name, so the one copied from another is the one that fails at runtime.
   */
  it("sends every deck write under the name its command declares", async () => {
    invoke.mockResolvedValue({ id: 4 });

    await ipc.deckCreate({ name: "Burn", formatKey: "modern" });
    expect(invoke).toHaveBeenCalledWith("deck_create", {
      deck: { name: "Burn", formatKey: "modern" },
    });

    await ipc.deckUpdate(4, { isBuilt: true });
    expect(invoke).toHaveBeenCalledWith("deck_update", { id: 4, patch: { isBuilt: true } });

    invoke.mockResolvedValue(undefined);
    await ipc.deckDelete(4);
    expect(invoke).toHaveBeenCalledWith("deck_delete", { id: 4 });

    invoke.mockResolvedValue({ id: 5 });
    await ipc.deckDuplicate(4);
    expect(invoke).toHaveBeenCalledWith("deck_duplicate", { id: 4 });
  });

  /**
   * The zone writes, and the one command in this module that does not take `id`.
   *
   * Every zone write addresses a slot by **deck and card**, never by the `deck_cards.id` it
   * answers with: a stale row id is the difference between emptying the slot the reader
   * pressed and emptying somebody else's. And `deck_missing_to_wishlist` takes `deckId`
   * where its four siblings take `id` — the one break in the pattern is the one a
   * copy-paste gets wrong, and it is a runtime rejection with no type error anywhere.
   */
  it("addresses every zone write by deck and card, and the wishlist push by `deckId`", async () => {
    invoke.mockResolvedValue({ id: 9, quantity: 4, removed: false });

    await ipc.deckAddCard(4, "p1", "main", 4);
    expect(invoke).toHaveBeenCalledWith("deck_add_card", {
      deckId: 4,
      cardId: "p1",
      zone: "main",
      quantity: 4,
    });

    await ipc.deckSetCardQuantity(4, "p1", "main", 0);
    expect(invoke).toHaveBeenCalledWith("deck_set_card_quantity", {
      deckId: 4,
      cardId: "p1",
      zone: "main",
      quantity: 0,
    });

    invoke.mockResolvedValue(undefined);
    await ipc.deckMoveCard(4, "p1", "maybe", "side");
    expect(invoke).toHaveBeenCalledWith("deck_move_card", {
      deckId: 4,
      cardId: "p1",
      from: "maybe",
      to: "side",
    });

    // The one zone write that names **two** cards, so it spells neither of them `cardId` the
    // way its five siblings do — a payload that did would deserialize into neither parameter.
    // The answer is read back too: `folded` is the server's arithmetic, and a mirror typed
    // `void` would throw away the one thing the UI has to say about a swap.
    invoke.mockResolvedValue({ folded: true, quantity: 5 });
    const swapped = await ipc.deckSwapPrinting(4, "p1", "p2", "main");
    expect(invoke).toHaveBeenCalledWith("deck_swap_printing", {
      deckId: 4,
      fromCardId: "p1",
      toCardId: "p2",
      zone: "main",
    });
    expect(swapped).toEqual({ folded: true, quantity: 5 });

    invoke.mockResolvedValue(2);
    const wishes = await ipc.deckMissingToWishlist(4);
    expect(invoke).toHaveBeenCalledWith("deck_missing_to_wishlist", { deckId: 4 });
    // How many wishes were *touched*, not how many copies were added — clicking twice raises
    // one line rather than making two, which is `add_wish`'s fold.
    expect(wishes).toBe(2);
  });

  it("asks for a collection pre-warm with no arguments and reads back the queue size", async () => {
    invoke.mockResolvedValue(412);

    const queued = await ipc.prewarmCollection();

    // `prewarm_collection()` takes only the managed state, so an argument object here
    // would be a deserialization error rather than a type error.
    expect(invoke).toHaveBeenCalledWith("prewarm_collection");
    // The count is what was *queued*, not fetched — the command resolves as soon as the
    // background loop owns the batch.
    expect(queued).toBe(412);
  });
});

it("unwraps the sync:progress payload and returns the unlisten handle", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: SyncProgressEvent }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: SyncProgressEvent }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: SyncProgressEvent[] = [];

  const stop = await ipc.onSyncProgress((e) => seen.push(e));
  emit?.({ payload: { phase: "downloading", done: 5, total: 10, message: null } });

  expect(listen).toHaveBeenCalledWith("sync:progress", expect.any(Function));
  expect(seen).toEqual([{ phase: "downloading", done: 5, total: 10, message: null }]);
  expect(stop).toBe(unlisten);
});

/**
 * Every command returns `Result<_, String>`, so a rejection carries a bare string —
 * `e.message` would be `undefined` and `String(e)` would be `[object Object]` for the
 * cases that are not strings.
 */
describe("ipcError", () => {
  it("passes a Rust error string through unchanged", () => {
    expect(ipcError("sync already running")).toBe("sync already running");
  });

  it("reads an Error's message", () => {
    expect(ipcError(new Error("window closed"))).toBe("window closed");
  });

  it("never renders an object as [object Object]", () => {
    expect(ipcError({ code: 42 })).toContain('{"code":42}');
  });
});
