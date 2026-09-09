import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

// **Defaulted to `false`, which is the desktop shape every other assertion in this file
// assumes.** `ipc.scannerFrame` is the one wrapper whose *call shape* depends on the OS, so
// the two legs have to be drivable from here; a real `isAndroid()` would answer off jsdom's
// user agent and pin only whichever leg that happens to be. Each Android case arms it with a
// single `mockReturnValueOnce`, so the mock never leaks past the call it was written for.
vi.mock("@/lib/platform", () => ({ isAndroid: vi.fn(() => false) }));

// Read as text, not imported as a module: this pair is the only thing in the build that
// compares the hand-written mirror below with the crate it mirrors. `viewports.test.ts`
// reads `tauri.conf.json` the same way, for the same reason — Rust owns the fact and
// TypeScript only quotes it, so the quote is what can rot.
import collectionRs from "../../src-tauri/src/collection.rs?raw";
import collectionFoldersRs from "../../src-tauri/src/collection_folders.rs?raw";
import combosRs from "../../src-tauri/src/combos.rs?raw";
import deckRs from "../../src-tauri/src/deck.rs?raw";
import deckpaneRs from "../../src-tauri/src/deckpane.rs?raw";
import decksortRs from "../../src-tauri/src/decksort.rs?raw";
import deckMetaRs from "../../src-tauri/src/deck_meta.rs?raw";
import deckMissingRs from "../../src-tauri/src/deck_missing.rs?raw";
import deckPullRs from "../../src-tauri/src/deck_pull.rs?raw";
import deckQuickAddRs from "../../src-tauri/src/deck_quick_add.rs?raw";
import deckTheoryRs from "../../src-tauri/src/deck_theory.rs?raw";
import deckTokensRs from "../../src-tauri/src/deck_tokens.rs?raw";
import markcolorsRs from "../../src-tauri/src/markcolors.rs?raw";
import resetRs from "../../src-tauri/src/reset.rs?raw";
import searchRs from "../../src-tauri/src/search.rs?raw";
import shareRs from "../../src-tauri/src/share/commands.rs?raw";
import syncCommandsRs from "../../src-tauri/src/sync_engine/commands.rs?raw";
import syncLiveRs from "../../src-tauri/src/sync_engine/live.rs?raw";
import wishlistFoldersRs from "../../src-tauri/src/wishlist_folders.rs?raw";
import wishlistRs from "../../src-tauri/src/wishlist.rs?raw";
import wishlistOptimizeRs from "../../src-tauri/src/wishlist_optimize.rs?raw";
// The scanner's seven. Six are in the `card-scanner` crate rather than under `src-tauri/src` —
// the detector is a library with a CLI of its own, and the shapes the page reads are declared
// there — and `src-tauri/src/scanner.rs` is the app's own four commands.
import scannerRs from "../../src-tauri/src/scanner.rs?raw";
import sessionRs from "../../crates/card-scanner/src/session.rs?raw";
import referenceRs from "../../crates/card-scanner/src/reference.rs?raw";
import lockRs from "../../crates/card-scanner/src/lock.rs?raw";
import detectRs from "../../crates/card-scanner/src/detect.rs?raw";
import cardnessRs from "../../crates/card-scanner/src/cardness.rs?raw";
import trimRs from "../../crates/card-scanner/src/trim.rs?raw";
import ipcSource from "./ipc.ts?raw";
import { CONDITIONS, CONDITION_NOT_SET } from "@/lib/conditions";
import { isAndroid } from "@/lib/platform";
import { DEFAULT_SCANNER_OPTIONS } from "@/features/scanner/scannerOptions";
import {
  AUTO_BRACKET,
  ipc,
  ipcError,
  type ArtTagProgressEvent,
  type CardCombosPage,
  type ComboProgress,
  type DeckTokenRow,
  type FeedProgressEvent,
  type OracleTagProgressEvent,
  type RelayOutcome,
  type SyncLiveEvent,
  type SyncProgressEvent,
  type TheorySlot,
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

    // `needsReview` rather than the `fulfilled` this carried until 2026-09-08: that field is off
    // `WishlistQuery` entirely, because the wishlist compares itself to the collection nowhere.
    // A three-state boolean is still what this pin is for — `false` is a real question and has to
    // reach the wire, where `undefined` must not.
    invoke.mockResolvedValue({ items: [], total: 0 });
    await ipc.wishlistList({ needsReview: false, limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("wishlist_list", {
      query: { needsReview: false, limit: 100, offset: 0 },
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
   * The gallery overview's two reads, and the pair that remembers the wall's order.
   *
   * **`set_deck_sort`'s parameter is the one this test exists for.** It is `sort` and not
   * `value`, and there is nothing in either build that would say so: `invoke` fills a command's
   * parameters **by name**, so a wrapper sending `{ value }` is a runtime rejection with a green
   * TypeScript build on one side and a green `cargo test` on the other — the picker would look
   * like it worked all session and open on the default order at the next launch, which is a bug
   * report about *persistence* pointing at a spelling. The crate is read for the word rather
   * than trusted, `deck_played_keys`' rule one test down.
   *
   * `deck_pip_costs` takes **no arguments at all**, which is the opposite trap and the one
   * `prewarm_collection` shipped: a command that takes only the managed state is a
   * deserialization error when an argument object arrives, not a type error. `deck_bracket_reads`
   * is the only one of the four with a payload, and `deck_ids` reaches the wire camelCased —
   * `deckIds` here and `deck_ids: Vec<i64>` there are one name and have to agree.
   *
   * The ids go in and come back **in request order** (`bracket_reads` pushes one entry per id
   * rather than grouping), so a caller may zip the answer against what it sent; a re-ordering
   * mirror would hand every deck its neighbour's bracket.
   */
  it("asks the gallery's overview reads and the remembered sort under the names the crate declares", async () => {
    // Not `toContain` on the sources alone: a pass has to mean "the crate spells it", never
    // "the crate was never read".
    expect(deckRs.length).toBeGreaterThan(1_000);
    expect(decksortRs.length).toBeGreaterThan(500);

    invoke.mockResolvedValue([]);
    await ipc.deckPipCosts();
    expect(invoke).toHaveBeenCalledWith("deck_pip_costs");
    expect(deckRs).toContain("pub async fn deck_pip_costs(");

    await ipc.deckBracketReads([4, 2]);
    expect(invoke).toHaveBeenCalledWith("deck_bracket_reads", { deckIds: [4, 2] });
    expect(deckRs).toContain("pub async fn deck_bracket_reads(");
    expect(deckRs).toContain("deck_ids: Vec<i64>");

    invoke.mockResolvedValue("name:asc");
    await ipc.deckSort();
    expect(invoke).toHaveBeenCalledWith("deck_sort");
    expect(decksortRs).toContain("pub fn deck_sort(");

    invoke.mockResolvedValue(undefined);
    await ipc.setDeckSort("colors:asc");
    expect(invoke).toHaveBeenCalledWith("set_deck_sort", { sort: "colors:asc" });
    expect(decksortRs).toContain("sort: String,");
  });

  /**
   * The mark colours — and the one `app_meta` write where a misspelled argument is **destructive
   * rather than refused**.
   *
   * `set_mark_color(mark: String, color: Option<String>)`, and Tauri fills a missing `Option`
   * argument with `None`. So the two halves fail in opposite directions: a wrapper that spelled
   * `mark` wrong is a parameter Tauri cannot fill and a clean rejection, while one that spelled
   * `color` wrong — `colour`, `value`, `hex` — is accepted, arrives as `None`, and `None` here
   * **deletes the entry**. Every colour the reader picked would read back as unset at the next
   * launch, with a green build on both sides and a write that reported success. That asymmetry is
   * the whole reason this case exists, and it is why the crate is read for both words rather than
   * trusted.
   *
   * `mark_colors` takes **no arguments at all** — `prewarm_collection`'s trap, where an argument
   * object sent to a command that declares only the managed state is a deserialization error and
   * not a type error.
   */
  it("sends both mark-colour commands under the names `markcolors.rs` declares", async () => {
    // A pass must never be able to mean "the crate was never read".
    expect(markcolorsRs.length).toBeGreaterThan(1_000);

    const stored = { theoryExact: "#56bd78", theoryName: "#0e68ab" };
    invoke.mockResolvedValue(stored);
    const colors = await ipc.markColors();
    expect(invoke).toHaveBeenCalledWith("mark_colors");
    expect(colors).toEqual(stored);
    expect(markcolorsRs).toContain("pub fn mark_colors(");

    invoke.mockResolvedValue(undefined);
    await ipc.setMarkColor("theoryExact", "#56BD78");
    // `mark` and `color`, not `key` and `value` — and the uppercase goes over the wire as typed,
    // because the folding is the far end's (`to_ascii_lowercase`) and a mirror that folded here
    // would be a second opinion about a rule the crate already owns.
    expect(invoke).toHaveBeenCalledWith("set_mark_color", {
      mark: "theoryExact",
      color: "#56BD78",
    });
    expect(markcolorsRs).toContain("mark: String,");
    expect(markcolorsRs).toContain("color: Option<String>,");

    // **Reset**, and it is `null` on the wire rather than an omitted key. Both reach Rust as
    // `None` and both clear the row, so this pins the mirror's *signature* — `string | null`,
    // which is what lets the panel's Reset button say what it means — rather than a difference
    // the backend can see.
    await ipc.setMarkColor("theoryExact", null);
    expect(invoke).toHaveBeenCalledWith("set_mark_color", { mark: "theoryExact", color: null });
    // The clearing arm is the crate's, not an inference from the signature.
    expect(markcolorsRs).toContain("colors.remove(mark);");
  });

  /**
   * The two reads a **collection-folder filing rule** is answered from — one deck's played
   * cards, and the decks that play a given set.
   *
   * **They are one question asked from both ends, so they are the shape a copy-paste gets
   * wrong**: `deck_played_keys` takes a `deckId` and answers card keys, `deck_ids_playing`
   * takes card keys and answers deck ids. Both parameters are single-word and neither is
   * `id` — so a wrapper that reached for `id`, or that sent `cardIds` for `keys` because that
   * is what the array holds elsewhere in this file, is a parameter Tauri cannot fill and a
   * runtime rejection with no type error anywhere. And a swap between the two commands
   * type-checks on neither side while both answer an array.
   *
   * **The crate is read for the wire names**, `deck_category_clear`'s argument above: nothing
   * else in this build compares the two sides, and a name Rust does not register is a menu
   * whose rows all grey for a reason nothing on screen explains.
   *
   * The answers are read back because the mirrors are typed rather than inert — `string[]` one
   * way and `number[]` the other, and a mirror that had them the wrong way round would hand a
   * consumer a `Set` of card keys to test deck ids against, which matches nothing and looks
   * exactly like a deck that plays nothing.
   */
  it("asks both play reads under the names their commands declare, and the crate declares them", async () => {
    // Not `toContain` on the source alone: a pass has to mean "the crate spells it", never
    // "the crate was never read".
    expect(deckRs.length).toBeGreaterThan(1_000);
    expect(deckRs).toContain("fn deck_played_keys(");
    expect(deckRs).toContain("fn deck_ids_playing(");

    // `deckId`, not `id` — the four `deck_update`-family writes above take `id`, and this is a
    // read in the other family. Camel-cased on the wire, because `deck.rs` renames.
    invoke.mockResolvedValue(["o1", "o2"]);
    expect(await ipc.deckPlayedKeys(4)).toEqual(["o1", "o2"]);
    expect(invoke).toHaveBeenCalledWith("deck_played_keys", { deckId: 4 });

    // `keys`, and the array is passed through untouched: sorting and deduping are the caller's
    // (`useDecksPlaying` does both), so a mirror that quietly reordered here would make the
    // hook's own guarantee unfalsifiable.
    invoke.mockResolvedValue([7, 9]);
    expect(await ipc.deckIdsPlaying(["o1", "o2"])).toEqual([7, 9]);
    expect(invoke).toHaveBeenCalledWith("deck_ids_playing", { keys: ["o1", "o2"] });

    // The empty set still travels as an explicit key rather than being dropped: Tauri fills
    // parameters by name and an absent one is a refusal, not a default — and the backend's
    // answer to no keys is `[]`, never every deck.
    invoke.mockResolvedValue([]);
    expect(await ipc.deckIdsPlaying([])).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("deck_ids_playing", { keys: [] });
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

    // The third deck kind, born virtual — `decks.virtual_only`, schema v40. Pinned here for
    // the reason the whole case exists: serde fills a field it cannot find with that field's
    // default, so `virtualOnly` misspelt is not a type error but a deck born tracking a
    // collection the reader said it should not.
    await ipc.deckCreate({ name: "Arena Standard", formatKey: "standard", virtualOnly: true });
    expect(invoke).toHaveBeenCalledWith("deck_create", {
      deck: { name: "Arena Standard", formatKey: "standard", virtualOnly: true },
    });

    await ipc.deckUpdate(4, { archived: true });
    expect(invoke).toHaveBeenCalledWith("deck_update", { id: 4, patch: { archived: true } });

    // **Both kind columns on one patch, and that is the shape rather than an accident.**
    // `deckKindPatch` in `features/decks/deckKind.ts` always names the pair, because naming
    // only the column that changed would leave the other standing and spell the one
    // combination — theory *and* virtual — that neither side allows. Rust writes the pair
    // defensively as well; this pins that the near side sends it that way in the first place.
    await ipc.deckUpdate(4, { theoryEnabled: false, virtualOnly: true });
    expect(invoke).toHaveBeenCalledWith("deck_update", {
      id: 4,
      patch: { theoryEnabled: false, virtualOnly: true },
    });

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
    // **No destination named, so nothing about the folder is sent** — which is what every call
    // site that predates issue #437 means and what the root has always been. `folderId` is left
    // off this expectation deliberately rather than written as `undefined`: `toHaveBeenCalledWith`
    // compares like `toEqual`, so the two are the same object to it either way, and the case
    // below is where that absence is read off the call and asserted.
    expect(invoke).toHaveBeenCalledWith("deck_missing_to_wishlist", { deckId: 4 });
    // How many wishes were *touched*, not how many copies were added — clicking twice raises
    // one line rather than making two, which is `add_wish`'s fold.
    expect(wishes).toBe(2);
  });

  /**
   * The quick add's two commands, and the crate is read for both names.
   *
   * **`invoke` matches by name and nothing in this build type-checks either half**, which is the
   * ordinary reason; what makes this pair worth its own case is that the two are one press split
   * across a read and a write, and the write's argument list is the longest in this file. Six
   * parameters, two of which are nullable and one of which is a bare `string` — so a payload
   * that spelled `wishId` `wish_id`, or sent `deckId` where the read wants none, is a
   * deserialization failure with no type error anywhere and a menu row that simply never works.
   *
   * **`condition` is `MENU_CONDITION`'s `"NM"` and travels as an explicit argument**, never as a
   * default the backend fills in: a collection row's identity includes its condition, so
   * something has to choose, and the menu says so where the choice is made.
   *
   * **`finish` is the deck row's** — `null` is the regular copy, which the crate translates to
   * `nonfoil` on its own side — and it is sent on **both** commands, because the wish predicate
   * matches on it too. `null` is a value the wire carries rather than an omission: an absent
   * parameter is a refusal, not a default.
   *
   * **`wishId: null` is the whole of "record these copies and clear nothing"**, and it is the
   * commonest press of the three menu rows, so it is asserted beside the named-wish form.
   */
  it("sends both quick-add commands under the names the crate declares", async () => {
    // Not `toContain` on the source alone: a pass has to mean "the crate spells it", never
    // "the crate was never read".
    expect(deckQuickAddRs.length).toBeGreaterThan(1_000);
    expect(deckQuickAddRs).toContain("fn deck_quick_add_wishes(");
    expect(deckQuickAddRs).toContain("fn deck_quick_add_to_collection(");

    // The read names **no deck**: a wish is a fact about a shopping list and a printing, and
    // which deck the press came from decides only where the copies are filed.
    invoke.mockResolvedValue([{ id: 7, quantity: 3, folderId: null, folderName: null }]);
    const wishes = await ipc.deckQuickAddWishes("p1", null);
    expect(invoke).toHaveBeenCalledWith("deck_quick_add_wishes", { cardId: "p1", finish: null });
    expect(wishes).toEqual([{ id: 7, quantity: 3, folderId: null, folderName: null }]);

    await ipc.deckQuickAddWishes("p1", "foil");
    expect(invoke).toHaveBeenLastCalledWith("deck_quick_add_wishes", {
      cardId: "p1",
      finish: "foil",
    });

    // The write, and the answer is read back because it is what a sentence quotes — the copies
    // recorded, the row they folded into, and what came off the wish.
    invoke.mockResolvedValue({ copies: 4, entryId: 44, wishCopies: 3 });
    const outcome = await ipc.deckQuickAddToCollection(4, "p1", null, "NM", 4, 7);
    expect(invoke).toHaveBeenLastCalledWith("deck_quick_add_to_collection", {
      deckId: 4,
      cardId: "p1",
      finish: null,
      condition: "NM",
      quantity: 4,
      wishId: 7,
    });
    expect(outcome).toEqual({ copies: 4, entryId: 44, wishCopies: 3 });

    // No wish named — the plain `Quick add N copies` row — and `null` still travels.
    await ipc.deckQuickAddToCollection(4, "p1", "etched", "NM", 1, null);
    expect(invoke).toHaveBeenLastCalledWith("deck_quick_add_to_collection", {
      deckId: 4,
      cardId: "p1",
      finish: "etched",
      condition: "NM",
      quantity: 1,
      wishId: null,
    });
  });

  /**
   * The deck write that is **not** a `DeckPatch`, and the reason it cannot be one.
   *
   * `deck_update` writes every column with `coalesce(?n, column)`, which reads a bound NULL as
   * "leave it" — so a patch has no way to say *clear this*. Filing a deck back at the **root**
   * of the folder tree is exactly that sentence, which is why `deck_set_folder` exists and
   * takes an `Option<i64>` of its own where `null` means the root.
   *
   * **It was two, and the other was `deck_set_cover_image`** — a cover could be a file on disk
   * rather than a column, so it arrived as the path the picker answered. That command is gone
   * with the whole custom-cover feature; a cover is `DeckPatch.coverCardId`, a string, and this
   * module has no second exception left.
   */
  it("sends the deck write a patch cannot express under its own name", async () => {
    invoke.mockResolvedValue({ id: 4 });

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
   * The two clears, and the **name** is what is really under test on the second one.
   *
   * They are the same write at two grains — `deck_category_clear` empties one pile of one
   * variant, `deck_clear` empties one variant of the whole deck — so the payloads differ by
   * exactly one key, which is the shape a copy-paste gets wrong without a type error anywhere:
   * a `categoryId` sent to `deck_clear` is a parameter Tauri cannot fill, and a `deck_clear`
   * that dropped `variant` would empty whichever list the backend defaulted to. Both answer a
   * **number of copies** rather than a row, and both are read back here for it — a mirror typed
   * `void` would throw away the figure the confirmation counted.
   *
   * **The crate is read for the wire name, because nothing else in this build compares the two
   * sides.** These are irreversible commands behind one confirmation each, and a name Rust does
   * not register is a runtime rejection with no type error and nothing on screen naming the
   * culprit — the same argument `reset.rs`'s four clears are pinned on, one module over. The
   * `includes` is deliberately crude: this is a name check, not a parse, and what it catches is
   * the whole class that has bitten this repo — a rename on either side, or the plural
   * `decks_clear` (the Settings danger zone's command, which empties *every* deck) reached for
   * by autocomplete.
   */
  it("sends both clears under the name its command declares, and the crate declares them", async () => {
    // Not `toContain` on the source alone: a pass has to mean "the crate spells it", never
    // "the crate was never read".
    expect(deckRs.length).toBeGreaterThan(1_000);
    expect(deckRs).toContain("fn deck_category_clear(");
    expect(deckRs).toContain("fn deck_clear(");

    invoke.mockResolvedValue(4);
    expect(await ipc.deckCategoryClear(4, 7, "live")).toBe(4);
    expect(invoke).toHaveBeenCalledWith("deck_category_clear", {
      deckId: 4,
      categoryId: 7,
      variant: "live",
    });

    // No `categoryId`, and `variant` is the whole of what says which list is emptied — the piles
    // themselves are untouched, so there is no id to name.
    invoke.mockResolvedValue(99);
    expect(await ipc.deckClear(4, "theory")).toBe(99);
    expect(invoke).toHaveBeenCalledWith("deck_clear", { deckId: 4, variant: "theory" });

    invoke.mockResolvedValue(0);
    expect(await ipc.deckClear(4, "live")).toBe(0);
    expect(invoke).toHaveBeenCalledWith("deck_clear", { deckId: 4, variant: "live" });
  });

  /**
   * The seven label commands, and the two that break the module's own pattern.
   *
   * `deck_label_all` takes **no deck id at all** — the palette is a property of the app's whole
   * history rather than of one deck — so an argument object here is a deserialization error,
   * `prewarm_collection`'s trap again. And `deck_card_set_label` is a *card* write wearing a
   * label command's name: it addresses the slot by the full grain, like every other card write,
   * and not by the label.
   */
  it("sends every label command under the name its command declares", async () => {
    invoke.mockResolvedValue([]);
    await ipc.deckLabelList(4, "live");
    expect(invoke).toHaveBeenCalledWith("deck_label_list", { deckId: 4, variant: "live" });

    invoke.mockResolvedValue({ id: 3 });
    await ipc.deckLabelCreate(4, "Cut candidate", "ember");
    expect(invoke).toHaveBeenCalledWith("deck_label_create", {
      deckId: 4,
      name: "Cut candidate",
      color: "ember",
    });

    // One command for the rename **and** the recolour, and both are required: there is no
    // patch shape here, so a caller changing one sends the other back unchanged. `deckId` is
    // where the reader was standing — the write itself is app-wide.
    await ipc.deckLabelUpdate(4, 3, "Cut", "moss");
    expect(invoke).toHaveBeenCalledWith("deck_label_update", {
      deckId: 4,
      id: 3,
      name: "Cut",
      color: "moss",
    });

    invoke.mockResolvedValue(undefined);
    await ipc.deckLabelDelete(4, 3);
    expect(invoke).toHaveBeenCalledWith("deck_label_delete", { deckId: 4, id: 3 });

    // The other destructive one, and the distinction the app-wide list needed: this takes the
    // label off one deck's one list and leaves the label standing.
    invoke.mockResolvedValue(2);
    expect(await ipc.deckLabelRemoveFromDeck(4, 3, "theory")).toBe(2);
    expect(invoke).toHaveBeenCalledWith("deck_label_remove_from_deck", {
      deckId: 4,
      labelId: 3,
      variant: "theory",
    });

    const every = [{ id: 3, name: "Cut candidate", color: "ember", cardCount: 9, deckCount: 2 }];
    invoke.mockResolvedValue(every);
    const palette = await ipc.deckLabelAll();
    expect(invoke).toHaveBeenCalledWith("deck_label_all");
    expect(palette).toEqual(every);

    invoke.mockResolvedValue(undefined);
    await ipc.deckCardSetLabel(4, "p1", 7, "live", null, 3);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_label", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      finish: null,
      labelId: 3,
    });

    // Unlabelling is the same command with `null`, not a second one — `deck_cards.label_id` is
    // a nullable column and clearing it is a write to it.
    await ipc.deckCardSetLabel(4, "p1", 7, "live", null, null);
    expect(invoke).toHaveBeenCalledWith("deck_card_set_label", {
      deckId: 4,
      cardId: "p1",
      categoryId: 7,
      variant: "live",
      finish: null,
      labelId: null,
    });

    // **Three of them take `deckId: number | null`, and `null` is Settings' Appearance panel.**
    // The label was never the deck's — a label has been one app-wide row since v21, and the deck
    // is only what the *side effects* need, its `updated_at` and its history row. So a call from
    // a page with no deck open sends `null` and writes neither. `list` and `removeFromDeck` above
    // are untouched, and have to be: those two really are about one deck's list.
    invoke.mockResolvedValue({ id: 5 });
    await ipc.deckLabelCreate(null, "Playtest", "moss");
    expect(invoke).toHaveBeenCalledWith("deck_label_create", {
      deckId: null,
      name: "Playtest",
      color: "moss",
    });

    await ipc.deckLabelUpdate(null, 5, "Playtesting", "ember");
    expect(invoke).toHaveBeenCalledWith("deck_label_update", {
      deckId: null,
      id: 5,
      name: "Playtesting",
      color: "ember",
    });

    invoke.mockResolvedValue(undefined);
    await ipc.deckLabelDelete(null, 5);
    expect(invoke).toHaveBeenCalledWith("deck_label_delete", { deckId: null, id: 5 });

    // The crate is read for the optionality rather than trusted — three separate declarations, so
    // a `deck_id: i64` surviving on any one of them is a runtime rejection from that one panel
    // with nothing red in either build. Sliced per command rather than counted across the file:
    // `deck_meta.rs` spells `deck_id: Option<i64>` on its plain helpers too, so a bare count of
    // the whole source would pass on the helpers alone.
    expect(deckMetaRs.length).toBeGreaterThan(1_000);
    for (const command of ["deck_label_create", "deck_label_update", "deck_label_delete"]) {
      const at = deckMetaRs.indexOf(`pub async fn ${command}(`);
      expect(at, `\`${command}\` is not declared in deck_meta.rs`).toBeGreaterThan(-1);
      const signature = deckMetaRs.slice(at, deckMetaRs.indexOf(")", at));
      expect(signature, `\`${command}\` still requires a deck`).toContain("deck_id: Option<i64>");
    }
  });

  /**
   * **Every argument `ipc.ts` sends is one the command declares — for the family where a missing
   * one is silent.**
   *
   * `deck_card_set_label` sent `finish` from the day the finish grain landed and the command
   * never declared it. **Tauri drops a payload field a command does not name**, so the writer
   * behind it was handed `None` and addressed the row on four terms of a five-term grain: every
   * foil and etched deck row answered "that card is not in this deck's category any more" for a
   * row the reader was looking straight at, and 148 of the 611 rows in the developer's own
   * database are one of those. It shipped, and it survived readings on both sides, because each
   * side is separately correct — the argument goes missing in the gap between them.
   *
   * Nothing else could have caught it. The type checker never sees the crate; `invoke` is typed
   * on its return, not its payload; and the Storybook fake matched on four fields too, so the
   * suite agreed with the bug. This is the only place the two spellings meet.
   *
   * **Scoped to the commands carrying a finish** rather than to all 131, because that is the
   * term whose absence is invisible: drop `deckId` and nothing works at all, drop `finish` and
   * three rows in four keep working. The expected list is read out of `ipc.ts` rather than
   * written down here, so this cannot pass by agreeing with itself.
   */
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  /** The keys of the object literal a command is invoked with. Shorthand only, which is what
   *  all three of these use — a `key: value` pair is read by its key just the same. */
  const payloadKeys = (src: string, command: string): string[] => {
    const marker = `"${command}", {`;
    const start = src.indexOf(marker);
    if (start === -1) return [];
    const open = start + marker.length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return src
      .slice(open + 1, end)
      .split(",")
      .map((part) => (part.split(":")[0] ?? "").trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  };

  /** The parameter names of a `#[tauri::command]`, which are one per line in this crate. */
  const commandParams = (src: string, fn: string): string[] => {
    const marker = `pub async fn ${fn}(`;
    const start = src.indexOf(marker);
    if (start === -1) return [];
    const open = start + marker.length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return [...src.slice(open + 1, end).matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? "");
  };

  const finishBearing: [command: string, rustSource: string][] = [
    ["deck_card_set_label", deckMetaRs],
    ["deck_set_card_finish", deckRs],
    ["deck_quick_add_wishes", deckQuickAddRs],
  ];

  it.each(finishBearing)("%s declares every argument ipc.ts sends it", (command, rustSource) => {
    const sent = payloadKeys(ipcSource, command).map(snake);
    const declared = commandParams(rustSource, command);

    // Not `toEqual` on the two lists: the *parsers* are what a green result has to be trusted
    // against, so a pass must never be able to mean "both found nothing". `state` is declared
    // and never sent, which is why this is containment rather than equality.
    expect(sent.length, `nothing parsed out of ipc.ts for \`${command}\``).toBeGreaterThan(1);
    expect(declared.length, `nothing parsed out of the crate for \`${command}\``).toBeGreaterThan(
      1,
    );
    expect(sent, `\`${command}\` sends no finish; this table is for the ones that do`).toContain(
      sent.find((k) => k.includes("finish")) ?? "finish",
    );

    for (const key of sent) {
      expect(declared, `\`${command}\` is sent \`${key}\` and does not declare it`).toContain(key);
    }
  });

  /**
   * **`combos_for_card` on the same fence, for the same reason one grain over** — added
   * 2026-09-08 with the search box.
   *
   * This is `deck_card_set_label`'s failure in a different family. The command gained a sixth
   * parameter, `search: Option<String>`, and the two sides spell it independently: Rust in the
   * signature, `ipc.ts` in the object literal. **Tauri drops a payload field a command does not
   * name**, so a crate that called it `query`, or `term`, or `name_search` — every one of which
   * reads perfectly at its own site — hands `card_combos` a `None` and answers the *unsearched*
   * page. Nothing goes wrong: the dialog gets combos, the pager pages, the counts add up. They
   * are simply the counts for a question the reader did not ask, and a search box that narrows
   * nothing is read as a UI bug for as long as it takes somebody to look at the crate.
   *
   * The suite cannot otherwise see it. `invoke` is typed on its return and not its payload, the
   * argument-naming case below sends `search` to a mock that would accept any key at all, and
   * the Storybook fake takes `CardCombosQuery` — the camelCase side — so it agrees with the
   * bug. This is the only place the two spellings meet.
   *
   * Containment rather than equality, `finishBearing`'s rule: `state` is declared and never
   * sent. The two length guards are what stop a parser that found nothing from reading as a
   * pass — a `pub async fn` this parser cannot see is a green test over an empty list.
   */
  it("combos_for_card declares every argument ipc.ts sends it, `search` included", () => {
    const sent = payloadKeys(ipcSource, "combos_for_card").map(snake);
    const declared = commandParams(combosRs, "combos_for_card");

    expect(sent, "nothing parsed out of ipc.ts for `combos_for_card`").toContain("oracle_id");
    expect(declared, "nothing parsed out of the crate for `combos_for_card`").toContain(
      "oracle_id",
    );
    // Named rather than left to the loop: the loop is only as strong as what `ipc.ts` happens to
    // send, so a wrapper that dropped `q.search` on the floor would make it vacuous — green on
    // both sides while the box narrows nothing.
    expect(sent, "`ipc.ts` sends `combos_for_card` no search").toContain("search");
    expect(declared, "the crate's `combos_for_card` declares no `search`").toContain("search");

    for (const key of sent) {
      expect(declared, `\`combos_for_card\` is sent \`${key}\` and does not declare it`).toContain(
        key,
      );
    }
  });

  /**
   * **`share_create` on the same fence, and it is the loudest member of this family yet.**
   *
   * Tauri camel-cases a command's parameters, so `folder_uid: Option<String>` is `folderUid` on
   * the wire — and a wrapper spelling it `folderId`, or `uid`, or the snake name sends a key the
   * command does not declare. **Tauri drops a payload field a command does not name**, so
   * `folder_uid` arrives `None`, and `None` is not an error here: it is *the whole collection*.
   * The press succeeds, the link works, and it publishes every card the reader owns instead of
   * the one binder they picked — a refusal would have been the kinder failure.
   *
   * The expected list is read out of `ipc.ts` rather than written down here, which is exactly
   * what the share `describe` further down cannot do: its expectations are hand-typed, so it
   * pins the two sides against a third opinion and this pins them against the crate.
   *
   * Containment rather than equality, `finishBearing`'s rule: `state` is declared and never
   * sent. Both length guards are what stop a parser that found nothing from reading as a pass.
   */
  it("share_create declares every argument ipc.ts sends it", () => {
    const sent = payloadKeys(ipcSource, "share_create").map(snake);
    const declared = commandParams(shareRs, "share_create");

    expect(sent, "nothing parsed out of ipc.ts for `share_create`").toContain("folder_uid");
    expect(declared, "nothing parsed out of the crate for `share_create`").toContain("folder_uid");
    // Named on its own as well as looped over: the loop is only as strong as what `ipc.ts`
    // happens to send, so a wrapper that dropped the owner's name on the floor would make it
    // vacuous — and spec §4.3 has the *second* device in a group publish under that name.
    expect(sent, "`ipc.ts` sends `share_create` no owner name").toContain("owner_name");
    expect(declared, "the crate's `share_create` declares no `owner_name`").toContain("owner_name");

    for (const key of sent) {
      expect(declared, `\`share_create\` is sent \`${key}\` and does not declare it`).toContain(
        key,
      );
    }
  });

  /**
   * **The two deck→wishlist pushes on the same fence, for the term that decides _where_** —
   * added 2026-09-09 with the destination folder (issue #437).
   *
   * `deck_card_set_label`'s failure again, in the family where it is quietest. Both commands
   * gained `folder_id: Option<i64>`, and the two sides spell it independently: Rust in the
   * signature, `ipc.ts` in the object literal. **Tauri drops a payload field a command does not
   * name**, so a crate that called it `folder`, or `dest_folder_id`, or `wishlist_folder` — each
   * of which reads perfectly at its own site — hands the writer a `None`. And `None` here is not
   * an error: it is **the root**. The press succeeds, the count is right, the wishes are real;
   * they are simply in a drawer the reader did not choose, and there is nothing for them to read
   * that as except a folder picker that does not work.
   *
   * Nothing else in the build compares the two spellings. `invoke` is typed on its return and
   * not its payload, the behavioural case further down sends `folderId` to a mock that would
   * accept any key at all, and the Storybook fake takes the camelCase side — so it agrees with
   * the bug.
   *
   * Containment rather than equality, `finishBearing`'s rule: `state` is declared and never
   * sent. Both length guards are what stop a parser that found nothing from reading as a pass —
   * and the source each command is looked up in is worth one line of care, because
   * **`deck_missing_to_wishlist` is declared in `deck.rs` and not in `deck_missing.rs`**, which
   * is a module about the pull's picks. Pointed at the wrong file this is a green test over an
   * empty list, which is the one way a fence lies.
   */
  const folderBearing: [command: string, rustSource: string][] = [
    ["deck_missing_to_wishlist", deckRs],
    ["deck_theory_missing_to_wishlist", deckTheoryRs],
  ];

  it.each(folderBearing)("%s declares the folder ipc.ts sends it", (command, rustSource) => {
    const sent = payloadKeys(ipcSource, command).map(snake);
    const declared = commandParams(rustSource, command);

    expect(sent.length, `nothing parsed out of ipc.ts for \`${command}\``).toBeGreaterThan(1);
    expect(declared.length, `nothing parsed out of the crate for \`${command}\``).toBeGreaterThan(
      1,
    );
    // Named as well as looped over: the loop is only as strong as what `ipc.ts` happens to send,
    // so a wrapper that took a `folderId` parameter and then dropped it on the floor would make
    // this vacuous — green on both sides while every press files at the root.
    expect(sent, `\`ipc.ts\` sends \`${command}\` no folder`).toContain("folder_id");
    expect(declared, `the crate's \`${command}\` declares no \`folder_id\``).toContain("folder_id");

    for (const key of sent) {
      expect(declared, `\`${command}\` is sent \`${key}\` and does not declare it`).toContain(key);
    }
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
   *
   * `deck_theory_slots` is the read the editor's tick is drawn from, and it takes the deck and
   * **nothing else** — nothing in it is priced, so there is no `marketplace` beside the id as
   * there is on the diff.
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

    /**
     * **`nameKey` is nullable and the annotation is the assertion.** The `null` below only
     * type-checks because {@link TheorySlot.nameKey} is `string | null`; a mirror that typed it
     * `string` — which is what the field looks like on every card whose printing is still in the
     * corpus — makes this line a build error, and would make `theoryNameKey` fold `undefined` on
     * exactly the orphan rows the loose tier exists to survive. Nothing else in the build
     * compares the two sides, so this and the crate line below are the whole fence.
     */
    const slots: TheorySlot[] = [
      { key: "sol-ring-c21|", nameKey: "Sol Ring", quantity: 1 },
      { key: "gone-from-corpus|foil", nameKey: null, quantity: 2 },
    ];
    invoke.mockResolvedValue(slots);
    const read = await ipc.deckTheorySlots(4);
    expect(invoke).toHaveBeenCalledWith("deck_theory_slots", { deckId: 4 });
    // Read back rather than only called: the mirror hands the answer through untouched, so an
    // orphan has to arrive as `null` and not as an absent key a consumer would read as
    // `undefined`.
    expect(read[0]?.nameKey).toBe("Sol Ring");
    expect(read[1]?.nameKey).toBeNull();
    // The crate is read for the shape rather than trusted — `deck_theory_diff`'s rule above.
    expect(deckTheoryRs.length).toBeGreaterThan(1_000);
    expect(deckTheoryRs).toContain("pub name_key: Option<String>,");

    invoke.mockResolvedValue(12);
    const copied = await ipc.deckTheoryCopyFromLive(4);
    expect(invoke).toHaveBeenCalledWith("deck_theory_copy_from_live", { deckId: 4 });
    expect(copied).toBe(12);

    invoke.mockResolvedValue(3);
    const wishes = await ipc.deckTheoryMissingToWishlist(4);
    // A **second** command rather than a variant argument on `deck_missing_to_wishlist`: that
    // one reads `live` and only `live`, and the two shopping lists are different questions.
    // Neither `only` nor `folderId` is written out here — both are absent, both compare equal to
    // an omitted key under `toEqual`, and the case below is where the absence is the assertion.
    expect(invoke).toHaveBeenCalledWith("deck_theory_missing_to_wishlist", { deckId: 4 });
    expect(wishes).toBe(3);
  });

  /**
   * **Where the two shopping lists file, which is a fourth thing the wire now has to carry** —
   * issue #437.
   *
   * Both commands wrote at the root and offered nothing else until 2026-09-09. The root is still
   * the default and still a destination a reader can pick; what is new is that they can point at
   * a wishlist folder instead, and the whole of that instruction is one key on the payload.
   *
   * **Both commands in one case on purpose.** The destination is a single feature spread across
   * two commands that answer different questions, and the failure a per-command case reads
   * straight past is the wrapper that grew the argument on the live side and not the theory side
   * — a folder picker that works from the deck's own footer and silently files at the root from
   * the plan's diff dialog.
   *
   * **The absence leg is what protects every existing call site**, and it cannot be written as an
   * expectation object. `toHaveBeenCalledWith` compares like `toEqual`, so an absent key and an
   * `undefined` one are the same object to it — which means the two destination assertions would
   * still pass if these wrappers invented a folder of their own. The payload is read off the call
   * for that, which is `cardPrintings`' rule one command family over.
   *
   * **`null` is asserted as itself, and the distinction is observable here where it is not on the
   * wire.** `toEqual` does *not* fold `null` into an absent key, so a wrapper that coerced
   * `folderId ?? undefined` goes red on the explicit-root leg. It should: Rust reads either
   * spelling as `None` and cannot tell them apart, but a **caller** can, because
   * {@link WishInput.folderId} and every folder-aware surface in this app hold a
   * `number | null` — so forwarding that value unchanged has to be legal, and a seam that
   * quietly rewrote it would make the root reachable only by leaving an argument out. What this
   * pins is the honesty of the seam, not a difference the backend can see.
   */
  it("files both deck shopping lists where it is told, and at the root when it is not", async () => {
    invoke.mockResolvedValue(2);
    await ipc.deckMissingToWishlist(4, 12);
    expect(invoke).toHaveBeenCalledWith("deck_missing_to_wishlist", { deckId: 4, folderId: 12 });

    // The two narrowings are independent: `only` picks the rows, `folderId` picks the drawer.
    invoke.mockResolvedValue(3);
    await ipc.deckTheoryMissingToWishlist(4, ["ring-c21|"], 12);
    expect(invoke).toHaveBeenCalledWith("deck_theory_missing_to_wishlist", {
      deckId: 4,
      only: ["ring-c21|"],
      folderId: 12,
    });

    // The footer's untouched press with a folder picked — the whole difference, into one folder.
    // A positional third argument means the second has to be spellable as "no narrowing", so the
    // `undefined` here is the call shape a dialog with nothing ticked actually makes.
    invoke.mockResolvedValue(9);
    await ipc.deckTheoryMissingToWishlist(4, undefined, 12);
    expect(invoke).toHaveBeenCalledWith("deck_theory_missing_to_wishlist", {
      deckId: 4,
      only: undefined,
      folderId: 12,
    });

    // The explicit root: a destination the reader chose from a menu, forwarded as the `null` the
    // menu is holding rather than translated into an omission on the way past.
    invoke.mockResolvedValue(1);
    await ipc.deckMissingToWishlist(4, null);
    expect(invoke).toHaveBeenCalledWith("deck_missing_to_wishlist", { deckId: 4, folderId: null });
    await ipc.deckTheoryMissingToWishlist(4, undefined, null);
    expect(invoke).toHaveBeenCalledWith("deck_theory_missing_to_wishlist", {
      deckId: 4,
      only: undefined,
      folderId: null,
    });

    // And the omission, read off the call rather than compared against an object: a caller from
    // before the folder existed sends no folder at all, and JSON drops an `undefined` key, so
    // this is also the assertion that nothing new reaches Rust for those callers.
    await ipc.deckMissingToWishlist(4);
    const live = invoke.mock.lastCall?.[1] as { deckId?: number; folderId?: number | null };
    expect(live.deckId, "the deck stopped being sent, so this proves nothing").toBe(4);
    expect(live.folderId).toBeUndefined();

    await ipc.deckTheoryMissingToWishlist(4);
    const theory = invoke.mock.lastCall?.[1] as {
      deckId?: number;
      only?: readonly string[];
      folderId?: number | null;
    };
    expect(theory.deckId, "the deck stopped being sent, so this proves nothing").toBe(4);
    expect(theory.only).toBeUndefined();
    expect(theory.folderId).toBeUndefined();
  });

  /**
   * The four token commands, and the one argument in this whole file that is **renamed on the
   * wire**.
   *
   * `deck_token_set`'s state word cannot be spelled `state` in Rust: `state` is already the
   * managed `tauri::State` every command takes, so the parameter is `token_state` and the key
   * the payload carries is `tokenState`. That rename lives in exactly one place — this
   * wrapper — and nothing type-checks it: callers on this side pass `{ state }` because that
   * is what the column is called, and a mirror that forwarded the word unchanged would hand
   * `deck_token_set` a field it declares no parameter for. Tauri drops it, the command reads
   * `None`, and a dismissal silently becomes "no change" with no error anywhere.
   *
   * The other three are pinned for the ordinary reason. `deck_tokens` is a read scoped by
   * `variant`, like every deck read beside it. `deck_token_clear` addresses the override by
   * the grain (`deckId`, `oracleId`); `deck_token_add` addresses a **printing** (`deckId`,
   * `cardId`) because a hand-added token is picked out of a printings grid and Rust resolves
   * the oracle id from it. Those two ids are one word apart and interchangeable to a
   * type checker, so the swap is a runtime no-op the suite would otherwise never see.
   */
  it("names the deck token command arguments the way Rust spells them", async () => {
    const row: DeckTokenRow = {
      oracleId: "o-1",
      name: "Treasure",
      typeLine: "Token Artifact — Treasure",
      layout: "token",
      // The four disambiguation fields, and a `null` in each is a real answer: an artifact
      // token has no power or toughness and Treasure is colourless. They are typed here rather
      // than left off, because 104 token names in the corpus name more than one `oracle_id`
      // and a mirror that dropped these would draw them as one tile.
      power: null,
      toughness: null,
      colors: "",
      oracleText: "{T}, Sacrifice this artifact: Add one mana of any color.",
      defaultCardId: "c-default",
      sources: [{ cardId: "d-1", name: "Smothering Tithe" }],
      derived: true,
      cardId: null,
      quantity: null,
      state: null,
    };
    invoke.mockResolvedValue([row]);

    // Read back rather than assumed: the DTO reaches this side already camelCased by serde and
    // the wrapper transforms nothing, so a mirror that renamed or dropped a field here would
    // be the only thing standing between the crate and every caller. The annotation above is
    // half the assertion — a field this side spells differently is a compile error here and
    // `undefined` everywhere else.
    expect(await ipc.deckTokens(7, "live")).toEqual([row]);
    expect(invoke).toHaveBeenCalledWith("deck_tokens", { deckId: 7, variant: "live" });

    invoke.mockResolvedValue(undefined);
    await ipc.deckTokenSet(7, "o-1", { cardId: "c-9", quantity: 4, state: "auto" });
    expect(invoke).toHaveBeenLastCalledWith("deck_token_set", {
      deckId: 7,
      oracleId: "o-1",
      cardId: "c-9",
      quantity: 4,
      tokenState: "auto",
    });

    // All five keys travel on every call, the `null`s included — Tauri fills parameters by
    // name and an absent one is a refusal rather than a default, which is the same rule
    // `deck_add_card`'s two category keys are written to.
    await ipc.deckTokenSet(7, "o-1", { quantity: 2 });
    expect(invoke).toHaveBeenLastCalledWith("deck_token_set", {
      deckId: 7,
      oracleId: "o-1",
      cardId: null,
      quantity: 2,
      tokenState: null,
    });

    // A quantity of **zero** is a number the reader chose, not an absent one: `?? null` and
    // never `|| null`, or stepping a token down to nothing would travel as "leave it alone"
    // and the tile would spring back to what it was.
    await ipc.deckTokenSet(7, "o-1", { quantity: 0, state: "hidden" });
    expect(invoke).toHaveBeenLastCalledWith("deck_token_set", {
      deckId: 7,
      oracleId: "o-1",
      cardId: null,
      quantity: 0,
      tokenState: "hidden",
    });

    await ipc.deckTokenClear(7, "o-1");
    expect(invoke).toHaveBeenLastCalledWith("deck_token_clear", { deckId: 7, oracleId: "o-1" });

    await ipc.deckTokenAdd(7, "c-9");
    expect(invoke).toHaveBeenLastCalledWith("deck_token_add", { deckId: 7, cardId: "c-9" });
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
   * Three of the combo feed's five commands, and **the id name is the trap** — the one this file
   * exists for. The fourth, `combos_clear`, is the case below: it carries nothing at all, which
   * is a different trap and gets a different assertion. The fifth is `combos_for_card`, two cases
   * below, whose name is this one's with a letter taken off — so the two are pinned apart there
   * as well as pinned individually here.
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
   * The fourth combo command, whose whole contract is that it carries **nothing**.
   *
   * `combos_clear` declares no parameters, so this is `prewarm_collection`'s trap and
   * `combos_status`' assertion one command over: Tauri deserializes the argument object into the
   * command's parameters, and a command with none refuses an object it never declared rather
   * than ignoring it. `invoke("combos_clear", {})` is therefore a rejection with no type error
   * anywhere on this side — and the press it breaks is the pair, so the tables would be left
   * standing and the forced refresh after them would find nothing to do.
   *
   * The answer read back is the never-ingested {@link ComboStatus} — two zeros, three `null`s
   * and `stale: true` — which is the same shape `combos_status` gives on a database that has
   * never fetched the file, and it is checked field by field for that case's reason: one field
   * spelled `fetched_at` here is `undefined` with no type error, and `undefined` reads as
   * "never ingested" whether or not the clear actually ran.
   */
  it("sends `combos_clear` under its own name, with no arguments object at all", async () => {
    const cleared = {
      combos: 0,
      cards: 0,
      stamp: null,
      fetchedAt: null,
      checkedAt: null,
      stale: true,
    };
    invoke.mockResolvedValue(cleared);

    const after = await ipc.combosClear();

    // One argument and not two. `toHaveBeenCalledWith` is exact about arity, which is the whole
    // of what this line is for: an `{}` sent beside the name would satisfy every other
    // assertion in this case and fail only in the running app.
    expect(invoke).toHaveBeenCalledWith("combos_clear");
    expect(after).toEqual(cleared);
    // Zeros for the counts and `null` for all three stamps, which is the distinction
    // `ComboStatus.fetchedAt` exists to keep: "never fetched" is not "fetched nothing", and this
    // is the one command that puts a database back in the first of those on purpose.
    expect(after.combos).toBe(0);
    expect(after.cards).toBe(0);
    expect(after.stamp).toBeNull();
    expect(after.fetchedAt).toBeNull();
    expect(after.checkedAt).toBeNull();
    expect(after.stale).toBe(true);

    // The press is a pair and the order is load-bearing: the forced refresh after the clear is
    // what re-downloads, and it downloads rather than being told 304 because
    // `combos::conditional_etag` replays the stored ETag only when there are rows behind it.
    await ipc.combosRefresh(true);
    expect(invoke.mock.calls).toEqual([["combos_clear"], ["combos_refresh", { force: true }]]);
  });

  /**
   * The fifth combo command, whose **name is the fourth one's with a letter taken off**.
   *
   * `combos_for_card` and `combos_for_cards` are opposite questions over one table — which
   * combos a pile of printings fully *contains* (the deck advisory) against what one card is
   * *part of* — and a wrapper that routed either to the other's name would be answered rather
   * than rejected. That is the worst shape a drift can take here: the deck read handed an oracle
   * id in place of `card_ids` deserialises nothing and the dialog draws an empty list, which is
   * exactly what a card in no combo looks like. So the two names are asserted together, in one
   * `invoke.mock.calls` comparison, rather than each on its own.
   *
   * **`cardCount: null` is the case a number alone would pass over.** The Rust parameter is
   * `Option<i64>`, `null` is how `None` is spelled on the wire, and Tauri fills parameters *by
   * name* — so a mapper that dropped the key when there was no size filter (`...(size && {
   * cardCount: size })` is the shape that writes itself) would be a rejection on every
   * unfiltered read, which is the read the dialog opens on. A test that only ever sent a number
   * would be green the whole time.
   *
   * **`search: null` is that trap a second time and it is the newer of the two** (2026-09-08).
   * `Option<String>` this time, and the shape that writes itself is worse than `cardCount`'s
   * because it *reads* correctly: `...(term && { search: term })` folds the empty box away, which
   * is exactly the fold the key helper performs one file over — and here it produces an object
   * Tauri refuses on every unsearched read, i.e. on the read the dialog opens on and returns to
   * every time the reader clears the box. So the assertion below is on the **key set**, not on
   * the object: `toHaveBeenCalledWith` compares the way `toEqual` does and cannot tell a key
   * holding `undefined` from a key that is not there.
   *
   * `ownedOnly: false` carries the same trap one field over and is `combos_refresh`'s `force`
   * argument again: an absent boolean is a refusal, not a default.
   *
   * **A third read sends a real term**, because the two failures are opposite: a wrapper that
   * hard-coded `search: null` would satisfy every assertion the unsearched case makes, and the
   * symptom — a search box that narrows nothing while the caption keeps changing — is a bug in
   * the dialog everywhere except where it is.
   *
   * The answer is read back through a typed local rather than asserted as an opaque blob,
   * because that is the half `tsc` can see: every field named below has to exist on
   * {@link CardCombosPage}, so a mirror spelling `owned_total` or `by_card_count` the column's
   * way fails the build rather than reaching a caption as `undefined`.
   */
  it("sends `combos_for_card` with `search` and `cardCount` null as explicit keys", async () => {
    const page = {
      total: 41,
      matching: 12,
      ownedTotal: 3,
      byCardCount: [
        { cards: 2, combos: 12 },
        { cards: 3, combos: 29 },
      ],
      combos: [
        {
          id: "1957-4050-7918--204",
          bracketTag: "R",
          cardCount: 2,
          templateCount: 0,
          identity: "UB",
          produces: "Win the game",
          description: "1. Cast Demonic Consultation naming a card not in your deck.",
          easyPrerequisites: "All permanents are untapped.",
          notablePrerequisites: "Thassa's Oracle is on the battlefield.",
          manaNeeded: "{U}{B}",
          popularity: 9_001,
          pieces: [
            {
              oracleId: "oracle-thassa",
              name: "Thassa's Oracle",
              quantity: 1,
              mustBeCommander: false,
              cardId: "printing-thassa",
              imageUris: { display: "https://cards.scryfall.io/large/front/a/b/ab.jpg?1" },
              owned: 2,
            },
            {
              oracleId: "oracle-consultation",
              name: "Demonic Consultation",
              quantity: 1,
              mustBeCommander: false,
              // A piece the corpus has never synced: no printing to address, no picture, and
              // the feed's own spelling is the whole of what the row can draw.
              cardId: null,
              imageUris: null,
              owned: 0,
            },
          ],
        },
      ],
    };
    invoke.mockResolvedValue(page);

    // The unfiltered read the dialog opens on — an empty search, a size filter of `null` and the
    // owned box off.
    const opened: CardCombosPage = await ipc.combosForCard({
      oracleId: "oracle-thassa",
      search: null,
      cardCount: null,
      ownedOnly: false,
      limit: 20,
      offset: 0,
    });

    expect(invoke).toHaveBeenCalledWith("combos_for_card", {
      oracleId: "oracle-thassa",
      search: null,
      cardCount: null,
      ownedOnly: false,
      limit: 20,
      offset: 0,
    });
    // Said again, and not as ceremony: `toHaveBeenCalledWith` compares the way `toEqual` does,
    // which treats a key holding `undefined` as a key that is not there. A mapper writing
    // `cardCount: size ?? undefined` — or `...(term && { search: term })`, which is the shape
    // that writes itself for a search box — would therefore satisfy the assertion above while
    // sending an object Tauri refuses. These lines are about the keys *existing* and about them
    // holding `null` rather than `undefined`, which is the distinction the wire actually has.
    const sent = invoke.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "cardCount",
      "limit",
      "offset",
      "oracleId",
      "ownedOnly",
      "search",
    ]);
    expect(sent.cardCount).toBeNull();
    expect(sent.search).toBeNull();

    // Read back through the typed local: the three totals are three different questions —
    // `total` is the card's whole match set, `matching` is what the pager pages through, and
    // `ownedTotal` is a share of `total` and never of `matching`.
    expect(opened.total).toBe(41);
    expect(opened.matching).toBe(12);
    expect(opened.ownedTotal).toBe(3);
    // The census is over the **searched** set — which on this read is the whole set, because
    // nothing was searched — so its buckets sum past `matching` rather than to it. A bucket list
    // that agreed with the filtered count would be the client-side filter this key exists to
    // prevent, arriving through the back door. (Under a term the sum tracks the searched set
    // instead, and it is the *facets* that follow the subject: see `CardCombosPage` in `ipc.ts`.)
    expect(opened.byCardCount.map((b) => b.cards)).toEqual([2, 3]);
    expect(opened.byCardCount.reduce((n, b) => n + b.combos, 0)).toBe(41);
    // The piece fields nothing else in this file names. `mustBeCommander` is the column the
    // ingest has always stored and no shape carried until now, and `owned` is a count across
    // every printing and finish — `0` is an answer, so a mirror dropping it would read as
    // "owns none" on a card the reader has four of, with nothing red anywhere.
    const [thassa, consultation] = opened.combos[0].pieces;
    expect(thassa.mustBeCommander).toBe(false);
    expect(thassa.owned).toBe(2);
    expect(thassa.cardId).toBe("printing-thassa");
    // The unsynced piece keeps its name and loses everything a printing would have given it.
    expect(consultation.cardId).toBeNull();
    expect(consultation.name).toBe("Demonic Consultation");
    expect(consultation.imageUris).toBeNull();

    // A narrowed read: the size comes from a bucket and the owned box is on. Still no term, so
    // `search` has to travel as `null` here too rather than being dropped once something else is
    // set — a mapper spreading only the fields that are "on" would pass the first assertion and
    // fail this one.
    invoke.mockResolvedValue({ ...page, matching: 12, combos: [] });
    await ipc.combosForCard({
      oracleId: "oracle-thassa",
      search: null,
      cardCount: 2,
      ownedOnly: true,
      limit: 20,
      offset: 20,
    });
    expect(invoke).toHaveBeenLastCalledWith("combos_for_card", {
      oracleId: "oracle-thassa",
      search: null,
      cardCount: 2,
      ownedOnly: true,
      limit: 20,
      offset: 20,
    });

    // A searched read — the opposite failure to the two above. A wrapper hard-coding
    // `search: null`, or dropping `q.search` on the floor, satisfies every assertion so far and
    // ships a search box that narrows nothing; only a call carrying a real term can see it.
    // The term is a substring and is sent **as typed**: no trimming, no lower-casing, no `%`
    // wrapping. Case-insensitivity and the substring match are the backend's, and a wrapper that
    // pre-cooked the string would be doing half of a job the SQL does the whole of.
    invoke.mockResolvedValue({ ...page, matching: 1, ownedTotal: 1, combos: [] });
    await ipc.combosForCard({
      oracleId: "oracle-thassa",
      search: "Thassa",
      cardCount: null,
      ownedOnly: false,
      limit: 20,
      offset: 0,
    });
    expect(invoke).toHaveBeenLastCalledWith("combos_for_card", {
      oracleId: "oracle-thassa",
      search: "Thassa",
      cardCount: null,
      ownedOnly: false,
      limit: 20,
      offset: 0,
    });
    const searched = invoke.mock.calls[2][1] as Record<string, unknown>;
    expect(searched.search).toBe("Thassa");
    // And `cardCount` is still an explicit `null` beside it: the two `Option`s are independent,
    // so a term must not smuggle a size away.
    expect(Object.keys(searched)).toContain("cardCount");
    expect(searched.cardCount).toBeNull();

    // **The two reads are pinned apart, not just each pinned.** One character between the two
    // command names, and a wrapper sending either under the other's would be answered — the
    // wrong question, correctly, with an empty list at the end of it.
    invoke.mockResolvedValue([]);
    await ipc.combosForCards(["p1"]);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      "combos_for_card",
      "combos_for_card",
      "combos_for_card",
      "combos_for_cards",
    ]);
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

  /**
   * The decks page's folder tree — the **first stored preference in this file that carries a
   * struct**, and the settings write with the most ways to get the wire wrong.
   *
   * Three of them, none caught by either compiler. `set_deck_folder_pane(width, collapsed)` takes
   * **two** arguments where most of this family takes one, so a wrapper that reached for the
   * neighbour's shape and sent `{ pane: … }` — the shape the *read* answers in, and therefore the
   * plausible mistake — is a parameter Tauri cannot fill and a runtime rejection. A wrapper that
   * spelled the second argument as the thing it is about rather than as the thing it is
   * (`folded`, `open`, `railed`) is the same rejection, silently, on a press whose whole contract
   * is that a refusal is *not* surfaced — see `useFolderPane`, which swallows it. And
   * `deck_folder_pane` takes **no arguments at all**, which is `prewarm_collection`'s trap: an
   * argument object sent to a command that declares only the managed state is a deserialization
   * error and not a type error.
   *
   * The crate is read for both parameter names rather than trusted, and read by *name* rather
   * than by type: how wide a column is could honestly be stored as any of several numbers, and a
   * fence that pinned `i64` would go red for a change that broke nothing.
   */
  it("reads the folder pane with no arguments and writes both of its fields by name", async () => {
    // A pass must never be able to mean "the crate was never read".
    expect(deckpaneRs.length).toBeGreaterThan(1_000);

    const stored = { width: 288, collapsed: true };
    invoke.mockResolvedValue(stored);
    const pane = await ipc.deckFolderPane();
    expect(invoke).toHaveBeenCalledWith("deck_folder_pane");
    expect(pane).toEqual(stored);
    expect(deckpaneRs).toContain("fn deck_folder_pane(");

    invoke.mockResolvedValue(undefined);
    await ipc.setDeckFolderPane(288, true);
    expect(invoke).toHaveBeenCalledWith("set_deck_folder_pane", { width: 288, collapsed: true });
    expect(deckpaneRs).toMatch(/fn set_deck_folder_pane\([^)]*\bwidth\s*:/s);
    expect(deckpaneRs).toMatch(/fn set_deck_folder_pane\([^)]*\bcollapsed\s*:\s*bool/s);

    // **`null` is an answer and not a missing field.** It is what the row says on a database
    // nobody has dragged, and it has to reach this side as itself — a mirror that typed `width`
    // as a bare `number` would make `?? DEFAULT_FOLDER_TREE_WIDTH_PX` unreachable code on one
    // side of the wire and a `null` width on the other.
    invoke.mockResolvedValue({ width: null, collapsed: false });
    expect(await ipc.deckFolderPane()).toEqual({ width: null, collapsed: false });
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

  /**
   * **Two call shapes for one command, and this is the only pin either of them has.**
   *
   * A camera frame has no fields to name, so on desktop it is Tauri's raw byte body with the
   * detector options riding in a header — and on Android Tauri carries no raw bytes at all
   * ("on all platforms except Android", its own doc on `Request`), so the same command takes
   * `{ jpeg, options }` as ordinary named arguments. Nothing type-checks either half: the
   * desktop leg's header *name* is a string on both sides, and the Android leg's argument names
   * are matched by `invoke` at run time. A misspelling on either is a scanner that reports
   * "no card" for every frame on exactly one of the two platforms.
   */
  it("scanner_frame sends the frame as bytes with its options in a header on desktop", async () => {
    const jpeg = new Uint8Array([1, 2, 3]);
    await ipc.scannerFrame(jpeg, DEFAULT_SCANNER_OPTIONS);
    expect(invoke).toHaveBeenCalledWith("scanner_frame", jpeg, {
      headers: { "x-scanner-options": JSON.stringify(DEFAULT_SCANNER_OPTIONS) },
    });
  });

  it("scanner_frame sends the frame as base64 arguments on Android", async () => {
    vi.mocked(isAndroid).mockReturnValueOnce(true);
    await ipc.scannerFrame(new Uint8Array([1, 2, 3]), DEFAULT_SCANNER_OPTIONS);
    expect(invoke).toHaveBeenCalledWith("scanner_frame", {
      jpeg: "AQID",
      options: DEFAULT_SCANNER_OPTIONS,
    });
  });

  it("scanner_capture carries the sidecar the same two ways", async () => {
    const sidecar = { expected: "Plains", reported: "", confidence: "", votes: "8.0", distance: "74" };
    await ipc.scannerCapture(new Uint8Array([9]), sidecar);
    expect(invoke).toHaveBeenCalledWith("scanner_capture", new Uint8Array([9]), {
      headers: { "x-scanner-capture": JSON.stringify(sidecar) },
    });
    vi.mocked(isAndroid).mockReturnValueOnce(true);
    await ipc.scannerCapture(new Uint8Array([9]), sidecar);
    expect(invoke).toHaveBeenCalledWith("scanner_capture", { jpeg: "CQ==", sidecar });
  });

  /**
   * **A non-ASCII card name has to survive the header, and `JSON.stringify` alone does not get
   * it there.** Three layers disagree about what a header value may contain: `JSON.stringify`
   * leaves `Æ` as itself, a browser sends 0x80–0xFF as Latin-1 and throws a `TypeError` above
   * that, and Rust's `HeaderValue::to_str` refuses anything outside visible ASCII. So a capture
   * of `Æther Vial` either kills the call in the page or arrives unreadable — and the cards this
   * would refuse are exactly the ones whose names are worth filing correctly.
   *
   * Three assertions, and the first is what ties the other two to the wrapper: the exact string
   * pins what `scannerCapture` produced, so the ASCII sweep and the round-trip are about the
   * value that actually goes on the wire rather than about a constant this test wrote.
   */
  it("escapes a non-ASCII card name into the capture header, losslessly", async () => {
    const sidecar = {
      expected: "Æther Vial",
      reported: "Jötun Grunt",
      confidence: "0.91",
      votes: "8.0",
      distance: "74",
    };
    const header =
      '{"expected":"\\u00c6ther Vial","reported":"J\\u00f6tun Grunt","confidence":"0.91","votes":"8.0","distance":"74"}';

    await ipc.scannerCapture(new Uint8Array([9]), sidecar);

    expect(invoke).toHaveBeenCalledWith("scanner_capture", new Uint8Array([9]), {
      headers: { "x-scanner-capture": header },
    });
    // Visible ASCII only — the range `HeaderValue::to_str` accepts and the one a browser will
    // put on the wire without reinterpreting a byte.
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    // Still the same JSON: escaping is a spelling, not a lossy transport encoding, so the far
    // end's `serde_json` reads back the characters the reader saw.
    expect(JSON.parse(header)).toEqual(sidecar);
  });

  it("scanner_status and scanner_reset take nothing", async () => {
    await ipc.scannerStatus();
    expect(invoke).toHaveBeenCalledWith("scanner_status");
    await ipc.scannerReset();
    expect(invoke).toHaveBeenCalledWith("scanner_reset");
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
 * The collection's eight folder commands.
 *
 * **Every one of them is a name and a set of argument spellings that nothing type-checks.**
 * `invoke` matches by name against the Rust parameter list, and `collection_folders.rs` renames
 * to camelCase — so a wrapper reaching for a plausible `collection_folder_set` or spelling
 * `parent_id` is a runtime rejection, or worse a bound `None` that files at the root, with no
 * type error anywhere. The eight names below are eight of the `collection_folders::` entries in
 * `desktop.rs`'s `generate_handler!`, and the `null`s are load-bearing: `null` is how a folder is
 * made at the top level, moved back out of one, and how a card is filed back at the root of the
 * collection.
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
   * The eighth, and the newest — setting a drawer aside.
   *
   * **`collection_folder_set_locked`, not the `collection_folder_set` this family's own doc names
   * as the plausible wrong guess**, and `locked` is sent on both presses rather than one: it is a
   * flag the caller states, never a toggle the backend works out, so the write is idempotent and
   * two surfaces pressing at once cannot leave the folder in whichever state the second press
   * flipped it to.
   */
  it("spells the lock write and sends the flag both ways round", async () => {
    invoke.mockResolvedValue({
      id: 2,
      parentId: null,
      name: "Binder",
      kind: "user",
      deckId: null,
      sortOrder: 0,
      locked: true,
    });

    await ipc.collectionFolderSetLocked(2, true);
    expect(invoke).toHaveBeenCalledWith("collection_folder_set_locked", { id: 2, locked: true });

    // `false` is a value the wire carries, not an omission — an unlock has to reach the column.
    await ipc.collectionFolderSetLocked(2, false);
    expect(invoke).toHaveBeenLastCalledWith("collection_folder_set_locked", {
      id: 2,
      locked: false,
    });
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
 * The five share commands — publishing one of those folders read-only.
 *
 * **`invoke` matches by name**, and Tauri camel-cases a command's parameters — so a wrapper
 * spelling `folder_uid` binds nothing, the command is handed `None`, and `None` is not a
 * rejection here: it is **the whole collection**. That is the failure this block exists for, and
 * it is worse than an error — a publish that succeeds and shares more than the reader asked for.
 *
 * These expectations are hand-typed, so they pin the two sides against a third opinion rather
 * than against the crate; `share_create declares every argument ipc.ts sends it` above is the
 * half that reads `share/commands.rs` itself. Neither is redundant: this one sees the *values*
 * a wrapper sends, that one sees a name this file could have got wrong twice.
 */
describe("the share wrappers name the commands `share/commands.rs` registers", () => {
  /** One published share, shaped as `ShareRow` serializes — nine fields, `ownerName` and `url`
   *  among them, because both are stored columns rather than anything a page rebuilds. */
  const row = {
    id: "kQ2p7fMx9Lb0RtVw",
    folderUid: "uid-1",
    title: "Trade binder",
    ownerName: "Giradeli",
    url: "https://share.example/s/kQ2p7fMx9Lb0RtVw",
    fields: ["value"],
    state: "live",
    published: 1_757_308_800,
    updatedAt: 1_757_308_800,
  };

  it("sends a folder share under `folderUid`, and a whole-collection share as null", async () => {
    invoke.mockResolvedValue(row);

    await ipc.shareCreate("uid-1", "Giradeli", { condition: true, lang: true, value: true });
    expect(invoke).toHaveBeenCalledWith("share_create", {
      folderUid: "uid-1",
      ownerName: "Giradeli",
      fields: { condition: true, lang: true, value: true },
    });

    // `null` is the whole collection, and it has to reach the wire as a value rather than as an
    // omitted key — an absent `folderUid` and an explicit null are the same on this wire only
    // because Rust reads `Option`; do not rely on it.
    await ipc.shareCreate(null, "Giradeli", { condition: false, lang: false, value: false });
    expect(invoke).toHaveBeenLastCalledWith("share_create", {
      folderUid: null,
      ownerName: "Giradeli",
      fields: { condition: false, lang: false, value: false },
    });
  });

  /**
   * **Three booleans under their own names, never a list of field names** — `ShareFieldsArg` is
   * a struct precisely so a page cannot invent a fourth field by spelling one.
   *
   * Each of the three is `#[serde(default)]`, which is what makes a misspelling here silent
   * rather than a rejection: it arrives `false`, the publish succeeds, and the column the reader
   * ticked is missing from every card in the snapshot. So the three are sent **mixed** here
   * rather than all on or all off, which is what the case above sends: a wrapper that passed two
   * of them through each other's names satisfies both of those and only this one.
   */
  it("names each of the three field switches, on and off", async () => {
    invoke.mockResolvedValue(row);

    await ipc.shareCreate(null, "Giradeli", { condition: true, lang: false, value: true });

    expect(invoke).toHaveBeenLastCalledWith("share_create", {
      folderUid: null,
      ownerName: "Giradeli",
      fields: { condition: true, lang: false, value: true },
    });
  });

  it.each([
    ["shareRefresh", "share_refresh"],
    ["shareRevoke", "share_revoke"],
  ] as const)("%s sends the id under `id`", async (method, command) => {
    invoke.mockResolvedValue(method === "shareRefresh" ? row : undefined);

    await ipc[method]("kQ2p7fMx9Lb0RtVw");

    expect(invoke).toHaveBeenCalledWith(command, { id: "kQ2p7fMx9Lb0RtVw" });
  });

  it("shareList takes no arguments", async () => {
    invoke.mockResolvedValue([]);

    await ipc.shareList();

    expect(invoke).toHaveBeenCalledWith("share_list");
  });

  /**
   * **`share_open` answers unknown JSON on purpose, and this pins that the wrapper passes it
   * through untouched.**
   *
   * The crate answers `serde_json::Value` because spec §10 wants a snapshot from a *newer* build
   * told about rather than refused, and a strict Rust struct turns that into a parse error at the
   * wrong layer. `parseSnapshot` in `@/lib/shareSnapshot` is what draws the conclusion, so a
   * wrapper that narrowed the answer here would be a fourth implementation of the format.
   */
  it("shareOpen sends the pasted link under `url` and answers what it was given", async () => {
    const body = { v: 1, title: "Trade binder", cards: [], folders: [] };
    invoke.mockResolvedValue(body);

    const out = await ipc.shareOpen("https://share.example/s/kQ2p7fMx9Lb0RtVw");

    expect(invoke).toHaveBeenCalledWith("share_open", {
      url: "https://share.example/s/kQ2p7fMx9Lb0RtVw",
    });
    expect(out).toEqual(body);
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
  /**
   * Both parsers split on `/\r?\n/` rather than on `"\n"`, and it is not tidiness.
   *
   * A file's line endings are not a fact about the code in it, but `body.indexOf("}")` compares
   * a whole line — so a source checked out or written with CRLF ends every struct in `"}\r"`,
   * the closing brace is never found, and the row fails with `has no closing brace` for a
   * mirror that is perfectly correct. That is a *fence reporting a drift that does not exist*,
   * which is worse than the drift: it trains a reader to disbelieve this table. Two of the
   * `card-scanner` sources were CRLF and four were LF when the scanner rows were added
   * (2026-09-08), which is the shape this arrives in — an editor or a generated write flips one
   * file and nothing else in either build notices.
   */
  const srcLines = (text: string): string[] => text.split(/\r?\n/);

  /** Field names of a `pub struct` in a Rust source file, in declaration order. */
  const rustFields = (src: string, name: string): string[] => {
    const start = src.indexOf(`pub struct ${name} {`);
    expect(start, `\`pub struct ${name}\` is not in the Rust source given`).toBeGreaterThan(-1);
    const body = srcLines(src.slice(start)).slice(1);
    const end = body.indexOf("}");
    expect(end, `\`${name}\` has no closing brace`).toBeGreaterThan(0);
    // **Two things the plain `pub name:` line cannot express, both of them the scanner's.**
    //
    // A `#[serde(skip)]` field is not in the JSON at all, so it must not be in the mirror
    // either — `LockState::quad` is the live one, and the row for `ScannerLock` would fail for
    // a field the page can never receive. The attribute is on the line *before* the field, so
    // the walk needs the neighbouring line and not just its own. `skip_serializing_if` is
    // deliberately not matched: that field *is* in the JSON whenever it has a value, and
    // `Verdict::error` is the one that has to stay.
    //
    // `r#match` is the one raw identifier in either tree, because `match` is a keyword in Rust
    // and is not one in TypeScript — the page reads `verdict.match`, so the mirror carries the
    // bare name and the parser has to see through the prefix.
    const lines = body.slice(0, end);
    return lines
      .map((line, i) =>
        /^\s*#\[serde\(skip\)\]/.test(lines[i - 1] ?? "")
          ? undefined
          : /^\s*pub\s+(?:r#)?([a-z0-9_]+)\s*:/.exec(line)?.[1],
      )
      .filter((f): f is string => f !== undefined);
  };

  /** Field names of an exported `interface`, comments stripped first. */
  const tsFields = (src: string, name: string): string[] => {
    const start = src.indexOf(`export interface ${name} {`);
    expect(start, `\`export interface ${name}\` is not in ipc.ts`).toBeGreaterThan(-1);
    const body = srcLines(src.slice(start)).slice(1);
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
   * The request's side of the same rot, for the one field on it that changes what a *number*
   * means rather than which rows come back.
   *
   * A misspelling here is silent in the worst way this file guards: `#[serde(default)]` means
   * an unrecognised key is simply dropped, so the deck builder would go on rendering every
   * copy the reader owns — the exact behaviour issue #349 reports — with a green build, a
   * passing wall and no error anywhere. Pinned by name rather than field for field, because
   * `SearchRequest`'s two sides part company on purpose elsewhere (`CardFilters` is flattened
   * into the Rust struct and spelled out in the TypeScript one).
   */
  it("names the deck-relative owned scope on both sides of the search request", () => {
    expect(rustFields(searchRs, "SearchRequest")).toContain("available_for_deck");
    expect(tsFields(ipcSource, "SearchRequest")).toContain("availableForDeck");
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
   *
   * **It is not only the walls, which is why the list below is longer than that paragraph.**
   * Five more surfaces read `cardImageUrl` directly and were found blank on the phone the same
   * day: the deck gallery's cover, a folder card's strip of member art, the cover picker's
   * preview and its choice tiles, and the theory diff's row thumbnails. Two more DTOs carry the
   * field for them, and both are pinned here rather than trusted — see the rows themselves.
   */
  // Annotated rather than inferred: without the tuple type TypeScript widens each row to
  // `string[]` and the three arguments below lose their names.
  const mirrors: [tsName: string, rustSource: string, rustName: string][] = [
    ["CollectionRow", collectionRs, "CollectionRow"],
    ["WishRow", wishlistRs, "WishRow"],
    // The one pair whose two names differ: the crate calls a deck's line `DeckCardRow` and
    // this file calls it `DeckCard`, so the mapping is spelled out rather than assumed.
    ["DeckCard", deckRs, "DeckCardRow"],
    // **The two rows that are not card walls, added 2026-08-31 with the surfaces that needed
    // them.** A deck's gallery tile, a folder card's strip of member art, the cover picker's
    // preview and the theory diff's row thumbnails all drew `mtgimg://` directly, so all four
    // were blank in a browser and on the phone — the gallery from the day a card-art crop
    // became the *only* deck cover. `DeckRow.image_uris` is the **cover printing's** picture,
    // off the same `LEFT JOIN cards c ON c.id = d.cover_card_id` its `cover_artist` comes from,
    // not the deck's own; `TheoryDiffRow.image_uris` is the row's printing.
    ["DeckRow", deckRs, "DeckRow"],
    ["TheoryDiffRow", deckTheoryRs, "TheoryDiffRow"],
    // **The first row here that is not about a picture**, and it earns its place on the same
    // mechanism rather than the same symptom. Four of `DeckTokenRow`'s fields exist solely to
    // tell two tokens apart — `power`, `toughness`, `colors`, `oracleText` — because a token's
    // name does not identify it: 104 token/emblem names are shared by more than one `oracle_id`
    // (debug corpus, 2026-09-07), and `Wurmcoil Engine` alone puts two tokens both called
    // `Wurm 3/3` in one deck. A field dropped on either side of this mirror would not blank a
    // tile the way a missing `image_uris` does; it would draw two tiles that look and announce
    // the same, which is the collection wall's shipped bug again and which neither suite can
    // see. `colors` typed as an array rather than the concatenated letters `cards.colors`
    // actually stores would be caught here too, by name parity alone.
    ["DeckTokenRow", deckTokensRs, "DeckTokenRow"],
  ];

  it.each(mirrors)(
    "the %s mirror agrees with the Rust struct field for field",
    (tsName, rustSource, rustName) => {
    const rust = rustFields(rustSource, rustName).map(camel);
    const ts = tsFields(ipcSource, tsName);

    // **First, because it is the assertion this whole block exists for** — and because the
    // sanity floor below reads as nonsense when it is the one that trips ("expected 10 to be
    // greater than 10" is a missing field, not a parser fault). Named on its own as well as
    // counted, since its absence is silent on both sides: `undefined` at the call site, a
    // blank frame on screen, and no type error anywhere.
    expect(rust, `\`${rustName}\` (Rust) has no \`image_uris\``).toContain("imageUris");
    expect(ts, `\`${tsName}\` (ipc.ts) has no \`imageUris\``).toContain("imageUris");

    // Not `toEqual` on the raw arrays: the parsers are the thing under suspicion, so a pass
    // has to mean "both found fields", never "both found nothing".
    expect(rust.length, `nothing parsed out of \`${rustName}\``).toBeGreaterThan(10);
    expect(ts.length, `nothing parsed out of \`${tsName}\``).toBeGreaterThan(10);
    expect([...ts].sort()).toEqual([...rust].sort());
    },
  );

  /**
   * The same fence, for structs that are **not** card rows.
   *
   * `mirrors` above asserts two things beyond field parity — that `image_uris` is present, and
   * that more than ten fields parsed — and both are properties of a card-bearing row rather
   * than of a mirror. `DecksCleared` is two fields and has no picture, so it needs the parity
   * rule and neither of the others.
   *
   * **These three are here because one of them drifted unnoticed on 2026-08-31.** Rust dropped
   * `DecksCleared::covers` along with the custom deck cover; this file's mirror kept it, and
   * `clearOutcome`'s `r.covers > 0` quietly became `undefined > 0` — **`false` rather than a
   * type error** — so the panel stopped reporting a count while every mock still supplied
   * `covers: 0`. Nothing went red. **A removal presents more quietly than a rename**: a renamed
   * field at least reads `undefined` where a value is expected, whereas a removed number
   * compared with `>` simply takes the other branch for ever.
   *
   * The lesson is the table itself. This fence is **opt-in per struct**, so "is this checked?"
   * is answered by whether a name appears on one of these two lists and by nothing else.
   * Adding a row is the whole of the fix and it costs one line.
   */
  const plainMirrors: [tsName: string, rustSource: string, rustName: string][] = [
    ["CollectionCleared", resetRs, "CollectionCleared"],
    ["DecksCleared", resetRs, "DecksCleared"],
    ["CacheCleared", resetRs, "CacheCleared"],
    // **Added with `locked` (2026-09-03), which is the field that showed why it was missing.**
    // A folder row is small, unpictured and had been on neither list since folders shipped — so
    // a boolean added to the Rust struct and forgotten here would be `undefined` on every
    // folder, and `if (folder.locked)` takes the other branch for ever: no badge, no greyed
    // Delete, and nothing red anywhere. That is `DecksCleared::covers`' failure exactly, in a
    // field the reader presses a menu row to set.
    ["CollectionFolder", collectionFoldersRs, "CollectionFolder"],
    // **The pull's four, added with the feature** (2026-09-03, issue #351). Three of them are
    // read-only shapes and the fourth is the only DTO in this file the app *sends*, which is
    // the one where a drift is loudest: `deck_pull_from_collection` is all-or-nothing, so a
    // renamed `Pick` field deserialises to a serde default and the batch is refused whole
    // rather than half-applied — a press that always fails, with nothing red anywhere.
    //
    // `PullRow` is on this list rather than on `mirrors` above even though it carries a
    // picture, because that table's floor of ten fields is a property of a card *wall*'s row
    // and this one has nine. The picture is asserted on its own instead, below.
    ["DeckPullRow", deckPullRs, "PullRow"],
    ["DeckPullCandidate", deckPullRs, "PullCandidate"],
    ["DeckPullPick", deckPullRs, "Pick"],
    ["DeckPullOutcome", deckPullRs, "PullOutcome"],
    // **The quick add's two, added with the feature** (2026-09-03, issue #350). Both are
    // read-only shapes with no picture, and both are exactly the kind of small unpictured row
    // `CollectionFolder` above is on this list for: `QuickAddOutcome`'s three numbers are all
    // counts a sentence quotes, so a renamed one arrives as `undefined`, prints as `0` through
    // the audit's own defensive readers, and reads as a press that recorded nothing — with
    // nothing red anywhere, because a press that *did* record nothing is a legitimate answer.
    ["DeckQuickAddWish", deckQuickAddRs, "QuickAddWish"],
    ["DeckQuickAddOutcome", deckQuickAddRs, "QuickAddOutcome"],
    // **The deck-wide add's three, added with the feature** (2026-09-08) — one row per struct,
    // which is two commands' worth: `deck_missing_plan` answers `MissingRow[]` and
    // `deck_missing_to_collection` takes `MissingPick[]` and answers a `MissingOutcome`.
    //
    // `MissingRow` is on this list and not on `mirrors` above for `PullRow`'s reason exactly: it
    // carries a picture, but it is nine fields against that table's floor of ten, and the floor
    // is a property of a card *wall*'s row rather than of a mirror. The picture is asserted on
    // its own below, beside the pull row's.
    //
    // `MissingPick` is the one the app **sends**, where a drift is loudest —
    // `WishOptimizeApplyItem`'s lesson below and `deck_pull_from_collection`'s above: the write
    // is all-or-nothing, so a renamed field deserialises to a serde default, matches nothing in
    // the backend's re-plan, and every ticked row is refused whole. A press that always fails,
    // with nothing red anywhere. It is also the one DTO in this pair carrying **no id at all** —
    // the address is `(card_id, finish)` because the row being created does not exist yet — so
    // both of its naming fields are load-bearing and neither can be inferred from the other side.
    //
    // `MissingOutcome`'s three numbers are all counts a sentence quotes, which is
    // `QuickAddOutcome`'s note three rows up: a renamed one arrives `undefined`, prints as `0`,
    // and reads as a press that recorded nothing — and a press that *did* record nothing is a
    // legitimate answer, so nothing goes red.
    ["DeckMissingRow", deckMissingRs, "MissingRow"],
    ["DeckMissingPick", deckMissingRs, "MissingPick"],
    ["DeckMissingOutcome", deckMissingRs, "MissingOutcome"],
    // **The cheapest-printing sweep's six, added with the feature** (2026-09-03, issue #352).
    // They are here rather than on `mirrors` above for `DecksCleared`'s reason and not for a new
    // one: none is a card wall's row, none carries a picture, and the smallest of them is two
    // fields — so the parity rule is the only one of that table's three they can pass.
    //
    // The list is longer than the feature looks because a plan is **nested**: `OptimizePrinting`
    // is not sent or received on its own, it is the `from` and the `to` of every move, and a
    // field renamed inside it would leave the row's two halves reading `undefined` while
    // `WishOptimizeMove` itself still agreed field for field. A parity check on the outer struct
    // cannot see that, so each level is named.
    //
    // `WishOptimizeApplyItem` is the one the app **sends**, which is where a drift is loudest —
    // `deck_pull_from_collection`'s lesson four rows up: apply is one transaction, so a renamed
    // field deserialises to a serde default, `fromCardId` matches nothing, and every ticked row
    // comes back `stale`. A press that always appears to do nothing, with nothing red anywhere.
    //
    // `WishOptimizeStatus` is deliberately absent: it is a TypeScript union and a Rust `enum`,
    // and this fence parses `pub struct`/`export interface` field lists. The four words are
    // pinned by `WishOptimizeResult.status`'s type on one side and `#[serde(rename_all)]` on the
    // other, which is a gap worth naming rather than one worth papering over here.
    ["OptimizePrinting", wishlistOptimizeRs, "OptimizePrinting"],
    ["WishOptimizeMove", wishlistOptimizeRs, "WishOptimizeMove"],
    ["WishlistOptimizePlan", wishlistOptimizeRs, "WishlistOptimizePlan"],
    ["WishOptimizeApplyItem", wishlistOptimizeRs, "WishOptimizeApplyItem"],
    ["WishOptimizeResult", wishlistOptimizeRs, "WishOptimizeResult"],
    ["WishlistOptimizeOutcome", wishlistOptimizeRs, "WishlistOptimizeOutcome"],
    // **The deck gallery's two reads, added with the feature** (2026-09-07, issue #387). Four
    // rows because both are **nested** for `OptimizePrinting`'s reason: `PipCost` is the whole
    // content of a `DeckPipCosts` and `BracketCardRow` the whole content of a
    // `DeckBracketRead`, so a field renamed one level down leaves the outer struct agreeing
    // field for field while every value inside it arrives `undefined`.
    //
    // **`BracketCardRow` is on this list and not on `mirrors` above, and it is the closest call
    // either table has had.** It is card-shaped — a name, oracle text, the faces blob — so the
    // obvious reading is that the card table is where it goes. It is not: that table's two extra
    // rules are properties of a card *wall's* row rather than of a card, and this row satisfies
    // neither. It carries no `image_uris`, because the bracket estimate draws no picture and a
    // gallery-wide read that shipped one would be carrying an art URL per card of every deck for
    // a number in a caption; and it is five fields against a floor of ten, which is the same
    // fact said twice — it is `estimateBracket`'s input and nothing else.
    //
    // What a drift here costs is worth stating because none of it is loud. A renamed
    // `game_changer` reads `undefined`, `=== true` takes the other branch, and every deck in the
    // gallery quietly estimates one bracket too low. A renamed `oracle_text` or `faces` empties
    // the mass-land-denial and extra-turn greps, which fire on *no* deck rather than on the
    // wrong one. A renamed `cost` on `PipCost` gives `countPips(undefined)` — no pips, no bar,
    // on every tile at once. Every one of those is a plausible-looking gallery with a green
    // build behind it.
    ["PipCost", deckRs, "PipCost"],
    ["DeckPipCosts", deckRs, "DeckPipCosts"],
    ["BracketCardRow", deckRs, "BracketCardRow"],
    ["DeckBracketRead", deckRs, "DeckBracketRead"],
    // **The card-side combo read's four, added with the feature** (issue #359) — and four rows
    // for one command because the shape is **nested three deep**, which is `OptimizePrinting`'s
    // reason arriving at its worst case: `CardCombosPage` holds `CardCombo`s, each of which
    // holds `ComboPiece`s, and the page also holds a list of `ComboCountBucket`s. A field
    // renamed at any level below the top leaves the outer struct agreeing field for field while
    // everything inside it arrives `undefined`, so each level is named.
    //
    // `ComboPiece` is on this list and not on `mirrors` above for `PullRow`'s and `MissingRow`'s
    // reason exactly: it carries a picture, but it is seven fields against that table's floor of
    // ten, and the floor is a property of a card *wall's* row rather than of a mirror. The
    // picture is asserted on its own below, beside theirs.
    //
    // What a drift costs here is quiet in the way this table exists for. A renamed `owned` reads
    // `undefined` and prints as though the reader owns none of a card they have four of. A
    // renamed `must_be_commander` is `undefined`, `=== true` takes the other branch, and the one
    // piece a combo insists on in the command zone is drawn as an ordinary card. A renamed
    // `matching` or `owned_total` on the page gives a caption `NaN` or a pager that stops early.
    // Every one of those is a screen that looks like an answer.
    ["ComboPiece", combosRs, "ComboPiece"],
    ["CardCombo", combosRs, "CardCombo"],
    ["ComboCountBucket", combosRs, "ComboCountBucket"],
    ["CardCombosPage", combosRs, "CardCombosPage"],
    // **The first *stored preference* on either table** (2026-09-08), and it is here because it is
    // the first one with fields at all: the other nine `app_meta` settings answer a bare string, a
    // bare map or a bare `boolean`, and this fence parses `pub struct`/`export interface` field
    // lists — so none of them can be on a list here, and this one cannot be left off it for the
    // same reason.
    //
    // Two fields, and what a drift costs is the quiet kind this table exists for. A renamed
    // `width` reads `undefined`, `?? DEFAULT_FOLDER_TREE_WIDTH_PX` takes the fallback arm, and the
    // decks page opens at its default width for ever — which is exactly what a reader who has
    // never dragged the tree sees, so nothing looks wrong. A renamed `collapsed` reads
    // `undefined`, the `typeof … === "boolean"` narrowing takes the same fallback, and the tree
    // simply never remembers a fold. Both are a green build, a drawable page and a setting that
    // silently stopped working.
    ["DeckFolderPane", deckpaneRs, "DeckFolderPane"],
    // **The share list's two, added with the feature** (2026-09-08). `ShareRow` is here rather
    // than on `mirrors` above for `PullRow`'s reason: it draws no picture and is nine fields
    // against that table's floor of ten, and both of those rules are properties of a card
    // *wall's* row rather than of a mirror.
    //
    // What a drift costs is the quiet kind this table exists for, and every one of the four is a
    // page that still draws. A renamed `state` reads `undefined`, the *Lapsed* row never draws,
    // and the reader learns their share stopped answering from the friend they sent it to. A
    // renamed `url` gives a Copy-link row that copies `undefined` — the one field that cannot be
    // rebuilt from anything, because the Worker builds the link from its own `SHARE_BASE`. A
    // renamed `ownerName` empties the name the *next* device in the group publishes under (spec
    // §4.3), which is a field this device never has to look at. And a renamed `published` is
    // nullish for ever, so a second device offers *Share* where it owes *Update*.
    //
    // `ShareFieldsArg` is the one the app **sends**, which is where a drift is loudest —
    // `MissingPick`'s and `WishOptimizeApplyItem`'s lesson above, and sharper here because all
    // three of its fields are `#[serde(default)]`: a renamed one is not a refusal, it is `false`.
    // The publish succeeds and the column the reader ticked is missing from every card in it.
    // Named `ShareFields` on this side, which is why the pair is spelled out rather than assumed
    // — `DeckCard`/`DeckCardRow`'s row above is the precedent.
    ["ShareRow", shareRs, "ShareRow"],
    ["ShareFields", shareRs, "ShareFieldsArg"],
    // Added 2026-09-08 by a rename that this table would have caught and nothing else could.
    // `missing` became `copies` on both sides by hand when the wishlist stopped subtracting the
    // collection, and a rename reaching only one of them is the quiet kind: every folder card
    // reads `undefined` for the field, `face()` takes its "not counted yet" arm, and the whole
    // cabinet draws an em dash over drawers that are full. Green build, drawable page, no figure.
    ["WishlistFolderSummary", wishlistFoldersRs, "WishlistFolderSummary"],
  ];

  it.each(plainMirrors)(
    "the %s mirror agrees with the Rust struct field for field",
    (tsName, rustSource, rustName) => {
      const rust = rustFields(rustSource, rustName).map(camel);
      const ts = tsFields(ipcSource, tsName);

      // A floor of one rather than ten, for the same reason the card table has ten: a pass has
      // to mean "both parsers found fields", never "both found nothing".
      expect(rust.length, `nothing parsed out of \`${rustName}\``).toBeGreaterThan(0);
      expect(ts.length, `nothing parsed out of \`${tsName}\``).toBeGreaterThan(0);
      expect([...ts].sort()).toEqual([...rust].sort());
    },
  );

  /**
   * **Snake case on both sides.** The scanner's JSON is the debug page's, which reads
   * `decide_at` and `best_distance` by name and is not changing — so these mirrors keep the
   * Rust field names verbatim and the row compares them with no camel step.
   *
   * That makes this the third table rather than a longer `plainMirrors`: the `camel` call in
   * both tables above is not decoration, it is the `#[serde(rename_all = "camelCase")]` those
   * structs carry, and none of these twenty-one does. A scanner row on `plainMirrors` would
   * fail on every multi-word field for a spelling that is correct.
   *
   * **Most of this list is one command's answer**, because a `Verdict` is a tree of structs and
   * parity on the outer one sees none of it — `OptimizePrinting`'s lesson above, at the scale
   * the detector works at. A renamed `best_distance` inside `StandingView` leaves `Verdict`
   * agreeing field for field while every standing in the list reads `undefined`, which draws a
   * candidate table of `NaN`s rather than an empty one. So each level is named.
   */
  const snakeMirrors: [tsName: string, rustSource: string, rustName: string][] = [
    ["ScannerAsset", scannerRs, "Asset"],
    ["ScannerStatus", scannerRs, "ScannerStatus"],
    ["ScannerSidecar", scannerRs, "Sidecar"],
    ["ScannerCaptured", scannerRs, "Captured"],
    ["ScannerOptions", sessionRs, "FrameOptions"],
    ["ScannerVerdict", sessionRs, "Verdict"],
    ["ScannerFrameSize", sessionRs, "FrameSize"],
    ["ScannerStages", sessionRs, "Stages"],
    ["ScannerStanding", sessionRs, "StandingView"],
    ["ScannerTracked", sessionRs, "TrackedView"],
    ["ScannerCollectorTry", sessionRs, "CollectorTry"],
    ["ScannerCollector", sessionRs, "CollectorView"],
    ["ScannerOcr", sessionRs, "OcrView"],
    ["ScannerLabel", referenceRs, "Label"],
    ["ScannerCandidate", referenceRs, "Candidate"],
    ["ScannerMatch", referenceRs, "MatchReport"],
    ["ScannerLock", lockRs, "LockState"],
    ["ScannerScore", detectRs, "QuadScore"],
    ["ScannerTimings", detectRs, "DetectTimings"],
    ["ScannerCardness", cardnessRs, "Cardness"],
    ["ScannerTrim", trimRs, "Margin"],
  ];

  it.each(snakeMirrors)(
    "the %s mirror agrees with the Rust struct field for field, snake case kept",
    (tsName, rustSource, rustName) => {
      const rust = rustFields(rustSource, rustName);
      const ts = tsFields(ipcSource, tsName);
      expect(rust.length, `nothing parsed out of \`${rustName}\``).toBeGreaterThan(0);
      expect(ts.length, `nothing parsed out of \`${tsName}\``).toBeGreaterThan(0);
      expect([...ts].sort()).toEqual([...rust].sort());
    },
  );

  /**
   * `PullRow`'s picture, named on its own — the assertion `mirrors` makes for the four card
   * walls, owed here for their reason and made separately because that table's other two rules
   * are properties of a wall's row rather than of a mirror.
   *
   * The pull dialog draws an art crop per row, and the failure a missing `image_uris` produces
   * is the silent one this whole block exists for: `undefined` at the call site, a bare frame on
   * screen, and no type error anywhere — because the field is optional on the TypeScript side,
   * as every `imageUris` in this file is. jsdom has no network and cannot notice a picture that
   * never arrives, so the field name agreeing on both sides is the whole of the fence.
   *
   * It costs the crate nothing to carry: `deck_pull` clones the value off the `DeckCardRow`s the
   * plan is already built from, rather than running a second `front_face_selects` query.
   */
  it("names the front face's image URLs on both sides of the pull row", () => {
    expect(rustFields(deckPullRs, "PullRow"), "`PullRow` (Rust) has no `image_uris`").toContain(
      "image_uris",
    );
    expect(
      tsFields(ipcSource, "DeckPullRow"),
      "`DeckPullRow` (ipc.ts) has no `imageUris`",
    ).toContain("imageUris");
  });

  /**
   * `MissingRow`'s picture, for the reason one test up and not a new one: the add dialog draws an
   * art crop per row exactly as the pull's does, the row is nine fields and so sits on
   * `plainMirrors`, and that table asserts parity alone. Two rows now share this shape, which is
   * the sign that the argument belongs to the *dialog* rather than to either feature — a third
   * deck-boundary read that draws art owes this assertion too.
   */
  it("names the front face's image URLs on both sides of the add row", () => {
    expect(
      rustFields(deckMissingRs, "MissingRow"),
      "`MissingRow` (Rust) has no `image_uris`",
    ).toContain("image_uris");
    expect(
      tsFields(ipcSource, "DeckMissingRow"),
      "`DeckMissingRow` (ipc.ts) has no `imageUris`",
    ).toContain("imageUris");
  });

  /**
   * A combo piece's picture, for the two above's reason and with one difference worth naming:
   * this is not a deck-boundary read at all. It is the *card* side — every combo that names one
   * card, most of whose pieces the reader owns nothing of — so the paragraph those two share
   * generalises one step further than it was written. What owes this assertion is any row that
   * **draws a card and is not on `mirrors`**, whatever it is a boundary of.
   *
   * The parity row above cannot make it: parity catches a field renamed on *one* side, and both
   * sides dropping the picture together is a green table and a dialog of named, artless frames.
   * The web build and the phone have no `mtgimg://` to fall back on, so there this field is the
   * only picture there is.
   */
  it("names the front face's image URLs on both sides of the combo piece", () => {
    expect(
      rustFields(combosRs, "ComboPiece"),
      "`ComboPiece` (Rust) has no `image_uris`",
    ).toContain("image_uris");
    expect(tsFields(ipcSource, "ComboPiece"), "`ComboPiece` (ipc.ts) has no `imageUris`").toContain(
      "imageUris",
    );
  });
});

/**
 * **The condition scale is a Rust↔TypeScript contract with no compiler behind it**, and it is
 * the same shape of seam as the sync event names above: `collection.rs` refuses a grade it does
 * not know *in words* (`valid_condition`), and `conditions.ts` is what fills every dropdown the
 * reader picks from. Nothing else in the build makes the two agree.
 *
 * The two ways it breaks are not symmetrical, and both are silent on this side:
 *
 * * a grade in `CONDITIONS` here that Rust does not know is a menu row that always fails, with
 *   the backend's sentence surfacing as a red line under a control that looked ordinary;
 * * a grade Rust accepts that this list omits is a stored row this app cannot label, filter or
 *   offer — which is exactly what an imported database or a synced device can hand it.
 *
 * So the crate is read for the list, the way `deck_played_keys` is read for its name above.
 * Compared as **sets**, because the two orders are allowed to differ and are not the same
 * question: Rust's is the order `COLLECTION_SORTS`' `CASE` ranks a column by, and this side's is
 * the order a dropdown offers.
 */
describe("the condition scale agrees with the crate that enforces it", () => {
  /** Not `toContain` on the source alone: a pass has to mean "the crate spells it", never
   *  "the crate was never read". */
  it("read collection.rs", () => {
    expect(collectionRs.length).toBeGreaterThan(1_000);
  });

  /** `[\s\S]` rather than the `s` flag, and a lazy body: the array fits on one line today and
   *  rustfmt is free to wrap it the day a seventh grade is added. */
  const rustList = (): string[] => {
    const m = /pub const CONDITIONS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(collectionRs);
    expect(
      m,
      "`collection.rs` no longer declares `CONDITIONS` in a shape this test can read",
    ).not.toBeNull();
    return [...(m as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((g) => g[1]);
  };

  it("offers exactly the grades the backend accepts", () => {
    expect([...rustList()].sort()).toEqual([...CONDITIONS].sort());
  });

  it("declares the same length on both sides", () => {
    // The `N` in Rust's `[&str; N]` is a third statement of the same fact and can rot on its
    // own. A *widened* array with a stale length does not compile; a narrowed one does not
    // either — but the pair only stays honest while something reads the number, and this is the
    // only thing that does.
    const m = /pub const CONDITIONS: \[&str; (\d+)\]/.exec(collectionRs);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBe(CONDITIONS.length);
  });

  it("records the same grade for a write that names none", () => {
    // What a write naming no grade stores, asked on both sides by unrelated code —
    // `valid_condition`'s `unwrap_or` there, `MENU_CONDITION` and the add popup's opening value
    // here. A disagreement draws one grade and stores another.
    const m = /pub const DEFAULT_CONDITION: &str = "([^"]+)";/.exec(collectionRs);
    expect(m, "`collection.rs` no longer declares `DEFAULT_CONDITION`").not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe(CONDITION_NOT_SET);
  });

  it("agrees on the sentinel's spelling", () => {
    // `CONDITION_NOT_SET` and `DEFAULT_CONDITION` hold one string and are not one idea: the
    // sentinel is *the grade meaning nobody said*, the default is *what an unnamed write
    // records*. Pinned separately so a later release that defaults to something else does not
    // silently take the sentinel with it.
    const m = /pub const CONDITION_NOT_SET: &str = "([^"]+)";/.exec(collectionRs);
    expect(m, "`collection.rs` no longer declares `CONDITION_NOT_SET`").not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe(CONDITION_NOT_SET);
    expect(CONDITIONS).toContain(CONDITION_NOT_SET);
  });
});
