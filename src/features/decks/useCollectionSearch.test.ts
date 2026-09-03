import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionFolder, CollectionRow } from "@/lib/ipc";

const collectionList = vi.hoisted(() => vi.fn());
const collectionToDeck = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
// The deck's live census, which `useDeckPlays` reads and this hook fences every tile on
// (issue #358). The real hook is mounted rather than mocked — what is faked is the one command
// under it — so the key this file asserts on is `playKey`'s own `coalesce(oracle_id, card_id)`
// rather than a second copy of that rule written here.
const deckPlayedKeys = vi.hoisted(() => vi.fn());
// `useMarketplace` is the real hook here rather than a fake — the marketplace is part of both
// the payload and the key — so its own two queries need answers or it sits rejected for the
// life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionToDeck,
    collectionFolderList,
    deckPlayedKeys,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import {
  copySource,
  DEFAULT_EXCLUDE_LOCKED,
  playStateFor,
  useCollectionSearch,
} from "./useCollectionSearch";

/** The deck this panel is docked beside — the one a move files *into*. */
const DECK_ID = 4;

/** This deck's own group: `kind: "deck"`, named after the deck, `deckId` pointing back at it. */
const THIS_GROUP: CollectionFolder = {
  id: 10,
  parentId: null,
  name: "Kenrith",
  kind: "deck",
  deckId: DECK_ID,
  sortOrder: 0,
  locked: false,
};
/** Another deck's group — the folder the confirm exists for. */
const OTHER_GROUP: CollectionFolder = {
  id: 11,
  parentId: null,
  name: "Mono-Red Aggro",
  kind: "deck",
  deckId: 9,
  sortOrder: 0,
  locked: false,
};
/** A drawer the reader made. On the desk, so no confirm. */
const BINDER: CollectionFolder = {
  id: 12,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
};
/** The one holding area. **On the desk too** — a card that left the collection without leaving
 *  the database is not a card a deck is using. */
const REMOVED: CollectionFolder = {
  id: 13,
  parentId: null,
  name: "Recently removed",
  kind: "removed",
  deckId: null,
  sortOrder: 0,
  locked: false,
};

const FOLDERS = [THIS_GROUP, OTHER_GROUP, BINDER, REMOVED];

function row(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1,
    cardId: "bolt",
    folderId: null,
    folderName: null,
    name: "Lightning Bolt",
    oracleId: "o-bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    lang: "en",
    rarity: "common",
    manaCost: "{R}",
    typeLine: "Instant",
    layout: "normal",
    finish: "nonfoil",
    condition: "NM",
    quantity: 3,
    tradelistQuantity: 0,
    unitPrice: 400.5,
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: 0,
    promoTypes: null,
    legalities: null,
    ...over,
  };
}

const BOLT = row();

/**
 * The Bolt as the **wall** hands it to the fence — `CopyTile.id` is the printing, which is
 * `CollectionRow.cardId` under the wall's own name, and `PlayableTile` is written down precisely
 * so that a row's numeric `id` cannot be passed where a printing is wanted.
 */
const BOLT_TILE = { id: BOLT.cardId, oracleId: BOLT.oracleId };

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  collectionList.mockReset().mockResolvedValue({ items: [BOLT], total: 1 });
  // `deckCardId` is the `deck_cards` row the move landed on — always named by this command,
  // so a mock that omitted it would encode an answer the backend cannot give.
  collectionToDeck
    .mockReset()
    .mockResolvedValue({ entryId: 5, fromDeck: null, deckCardId: 41, quantity: 1 });
  collectionFolderList.mockReset().mockResolvedValue(FOLDERS);
  // The deck plays the Bolt, so every case in this file that is not about the fence sees the
  // pressable answer. The key is the **oracle** id, which is what `played_keys` selects.
  deckPlayedKeys.mockReset().mockResolvedValue([BOLT.oracleId]);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

