import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

// Read as text, not imported as a module: this pair is the only thing in the build that
// compares the hand-written mirror below with the crate it mirrors. `viewports.test.ts`
// reads `tauri.conf.json` the same way, for the same reason — Rust owns the fact and
// TypeScript only quotes it, so the quote is what can rot.
import collectionRs from "../../src-tauri/src/collection.rs?raw";
import deckRs from "../../src-tauri/src/deck.rs?raw";
import searchRs from "../../src-tauri/src/search.rs?raw";
import syncCommandsRs from "../../src-tauri/src/sync_engine/commands.rs?raw";
import syncLiveRs from "../../src-tauri/src/sync_engine/live.rs?raw";
import wishlistRs from "../../src-tauri/src/wishlist.rs?raw";
import ipcSource from "./ipc.ts?raw";
import {
  AUTO_BRACKET,
  ipc,
  ipcError,
  type ArtTagProgressEvent,
  type ComboProgress,
  type FeedProgressEvent,
  type OracleTagProgressEvent,
  type RelayOutcome,
  type SyncLiveEvent,
  type SyncProgressEvent,
} from "@/lib/ipc";

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

    // Same trap for `oracleId`: `#[serde(rename_all = "camelCase")]` makes a mismatch
    // silent on the Rust side too — a wrapper spelling this `oracle_id` would deserialize
    // to `None` with no error anywhere, and an unset filter returns the whole corpus rather
    // than one card's printings.
    await ipc.searchCards({ oracleId: "o1", limit: 50, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { oracleId: "o1", limit: 50, offset: 0 },
    });
  });

  /**
   * Facets are a **second command over the same request shape**, which is what makes them
   * easy to get wrong here: `facet_cards(req)` spells its parameter exactly as
   * `search_cards` does, so a wrapper that reached for `search_cards` — or for a plausible
   * `facets` — is a runtime failure with no type error anywhere, and both surfaces send the
   * identical object.
   */
  it("sends a facet request under `req`, to its own command", async () => {
    invoke.mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    });

    const res = await ipc.facetCards({ text: "bolt", limit: 50, offset: 0 });

    expect(invoke).toHaveBeenCalledWith("facet_cards", {
      req: { text: "bolt", limit: 50, offset: 0 },
    });
    // `ready` is the field a cold index answers with, and it is the one a mirror that typed
    // this as a bare count map would throw away — the UI cannot tell "empty" from "not yet".
    expect(res.ready).toBe(false);
  });

  it("takes no arguments for the set list", async () => {
    invoke.mockResolvedValue([]);
    await ipc.listSets();
    expect(invoke).toHaveBeenCalledWith("list_sets");
  });

  it("sends a card id under `id`, an oracle id under `oracleId`, and both with a marketplace", async () => {
    invoke.mockResolvedValue(null);
    await ipc.cardDetail("p1", "cardkingdom");
    // The marketplace is not a formatting choice here: it decides `finishPrices` on the answer,
    // so a wrapper that dropped it would quote TCGplayer's dollars under a Card Kingdom heading
    // — the cross-marketplace fallback the whole feature refuses, and invisible from the page.
    expect(invoke).toHaveBeenCalledWith("card_detail", { id: "p1", marketplace: "cardkingdom" });

    invoke.mockResolvedValue({ items: [], total: 0 });
    const printings = await ipc.cardPrintings("o1", "manapool");
    // Tauri maps a camelCase key onto the `oracle_id` parameter; spelling it
    // `oracle_id` here would be the runtime deserialization error no type can catch.
    expect(invoke).toHaveBeenCalledWith("card_printings", {
      oracleId: "o1",
      marketplace: "manapool",
    });
    // Not a bare array: `card::list_printings` caps the page at 400 and answers
    // `PrintingsResponse`, whose `total` is the only thing that says a list was truncated.
    // A mirror typed as `Printing[]` would read `.length` as the whole story and the
    // compiler would agree with it.
    expect(printings).toEqual({ items: [], total: 0 });
  });

  /**
   * The page size, which only the printings modal names.
   *
   * `limit` is what `card_printings` declares. A wrapper that spelled it `pageSize` — or dropped
   * it — deserializes to `None` with no error anywhere, and the modal would then filter the
   * newest 400 of Forest's 862 printings: narrowing to a set outside that page draws an empty
   * wall that reads as an answer rather than as a truncation.
   */
  it("sends a page size under `limit` when one is asked for", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });

    await ipc.cardPrintings("o1", "manapool", 1000);

    expect(invoke).toHaveBeenCalledWith("card_printings", {
      oracleId: "o1",
      marketplace: "manapool",
      limit: 1000,
    });
  });

  it("sends no page size when none is asked for, so the card pane's page is unchanged", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });

    await ipc.cardPrintings("o1", "manapool");

    expect(invoke).toHaveBeenCalledWith("card_printings", {
      oracleId: "o1",
      marketplace: "manapool",
      limit: undefined,
    });
    // Read off the call as well, because `toHaveBeenCalledWith` compares like `toEqual`: an
    // absent key and an `undefined` one are the same object to it, so the assertion above would
    // still pass if this wrapper invented a page size of its own. Absent has to reach Rust as
    // `None` for `MAX_PRINTINGS` — the pane's 400, and its cache key — to stay what it was.
    const sent = invoke.mock.calls[0][1] as { limit?: number };
    expect(sent.limit).toBeUndefined();
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
    await ipc.collectionList({ sort: [{ key: "set", dir: "asc" }], limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { sort: [{ key: "set", dir: "asc" }], limit: 100, offset: 0 },
    });

    invoke.mockResolvedValue({ totalCards: 0 });
    // The header is taken over the *same* filters as the list it captions, which is why
    // both take one query shape rather than the summary taking a narrower one.
    await ipc.collectionSummary({ finishes: ["foil"], limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_summary", {
      query: { finishes: ["foil"], limit: 100, offset: 0 },
    });
  });

  /**
   * **`allocation`'s two words, on the wire.**
   *
   * This field has existed since schema v25 and had **no sender at all** until the deck builder's
   * Collection Search tab landed (2026-08-23), which is exactly why it is pinned here: the
   * TypeScript union is a fact about `ipc.ts` and nothing checks it against
   * `collection::Allocation`, whose `rename_all = "camelCase"` is what actually decides the two
   * strings. A third spelling — `"unAllocated"`, `"free"` — is a serde failure at runtime and a
   * type error nowhere, and the symptom is a list that answers the *unfiltered* question, which
   * looks like a working panel.
   *
   * Both ends, because `"all"` is genuinely sent rather than left off: it is one end of a control
   * the reader can see, and the payload says which end it is at.
   */
  it("carries the collection list's allocation, in both of its spellings", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });

    await ipc.collectionList({ allocation: "unallocated", limit: 60, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { allocation: "unallocated", limit: 60, offset: 0 },
    });

    await ipc.collectionList({ allocation: "all", limit: 60, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { allocation: "all", limit: 60, offset: 0 },
    });
  });

  /**
   * **The collection's price band, in the two spellings `serde(rename_all = "camelCase")` turns
   * `price_min`/`price_max` into.**
   *
   * Pinned for `allocation`'s reason and with one of its own. The field is new (2026-08-25) and
   * the deck builder's Collection Search tab is its only sender, so nothing else would notice a
   * name that does not deserialize — and a `CollectionQuery` is `#[serde(default)]`, so an
   * unrecognised key is **dropped silently** rather than refused. The symptom would be a slider
   * the reader can move over a wall that never narrows.
   *
   * Each bound alone as well as the pair, because sending one end is the ordinary case: half a
   * band is one predicate, and a caller that folded a missing end into a `0` or an `Infinity`
   * would be asking a question the reader did not.
   */
  it("carries the collection list's price band, each bound on its own", async () => {
    invoke.mockResolvedValue({ items: [], total: 0 });

    await ipc.collectionList({ priceMin: 2.5, priceMax: 40, limit: 60, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { priceMin: 2.5, priceMax: 40, limit: 60, offset: 0 },
    });

    await ipc.collectionList({ priceMin: 2.5, limit: 60, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { priceMin: 2.5, limit: 60, offset: 0 },
    });

    await ipc.collectionList({ priceMax: 40, limit: 60, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("collection_list", {
      query: { priceMax: 40, limit: 60, offset: 0 },
    });
  });

  /**
   * **The folder a bulk import files into, and the default that keeps every other caller
   * unchanged.**
   *
   * `commit_import` hard-coded `folder_id: None` until 2026-08-23, so ticking "Add cards to
   * collection" on a **deck** import landed the copies at the root: the deck went on reading
   * *missing* on every line, and every other deck could still claim them. The field is on the
   * wire as `folderId` — Tauri matches arguments by name and `#[serde(rename_all)]` does not
   * apply to command parameters, so `folder_id` here would deserialize to `None` and reinstate
   * exactly the bug, silently and with no type error anywhere.
   *
   * Both ends are pinned because the **absence** is a product decision of its own: a file says
   * nothing about a reader's filing, so the plain collection import must go on sending `null`.
   */
  it("carries the import's folder, and sends null when nobody names one", async () => {
    invoke.mockResolvedValue({ added: 1, updated: 0, removed: 0 });
    const items = [{ cardId: "c1", quantity: 1, finish: "nonfoil" as const }];

    await ipc.collectionImportCommit(items, "add");
    expect(invoke).toHaveBeenCalledWith("collection_import_commit", {
      items,
      mode: "add",
      folderId: null,
    });

    await ipc.collectionImportCommit(items, "add", 7);
    expect(invoke).toHaveBeenCalledWith("collection_import_commit", {
      items,
      mode: "add",
      folderId: 7,
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

    // The whole level in order — {@link ipc.deckFolderReorder}'s rule, one cabinet over.
    // **This cabinet's folder commands had no pins at all before this one**, which is worth
    // knowing rather than quietly fixing: `invoke` matches by name, so a typo in any of them is
    // a runtime rejection nothing in the suite can see. The three that predate this are still
    // unpinned; adding them is not this change's business, but they are not covered.
    invoke.mockResolvedValue([]);
    await ipc.wishlistFolderReorder(null, [4, 1]);
    expect(invoke).toHaveBeenCalledWith("wishlist_folder_reorder", { parentId: null, ids: [4, 1] });

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
   * The four deck **reads**.
   *
   * `format_specs_list` and `deck_last_format` are the odd ones out and are pinned for it: each
   * takes only the managed state, so an argument object here would be a deserialization error
   * rather than a type error — `prewarm_collection`'s trap, in the module that added ten
   * commands beside it.
   */
  it("sends every deck read under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckList();
    expect(invoke).toHaveBeenCalledWith("deck_list");

    invoke.mockResolvedValue(null);
    // The variant is a parameter of the command and not a filter this side applies: it scopes
    // the **cards** and nothing else, so a mirror that dropped it would not read the live deck
    // by luck — Tauri refuses a call whose parameters it cannot fill. The marketplace is the
    // same shape of fact one step over: it prices every card and every category heading in the
    // answer, so a call that dropped it would read a deck quoted at somebody else's prices.
    await ipc.deckGet(3, "live", "cardkingdom");
    expect(invoke).toHaveBeenCalledWith("deck_get", {
      id: 3,
      variant: "live",
      marketplace: "cardkingdom",
    });

    invoke.mockResolvedValue([]);
    await ipc.formatSpecs();
    expect(invoke).toHaveBeenCalledWith("format_specs_list");

    // No assertion on what comes back. The mirror is `invoke(...) as Promise<string | null>`
    // and does nothing to the answer, so reading back a value this line just mocked would test
    // the mock. What can really drift is the name and the arity — the two things below.
    invoke.mockResolvedValue("commander");
    await ipc.deckLastFormat();
    expect(invoke).toHaveBeenCalledWith("deck_last_format");
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

    // A create carries the **whole deck** now, so every field is pinned by name. Nothing
    // type-checks this mirror against `deck::DeckInput`, and serde fills a field it cannot
    // find with that field's default — so a key misspelled here is not a type error, it is a
    // deck quietly born without its notes.
    //
    // The bare call above is the other half of the pin: an omitted `folderId` travels as
    // omitted, and on an INSERT that *is* the top level — unlike `DeckPatch.folderId`, where
    // a missing value means "leave it" and only `deck_set_folder` reaches the root.
    await ipc.deckCreate({
      name: "Rakdos Sacrifice",
      formatKey: "commander",
      description: "Aristocrats, but rude",
      notes: "Swap the Cauldron once the reprint lands.",
      coverCardId: "p1",
      folderId: 3,
      theoryEnabled: true,
    });
    expect(invoke).toHaveBeenCalledWith("deck_create", {
      deck: {
        name: "Rakdos Sacrifice",
        formatKey: "commander",
        description: "Aristocrats, but rude",
        notes: "Swap the Cauldron once the reprint lands.",
        coverCardId: "p1",
        folderId: 3,
        theoryEnabled: true,
      },
    });

    await ipc.deckUpdate(4, { archived: true });
    expect(invoke).toHaveBeenCalledWith("deck_update", { id: 4, patch: { archived: true } });

    invoke.mockResolvedValue(undefined);
    await ipc.deckDelete(4);
    expect(invoke).toHaveBeenCalledWith("deck_delete", { id: 4 });

    invoke.mockResolvedValue({ id: 5 });
    await ipc.deckDuplicate(4);
    expect(invoke).toHaveBeenCalledWith("deck_duplicate", { id: 4 });
  });

  /**
   * The bracket rides the **ordinary patch**, and `AUTO_BRACKET` is the trap in it.
   *
   * `deck_update` is `coalesce(?n, column)` on every field, so an absent key means "leave it" —
   * which makes `0` the *only* way to say "back to Auto" and makes it a value rather than an
   * absence. A wrapper that dropped a falsy field, or a caller that sent `undefined` for Auto,
   * would turn the picker's first row into the one entry that does nothing, and **nothing would
   * go red**: the patch is accepted, the command answers a row, and the deck simply keeps the
   * bracket it had.
   *
   * It is also pinned as travelling with the rename and the format rather than through
   * `deck_set_view_state`, because that is the split `DeckRow.bracket` documents: an answer about
   * the deck, not one of the three `last*` fields that say how it was last looked at.
   */
  it("sends a deck's bracket through the ordinary patch, `0` and all", async () => {
    invoke.mockResolvedValue({ id: 7, bracket: 3 });

    const row = await ipc.deckUpdate(7, { bracket: 3 });
    expect(invoke).toHaveBeenCalledWith("deck_update", { id: 7, patch: { bracket: 3 } });
    // Read back rather than assumed: `bracket` is on the row as well as in the patch, because a
    // setting the app can write and never see is a setting nothing can draw.
    expect(row.bracket).toBe(3);

    invoke.mockResolvedValue({ id: 7, bracket: AUTO_BRACKET });
    const auto = await ipc.deckUpdate(7, { bracket: AUTO_BRACKET });
    expect(invoke).toHaveBeenCalledWith("deck_update", { id: 7, patch: { bracket: 0 } });
    expect(auto.bracket).toBe(0);
    // The sentinel Rust spells `deck::AUTO_BRACKET`. Pinned to the literal, because the two sides
    // are one vocabulary and a constant that drifted would be a silent "leave it".
    expect(AUTO_BRACKET).toBe(0);

    invoke.mockResolvedValue({ id: 7, bracket: 4 });
    await ipc.deckUpdate(7, { name: "Ezuri", formatKey: "commander", bracket: 4 });
    expect(invoke).toHaveBeenCalledWith("deck_update", {
      id: 7,
      patch: { name: "Ezuri", formatKey: "commander", bracket: 4 },
    });
  });

  /**
   * The card writes, and the one command in this module that does not take `id`.
   *
   * Every card write addresses a slot by **deck, card and category**, never by the
   * `deck_cards.id` it answers with: a stale row id is the difference between emptying the
   * slot the reader pressed and emptying somebody else's. Since schema v8 the slot carries a
   * `variant` too, and it is a *fourth* part of the grain rather than a mode — the same
   * printing in the same category is two rows, one `live` and one `theory`, so a write that
   * dropped it would edit whichever the backend defaulted to. And `deck_missing_to_wishlist`
   * takes `deckId` where its four siblings take `id` — the one break in the pattern is the one
   * a copy-paste gets wrong, and it is a runtime rejection with no type error anywhere.
   */
  it("addresses every card write by deck, card and category, and the wishlist push by `deckId`", async () => {
    invoke.mockResolvedValue({ id: 9, quantity: 4, removed: false });

    await ipc.deckAddCard(4, "p1", 7, null, "live", null, 4);
    expect(invoke).toHaveBeenCalledWith("deck_add_card", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      categoryName: null,
      variant: "live",
      finish: null,
      quantity: 4,
    });

    // The other half of the one command that takes two ways of naming a pile: an id is a drop
    // onto a column the reader pointed at, a name is "file it where this card belongs",
    // found-or-created. **Both keys travel either way** — the unused one as an explicit
    // `null`, because Tauri fills parameters by name and an absent key is a refusal rather
    // than a default.
    await ipc.deckAddCard(4, "p1", null, "Main deck", "live", null, 1);
    expect(invoke).toHaveBeenCalledWith("deck_add_card", {
      deckId: 4,
      cardId: "p1",
      categoryId: null,
      categoryName: "Main deck",
      variant: "live",
      finish: null,
      quantity: 1,
    });

    await ipc.deckSetCardQuantity(4, "p1", 7, "live", null, 0);
    expect(invoke).toHaveBeenCalledWith("deck_set_card_quantity", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      finish: null,
      quantity: 0,
    });

    // The one write that names **two** categories, so it spells neither of them `categoryId`
    // the way its siblings do — and `from`/`to` alone, which is what the zones took, would
    // deserialize into neither parameter.
    invoke.mockResolvedValue(2);
    await ipc.deckMoveCard(4, "p1", 9, 2, null, "live", null);
    expect(invoke).toHaveBeenCalledWith("deck_move_card", {
      deckId: 4,
      cardId: "p1",
      fromCategoryId: 9,
      toCategoryId: 2,
      toCategoryName: null,
      variant: "live",
      finish: null,
    });

    // The **name** arm — the quick zones' `Auto`, where the pile is `autoCategoryFor`'s answer
    // and may not exist yet. Both halves are always sent, because Rust's parameters are
    // `Option`s and an absent key deserializes to `None` on the wrong one as readily as on the
    // right one. It answers the category the copies are now in, which is the only way this
    // caller learns what was found or made.
    invoke.mockResolvedValue(31);
    expect(await ipc.deckMoveCard(4, "p1", 9, null, "Removal", "live", null)).toBe(31);
    expect(invoke).toHaveBeenCalledWith("deck_move_card", {
      deckId: 4,
      cardId: "p1",
      fromCategoryId: 9,
      toCategoryId: null,
      toCategoryName: "Removal",
      variant: "live",
      finish: null,
    });

    // The one card write that names **two** cards, so it spells neither of them `cardId` the
    // way its siblings do — a payload that did would deserialize into neither parameter.
    // The answer is read back too: `folded` is the server's arithmetic, and a mirror typed
    // `void` would throw away the one thing the UI has to say about a swap.
    invoke.mockResolvedValue({ folded: true, quantity: 5 });
    const swapped = await ipc.deckSwapPrinting(4, "p1", "p2", 7, "live", null);
    expect(invoke).toHaveBeenCalledWith("deck_swap_printing", {
      deckId: 4,
      fromCardId: "p1",
      toCardId: "p2",
      categoryId: 7,
      variant: "live",
      finish: null,
    });
    expect(swapped).toEqual({ folded: true, quantity: 5 });

    invoke.mockResolvedValue(2);
    const wishes = await ipc.deckMissingToWishlist(4);
    expect(invoke).toHaveBeenCalledWith("deck_missing_to_wishlist", { deckId: 4 });
    // How many wishes were *touched*, not how many copies were added — clicking twice raises
    // one line rather than making two, which is `add_wish`'s fold.
    expect(wishes).toBe(2);
  });

  /**
   * The two deck writes that are **not** a `DeckPatch`, and the reason neither can be one.
   *
   * `deck_update` writes every column with `coalesce(?n, column)`, which reads a bound NULL as
   * "leave it" — so a patch has no way to say *clear this*. Filing a deck back at the **root**
   * of the folder tree is exactly that sentence, which is why `deck_set_folder` exists and
   * takes an `Option<i64>` of its own where `null` means the root. And a cover image is a file
   * on disk rather than a column, so it arrives as the path the picker answered.
   */
  it("sends the two deck writes a patch cannot express under their own names", async () => {
    invoke.mockResolvedValue({ id: 4 });

    await ipc.deckSetCoverImage(4, "C:\\pics\\dragon.png");
    // `deckId` and `sourcePath` — the command takes neither `id` nor `path`, and Tauri fills
    // parameters by name.
    expect(invoke).toHaveBeenCalledWith("deck_set_cover_image", {
      deckId: 4,
      sourcePath: "C:\\pics\\dragon.png",
    });

    await ipc.deckSetFolder(4, 2);
    expect(invoke).toHaveBeenCalledWith("deck_set_folder", { deckId: 4, folderId: 2 });

    // The whole reason this command is not a patch field: an explicit `null` is the root, and
    // it must travel as a key rather than be dropped — `DeckPatch` would read it as "leave it".
    await ipc.deckSetFolder(4, null);
    expect(invoke).toHaveBeenCalledWith("deck_set_folder", { deckId: 4, folderId: null });
  });

  /**
   * The third deck write that is not a patch — and the one that is not about the deck's
   * *contents* at all: which tab, which grouping, which sort the reader left it on.
   *
   * `viewState`, not `patch` or `state`: Tauri fills parameters by name, and this module now has
   * three one-object payloads under three different words (`deck`, `patch`, `viewState`), so the
   * one copied from a neighbour is the one that fails at runtime with no type error anywhere.
   * An absent field means "leave it", so the editor sends the **one** control that moved.
   */
  it("sends the view state under its own parameter name, one field at a time", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.deckSetViewState(4, { variant: "theory" });
    expect(invoke).toHaveBeenCalledWith("deck_set_view_state", {
      deckId: 4,
      viewState: { variant: "theory" },
    });

    // Only the field that moved travels: a press on Sort must not write back a grouping read
    // out of a stale render.
    await ipc.deckSetViewState(4, { sortBy: "price" });
    expect(invoke).toHaveBeenCalledWith("deck_set_view_state", {
      deckId: 4,
      viewState: { sortBy: "price" },
    });

    // All three at once is legal and is what a caller with three fresh values sends.
    await ipc.deckSetViewState(4, { variant: "live", groupBy: "manaValue", sortBy: "type" });
    expect(invoke).toHaveBeenCalledWith("deck_set_view_state", {
      deckId: 4,
      viewState: { variant: "live", groupBy: "manaValue", sortBy: "type" },
    });
  });

  /**
   * The six category commands.
   *
   * Three different first parameters between them — `deckId` on the two that are about a
   * *deck's* categories (list, create, reorder) and a bare `id` on the three that are about
   * **one** category (rename, setActive, delete) — and Tauri matches by name, so the one
   * copied from its neighbour is the one that fails at runtime with no type error anywhere.
   */
  it("sends every category command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckCategoryList(4, "theory", "manapool");
    // The variant scopes the two **counts** on each row and nothing else — the list of
    // categories is the same either way, which is what keeps the editor's columns still while
    // the reader switches lists. The marketplace scopes one of those two numbers: `totalPrice`
    // is a sum *at* a marketplace, and two of them are not conversions of each other.
    expect(invoke).toHaveBeenCalledWith("deck_category_list", {
      deckId: 4,
      variant: "theory",
      marketplace: "manapool",
    });

    invoke.mockResolvedValue({ id: 7 });
    await ipc.deckCategoryCreate(4, "Ramp");
    expect(invoke).toHaveBeenCalledWith("deck_category_create", { deckId: 4, name: "Ramp" });

    await ipc.deckCategoryRename(7, "Acceleration");
    // `id`, not `deckId`: a category names its own deck, so a rename does not.
    expect(invoke).toHaveBeenCalledWith("deck_category_rename", { id: 7, name: "Acceleration" });

    await ipc.deckCategorySetActive(7, false);
    // `isActive` — the flag that is the whole of "counts toward nothing", and the one field of
    // a category every kind accepts, `commander` included.
    expect(invoke).toHaveBeenCalledWith("deck_category_set_active", { id: 7, isActive: false });

    invoke.mockResolvedValue([]);
    await ipc.deckCategoryReorder(4, [7, 1, 2]);
    expect(invoke).toHaveBeenCalledWith("deck_category_reorder", { deckId: 4, ids: [7, 1, 2] });

    invoke.mockResolvedValue(undefined);
    await ipc.deckCategoryDelete(7, 1);
    expect(invoke).toHaveBeenCalledWith("deck_category_delete", { id: 7, moveToCategoryId: 1 });

    // `null` is not "no argument": it is the destructive half of one command — the cards go
    // with the category, by `ON DELETE CASCADE`. The key must travel either way.
    await ipc.deckCategoryDelete(7, null);
    expect(invoke).toHaveBeenCalledWith("deck_category_delete", { id: 7, moveToCategoryId: null });
  });

  /**
   * The six tag commands, and the two that break the module's own pattern.
   *
   * `deck_tag_suggestions` takes **no deck id at all** — the palette is a property of the
   * app's whole history rather than of one deck — so an argument object here is a
   * deserialization error, `prewarm_collection`'s trap again. And `deck_card_set_tag` is a
   * *card* write wearing a tag command's name: it addresses the slot by the full grain, like
   * every other card write, and not by the tag.
   */
  it("sends every tag command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckTagList(4, "live");
    expect(invoke).toHaveBeenCalledWith("deck_tag_list", { deckId: 4, variant: "live" });

    invoke.mockResolvedValue({ id: 3 });
    await ipc.deckTagCreate(4, "Cut candidate", "ember");
    expect(invoke).toHaveBeenCalledWith("deck_tag_create", {
      deckId: 4,
      name: "Cut candidate",
      color: "ember",
    });

    // One command for the rename **and** the recolour, and both are required: there is no
    // patch shape here, so a caller changing one sends the other back unchanged. `deckId` is
    // where the reader was standing — the write itself is app-wide.
    await ipc.deckTagUpdate(4, 3, "Cut", "moss");
    expect(invoke).toHaveBeenCalledWith("deck_tag_update", {
      deckId: 4,
      id: 3,
      name: "Cut",
      color: "moss",
    });

    invoke.mockResolvedValue(undefined);
    await ipc.deckTagDelete(4, 3);
    expect(invoke).toHaveBeenCalledWith("deck_tag_delete", { deckId: 4, id: 3 });

    // The other destructive one, and the distinction the app-wide list needed: this takes the
    // label off one deck's one list and leaves the tag standing.
    invoke.mockResolvedValue(2);
    expect(await ipc.deckTagRemoveFromDeck(4, 3, "theory")).toBe(2);
    expect(invoke).toHaveBeenCalledWith("deck_tag_remove_from_deck", {
      deckId: 4,
      tagId: 3,
      variant: "theory",
    });

    const every = [{ id: 3, name: "Cut candidate", color: "ember", cardCount: 9, deckCount: 2 }];
    invoke.mockResolvedValue(every);
    const palette = await ipc.deckTagAll();
    expect(invoke).toHaveBeenCalledWith("deck_tag_all");
    expect(palette).toEqual(every);

    invoke.mockResolvedValue(undefined);
    await ipc.deckCardSetTag(4, "p1", 7, "live", null, 3);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_tag", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      finish: null,
      tagId: 3,
    });

    // Untagging is the same command with `null`, not a second one — `deck_cards.tag_id` is a
    // nullable column and clearing it is a write to it.
    await ipc.deckCardSetTag(4, "p1", 7, "live", null, null);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_tag", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      finish: null,
      tagId: null,
    });
  });

  /**
   * The five folder commands — the one family in the deck surface that is about **no deck**.
   *
   * `deck_folder_list` therefore takes nothing, and `create`/`move` both spell their target
   * `parentId` with `null` meaning the root of the tree. That `null` is load-bearing twice
   * over: it is how a folder is made at the top level and how one is moved back out.
   */
  it("sends every folder command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckFolderList();
    expect(invoke).toHaveBeenCalledWith("deck_folder_list");

    invoke.mockResolvedValue({ id: 2 });
    await ipc.deckFolderCreate(null, "Commander");
    expect(invoke).toHaveBeenCalledWith("deck_folder_create", {
      parentId: null,
      name: "Commander",
    });

    await ipc.deckFolderCreate(2, "Legends");
    expect(invoke).toHaveBeenCalledWith("deck_folder_create", { parentId: 2, name: "Legends" });

    await ipc.deckFolderRename(2, "EDH");
    expect(invoke).toHaveBeenCalledWith("deck_folder_rename", { id: 2, name: "EDH" });

    await ipc.deckFolderMove(3, null);
    expect(invoke).toHaveBeenCalledWith("deck_folder_move", { id: 3, parentId: null });

    // **`ids` is the whole level, in its new order** — the command writes `sort_order` from
    // position *and* `parent_id` from the argument, so one gesture both re-parents and places.
    // Pinned by value rather than by length: an order-insensitive assertion would pass a
    // reorder that shuffled the level.
    invoke.mockResolvedValue([]);
    await ipc.deckFolderReorder(null, [3, 2]);
    expect(invoke).toHaveBeenCalledWith("deck_folder_reorder", { parentId: null, ids: [3, 2] });

    invoke.mockResolvedValue(undefined);
    await ipc.deckFolderDelete(3);
    expect(invoke).toHaveBeenCalledWith("deck_folder_delete", { id: 3 });
  });

  /**
   * The history and the theory list.
   *
   * `deck_audit_list` takes a **required** `limit`: the backend clamps it into `1..=500`, and
   * a mirror that made it optional would send `undefined` — which Tauri cannot fill an `i64`
   * from, so the drawer would fail to open rather than quietly reading everything.
   *
   * The two theory writes both answer a **count**, and they count different things:
   * `copyFromLive` answers rows written, `missingToWishlist` answers wishes touched.
   */
  it("sends the history and theory commands under the names their commands declare", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckAuditList(4, 200);
    expect(invoke).toHaveBeenCalledWith("deck_audit_list", { deckId: 4, limit: 200 });

    invoke.mockResolvedValue([]);
    await ipc.deckTheoryDiff(4, "tcgplayer");
    expect(invoke).toHaveBeenCalledWith("deck_theory_diff", {
      deckId: 4,
      marketplace: "tcgplayer",
    });

    invoke.mockResolvedValue(12);
    const copied = await ipc.deckTheoryCopyFromLive(4);
    expect(invoke).toHaveBeenCalledWith("deck_theory_copy_from_live", { deckId: 4 });
    expect(copied).toBe(12);

    invoke.mockResolvedValue(3);
    const wishes = await ipc.deckTheoryMissingToWishlist(4);
    // A **second** command rather than a variant argument on `deck_missing_to_wishlist`: that
    // one reads `live` and only `live`, and the two shopping lists are different questions.
    expect(invoke).toHaveBeenCalledWith("deck_theory_missing_to_wishlist", { deckId: 4 });
    expect(wishes).toBe(3);
  });

  /**
   * The three import commands, and the one in the whole file that takes **no managed state**.
   *
   * `import_read_file(path)` touches no database, so `path` is its only parameter — and it
   * is a *path* rather than bytes, which is the contract that keeps `dialog:allow-open` the only
   * capability this feature needs. A mirror that sent the file's contents under `path` would
   * type-check perfectly and import a filename.
   *
   * The other two break the module's own patterns in opposite directions: `import_resolve`
   * takes a bare `lines` array where every other list-shaped read in this file wraps its payload
   * in `query` or `req`, and `deck_import_commit` takes `deckId` where the card writes beside it
   * take `deckId` too but spell their payload out field by field rather than as `items`.
   */
  it("sends every import command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.importResolve([{ name: "Sol Ring", setCode: null, collectorNumber: null }]);
    // `lines`, not `query` or `req` — and both hints travel as explicit `null`s, because Tauri
    // fills parameters by name and the preview must be able to say a hint was *given*.
    expect(invoke).toHaveBeenCalledWith("import_resolve", {
      lines: [{ name: "Sol Ring", setCode: null, collectorNumber: null }],
    });

    invoke.mockResolvedValue({ added: 100, removed: 0, categoriesCreated: 2 });
    const outcome = await ipc.deckImportCommit(4, "live", "merge", [
      { cardId: "p1", quantity: 1, categoryName: "Ramp" },
    ]);
    expect(invoke).toHaveBeenCalledWith("deck_import_commit", {
      deckId: 4,
      variant: "live",
      mode: "merge",
      items: [{ cardId: "p1", quantity: 1, categoryName: "Ramp" }],
    });
    // The three numbers the report is written from, read back rather than assumed: a mirror
    // typed `void` would throw away the whole of what an import has to say for itself.
    expect(outcome).toEqual({ added: 100, removed: 0, categoriesCreated: 2 });

    invoke.mockResolvedValue("1 Sol Ring\n");
    const text = await ipc.importReadFile("C:\\lists\\edh.txt");
    expect(invoke).toHaveBeenCalledWith("import_read_file", { path: "C:\\lists\\edh.txt" });
    expect(text).toBe("1 Sol Ring\n");
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

  /**
   * The error log's two commands, and the trap `prewarm_collection` documents above: a
   * command that takes no arguments must be invoked with none, or Tauri answers a
   * deserialization error rather than a type error the compiler could have caught.
   */
  /**
   * The marketplace setting and the two price-feed commands.
   *
   * `set_marketplace` and `marketplace_feed_refresh` both take one argument and they spell it
   * **differently** — `id` and `marketplace` — which is exactly the pair a copy-paste gets
   * wrong, and Tauri matches by name. `marketplace_feed_status` takes none at all, which is
   * `prewarm_collection`'s trap: an argument object there is a deserialization error rather
   * than a type error the compiler could have caught.
   */
  it("sends the marketplace commands under the names they declare", async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.setMarketplace("cardkingdom");
    expect(invoke).toHaveBeenCalledWith("set_marketplace", { id: "cardkingdom" });

    invoke.mockResolvedValue({
      marketplace: "cardkingdom",
      fetchedAt: 1_800_000_000,
      feedBuiltAt: "2026-08-11 21:07:02",
      rowCount: 149_989,
    });
    const status = await ipc.marketplaceFeedRefresh("cardkingdom");
    expect(invoke).toHaveBeenCalledWith("marketplace_feed_refresh", {
      marketplace: "cardkingdom",
    });
    // The feed's own build stamp, which is not `fetchedAt` and is `null` for Mana Pool — a
    // mirror that dropped it would leave the panel unable to draw the difference at all.
    expect(status.feedBuiltAt).toBe("2026-08-11 21:07:02");

    invoke.mockResolvedValue([]);
    await ipc.marketplaceFeedStatus();
    expect(invoke).toHaveBeenCalledWith("marketplace_feed_status");
  });

  /**
   * The four Oracle-tag commands, and **three different spellings of "the ids I am asking
   * about"** between the two reads — `cardIds` for the printing-keyed one, `oracleIds` for the
   * oracle-keyed one, and neither for the status. They are the pair a copy-paste gets wrong,
   * Tauri matches by name, and the two take ids from *different columns*: sending an array of
   * `cards.id` under `oracleIds` deserializes perfectly and answers an empty slug list for every
   * one of them, which is indistinguishable from a card the taxonomy has nothing to say about.
   * That is the failure this test exists for — it is silent, and it degrades to the type-line
   * fallback rather than to an error anyone would see.
   */
  it("sends the tag reads under the id names their commands declare", async () => {
    invoke.mockResolvedValue([{ cardId: "p1", slugs: ["removal", "removal-creature"] }]);
    const printings = await ipc.oracleTagsForPrintings(["p1", "p2"]);
    expect(invoke).toHaveBeenCalledWith("oracle_tags_for_printings", { cardIds: ["p1", "p2"] });
    // `cardId`, echoed back — the field a mirror typed as `oracleId` would make into a lie the
    // caller has no way to notice, since both are opaque UUID strings.
    expect(printings).toEqual([{ cardId: "p1", slugs: ["removal", "removal-creature"] }]);

    invoke.mockResolvedValue([{ oracleId: "o1", slugs: [] }]);
    const cards = await ipc.oracleTagsForCards(["o1"]);
    expect(invoke).toHaveBeenCalledWith("oracle_tags_for_cards", { oracleIds: ["o1"] });
    // An empty `slugs` is an **answer**, not a miss: an untagged card, an id `cards` does not
    // have and a printing whose `oracle_id` is NULL all come back like this on purpose.
    expect(cards).toEqual([{ oracleId: "o1", slugs: [] }]);

    // An empty request is a real call and not something the wrapper may short-circuit — Rust
    // prepares no statement for it and answers `[]`, which is the whole of what it costs.
    invoke.mockResolvedValue([]);
    await ipc.oracleTagsForPrintings([]);
    expect(invoke).toHaveBeenCalledWith("oracle_tags_for_printings", { cardIds: [] });
  });

  /**
   * The status read and the refresh, and the two traps between them.
   *
   * `oracle_tags_status` takes **no arguments** — `prewarm_collection`'s trap, where an argument
   * object is a deserialization error rather than a type error the compiler could have caught —
   * while `oracle_tags_refresh` spells its one argument `force`, exactly as `sync_run` does one
   * dataset over. And the fields are the second half: `ingestedAt` and `checkedAt` are separate
   * columns because a 304 moves only the latter, so a mirror that folded them into one would
   * make an up-to-date taxonomy read as due on every launch and cost an API call per start.
   */
  it("asks for the tag status with no arguments and sends the throttle override under `force`", async () => {
    const status = {
      updatedAt: "2026-08-11T09:04:16.113+00:00",
      ingestedAt: 1_800_000_000,
      checkedAt: 1_800_003_600,
      tagCount: 4_521,
      taggingCount: 229_633,
      stale: false,
      refreshing: false,
    };
    invoke.mockResolvedValue(status);

    const read = await ipc.oracleTagsStatus();

    expect(invoke).toHaveBeenCalledWith("oracle_tags_status");
    // Read back rather than assumed: every one of these is camelCase on the wire
    // (`#[serde(rename_all = "camelCase")]` on `OracleTagStatus`), and a field this side spells
    // `tag_count` is `undefined` with no type error anywhere.
    expect(read).toEqual(status);
    // The two stamps are apart by design — the ordinary state of a taxonomy whose last check
    // was a 304 — and nothing here may collapse them.
    expect(read.checkedAt).not.toBe(read.ingestedAt);

    invoke.mockResolvedValue({ ...status, stale: false });
    await ipc.oracleTagsRefresh(true);
    expect(invoke).toHaveBeenCalledWith("oracle_tags_refresh", { force: true });

    // `false` must travel as a key: Tauri fills parameters by name and an absent one is a
    // refusal, not a default.
    await ipc.oracleTagsRefresh(false);
    expect(invoke).toHaveBeenCalledWith("oracle_tags_refresh", { force: false });
  });

  /**
   * The **art** taxonomy's pair, which is the oracle pair's shape under different command names
   * and one different event channel — and that last one is the trap.
   *
   * `oracle-tags:progress` and `art-tags:progress` are two channels because either taxonomy may
   * be refreshing while the other is, so a listener wired to the wrong one is a progress bar that
   * never moves and never errors. Both payloads are the same `tags::TagProgress`, which is
   * exactly what makes the mistake invisible to the compiler.
   */
  it("reads the art tag status, forces its refresh, and listens on its own channel", async () => {
    const status = {
      updatedAt: "2026-08-20T09:12:44.207+00:00",
      ingestedAt: 1_800_000_000,
      checkedAt: 1_800_003_600,
      tagCount: 11_531,
      taggingCount: 475_163,
      stale: false,
      refreshing: false,
    };
    invoke.mockResolvedValue(status);

    expect(await ipc.artTagsStatus()).toEqual(status);
    expect(invoke).toHaveBeenCalledWith("art_tags_status");

    await ipc.artTagsRefresh(true);
    expect(invoke).toHaveBeenCalledWith("art_tags_refresh", { force: true });

    let emit: ((evt: { payload: ArtTagProgressEvent }) => void) | undefined;
    listen.mockImplementation(
      (_name: string, handler: (evt: { payload: ArtTagProgressEvent }) => void) => {
        emit = handler;
        return Promise.resolve(vi.fn());
      },
    );
    const heard: ArtTagProgressEvent[] = [];

    await ipc.onArtTagProgress((e) => heard.push(e));
    emit?.({ payload: { phase: "downloading", done: 512_000, total: 12_544_874 } });

    expect(listen).toHaveBeenCalledWith("art-tags:progress", expect.any(Function));
    expect(heard).toEqual([{ phase: "downloading", done: 512_000, total: 12_544_874 }]);
  });

  /**
   * The five tag commands the Tags page is built out of, and **three different argument shapes
   * between them** — the family a copy-paste gets wrong in a way nothing type-checks.
   *
   * `tag_search` takes three, `tag_children` takes a namespace and a nullable slug, and the mute
   * pair takes `tagId` — snake_case `tag_id` on the Rust side, so a wrapper that sent `tag_id`
   * deserializes to nothing and the mute silently never lands. `tags_muted` takes none at all,
   * which is `prewarm_collection`'s trap: an argument object is a deserialization error rather
   * than something the compiler could have caught.
   */
  it("sends the tag reads and the mute pair under the argument names their commands declare", async () => {
    invoke.mockResolvedValue([]);

    await ipc.tagSearch("dog", "both", 25);
    expect(invoke).toHaveBeenCalledWith("tag_search", {
      text: "dog",
      namespace: "both",
      limit: 25,
    });

    // **`null` must travel as a key.** The roots are what an absent slug means, and Tauri fills
    // `Option<String>` by name — a wrapper that omitted the key would still resolve, and would
    // answer the roots when a rail asked for a named parent's children only by accident.
    await ipc.tagChildren("art", null);
    expect(invoke).toHaveBeenCalledWith("tag_children", { namespace: "art", slug: null });
    await ipc.tagChildren("art", "dog");
    expect(invoke).toHaveBeenCalledWith("tag_children", { namespace: "art", slug: "dog" });

    invoke.mockResolvedValue(undefined);
    await ipc.tagMute("oracle", "b8f1", "removal");
    expect(invoke).toHaveBeenCalledWith("tag_mute", {
      namespace: "oracle",
      tagId: "b8f1",
      slug: "removal",
    });
    // The unmute drops `slug` and keeps the other two: the row is keyed on the pair, and the
    // slug it stored was only ever there so Settings could name it.
    await ipc.tagUnmute("oracle", "b8f1");
    expect(invoke).toHaveBeenCalledWith("tag_unmute", { namespace: "oracle", tagId: "b8f1" });

    invoke.mockResolvedValue([{ namespace: "art", tagId: "b8f1", slug: "dog", mutedAt: 1 }]);
    const muted = await ipc.tagsMuted();
    expect(invoke).toHaveBeenCalledWith("tags_muted");
    // Read back rather than assumed: `tag_id` and `muted_at` are camelCase on the wire, and a
    // mirror that spelled either the column's way would be `undefined` with no type error.
    expect(muted).toEqual([{ namespace: "art", tagId: "b8f1", slug: "dog", mutedAt: 1 }]);
  });

  /**
   * The combo feed's three commands, and **the id name is the trap** — the one this file exists
   * for.
   *
   * `combos_for_cards` declares `card_ids: Vec<String>`, which Tauri fills from `cardIds`, exactly
   * as `oracle_tags_for_printings` does. A wrapper sending `card_ids`, or `cards`, or `ids` is a
   * deserialization error with no type error anywhere on this side — and the *silent* half is
   * worse than the loud one: a combo read that never lands leaves the bracket advisory saying the
   * deck has no combos, which is indistinguishable from a deck that really has none.
   *
   * `combos_status` takes **no arguments** (`prewarm_collection`'s trap: an argument object is a
   * deserialization error rather than something the compiler could have caught), and
   * `combos_refresh` spells its one argument `force`, as `sync_run` and both tag refreshes do.
   *
   * The figures below are fixtures and not measurements — the one measured number in this test is
   * the feed's compressed size in the progress case that follows.
   */
  it("sends the combo commands under the names they declare, and the ids under `cardIds`", async () => {
    const status = {
      combos: 1_200,
      cards: 2_800,
      stamp: "2026-08-27T03:12:44Z",
      fetchedAt: 1_800_000_000,
      checkedAt: 1_800_003_600,
      stale: false,
    };
    invoke.mockResolvedValue(status);

    const read = await ipc.combosStatus();

    expect(invoke).toHaveBeenCalledWith("combos_status");
    // Read back rather than assumed: every field is camelCase on the wire, and one spelled
    // `fetched_at` here is `undefined` with no type error anywhere — which reads as "never
    // ingested" and would put the Settings panel's honest copy on an up-to-date table.
    expect(read).toEqual(status);
    // The two stamps are apart by design — a 304 moves `checkedAt` and not `fetchedAt` — and
    // nothing here may collapse them.
    expect(read.checkedAt).not.toBe(read.fetchedAt);

    // A database that has never ingested the feed: `null` rather than `0`, because "never
    // fetched" and "fetched nothing" are two states and only the first is the supported one the
    // bracket estimate drops a signal for.
    invoke.mockResolvedValue({
      combos: 0,
      cards: 0,
      stamp: null,
      fetchedAt: null,
      checkedAt: null,
      stale: true,
    });
    const cold = await ipc.combosStatus();
    expect(cold.fetchedAt).toBeNull();
    expect(cold.combos).toBe(0);

    invoke.mockResolvedValue(status);
    await ipc.combosRefresh(true);
    expect(invoke).toHaveBeenCalledWith("combos_refresh", { force: true });
    // `false` must travel as a key: Tauri fills parameters by name and an absent one is a
    // refusal, not a default.
    await ipc.combosRefresh(false);
    expect(invoke).toHaveBeenCalledWith("combos_refresh", { force: false });

    const combo = {
      id: "1957-4050-7918--204",
      bracketTag: "R",
      cards: ["Thassa's Oracle", "Demonic Consultation"],
      templateCount: 0,
      produces: "Win the game",
      popularity: 9_001,
    };
    invoke.mockResolvedValue([combo]);

    const found = await ipc.combosForCards(["p1", "p2"]);

    expect(invoke).toHaveBeenCalledWith("combos_for_cards", { cardIds: ["p1", "p2"] });
    // `bracketTag` and `templateCount` are the two the estimator reads: the letter is the floor
    // and `0` is what makes the combo count toward it at all. A mirror that dropped either would
    // leave the advisory drawing combos that raise nothing.
    expect(found).toEqual([combo]);

    // An empty request is a real call and not something the wrapper may short-circuit — a deck
    // with no countable piles asks, and Rust answers `[]`.
    invoke.mockResolvedValue([]);
    await ipc.combosForCards([]);
    expect(invoke).toHaveBeenCalledWith("combos_for_cards", { cardIds: [] });
  });

  /**
   * The combo feed's own progress channel, which is the mistake the compiler cannot see.
   *
   * `combos:progress` sits beside `marketplace:progress`, `oracle-tags:progress` and
   * `art-tags:progress`, and every one of those payloads is `{ phase, done, total }` — so a
   * listener wired to the wrong channel is a progress line that never moves and never errors.
   */
  it("listens for combo progress on its own channel", async () => {
    let emit: ((evt: { payload: ComboProgress }) => void) | undefined;
    listen.mockImplementation(
      (_name: string, handler: (evt: { payload: ComboProgress }) => void) => {
        emit = handler;
        return Promise.resolve(vi.fn());
      },
    );
    const heard: ComboProgress[] = [];

    await ipc.onCombosProgress((e) => heard.push(e));
    // 27 542 314 is the feed's measured compressed size (2026-08-27), so `total` is bytes in this
    // phase and variants in `ingesting` — two counts on one pair of fields.
    emit?.({ payload: { phase: "downloading", done: 1_048_576, total: 27_542_314 } });

    expect(listen).toHaveBeenCalledWith("combos:progress", expect.any(Function));
    expect(heard).toEqual([{ phase: "downloading", done: 1_048_576, total: 27_542_314 }]);
  });

  /**
   * A tag-filtered search, in the shape the request really goes out in.
   *
   * **`artTags`, `oracleTags` and `artWeightFloor` are pinned by a Rust end-to-end JSON test**
   * (`search::tests`), and a misspelling on this side is an *ignored unknown key* rather than an
   * error — the search would simply not narrow, and the wall would look like a filter that found
   * a lot of matches. The nested `include`/`exclude` are the same trap one level down.
   */
  it("sends the tag filters under the keys the request deserializes", async () => {
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    await ipc.searchCards({
      artTags: { include: ["dog"], exclude: ["skeleton"] },
      oracleTags: { include: ["ramp"] },
      artWeightFloor: "strong",
      limit: 60,
      offset: 0,
    });

    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: {
        artTags: { include: ["dog"], exclude: ["skeleton"] },
        oracleTags: { include: ["ramp"] },
        artWeightFloor: "strong",
        limit: 60,
        offset: 0,
      },
    });
  });

  /**
   * The printings list's grouping — one of the settings that carry no struct at all, and the
   * pair a copy of the marketplace one gets wrong. (There are four of them now; the header of
   * `ipc.ts` is where the list lives, and this test is about one pair's argument names rather
   * than about the count.)
   *
   * `set_marketplace` spells its single argument `id` and `set_printing_group_by` spells its
   * own `mode`; Tauri matches by name, so the wrapper copied from the neighbour two lines up
   * is a runtime deserialization error with no type error anywhere. And `printing_group_by`
   * takes none at all — `prewarm_collection`'s trap, in the module that added the pair.
   */
  it("sends the printings grouping under `mode` and reads it back with no arguments", async () => {
    invoke.mockResolvedValue("set");

    const mode = await ipc.printingGroupBy();

    expect(invoke).toHaveBeenCalledWith("printing_group_by");
    // A bare string, not a narrowed union: the row may have been written by a build that
    // offered a mode this one does not, and it has to reach `isPrintingGroupBy` as what it is.
    expect(mode).toBe("set");

    invoke.mockResolvedValue(undefined);
    await ipc.setPrintingGroupBy("price");
    expect(invoke).toHaveBeenCalledWith("set_printing_group_by", { mode: "price" });
  });

  it("reads the error log with a limit and clears it with nothing", async () => {
    invoke.mockResolvedValue([]);
    await ipc.errorLogList(50);
    expect(invoke).toHaveBeenCalledWith("error_log_list", { limit: 50 });

    invoke.mockResolvedValue(3);
    const gone = await ipc.errorLogClear();
    expect(invoke).toHaveBeenCalledWith("error_log_clear");
    expect(gone).toBe(3);
  });

  /**
   * `card_image_uri(cardId, variant)` — the context menu's one round trip for an image URL.
   * `variant` is a bare string on the wire, so a wrapper that reached for `imageVariant` or
   * dropped it silently would be a runtime deserialization error no type here catches.
   */
  it("sends a card image request under `cardId` and `variant`", async () => {
    invoke.mockResolvedValue("https://cards.scryfall.io/display/x.webp?1");
    const uri = await ipc.cardImageUri("p1", "display");
    expect(invoke).toHaveBeenCalledWith("card_image_uri", { cardId: "p1", variant: "display" });
    expect(uri).toBe("https://cards.scryfall.io/display/x.webp?1");
  });

  /**
   * `export_write_file(path, contents)` — the save-dialog path Rust writes at, since no `fs:`
   * permission is granted anywhere for the webview to write it itself.
   */
  it("sends an export write under `path` and `contents`", async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.exportWriteFile("C:\\decks\\out.txt", "1 Lightning Bolt\n");
    expect(invoke).toHaveBeenCalledWith("export_write_file", {
      path: "C:\\decks\\out.txt",
      contents: "1 Lightning Bolt\n",
    });
  });

  /**
   * The plain-text mirror's four. Two of them carry an argument, and both names are the crate's
   * parameter names — `mirror_set_enabled(enabled)` and `mirror_set_root(root)` — so a wrapper
   * that spelled either differently would fail at runtime with a deserialization error and no
   * type error anywhere.
   */
  it("asks for the mirror's state with no arguments", async () => {
    invoke.mockResolvedValue({
      enabled: true,
      root: "D:\\app\\data\\export",
      lastRunAt: null,
      lastReport: null,
      lastError: null,
    });

    const status = await ipc.mirrorStatus();

    expect(invoke).toHaveBeenCalledWith("mirror_status");
    // `lastRunAt` is a **string** on the wire and `null` for no pass having finished — the two
    // facts this whole panel's "not run yet" arm rests on.
    expect(status.lastRunAt).toBeNull();
  });

  it("sends the mirror switch under `enabled`", async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.mirrorSetEnabled(false);
    expect(invoke).toHaveBeenCalledWith("mirror_set_enabled", { enabled: false });
  });

  it("sends the mirror folder under `root`", async () => {
    invoke.mockResolvedValue(undefined);
    await ipc.mirrorSetRoot("E:\\Backups\\MTG");
    expect(invoke).toHaveBeenCalledWith("mirror_set_root", { root: "E:\\Backups\\MTG" });
  });

  it("asks for a rebuild with no arguments and gets the pass back", async () => {
    invoke.mockResolvedValue({ written: 142, unchanged: 208, pruned: 0, failed: 0 });

    const report = await ipc.mirrorRebuild();

    expect(invoke).toHaveBeenCalledWith("mirror_rebuild");
    expect(report).toEqual({ written: 142, unchanged: 208, pruned: 0, failed: 0 });
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
  // Not `toBe(unlisten)`. `ipc` reaches Tauri through `@/lib/core` now, so the handle it
  // hands back is the boundary's own unsubscribe rather than the object Tauri returned.
  // That identity was precisely the transport detail the boundary exists to hide; that the
  // handle *unsubscribes* is the claim worth pinning, and it is the stronger of the two —
  // `toBe` passed for a handle that was never wired to anything.
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

/**
 * `sync:applied` and `sync:live` — the connection manager's two events (`sync_engine/live.rs`,
 * `sync_engine/commands.rs`). Same trap as every event name in this file: the string is the
 * whole contract and nothing in the type system holds it, so a subscriber spelling either one
 * differently — a hyphen, an underscore — hears nothing at all, forever, with no error
 * anywhere. `RelayOutcome` already exists above as `syncNow`'s answer; `onSyncApplied` hands
 * that same shape through unwrapped rather than redeclaring it.
 */
it("subscribes to sync:applied and hands the payload through unwrapped", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: RelayOutcome }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: RelayOutcome }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: RelayOutcome[] = [];
  const outcome: RelayOutcome = {
    pushed: 1,
    pulled: 2,
    unreadable: 0,
    applied: 3,
    resurrected: 0,
    cyclesBroken: 0,
    skipped: 0,
    deferred: 0,
    baselineOps: 0,
    baselineHistory: 0,
  };

  const stop = await ipc.onSyncApplied((o) => seen.push(o));
  emit?.({ payload: outcome });

  expect(listen).toHaveBeenCalledWith("sync:applied", expect.any(Function));
  expect(seen[0]).toEqual(outcome);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

it("subscribes to sync:live and hands the payload through unwrapped", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: SyncLiveEvent }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: SyncLiveEvent }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: SyncLiveEvent[] = [];

  const stop = await ipc.onSyncLive((e) => seen.push(e));
  emit?.({ payload: { state: "connecting" } });

  expect(listen).toHaveBeenCalledWith("sync:live", expect.any(Function));
  expect(seen).toEqual([{ state: "connecting" }]);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

