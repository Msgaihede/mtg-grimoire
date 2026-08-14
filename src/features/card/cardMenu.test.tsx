import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuAction, MenuItem, MenuSubmenu } from "@/components/menu/types";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/externalLinks";
import { ipc, type DeckFolder, type DeckRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  buildCardMenu,
  buildDeckTargetItems,
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

const BOLT: CardMenuTarget = {
  cardId: "bolt-lea",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  oracleId: "o-bolt",
  finishes: '["nonfoil"]',
};

/** Everything the menu needs that is not the card, with every write a spy. A surface's real
 *  deps are its own; this is the shape, so a test can name the one it is about. */
function deps(over: Partial<CardMenuDeps> = {}): CardMenuDeps {
  return {
    marketplace: MARKETPLACES.tcgplayer,
    addToCollection: vi.fn(),
    addToWishlist: vi.fn(),
    // Null is "not inside the deck editor", which is every card surface outside it.
    viewPrintingsInPane: null,
    requestAllPrintings: vi.fn(),
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

  it("routes View all printings to Search outside the editor", () => {
    const requestAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ requestAllPrintings, viewPrintingsInPane: null }));
    (find(items, "View all printings") as MenuAction).onSelect();
    expect(requestAllPrintings).toHaveBeenCalledWith({
      oracleId: "o-bolt",
      name: "Lightning Bolt",
    });
  });

  it("routes View all printings to the card pane inside the editor", () => {
    const viewPrintingsInPane = vi.fn();
    const requestAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ viewPrintingsInPane, requestAllPrintings }));
    (find(items, "View all printings") as MenuAction).onSelect();
    // Navigating would close the deck -- setActiveView clears openDeckId by design.
    expect(viewPrintingsInPane).toHaveBeenCalledWith("bolt-lea");
    expect(requestAllPrintings).not.toHaveBeenCalled();
  });

  it("disables View all printings for an orphan with no oracle id", () => {
    const items = buildCardMenu({ ...BOLT, oracleId: null }, deps());
    const item = find(items, "View all printings") as MenuAction;
    expect(item.disabled).toBe(true);
    expect(item.reason).toBeTruthy();
  });

  it("greys View all printings on the card the pane is already showing", () => {
    // It shipped live and inert: `viewPrinting` sets `selectedCardId` to the value it already
    // holds, so the press moved nothing and said nothing.
    const viewPrintingsInPane = vi.fn();
    const items = buildCardMenu(BOLT, deps({ viewPrintingsInPane, paneCardId: "bolt-lea" }));
    const item = find(items, "View all printings") as MenuAction;

    expect(item.disabled).toBe(true);
    // And **not** the orphan's sentence, which would be false of a perfectly healthy card.
    expect(item.reason).toBe("this pane is already showing them");
    item.onSelect();
    expect(viewPrintingsInPane).not.toHaveBeenCalled();
  });

  it("leaves the row live for another printing of the card in the pane", () => {
    // The printings list is the case: every row but the open one moves the pane somewhere.
    const viewPrintingsInPane = vi.fn();
    const items = buildCardMenu(BOLT, deps({ viewPrintingsInPane, paneCardId: "bolt-2ed" }));
    const item = find(items, "View all printings") as MenuAction;

    expect(item.disabled).toBeUndefined();
    item.onSelect();
    expect(viewPrintingsInPane).toHaveBeenCalledWith("bolt-lea");
  });

  it("keeps the row live for the open card on a surface that navigates to Search", () => {
    // A wall beside an open pane routes to Search, which always has somewhere to go — greying
    // there would refuse a row that works.
    const requestAllPrintings = vi.fn();
    const items = buildCardMenu(
      BOLT,
      deps({ requestAllPrintings, viewPrintingsInPane: null, paneCardId: "bolt-lea" }),
    );
    const item = find(items, "View all printings") as MenuAction;

    expect(item.disabled).toBeUndefined();
    item.onSelect();
    expect(requestAllPrintings).toHaveBeenCalled();
  });

  it("adds one copy silently when the printing has one finish", () => {
    const addToCollection = vi.fn();
    const items = buildCardMenu(BOLT, deps({ addToCollection }));
    const addTo = find(items, "Add to") as MenuSubmenu;
    const collection = find(addTo.items, "Collection");
    expect(collection.kind).toBe("action");
    (collection as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(BOLT, "nonfoil");
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
    expect(addToCollection).toHaveBeenCalledWith(target, "foil");
  });

  it("treats a null finishes column as nonfoil rather than as no finishes at all", () => {
    // `null` means the column is empty -- unknown, not "this printing has no finishes".
    const addToCollection = vi.fn();
    const target = { ...BOLT, finishes: null };
    const addTo = find(buildCardMenu(target, deps({ addToCollection })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Collection") as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "nonfoil");
  });

  it("wishes for the exact printing", () => {
    const addToWishlist = vi.fn();
    const addTo = find(buildCardMenu(BOLT, deps({ addToWishlist })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Wishlist") as MenuAction).onSelect();
    expect(addToWishlist).toHaveBeenCalledWith(BOLT);
  });

  it("puts the deck picker behind a lazy row", () => {
    const addTo = find(buildCardMenu(BOLT, deps()), "Add to") as MenuSubmenu;
    const deck = find(addTo.items, "Deck");
    // Lazy, so the folder tree and the deck list are fetched on expand and never on open.
    expect(deck.kind).toBe("lazy");
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The deck picker
 * ------------------------------------------------------------------------------------------ */

const deck = (over: Partial<DeckRow> & { id: number; name: string }): DeckRow => ({
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverKind: "card_art",
  coverArtist: null,
  isBuilt: false,
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

  it("asks Theory before Live for a deck that keeps both", () => {
    const choose = vi.fn();
    const items = buildDeckTargetItems(
      [],
      [deck({ id: 10, name: "Burn", theoryEnabled: true })],
      choose,
    );
    const row = find(items, "Burn") as MenuSubmenu;
    // Theory first, and deliberately not alphabetical: it is the order the editor's own
    // variant tabs read in, and the list a deck's cards are in once theory is switched on.
    expect(labels(row.items)).toEqual(["Theory", "Live"]);
    (row.items[0] as MenuAction).onSelect();
    expect(choose).toHaveBeenCalledWith(10, "theory");
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
          <DeckTargetSubmenu target={{ ...BOLT, typeLine: "Instant" }} onDone={vi.fn()} />
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
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "live", 1),
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
          <DeckTargetSubmenu target={BOLT} onDone={vi.fn()} />
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
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "theory", 1),
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
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "theory", 1),
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
