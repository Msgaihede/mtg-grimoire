import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuAction, MenuItem, MenuSubmenu } from "@/components/menu/types";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/externalLinks";
import {
  ipc,
  type CollectionFolder,
  type DeckFolder,
  type DeckRow,
  type WishlistFolder,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  buildCardMenu,
  buildCollectionTargetItems,
  buildDeckTargetItems,
  buildWishlistTargetItems,
  CardToDeckProvider,
  DeckTargetSubmenu,
  useCardToDeck,
  useCardToDeckRefusal,
  type CardMenuDeps,
  type CardMenuTarget,
} from "./cardMenu";

/**
 * The three doors out of the app, all three mocked, because the whole subject of this file is
 * **when** they are opened rather than what they say. `@/lib/ipc` keeps its real module for the
 * types and replaces only `ipc`, the way every other suite here mocks it.
 */
// Both of these really do answer a promise, and the menu really does hand it to a `catch` --
// a `vi.fn()` answering `undefined` would be a fake the code under test could not have been
// written against.
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));
const deckList = vi.fn();
const deckFolderList = vi.fn();
const deckGet = vi.fn();
const deckAddCard = vi.fn();
const oracleTagsForPrintings = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardImageUri: vi.fn(),
    deckList: () => deckList(),
    deckFolderList: () => deckFolderList(),
    deckGet: (...args: unknown[]) => deckGet(...args),
    deckAddCard: (...args: unknown[]) => deckAddCard(...args),
    oracleTagsForPrintings: (ids: string[]) => oracleTagsForPrintings(ids),
    // `useDeck` reads the selected marketplace, because a deck is priced at it. Answered so the
    // hook's queries resolve rather than rejecting on a `vi.fn()` that is not there.
    getMarketplace: () => Promise.resolve("tcgplayer"),
    marketplaceFeedStatus: () => Promise.resolve([]),
  },
}));

/**
 * The deck-plays census behind the cabinet's greyed deck rows (issue #358), faked at the module
 * boundary.
 *
 * **Faked rather than driven through `ipc`, because what this file owns is the *use* of that
 * answer and not the answer.** `useDecksPlaying` belongs to `features/decks/useDeckPlays` and is
 * tested there; here it is a spy, which is what lets a test say what the census answered and —
 * the whole point of the `lazy` row — that *building* a menu asked it nothing.
 *
 * **{@link plays} keeps the hook's contract rather than a convenient shortcut.** A deck is in the
 * answer only when it holds **every** key it was handed. A fake that ORed them would let the group
 * case below pass against a picker that had stopped intersecting, which is the one thing that case
 * exists to catch.
 */
const decksPlaying = vi.fn();
vi.mock("@/features/decks/useDeckPlays", () => ({
  // The documented key: the oracle card, or the printing where `cards` has never heard of it.
  playKey: (card: { oracleId: string | null; cardId: string }) => card.oracleId ?? card.cardId,
  useDecksPlaying: (keys: readonly string[]) => decksPlaying(keys),
}));

/** What the census answers: deck id → the play keys that deck's live list holds. */
function plays(byDeck: Record<number, readonly string[]>) {
  decksPlaying.mockImplementation((keys: readonly string[]) => ({
    deckIds: new Set(
      Object.entries(byDeck)
        .filter(([, held]) => keys.every((key) => held.includes(key)))
        .map(([id]) => Number(id)),
    ),
    // **`pending`, and not a `query` object**, because that is what the picker reads: the hook
    // exposes `query.isPending && query.fetchStatus !== "idle"` under this name precisely so a
    // caller cannot mistake a *disabled* query for a loading one. A fake offering `query` instead
    // would let the picker go back to the raw flag with nothing going red.
    pending: false,
  }));
}

/** The census still in flight. `deckIds` is empty because a pending query has no data — the point
 *  is that the picker must not draw rows off it, greyed or otherwise. */
function censusPending() {
  decksPlaying.mockReturnValue({ deckIds: new Set<number>(), pending: true });
}

/**
 * Mount a `lazy` row's body — what a reader does by expanding it, and the only way to see the rows
 * behind `Decks` now that a query decides them.
 *
 * No cascade around it, which is `DeckTargetSubmenu`'s own tests' shape: `MenuRows` outside a menu
 * draws the rows and runs what is pressed, which is exactly the half being asserted.
 */
function expand(item: MenuItem) {
  if (item.kind !== "lazy") {
    throw new Error(`${"label" in item ? item.label : item.kind} is ${item.kind}, not lazy`);
  }
  render(<item.Content onDone={vi.fn()} />);
}

/** The rows the expanded body drew, in order. A greyed row's `reason` is part of its text, so a
 *  name is matched rather than compared where one is expected — see the greying cases. */
function drawnRows(): string[] {
  return screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
}

const BOLT: CardMenuTarget = {
  cardId: "bolt-lea",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  oracleId: "o-bolt",
  finishes: '["nonfoil"]',
};

/**
 * One wishlist folder.
 *
 * Module-level and named for its own cabinet rather than declared inside the picker's `describe`,
 * because two blocks need it — the wishlist picker's own tests and the `buildCardMenu` row that
 * turns into a submenu the moment one of these exists — and the deck gallery's `folder` helper
 * further down builds a `DeckFolder`. Two `folder`s in one file, one shadowing the other, is the
 * kind of thing that reads as a typo forever.
 */
const wishFolder = (
  id: number,
  name: string,
  parentId: number | null = null,
  sortOrder = 0,
): WishlistFolder => ({ id, parentId, name, sortOrder });

/**
 * One collection folder, the reader's own unless a test says otherwise.
 *
 * `kind` last and defaulted, because it is the field this cabinet has that the other two do not
 * and only the filter tests care what it is — every other test here is about a drawer somebody
 * made and named.
 */
const binder = (
  id: number,
  name: string,
  parentId: number | null = null,
  sortOrder = 0,
  kind = "user",
): CollectionFolder => ({ id, parentId, name, kind, deckId: null, sortOrder });

/**
 * One deck's group — the app's own folder, carrying the deck it stands for.
 *
 * `binder` cannot build one: it writes `deckId: null`, which is right for every other kind and is
 * the half of the schema's `CHECK` that makes a `deck` folder without a deck impossible. A helper
 * that took a fifth optional argument would let a test write that impossible row by accident.
 */
const deckGroup = (
  id: number,
  name: string,
  deckId: number,
  sortOrder = 0,
): CollectionFolder => ({ id, parentId: null, name, kind: "deck", deckId, sortOrder });

/** Everything the menu needs that is not the card, with every write a spy. A surface's real
 *  deps are its own; this is the shape, so a test can name the one it is about. */
function deps(over: Partial<CardMenuDeps> = {}): CardMenuDeps {
  return {
    marketplace: MARKETPLACES.tcgplayer,
    addToCollection: vi.fn(),
    addToWishlist: vi.fn(),
    // A wishlist that files nothing, which is every reader who has never made a folder and the
    // case each of these tests was already asserting before folders existed.
    wishlistFolders: [],
    // The same, one cabinet over — and `moveToFolder` left out, because a surface that hands
    // over no `entryId` has no row to move and every one of these targets is a card.
    collectionFolders: [],
    // No `printingsDeck` and no `printingsOracleId`: the shape a *plain* card surface hands
    // over, which is every one of them except the deck editor and the modal itself.
    openAllPrintings: vi.fn(),
    DeckTargetSubmenu: () => null,
    ...over,
  };
}

function labels(items: MenuItem[]): string[] {
  return items.filter((i) => i.kind !== "separator").map((i) => i.label);
}
function find(items: MenuItem[], label: string) {
  const hit = items.find((i) => i.kind !== "separator" && i.label === label);
  if (!hit) throw new Error(`no item ${label} in ${labels(items).join(", ")}`);
  return hit;
}

beforeEach(() => {
  vi.clearAllMocks();
  // **Nothing plays anything until a case says otherwise.** `clearAllMocks` clears calls and not
  // implementations, so without this the census a test set would answer the next one's — and the
  // empty answer is the fail-closed direction, so a case that forgot to arm it greys every deck
  // rather than quietly enabling one.
  plays({});
});