/**
 * **The two tests above pin only this side of the seam, and that is the failure this repo has
 * already had twice.** A Rust↔`ipc.ts` contract has no compiler and no shared type: renaming
 * `app.emit("sync:applied", …)` in the crate leaves every assertion here green, because they
 * assert that `onSyncApplied` subscribes to the string *this file* wrote down — a listener
 * hearing nothing, forever, with both suites passing.
 *
 * So the string is read out of the crate, the same way the DTO mirrors below read their struct
 * fields. Two emitters, because the events come from two places: `sync_engine/live.rs` emits
 * both from the background loop, and `sync_engine/commands.rs` emits `sync:applied` again for
 * the manual **Sync now** press.
 *
 * The `raw.includes` shape is deliberately crude — this is a name check and not a parse. What
 * it can catch is the whole class that has bitten: a rename on either side, a hyphen for a
 * colon, an underscore for a hyphen.
 */
describe("the sync event names agree with the crate that emits them", () => {
  const emitters: [name: string, source: string][] = [
    ["sync_engine/live.rs", syncLiveRs],
    ["sync_engine/commands.rs", syncCommandsRs],
  ];

  // Not `toContain` on the raw sources alone: a pass has to mean "both ends spell it", never
  // "neither end was read", so each source is checked for length first.
  it.each(emitters)("%s was read", (_name, source) => {
    expect(source.length).toBeGreaterThan(1_000);
  });

  it("emits sync:applied on both sides of the boundary", () => {
    expect(syncLiveRs).toContain('app.emit("sync:applied"');
    expect(syncCommandsRs).toContain('app.emit("sync:applied"');
    expect(ipcSource).toContain('"sync:applied"');
  });

  it("emits sync:live on both sides of the boundary", () => {
    expect(syncLiveRs).toContain('app.emit("sync:live"');
    expect(ipcSource).toContain('"sync:live"');
  });
});

