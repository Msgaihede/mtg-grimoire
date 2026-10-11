import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type {
  CollectionFolder,
  CollectionQuery,
  CollectionRow,
  Printing,
  Trade,
  TradeFinishOptions,
  TradeLine,
  TradeLineChange,
  TradeLineInput,
  TradeSide,
  TradeSummary,
} from "@/lib/ipc";
import { openDropdown, pickOption } from "@/test-dropdown";

/**
 * The page over a **backend that remembers**, written here in thirty lines.
 *
 * `useTrades`' `write` invalidates the whole `["trade"]` root when a write settles, so every
 * assertion made after a write is made against a *second read*. A `mockResolvedValue` fixture
 * would answer that read with the trade as it was before the press — and a quantity step would
 * look like it stepped back. So the thirteen commands below read and write one array, the way the
 * real ones read and write two tables, and what a test asserts after a press is what a reader
 * would see after it.
 *
 * Mocked at `@/lib/ipc` rather than run over the Storybook fake, which is `WishlistPage.test.tsx`'s
 * choice and its reason: this file is about what the page *sends*, and a `vi.fn` per command is
 * the thing that can be asked. The stories run the same page over the fake.
 */
const backend = vi.hoisted(() => ({ trades: [] as Trade[] }));
const ipcMock = vi.hoisted(() => ({
  tradeList: vi.fn(),
  tradeGet: vi.fn(),
  tradeCreate: vi.fn(),
  tradeRename: vi.fn(),
  tradeSetRate: vi.fn(),
  tradeAddLines: vi.fn(),
  tradeUpdateLine: vi.fn(),
  tradeRemoveLine: vi.fn(),
  tradeFinish: vi.fn(),
  tradeArchive: vi.fn(),
  tradeReopen: vi.fn(),
  tradeDuplicate: vi.fn(),
  tradeDelete: vi.fn(),
  collectionList: vi.fn(),
  collectionFolderList: vi.fn(),
  searchCards: vi.fn(),
  cardPrintings: vi.fn(),
  getMarketplace: vi.fn(),
  marketplaceFeedStatus: vi.fn(),
  importResolve: vi.fn(),
  oracleTagsForPrintings: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...real, ipc: { ...real.ipc, ...ipcMock } };
});

/**
 * The scanner, stood in for by a box that says which side it was opened onto.
 *
 * The real one mounts the Scanner view — a camera, a lease, a dozen commands — and is tested in
 * its own file. What is this page's is that the right button opens it onto the right side and
 * that the caret comes back.
 */
vi.mock("./TradeScanDialog", () => ({
  TradeScanDialog: ({
    open,
    side,
    onClose,
  }: {
    open: boolean;
    side: TradeSide;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={`Scanner onto ${side}`}>
        <button type="button" onClick={onClose}>
          Close scanner
        </button>
      </div>
    ) : null,
}));

/** The clipboard, so an export's text can be read where Copy put it — `ExportDialog.test`'s seam. */
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

import { TradePage } from "./TradePage";

/** Midday UTC, so the day is the same day in every time zone a suite runs in. */
const day = (month: number, date: number) => Date.UTC(2026, month - 1, date, 12) / 1000;

let nextLine = 100;
function line(over: Partial<TradeLine> & Pick<TradeLine, "side" | "name">): TradeLine {
  const id = nextLine++;
  return {
    id,
    cardId: `card-${id}`,
    oracleId: `oracle-${id}`,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: String(id),
    rarity: "rare",
    layout: "normal",
    finishes: '["nonfoil","foil"]',
    lang: "en",
    typeLine: "Instant",
    legalities: '{"vintage":"legal"}',
    finish: "nonfoil",
    quantity: 1,
    source: "search",
    unitPrice: 1,
    finishPrices: { nonfoil: 1, foil: 2, etched: null },
    owned: 0,
    ownedInDecks: 0,
    deckNames: [],
    wished: 0,
    ...over,
  };
}

function trade(over: Partial<Trade> & Pick<Trade, "id">): Trade {
  return {
    name: `Trade ${over.id}`,
    marketplace: "tcgplayer",
    rateMine: 100,
    rateTheirs: 100,
    status: "open",
    finishedBefore: false,
    outcome: null,
    createdAt: day(10, 2),
    closedAt: null,
    lines: [],
    ...over,
  };
}

/**
 * The design's own trade: four lines a side, $64.39 against $87.09, so the reader owes $22.70.
 * Every figure the tests assert is derived from these prices by hand in the comment beside it.
 */
function canvasTrade(over: Partial<Trade> = {}): Trade {
  return trade({
    id: 5,
    lines: [
      line({
        side: "mine",
        name: "Ragavan, Nimble Pilferer",
        rarity: "mythic",
        unitPrice: 42.19,
        source: "collection",
        owned: 1,
      }),
      line({
        side: "mine",
        name: "Counterspell",
        finishes: '["nonfoil","foil","etched"]',
        finish: "etched",
        quantity: 2,
        unitPrice: 3.25,
        finishPrices: { nonfoil: 2.95, foil: 3.19, etched: 3.25 },
        source: "collection",
        owned: 2,
      }),
      line({
        side: "mine",
        name: "Swords to Plowshares",
        cardId: "stp-ema",
        oracleId: "stp-oracle",
        setCode: "ema",
        setName: "Eternal Masters",
        collectorNumber: "32",
        finish: "foil",
        unitPrice: 4.02,
        finishPrices: { nonfoil: 1.76, foil: 4.02, etched: null },
        source: "collection",
        owned: 1,
      }),
      line({
        side: "mine",
        name: "Boros Charm",
        cardId: "charm-gtc",
        setCode: "gtc",
        setName: "Gatecrash",
        collectorNumber: "148",
        quantity: 2,
        unitPrice: 5.84,
        source: "collection",
        owned: 4,
      }),
      line({ side: "theirs", name: "Lightning Bolt", finish: "foil", unitPrice: 7.1, source: "scan" }),
      line({ side: "theirs", name: "Urza's Saga", unitPrice: 38.5, wished: 1 }),
      line({ side: "theirs", name: "Tarmogoyf", unitPrice: 39.25, wished: 2 }),
      line({ side: "theirs", name: "Sol Ring", quantity: 2, unitPrice: 1.12, source: "scan" }),
    ],
    ...over,
  });
}

function summary(t: Trade): TradeSummary {
  return {
    id: t.id,
    name: t.name,
    marketplace: t.marketplace,
    rateMine: t.rateMine,
    rateTheirs: t.rateTheirs,
    status: t.status,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    lines: t.lines.map(({ side, quantity, unitPrice }) => ({ side, quantity, unitPrice })),
  };
}

const change = (id: number, over: (t: Trade) => Partial<Trade>) => {
  backend.trades = backend.trades.map((t) => (t.id === id ? { ...t, ...over(t) } : t));
};
const changeLine = (lineId: number, over: (l: TradeLine) => TradeLine | null) => {
  backend.trades = backend.trades.map((t) => ({
    ...t,
    lines: t.lines.flatMap((l) => {
      if (l.id !== lineId) return [l];
      const next = over(l);
      return next === null ? [] : [next];
    }),
  }));
};

function folder(id: number, name: string, over: Partial<CollectionFolder> = {}): CollectionFolder {
  return {
    id,
    parentId: null,
    name,
    kind: "user",
    deckId: null,
    sortOrder: id,
    locked: false,
    syncUid: null,
    ...over,
  };
}

function owned(over: Partial<CollectionRow> & Pick<CollectionRow, "id" | "cardId" | "name">) {
  return {
    folderId: null,
    folderName: null,
    oracleId: `oracle-${over.cardId}`,
    setCode: "gtc",
    setName: "Gatecrash",
    collectorNumber: "148",
    lang: "en",
    rarity: "uncommon",
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
    unitPrice: 5.84,
    ...over,
  } as CollectionRow;
}

/**
 * The collection answering its two questions apart, as `collection_list` does: the copies outside
 * every deck, and — to the read that names shelves — the copies those deck groups hold.
 */
function answerCollection(outside: CollectionRow[], inDecks: CollectionRow[]) {
  ipcMock.collectionList.mockImplementation(async (q: CollectionQuery) => {
    const items = q.shelves === undefined ? outside : inDecks;
    return { items, total: items.length };
  });
}

/** A cabinet with two decks in it, a binder, and the holding area. */
const DECKS = [
  folder(7, "Trade binder"),
  folder(11, "Serah", { kind: "deck", deckId: 1 }),
  folder(12, "Azula", { kind: "deck", deckId: 2 }),
  folder(10, "Recently removed", { kind: "removed" }),
];

/** The deck's mark on a line, or `null` where the line wears none. */
const deckMark = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-mark="deck"]');

function printing(id: string, setCode: string, number: string, setName: string): Printing {
  return {
    id,
    setCode,
    setName,
    collectorNumber: number,
    releasedAt: null,
    rarity: "uncommon",
    illustrationId: null,
    artist: null,
    lang: "en",
    finishes: '["nonfoil"]',
    finishPrices: { nonfoil: 1.33, foil: null, etched: null },
    promo: false,
    promoTypes: null,
    fullArt: false,
    frameEffects: null,
    borderColor: null,
    layout: "normal",
  };
}