/** The hook, mounted the way the tab mounts it. */
function mount(options: { deckId?: number | null } = {}) {
  return renderHook(
    () =>
      useCollectionSearch({
        deckId: options.deckId === undefined ? DECK_ID : options.deckId,
        defaultFormat: { value: "commander", label: "Commander" },
      }),
    { wrapper },
  );
}

/** The query object the last `collection_list` was asked with. */
function lastQuery() {
  return collectionList.mock.calls[collectionList.mock.calls.length - 1][0];
}

describe("useCollectionSearch", () => {
  /**
   * **The default is only-unallocated, and it is the whole point of the feature.**
   *
   * A copy sitting in another deck's group is spoken for: a reader building a deck out of what
   * they have wants the cards that are actually free. `"all"` is the deliberate press that makes
   * the spoken-for copies visible — and pressing Add on one of those is what the confirm is for.
   *
   * The assertion is on the **payload**, not on a piece of state, because nothing has ever sent
   * this field: `CollectionQuery.allocation` has existed since schema v25 and every caller in
   * the app gets `All` by omission. A hook that held the right state and dropped the field on the
   * way to the wire would read as correct everywhere but in the answers.
   */
  it("asks for only the unallocated copies until the reader says otherwise", async () => {
    mount();

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().allocation).toBe("unallocated");
  });

  /**
   * The other half of the toggle, and that it reaches the wire as a **new request** rather than
   * being served from the cached page: the two allocations are two different sets of rows, so a
   * key that did not carry the field would show the reader the narrowed list under a widened
   * control.
   */
  it("sends `all` once the reader asks to see every copy", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    act(() => result.current.setAllocation("all"));

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(lastQuery().allocation).toBe("all");
  });

  /**
   * **The set-aside drawers drop out, and it is asserted on the payload for `allocation`'s
   * reason.** `CollectionQuery.excludeLocked` defaults to `false` — an unasked question keeps
   * today's answer, which is what keeps the mirror's and the export sweep's whole-collection
   * reads whole — so a tab that merely *believed* it wanted the narrow list and dropped the field
   * on the way to the wire would read as correct everywhere except in the rows it got back.
   *
   * The expected value is written out as a literal rather than read off the hook or off a
   * constant: a test that asks the implementation what it sends passes against the defect it was
   * written for.
   *
   * It is the same question `DEFAULT_ALLOCATION` answers one line above — *what can I build with
   * today* — so the two travel together and there is no press that turns this one off.
   */
  it("drops the copies in a locked folder, with no press to turn it off", async () => {
    const { result } = mount();

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().excludeLocked).toBe(true);

    // Widening the allocation is the one control over which copies this list asks for, and it
    // says nothing about a drawer the reader set aside: `all` puts back the copies a *deck* is
    // holding, not the ones they took off the table themselves.
    let asked = collectionList.mock.calls.length;
    act(() => result.current.setAllocation("all"));
    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(lastQuery().excludeLocked).toBe(true);

    // And `Reset all` leaves it alone, for the reason it leaves the allocation pressed: this is
    // what the tab *is* rather than a filter laid over it. The wait is on a **new request**, so
    // the assertion cannot be read off the page the reset replaced.
    asked = collectionList.mock.calls.length;
    act(() => result.current.resetAll());
    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(lastQuery().excludeLocked).toBe(true);
  });

  /**
   * The deck's format opens the search, exactly as it does on the card-search tab — and `null`
   * is a working panel rather than a degraded one, which is why the fence is `DeckEditor`'s
   * `hasLegalityData` and never this hook's. `casual` is every deck's birth format and answers
   * no rows at all.
   */
  it("opens on the deck's format", async () => {
    mount();

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().format).toBe("commander");
  });

  /**
   * **The three filters this column grew when it took `FilterBar`'s tray** (2026-08-25), asserted
   * on the payload for `allocation`'s reason: two of them were already on the wire and simply
   * never sent, so a hook holding the right state and dropping the field would read as correct
   * everywhere but in the answers.
   *
   * `sets` and `rarities` are `CardFilters`' own — `CollectionQuery extends CardFilters` and
   * `push_card_filters` emits both for all three lists — so those two are state-only work. The
   * band is new in `collection::scope` and is the copy's **own** per-finish price rather than the
   * printing's fallback chain, which is what makes a banded row a row the Price column agrees
   * with.
   *
   * Each is set through the same press `FilterBar` makes, and each is read back off the last
   * request rather than off state.
   */
  it("sends the set, rarity and price filters the tray offers", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.toggleSet("lea"));
    act(() => result.current.toggleRarity("rare"));
    act(() => result.current.setPriceRange(2.5, 40));

    await waitFor(() => expect(lastQuery().priceMax).toBe(40));
    expect(lastQuery().sets).toEqual(["lea"]);
    expect(lastQuery().rarities).toEqual(["rare"]);
    expect(lastQuery().priceMin).toBe(2.5);
  });

  /**
   * **One end of the band on its own is one bound**, and the other is genuinely absent rather
   * than folded into a `0` — which would silently drop every copy the marketplace cannot price,
   * a filter the reader did not ask for. `collection::scope` pushes exactly the ends that arrive.
   */
  it("sends half a price band as half a price band", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.setPriceRange(undefined, 40));

    await waitFor(() => expect(lastQuery().priceMax).toBe(40));
    expect(lastQuery().priceMin).toBeUndefined();
  });

  /**
   * **Every one of them is in the key**, which is the half a payload assertion cannot see: the
   * list is `keepPreviousData` against local SQLite, so a key missing a term serves the *previous*
   * filter's page under the new control, instantly, with nothing on screen to notice.
   *
   * Counted as requests rather than compared as strings — the key is an implementation detail and
   * "it refetched" is the property.
   */
  it("re-reads for each of them rather than serving the last page", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    for (const press of [
      () => result.current.toggleSet("lea"),
      () => result.current.toggleRarity("rare"),
      () => result.current.setPriceRange(1, undefined),
    ]) {
      const asked = collectionList.mock.calls.length;
      act(press);
      await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    }
  });

  /**
   * **`Reset all` clears the three new filters and leaves `Not in a deck` pressed**, which is the
   * one judgement call in this hook's `activeCount`: the chip is on by default, so counting it
   * would open every deck reading `Reset all 1` for a state nobody touched, and clearing it would
   * take away what this tab *is* rather than a filter laid over it.
   */
  it("clears the tray's filters on reset and keeps the allocation", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.toggleSet("lea"));
    act(() => result.current.toggleRarity("rare"));
    act(() => result.current.setPriceRange(2.5, 40));
    await waitFor(() => expect(result.current.activeCount).toBe(4)); // + the deck's format

    act(() => result.current.resetAll());

    await waitFor(() => expect(result.current.activeCount).toBe(0));
    expect(result.current.sets).toEqual([]);
    expect(result.current.rarities).toEqual([]);
    expect(result.current.priceMin).toBeUndefined();
    expect(result.current.priceMax).toBeUndefined();
    expect(result.current.allocation).toBe("unallocated");
  });

  /**
   * The direction arrow beside the sort picker, and **the one place this hook deliberately
   * differs from `useCardSearch`**.
   *
   * An empty sort spec is this list's *name order* — `sortSelection` reports `name` for it and
   * never `""` — so it has a direction and the button is drawn live. The card search's empty spec
   * is `Best match`, a ranking, so its arrow greys. A press here therefore has to **write the
   * order out** rather than no-op on an empty array, or the reader would be looking at a control
   * that visibly does nothing.
   */
  it("flips the name order it opens in, rather than doing nothing", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(result.current.sortSelection).toBe("name");
    expect(result.current.sortDir).toBe("asc");

    act(() => result.current.flipSortDir());

    await waitFor(() => expect(result.current.sortDir).toBe("desc"));
    expect(result.current.sortSelection).toBe("name");
    expect(lastQuery().sort).toEqual([{ key: "name", dir: "desc" }]);
  });

  /**
   * The write, addressed the way `collection_alloc::collection_to_deck` declares it: the
   * **collection row**, the deck, the category and how many copies.
   */
  it("moves copies out of a collection row and into the deck", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    expect(collectionToDeck).toHaveBeenCalledWith(BOLT.id, DECK_ID, { id: 3 }, 1);
  });

  /**
   * **Not optimistic, and not merely marked stale.** `lib/query.ts` caches 30 s, so a mounted
   * query told it is stale and not refetched goes on drawing the row the write has just moved
   * out of the list — PR 2 shipped exactly that ghost row. The list observer here is mounted, so
   * the assertion is a second `collection_list`, not an `invalidateQueries` call count.
   */
  it("re-reads the list after a move rather than patching it", async () => {
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
  });

  /**
   * The three roots a move actually moves numbers under, and **the deck is the one easiest to
   * forget**: the copies came off somebody's desk *and* landed in a deck's list, and when they
   * came out of another deck's group that deck's live list is one shorter too. `invalidateQueries`
   * matches by key **prefix**, so `["collection"]` reaches the list, the summary, the folder
   * census and the per-folder subtotals together, and `["decks"]` reaches every deck's detail.
   *
   * **The card search is the third and joined on 2026-09-03** (issue #349). It used to move
   * nothing — that wall counted every copy the reader owned wherever it was filed — but the tab
   * one press away now counts what *this deck* can use, and a copy taken out of another deck's
   * group is exactly the case that changes: spoken for before the press, this deck's after it.
   * `lib/query.ts` caches 30 s, so a missing root here is a badge that reads from before the
   * press with nothing on screen to say so.
   */
  it("invalidates the collection, every deck and the card search", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    await act(async () => {
      await result.current.move.mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 });
    });

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["collection"]));
    expect(keys).toContain(JSON.stringify(["decks"]));
    expect(keys).toContain(JSON.stringify(["cards", "search"]));
  });

  /**
   * **The census is read here rather than threaded down from the editor**, and this is the whole
   * of why: `collection_to_deck` hardcodes `LIVE`, so the list the fence has to be built from is
   * the deck's live one whatever variant the editor happens to be drawing. The assertion is that
   * the hook asks for it at all — a fence built from a prop would ask nothing.
   */
  it("reads the deck's own live census", async () => {
    mount();

    await waitFor(() => expect(deckPlayedKeys).toHaveBeenCalled());
    expect(deckPlayedKeys.mock.calls[0][0]).toBe(DECK_ID);
  });

  /**
   * **Fail closed while the census is in flight** — `CollectionPage.tsx`'s `stepperByTile` argues
   * this direction in full, and the failure it names is exactly this one: a control that is live
   * for the length of one query and greys afterwards is worse than one that was never live,
   * because the reader has already reached for it.
   *
   * The two ends are both asserted, because only the pair can fail: a hook that answered `unread`
   * for ever would pass the first half and grey the whole wall.
   */
  it("greys every tile until the census answers, then opens", async () => {
    let answer: (keys: string[]) => void = () => undefined;
    deckPlayedKeys.mockReturnValue(new Promise<string[]>((resolve) => (answer = resolve)));
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    expect(result.current.playStateOf(BOLT_TILE)).toBe("unread");

    act(() => answer([BOLT.oracleId!]));

    await waitFor(() => expect(result.current.playStateOf(BOLT_TILE)).toBe("plays"));
  });

  /**
   * And a census that **failed** is a separate word rather than the same one, because the two
   * sentences differ: a wall that is waiting is about to fix itself and a wall that could not find
   * out is not. Both are closed.
   */
  it("greys the wall when the census cannot be read", async () => {
    deckPlayedKeys.mockRejectedValue(new Error("no such deck"));
    const { result } = mount();

    await waitFor(() => expect(result.current.playStateOf(BOLT_TILE)).toBe("unreadable"));
  });

  /**
   * And on a **refusal** too, for `useCollectionFolders`' reason: the usual refusal is a row
   * something else has already moved or deleted, so the list on screen is the thing that is
   * wrong. Leaving it alone after `GONE` is how a panel comes to offer a copy that is not there.
   */
  it("re-reads after a refused move as well", async () => {
    collectionToDeck.mockRejectedValue(new Error("That row is gone"));
    const { result } = mount();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    await act(async () => {
      await result.current.move
        .mutateAsync({ row: BOLT, categoryId: 3, quantity: 1 })
        .catch(() => undefined);
    });

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
  });
});