/**
 * `marketplace:progress` — its **own** event rather than a ninth `SyncPhase`.
 *
 * The name is the whole contract and there is nothing in the type system holding it: a
 * subscriber spelling it `marketplace_feed:progress` hears nothing at all, forever, with no
 * error anywhere. It follows `update:progress`'s precedent for a stated reason — `SyncPhase` is
 * a closed union behind a total `PHASE_LABEL` map, so a phase added there would render
 * `undefined` on the ribbon — and the payload carries `marketplace`, because two feeds exist
 * and either can be the one running.
 */
it("unwraps the marketplace:progress payload and returns the unlisten handle", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: FeedProgressEvent }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: FeedProgressEvent }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: FeedProgressEvent[] = [];

  const stop = await ipc.onMarketplaceProgress((e) => seen.push(e));
  emit?.({
    payload: { marketplace: "cardkingdom", phase: "downloading", done: 5, total: 66_787_283 },
  });

  expect(listen).toHaveBeenCalledWith("marketplace:progress", expect.any(Function));
  expect(seen).toEqual([
    { marketplace: "cardkingdom", phase: "downloading", done: 5, total: 66_787_283 },
  ]);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
});

/**
 * `oracle-tags:progress` — a **hyphen** where both of its neighbours have none.
 *
 * `sync:progress`, `update:progress` and `marketplace:progress` are one word each, and this one
 * is not; `oracle_tags.rs` spells it `oracle-tags:progress` and that string is the whole
 * contract. A subscriber that guessed `oracle_tags:progress` — or `oracletags:progress` —
 * hears nothing at all, forever, with no error anywhere and nothing in the type system holding
 * it. The failure is invisible twice over here: the ribbon simply never draws a line for a
 * refresh that is running perfectly, and the categories it produces are right either way.
 */