/** The page under the three providers `App` mounts above it. `staleTime` 0, as the hooks ask. */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ContextMenuProvider>{ui}</ContextMenuProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The open trade's section, once its read has landed. */
const tradeSection = (name: string) => screen.findByRole("region", { name });
const side = (section: HTMLElement, name: string) => within(section).getByRole("region", { name });
/** A line, by the card it is. */
const lineOf = (within_: HTMLElement, name: string) =>
  within(within_)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(name) !== null) as HTMLElement;

beforeEach(() => {
  nextLine = 100;
  backend.trades = [];
  const m = ipcMock;
  m.tradeList.mockReset().mockImplementation(async () => backend.trades.map(summary));
  m.tradeGet
    .mockReset()
    .mockImplementation(async (id: number) => backend.trades.find((t) => t.id === id) ?? null);
  m.tradeCreate.mockReset().mockImplementation(async (create: { name?: string }) => {
    const id = Math.max(0, ...backend.trades.map((t) => t.id)) + 1;
    backend.trades = [trade({ id, ...(create.name ? { name: create.name } : {}) }), ...backend.trades];
    return id;
  });
  m.tradeRename.mockReset().mockImplementation(async (id: number, name: string) => {
    change(id, () => ({ name }));
  });
  m.tradeSetRate.mockReset().mockImplementation(async (id: number, whose: TradeSide, rate: number) => {
    change(id, () => (whose === "mine" ? { rateMine: rate } : { rateTheirs: rate }));
  });
  m.tradeAddLines
    .mockReset()
    .mockImplementation(async (id: number, whose: TradeSide, lines: TradeLineInput[]) => {
      change(id, (t) => ({
        lines: [
          ...t.lines,
          ...lines.map((l) => line({ side: whose, name: `Added ${l.cardId}`, ...l })),
        ],
      }));
    });
  m.tradeUpdateLine.mockReset().mockImplementation(async (lineId: number, next: TradeLineChange) => {
    changeLine(lineId, (l) => ({
      ...l,
      ...next,
      unitPrice: next.finish ? l.finishPrices[next.finish] : l.unitPrice,
    }));
  });
  m.tradeRemoveLine.mockReset().mockImplementation(async (lineId: number) => {
    changeLine(lineId, () => null);
  });
  m.tradeFinish.mockReset().mockImplementation(async (id: number) => {
    const outcome = {
      removedFromCollection: 6,
      removedFromDecks: 0,
      addedToCollection: 5,
      removedFromWishlist: 2,
      addedToWishlist: 0,
    };
    change(id, () => ({ status: "finished", finishedBefore: true, closedAt: day(10, 4), outcome }));
    return outcome;
  });
  m.tradeArchive.mockReset().mockImplementation(async (id: number) => {
    change(id, () => ({ status: "archived", closedAt: day(10, 4) }));
  });
  m.tradeReopen.mockReset().mockImplementation(async (id: number) => {
    change(id, () => ({ status: "open", closedAt: null }));
  });
  m.tradeDuplicate.mockReset().mockImplementation(async (id: number) => {
    const from = backend.trades.find((t) => t.id === id) as Trade;
    const copy = Math.max(...backend.trades.map((t) => t.id)) + 1;
    backend.trades = [
      trade({ id: copy, name: `${from.name} copy`, lines: from.lines }),
      ...backend.trades,
    ];
    return copy;
  });
  m.tradeDelete.mockReset().mockImplementation(async (id: number) => {
    backend.trades = backend.trades.filter((t) => t.id !== id);
  });
  m.collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  m.collectionFolderList.mockReset().mockResolvedValue([]);
  m.searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  m.cardPrintings.mockReset().mockResolvedValue({ items: [], total: 0 });
  m.getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  m.marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  m.importResolve.mockReset().mockResolvedValue([]);
  m.oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  copyText.mockReset().mockResolvedValue(undefined);
});

describe("which trade the page opens on", () => {
  it("opens the newest open trade, and lists the rest in two groups with their balances", async () => {
    backend.trades = [
      canvasTrade(),
      trade({
        id: 4,
        createdAt: day(9, 28),
        lines: [
          line({ side: "mine", name: "A", quantity: 2, unitPrice: 5 }),
          line({ side: "theirs", name: "B", unitPrice: 3.9 }),
        ],
      }),
      trade({
        id: 2,
        status: "finished",
        createdAt: day(9, 1),
        closedAt: day(9, 6),
        lines: [
          line({ side: "mine", name: "C", quantity: 3, unitPrice: 2 }),
          line({ side: "theirs", name: "D", quantity: 3, unitPrice: 1.2 }),
        ],
      }),
      trade({
        id: 1,
        status: "archived",
        createdAt: day(8, 20),
        closedAt: day(8, 23),
        lines: [
          line({ side: "mine", name: "E", unitPrice: 1.25 }),
          line({ side: "theirs", name: "F", quantity: 2, unitPrice: 2.5 }),
        ],
      }),
    ];
    wrap(<TradePage />);

    const section = await tradeSection("Trade 5");
    expect(within(section).getByRole("heading", { level: 3, name: "Trade 5" })).toBeVisible();
    expect(
      within(section).getByText("Opened 2 Oct 2026 · TCGplayer prices, USD · Saved as you go"),
    ).toBeVisible();

    const pane = screen.getByRole("complementary", { name: "Trades" });
    expect(within(pane).getByText("Open · 2")).toBeVisible();
    expect(within(pane).getByText("Archived · 2")).toBeVisible();

    const entry = (name: string) => within(pane).getByRole("button", { name: new RegExp(name) });
    expect(entry("Trade 5")).toHaveAttribute("aria-current", "true");
    // 6 for 5 cards; 87.09 − 64.39.
    expect(entry("Trade 5")).toHaveTextContent("Opened 2 Oct · 6 for 5 cards");
    expect(entry("Trade 5")).toHaveTextContent("You owe $22.70");
    // 10.00 against 3.90: theirs is the smaller side.
    expect(entry("Trade 4")).not.toHaveAttribute("aria-current");
    expect(entry("Trade 4")).toHaveTextContent("Opened 28 Sep · 2 for 1 card");
    expect(entry("Trade 4")).toHaveTextContent("They owe you $6.10");
    // Finished, so the balance is a record: 6.00 against 3.60.
    expect(entry("Trade 2")).toHaveTextContent("Finished 6 Sep · 3 for 3 cards");
    expect(entry("Trade 2")).toHaveTextContent("They owed you $2.40");
    // Archived without finishing still owes, in the present tense: 1.25 against 5.00.
    expect(entry("Trade 1")).toHaveTextContent("Archived 23 Aug · not finished");
    expect(entry("Trade 1")).toHaveTextContent("You owe $3.75");
  });

  it("shows another trade when its entry is pressed", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4, name: "Store night swaps" })];
    wrap(<TradePage />);
    await tradeSection("Trade 5");

    await user.click(screen.getByRole("button", { name: /Store night swaps/ }));

    await tradeSection("Store night swaps");
    expect(screen.queryByRole("region", { name: "Trade 5" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Store night swaps/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("invites a first trade when there are none, and opens the one it creates", async () => {
    const user = userEvent.setup();
    wrap(<TradePage />);

    expect(await screen.findByText("No trades yet")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Trades" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New trade" }));
    const dialog = screen.getByRole("dialog", { name: "New trade" });
    // No trade exists, so the first will most likely be number one.
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "placeholder",
      "Trade 1",
    );
    // The reader's own marketplace, without their having to say so.
    expect(within(dialog).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create trade" }));

    // A name left blank is left out, not sent empty: absent is what asks for `Trade N`.
    expect(ipcMock.tradeCreate).toHaveBeenCalledExactlyOnceWith({ marketplace: "tcgplayer" });
    await tradeSection("Trade 1");
    expect(screen.queryByRole("dialog", { name: "New trade" })).not.toBeInTheDocument();
  });

  it("creates a named trade in the marketplace picked, and selects it over the open one", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    await tradeSection("Trade 5");

    await user.click(screen.getByRole("button", { name: "New trade" }));
    const dialog = screen.getByRole("dialog", { name: "New trade" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "placeholder",
      "Trade 6",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "  Friday swaps ");
    await pickOption(user, "Prices from", /^Cardmarket/);
    // The four marketplaces with prices, and not the fifth that has none.
    await openDropdown(user, "Prices from");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "TCGplayerUSD",
      "CardmarketEUR",
      "Card KingdomUSD",
      "Mana PoolUSD",
    ]);
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Create trade" }));

    expect(ipcMock.tradeCreate).toHaveBeenCalledExactlyOnceWith({
      name: "Friday swaps",
      marketplace: "cardmarket",
    });
    await tradeSection("Friday swaps");
  });

  it("says a failed read in the backend's own words", async () => {
    ipcMock.tradeList.mockRejectedValue("database is locked");
    wrap(<TradePage />);

    // The region is there from the first render, saying it is loading: wait for the sentence,
    // not for the element.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't read your trades — database is locked",
      ),
    );
    expect(screen.queryByText("No trades yet")).not.toBeInTheDocument();
  });

  it("falls back to the default when the picked trade has been deleted elsewhere", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4 })];
    wrap(<TradePage />);
    await tradeSection("Trade 5");
    await user.click(screen.getByRole("button", { name: /Trade 4/ }));
    const four = await tradeSection("Trade 4");

    // Another window deletes it; this one finds out the next time it writes.
    backend.trades = backend.trades.filter((t) => t.id !== 4);
    ipcMock.tradeArchive.mockRejectedValueOnce("That trade no longer exists.");
    await user.click(within(four).getByRole("button", { name: "Archive" }));

    await tradeSection("Trade 5");
    expect(screen.queryByRole("region", { name: "Trade 4" })).not.toBeInTheDocument();
  });

  it("says a trade could not be read, rather than leaving the last one drawn in its place", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4, name: "Store night swaps" })];
    wrap(<TradePage />);
    await tradeSection("Trade 5");
    ipcMock.tradeGet.mockImplementation(async (id: number) => {
      if (id === 4) throw "database is locked";
      return backend.trades.find((t) => t.id === id) ?? null;
    });

    await user.click(screen.getByRole("button", { name: /Store night swaps/ }));

    // The region was there, empty, beside the trade: the sentence is swapped into it.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't read this trade — database is locked",
      ),
    );
    // Trade 5 was held while the read was out. It is not Trade 4, and is not left standing as it.
    expect(screen.queryByRole("region", { name: "Trade 5" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish trade" })).not.toBeInTheDocument();
    // The pane is still the way to another trade, and still says which one was asked for.
    expect(screen.getByRole("button", { name: /Store night swaps/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /Trade 5/ }));
    await tradeSection("Trade 5");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

/**
 * `trades.id` is a plain `INTEGER PRIMARY KEY`: the highest id is handed out again once its trade
 * is deleted, and the backend here does the same (`max + 1`). So the trade made right after the
 * newest one is deleted has the deleted one's id — and a page that remembered that id as gone, or
 * a cache still holding "no such trade" under it, turned away from the trade it had just made.
 */
describe("an id that is handed out again", () => {
  const removeShown = async (user: ReturnType<typeof userEvent.setup>, section: HTMLElement) => {
    await user.click(within(section).getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this trade?" })).getByRole("button", {
        name: "Delete trade",
      }),
    );
  };
  const create = async (user: ReturnType<typeof userEvent.setup>, name?: string) => {
    await user.click(screen.getByRole("button", { name: "New trade" }));
    const dialog = screen.getByRole("dialog", { name: "New trade" });
    if (name !== undefined) await user.type(within(dialog).getByRole("textbox", { name: "Name" }), name);
    await user.click(within(dialog).getByRole("button", { name: "Create trade" }));
  };

  it("shows the trade made after the newest one was deleted", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4 })];
    wrap(<TradePage />);

    await removeShown(user, await tradeSection("Trade 5"));
    await tradeSection("Trade 4");
    await create(user, "Sunday swaps");

    // The same number as the trade that was deleted, and a different trade.
    expect(backend.trades.find((t) => t.name === "Sunday swaps")?.id).toBe(5);
    const made = await tradeSection("Sunday swaps");
    expect(within(made).getAllByText(/^Nothing on this side yet\./)).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Trade 4" })).not.toBeInTheDocument();
    const pane = screen.getByRole("complementary", { name: "Trades" });
    await waitFor(() =>
      expect(within(pane).getByRole("button", { name: /Sunday swaps/ })).toHaveAttribute(
        "aria-current",
        "true",
      ),
    );
    expect(within(pane).getByText("Open · 2")).toBeVisible();
  });

  it("shows the trade made after the only one was deleted", async () => {
    const user = userEvent.setup();
    backend.trades = [trade({ id: 1, name: "The only trade" })];
    wrap(<TradePage />);

    await removeShown(user, await tradeSection("The only trade"));
    expect(await screen.findByText("No trades yet")).toBeVisible();
    await create(user);

    expect(backend.trades.map((t) => t.id)).toEqual([1]);
    await tradeSection("Trade 1");
    expect(screen.queryByText("No trades yet")).not.toBeInTheDocument();
  });

  it("shows the copy made after the newest one was deleted", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4, name: "Store night swaps" })];
    wrap(<TradePage />);

    await removeShown(user, await tradeSection("Trade 5"));
    const four = await tradeSection("Store night swaps");
    await user.click(within(four).getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(backend.trades.find((t) => t.name === "Store night swaps copy")?.id).toBe(5);
    await tradeSection("Store night swaps copy");
  });
});