/**
 * Where a copy is filed, as the one question the Add button has to answer before it presses.
 *
 * A pure function over the folder census rather than a field on the row: `CollectionRow` carries
 * `folderId` and `folderName` and **not** the folder's `kind`, so "is this copy in a deck" cannot
 * be read off the row at all. `collection_folder_list` is the census and it is already fetched
 * once per window for the card menu.
 */
describe("copySource", () => {
  it("calls the root, a reader's drawer and Recently removed the desk", () => {
    for (const folderId of [null, BINDER.id, REMOVED.id]) {
      expect(copySource(row({ folderId }), FOLDERS, DECK_ID).kind).toBe("desk");
    }
  });

  /** A copy already in this deck's group — `collection_to_deck` refuses it in words
   *  (`ALREADY_HERE`), so the button says so instead of pressing. */
  it("knows a copy this deck already holds", () => {
    const source = copySource(row({ folderId: THIS_GROUP.id }), FOLDERS, DECK_ID);
    expect(source.kind).toBe("here");
  });

  /**
   * **The case the whole confirm exists for, and the name is the load-bearing half**: the side
   * effect lands on a deck the reader is not looking at, so the question has to say which one.
   */
  it("names the other deck a copy is spoken for by", () => {
    const source = copySource(row({ folderId: OTHER_GROUP.id }), FOLDERS, DECK_ID);
    expect(source).toEqual({ kind: "otherDeck", deckName: "Mono-Red Aggro" });
  });

  /** A folder the census has not answered for yet — the first render, before
   *  `collection_folder_list` lands. **The desk is the wrong guess to make here**: it would let
   *  an add slip past the confirm, so an unknown folder is treated as spoken for and named as
   *  best it can be. */
  it("treats a folder it cannot place as spoken for", () => {
    const source = copySource(row({ folderId: 99, folderName: "Somewhere" }), [], DECK_ID);
    expect(source).toEqual({ kind: "otherDeck", deckName: "Somewhere" });
  });

  /**
   * **The coupling, not the behaviour** ([#365](https://github.com/Msgaihede/mtg-grimoire/issues/365)).
   *
   * A locked drawer is `kind: "user"`, so a copy in one falls through to `desk` — *freely
   * movable, nothing asked*. Read on its own that is the wrong answer by this module's own
   * rule: an unclassifiable copy is treated as **spoken for** precisely so an add cannot slip
   * past the confirmation, and a drawer the reader deliberately set aside is that copy.
   *
   * **It is nevertheless correct today, and this test is why it stays correct.** The tab sends
   * `excludeLocked: true` unconditionally, so a locked row never reaches `copySource` at all —
   * the answer below is unreachable rather than wrong. The two halves are asserted **in one
   * test on purpose**: the `desk` answer is only sound while the exclusion holds, and a test
   * that pinned the classification alone would go on passing, green and meaningless, the day
   * somebody put those rows back.
   *
   * So if this fails, do not "fix" the expectation. It means locked copies can now reach this
   * function, and `copySource` owes them a real answer — see its doc comment, and note that a
   * fourth arm is a fourth press, so `pickCopy` and `CollectionSearchTab` owe one too.
   *
   * **It reads `DEFAULT_EXCLUDE_LOCKED` where the payload test above deliberately writes `true`
   * out, and the two are not in disagreement.** That one asks *what went on the wire*, so
   * reading the constant would let it pass against a hook that had stopped sending the field —
   * the defect it exists for. This one asks *what the decision is*, and the constant **is** the
   * decision: flipping it to `false` has to fail something, and this is the something.
   */
  it("has no answer for a locked copy, which is why the tab must never send it one", () => {
    const locked: CollectionFolder = { ...BINDER, id: 14, name: "Graded", locked: true };

    // Half one: unreachable-by-construction. `DEFAULT_ALLOCATION`'s neighbour on the wire.
    expect(DEFAULT_EXCLUDE_LOCKED).toBe(true);

    // Half two: what it *would* say if it ever saw one — the absence of a considered answer.
    expect(copySource(row({ folderId: locked.id }), [...FOLDERS, locked], DECK_ID).kind).toBe(
      "desk",
    );
  });
});

