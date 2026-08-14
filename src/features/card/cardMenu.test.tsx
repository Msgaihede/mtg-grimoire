import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MenuAction, MenuItem, MenuSubmenu } from "@/components/menu/types";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/externalLinks";
import { ipc, type DeckFolder, type DeckRow } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  buildCardMenu,
  buildDeckTargetItems,
  DeckTargetSubmenu,
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
    // Null is "not inside the deck editor", which is nine of the ten surfaces.
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
      expect(vi.mocked(copyText)).toHaveBeenCalledWith("https://cards.scryfall.io/display/x.webp?1"),
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
    expect(requestAllPrintings).toHaveBeenCalledWith({ oracleId: "o-bolt", name: "Lightning Bolt" });
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

const folder = (id: number, name: string, parentId: number | null = null): DeckFolder => ({
  id,
  parentId,
  name,
  sortOrder: 0,
});

describe("buildDeckTargetItems", () => {
  it("lists folders before decks, each alphabetically by its own name", () => {
    const items = buildDeckTargetItems(
      [folder(2, "Standard"), folder(1, "Commander")],
      [
        deck({ id: 10, name: "Zoo", folderId: 1 }),
        deck({ id: 11, name: "Affinity", folderId: 2 }),
        deck({ id: 12, name: "Tron" }),
        deck({ id: 13, name: "Belcher" }),
      ],
      vi.fn(),
    );
    expect(labels(items)).toEqual(["Commander", "Standard", "Belcher", "Tron"]);
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
  function mount(onDone = vi.fn()) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DeckTargetSubmenu target={{ ...BOLT, typeLine: "Instant" }} onDone={onDone} />
      </QueryClientProvider>,
    );
    return onDone;
  }

  beforeEach(() => {
    deckList.mockResolvedValue([deck({ id: 7, name: "Burn" })]);
    deckFolderList.mockResolvedValue([]);
    deckGet.mockResolvedValue({ deck: { id: 7, name: "Burn" }, cards: [], categories: [] });
    deckAddCard.mockResolvedValue(undefined);
    oracleTagsForPrintings.mockResolvedValue([]);
  });

  it("adds one copy, naming no category so the app's own rule files the card", async () => {
    const user = userEvent.setup();
    const onDone = mount();

    await user.click(await screen.findByRole("menuitem", { name: "Burn" }));

    // No category id and a type line: `useDeck.addCard`'s `autoCategoryFor` arm, which is the
    // same rule a drag with no column under it and an imported line take.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "bolt-lea", null, "Instant", "live", 1),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("says so rather than drawing an empty panel when there are no decks", async () => {
    deckList.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No decks")).toBeInTheDocument();
  });
});