describe("where the caret goes when the pressed control leaves", () => {
  it("lands in the first trade once it is drawn, not on the button the pane replaced", async () => {
    const user = userEvent.setup();
    wrap(<TradePage />);
    await user.click(await screen.findByRole("button", { name: "New trade" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "New trade" })).getByRole("button", {
        name: "Create trade",
      }),
    );

    const section = await tradeSection("Trade 1");
    await waitFor(() => expect(section).toHaveFocus());
    // The empty state's button is gone and the pane's is a different element: neither had it.
    expect(screen.getByRole("button", { name: "New trade" })).not.toHaveFocus();
  });

  it("lands in a copy, whose Duplicate button belonged to the trade it was made from", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade({ status: "archived", closedAt: day(10, 4) })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Duplicate" }));

    const copy = await tradeSection("Trade 5 copy");
    await waitFor(() => expect(copy).toHaveFocus());
  });

  it("owes the caret to a new trade once: going back to it later moves nothing", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    await tradeSection("Trade 5");
    await user.click(screen.getByRole("button", { name: "New trade" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "New trade" })).getByRole("button", {
        name: "Create trade",
      }),
    );
    await waitFor(async () => expect(await tradeSection("Trade 6")).toHaveFocus());

    await user.click(screen.getByRole("button", { name: /Trade 5/ }));
    await tradeSection("Trade 5");
    const back = screen.getByRole("button", { name: /Trade 6/ });
    await user.click(back);

    await tradeSection("Trade 6");
    expect(back).toHaveFocus();
  });

  it("lands on New trade after a delete, in the pane while there is one", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4 })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    await user.click(within(section).getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this trade?" })).getByRole("button", {
        name: "Delete trade",
      }),
    );

    await tradeSection("Trade 4");
    const pane = screen.getByRole("complementary", { name: "Trades" });
    expect(within(pane).getByRole("button", { name: "New trade" })).toHaveFocus();
  });

  it("lands on the empty state's New trade after the last trade is deleted", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    await user.click(within(section).getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete this trade?" })).getByRole("button", {
        name: "Delete trade",
      }),
    );

    expect(await screen.findByText("No trades yet")).toBeVisible();
    // The pane and its button went with the trade; this one took their place on the same render.
    expect(screen.queryByRole("complementary", { name: "Trades" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "New trade" })).toHaveFocus());
  });
});

describe("whose prices a new trade can use", () => {
  const options = () =>
    screen
      .getAllByRole("option")
      .map((row) => `${row.textContent}${row.getAttribute("aria-disabled") === "true" ? " ✗" : ""}`);

  it("always offers the two whose prices come with the card data, and neither feed", async () => {
    const user = userEvent.setup();
    wrap(<TradePage />);
    await user.click(await screen.findByRole("button", { name: "New trade" }));
    const dialog = screen.getByRole("dialog", { name: "New trade" });

    await openDropdown(user, "Prices from");
    // Still listed, so a reader looking for Card Kingdom is told it exists and how to reach it.
    expect(options()).toEqual(["TCGplayerUSD", "CardmarketEUR", "Card KingdomUSD ✗", "Mana PoolUSD ✗"]);
    await user.hover(screen.getByRole("option", { name: /^Card Kingdom/ }));
    expect(await screen.findByRole("tooltip", undefined, { timeout: 2000 })).toHaveTextContent(
      "Switch the app to Card Kingdom in Settings to trade in its prices.",
    );

    // A press on it is refused: the trade is still the app's own marketplace's.
    await user.click(screen.getByRole("option", { name: /^Card Kingdom/ }));
    await user.keyboard("{Escape}");
    expect(within(dialog).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create trade" }));
    expect(ipcMock.tradeCreate).toHaveBeenCalledExactlyOnceWith({ marketplace: "tcgplayer" });
  });

  it("offers a feed while the app is set to it, opens on it, and still not the other", async () => {
    const user = userEvent.setup();
    ipcMock.getMarketplace.mockResolvedValue("cardkingdom");
    wrap(<TradePage />);
    await user.click(await screen.findByRole("button", { name: "New trade" }));
    const dialog = screen.getByRole("dialog", { name: "New trade" });

    // The setting is a read: the picker follows it when it lands rather than keeping a guess.
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Prices from" })).toHaveTextContent(
        "Card Kingdom",
      ),
    );
    await openDropdown(user, "Prices from");
    expect(options()).toEqual(["TCGplayerUSD", "CardmarketEUR", "Card KingdomUSD", "Mana PoolUSD ✗"]);
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Create trade" }));

    expect(ipcMock.tradeCreate).toHaveBeenCalledExactlyOnceWith({ marketplace: "cardkingdom" });
  });
});