it("unwraps the oracle-tags:progress payload and returns the unlisten handle", async () => {
  const unlisten = vi.fn();
  let emit: ((evt: { payload: OracleTagProgressEvent }) => void) | undefined;
  listen.mockImplementation(
    (_name: string, handler: (evt: { payload: OracleTagProgressEvent }) => void) => {
      emit = handler;
      return Promise.resolve(unlisten);
    },
  );
  const seen: OracleTagProgressEvent[] = [];

  const stop = await ipc.onOracleTagProgress((e) => seen.push(e));
  emit?.({ payload: { phase: "downloading", done: 512_000, total: 5_850_000 } });

  expect(listen).toHaveBeenCalledWith("oracle-tags:progress", expect.any(Function));
  expect(seen).toEqual([{ phase: "downloading", done: 512_000, total: 5_850_000 }]);
  stop();
  expect(unlisten).toHaveBeenCalledTimes(1);
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

/**
 * The four clears take **no arguments at all**, so the only half of the contract that can drift
 * is the command name — and a name Rust does not register is a runtime rejection with no type
 * error anywhere. These are irreversible commands reached from one button each, so "it silently
 * did nothing" and "it silently did it to the wrong table" are both worth a spelling test.
 */
describe("the Settings clears name the commands `reset.rs` registers", () => {
  it.each([
    ["collectionClear", "collection_clear"],
    ["wishlistClear", "wishlist_clear"],
    ["decksClear", "decks_clear"],
    ["cacheClear", "cache_clear"],
  ] as const)("%s invokes %s with no arguments", async (method, command) => {
    invoke.mockResolvedValue({});

    await ipc[method]();

    expect(invoke).toHaveBeenCalledWith(command);
  });
});

/**
 * The collection's seven folder commands.
 *
 * **Every one of them is a name and a set of argument spellings that nothing type-checks.**
 * `invoke` matches by name against the Rust parameter list, and `collection_folders.rs` renames
 * to camelCase — so a wrapper reaching for a plausible `collection_folder_set` or spelling
 * `parent_id` is a runtime rejection, or worse a bound `None` that files at the root, with no
 * type error anywhere. The seven names below are the seven entries in `lib.rs`'s
 * `generate_handler!`, and the `null`s are load-bearing: `null` is how a folder is made at the
 * top level, moved back out of one, and how a card is filed back at the root of the collection.
 */
describe("the collection folder wrappers name the commands `collection_folders.rs` registers", () => {
  it("asks for the folder list with no arguments at all", async () => {
    invoke.mockResolvedValue([]);

    await ipc.collectionFolderList();

    // No card id scopes it: a folder belongs to no card, the way a directory belongs to no file.
    expect(invoke).toHaveBeenCalledWith("collection_folder_list");
  });

  it("spells the four folder writes the way their commands declare them", async () => {
    invoke.mockResolvedValue({ id: 2, parentId: null, name: "Binder", kind: "user", deckId: null });

    await ipc.collectionFolderCreate(null, "Binder");
    expect(invoke).toHaveBeenCalledWith("collection_folder_create", {
      parentId: null,
      name: "Binder",
    });

    await ipc.collectionFolderCreate(2, "Rares");
    expect(invoke).toHaveBeenCalledWith("collection_folder_create", { parentId: 2, name: "Rares" });

    await ipc.collectionFolderRename(2, "Trade binder");
    expect(invoke).toHaveBeenCalledWith("collection_folder_rename", { id: 2, name: "Trade binder" });

    // `null` is the root and is a destination rather than an omission — the way back out.
    await ipc.collectionFolderMove(3, null);
    expect(invoke).toHaveBeenCalledWith("collection_folder_move", { id: 3, parentId: null });

    // The whole level in order — {@link ipc.deckFolderReorder}'s rule, one cabinet over. This
    // one alone fences the reader's own `kind`, because it is the only cabinet with one.
    invoke.mockResolvedValue([]);
    await ipc.collectionFolderReorder(2, [5, 3]);
    expect(invoke).toHaveBeenCalledWith("collection_folder_reorder", { parentId: 2, ids: [5, 3] });

    invoke.mockResolvedValue(undefined);
    await ipc.collectionFolderDelete(3);
    expect(invoke).toHaveBeenCalledWith("collection_folder_delete", { id: 3 });
  });

  /**
   * The one write that is about a **card** rather than a folder, and the one whose name breaks
   * the family's pattern: `collection_set_folder`, not `collection_folder_set`.
   */
  it("moves an owned row with `collection_set_folder`, and `null` is the root", async () => {
    invoke.mockResolvedValue({ id: 7, quantity: 3, removed: false });

    await ipc.collectionSetFolder(7, 4);
    expect(invoke).toHaveBeenCalledWith("collection_set_folder", { id: 7, folderId: 4 });

    // Not an omission: the root of the collection is where every unfiled copy is, and this is
    // the only way back to it.
    await ipc.collectionSetFolder(7, null);
    expect(invoke).toHaveBeenCalledWith("collection_set_folder", { id: 7, folderId: null });
  });

  /**
   * The two writes that move a row across the deck boundary. **The command names have no
   * prefix** — `collection_alloc::commands` exists so the wire name and the function name can be
   * the same word — so neither follows the `collection_*`/`deck_*` family above, and a mirror
   * that "corrected" them would fail only at runtime.
   *
   * `collectionToDeck`'s one caller is the deck builder's Collection Search tab
   * (`features/decks/useCollectionSearch.ts`, 2026-08-23). It had **none** when these names were
   * pinned, which was the reason to pin them: nothing else would have noticed a typo until the
   * day something called it, and by then the four names are load-bearing in a write.
   */
  it("names the two deck-boundary moves without a prefix", async () => {
    invoke.mockResolvedValue({ entryId: 9, fromDeck: null, quantity: 2 });

    await ipc.collectionToDeck(7, 3, { id: 11 }, 2);
    expect(invoke).toHaveBeenCalledWith("collection_to_deck", {
      entryId: 7,
      deckId: 3,
      categoryId: 11,
      categoryName: null,
      quantity: 2,
    });

    // The other arm of {@link DeckPile}: a name the backend finds or creates through
    // `category_for_name`, which is the one write that marks an invented pile `origin: "auto"`.
    // **The two fields are exclusive on the wire and the union is what enforces it** — Rust
    // refuses a payload carrying both in words, and no caller here can build one.
    await ipc.collectionToDeck(7, 3, { name: "Ramp" }, 2);
    expect(invoke).toHaveBeenCalledWith("collection_to_deck", {
      entryId: 7,
      deckId: 3,
      categoryId: null,
      categoryName: "Ramp",
      quantity: 2,
    });

    // Addressed by `deck_cards.id` — the one deck command that is, where every other one takes
    // the grain.
    const out = await ipc.deckToCollection(42, 2);
    expect(invoke).toHaveBeenCalledWith("deck_to_collection", { deckCardId: 42, quantity: 2 });
    expect(out.entryId).toBe(9);
  });

  /**
   * **The pile is read by its `id`'s *value*, never by the key being present.**
   *
   * Both members of {@link DeckPile} declare `id` — the name arm as `?: undefined`, which is the
   * whole trick that stops `{ id, name }` satisfying either — so `{ name: "Ramp", id: undefined }`
   * is a legal `DeckPile` that an `"id" in pile` test calls the id arm. That sends
   * `categoryId: undefined, categoryName: null`, both of which deserialise to `None`, and
   * `Pile::from_args` answers `NO_CATEGORY`: a filing by name refused for naming no pile.
   *
   * No caller writes it today — both build object literals — which is exactly why it is pinned
   * here rather than left to the day one spreads a partial object into the argument.
   */
  it("reads the pile by the id's value, not by the key being there", async () => {
    invoke.mockResolvedValue({ entryId: 9, fromDeck: null, deckCardId: 4, quantity: 1 });

    await ipc.collectionToDeck(7, 3, { name: "Ramp", id: undefined }, 1);

    expect(invoke).toHaveBeenCalledWith("collection_to_deck", {
      entryId: 7,
      deckId: 3,
      categoryId: null,
      categoryName: "Ramp",
      quantity: 1,
    });
  });

  /**
   * **What moved is the answer, never the argument.** A deck card nobody owned reports `0` and
   * `entryId: null` rather than failing — the group is the record of which cards the reader
   * actually has behind a list — and a caller that quoted its own `quantity` would tell them
   * two copies are on their desk when none are.
   */
  it("reports what a cut actually moved, which can be nothing", async () => {
    invoke.mockResolvedValue({ entryId: null, fromDeck: null, quantity: 0 });

    const out = await ipc.deckToCollection(42, 2);

    expect(out).toEqual({ entryId: null, fromDeck: null, quantity: 0 });
  });

  it("prices the folder summary at the marketplace it is given", async () => {
    invoke.mockResolvedValue([{ folderId: 4, cards: 12, value: null }]);

    const rows = await ipc.collectionFolderSummary("cardkingdom");

    expect(invoke).toHaveBeenCalledWith("collection_folder_summary", {
      marketplace: "cardkingdom",
    });
    // `null`, never `0`: a folder of cards the feed has never listed is unpriced rather than
    // worthless, and the tile draws an em dash for it.
    expect(rows[0].value).toBeNull();
  });

  /**
   * The folder an **add** files into, which is a field on `EntryInput` rather than a command of
   * its own — because `folder_id` is part of the collection's storage grain, so adding the same
   * printing to two folders is two rows.
   */
  it("carries the add's destination folder on the entry", async () => {
    invoke.mockResolvedValue({ id: 1, quantity: 1, removed: false });

    await ipc.collectionAdd({ cardId: "bolt", finish: "nonfoil", quantity: 1, folderId: 4 });

    expect(invoke).toHaveBeenCalledWith("collection_add", {
      entry: { cardId: "bolt", finish: "nonfoil", quantity: 1, folderId: 4 },
    });
  });
});

/**
 * Pairing's commands — spec §7.5 and §7.6.
 *
 * **The number is deliberately not written down.** This line said *eight* while `desktop.rs`
 * registered nine; a count is a fact about a tree and every open branch has a different one, which
 * is the same argument `src-tauri/CLAUDE.md` already makes about this exact list.
 *
 * `invoke` matches arguments **by name**, so a wrapper that spells one differently fails at
 * runtime with a deserialization error and no type error anywhere. These pin the three names
 * Rust declares: `code`, `deviceId` and `name`. **`response` and `sealedKey` are gone from this
 * list** (they were `sync_pairing_respond`'s and `sync_pairing_complete`'s own): a relay carries
 * both blobs now, so the two commands that used to hand them to a reader for hand-carrying are
 * folded into `sync_pairing_poll`, which takes no arguments of its own.
 */
describe("pairing", () => {
  const status = {
    deviceId: "aa".repeat(16),
    deviceName: "MAIN-PC",
    groupId: null,
    epoch: null,
    devices: [],
  };

  it("reads the panel with no arguments", async () => {
    invoke.mockResolvedValue(status);

    const answered = await ipc.syncPairingStatus();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_status");
    // `groupId` and `epoch` are null on an unpaired device, and the panel draws a different
    // section for that — a mirror that typed them as numbers would make "not paired" and
    // "in a group with epoch 0" the same thing.
    expect(answered.groupId).toBeNull();
    expect(answered.epoch).toBeNull();
  });

  it("starts an offer with no arguments and reads back both forms of it", async () => {
    invoke.mockResolvedValue({ code: "ABCDE-FGHJK", qr: { width: 21, modules: [true, false] } });

    const offer = await ipc.syncPairingBegin();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_begin");
    expect(offer.code).toBe("ABCDE-FGHJK");
    // The matrix is booleans, not a data URI: the page draws the SVG.
    expect(offer.qr.modules[0]).toBe(true);
  });

  it("sends the typed code under `code` and answers six digits, and nothing to carry back", async () => {
    invoke.mockResolvedValue({ sas: "042913" });

    const shake = await ipc.syncPairingAccept("ABCDE-FGHJK");

    expect(invoke).toHaveBeenCalledWith("sync_pairing_accept", { code: "ABCDE-FGHJK" });
    // A string and not a number, and the leading zero is why: `042913` and `42913` are the
    // same number and not the same code, and the reader is comparing characters.
    expect(shake.sas).toBe("042913");
    // `PairingHandshake` no longer has a `response` field to carry to the other device — the
    // relay is what carries it now (spec §1).
    expect(shake).not.toHaveProperty("response");
  });

  it("confirms with no arguments and answers the sealed key", async () => {
    invoke.mockResolvedValue({ sealedKey: "SEALED" });

    const sealed = await ipc.syncPairingConfirm();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_confirm");
    expect(sealed.sealedKey).toBe("SEALED");
  });

  /**
   * `sync_pairing_poll` replaces `sync_pairing_respond` and `sync_pairing_complete` — one
   * command, no arguments, asked on an interval rather than pressed once a paste box is filled.
   */
  it("polls with no arguments and answers idle when nothing is in flight", async () => {
    invoke.mockResolvedValue({ stage: "idle", sas: null });

    const progress = await ipc.syncPairingPoll();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_poll");
    expect(progress.stage).toBe("idle");
    expect(progress.sas).toBeNull();
  });

  it("polls and answers the six digits once both sides have them", async () => {
    invoke.mockResolvedValue({ stage: "compare", sas: "042913" });

    const progress = await ipc.syncPairingPoll();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_poll");
    expect(progress.stage).toBe("compare");
    expect(progress.sas).toBe("042913");
  });

  it("cancels with no arguments", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.syncPairingCancel();

    expect(invoke).toHaveBeenCalledWith("sync_pairing_cancel");
  });

  it("renames and revokes by `deviceId`", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.syncDeviceRename("cc".repeat(16), "Phone");
    expect(invoke).toHaveBeenCalledWith("sync_device_rename", {
      deviceId: "cc".repeat(16),
      name: "Phone",
    });

    await ipc.syncDeviceRevoke("cc".repeat(16));
    expect(invoke).toHaveBeenCalledWith("sync_device_revoke", { deviceId: "cc".repeat(16) });
  });

  it("reads the relay with no arguments", async () => {
    invoke.mockResolvedValue({
      paired: false,
      pending: 0,
      lastSyncAt: null,
      reviewCount: 0,
    });

    const status = await ipc.syncRelayStatus();

    expect(invoke).toHaveBeenCalledWith("sync_relay_status");
    expect(status.pending).toBe(0);
  });

  /**
   * **`sync_relay_set_url` is gone, and this is the assertion that says so rather than a gap.**
   * The relay became one hosted service whose address is compiled into the crate, so there is
   * nothing for a reader to set — and a mirror that kept the method would leave `ipc.ts`
   * offering a command `desktop.rs` no longer registers, which fails at the IPC boundary and
   * nowhere a type-checker looks. `relayUrl` left the same way and for the same reason: what
   * makes sync on or off is now an entitlement.
   */
  it("no longer offers a way to set a relay address", () => {
    expect(ipc).not.toHaveProperty("syncRelaySetUrl");
  });

  it("begins a Patreon connection with no arguments, and opens nothing itself", async () => {
    invoke.mockResolvedValue("https://www.patreon.com/oauth2/authorize?client_id=x&state=y");

    const url = await ipc.syncPatreonBegin();

    expect(invoke).toHaveBeenCalledWith("sync_patreon_begin");
    // A string and not a side effect: the browser hop belongs to the `opener` plugin, which is
    // TypeScript's, so a panel that merely *offers* to connect has visited nothing.
    expect(url).toMatch(/^https:\/\//);
  });

  it("sends the claim code under `code`", async () => {
    invoke.mockResolvedValue({
      entitled: true,
      status: "active",
      since: 1_756_000_000,
      groupBound: true,
    });

    const supporter = await ipc.syncPatreonClaim("PQRS-TVWX-YZ01");

    expect(invoke).toHaveBeenCalledWith("sync_patreon_claim", { code: "PQRS-TVWX-YZ01" });
    expect(supporter.entitled).toBe(true);
  });

  /**
   * **Four fields, `camelCase`, and two of them are worth an assertion of their own.**
   *
   * The Rust is `group_bound` under `#[serde(rename_all = "camelCase")]`, and it is the only
   * signal separating *Membership ended* from *Not connected* — a lapse clears the refresh
   * secret **and** the date, so `entitled`, `status` and `since` all read exactly as they do on
   * a device out of the box. A mirror that misspelled that one field would leave every lapsed
   * reader told they had never connected, with nothing red anywhere.
   *
   * ⚠️ **`entitled` is the second, and it is here because this file is the only fence there
   * is.** The crate renamed `connected` → `entitled` in spec §2.5 and this hand-written mirror
   * kept the old spelling for a wave: TypeScript compiled, every test passed, and
   * `status.connected` was `undefined` in the shipped window — so `supporterState` fell to
   * *Not connected* and drew **Connect Patreon at a paid-up supporter on every device but one**.
   * Naming the field in a mock is what makes the next such rename a red build; a mock that keeps
   * an old spelling is green for ever.
   */
  it("reads the supporter status with no arguments, and names its fields in camelCase", async () => {
    invoke.mockResolvedValue({
      entitled: false,
      status: "dead",
      since: null,
      groupBound: true,
    });

    const supporter = await ipc.syncSupporterStatus();

    expect(invoke).toHaveBeenCalledWith("sync_supporter_status");
    expect(supporter.groupBound).toBe(true);
    expect(supporter.since).toBeNull();
    // Named rather than inferred: a DTO that stopped carrying this field would answer
    // `undefined`, which is falsy and would satisfy a `toBeFalsy()` written for tidiness.
    expect(supporter.entitled).toBe(false);
  });

  /**
   * The other half of the same fence, and **it is a compile-time assertion rather than a
   * runtime one**.
   *
   * A mirror that carried *both* names — the rename made as an addition — would satisfy every
   * assertion above while a call site went on reading the dead one. Nothing at runtime can
   * catch that: `invoke` is mocked here, so `Object.keys` would only ever report the keys this
   * file's own fixture wrote, which is an assertion reading its own constant. `@ts-expect-error`
   * is the check that bites — it fails the build when the line **stops** being an error, which
   * is precisely the day `connected` comes back.
   */
  it("carries no `connected` field, which is the name that was renamed away", async () => {
    invoke.mockResolvedValue({
      entitled: true,
      status: "active",
      since: 1_756_000_000,
      groupBound: true,
    });

    const supporter = await ipc.syncSupporterStatus();

    // @ts-expect-error `connected` became `entitled` in spec §2.5. If this stops erroring the
    // dead name is back on the interface and a call site can read it again.
    expect(supporter.connected).toBeUndefined();
  });

  it("syncs now with no arguments, and null is not a failure", async () => {
    invoke.mockResolvedValue(null);

    // `null` means there was nothing to do — no connected membership, or no pairing group —
    // which is the state every existing installation is in and is not an error.
    expect(await ipc.syncNow()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("sync_now");
  });

  it("tells the socket whether the app is in front under `on`", async () => {
    invoke.mockResolvedValue(undefined);

    await ipc.syncLiveForeground(true);

    expect(invoke).toHaveBeenCalledWith("sync_live_foreground", { on: true });
  });

  it("reads the socket's current state with no arguments", async () => {
    invoke.mockResolvedValue("connecting");

    expect(await ipc.syncLiveState()).toBe("connecting");
    expect(invoke).toHaveBeenCalledWith("sync_live_state");
  });

  it("lists the review queue with no arguments and clears one row by table and uid", async () => {
    invoke.mockResolvedValue([]);
    await ipc.syncReviewList();
    expect(invoke).toHaveBeenCalledWith("sync_review_list");

    // By `sync_uid` and never by a rowid: `muted_tags` has none at all, and a rowid means
    // nothing on the other device anyway.
    await ipc.syncReviewClear("collection_entries", "aa".repeat(16));
    expect(invoke).toHaveBeenCalledWith("sync_review_clear", {
      table: "collection_entries",
      uid: "aa".repeat(16),
    });
  });
});
/**
 * **`src/lib/ipc.ts` is a hand-written mirror and nothing in the build type-checks it against
 * the crate.** A field added to a Rust DTO and forgotten here is `undefined` at the call site
 * with no type error anywhere; a field renamed on either side is the same. Every other pin in
 * this file guards an *argument* name — the shape going out. This one guards the shape coming
 * back, for the one DTO the card walls are built on.
 *
 * Read as text rather than reflected over, because there is nothing to reflect over: a
 * TypeScript `interface` is erased at run time and the Rust struct is not in this process at
 * all. `#[serde(rename_all = "camelCase")]` makes the mapping mechanical, which is what lets
 * two lists of names be compared instead of two schemas.
 */
describe("the CardSummary mirror agrees with the Rust struct field for field", () => {
  /** Field names of a `pub struct` in a Rust source file, in declaration order. */
  const rustFields = (src: string, name: string): string[] => {
    const start = src.indexOf(`pub struct ${name} {`);
    expect(start, `\`pub struct ${name}\` is not in the Rust source given`).toBeGreaterThan(-1);
    const body = src.slice(start).split("\n").slice(1);
    const end = body.indexOf("}");
    expect(end, `\`${name}\` has no closing brace`).toBeGreaterThan(0);
    return body
      .slice(0, end)
      .map((line) => /^\s*pub\s+([a-z0-9_]+)\s*:/.exec(line)?.[1])
      .filter((f): f is string => f !== undefined);
  };

  /** Field names of an exported `interface`, comments stripped first. */
  const tsFields = (src: string, name: string): string[] => {
    const start = src.indexOf(`export interface ${name} {`);
    expect(start, `\`export interface ${name}\` is not in ipc.ts`).toBeGreaterThan(-1);
    const body = src.slice(start).split("\n").slice(1);
    const end = body.indexOf("}");
    expect(end, `\`${name}\` has no closing brace`).toBeGreaterThan(0);
    return body
      .slice(0, end)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => /^ {2}([A-Za-z0-9_]+)\??:/.exec(line)?.[1])
      .filter((f): f is string => f !== undefined);
  };

  const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

  it("carries every field the Rust struct declares, and no field it does not", () => {
    const rust = rustFields(searchRs, "CardSummary").map(camel);
    const ts = tsFields(ipcSource, "CardSummary");

    // Not `toEqual` on the raw arrays: the parsers are the thing under suspicion, so a pass
    // has to mean "both found fields", never "both found nothing".
    expect(rust.length).toBeGreaterThan(10);
    expect(ts.length).toBeGreaterThan(10);
    expect([...ts].sort()).toEqual([...rust].sort());
  });

  /**
   * The field this whole pin was added for. Named on its own as well as counted above,
   * because the failure it guards is silent in a way the others are not: a search wall on the
   * web build draws no art at all without it, and jsdom has no network to notice.
   */
  it("names the front face's image URLs on both sides", () => {
    expect(rustFields(searchRs, "CardSummary")).toContain("image_uris");
    expect(tsFields(ipcSource, "CardSummary")).toContain("imageUris");
  });

  /**
   * **The other three card walls, pinned the same way and for a failure that has already
   * shipped.** `CardSummary` was the only DTO carrying `image_uris` until 2026-08-31, on the
   * belief that `search_cards` was the one card-bearing command a browser could call. It is
   * not — `collection_list`, `wishlist_list` and `deck_get` are all in `web/route.rs`'s
   * `COMMANDS` — so those three walls drew named, artless frames on the web build while the
   * search wall beside them drew pictures.
   *
   * Nothing in jsdom can notice a missing picture, and nothing in the build type-checks this
   * mirror against the crate, so the field name on both sides is the whole of the fence.
   */
  // Annotated rather than inferred: without the tuple type TypeScript widens each row to
  // `string[]` and the three arguments below lose their names.
  const mirrors: [tsName: string, rustSource: string, rustName: string][] = [
    ["CollectionRow", collectionRs, "CollectionRow"],
    ["WishRow", wishlistRs, "WishRow"],
    // The one pair whose two names differ: the crate calls a deck's line `DeckCardRow` and
    // this file calls it `DeckCard`, so the mapping is spelled out rather than assumed.
    ["DeckCard", deckRs, "DeckCardRow"],
  ];

  it.each(mirrors)(
    "the %s mirror agrees with the Rust struct field for field",
    (tsName, rustSource, rustName) => {
    const rust = rustFields(rustSource, rustName).map(camel);
    const ts = tsFields(ipcSource, tsName);

    // Not `toEqual` on the raw arrays: the parsers are the thing under suspicion, so a pass
    // has to mean "both found fields", never "both found nothing".
    expect(rust.length).toBeGreaterThan(10);
    expect(ts.length).toBeGreaterThan(10);
    expect([...ts].sort()).toEqual([...rust].sort());

    // Named on its own as well as counted, because this is the field the whole widening was
    // for and its absence is silent on both sides.
    expect(rust).toContain("imageUris");
    expect(ts).toContain("imageUris");
    },
  );
});