/**
 * Whether the deck's live list plays a card at all — **the second axis of what a press does**, and
 * the one issue #358 added (this tab is assign-only).
 *
 * Pure over the census, so it is a truth table rather than a mounted panel: two inputs, four
 * answers, no DOM and no query behind it. `PlayState`'s doc comment carries the argument for why
 * this is not a fourth `CopySource` arm.
 */
describe("playStateFor", () => {
  const ANSWERED = { isSuccess: true, isError: false };
  const IN_FLIGHT = { isSuccess: false, isError: false };
  const FAILED = { isSuccess: false, isError: true };

  /** The 2XM Bolt in the deck, the Alpha Bolt in the binder — **one oracle card**, and this is the
   *  case the whole `coalesce` exists for. A printing-exact test greys exactly the tile this tab
   *  is for: a copy the reader owns of a card their deck plays. */
  it("matches on the oracle card rather than on the printing", () => {
    const plays = new Set(["o-bolt"]);
    expect(playStateFor({ id: "bolt-2xm", oracleId: "o-bolt" }, plays, ANSWERED)).toBe("plays");
    expect(playStateFor({ id: "bolt-lea", oracleId: "o-bolt" }, plays, ANSWERED)).toBe("plays");
  });

  /** A card the list does not name — the refusal that sends the reader to the Card search tab. */
  it("refuses a card the deck does not play", () => {
    expect(playStateFor({ id: "sol", oracleId: "o-sol" }, new Set(["o-bolt"]), ANSWERED)).toBe(
      "notPlayed",
    );
  });

  /**
   * An **orphan** — a copy whose printing has left `cards`, so it carries no oracle id on either
   * side of the comparison. `coalesce(oracle_id, card_id)` falls back to the printing on *both*
   * sides, so the two still meet; this is that fallback, and it is why `playKey` takes the pair
   * rather than an oracle id.
   */
  it("falls back to the printing for a copy with no oracle id", () => {
    expect(playStateFor({ id: "ghost", oracleId: null }, new Set(["ghost"]), ANSWERED)).toBe(
      "plays",
    );
    expect(playStateFor({ id: "ghost", oracleId: null }, new Set(["o-bolt"]), ANSWERED)).toBe(
      "notPlayed",
    );
  });

  /**
   * **Fail closed on both of the two states that are not an answer**, and note the fixture: the
   * census here *contains* the key, so a permissive reading would say `plays` and the assertion is
   * genuinely about the gate rather than about an empty set. `CollectionPage.tsx`'s
   * `stepperByTile` argues the direction.
   */
  it("greys a card the census has not answered for, even one it would allow", () => {
    const plays = new Set(["o-bolt"]);
    expect(playStateFor({ id: "bolt", oracleId: "o-bolt" }, plays, IN_FLIGHT)).toBe("unread");
    expect(playStateFor({ id: "bolt", oracleId: "o-bolt" }, plays, FAILED)).toBe("unreadable");
  });
});