describe("an open trade", () => {
  it("states both totals and who owes whom", async () => {
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    const balance = within(section).getByRole("region", { name: "Balance" });
    // 42.19 + 2×3.25 + 4.02 + 2×5.84, and 7.10 + 38.50 + 39.25 + 2×1.12.
    expect(balance).toHaveTextContent("You give$64.39");
    expect(balance).toHaveTextContent("They give$87.09");
    expect(within(balance).getByText("You owe them")).toBeVisible();
    expect(within(balance).getByText("$22.70")).toBeVisible();
    // Neither side is rated and every line has a price, so neither note is drawn.
    expect(balance).not.toHaveTextContent("at 100%");
    expect(balance).not.toHaveTextContent("without a price");

    const mine = side(section, "You give");
    expect(mine).toHaveTextContent("6 cards");
    expect(within(mine).getByRole("button", { name: "Price for your cards: 100%" })).toHaveTextContent(
      "100% of market",
    );
    const counterspell = lineOf(mine, "Counterspell");
    expect(counterspell).toHaveTextContent("$6.50");
    expect(counterspell).toHaveTextContent("2 × $3.25");
    expect(counterspell).toHaveTextContent("from your collection");

    const theirs = side(section, "They give");
    expect(theirs).toHaveTextContent("5 cards");
    expect(lineOf(theirs, "Tarmogoyf")).toHaveTextContent("on your wishlist");
    // A scanned card that is on nobody's wishlist carries neither mark.
    expect(lineOf(theirs, "Sol Ring")).not.toHaveTextContent("on your wishlist");
    expect(lineOf(theirs, "Sol Ring")).not.toHaveTextContent("from your collection");
  });

  it("counts a line with no price and leaves it out of the total", async () => {
    backend.trades = [
      trade({
        id: 5,
        lines: [
          line({ side: "mine", name: "Priced", unitPrice: 2 }),
          line({ side: "mine", name: "Unpriced", quantity: 3, unitPrice: null }),
          line({ side: "theirs", name: "Other", unitPrice: 2 }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    const balance = within(section).getByRole("region", { name: "Balance" });
    expect(balance).toHaveTextContent("You give$2.00");
    expect(balance).toHaveTextContent("1 without a price");
    expect(within(balance).getByText("Even trade")).toBeVisible();
    // An em dash, never a zero: no price is not free.
    expect(lineOf(side(section, "You give"), "Unpriced")).toHaveTextContent("3 × —");
  });

  it("steps a quantity, and the totals move with it", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const charm = lineOf(side(section, "You give"), "Boros Charm");
    const charmId = backend.trades[0].lines.find((l) => l.name === "Boros Charm")?.id;

    await user.click(within(charm).getByRole("button", { name: "Increase Quantity of Boros Charm" }));

    expect(ipcMock.tradeUpdateLine).toHaveBeenCalledExactlyOnceWith(charmId, { quantity: 3 });
    // 3 × 5.84, and the side is 5.84 heavier: 70.23, so 87.09 − 70.23 is owed.
    await waitFor(() => expect(charm).toHaveTextContent("$17.52"));
    const balance = within(section).getByRole("region", { name: "Balance" });
    expect(balance).toHaveTextContent("You give$70.23");
    expect(within(balance).getByText("$16.86")).toBeVisible();
    expect(screen.getByRole("button", { name: /Trade 5/ })).toHaveTextContent("You owe $16.86");
  });

  /**
   * A copy that comes out of a deck is the one thing a trade costs that nobody put on the table.
   * The line that would take one says which deck, in the destructive colour, and the mark is read
   * from the line's live facts — so it comes and goes with the stepper.
   */
  it("turns a line's mark red, naming the deck, as its quantity passes what is held outside decks", async () => {
    const user = userEvent.setup();
    backend.trades = [
      trade({
        id: 5,
        lines: [
          line({
            side: "mine",
            name: "Sol Ring",
            source: "collection",
            owned: 1,
            ownedInDecks: 2,
            deckNames: ["Serah", "Azula"],
          }),
          line({ side: "theirs", name: "Other", unitPrice: 2 }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const ring = lineOf(side(section, "You give"), "Sol Ring");
    const more = within(ring).getByRole("button", { name: "Increase Quantity of Sol Ring" });

    // One copy, and one is held outside every deck: the gold mark, and nothing in red.
    const gold = within(ring).getByText("from your collection");
    expect(gold.classList.contains("text-accent")).toBe(true);
    expect(gold.classList.contains("text-destructive")).toBe(false);
    expect(deckMark(ring)).toBeNull();

    await user.click(more);

    // The second copy can only come out of a deck — the first one a finish would empty.
    await waitFor(() => expect(deckMark(ring)).toHaveTextContent("1 from your deck Serah"));
    expect(deckMark(ring)?.classList.contains("text-destructive")).toBe(true);
    expect(deckMark(ring)?.classList.contains("text-accent")).toBe(false);
    // Never both: a line that reaches into a deck does not also wear the gold.
    expect(within(ring).queryByText("from your collection")).not.toBeInTheDocument();

    await user.click(more);
    await waitFor(() =>
      expect(deckMark(ring)).toHaveTextContent("2 from your decks Serah, Azula"),
    );

    await user.click(within(ring).getByRole("button", { name: "Decrease Quantity of Sol Ring" }));
    await user.click(within(ring).getByRole("button", { name: "Decrease Quantity of Sol Ring" }));

    // Back to one copy, and back to gold.
    await waitFor(() => expect(deckMark(ring)).toBeNull());
    expect(within(ring).getByText("from your collection").classList.contains("text-accent")).toBe(
      true,
    );
  });

  it("marks a searched-for line whose only copy is a deck's, and never a card on their side", async () => {
    backend.trades = [
      trade({
        id: 5,
        lines: [
          // Added from every card, not from the collection: a finish takes it all the same.
          line({ side: "mine", name: "Mana Crypt", ownedInDecks: 1, deckNames: ["Azula"] }),
          line({ side: "mine", name: "Plain", source: "collection", owned: 1 }),
          // The facts arrive on their lines too: a card they give that the reader holds in a
          // deck. Nothing is ever taken for it, so nothing is said.
          line({ side: "theirs", name: "Arcane Signet", ownedInDecks: 1, deckNames: ["Serah"] }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");
    const theirs = side(section, "They give");

    // The whole line, so no count: the quantity is beside it.
    expect(deckMark(lineOf(mine, "Mana Crypt"))).toHaveTextContent(/^from your deck Azula$/);
    expect(deckMark(lineOf(mine, "Mana Crypt"))?.classList.contains("text-destructive")).toBe(true);
    expect(deckMark(lineOf(mine, "Plain"))).toBeNull();

    const signet = lineOf(theirs, "Arcane Signet");
    expect(deckMark(signet)).toBeNull();
    expect(signet).not.toHaveTextContent("from your deck");
    expect(signet).not.toHaveTextContent("from your collection");
  });

  it("never steps a line below one copy: removal is its own control", async () => {
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const ragavan = lineOf(side(section, "You give"), "Ragavan, Nimble Pilferer");

    expect(
      within(ragavan).getByRole("button", { name: "Decrease Quantity of Ragavan, Nimble Pilferer" }),
    ).toBeDisabled();
  });

  it("changes a line's finish, offering each with today's price", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const spell = backend.trades[0].lines.find((l) => l.name === "Counterspell") as TradeLine;

    await openDropdown(user, "Finish of Counterspell");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Nonfoil$2.95",
      "Foil$3.19",
      "Etched$3.25",
    ]);
    await user.click(screen.getByRole("option", { name: /^Foil/ }));

    expect(ipcMock.tradeUpdateLine).toHaveBeenCalledExactlyOnceWith(spell.id, { finish: "foil" });
    // 2 × 3.19, patched from the line's own finish prices before the answer.
    await waitFor(() =>
      expect(lineOf(side(section, "You give"), "Counterspell")).toHaveTextContent("$6.38"),
    );
  });

  it("reads a card's printings only when the picker is opened, and writes the one picked", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.cardPrintings.mockResolvedValue({
      items: [
        printing("stp-ema", "ema", "32", "Eternal Masters"),
        printing("stp-msc", "msc", "143", "Marvel Super Heroes Commander"),
      ],
      total: 2,
    });
    wrap(<TradePage />);
    await tradeSection("Trade 5");
    const swords = backend.trades[0].lines.find((l) => l.name === "Swords to Plowshares");

    // Eight lines drawn, and not one list of printings asked for.
    expect(ipcMock.cardPrintings).not.toHaveBeenCalled();
    const trigger = screen.getByRole("button", { name: "Printing of Swords to Plowshares" });
    expect(trigger).toHaveTextContent("EMA · 32");

    await user.click(trigger);
    // The trade's own marketplace, not the app's.
    expect(ipcMock.cardPrintings).toHaveBeenCalledExactlyOnceWith("stp-oracle", "tcgplayer");
    // The line is foil and this printing is not, so the row says what the line would become.
    const other = await screen.findByRole("option", { name: /^MSC · 143/ });
    expect(other).toHaveTextContent("Marvel Super Heroes Commander · Nonfoil only, $1.33");
    await user.click(other);

    expect(ipcMock.tradeUpdateLine).toHaveBeenCalledExactlyOnceWith(swords?.id, {
      cardId: "stp-msc",
    });
  });

  it("removes a line", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const ring = backend.trades[0].lines.find((l) => l.name === "Sol Ring");

    await user.click(screen.getByRole("button", { name: "Remove Sol Ring from the trade" }));

    expect(ipcMock.tradeRemoveLine).toHaveBeenCalledExactlyOnceWith(ring?.id);
    await waitFor(() => expect(side(section, "They give")).toHaveTextContent("3 cards"));
    expect(within(section).queryByText("Sol Ring")).not.toBeInTheDocument();
  });

  it("draws a refused line write on the line, in the backend's words", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.tradeUpdateLine.mockRejectedValue("This trade is archived.");
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const charm = lineOf(side(section, "You give"), "Boros Charm");

    await user.click(within(charm).getByRole("button", { name: "Increase Quantity of Boros Charm" }));

    expect(await within(charm).findByRole("alert")).toHaveTextContent(
      "Couldn't change the quantity — This trade is archived.",
    );
    // And the patch is undone by the read that follows: two copies, as stored.
    await waitFor(() => expect(charm).toHaveTextContent("2 × $5.84"));
  });

  it("renames in place, showing the new name at once", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Rename trade" }));
    const field = screen.getByRole("textbox", { name: "Trade name" });
    expect(field).toHaveValue("Trade 5");
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Friday swaps{Enter}");

    expect(ipcMock.tradeRename).toHaveBeenCalledExactlyOnceWith(5, "Friday swaps");
    expect(await screen.findByRole("heading", { level: 3, name: "Friday swaps" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Friday swaps/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The caret is back on the control that opened the field.
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename trade" })).toHaveFocus());
  });

  it("gives up a rename on Escape and writes nothing", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Rename trade" }));
    await user.type(screen.getByRole("textbox", { name: "Trade name" }), " edited{Escape}");

    expect(screen.queryByRole("textbox", { name: "Trade name" })).not.toBeInTheDocument();
    expect(within(section).getByRole("heading", { level: 3, name: "Trade 5" })).toBeVisible();
    expect(ipcMock.tradeRename).not.toHaveBeenCalled();
  });

  it("asks before deleting, and deletes only on the answer", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4 })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "Rename",
      "Duplicate",
      "Delete…",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));

    const question = screen.getByRole("dialog", { name: "Delete this trade?" });
    expect(question).toHaveTextContent(
      "“Trade 5” and the cards listed on both of its sides will be deleted. " +
        "Your collection and your wishlist are not touched.",
    );
    expect(ipcMock.tradeDelete).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Delete trade" }));

    expect(ipcMock.tradeDelete).toHaveBeenCalledExactlyOnceWith(5);
    // The page moves on to what is left rather than drawing a trade that is gone.
    await tradeSection("Trade 4");
    expect(screen.queryByRole("button", { name: /Trade 5/ })).not.toBeInTheDocument();
  });

  it("duplicates from the menu and shows the copy", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    expect(ipcMock.tradeDuplicate).toHaveBeenCalledExactlyOnceWith(5);
    await tradeSection("Trade 5 copy");
  });

  it("archives, and the same page stops being editable", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Archive" }));

    expect(ipcMock.tradeArchive).toHaveBeenCalledExactlyOnceWith(5);
    expect(await within(section).findByRole("button", { name: "Reopen" })).toBeVisible();
    expect(within(section).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    // The button that was pressed is gone, so the caret is on the section, not on `<body>`.
    expect(section).toHaveFocus();
  });

  it("opens the scanner onto the side whose camera was pressed, and takes the caret back", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    await tradeSection("Trade 5");

    const camera = screen.getByRole("button", { name: "Scan cards onto their side" });
    await user.click(camera);
    const scanner = screen.getByRole("dialog", { name: "Scanner onto theirs" });
    await user.click(within(scanner).getByRole("button", { name: "Close scanner" }));

    expect(screen.queryByRole("dialog", { name: /Scanner/ })).not.toBeInTheDocument();
    expect(camera).toHaveFocus();
  });
});

/**
 * Each side in and out of a file (issue #903): the app's own import and export dialogs, onto and
 * off the one side whose button was pressed, and an export on a closed trade too.
 */
describe("a side's import and export", () => {
  it("imports a pasted list onto the side whose Import was pressed, and takes the caret back", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.importResolve.mockResolvedValue([
      {
        index: 0,
        hintMissed: false,
        matched: { cardId: "ring-ltc", name: "Sol Ring", setCode: "ltc", collectorNumber: "285" },
      },
      {
        index: 1,
        hintMissed: false,
        matched: { cardId: "bolt-sta", name: "Lightning Bolt", setCode: "sta", collectorNumber: "42" },
      },
    ]);
    wrap(<TradePage />);
    await tradeSection("Trade 5");

    const opener = screen.getByRole("button", { name: "Import cards to their side" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Import cards" });
    expect(dialog).toHaveTextContent("Onto their side of “Trade 5”");
    await user.click(within(dialog).getByLabelText("Card list"));
    await user.paste("2 Sol Ring\n1 Lightning Bolt *F*");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText("3 cards will be put on their side.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "theirs", [
        { cardId: "ring-ltc", finish: "nonfoil", quantity: 2, source: "search" },
        { cardId: "bolt-sta", finish: "foil", quantity: 1, source: "search" },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Import cards" })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });

  it("keeps the dialog up and says why when the side refuses the list", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.importResolve.mockResolvedValue([
      {
        index: 0,
        hintMissed: false,
        matched: { cardId: "ring-ltc", name: "Sol Ring", setCode: "ltc", collectorNumber: "285" },
      },
    ]);
    ipcMock.tradeAddLines.mockRejectedValue("a trade line holds at most 9999 copies");
    wrap(<TradePage />);
    await tradeSection("Trade 5");

    await user.click(screen.getByRole("button", { name: "Import cards to your side" }));
    const dialog = await screen.findByRole("dialog", { name: "Import cards" });
    await user.click(within(dialog).getByLabelText("Card list"));
    await user.paste("1 Sol Ring");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.click(await within(dialog).findByRole("button", { name: "Import" }));

    expect(
      await within(dialog).findByText(
        "Couldn't import the list — a trade line holds at most 9999 copies",
      ),
    ).toBeVisible();
    expect(ipcMock.tradeAddLines).toHaveBeenCalledWith(5, "mine", expect.any(Array));
  });

  it("exports one side of an archived trade, with no way to import onto it", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade({ status: "archived", closedAt: day(10, 4) })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    expect(within(section).queryByRole("button", { name: /^Import cards/ })).not.toBeInTheDocument();
    const opener = within(section).getByRole("button", { name: "Export their side" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Export \"Trade 5 — They give\"" });
    await user.click(within(dialog).getByRole("button", { name: /Copy/ }));

    await waitFor(() => expect(copyText).toHaveBeenCalledOnce());
    const text = copyText.mock.calls[0][0] as string;
    // Their four lines, and none of the reader's own.
    for (const name of ["Lightning Bolt", "Urza's Saga", "Tarmogoyf", "Sol Ring"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("Counterspell");
    expect(text).not.toContain("Boros Charm");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Export/ })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
  });
});

describe("a side's percentage", () => {
  /** A drag: every position on the way is an `input`, and letting go is the one `change`. */
  const drag = (slider: HTMLElement, ...through: number[]) => {
    for (const value of through) fireEvent.input(slider, { target: { value: String(value) } });
  };
  const release = (slider: HTMLElement) => fireEvent(slider, new Event("change", { bubbles: true }));

  it("follows the thumb without writing, then writes once when it is let go", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const theirs = side(section, "They give");

    await user.click(within(theirs).getByRole("button", { name: "Price for their cards: 100%" }));
    const popover = screen.getByRole("dialog", { name: "Price for their cards" });
    const slider = within(popover).getByRole("slider", { name: "Percent of market price" });
    expect(slider).toHaveAttribute("min", "50");
    expect(slider).toHaveAttribute("max", "150");
    expect(slider).toHaveAttribute("step", "5");

    drag(slider, 95, 90, 85, 80);

    // The popover is already at 80%: 5.68 + 30.80 + 31.40 + 2×0.90, each card rounded on its own.
    expect(popover).toHaveTextContent("80%of market price, for their cards");
    expect(popover).toHaveTextContent("At 100%$87.09");
    expect(popover).toHaveTextContent("At 80%$69.68");
    // …and nothing has been written, nor has the page behind moved.
    expect(ipcMock.tradeSetRate).not.toHaveBeenCalled();
    expect(within(section).getByRole("region", { name: "Balance" })).toHaveTextContent(
      "They give$87.09",
    );

    release(slider);

    // A patched write cancels the reads in flight before it sends, so the command is a tick
    // behind the press.
    await waitFor(() => expect(ipcMock.tradeSetRate).toHaveBeenCalled());
    expect(ipcMock.tradeSetRate).toHaveBeenCalledExactlyOnceWith(5, "theirs", 80);
    const balance = within(section).getByRole("region", { name: "Balance" });
    await waitFor(() => expect(balance).toHaveTextContent("They give$69.68$87.09 at 100%"));
    // 69.68 − 64.39.
    expect(within(balance).getByText("$5.29")).toBeVisible();
    // The button is gold while the side is not at full price, and every line says both figures.
    // …and its name says the value too: an `aria-label` replaces the words drawn on the button.
    const button = within(theirs).getByRole("button", { name: "Price for their cards: 80%" });
    expect(button).toHaveTextContent("80% of market");
    expect(button.classList.contains("border-accent")).toBe(true);
    expect(lineOf(theirs, "Sol Ring")).toHaveTextContent("$1.802 × $0.90$2.24 at 100%");
    // The other side was not touched.
    expect(lineOf(side(section, "You give"), "Counterspell")).not.toHaveTextContent("at 100%");
  });

  it("writes nothing when the thumb is let go where it started", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Price for your cards: 100%" }));
    const slider = screen.getByRole("slider", { name: "Percent of market price" });
    drag(slider, 110, 100);
    release(slider);

    expect(ipcMock.tradeSetRate).not.toHaveBeenCalled();
  });

  it("says a refused percentage in the popover it was set from", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.tradeSetRate.mockRejectedValue("This trade is archived.");
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Price for your cards: 100%" }));
    const popover = screen.getByRole("dialog", { name: "Price for your cards" });
    const slider = within(popover).getByRole("slider");
    drag(slider, 120);
    release(slider);

    expect(await within(popover).findByRole("alert")).toHaveTextContent(
      "Couldn't change the percentage — This trade is archived.",
    );
  });
});

describe("adding a card", () => {
  it("searches the collection for the reader's side, and Enter adds the first match", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.collectionList.mockResolvedValue({
      items: [
        owned({ id: 1, cardId: "charm-gtc", name: "Boros Charm", quantity: 3 }),
        // The same printing and finish in another condition: one card, four copies.
        owned({ id: 2, cardId: "charm-gtc", name: "Boros Charm", condition: "LP" }),
        owned({
          id: 3,
          cardId: "reckoner",
          name: "Boros Reckoner",
          collectorNumber: "215",
          finish: "foil",
          unitPrice: 3.52,
        }),
      ],
      total: 3,
    });
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");
    const field = within(mine).getByRole("combobox", { name: "Add a card to your side" });
    expect(field).toHaveAttribute("placeholder", "Add a card…");
    expect(within(mine).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.type(field, "bo");
    const charm = await within(mine).findByRole("option", { name: /Boros Charm/ });

    // Two of the trade's own copies are already on this side.
    expect(charm).toHaveTextContent("GTC 148 · Nonfoil · 4 owned · 2 in this trade");
    expect(charm).toHaveTextContent("$5.84");
    expect(within(mine).getByRole("option", { name: /Boros Reckoner/ })).toHaveTextContent(
      "GTC 215 · Foil · 1 owned",
    );
    expect(within(mine).getByRole("status")).toHaveTextContent(
      /^2 matches in your collection · Enter adds one copy$/,
    );
    expect(ipcMock.searchCards).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

    expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "mine", [
      { cardId: "charm-gtc", finish: "nonfoil", quantity: 1, source: "collection" },
    ]);
    // Ready for the next name.
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
  });

  it("searches every card for their side, with no scope to choose", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.searchCards.mockResolvedValue({
      items: [
        {
          id: "bolt-sta",
          name: "Lightning Bolt",
          setCode: "sta",
          setName: "Strixhaven Mystical Archive",
          collectorNumber: "42",
          rarity: "rare",
          price: 2.1,
          oracleId: "bolt",
          finishes: '["nonfoil","foil"]',
        },
      ],
      total: 1,
      totalIsCapped: false,
    });
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const theirs = side(section, "They give");
    const field = within(theirs).getByRole("combobox", { name: "Add a card to their side" });
    expect(field).toHaveAttribute("placeholder", "Add any card…");
    expect(within(theirs).queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
    expect(within(theirs).queryByRole("button", { name: "All cards" })).not.toBeInTheDocument();

    await user.type(field, "bolt");
    const row = await within(theirs).findByRole("option", { name: /Lightning Bolt/ });
    // No copies counted: this is not the reader's card.
    expect(row).toHaveTextContent("STA 42 · Nonfoil");
    expect(row).not.toHaveTextContent("owned");
    expect(ipcMock.collectionList).not.toHaveBeenCalled();

    // A press on the row adds a copy and leaves the list where it is.
    await user.click(row);

    expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "theirs", [
      { cardId: "bolt-sta", finish: "nonfoil", quantity: 1, source: "search" },
    ]);
    expect(field).toHaveValue("bolt");
  });

  it("offers every card from an empty collection search, one press away", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");

    await user.type(within(mine).getByRole("combobox"), "goyf");
    await waitFor(() =>
      expect(within(mine).getByRole("status")).toHaveTextContent(
        "Nothing in your collection matches “goyf”.",
      ),
    );
    await user.click(within(mine).getByRole("button", { name: "Search all cards for “goyf”" }));

    expect(within(mine).getByRole("button", { name: "All cards" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(ipcMock.searchCards).toHaveBeenCalled());
    expect(ipcMock.searchCards.mock.lastCall?.[0]).toMatchObject({ text: "goyf", collapse: true });
    // The caret never left the field.
    expect(within(mine).getByRole("combobox")).toHaveFocus();
  });

  it("spends Escape on the list first and on the field second", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.collectionList.mockResolvedValue({
      items: [owned({ id: 1, cardId: "charm-gtc", name: "Boros Charm" })],
      total: 1,
    });
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");
    const field = within(mine).getByRole("combobox");

    await user.type(field, "bo");
    await within(mine).findByRole("option", { name: /Boros Charm/ });

    await user.keyboard("{Escape}");
    expect(within(mine).queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveValue("bo");

    await user.keyboard("{Escape}");
    expect(field).toHaveValue("");
    expect(ipcMock.tradeAddLines).not.toHaveBeenCalled();
  });

  /**
   * Between Escape's two presses the list is put away and its rows are still held. Enter there
   * used to add the highlighted one — a card the reader could not see — and ArrowUp moved a
   * highlight nobody could see either.
   */
  it("brings a list put away with Escape back before any key acts on a row", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.collectionList.mockResolvedValue({
      items: [
        owned({ id: 1, cardId: "charm-gtc", name: "Boros Charm" }),
        owned({ id: 2, cardId: "reckoner", name: "Boros Reckoner", collectorNumber: "215" }),
      ],
      total: 2,
    });
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");
    const field = within(mine).getByRole("combobox");
    const selected = () =>
      within(mine)
        .getAllByRole("option")
        .map((row) => row.getAttribute("aria-selected"));

    await user.type(field, "bo");
    await within(mine).findByRole("option", { name: /Boros Charm/ });
    await user.keyboard("{ArrowDown}");
    expect(selected()).toEqual(["false", "true"]);

    // Enter on the list that is put away: the list comes back, and nothing is added.
    await user.keyboard("{Escape}");
    expect(within(mine).queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(ipcMock.tradeAddLines).not.toHaveBeenCalled();
    expect(within(mine).getByRole("listbox")).toBeInTheDocument();
    expect(field).toHaveValue("bo");
    expect(field).toHaveAttribute("aria-expanded", "true");

    // ArrowUp the same: it shows the highlight where it was rather than moving it unseen.
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowUp}");
    expect(selected()).toEqual(["false", "true"]);
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowDown}");
    expect(selected()).toEqual(["false", "true"]);

    // And with the list up, Enter is about the row the reader is looking at.
    await user.keyboard("{Enter}");
    expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "mine", [
      { cardId: "reckoner", finish: "nonfoil", quantity: 1, source: "collection" },
    ]);
  });

  /**
   * The owner's words: offer them, in a separate section, in red rather than gold, "so its VERY
   * obvious to the user that they are removing a card out of their decks".
   */
  it("offers a deck's copies in a section of their own, under the others and in the destructive colour", async () => {
    const user = userEvent.setup();
    backend.trades = [trade({ id: 5 })];
    ipcMock.collectionFolderList.mockResolvedValue(DECKS);
    const ring = { cardId: "ring", name: "Sol Ring", collectorNumber: "263" };
    answerCollection(
      [
        owned({ id: 1, ...ring, folderId: 7 }),
        owned({ id: 2, cardId: "talisman", name: "Sol Talisman", collectorNumber: "236" }),
      ],
      [
        owned({ id: 3, ...ring, folderId: 11, folderName: "Serah" }),
        owned({ id: 4, ...ring, folderId: 12, folderName: "Azula", quantity: 2 }),
      ],
    );
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");
    const field = within(mine).getByRole("combobox");

    await user.type(field, "sol");
    const group = await within(mine).findByRole("group", { name: "In your decks" });
    const options = () => within(mine).getAllByRole("option");

    // Visual order: the copies outside a deck, then each deck's.
    expect(options().map((row) => row.getAttribute("data-place"))).toEqual([
      "collection",
      "collection",
      "deck",
      "deck",
    ]);
    // Never mixed: the group holds the deck rows and only them.
    expect(within(group).getAllByRole("option")).toEqual(options().slice(2));
    expect(within(mine).getByRole("listbox")).toContainElement(group);

    // The section says what it is in words, and warns in a sentence — both in the destructive
    // colour, and the sentence is the group's description.
    const heading = within(group).getByText("In your decks");
    expect(heading.classList.contains("text-destructive")).toBe(true);
    expect(group).toHaveAccessibleDescription(
      "A finished trade takes these out of their decks, once your copies outside any deck have run out.",
    );
    expect(
      within(group).getByText(/A finished trade takes these/).classList.contains("text-destructive"),
    ).toBe(true);

    // Each deck row names its deck and draws its words in that colour; an ordinary row does not.
    const [ordinary, , inSerah, inAzula] = options();
    expect(inSerah).toHaveTextContent("GTC 263 · Nonfoil · 1 in Serah");
    expect(inAzula).toHaveTextContent("GTC 263 · Nonfoil · 2 in Azula");
    expect(inSerah).not.toHaveTextContent("owned");
    expect(within(inSerah).getByText("Sol Ring").classList.contains("text-destructive")).toBe(true);
    expect(within(inSerah).getByText(/1 in Serah/).classList.contains("text-destructive")).toBe(
      true,
    );
    expect(ordinary).toHaveTextContent("GTC 263 · Nonfoil · 1 owned");
    expect(within(ordinary).getByText("Sol Ring").classList.contains("text-destructive")).toBe(
      false,
    );
    expect(within(ordinary).getByText(/1 owned/).classList.contains("text-destructive")).toBe(false);

    expect(within(mine).getByRole("status")).toHaveTextContent(
      /^2 matches in your collection, 2 in your decks · Enter adds one copy$/,
    );

    // One highlight through both sections in the order they are drawn, starting at the top.
    const selected = () => options().map((row) => row.getAttribute("aria-selected"));
    expect(selected()).toEqual(["true", "false", "false", "false"]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toEqual(["false", "false", "true", "false"]);
    expect(field).toHaveAttribute("aria-activedescendant", inSerah.id);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toEqual(["false", "false", "false", "true"]);
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(selected()).toEqual(["true", "false", "false", "false"]);

    // Enter, untouched, is the top row — a copy outside every deck.
    await user.keyboard("{Enter}");
    expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "mine", [
      { cardId: "ring", finish: "nonfoil", quantity: 1, source: "collection" },
    ]);
  });

  /**
   * What the owner hit: three Sol Rings, every one of them sleeved, and a search from a trade
   * that answered *nothing in your collection matches*.
   */
  it("finds a card whose every copy is in a deck, and never says nothing matches over it", async () => {
    const user = userEvent.setup();
    backend.trades = [trade({ id: 5 })];
    ipcMock.collectionFolderList.mockResolvedValue(DECKS);
    answerCollection(
      [],
      [
        owned({ id: 3, cardId: "ring", name: "Sol Ring", folderId: 11, folderName: "Serah" }),
        // The holding area is not a deck, whatever an answer says: never offered.
        owned({
          id: 5,
          cardId: "vault",
          name: "Sol Vault",
          folderId: 10,
          folderName: "Recently removed",
        }),
      ],
    );
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");

    await user.type(within(mine).getByRole("combobox"), "sol");
    const row = await within(mine).findByRole("option", { name: /Sol Ring/ });

    expect(within(mine).getAllByRole("option")).toEqual([row]);
    expect(row).toHaveAttribute("data-place", "deck");
    expect(within(mine).queryByText(/Sol Vault/)).not.toBeInTheDocument();
    const status = within(mine).getByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(/^1 match in your decks · Enter adds one copy$/),
    );
    expect(status).not.toHaveTextContent("Nothing in your collection matches");

    // A press adds it, as a line like any other: where its copies come from is the line's to say.
    await user.click(row);
    expect(ipcMock.tradeAddLines).toHaveBeenCalledExactlyOnceWith(5, "mine", [
      { cardId: "ring", finish: "nonfoil", quantity: 1, source: "collection" },
    ]);
  });

  it("says a refused add under the field", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.collectionList.mockResolvedValue({
      items: [owned({ id: 1, cardId: "charm-gtc", name: "Boros Charm" })],
      total: 1,
    });
    ipcMock.tradeAddLines.mockRejectedValue("This trade is archived.");
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const mine = side(section, "You give");

    await user.type(within(mine).getByRole("combobox"), "bo");
    await within(mine).findByRole("option", { name: /Boros Charm/ });
    await user.keyboard("{Enter}");

    expect(await within(mine).findByRole("alert")).toHaveTextContent(
      "Couldn't add Boros Charm — This trade is archived.",
    );
  });
});