describe("buildCardMenu", () => {
  it("copies the printed name", async () => {
    const items = buildCardMenu(BOLT, deps());
    (find(items, "Copy card name") as MenuAction).onSelect();
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith("Lightning Bolt"));
  });

  it("asks for the display variant's URL only when the item is pressed", async () => {
    const items = buildCardMenu(BOLT, deps());
    // The whole rule: a menu that merely offers the URL must not have fetched it.
    expect(vi.mocked(ipc.cardImageUri)).not.toHaveBeenCalled();

    vi.mocked(ipc.cardImageUri).mockResolvedValue("https://cards.scryfall.io/display/x.webp?1");
    (find(items, "Copy card image") as MenuAction).onSelect();

    await waitFor(() =>
      expect(vi.mocked(ipc.cardImageUri)).toHaveBeenCalledWith("bolt-lea", "display"),
    );
    await waitFor(() =>
      expect(vi.mocked(copyText)).toHaveBeenCalledWith(
        "https://cards.scryfall.io/display/x.webp?1",
      ),
    );
  });

  it("copies nothing when the card has no stored image", async () => {
    vi.mocked(ipc.cardImageUri).mockResolvedValue(null);
    const items = buildCardMenu(BOLT, deps());
    (find(items, "Copy card image") as MenuAction).onSelect();
    await waitFor(() => expect(vi.mocked(ipc.cardImageUri)).toHaveBeenCalled());
    expect(vi.mocked(copyText)).not.toHaveBeenCalled();
  });

  it("offers Scryfall and exactly one marketplace, named for the setting", () => {
    const items = buildCardMenu(BOLT, deps({ marketplace: MARKETPLACES.cardkingdom }));
    const openOn = find(items, "Open on") as MenuSubmenu;
    expect(labels(openOn.items)).toEqual(["Scryfall", "Card Kingdom"]);
  });

  it("opens nothing until the entry is pressed", async () => {
    const items = buildCardMenu(BOLT, deps({ marketplace: MARKETPLACES.cardmarket }));
    const openOn = find(items, "Open on") as MenuSubmenu;
    expect(vi.mocked(openExternal)).not.toHaveBeenCalled();

    (openOn.items[0] as MenuAction).onSelect();
    await waitFor(() =>
      expect(vi.mocked(openExternal)).toHaveBeenCalledWith("https://scryfall.com/card/lea/161"),
    );
  });

  /**
   * The deck slot a surface names, as the deck editor's four views build it — every part of
   * `DECK_CARD_GRAIN`, because a context naming fewer has rewritten the wrong row here before.
   */
  const SLOT = {
    deckId: 4,
    categoryId: 9,
    categoryName: "Ramp",
    cardId: "bolt-lea",
    variant: "live" as const,
    finish: null,
  };

  it("opens the printings modal with no deck slot from a plain surface", () => {
    const openAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ openAllPrintings }));
    (find(items, "View all printings") as MenuAction).onSelect();
    // The card's oracle id, never the printing's: "every printing of this card" is asked by the
    // one field a `Printing` does not carry. The printing rides along beside it — it is the wall's
    // "you are here" ring and how the modal finds its place on a page's walk — and `deck: null` is
    // "there is no slot to write to".
    expect(openAllPrintings).toHaveBeenCalledWith({
      cardId: "bolt-lea",
      oracleId: "o-bolt",
      name: "Lightning Bolt",
      deck: null,
      wish: null,
    });
  });

  it("carries the deck slot the surface named", () => {
    const openAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ openAllPrintings, printingsDeck: SLOT }));
    (find(items, "View all printings") as MenuAction).onSelect();
    // Whole, and not a card id: it is what makes a press in the modal a swap rather than a look.
    expect(openAllPrintings).toHaveBeenCalledWith({
      cardId: "bolt-lea",
      oracleId: "o-bolt",
      name: "Lightning Bolt",
      deck: SLOT,
      wish: null,
    });
  });

  it("disables View all printings for an orphan with no oracle id", () => {
    const items = buildCardMenu({ ...BOLT, oracleId: null }, deps());
    const item = find(items, "View all printings") as MenuAction;
    expect(item.disabled).toBe(true);
    expect(item.reason).toBe("this printing has left the card database");
  });

  /** Inside the modal itself the row would re-ask a question already on screen. */
  it("greys the row on the surface that is already listing that card", () => {
    const openAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ openAllPrintings, printingsOracleId: "o-bolt" }));
    const item = find(items, "View all printings") as MenuAction;

    expect(item.disabled).toBe(true);
    // And **not** the orphan's sentence, which would be false of a perfectly healthy card.
    expect(item.reason).toBe("you are already looking at them");
    item.onSelect();
    expect(openAllPrintings).not.toHaveBeenCalled();
  });

  /**
   * A different oracle card in the same modal — a menu on some other card — still routes. The
   * fence is an oracle comparison rather than the printing one it replaced, so *this* is the
   * case that would silently grey every row if it were written on `cardId`.
   */
  it("stays live for a different card than the one being listed", () => {
    const openAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ openAllPrintings, printingsOracleId: "o-shock" }));
    const item = find(items, "View all printings") as MenuAction;

    expect(item.disabled).toBeUndefined();
    item.onSelect();
    expect(openAllPrintings).toHaveBeenCalled();
  });

  /** The same list, reached from another printing of it — one modal, not a second one. */
  it("greys the row for a different printing of the card being listed", () => {
    const items = buildCardMenu(
      { ...BOLT, cardId: "bolt-2ed", setCode: "2ed" },
      deps({ printingsOracleId: "o-bolt" }),
    );
    expect((find(items, "View all printings") as MenuAction).disabled).toBe(true);
  });

  it("adds one copy silently when the printing has one finish", () => {
    const addToCollection = vi.fn();
    const items = buildCardMenu(BOLT, deps({ addToCollection }));
    const addTo = find(items, "Add to") as MenuSubmenu;
    const collection = find(addTo.items, "Collection");
    expect(collection.kind).toBe("action");
    (collection as MenuAction).onSelect();
    // `null` is the root of the collection, spelled out rather than defaulted: the folder is
    // part of the row's storage grain, so a destination the caller did not choose is a second
    // row rather than a wrong drawer.
    expect(addToCollection).toHaveBeenCalledWith(BOLT, "nonfoil", null);
  });

  it("offers a finish submenu when the printing has more than one and the surface named none", () => {
    const target = { ...BOLT, finishes: '["nonfoil","foil"]' };
    const addTo = find(buildCardMenu(target, deps()), "Add to") as MenuSubmenu;
    const collection = find(addTo.items, "Collection") as MenuSubmenu;
    expect(collection.kind).toBe("submenu");
    expect(labels(collection.items)).toEqual(["Nonfoil", "Foil"]);
  });

  it("uses the surface's own finish without asking", () => {
    const addToCollection = vi.fn();
    const target: CardMenuTarget = { ...BOLT, finishes: '["nonfoil","foil"]', finish: "foil" };
    const addTo = find(buildCardMenu(target, deps({ addToCollection })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Collection") as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "foil", null);
  });

  it("treats a null finishes column as nonfoil rather than as no finishes at all", () => {
    // `null` means the column is empty -- unknown, not "this printing has no finishes".
    const addToCollection = vi.fn();
    const target = { ...BOLT, finishes: null };
    const addTo = find(buildCardMenu(target, deps({ addToCollection })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Collection") as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "nonfoil", null);
  });

  it("wishes for the exact printing", () => {
    const addToWishlist = vi.fn();
    const addTo = find(buildCardMenu(BOLT, deps({ addToWishlist })), "Add to") as MenuSubmenu;
    const wishlist = find(addTo.items, "Wishlist");
    // **One row and one press for a reader who has never made a folder**, which is the
    // overwhelming majority of them and the shape this row had before folders existed. `null`
    // is the root wishlist, spelled out because the argument is not optional.
    expect(wishlist.kind).toBe("action");
    (wishlist as MenuAction).onSelect();
    expect(addToWishlist).toHaveBeenCalledWith(BOLT, null);
  });

  it("opens the wishlist into a picker once there are folders to file into", () => {
    const addToWishlist = vi.fn();
    const addTo = find(
      buildCardMenu(BOLT, deps({ addToWishlist, wishlistFolders: [wishFolder(1, "Expensive")] })),
      "Add to",
    ) as MenuSubmenu;
    const wishlist = find(addTo.items, "Wishlist") as MenuSubmenu;
    // `submenu` rather than `lazy`: the folder list is one small query the page already holds,
    // so there is nothing for a right-click to fire.
    expect(wishlist.kind).toBe("submenu");
    expect(labels(wishlist.items)).toEqual(["Wishlist", "Expensive"]);
    (wishlist.items[2] as MenuAction).onSelect();
    // The target rides through the closure the row was built with, so a folder press is the
    // same add as the root one with a different destination.
    expect(addToWishlist).toHaveBeenCalledWith(BOLT, 1);
  });

  it("puts the deck picker behind a lazy row", () => {
    const addTo = find(buildCardMenu(BOLT, deps()), "Add to") as MenuSubmenu;
    const deck = find(addTo.items, "Deck");
    // Lazy, so the folder tree and the deck list are fetched on expand and never on open.
    expect(deck.kind).toBe("lazy");
  });

  it("opens the collection into a picker once there are folders to file into", () => {
    const addToCollection = vi.fn();
    const addTo = find(
      buildCardMenu(BOLT, deps({ addToCollection, collectionFolders: [binder(1, "Binder")] })),
      "Add to",
    ) as MenuSubmenu;
    const collection = find(addTo.items, "Collection") as MenuSubmenu;
    // `submenu` rather than `lazy`, the wishlist's rule: the folder list is one small query the
    // page already holds, so there is nothing for a right-click to fire.
    expect(collection.kind).toBe("submenu");
    expect(labels(collection.items)).toEqual(["Collection", "Binder"]);

    (collection.items[2] as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(BOLT, "nonfoil", 1);
  });

  /**
   * The two questions compose rather than flattening: which piece of cardboard, then which
   * drawer. A flat list would be `finishes × folders` rows and would grow with every folder.
   */
  /**
   * **Through `buildCardMenu`, not through `buildCollectionTargetItems` — which is the whole
   * point of this test.** Every other case for the app's own folders calls that builder directly
   * and hands it a list carrying a deck group, so every one of them passed while the shipped
   * window drew no `Decks` submenu at all.
   *
   * What the direct calls could not see is what `collectionItem` *passes*: it holds a
   * `userFolders(...)` list for its own "is there a cabinet at all" guard, and it handed that
   * same filtered list to the builder — so the app section looked for `kind = 'deck'` rows in a
   * list they had already been stripped from. Found by driving the real app against a database
   * with three deck groups in the pinned band, one panel away from an empty picker.
   */
  it("offers the deck groups through the whole menu, not only through the builder", async () => {
    const user = userEvent.setup();
    const toDeck = vi.fn();
    plays({ 7: ["o-bolt"] });
    const addTo = find(
      buildCardMenu(
        BOLT,
        deps({
          toDeck,
          collectionFolders: [binder(1, "Binder"), deckGroup(20, "Mono-Red Aggro", 7)],
        }),
      ),
      "Add to",
    ) as MenuSubmenu;
    const collection = find(addTo.items, "Collection") as MenuSubmenu;

    // `lazy` since issue #358: the rows behind it are decided by a census of what each deck plays,
    // and that is a backend read this menu may not make until the reader expands the row.
    const decks = find(collection.items, "Decks");
    expect(decks.kind).toBe("lazy");
    expand(decks);
    expect(drawnRows()).toEqual(["Mono-Red Aggro"]);

    await user.click(screen.getByRole("menuitem", { name: /Mono-Red Aggro/ }));
    // The **deck** id, never the group's folder id — the row writes through the deck's own add.
    expect(toDeck).toHaveBeenCalledWith(BOLT, 7);
  });

  /**
   * **The rule the whole `lazy` kind exists for, asserted at the outermost level.** A right-click
   * on a tile in a wall of forty builds this array; if the census were asked here it would be
   * asked forty times over a wall the reader is only scanning. `Add to → Deck` one row up is
   * pinned the same way by "puts the deck picker behind a lazy row"; this is the cabinet's copy,
   * and it is the assertion that would go red if the `Decks` row ever went back to `submenu`
   * with the greying computed eagerly.
   */
  it("asks the deck census nothing while the menu is merely built", () => {
    buildCardMenu(
      BOLT,
      deps({
        toDeck: vi.fn(),
        collectionFolders: [binder(1, "Binder"), deckGroup(20, "Mono-Red Aggro", 7)],
      }),
    );
    expect(decksPlaying).not.toHaveBeenCalled();
  });

  it("asks for the finish first and the folder second when the printing has two", () => {
    const addToCollection = vi.fn();
    const target = { ...BOLT, finishes: '["nonfoil","foil"]' };
    const addTo = find(
      buildCardMenu(target, deps({ addToCollection, collectionFolders: [binder(1, "Binder")] })),
      "Add to",
    ) as MenuSubmenu;
    const collection = find(addTo.items, "Collection") as MenuSubmenu;
    expect(labels(collection.items)).toEqual(["Nonfoil", "Foil"]);

    const foil = find(collection.items, "Foil") as MenuSubmenu;
    expect(foil.kind).toBe("submenu");
    expect(labels(foil.items)).toEqual(["Collection", "Binder"]);
    (foil.items[2] as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "foil", 1);
  });

  /**
   * A copy already in the binder is moved, never added — a second add would be a second row,
   * because the folder is part of the storage grain.
   */
  it("offers Move to for a row the surface can name, and files it where the reader points", () => {
    const moveToFolder = vi.fn();
    const items = buildCardMenu(
      { ...BOLT, entryId: 42 },
      deps({ moveToFolder, collectionFolders: [binder(1, "Binder")] }),
    );
    const move = find(items, "Move to") as MenuSubmenu;
    expect(labels(move.items)).toEqual(["Collection", "Binder"]);

    (move.items[2] as MenuAction).onSelect();
    expect(moveToFolder).toHaveBeenCalledWith(42, 1);
    // The root is a destination and not an omission — the only way back out of a folder.
    (move.items[0] as MenuAction).onSelect();
    expect(moveToFolder).toHaveBeenCalledWith(42, null);
  });

  /**
   * The three absences that leave the row out — and **out rather than greyed**, because it is
   * missing from every card of a surface that has no rows, so it reads as a fact about the
   * surface rather than about the card. `find` throws on a missing label, so each assertion is
   * on the label list.
   */
  it("leaves Move to out where the surface can name no row", () => {
    const items = buildCardMenu(
      BOLT,
      deps({ moveToFolder: vi.fn(), collectionFolders: [binder(1, "Binder")] }),
    );
    expect(labels(items)).not.toContain("Move to");
  });

  it("leaves Move to out where the surface wired no write", () => {
    const items = buildCardMenu(
      { ...BOLT, entryId: 42 },
      deps({ collectionFolders: [binder(1, "Binder")] }),
    );
    expect(labels(items)).not.toContain("Move to");
  });

  it("leaves Move to out for a reader who has made no folder", () => {
    // With no cabinet the only destination is the root, which is where every unfiled copy
    // already is — the whole row would be a press that does nothing.
    const items = buildCardMenu({ ...BOLT, entryId: 42 }, deps({ moveToFolder: vi.fn() }));
    expect(labels(items)).not.toContain("Move to");
  });

  /**
   * A **tile** is the collection wall's summary of one printing — every entry of it, across
   * finishes, conditions and drawers, drawn as one piece of cardboard. It names `entryIds` where
   * a table row names `entryId`, and the difference is not cosmetic: several rows is a *question*
   * about which copies the reader meant, and only the surface can ask it.
   */
  describe("Move to for a target that stands for several rows", () => {
    it("asks which copies rather than filing all of them", () => {
      const moveToFolder = vi.fn();
      const pickCopies = vi.fn();
      const items = buildCardMenu(
        { ...BOLT, entryIds: [4, 9] },
        deps({ moveToFolder, pickCopies, collectionFolders: [binder(1, "Binder")] }),
      );
      const move = find(items, "Move 2 cards to") as MenuSubmenu;

      (find(move.items, "Binder") as MenuAction).onSelect();
      expect(pickCopies).toHaveBeenCalledWith([4, 9], 1);
      // The whole point: nothing is filed until the reader has said which copies.
      expect(moveToFolder).not.toHaveBeenCalled();
    });

    it("files a tile that stands for exactly one row without asking", () => {
      // One id is the copy the reader pointed at, so there is no question — and this is the path
      // the collection's table has always taken.
      const moveToFolder = vi.fn();
      const pickCopies = vi.fn();
      const items = buildCardMenu(
        { ...BOLT, entryIds: [4] },
        deps({ moveToFolder, pickCopies, collectionFolders: [binder(1, "Binder")] }),
      );
      const move = find(items, "Move to") as MenuSubmenu;

      (find(move.items, "Binder") as MenuAction).onSelect();
      expect(moveToFolder).toHaveBeenCalledWith(4, 1);
      expect(pickCopies).not.toHaveBeenCalled();
    });

    it("loops the write where the surface wired no dialog", () => {
      // Today's behaviour for a multi-picked set, kept: falling through to nothing would take a
      // working row off a surface that never had a question to ask.
      const moveToFolder = vi.fn();
      const items = buildCardMenu(
        { ...BOLT, entryIds: [4, 9] },
        deps({ moveToFolder, collectionFolders: [binder(1, "Binder")] }),
      );
      const move = find(items, "Move 2 cards to") as MenuSubmenu;

      (find(move.items, "Binder") as MenuAction).onSelect();
      expect(moveToFolder.mock.calls).toEqual([
        [4, 1],
        [9, 1],
      ]);
    });

    it("leaves Move to out for a tile that names no rows at all", () => {
      // An empty list is a printing the page summed nothing into, which is not a thing the wall
      // draws — but it must read as "no row to move" rather than as one.
      const items = buildCardMenu(
        { ...BOLT, entryIds: [] },
        deps({ moveToFolder: vi.fn(), collectionFolders: [binder(1, "Binder")] }),
      );
      expect(labels(items)).not.toContain("Move to");
    });
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The deck picker
 * ------------------------------------------------------------------------------------------ */

const deck = (over: Partial<DeckRow> & { id: number; name: string }): DeckRow => ({
  gameKey: "any",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  archived: false,
  cardCount: 0,
  updatedAt: 0,
  folderId: null,
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
  bracket: 0,
  ...over,
});

const folder = (
  id: number,
  name: string,
  parentId: number | null = null,
  sortOrder = 0,
): DeckFolder => ({ id, parentId, name, sortOrder });

describe("buildDeckTargetItems", () => {
  it("keeps the reader's own folder order and sorts only the decks", () => {
    // `Standard` sorts first here and `Commander` second, which is the order the reader
    // arranged in the gallery and the reverse of the alphabet -- a folder tree is an
    // arrangement the reader made, which is the kind of list `src/lib/options.ts` exempts.
    // The loose decks are alphabetical.
    const items = buildDeckTargetItems(
      [folder(2, "Standard", null, 0), folder(1, "Commander", null, 1)],
      [
        deck({ id: 10, name: "Zoo", folderId: 1 }),
        deck({ id: 11, name: "Affinity", folderId: 2 }),
        deck({ id: 12, name: "Tron" }),
        deck({ id: 13, name: "Belcher" }),
      ],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Standard", "Commander", "Belcher", "Tron"]);
  });

  it("leaves archived decks out", () => {
    const items = buildDeckTargetItems(
      [],
      [deck({ id: 10, name: "Shelved", archived: true }), deck({ id: 11, name: "Burn" })],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Burn"]);
  });

  it("drops a folder that would open onto nothing", () => {
    // An empty drawer is a row that opens onto an empty panel, which is worse than no row.
    const items = buildDeckTargetItems([folder(1, "Empty")], [], vi.fn());
    expect(items).toEqual([]);
  });

  it("nests a deck under its folder", () => {
    const items = buildDeckTargetItems(
      [folder(1, "Commander"), folder(2, "Cedh", 1)],
      [deck({ id: 10, name: "Krenko", folderId: 2 })],
      vi.fn(),
    );
    const commander = find(items, "Commander") as MenuSubmenu;
    const cedh = find(commander.items, "Cedh") as MenuSubmenu;
    expect(labels(cedh.items)).toEqual(["Krenko"]);
  });

  it("files a deck whose folder has gone at the root", () => {
    // `buildFolderTree` resolves a missing parent towards the root; a deck has to resolve the
    // same way, or it is a deck with no row anywhere in the picker.
    const items = buildDeckTargetItems([], [deck({ id: 10, name: "Burn", folderId: 99 })], vi.fn());
    expect(labels(items)).toEqual(["Burn"]);
  });

  it("adds to the live list without asking when the deck keeps no theory list", () => {
    const choose = vi.fn();
    const items = buildDeckTargetItems([], [deck({ id: 10, name: "Burn" })], choose);
    const row = find(items, "Burn") as MenuAction;
    expect(row.kind).toBe("action");
    row.onSelect();
    expect(choose).toHaveBeenCalledWith(10, "live");
  });

  it("asks Theory before Actual for a deck that keeps both", () => {
    const choose = vi.fn();
    const items = buildDeckTargetItems(
      [],
      [deck({ id: 10, name: "Burn", theoryEnabled: true })],
      choose,
    );
    const row = find(items, "Burn") as MenuSubmenu;
    // Theory first, and deliberately not alphabetical: it is the list a deck's cards are in
    // once theory is switched on, so it is the likelier target of the two. **Not the editor's
    // tab order any more** — that reads `Live | Theory` since 2026-08-24, and this did not follow
    // it: a ranked guess and a strip a reader reads left to right are different questions.
    expect(labels(row.items)).toEqual(["Theory", "Actual"]);
    (row.items[0] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(10, "theory");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The wishlist picker
 * ------------------------------------------------------------------------------------------ */

describe("buildWishlistTargetItems", () => {
  it("offers the root first, then the folders", () => {
    const items = buildWishlistTargetItems([wishFolder(1, "Ordered")], vi.fn());
    expect(items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Wishlist",
      "separator",
      "Ordered",
    ]);
  });

  it("offers a folder with nothing in it", () => {
    // Unlike `deckLevel`, which drops an empty folder: a folder there is a container of
    // destinations, and here it IS the destination.
    expect(buildWishlistTargetItems([wishFolder(1, "Empty")], vi.fn())).toHaveLength(3);
  });

  it("draws a folder with children as a submenu whose first row is the folder itself", () => {
    const items = buildWishlistTargetItems(
      [wishFolder(1, "Expensive"), wishFolder(2, "Someday", 1)],
      vi.fn(),
    );
    const expensive = items.find((i) => "label" in i && i.label === "Expensive");
    expect(expensive?.kind).toBe("submenu");
    expect((expensive as MenuSubmenu).items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Expensive",
      "separator",
      "Someday",
    ]);
  });

  it("passes the folder id to the chooser, and null for the root", () => {
    const choose = vi.fn();
    const items = buildWishlistTargetItems([wishFolder(1, "Ordered")], choose);
    (items[0] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(null);
    (items[2] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(1);
  });

  it("keeps the reader's own folder order rather than the alphabet", () => {
    // The wishlist's cabinet is an arrangement the reader made, which is one of the two kinds
    // of list `src/lib/options.ts` exempts -- `buildDeckTargetItems` is exempt for the same
    // reason, and a picker that disagreed with the page would read as a bug.
    const items = buildWishlistTargetItems(
      [wishFolder(2, "Zoo", null, 0), wishFolder(1, "Alpha", null, 1)],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Wishlist", "Zoo", "Alpha"]);
  });
});

describe("buildCollectionTargetItems", () => {
  it("offers the root first, then the folders", () => {
    const items = buildCollectionTargetItems([binder(1, "Binder")], vi.fn());
    expect(items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Collection",
      "separator",
      "Binder",
    ]);
  });

  it("offers a folder with nothing in it", () => {
    // Unlike `deckLevel`, which drops an empty folder: a folder there is a container of
    // destinations, and here it IS the destination -- an empty drawer is where the next card
    // goes, and is what a reader makes a folder for.
    expect(buildCollectionTargetItems([binder(1, "Empty")], vi.fn())).toHaveLength(3);
  });

  it("draws a folder with children as a submenu whose first row is the folder itself", () => {
    const items = buildCollectionTargetItems([binder(1, "Binder"), binder(2, "Rares", 1)], vi.fn());
    const outer = items.find((i) => "label" in i && i.label === "Binder");
    expect(outer?.kind).toBe("submenu");
    // Its own row first, so a parent folder is always pickable -- otherwise "Binder" would be
    // the one folder in the cabinet a card cannot be filed into.
    expect((outer as MenuSubmenu).items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Binder",
      "separator",
      "Rares",
    ]);
  });

  it("passes the folder id to the chooser, and null for the root", () => {
    const choose = vi.fn();
    const items = buildCollectionTargetItems([binder(1, "Binder")], choose);
    (items[0] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(null);
    (items[2] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(1);
  });

  it("keeps the reader's own folder order rather than the alphabet", () => {
    const items = buildCollectionTargetItems(
      [binder(2, "Zoo", null, 0), binder(1, "Alpha", null, 1)],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Collection", "Zoo", "Alpha"]);
  });

  /**
   * The one thing this cabinet has that the other two do not. A deck's folder and the
   * removed-cards folder are places cards **are** — so the list command answers them and a page
   * draws them — but filing into one by hand asserts something the app is responsible for, and
   * `collection_set_folder` refuses both in words. A menu whose rows are refusals teaches
   * nothing.
   */
  it("offers only the folders the reader made", () => {
    const items = buildCollectionTargetItems(
      [
        binder(1, "Binder"),
        binder(2, "Mono red", null, 1, "deck"),
        binder(3, "Recently removed", null, 2, "removed"),
      ],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Collection", "Binder"]);
  });

  /**
   * A state `create_folder` refuses to write — a folder the reader made inside one the app owns
   * — so this pins what the picker does with a database that somehow holds one. The kind filter
   * runs **before** the tree is built, so the child's parent is simply not in the list and
   * `buildFolderTree`'s standing rule applies: resolve towards the **root**, never towards
   * nothing. Dropping it would hide a real folder with nothing anywhere pointing at it.
   */
  it("files a folder whose parent the filter removed at the root", () => {
    const items = buildCollectionTargetItems(
      [binder(1, "Mono red", null, 0, "deck"), binder(2, "Sideboard", 1)],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Collection", "Sideboard"]);
  });

  /**
   * The app's own folders, which are the ledger rather than the cabinet — *this deck holds these
   * copies*, *these copies have left the collection*. They are offered only to a surface that has
   * wired the sanctioned write, and never as a folder id.
   */
  describe("the app's own folders", () => {
    /** The one card every case here is filing, and the key {@link plays} answers about. */
    const ONE = [BOLT] as const;

    it("draws none of them where the surface offers no deck row", () => {
      // The third argument absent is every caller that existed before this row did, and the
      // picker they get is the one they have always had.
      const items = buildCollectionTargetItems(
        [binder(1, "Binder"), deckGroup(2, "Mono red", 4)],
        vi.fn(),
      );
      expect(labels(items)).toEqual(["Collection", "Binder"]);
    });

    it("draws them after the reader's own folders, behind a rule", () => {
      const items = buildCollectionTargetItems(
        [binder(1, "Binder"), deckGroup(2, "Mono red", 4)],
        vi.fn(),
        { toDeck: vi.fn(), targets: ONE },
      );
      expect(items.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
        "Collection",
        "separator",
        "Binder",
        "separator",
        "Decks",
        "Recently removed",
      ]);
    });

    /**
     * **`lazy`, not `submenu`, and nothing is asked to build it** — issue #358. The rows behind
     * `Decks` are decided by {@link decksPlaying}, which is a backend read; a right-click on a
     * wall of forty tiles builds forty of these arrays and must fire none of them.
     */
    it("puts the deck groups behind a lazy row and asks the census nothing to build it", () => {
      const items = buildCollectionTargetItems([deckGroup(2, "Mono red", 4)], vi.fn(), {
        toDeck: vi.fn(),
        targets: ONE,
      });
      expect(find(items, "Decks").kind).toBe("lazy");
      expect(decksPlaying).not.toHaveBeenCalled();
    });

    /**
     * **A deck row hands over the deck, never the folder.** `set_entry_folder` calls
     * `user_folder` on its destination and answers `FOLDER_NOT_YOURS` for a group; a copy reaches
     * one only through `collection_to_deck`, which writes the `deck_cards` row in the same
     * transaction. Calling `choose` here would file copies into a deck that does not list them.
     */
    it("hands the deck id to toDeck and leaves the folder chooser alone", async () => {
      const user = userEvent.setup();
      const choose = vi.fn();
      const toDeck = vi.fn();
      plays({ 4: ["o-bolt"] });
      const items = buildCollectionTargetItems(
        [binder(1, "Binder"), deckGroup(2, "Mono red", 4)],
        choose,
        { toDeck, targets: ONE },
      );
      expand(find(items, "Decks"));
      expect(drawnRows()).toEqual(["Mono red"]);

      const row = screen.getByRole("menuitem", { name: /Mono red/ });
      // Live, because the deck's list already plays the card — the other half of the fence below.
      expect(row).not.toHaveAttribute("aria-disabled");
      await user.click(row);
      expect(toDeck).toHaveBeenCalledWith(4);
      // The folder id 2 is the group's, and nothing may ever pass it to a folder write.
      expect(choose).not.toHaveBeenCalled();
    });

    /**
     * **Issue #358's whole point.** A deck group means *this deck holds these copies*, so aiming a
     * card at one the deck does not play would file custody for a card the list says nothing
     * about. The row is greyed rather than dropped, `Recently removed`'s argument: the deck is on
     * the page behind the menu and in the pinned band, so a group that vanished would read as a
     * picker that lost a deck rather than as a fact about the card.
     */
    it("greys a deck whose list does not play the card, and says why", async () => {
      const user = userEvent.setup();
      const toDeck = vi.fn();
      // The deck plays something, just not this card — an empty deck and a deck that plays other
      // things must grey the same way, and only the second says the census was consulted at all.
      plays({ 4: ["o-something-else"] });
      const items = buildCollectionTargetItems([deckGroup(2, "Mono red", 4)], vi.fn(), {
        toDeck,
        targets: ONE,
      });
      expand(find(items, "Decks"));

      const row = screen.getByRole("menuitem", { name: /Mono red/ });
      expect(row).toHaveAttribute("aria-disabled", "true");
      // A phrase, because a row is as wide as its widest content — `MenuAction.reason`'s rule.
      expect(row).toHaveTextContent("not in this deck");

      await user.click(row);
      expect(toDeck).not.toHaveBeenCalled();
    });

    /**
     * **Every target, never any.** A press writes one add per card, so a deck that plays three of
     * four would take the three and leave the fourth — one press, one menu closing, and nothing on
     * screen saying half of it did not happen. The picker hands the census *all* the keys and
     * greys on its answer; {@link plays} intersects, which is the hook's own contract.
     */
    it("greys a deck that plays only some of a picked set", async () => {
      const user = userEvent.setup();
      const toDeck = vi.fn();
      const HELIX: CardMenuTarget = { ...BOLT, cardId: "helix-arn", oracleId: "o-helix" };
      plays({ 4: ["o-bolt"], 5: ["o-bolt", "o-helix"] });
      const items = buildCollectionTargetItems(
        [deckGroup(2, "Half of it", 4), deckGroup(3, "Both", 5)],
        vi.fn(),
        { toDeck, targets: [BOLT, HELIX] },
      );
      expand(find(items, "Decks"));

      // Both keys reached the census — a picker that asked about the first card only would grey
      // exactly the same way here and be wrong about every other pair.
      expect(decksPlaying).toHaveBeenCalledWith(["o-bolt", "o-helix"]);
      expect(screen.getByRole("menuitem", { name: /Half of it/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      const both = screen.getByRole("menuitem", { name: /Both/ });
      expect(both).not.toHaveAttribute("aria-disabled");
      await user.click(both);
      expect(toDeck).toHaveBeenCalledWith(5);
    });

    /**
     * **Fail closed while the census is in flight.** Drawing rows off a pending query is drawing
     * them off no data: they would each be pressable for one frame and then grey under the
     * pointer. `CollectionPage.tsx`'s `stepperByTile` argues the same direction for the same class
     * of control — a tile whose rows the wall cannot vouch for gets no stepper at all, because a
     * control drawn before its fence is known is a control that writes past it.
     */
    it("draws a note rather than pressable rows while the census is loading", () => {
      censusPending();
      const items = buildCollectionTargetItems([deckGroup(2, "Mono red", 4)], vi.fn(), {
        toDeck: vi.fn(),
        targets: ONE,
      });
      expand(find(items, "Decks"));

      expect(screen.getByText("Checking your decks…")).toBeInTheDocument();
      // Not "greyed rows": no deck row is drawn at all, so there is nothing for a press to land
      // on and nothing that could stop being greyed a frame later.
      expect(screen.queryByRole("menuitem", { name: /Mono red/ })).not.toBeInTheDocument();
    });

    it("omits the Decks submenu where there is no deck group", () => {
      // `deckLevel`'s rule rather than the folder tree's: a row that opens onto nothing is a
      // promise with no destination behind it. `Recently removed` stays, because it is a place
      // cards go whether or not the reader keeps a deck.
      const items = buildCollectionTargetItems([binder(1, "Binder")], vi.fn(), {
        toDeck: vi.fn(),
        targets: ONE,
      });
      expect(labels(items)).not.toContain("Decks");
      expect(labels(items)).toContain("Recently removed");
    });

    /**
     * Schema v25 writes `sort_order = 0` on every group it creates, so the backend's
     * `ORDER BY sort_order, id` is deck-**id** order — the order the decks happened to be made
     * in. `PinnedFolders` sorts these by name for that reason and this picker follows it, while
     * the reader's own tree keeps the backend's order because there `sort_order` is theirs.
     */
    it("orders deck groups by name rather than by the order the decks were made", () => {
      // Both at `sort_order` 0, which is what v25 writes, so nothing but the name can order them.
      // Both playing the card too, so the order is read off live rows rather than off a reason.
      plays({ 9: ["o-bolt"], 1: ["o-bolt"] });
      const items = buildCollectionTargetItems(
        [deckGroup(2, "Zoo", 9), deckGroup(3, "Affinity", 1)],
        vi.fn(),
        { toDeck: vi.fn(), targets: ONE },
      );
      expand(find(items, "Decks"));
      expect(drawnRows()).toEqual(["Affinity", "Zoo"]);
    });

    /**
     * **A greyed deck is still in its place in the alphabet.** The order is a fact about the
     * groups, not about which of them this card can go to — a picker that floated the pressable
     * decks would move a row a reader has learnt the position of every time they right-clicked a
     * different card.
     */
    it("keeps a greyed deck in the alphabet rather than sinking it", () => {
      plays({ 9: ["o-bolt"] });
      const items = buildCollectionTargetItems(
        [deckGroup(2, "Zoo", 9), deckGroup(3, "Affinity", 1)],
        vi.fn(),
        { toDeck: vi.fn(), targets: ONE },
      );
      expand(find(items, "Decks"));
      expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
        "Affinitynot in this deck",
        "Zoo",
      ]);
    });

    /**
     * **`Recently removed` is greyed, and it can never stop being.** v25 dropped
     * `deck_allocations`, so a collection entry carries no link to a `deck_cards` row, and a deck
     * may hold one printing in two categories since v18 — there is no unambiguous row a cut could
     * address. The reason on the row is the sanctioned route, which is the only thing drawing a
     * dead row buys.
     */
    it("greys Recently removed and says on the row how to reach it", () => {
      const choose = vi.fn();
      const toDeck = vi.fn();
      const items = buildCollectionTargetItems([binder(1, "Binder")], choose, {
        toDeck,
        targets: ONE,
      });
      const removed = find(items, "Recently removed") as MenuAction;

      expect(removed.disabled).toBe(true);
      // The route, not an apology: the reason has to name the deck editor's cut.
      expect(removed.reason).toMatch(/cut/i);
      expect(removed.reason).toMatch(/deck/i);

      removed.onSelect();
      expect(choose).not.toHaveBeenCalled();
      expect(toDeck).not.toHaveBeenCalled();
    });
  });
});

describe("DeckTargetSubmenu", () => {
  function mount() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CardToDeckProvider>
          <DeckTargetSubmenu targets={[{ ...BOLT, typeLine: "Instant" }]} onDone={vi.fn()} />
        </CardToDeckProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    deckList.mockResolvedValue([deck({ id: 7, name: "Burn" })]);
    deckFolderList.mockResolvedValue([]);
    deckGet.mockResolvedValue({ deck: { id: 7, name: "Burn" }, cards: [], categories: [] });
    deckAddCard.mockResolvedValue(undefined);
    oracleTagsForPrintings.mockResolvedValue([]);
  });

  it("sends the chosen deck and variant to the app's one write", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("menuitem", { name: /Burn/ }));

    // Through the real provider rather than a spy in its place: what a leaf is worth is the
    // write that comes out the far end, deck and variant included.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "live", null, 1),
    );
  });

  it("refuses to render at all where nobody has mounted the write", () => {
    // The fence: a surface wired without the single mount fails on its first render rather than
    // silently swallowing every add a reader makes from it.
    const client = new QueryClient();
    // React logs the thrown render; the throw itself is the assertion.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <DeckTargetSubmenu targets={[BOLT]} onDone={vi.fn()} />
        </QueryClientProvider>,
      ),
    ).toThrow(/CardToDeckProvider/);
    quiet.mockRestore();
  });

  it("says so rather than drawing an empty panel when there are no decks", async () => {
    deckList.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No decks")).toBeInTheDocument();
  });

  it("says the list is still coming rather than that there is nothing in it", () => {
    // `isPending`, never the empty array: a gallery that has not answered and a gallery with
    // nothing in it say opposite things to a reader about to file a card.
    mount();
    expect(screen.getByText("Loading decks…")).toBeInTheDocument();
  });
});

describe("useCardToDeck", () => {
  function arm() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return {
      client,
      ...renderHook(() => useCardToDeck(), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }),
    };
  }

  beforeEach(() => {
    deckGet.mockResolvedValue({ deck: { id: 7, name: "Burn" }, cards: [], categories: [] });
    deckAddCard.mockResolvedValue(undefined);
    oracleTagsForPrintings.mockResolvedValue([]);
  });

  it("adds one copy, naming no category so the app's own rule files the card", async () => {
    const { result } = arm();
    act(() => result.current.addToDeck({ ...BOLT, typeLine: "Instant" }, 7, "theory"));

    // No category id and a type line: `useDeck.addCard`'s `autoCategoryFor` arm, which is the
    // same rule a drag with no column under it and an imported line take.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "theory", null, 1),
    );
    expect(result.current.error).toBeNull();
  });

  it("keeps what a refused add said, for the surface to draw", async () => {
    deckAddCard.mockRejectedValue(new Error("That deck is not there any more"));
    const { result } = arm();
    act(() => result.current.addToDeck({ ...BOLT, typeLine: "Instant" }, 7, "live"));

    await waitFor(() => expect(result.current.error).toBe("That deck is not there any more"));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("adds a second copy when the same leaf is pressed twice", async () => {
    // The once-guard is identity on the armed value, not on the deck: a reader who picks the
    // same deck again means a second copy.
    const { result } = arm();
    const target = { ...BOLT, typeLine: "Instant" };
    act(() => result.current.addToDeck(target, 7, "live"));
    await waitFor(() => expect(deckAddCard).toHaveBeenCalledTimes(1));
    act(() => result.current.addToDeck(target, 7, "live"));
    await waitFor(() => expect(deckAddCard).toHaveBeenCalledTimes(2));
  });

  it("takes last time's refusal down as the next add is armed", async () => {
    deckAddCard.mockRejectedValue(new Error("That deck is not there any more"));
    const { result } = arm();
    act(() => result.current.addToDeck({ ...BOLT, typeLine: "Instant" }, 7, "live"));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    deckAddCard.mockResolvedValue(undefined);
    act(() => result.current.addToDeck({ ...BOLT, typeLine: "Instant" }, 7, "live"));
    // Not after the answer -- at the press. A sentence about the last deck must not stand over
    // the whole of the next add's round trip.
    expect(result.current.error).toBeNull();
  });

  it("stops observing the deck once the add has settled", async () => {
    /**
     * The regression this is here for: `useDeck(id, …)` is a live `deck_get`, and `addCard`
     * invalidates the whole `["decks"]` prefix it sits under — so an armed value left set turns
     * every surface a reader has ever added from into a permanent observer of a deck it does not
     * draw, re-reading it on every deck write in the app. Nothing else in this file would see it:
     * `renderHook` unmounts at the end of a test and no other assertion counts a read.
     */
    const { result, client } = arm();
    act(() => result.current.addToDeck({ ...BOLT, typeLine: "Instant" }, 7, "live"));
    await waitFor(() => expect(deckAddCard).toHaveBeenCalled());
    await waitFor(() => expect(client.isMutating()).toBe(0));

    const readsSoFar = deckGet.mock.calls.length;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["decks"] });
    });
    expect(deckGet).toHaveBeenCalledTimes(readsSoFar);
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The picker inside the real cascade
 * ------------------------------------------------------------------------------------------ */

const KRENKO = deck({ id: 7, name: "Krenko", folderId: 1, theoryEnabled: true });
const COMMANDER = folder(1, "Commander");

/** `AppShell`'s job, in miniature: the one place the refusal sentence is drawn. */
function Refusal() {
  const error = useCardToDeckRefusal();
  return error === null ? null : <p role="alert">{error}</p>;
}

/** One of the ten. It passes `DeckTargetSubmenu` straight through, with no glue at all. */
function Surface() {
  const { menu } = useContextMenu();
  const items = buildCardMenu({ ...BOLT, typeLine: "Instant" }, deps({ DeckTargetSubmenu }));
  return <button onContextMenu={menu(() => items)}>target</button>;
}

/**
 * The real thing: the app's provider, the app's panel, and the picker mounted as the `lazy` body
 * of a menu `buildCardMenu` actually built.
 *
 * **`nesting` is the whole subject of one of the tests below and is `App.tsx`'s arrangement by
 * default.** `ContextMenuProvider` draws its panel as a **sibling** of its children, so a
 * provider mounted *inside* it — which is where `AppShell` sits — is around every view and
 * around none of the menu's rows. That shipped: the picker's leaf threw on every card surface
 * at once while every test here passed, because this harness had the order right and nothing
 * pinned `App.tsx`'s.
 *
 * The deck list and the folder list are **seeded into the cache** rather than awaited. The picker
 * is a consumer of the cascade here, and every assertion below is about the caret and the
 * arrows — a first paint that says `Loading decks…` would put the caret on the panel instead of
 * on a row and make the keyboard walk describe the read's timing rather than the menu's
 * behaviour. Both notes have their own tests above, against the unseeded hooks.
 */
function openCardMenu(nesting: "app" | "under-the-menu" = "app") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["decks", "list"], [KRENKO]);
  client.setQueryData(["decks", "folders"], [COMMANDER]);
  const inner = (
    <>
      <Surface />
      <Refusal />
    </>
  );
  render(
    <QueryClientProvider client={client}>
      {nesting === "app" ? (
        <CardToDeckProvider>
          <ContextMenuProvider>{inner}</ContextMenuProvider>
        </CardToDeckProvider>
      ) : (
        // The shipped mistake: the provider where `AppShell` is, under the menu's own.
        <ContextMenuProvider>
          <CardToDeckProvider>{inner}</CardToDeckProvider>
        </ContextMenuProvider>
      )}
    </QueryClientProvider>,
  );
  screen
    .getByRole("button", { name: "target" })
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/** The root panel is still up. `getByRole("menu")` cannot say so — every open submenu is a
 *  `menu` of its own, which is the point of this whole round. */
function rootMenuIsOpen(): boolean {
  return screen.queryByRole("menuitem", { name: /Copy card name/ }) !== null;
}

/** Down to `Add to`, in, down to `Deck`, in — the four presses that mount the picker. */
const TO_PICKER =
  "{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}" +
  "{ArrowDown}{ArrowDown}{ArrowRight}";

describe("the deck picker inside the real cascade", () => {
  // Restored rather than left, or each `beforeEach` stacks another getter spy on the same
  // property for the length of the file.
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    // jsdom has no layout engine, so `documentElement.clientWidth` is a hard 0 on every element
    // and the panel would place itself against nothing. Stated, and never as `window.innerWidth`.
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    deckList.mockResolvedValue([KRENKO]);
    deckFolderList.mockResolvedValue([COMMANDER]);
    deckGet.mockResolvedValue({ deck: { id: 7, name: "Krenko" }, cards: [], categories: [] });
    deckAddCard.mockResolvedValue(undefined);
    oracleTagsForPrintings.mockResolvedValue([]);
  });

  it("walks a folder, a deck and a variant on the same two arrow keys the panel's own rows use", async () => {
    const user = userEvent.setup();
    openCardMenu();
    await screen.findByRole("menu");
    await user.keyboard(TO_PICKER);

    // A row this file built, drawn by the menu module, with the cascade's own ARIA on it.
    const commander = await screen.findByRole("menuitem", { name: /Commander/ });
    expect(commander).toHaveFocus();
    expect(commander).toHaveAttribute("aria-haspopup", "menu");
    expect(commander).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}");
    expect(commander).toHaveAttribute("aria-expanded", "true");
    const krenko = screen.getByRole("menuitem", { name: /Krenko/ });
    expect(krenko).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Theory" })).toHaveFocus();

    // ...and back out, one level per press, without closing the menu.
    await user.keyboard("{ArrowLeft}");
    expect(krenko).toHaveFocus();
    expect(krenko).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowLeft}");
    expect(commander).toHaveFocus();
    expect(rootMenuIsOpen()).toBe(true);
  });

  it("closes one level per Escape rather than the whole menu", async () => {
    const user = userEvent.setup();
    openCardMenu();
    await screen.findByRole("menu");
    await user.keyboard(TO_PICKER);
    await screen.findByRole("menuitem", { name: /Commander/ });
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Theory" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Theory" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Krenko/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: /Krenko/ })).not.toBeInTheDocument();
    expect(rootMenuIsOpen()).toBe(true);
  });

  it("writes the add after the press has closed the whole menu", async () => {
    const user = userEvent.setup();
    openCardMenu();
    await screen.findByRole("menu");
    await user.keyboard(TO_PICKER);
    await screen.findByRole("menuitem", { name: /Commander/ });
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await user.click(screen.getByRole("menuitem", { name: "Theory" }));

    // The panel is on its way out — `aria-hidden` for the whole exit, so this says "closed or
    // closing" and deliberately not more than that. What proves the write does not belong to the
    // panel is the refusal test below: an answer that arrives after the exit still has somewhere
    // to be said.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "theory", null, 1),
    );
  });

  it("is out of reach when the write is provided under the menu instead of over it", async () => {
    /**
     * **The bug this file did not catch, made into a test.**
     *
     * `ContextMenuProvider` renders its panel as a **sibling** of its children, so a provider
     * around the *shell* is around every view and around none of the menu's rows. Mounted that
     * way, the picker's leaf reaches `useAddCardToDeck`, finds no context and throws — on every
     * card surface at once, at the moment the reader expands "Add to → Deck". Nothing on the page
     * says so; the panel simply dies.
     *
     * The harness above always had the order right, so every test here passed while the shipped
     * `App.tsx` had it wrong. Stating the wrong order explicitly is what closes that.
     */
    const user = userEvent.setup();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    openCardMenu("under-the-menu");
    await screen.findByRole("menu");

    // The picker's own body is what fails, so the throw lands on the expand rather than on the
    // press — the row before the deck tree even draws.
    await expect(user.keyboard(TO_PICKER)).rejects.toThrow(/CardToDeckProvider/);
    expect(deckAddCard).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("leaves a refused add's sentence on the surface, which outlived the menu", async () => {
    const user = userEvent.setup();
    deckAddCard.mockRejectedValue(new Error("That deck is not there any more"));
    openCardMenu();
    await screen.findByRole("menu");
    await user.keyboard(TO_PICKER);
    await screen.findByRole("menuitem", { name: /Commander/ });
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await user.click(screen.getByRole("menuitem", { name: "Theory" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That deck is not there any more");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The Collection row, in the real cascade
 * ------------------------------------------------------------------------------------------ */

describe("the Collection row", () => {
  function Surface() {
    const { menu } = useContextMenu();
    const items = buildCardMenu(BOLT, deps());
    return <button onContextMenu={menu(() => items)}>target</button>;
  }

  function openMenu() {
    render(
      <ContextMenuProvider>
        <Surface />
      </ContextMenuProvider>,
    );
    screen
      .getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  }

  /**
   * The exact name is the assertion, not a regex over it: a greyed row's accessible name carries
   * its reason appended, so `{ name: "Collection" }` is what proves the row is live rather than
   * merely present.
   */
  it("is live, drawn through the real cascade", async () => {
    openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add to" }));

    const row = await screen.findByRole("menuitem", { name: "Collection" });
    expect(row).not.toHaveAttribute("aria-disabled");
  });
});

/**
 * **The plural** — issue #214. When the right-clicked tile is a member of the reader's picked set,
 * the rows that are *writes* act on the whole set and the rest deliberately do not.
 *
 * The set is decided by the surface and arrives as `picked`, so nothing here knows what a
 * selection is; these pin the shape the builder gives one.
 */
describe("buildCardMenu with a picked set", () => {
  const HELIX: CardMenuTarget = {
    cardId: "helix-arn",
    name: "Lightning Helix",
    setCode: "arn",
    collectorNumber: "5",
    oracleId: "o-helix",
    finishes: '["nonfoil"]',
  };
  const PONDER: CardMenuTarget = {
    cardId: "ponder-chk",
    name: "Ponder",
    setCode: "chk",
    collectorNumber: "9",
    oracleId: "o-ponder",
    finishes: '["nonfoil","foil"]',
  };
  const PICKED = [BOLT, HELIX, PONDER];

  const rowsOf = (item: MenuItem) => (item as MenuSubmenu).items;

  it("counts the set on the Add to row", () => {
    expect(labels(buildCardMenu(BOLT, deps({ picked: PICKED })))).toContain("Add 3 cards to");
  });

  /**
   * **A clipboard holds one image, a browser tab opens one page, a printings modal lists one
   * oracle card.** None of the three has a plural that is not a different feature, so all three
   * stay about the tile that was right-clicked — said here rather than left as an absence.
   */
  it("leaves the one-card rows alone", () => {
    const shown = labels(buildCardMenu(BOLT, deps({ picked: PICKED })));
    expect(shown).toContain("Copy card name");
    expect(shown).toContain("Copy card image");
    expect(shown).toContain("Open on");
    expect(shown).toContain("View all printings");
    expect(shown.filter((l) => /3 cards/.test(l))).toEqual(["Add 3 cards to"]);
  });

  it("stays singular for a set of one", () => {
    expect(labels(buildCardMenu(BOLT, deps({ picked: [BOLT] })))).toContain("Add to");
  });

  it("wishes every picked card on one press", () => {
    const addToWishlist = vi.fn();
    const items = buildCardMenu(BOLT, deps({ picked: PICKED, addToWishlist }));
    (find(rowsOf(find(items, "Add 3 cards to")), "Wishlist") as MenuAction).onSelect();

    expect(addToWishlist.mock.calls.map((call) => (call[0] as CardMenuTarget).name)).toEqual([
      "Lightning Bolt",
      "Lightning Helix",
      "Ponder",
    ]);
  });

  /**
   * **A group is recorded in each card's own plain finish, and the finish level is dropped** —
   * the one row whose plural is narrower than its singular. A finish belongs to a printing, so a
   * submenu built from the right-clicked card's finishes would record the others in a finish
   * nobody said they had, and the collection is a record of cardboard the reader physically owns.
   */
  it("files every picked card into the collection in its own plain finish", () => {
    const addToCollection = vi.fn();
    const items = buildCardMenu(BOLT, deps({ picked: PICKED, addToCollection }));
    const row = find(rowsOf(find(items, "Add 3 cards to")), "Collection") as MenuAction;

    // One press, no finish question — where a single Ponder would have offered its two.
    expect(row.kind).toBe("action");
    row.onSelect();
    expect(addToCollection.mock.calls.map((call) => call[1] as string)).toEqual([
      "nonfoil",
      "nonfoil",
      "nonfoil",
    ]);
  });

  /** A foil-only printing keeps its own only finish rather than being recorded as plain — the
   *  13 515 printings for which `nonfoil` is not an answer at all. */
  it("records a foil-only printing as foil inside a group", () => {
    const addToCollection = vi.fn();
    const foilOnly: CardMenuTarget = { ...HELIX, finishes: '["foil"]' };
    const items = buildCardMenu(
      BOLT,
      deps({ picked: [BOLT, foilOnly], addToCollection }),
    );
    (find(rowsOf(find(items, "Add 2 cards to")), "Collection") as MenuAction).onSelect();

    expect(addToCollection.mock.calls.map((call) => call[1] as string)).toEqual([
      "nonfoil",
      "foil",
    ]);
  });

  /** The collection's `Move to` counts only the members that name a stored row — a tile is a
   *  printing the page summed several entries into, and `entryId` is what says otherwise. */
  it("moves only the picked cards that name a collection row", () => {
    const moveToFolder = vi.fn();
    const filed = { ...HELIX, entryId: 7 };
    const items = buildCardMenu(
      { ...BOLT, entryId: 3 },
      deps({
        picked: [{ ...BOLT, entryId: 3 }, filed, PONDER],
        moveToFolder,
        collectionFolders: [binder(1, "Binder")],
      }),
    );
    const move = find(items, "Move 2 cards to");
    (find(rowsOf(move), "Binder") as MenuAction).onSelect();

    expect(moveToFolder.mock.calls.map((call) => call[0] as number)).toEqual([3, 7]);
  });

  /**
   * **A picked set can name one row twice**, because a page that draws a wall and a table draws
   * both kinds of target: the tile summing entries 3 and 7, and the table row that *is* entry 3.
   * Filing 3 twice would send the second write at a row the first has already merged away.
   */
  it("counts a row named by two picked targets once", () => {
    const pickCopies = vi.fn();
    const items = buildCardMenu(
      { ...BOLT, entryIds: [3, 7] },
      deps({
        picked: [
          { ...BOLT, entryIds: [3, 7] },
          { ...HELIX, entryId: 3 },
        ],
        moveToFolder: vi.fn(),
        pickCopies,
        collectionFolders: [binder(1, "Binder")],
      }),
    );
    const move = find(items, "Move 2 cards to");
    (find(rowsOf(move), "Binder") as MenuAction).onSelect();

    expect(pickCopies).toHaveBeenCalledWith([3, 7], 1);
  });
});
