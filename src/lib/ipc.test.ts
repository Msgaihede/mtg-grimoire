import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { ipc, ipcError, type FeedProgressEvent, type SyncProgressEvent } from "@/lib/ipc";

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

    await ipc.deckAddCard(4, "p1", 7, null, "live", 4);
    expect(invoke).toHaveBeenCalledWith("deck_add_card", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      categoryName: null,
      variant: "live",
      quantity: 4,
    });

    // The other half of the one command that takes two ways of naming a pile: an id is a drop
    // onto a column the reader pointed at, a name is "file it where this card belongs",
    // found-or-created. **Both keys travel either way** — the unused one as an explicit
    // `null`, because Tauri fills parameters by name and an absent key is a refusal rather
    // than a default.
    await ipc.deckAddCard(4, "p1", null, "Main deck", "live", 1);
    expect(invoke).toHaveBeenCalledWith("deck_add_card", {
      deckId: 4,
      cardId: "p1",
      categoryId: null,
      categoryName: "Main deck",
      variant: "live",
      quantity: 1,
    });

    await ipc.deckSetCardQuantity(4, "p1", 7, "live", 0);
    expect(invoke).toHaveBeenCalledWith("deck_set_card_quantity", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      quantity: 0,
    });

    // The one write that names **two** categories, so it spells neither of them `categoryId`
    // the way its siblings do — and `from`/`to` alone, which is what the zones took, would
    // deserialize into neither parameter.
    invoke.mockResolvedValue(undefined);
    await ipc.deckMoveCard(4, "p1", 9, 2, "live");
    expect(invoke).toHaveBeenCalledWith("deck_move_card", {
      deckId: 4,
      cardId: "p1",
      fromCategoryId: 9,
      toCategoryId: 2,
      variant: "live",
    });

    // The one card write that names **two** cards, so it spells neither of them `cardId` the
    // way its siblings do — a payload that did would deserialize into neither parameter.
    // The answer is read back too: `folded` is the server's arithmetic, and a mirror typed
    // `void` would throw away the one thing the UI has to say about a swap.
    invoke.mockResolvedValue({ folded: true, quantity: 5 });
    const swapped = await ipc.deckSwapPrinting(4, "p1", "p2", 7, "live");
    expect(invoke).toHaveBeenCalledWith("deck_swap_printing", {
      deckId: 4,
      fromCardId: "p1",
      toCardId: "p2",
      categoryId: 7,
      variant: "live",
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
    // patch shape here, so a caller changing one sends the other back unchanged.
    await ipc.deckTagUpdate(3, "Cut", "moss");
    expect(invoke).toHaveBeenCalledWith("deck_tag_update", { id: 3, name: "Cut", color: "moss" });

    invoke.mockResolvedValue(undefined);
    await ipc.deckTagDelete(3);
    expect(invoke).toHaveBeenCalledWith("deck_tag_delete", { id: 3 });

    invoke.mockResolvedValue([{ name: "Cut candidate", color: "ember" }]);
    const palette = await ipc.deckTagSuggestions();
    expect(invoke).toHaveBeenCalledWith("deck_tag_suggestions");
    expect(palette).toEqual([{ name: "Cut candidate", color: "ember" }]);

    invoke.mockResolvedValue(undefined);
    await ipc.deckCardSetTag(4, "p1", 7, "live", 3);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_tag", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      tagId: 3,
    });

    // Untagging is the same command with `null`, not a second one — `deck_cards.tag_id` is a
    // nullable column and clearing it is a write to it.
    await ipc.deckCardSetTag(4, "p1", 7, "live", null);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_tag", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
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
    expect(invoke).toHaveBeenCalledWith("deck_folder_create", { parentId: null, name: "Commander" });

    await ipc.deckFolderCreate(2, "Legends");
    expect(invoke).toHaveBeenCalledWith("deck_folder_create", { parentId: 2, name: "Legends" });

    await ipc.deckFolderRename(2, "EDH");
    expect(invoke).toHaveBeenCalledWith("deck_folder_rename", { id: 2, name: "EDH" });

    await ipc.deckFolderMove(3, null);
    expect(invoke).toHaveBeenCalledWith("deck_folder_move", { id: 3, parentId: null });

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
   * `deck_import_read_file(path)` touches no database, so `path` is its only parameter — and it
   * is a *path* rather than bytes, which is the contract that keeps `dialog:allow-open` the only
   * capability this feature needs. A mirror that sent the file's contents under `path` would
   * type-check perfectly and import a filename.
   *
   * The other two break the module's own patterns in opposite directions: `deck_import_resolve`
   * takes a bare `lines` array where every other list-shaped read in this file wraps its payload
   * in `query` or `req`, and `deck_import_commit` takes `deckId` where the card writes beside it
   * take `deckId` too but spell their payload out field by field rather than as `items`.
   */
  it("sends every import command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckImportResolve([{ name: "Sol Ring", setCode: null, collectorNumber: null }]);
    // `lines`, not `query` or `req` — and both hints travel as explicit `null`s, because Tauri
    // fills parameters by name and the preview must be able to say a hint was *given*.
    expect(invoke).toHaveBeenCalledWith("deck_import_resolve", {
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
    const text = await ipc.deckImportReadFile("C:\\lists\\edh.txt");
    expect(invoke).toHaveBeenCalledWith("deck_import_read_file", { path: "C:\\lists\\edh.txt" });
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
   * The printings list's grouping — the **other** setting that carries no struct at all, and
   * the pair a copy of the marketplace one gets wrong.
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