describe("finishing a trade", () => {
  const box = (dialog: HTMLElement, name: string) =>
    within(dialog).getByRole("checkbox", { name });

  it("opens on three steps of four, each saying what it will move", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.collectionFolderList.mockResolvedValue([
      folder(7, "Trade binder"),
      folder(8, "Rares", { parentId: 7 }),
      // Neither a deck's group nor the removed pile is somewhere a reader files a card.
      folder(9, "Izzet deck", { kind: "deck", deckId: 1 }),
      folder(10, "Recently removed", { kind: "removed" }),
    ]);
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });
    expect(dialog).toHaveTextContent("Trade 5 · opened 2 Oct 2026");
    expect(dialog).toHaveTextContent("You give$64.396 cards");
    expect(dialog).toHaveTextContent("They give$87.095 cards");
    expect(within(dialog).getByText("$22.70")).toBeVisible();

    const remove = box(dialog, "Take the cards you gave out of your collection");
    const add = box(dialog, "Add the cards you received to your collection");
    const unwish = box(dialog, "Take the cards you received off your wishlist");
    const wish = box(dialog, "Put the cards you gave on your wishlist");
    expect(remove).toBeChecked();
    expect(add).toBeChecked();
    expect(unwish).toBeChecked();
    expect(wish).not.toBeChecked();

    // Each note is the box's description, so it is read with the box and not after the form.
    expect(remove).toHaveAccessibleDescription("6 cards. All of them are in your collection.");
    expect(add).toHaveAccessibleDescription(
      "5 cards, in the printing and finish shown in the trade.",
    );
    expect(unwish).toHaveAccessibleDescription("2 of them are on it: Urza's Saga, Tarmogoyf.");
    expect(wish).toHaveAccessibleDescription("For the ones you want back one day.");

    await openDropdown(user, "Folder for the cards you received");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Collection",
      "Trade binder",
      "Trade binder / Rares",
    ]);
    await user.click(screen.getByRole("option", { name: "Trade binder / Rares" }));
    await user.click(wish);
    await user.click(within(dialog).getByRole("button", { name: "Finish trade" }));

    expect(ipcMock.tradeFinish).toHaveBeenCalledExactlyOnceWith(5, {
      removeGiven: true,
      addReceived: true,
      folderId: 8,
      unwishReceived: true,
      wishGiven: true,
    } satisfies TradeFinishOptions);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Finish trade" })).not.toBeInTheDocument(),
    );
    // The page behind is the same trade, read-only, saying what the finish did.
    expect(await within(section).findByRole("button", { name: "Reopen" })).toBeVisible();
    expect(section).toHaveTextContent(
      "Finished and archived, so nothing here can be edited. Finishing it took 6 cards out of " +
        "your collection, added 5 cards to your collection and took 2 cards off your wishlist.",
    );
    expect(section).toHaveFocus();
  });

  /**
   * The default is which trade to *open on*, not which to *be on*.
   *
   * Finishing the newest open trade makes the next-newest the newest open one. A page that read
   * its default on every render swapped trades on that press — the reader finished Trade 5 and
   * was shown Trade 4, editable, with no word of what the finish had done. One trade in the world
   * cannot show it, which is why every other case here passed over it; the story over the fake's
   * five trades is what found it.
   */
  it("stays on the trade it finished when another one is still open", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade(), trade({ id: 4 })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Finish trade" })).getByRole("button", {
        name: "Finish trade",
      }),
    );

    expect(await within(section).findByRole("button", { name: "Reopen" })).toBeVisible();
    expect(section).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Trade 4" })).not.toBeInTheDocument();
    const pane = screen.getByRole("complementary", { name: "Trades" });
    await waitFor(() => expect(within(pane).getByText("Archived · 1")).toBeVisible());
    expect(within(pane).getByRole("button", { name: /Trade 5/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("says how many of the given cards the collection can actually give", async () => {
    const user = userEvent.setup();
    backend.trades = [
      trade({
        id: 5,
        lines: [
          line({ side: "mine", name: "Held", quantity: 4, source: "collection", owned: 1 }),
          line({ side: "mine", name: "Not held", quantity: 2, owned: 0 }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });

    expect(box(dialog, "Take the cards you gave out of your collection")).toHaveAccessibleDescription(
      "6 cards. 1 of them is in your collection; the rest are left alone.",
    );
    expect(box(dialog, "Add the cards you received to your collection")).toHaveAccessibleDescription(
      "There is nothing on their side.",
    );
    expect(box(dialog, "Take the cards you received off your wishlist")).toHaveAccessibleDescription(
      "None of them are on your wishlist.",
    );
  });

  it("warns, in red and as part of the question, about the cards a finish takes out of decks", async () => {
    const user = userEvent.setup();
    backend.trades = [
      trade({
        id: 5,
        lines: [
          line({
            side: "mine",
            name: "Sol Ring",
            quantity: 2,
            source: "collection",
            owned: 1,
            ownedInDecks: 1,
            deckNames: ["Serah"],
          }),
          line({ side: "mine", name: "Plain", source: "collection", owned: 1 }),
          // Their card, held in a deck of the reader's: nothing of it is taken, so no warning.
          line({ side: "theirs", name: "Arcane Signet", ownedInDecks: 1, deckNames: ["Azula"] }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });
    const remove = box(dialog, "Take the cards you gave out of your collection");

    // Read with the box it is confirmed against, after the count.
    expect(remove).toHaveAccessibleDescription(
      "3 cards. All of them are in your collection. " +
        "1 of them comes out of a deck: Serah. That deck will be short of it.",
    );
    const warning = within(dialog).getByText(
      "1 of them comes out of a deck: Serah. That deck will be short of it.",
    );
    expect(warning.parentElement?.classList.contains("text-destructive")).toBe(true);
    // Under its own question, above the next one.
    const add = box(dialog, "Add the cards you received to your collection");
    expect(remove.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(warning.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog).not.toHaveTextContent("Azula");
  });

  it("draws no deck line at all where every given card is held outside the reader's decks", async () => {
    const user = userEvent.setup();
    backend.trades = [
      trade({
        id: 5,
        lines: [
          // A deck holds another copy, and the line does not reach for it.
          line({
            side: "mine",
            name: "Sol Ring",
            source: "collection",
            owned: 1,
            ownedInDecks: 1,
            deckNames: ["Serah"],
          }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });

    expect(box(dialog, "Take the cards you gave out of your collection")).toHaveAccessibleDescription(
      "1 card. It is in your collection.",
    );
    expect(dialog).not.toHaveTextContent("out of a deck");
    expect(dialog).not.toHaveTextContent("Serah");
  });

  /**
   * A line with no price is in neither total. The balance panel says how many there are; the
   * summary a finish is confirmed against, and the trade's entry in the list, used not to — and
   * here that is *Even trade* over four cards nobody has priced.
   */
  it("says what the figures leave out, in the summary and on the trade's entry", async () => {
    const user = userEvent.setup();
    backend.trades = [
      trade({
        id: 5,
        rateTheirs: 80,
        lines: [
          line({ side: "mine", name: "Priced", unitPrice: 2 }),
          line({ side: "mine", name: "Unpriced", quantity: 3, unitPrice: null }),
          line({ side: "mine", name: "Also unpriced", unitPrice: null }),
          line({ side: "theirs", name: "Other", unitPrice: 2.5 }),
        ],
      }),
      trade({ id: 4, lines: [line({ side: "mine", name: "All priced", unitPrice: 1 })] }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    const pane = screen.getByRole("complementary", { name: "Trades" });
    // 2.00 against 2.50 at 80%: even, with two lines out of it.
    const entry = within(pane).getByRole("button", { name: /Trade 5/ });
    expect(entry).toHaveTextContent("Even trade2 without a price");
    expect(within(pane).getByRole("button", { name: /Trade 4/ })).not.toHaveTextContent(
      "without a price",
    );

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });

    expect(dialog).toHaveTextContent("You give$2.005 cards2 without a price");
    // Their side is rated: the full figure is beside the adjusted one, as on the panel behind.
    expect(dialog).toHaveTextContent("They give$2.00$2.50 at 100%1 card");
    expect(within(dialog).getByText("Even trade")).toBeVisible();
  });

  it("opens with every step off on a trade that was finished before", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade({ finishedBefore: true })];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });

    for (const each of within(dialog).getAllByRole("checkbox")) expect(each).not.toBeChecked();
    expect(dialog).toHaveTextContent("This trade was finished once before");
    // A folder for cards that are not being added is not a question.
    expect(
      within(dialog).getByRole("button", { name: "Folder for the cards you received" }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Finish trade" }));
    expect(ipcMock.tradeFinish).toHaveBeenCalledExactlyOnceWith(5, {
      removeGiven: false,
      addReceived: false,
      folderId: null,
      unwishReceived: false,
      wishGiven: false,
    });
  });

  it("keeps the dialog up and says why when the finish is refused", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    ipcMock.tradeFinish.mockRejectedValue("That folder no longer exists.");
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");

    await user.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = screen.getByRole("dialog", { name: "Finish trade" });
    await user.click(within(dialog).getByRole("button", { name: "Finish trade" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't finish the trade — That folder no longer exists.",
    );
    expect(within(section).getByRole("button", { name: "Archive" })).toBeVisible();
  });

  it("cancels without writing, and hands the caret back to the button", async () => {
    const user = userEvent.setup();
    backend.trades = [canvasTrade()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 5");
    const opener = within(section).getByRole("button", { name: "Finish trade" });

    await user.click(opener);
    await user.click(
      within(screen.getByRole("dialog", { name: "Finish trade" })).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(screen.queryByRole("dialog", { name: "Finish trade" })).not.toBeInTheDocument();
    expect(ipcMock.tradeFinish).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });
});

describe("a closed trade", () => {
  const finished = () =>
    canvasTrade({
      id: 2,
      name: "Trade 2",
      status: "finished",
      finishedBefore: true,
      rateTheirs: 80,
      closedAt: day(9, 6),
      outcome: {
        removedFromCollection: 3,
        removedFromDecks: 0,
        addedToCollection: 3,
        removedFromWishlist: 1,
        addedToWishlist: 0,
      },
    });

  it("is the same page with nothing to press but Duplicate, Reopen and Delete", async () => {
    const user = userEvent.setup();
    backend.trades = [finished()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 2");

    expect(
      within(section).getByText("Finished 6 Sep 2026 · Prices kept from that day, in USD"),
    ).toBeVisible();
    expect(section).toHaveTextContent(
      "Finished and archived, so nothing here can be edited. Finishing it took 3 cards out of " +
        "your collection, added 3 cards to your collection and took 1 card off your wishlist.",
    );

    // Past tense, on the headings and on the balance: 64.39 against 69.68.
    const gave = side(section, "You gave");
    const got = side(section, "They gave");
    expect(got).toHaveTextContent("80% of market");
    const balance = within(section).getByRole("region", { name: "Balance" });
    expect(balance).toHaveTextContent("You gave$64.39");
    expect(balance).toHaveTextContent("They gave$69.68$87.09 at 100%");
    expect(within(balance).getByText("You owed them")).toBeVisible();

    // No way to add, and no way to change what is there.
    expect(within(section).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(section).queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /^Printing of/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /^Price for/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /^Scan cards/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Rename trade" })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Finish trade" })).not.toBeInTheDocument();
    // The printing and finish a control used to say are one line of text.
    expect(lineOf(gave, "Swords to Plowshares")).toHaveTextContent("EMA 32 · Foil");

    await user.click(within(section).getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((row) => row.textContent)).toEqual(["Delete…"]);
  });

  it("reopens into the editable page", async () => {
    const user = userEvent.setup();
    backend.trades = [finished()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 2");

    await user.click(within(section).getByRole("button", { name: "Reopen" }));

    expect(ipcMock.tradeReopen).toHaveBeenCalledExactlyOnceWith(2);
    expect(await within(section).findByRole("button", { name: "Finish trade" })).toBeVisible();
    expect(side(section, "You give")).toBeVisible();
    expect(section).toHaveFocus();
  });

  it("duplicates into a new open trade and shows it", async () => {
    const user = userEvent.setup();
    backend.trades = [finished()];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 2");

    await user.click(within(section).getByRole("button", { name: "Duplicate" }));

    expect(ipcMock.tradeDuplicate).toHaveBeenCalledExactlyOnceWith(2);
    const copy = await tradeSection("Trade 2 copy");
    expect(within(copy).getByRole("button", { name: "Finish trade" })).toBeVisible();
  });

  it("says an archived trade moved nothing, and keeps its balance in the present", async () => {
    backend.trades = [
      canvasTrade({ id: 1, name: "Trade 1", status: "archived", closedAt: day(8, 23) }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 1");

    expect(
      within(section).getByText("Archived 23 Aug 2026 · Prices kept from that day, in USD"),
    ).toBeVisible();
    expect(section).toHaveTextContent(
      "Archived without finishing, so nothing here can be edited. " +
        "Archiving it changed nothing in your collection or your wishlist.",
    );
    // Nothing changed hands, so nothing is in the past tense.
    expect(side(section, "You give")).toBeVisible();
    expect(within(section).getByText("You owe them")).toBeVisible();
    expect(within(section).queryByRole("combobox")).not.toBeInTheDocument();
  });

  /**
   * A line's facts are live on a closed trade, so there they describe what *another* finish
   * would take — the deck had two copies and still has one. The record of what this finish took
   * is the banner's; the line keeps the mark of where it came from.
   */
  it("says in the banner what came out of decks, and marks no line as about to", async () => {
    backend.trades = [
      trade({
        id: 2,
        status: "finished",
        finishedBefore: true,
        closedAt: day(9, 6),
        outcome: {
          removedFromCollection: 2,
          removedFromDecks: 1,
          addedToCollection: 0,
          removedFromWishlist: 0,
          addedToWishlist: 0,
        },
        lines: [
          line({
            side: "mine",
            name: "Sol Ring",
            quantity: 2,
            source: "collection",
            owned: 0,
            ownedInDecks: 1,
            deckNames: ["Serah"],
          }),
        ],
      }),
    ];
    wrap(<TradePage />);
    const section = await tradeSection("Trade 2");

    expect(section).toHaveTextContent(
      "Finished and archived, so nothing here can be edited. " +
        "Finishing it took 2 cards out of your collection (1 from a deck).",
    );
    const ring = lineOf(side(section, "You gave"), "Sol Ring");
    expect(deckMark(ring)).toBeNull();
    expect(ring).toHaveTextContent("from your collection");
  });
});
