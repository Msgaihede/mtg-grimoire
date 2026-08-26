import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import { readWishDrag } from "./wishDrag";
import type {
  ImportMatch,
  WishlistFolder,
  WishlistFolderSummary,
  WishlistQuery,
  WishRow,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { dragOnto, startDrag } from "@/test-drag";

const wishlistList = vi.hoisted(() => vi.fn());
const wishlistSetQuantity = vi.hoisted(() => vi.fn());
const wishlistRemove = vi.hoisted(() => vi.fn());
/** Which marketplace the Cost column and the header figure quote. An unmocked command is a
 *  rejected query that silently resolves to the default, so it is answered explicitly. */
const getMarketplace = vi.hoisted(() => vi.fn());
// What the row's own context menu writes. Both are real `invoke`s, so an unmocked one is a
// rejection about a missing Tauri runtime rather than a call anything here could read.
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
// The wishlist's own bulk-import entry point (Task 14) — `CollectionPage.test.tsx`'s pair.
const importResolve = vi.hoisted(() => vi.fn());
const wishlistImportCommit = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
// The cabinet. Every one of these is reached on mount or by a control this file drives, and an
// unmocked `ipc` member is a `TypeError` rather than a rejected query — the page reads the folder
// list and the folder summary before it draws anything.
const wishlistFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderSummary = vi.hoisted(() => vi.fn());
const wishlistFolderCreate = vi.hoisted(() => vi.fn());
const wishlistFolderRename = vi.hoisted(() => vi.fn());
const wishlistFolderMove = vi.hoisted(() => vi.fn());
const wishlistFolderDelete = vi.hoisted(() => vi.fn());
const wishlistSetFolder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    wishlistList,
    wishlistSetQuantity,
    wishlistRemove,
    wishlistAdd,
    collectionAdd,
    getMarketplace,
    importResolve,
    wishlistImportCommit,
    oracleTagsForPrintings,
    wishlistFolderList,
    wishlistFolderSummary,
    wishlistFolderCreate,
    wishlistFolderRename,
    wishlistFolderMove,
    wishlistFolderDelete,
    wishlistSetFolder,
  },
}));

import { WishlistPage } from "./WishlistPage";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { useAppStore } from "@/lib/store";

/** The one printing `import_resolve` answers with for the import test below —
 *  `CollectionPage.test.tsx`'s own `SOL_RING`, copied rather than shared for its reason. */
const SOL_RING: ImportMatch = {
  cardId: "sol-ring",
  name: "Sol Ring",
  setCode: "ltc",
  collectorNumber: "285",
  lang: "en",
  oracleId: "o-sol-ring",
  manaCost: null,
  cmc: null,
  typeLine: "Artifact",
  oracleText: null,
  colors: null,
  colorIdentity: null,
  legalities: null,
  power: null,
  toughness: null,
  layout: null,
  rarity: null,
  faces: null,
  gameChanger: false,
  everUncommon: false,
  printingCount: 1,
  ownedQuantity: 0,
};

/** A wish pinned to one printing, one copy of four already in the binder. */
const BOLT: WishRow = {
  legalities: null,
  id: 7,
  oracleId: "o-bolt",
  cardId: "c1",
  // Loose at the root, which is where every wish lands unless somebody files it — the state the
  // whole first block below is about. `FILED` further down is the same card in a folder.
  folderId: null,
  elsewhere: 0,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  rarity: "common",
  manaCost: "{R}",
  typeLine: "Instant",
  artCardId: "c1",
  quantity: 4,
  preferredFinish: "foil",
  unitPrice: 400.5,
  ownedQuantity: 1,
  notes: null,
  needsReview: null,
  updatedAt: 1_800_000_000,
};

/**
 * A wish for the *card*, which is what a shopping list usually means.
 *
 * `cardId` is null and `artCardId` is not, which is the pair the wall is built on: the wish
 * names no printing, and the backend's join still hands over one to draw (`wishlist.rs`).
 */
const ANY: WishRow = {
  ...BOLT,
  id: 8,
  cardId: null,
  setCode: null,
  collectorNumber: null,
  lang: null,
  rarity: null,
  artCardId: "c-recall",
  name: "Ancestral Recall",
  manaCost: "{U}",
  preferredFinish: null,
  quantity: 1,
  ownedQuantity: 0,
  unitPrice: 12,
};

/**
 * The same card as {@link BOLT}, filed in `Ordered` — the pair `elsewhere` exists to report.
 *
 * With `folder_id` in the storage grain a card filed in a folder and added again at the root is a
 * **second row**, not a bump to the first, so this is the state folders create rather than a
 * fixture convenience.
 */
const FILED: WishRow = {
  ...BOLT,
  id: 12,
  folderId: 1,
  elsewhere: 1,
  name: "Rhystic Study",
  cardId: "c-rhystic",
  artCardId: "c-rhystic",
  setCode: "pcy",
  collectorNumber: "45",
  preferredFinish: null,
  quantity: 1,
  ownedQuantity: 0,
  unitPrice: 30,
};

/**
 * Three folders, and each is a shape the page has to be able to draw — the storybook seeds'
 * arrangement, copied rather than shared for the reason every fixture in this file is.
 *
 * `Ordered` holds a wish of its own **and** a sub-folder, which is the only shape that makes the
 * card's arithmetic visible: `wishlist_folder_summary` is direct per folder, so a card that did
 * not add `Backordered` in would read `1 wish` over a drawer holding three. `Someday` is empty,
 * and an empty folder has **no summary row at all** — the read groups the wishes — so it is the
 * one that catches a card fed a raw `Map.get`.
 */
const ORDERED: WishlistFolder = { id: 1, parentId: null, name: "Ordered", sortOrder: 0 };
const BACKORDERED: WishlistFolder = { id: 2, parentId: 1, name: "Backordered", sortOrder: 0 };
const SOMEDAY: WishlistFolder = { id: 3, parentId: null, name: "Someday", sortOrder: 1 };
const FOLDERS: WishlistFolder[] = [ORDERED, BACKORDERED, SOMEDAY];

/** Direct per folder, and `Someday` is deliberately absent rather than zeroed. */
const SUMMARY: WishlistFolderSummary[] = [
  { folderId: 1, wishes: 1, missing: 1, cost: 10, unpriced: 0 },
  { folderId: 2, wishes: 2, missing: 2, cost: 20, unpriced: 0 },
];

const page = (items: WishRow[], total = items.length) => ({ items, total });

/**
 * What the reconciler actually writes into `needs_review` — `reconcile::flag_deleted`'s
 * sentence at its real length. The wishlist is flagged by the same pass as the collection
 * (`reconcile::sweep_orphans` walks both tables), so the band has the same job here.
 */
const REVIEW_NOTE =
  "Scryfall removed this printing from its database on 2026-04-12. Your copies are still " +
  "recorded — check the printing and re-add it if you can identify it, or remove this entry.";

const lastQuery = () =>
  wishlistList.mock.calls[wishlistList.mock.calls.length - 1][0] as WishlistQuery;

/**
 * The filter bar's sort control.
 *
 * By role and exact name, not a loose label match. Every sortable column header carries a
 * `SORT_HINT` — since the tooltip sweep, a hover tooltip rather than a `title` — but a header's
 * own **accessible name** can still contain "Sort" (`headerLabel`, e.g. "Cost. Prices as of…"),
 * so `/sort/i` on `getByLabelText` would still risk matching the whole header row rather than
 * only the control this file means.
 */
// **`Sort results` and not the bare `Sort` this page drew before it shared `FilterBar`** —
// see `CollectionPage.test.tsx`, whose note this is, and `FilterBar`'s own label.
const sortSelect = () => screen.getByRole("combobox", { name: "Sort results" });
/**
 * Open the filter tray, so a cell behind the Filters disclosure can be pressed.
 *
 * Everything but the box, the colours, the order and the layout pair lives behind that button
 * since this page started drawing `FilterBar` — so a suite that reached straight for a chip is
 * now reaching into a tray that is not mounted. Matched on a prefix: the button's name carries
 * the live count (`Show filters — 2 active`), which moves as a case presses things.
 */
async function openTray(user: {
  // Structural, so the bare `userEvent` module and a `userEvent.setup()` instance both satisfy it
  // — this file uses each in different cases, and the two are not the same type.
  click: (element: Element) => Promise<unknown>;
}): Promise<void> {
  await user.click(screen.getByRole("button", { name: /^Show filters/ }));
}


/**
 * The header's money figure, scoped — a two-row wishlist prints the same amount in the total
 * and in the row it came from, and an unscoped query cannot tell the sum from a term.
 *
 * **One figure now, not the pair this header used to draw.** The label names the currency
 * because the figure changes denomination in Settings, so the scoping selector takes it.
 */
const total = async (currency: "USD" | "EUR" = "USD") =>
  (await screen.findByText(`Still to buy (${currency})`)).closest("div") as HTMLElement;

/**
 * The page, under the two providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it (so that every surface offering a right-click stays renderable on its own), which
 * means a page
 * rendered bare would open nothing and pass every menu assertion below by never being asked.
 *
 * **No `CardToDeckProvider`, and a test that expands "Add to → Deck" will need one** — the deck
 * picker throws without it, deliberately, rather than swallowing the add. It goes **above**
 * `ContextMenuProvider` and not inside it: the menu panel is drawn as a *sibling* of that
 * provider's children, so a provider around this page is around none of the menu's rows.
 * `CollectionPage.test.tsx` has the wiring, and `App.tsx` uses the same nesting.
 *
 * `TooltipProvider` is the same trade as `ContextMenuProvider`, for `useTooltip` — the
 * needs-review band's and the printing cell's hover assertions below would bind a tooltip that
 * can never open without it.
 *
 * **`staleTime` is 0 here and 30 000 in the app** (`src/lib/query.ts`), and the gap hides a whole
 * class of bug: at 0 every navigation refetches, so a cache nothing invalidated is repaired by
 * the next visit and a missing invalidation is invisible. One test below opts into the app's own
 * number for exactly that reason.
 */
function wrap(ui: ReactElement, { staleTime = 0 }: { staleTime?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ContextMenuProvider>{ui}</ContextMenuProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

/**
 * A right-click, and nothing awaited.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the surface's handler is on
 * the row, never on the cell the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * jsdom lays nothing out, so the virtualiser measures a scroller of zero height and renders
 * no rows at all. `@tanstack/react-virtual` sizes it with `offsetHeight` and scrolls it with
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  wishlistList.mockReset().mockResolvedValue(page([BOLT]));
  wishlistSetQuantity.mockReset().mockResolvedValue({ id: 7, quantity: 5, removed: false });
  wishlistRemove.mockReset().mockResolvedValue({ id: 7, quantity: 0, removed: true });
  // TCGplayer unless a test says otherwise — the default, and what every `$` below asserts.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  // One printing, so a one-line paste resolves to something the wishlist's own preview can
  // plan and commit — `CollectionPage.test.tsx`'s pair.
  importResolve.mockReset().mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  wishlistImportCommit.mockReset().mockResolvedValue({ added: 1, updated: 0, removed: 0 });
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  // **A wishlist nobody has filed, which is the case every block but the last one is about.** The
  // cabinet draws nothing at all without folders — no breadcrumb, no cards, no strip — so this
  // default is what keeps the rest of this file a test of the list rather than of the tree.
  wishlistFolderList.mockReset().mockResolvedValue([]);
  wishlistFolderSummary.mockReset().mockResolvedValue([]);
  wishlistFolderCreate.mockReset().mockResolvedValue(SOMEDAY);
  wishlistFolderRename.mockReset().mockResolvedValue(ORDERED);
  wishlistFolderMove.mockReset().mockResolvedValue(ORDERED);
  wishlistFolderDelete.mockReset().mockResolvedValue(undefined);
  wishlistSetFolder.mockReset().mockResolvedValue({ id: 7, quantity: 4, removed: false });
  // The table, which is not this view's default — the wall is (`store.ts`). Everything in the
  // first block below is about the list view and says so by asking for it; `the wall` block at
  // the end switches to the grid, and one test there holds the default itself. The same
  // arrangement `CollectionPage.test.tsx` uses from the other end.
  useAppStore.setState({
    wishlistView: "table",
    selectedCardId: null,
    importDefaults: { condition: "NM", finish: null },
  });
});

describe("WishlistPage", () => {
  /**
   * The whole question a wishlist answers, per row: how far along am I. A fraction in the
   * data face and nothing else — no bar, because the direction's motion and colour budget is
   * spent on the mana line and the card art, and forty progress bars would out-shout both.
   */
  it("says what is still needed, in the data face and without a bar", async () => {
    wrap(<WishlistPage />);

    const readout = await screen.findByText("1 of 4 owned");
    expect(readout).toHaveClass("font-mono", "tabular-nums");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /**
   * A wishlist that deletes its own entries loses the record of why they were there — so a
   * covered wish is marked rather than removed, in the same cell and the same word.
   */
  it("marks a fulfilled wish instead of hiding it", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }]));
    wrap(<WishlistPage />);

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("Fulfilled")).toBeInTheDocument();
    expect(screen.queryByText(/of 4 owned/)).not.toBeInTheDocument();
  });

  /** "What is still missing" is the list's usual question, so it is one press away. */
  it("narrows to the wishes the collection has not covered", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    await waitFor(() => expect(lastQuery().fulfilled).toBe(false));

    // And round the other way, because the opposite question — what did I already get? — is
    // the reason a fulfilled wish is kept in the first place. The tray is still open from the
    // press above — it is a disclosure the reader opened, not a menu that closes behind them.
    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    expect(await screen.findByRole("button", { name: "Fulfilled" })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().fulfilled).toBe(true));
  });

  /**
   * Spec §6's distinction, said in words: a wish with no `card_id` is for the *card*, and a
   * shopping list that showed it as a printing would send the reader hunting one particular
   * piece of cardboard they never asked for.
   */
  it("says when a wish is for any printing, and which one when it is not", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/LEA · 161/)).toBeInTheDocument();
    expect(screen.getByText(/Any printing/)).toBeInTheDocument();
  });

  /**
   * A wish *for the foil* is not filled by the nonfoil in the binder — that is why finish is
   * part of what makes two wishes two wishes, and why `ownedQuantity` on a wish row is
   * finish-aware where the search's field of the same name is not. A row that did not say so
   * would show two identical lines for one card.
   */
  it("says which finish a wish is for", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/LEA · 161 · Foil/)).toBeInTheDocument();
    // And says nothing where there is no preference, rather than inventing "Nonfoil".
    expect(screen.getByText("Any printing")).toBeInTheDocument();
  });

  /**
   * A shopping list is where the number of copies is *maintained*: the stepper writes
   * straight through, as the collection table's does.
   *
   * **The mock answers the new number on the re-read as well as from the write**, and that is
   * not fixture ceremony. Since 2026-08-22 the stepper settles the whole `["wishlist"]` root —
   * a copy count is what a folder's subtotal is a function of, and that arithmetic is the
   * backend's — so the list is asked again and its answer is the one that stands. A mock that
   * went on returning four would be a backend that had not stored the write.
   */
  it("writes the wanted quantity straight through from the row", async () => {
    let quantity = 4;
    wishlistList.mockImplementation(async () => page([{ ...BOLT, quantity }]));
    wishlistSetQuantity.mockImplementation(async (id: number, next: number) => {
      quantity = next;
      return { id, quantity: next, removed: false };
    });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Increase Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    );

    expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 5);
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
      ).toHaveValue(5),
    );
  });

  /**
   * `wishlistSetQuantity(0)` *deletes* the row — the deliberate opposite of the collection's,
   * because a wish for none of something is not a wish. So the stepper never reaches zero and
   * the removal is its own control, always offered: crossing something off is what a shopping
   * list is for.
   */
  it("removes a wish through its own control, never through the stepper", async () => {
    // At one copy, which is where the stepper would step into a deletion if it could. The list
    // empties on the re-read for the reason the stepper's does above: `remove` settles the whole
    // `["wishlist"]` root, so the backend's answer is what the row's absence rests on rather than
    // the optimistic patch alone.
    let gone = false;
    wishlistList.mockImplementation(async () =>
      gone ? page([]) : page([{ ...BOLT, quantity: 1 }]),
    );
    wishlistRemove.mockImplementation(async (id: number) => {
      gone = true;
      return { id, quantity: 0, removed: true };
    });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(
      screen.getByRole("button", {
        name: "Decrease Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    ).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    );

    expect(wishlistRemove).toHaveBeenCalledWith(7);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
  });

  /**
   * **The duplicate mark must not outlive the duplicate**, which is the second thing `remove`'s
   * patch-and-invalidate-the-search settle could not answer for (fixed 2026-08-22).
   *
   * `elsewhere` is a correlated count over the **whole** table — deliberately, because the wish
   * it is about is one the reader is not looking at — so it is not a field this page can adjust
   * when a row goes. Patching the removed row out and stopping there left the survivor still
   * saying "Also on your wishlist…", which is the one mark whose entire job is honesty about
   * duplicates now pointing at a wish that does not exist. It is also the mark a reader consults
   * before ordering the card again, so a stale one costs money rather than tidiness.
   *
   * **At the app's own `staleTime`** (`src/lib/query.ts`, 30s) and with no navigation in the
   * test, because that is the shape the reader is in: nothing remounts the list, nothing refocuses
   * the window, and an invalidation is the only event in the app that can ask the question again.
   */
  it("clears the elsewhere mark from the survivor when its duplicate is crossed off", async () => {
    // Two wishes for one oracle card — the foil and the plain — which is a pair the storage grain
    // makes legal and `elsewhere` exists to report.
    const PLAIN: WishRow = { ...BOLT, id: 21, elsewhere: 1, preferredFinish: null };
    const FOIL: WishRow = { ...BOLT, id: 22, elsewhere: 1 };
    let gone = false;
    wishlistList.mockImplementation(async () =>
      gone ? page([{ ...PLAIN, elsewhere: 0 }]) : page([PLAIN, FOIL]),
    );
    wishlistRemove.mockImplementation(async (id: number) => {
      gone = true;
      return { id, quantity: 0, removed: true };
    });

    wrap(<WishlistPage />, { staleTime: 30_000 });
    expect(await screen.findAllByRole("img", { name: /Also on your wishlist/ })).toHaveLength(2);

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    );
    expect(wishlistRemove).toHaveBeenCalledWith(22);

    // The survivor stays listed and stops warning about a wish that is no longer there.
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /Also on your wishlist/ })).toBeNull(),
    );
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * What the list is *for*: the money still to spend. Counted over what is missing rather
   * than over what is wanted — three of the four Bolts at $400.50, plus the Recall — because
   * a total that charged the reader for cards already in the binder is a number nobody can
   * act on. Spec §5: it says how old the prices are, and whose.
   */
  it("adds up what is still to buy, and says how old the prices are", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    // Three of the four Bolts at $400.50, plus the Recall.
    expect(await within(await total()).findByText("$1,213.50")).toBeInTheDocument();
    // `Figure`'s own `title` prop, bound through `useTooltip()` since the tooltip sweep
    // rather than a native attribute.
    const figure = await total();
    await userEvent.hover(figure);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.tcgplayer));
    await userEvent.unhover(figure);
    // One figure, not the pair this header drew before the marketplace setting existed: two
    // totals over one shopping list is two answers to the question it is open to ask.
    expect(screen.queryByText("Still to buy (EUR)")).not.toBeInTheDocument();
  });

  /** A fulfilled wish costs nothing to finish, so it adds nothing to the total. */
  it("charges nothing for a wish the collection already covers", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }, ANY]));
    wrap(<WishlistPage />);

    expect(await within(await total()).findByText("$12.00")).toBeInTheDocument();
  });

  /** A total that silently omits the cards it has no price for is a number that lies by
   *  rounding down — the same rule the collection header follows. */
  it("says how many wishes the total could not price", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: null }, ANY]));
    wrap(<WishlistPage />);

    const figure = await total();
    // The note is its own node beside the figure, so the sum reads off the pair.
    expect(await within(figure).findByText("1 unpriced")).toBeInTheDocument();
    expect(figure).toHaveTextContent("$12.00");
  });

  /**
   * Spec §7: this header mirrors the collection's, and that one now quotes the marketplace the
   * reader picked. On Cardmarket the figure, the label and the as-of sentence all move
   * together, and the dollars are not on screen at all.
   *
   * **And the unpriced count is summed from the rows on screen, which is the half that
   * matters.** No two marketplaces have the same holes — an etched wish has no `eur_etched` key
   * on Cardmarket, and a card a bulk feed has never listed is unpriced on that feed alone — so
   * a row this marketplace does not quote arrives with a `null` unit price, contributes nothing
   * to the sum, and is counted. Nothing is borrowed, because there is nothing to borrow from.
   */
  it("prices what is still to buy in euros, and counts what it could not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const UNQUOTED: WishRow = {
      ...ANY,
      id: 9,
      name: "Sol Ring",
      preferredFinish: "etched",
      unitPrice: null,
    };
    // What a Cardmarket read answers: the Bolt at €320, the etched wish at nothing at all.
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: 320 }, UNQUOTED]));
    wrap(<WishlistPage />);

    // Three of the four Bolts at €320, and nothing at all for the etched wish.
    const eur = await total("EUR");
    expect(await within(eur).findByText("€960.00")).toBeInTheDocument();
    expect(within(eur).getByText("1 unpriced")).toBeInTheDocument();
    await userEvent.hover(eur);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
    await userEvent.unhover(eur);
    expect(screen.queryByText("Still to buy (USD)")).not.toBeInTheDocument();
  });

  /**
   * The Cost column, per row, in the selected currency — including the `ea` line, which is
   * only drawn where more than one copy is missing and therefore survives every single-copy
   * fixture above it.
   *
   * The marketplace is the other half, and it is on **every** read rather than only a
   * money-sorted one: it decides the figures now, not just the order, so a Cost header cannot
   * rank in one marketplace's money while its cells print another's.
   */
  it("prices the Cost column in the selected currency and sends the marketplace with every read", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    const user = userEvent.setup();
    wishlistList.mockResolvedValue(page([{ ...BOLT, unitPrice: 320 }]));
    wrap(<WishlistPage />);

    const row = (await screen.findByText("Lightning Bolt")).closest('[role="row"]') as HTMLElement;
    // Three of four still missing, at €320 each. Scoped to the row: with one wish on the list
    // the header's total is the same number, and an unscoped query cannot tell a sum from a
    // term — the same reason `total()` above is scoped.
    await waitFor(() => expect(within(row).getByText("€960.00")).toBeInTheDocument());
    expect(within(row).getByText("€320.00 ea")).toBeInTheDocument();

    await waitFor(() => expect(lastQuery().marketplace).toBe("cardmarket"));
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "cost", dir: "desc" }]));
    expect(lastQuery().marketplace).toBe("cardmarket");
  });

  /**
   * The chip is not permanent. A filter for a state a healthy wishlist never reaches is a
   * control that spends its whole life saying nothing — the same reasoning that keeps the
   * collection's banner off the screen until the reconciler has left something behind.
   */
  it("keeps the needs-review chip off a wishlist with nothing flagged", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.queryByRole("button", { name: /needs review/i })).not.toBeInTheDocument();
  });

  /**
   * The half plan 3 could not build: the flagged band renders on a wish, and there was no way
   * to ask for only the wishes that carry one. Three-way, like every other filter in this app
   * that has a meaningful complement — "everything the sync did not touch" is a real question
   * once a reader has worked through the flagged ones.
   */
  it("narrows to the wishes a sync flagged, once there are any", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, needsReview: REVIEW_NOTE }, ANY]));
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await openTray(userEvent);
    await userEvent.click(await screen.findByRole("button", { name: "Needs review" }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));

    // And round the other way, then off — the tri-state the backend takes.
    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));
    expect(await screen.findByRole("button", { name: "Not flagged" })).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().needsReview).toBe(false));

    await userEvent.click(screen.getByRole("button", { name: "Not flagged" }));
    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
  });

  /**
   * The wishlist is flagged by the same reconciler pass as the collection
   * (`reconcile::sweep_orphans` walks both tables), so it renders the sentence the same way:
   * inside the name's cell, so a screen reader reads it with the row it belongs to, and one
   * line holds ~110 of its 175 characters — the half that goes over the edge is the half that
   * says what to do, so the whole of it rides as a `whenClipped` + `interactive` tooltip
   * (`CollectionPage.test.tsx`'s needs-review band, converted the same way).
   */
  it("prints what a sync left against a flagged wish, without clipping the instruction", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, needsReview: REVIEW_NOTE }]));
    wrap(<WishlistPage />);

    const row = (await screen.findByText("Lightning Bolt")).closest('[role="row"]') as HTMLElement;
    const band = within(row).getByText(REVIEW_NOTE);
    expect(within(row).getByText("Needs review:")).toBeInTheDocument();

    // `whenClipped` pinned shut: jsdom lays nothing out, so the band's `scrollWidth`/
    // `clientWidth` both read `0` by default — unclipped — and the provider's `whenClipped`
    // guard returns before arming the open timer.
    fireEvent.pointerEnter(band);
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_OPEN_MS + 150));
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toBeNull();
    fireEvent.pointerLeave(band);

    // The hover affordance, `whenClipped` pinned open: a screen reader already has the text
    // (asserted above via `getByText`), so the panel is `describes: false` and carries no
    // `role="tooltip"` — found by `TOOLTIP_PANEL_ID` instead.
    Object.defineProperty(band, "scrollWidth", { value: 200, configurable: true });
    Object.defineProperty(band, "clientWidth", { value: 100, configurable: true });
    fireEvent.pointerEnter(band);
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull(), {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    const panel = document.getElementById(TOOLTIP_PANEL_ID) as HTMLElement;
    expect(panel).toHaveTextContent(REVIEW_NOTE);
    // `interactive` pinned: the panel takes its own pointer events and its text can be
    // selected.
    expect(panel).toHaveClass("select-text");
    expect(panel).not.toHaveClass("pointer-events-none");
    fireEvent.pointerLeave(band);
  });

  /** An empty wishlist is not a failed search: it says how to fill one. */
  it("explains an empty wishlist instead of blaming the reader for it", async () => {
    wishlistList.mockResolvedValue(page([]));
    wrap(<WishlistPage />);

    expect(await screen.findByText(/nothing on your wishlist yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/match these filters/i)).not.toBeInTheDocument();
  });

  it("blames the filters when a filtered wishlist comes back empty", async () => {
    wishlistList.mockResolvedValue(page([]));
    wrap(<WishlistPage />);
    await screen.findByText(/nothing on your wishlist yet/i);

    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Still missing" }));

    expect(await screen.findByText(/no wishes match these filters/i)).toBeVisible();
  });

  /** A write the backend refused has to be said out loud — a stepper that silently does
   *  nothing is a stepper the reader presses again. */
  it("says so when the wish a stepper writes to is not there any more", async () => {
    wishlistSetQuantity.mockRejectedValue("That wishlist entry is not there any more.");
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: /^Increase Copies wanted of Lightning Bolt/ }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/not there any more/i);
    // And the number goes back to what the wishlist actually holds.
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
      ).toHaveValue(4),
    );
  });

  /**
   * Every list that counts these copies. A wish's `ownedQuantity` is computed from
   * `collection_entries`, and a search result's `wishlisted`/`ownedQuantity` from both — so a
   * write here makes cached rows in two other views wrong.
   */
  it("re-reads the search results after a write, now that they carry the badges", async () => {
    const { client } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await userEvent.click(
      screen.getByRole("button", { name: /^Increase Copies wanted of Lightning Bolt/ }),
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] }));
  });

  it("sends the wishlist's own filters and its sort", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.type(screen.getByLabelText(/search your wishlist/i), "bolt");
    await userEvent.selectOptions(sortSelect(), "price");

    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBe("bolt");
      // The select sets one term, and the direction is the column's own first — "Highest
      // price" is the label, so descending is what it means.
      expect(q.sort).toEqual([{ key: "price", dir: "desc" }]);
      expect(q.limit).toBe(100);
    });
  });

  /**
   * The select and the headers are one state seen from two ends — and the Printing column
   * is the one header in this app that is not a control at all: an any-printing wish names
   * no set, so there is nothing to sort by.
   */
  it("drives one sort from the headers and the select together, and leaves Printing alone", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("columnheader", { name: /^Printing/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Printing/ })).not.toBeInTheDocument();

    // **It opens on the order it is actually in, and `Custom…` is not there to open on** —
    // `CollectionPage.test.tsx`'s twin, and the trap is the same: a controlled `<select>` whose
    // value matches no option silently reports the first row rather than drawing blank.
    expect(sortSelect()).toHaveValue("name");
    expect(screen.queryByRole("option", { name: "Custom…" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Wanted" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("quantity");

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastQuery().sort).toEqual([
        { key: "quantity", dir: "desc" },
        { key: "cost", dir: "desc" },
      ]),
    );

    // Cost alone is an order the select has no option for — it offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "cost", dir: "desc" }]));
    expect(sortSelect()).toHaveValue("");
    expect(screen.getByRole("option", { name: "Custom…" })).toBeDisabled();
  });

  /**
   * Alphabetical by the words on screen, the one order an option list in this app is drawn
   * in (`lib/options.ts`). These four are named for what they *answer* — "Most wanted",
   * "Highest price" — so the order they are declared in is a train of thought rather than
   * anything a reader can see, and a picker showing it would be showing the author's notes.
   * The whole sequence is asserted rather than one entry, because that is the only thing
   * that tells a sorted list from the constant passed straight through.
   *
   * "Custom…" is pinned above them: it is the state of the control rather than an order to
   * pick, and it must not drift into the middle of the list if either it or an order is
   * ever renamed.
   */
  it("offers the sort orders alphabetically, under a pinned Custom…", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    const options = () =>
      within(sortSelect())
        .getAllByRole("option")
        .map((o) => o.textContent);
    const orders = ["Highest price", "Most wanted", "Name", "Recently added"];
    expect(options()).toEqual(orders);

    // A header this select has no option for is the only way to reach "Custom…": Cost sorts
    // by what finishing the wish costs, where the select offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));

    await waitFor(() => expect(sortSelect()).toHaveValue(""));
    expect(options()).toEqual(["Custom…", ...orders]);
  });

  /** Opening a card from a wish is how the reader checks what they are about to buy. */
  it("opens the card a wish is about", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByText("Lightning Bolt"));

    expect(useAppStore.getState().selectedCardId).toBe("c1");
  });

  /** An any-printing wish names no printing, so there is nothing to open — and a row that
   *  looked clickable and did nothing would be worse than one that does not. */
  it("leaves an any-printing wish unopenable rather than opening the wrong card", async () => {
    wishlistList.mockResolvedValue(page([ANY]));
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByText("Ancestral Recall"));

    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * **Every wish can be picked up, and only a pinned one is a card while it is in the air.**
   *
   * The two halves of spec §9's payload, from the page rather than from the module that writes
   * it. A pinned wish genuinely is both things — a printing a deck column can take, and a wish a
   * folder can take — so its record carries both marks and `readDragData` still reads it as the
   * card it always was, which is the proof the deck's drop targets did not regress. An
   * any-printing wish is only the second: there is no printing to carry, and a card payload built
   * from one would arrive somewhere holding an empty id, which addresses every row and no row
   * (`dnd.ts`). So it carries the wish mark **alone** and `readDragData` answers `null` for it —
   * exactly what a deck column saw before, when the row could not be picked up at all.
   */
  it("drags every wish, and only a pinned one as a card", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    const rows = [...container.querySelectorAll('[draggable="true"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");
    expect(rows[1]).toHaveTextContent("Ancestral Recall");

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const pinned = await startDrag(rows[0], { pressOn: screen.getByText("Lightning Bolt") });
    await pinned.cancel();
    const loose = await startDrag(rows[1], { pressOn: screen.getByText("Ancestral Recall") });
    await loose.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
      null,
    ]);
    // And both are wishes, which is what a folder card reads.
    expect(carried.map(readWishDrag)).toEqual([
      { wishId: 7, name: "Lightning Bolt", folderId: null },
      { wishId: 8, name: "Ancestral Recall", folderId: null },
    ]);
  });

  /**
   * **A press on the row's removal is a press on the removal.**
   *
   * The row is the drag handle, and Chromium starts a drag from the nearest draggable
   * *ancestor* of what was pressed — so without the mark, a press on the bin that travelled
   * five pixels would drag the wish and never deliver the click. `cardDraggable` reads where
   * the press landed, which is why this presses one place and drags from another.
   */
  it("does not drag a wish when the press landed on its removal", async () => {
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const row = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(row, {
      pressOn: screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    });
    expect(held.started).toBe(false);
    await held.cancel();

    // And the row itself still is one: the guard is a control's press, not a row's.
    const again = await startDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * **Task 11's first export entry point outside the deck editor, the wishlist's own.** This
   * list pages at 100 too, so what is loaded in memory is a scroll position rather than a
   * decision — the sweep asks for the whole filtered set at 500 a page instead, which is what
   * the `limit: 500` assertion pins.
   *
   * Wishlist opens on the **plain** format (the store's default), which writes one line per
   * card and no header — unlike the collection's CSV, so this is 150 lines for 150 rows with
   * no header to add. No correction needed here; the brief's own correction is the collection
   * page's CSV case.
   */
  it("exports every wish the filter matches, not the page that happens to be loaded", async () => {
    // 150 wishes, a 100-row list page, a 500-row sweep page: one sweep call for the lot.
    const wishes150 = Array.from({ length: 150 }, (_, i) => ({
      ...BOLT,
      id: i + 1,
      cardId: `c${i + 1}`,
      artCardId: `c${i + 1}`,
      name: `Wish ${i + 1}`,
    }));
    wishlistList.mockImplementation(async ({ limit, offset }: WishlistQuery) =>
      page(wishes150.slice(offset, offset + limit), wishes150.length),
    );
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Wish 1");

    await user.click(await screen.findByRole("button", { name: "Export wishlist" }));
    await waitFor(() =>
      expect(wishlistList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })),
    );
    await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
    expect(await screen.findByText(/150 lines/)).toBeInTheDocument();
  });

  /**
   * **Task 14's entry point: the Import button, over `wishlistDestination`.** A line naming no
   * printing is a wish for *any* printing — `WISHLIST_GRAIN`'s own distinction — so the round
   * trip that matters here is that `cardId` reaches `wishlistImportCommit` as `undefined` rather
   * than the pinned printing `import_resolve` answered with.
   */
  it("imports a pasted list into the wishlist", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Import wishes" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a decklist" });
    await user.click(within(dialog).getByLabelText("Decklist"));
    await user.paste("1 Sol Ring");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));

    expect(await screen.findByText(/will be added to your wishlist/)).toBeInTheDocument();

    // Scoped to the dialog: the page's own trigger is still on screen behind it and shares the
    // same accessible name.
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(wishlistImportCommit).toHaveBeenCalledWith(
        [
          {
            oracleId: "o-sol-ring",
            cardId: undefined,
            quantity: 1,
            preferredFinish: undefined,
            notes: undefined,
          },
        ],
        "add",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Import a decklist" })).not.toBeInTheDocument(),
    );
  });
});

/**
 * The card menu, on the one list in this app whose rows may not name a card at all.
 *
 * The same rule that decides whether a row opens the card and whether it can be dragged
 * decides this: a wish with no `card_id` is for the *card*, and there is no printing for a
 * menu to copy a name from, link to, or add a copy of.
 */
describe("the card menu", () => {
  it("opens on a right-click of a pinned wish, without opening the card", async () => {
    wrap(<WishlistPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    rightClick(row);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // The pane belongs to a left click; a right-click asks a question about the row. `App`
    // owns the pane, so the store is the whole of what opening the card means from here —
    // asserting on a `complementary` this page never renders would be an assertion that
    // cannot fail.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The keyboard's route to the same menu, which is a feature rather than a nicety: the reader
   * was asked and chose a menu that opens by keyboard over a mouse-only one. Shift+F10 here;
   * the dedicated ContextMenu key is the primitive's other arm and its rule, not this surface's.
   */
  it("opens from the keyboard on a pinned wish, without opening the card", async () => {
    wrap(<WishlistPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** And the row's own keys still work: this row's `onKeyDown` answers both questions, and the
   *  menu's arm runs in front of the activation rather than instead of it. */
  it("still opens the card on Enter, which the menu's handler sits beside", async () => {
    wrap(<WishlistPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    fireEvent.keyDown(row, { key: "Enter" });

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /** The keyboard is gated on the same `cardId` the pointer is: a wish for any printing names
   *  no card, from either input. */
  it("offers no keyboard menu on a wish for any printing", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    const any = await screen.findByRole("row", { name: /Ancestral Recall/ });

    // `fireEvent` is wrapped in `act`, so an opened menu would already be in the DOM here —
    // the same flush the pointer case needs `act` by hand for.
    fireEvent.keyDown(any, { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("row", { name: /Lightning Bolt/ }), {
      key: "F10",
      shiftKey: true,
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /**
   * A wish may prefer a finish, and a wish *for the foil* is not filled by the nonfoil — so
   * the copy this menu records is the one the wish was for, and the reader is not asked.
   */
  it("records the wish's preferred finish without asking", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    rightClick(await screen.findByRole("row", { name: /Lightning Bolt/ }));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));

    const collection = await screen.findByRole("menuitem", { name: "Collection" });
    // An action, not a submenu: the surface named the finish.
    expect(collection).not.toHaveAttribute("aria-haspopup", "menu");

    await user.click(collection);

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith({
        cardId: "c1",
        finish: "foil",
        condition: "NM",
        quantity: 1,
        // The root, because this reader has no collection folders — which is also why
        // `Collection` above is a plain action rather than the folder submenu (v24).
        folderId: null,
      }),
    );
  });

  /**
   * The negative half, and it is the reason this suite renders both rows: an absence proves
   * nothing unless the same gesture on the row beside it produces the menu.
   *
   * **Both presses are inside `act`, and that is what makes the absence mean anything.** A raw
   * `dispatchEvent` is not flushed synchronously, so a `queryByRole` on the next line finds no
   * menu whether or not one was opened — this test passed against a build that offered the
   * menu on every row until `act` was put round the press. The second half is then measured
   * exactly the same way, so the two halves differ in the row and in nothing else.
   */
  it("offers no menu on a wish for any printing, which names no card to ask about", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);
    const any = await screen.findByRole("row", { name: /Ancestral Recall/ });

    await act(async () => rightClick(any));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    // The same press one row up, so the absence above is about the wish rather than about
    // the harness.
    await act(async () => rightClick(screen.getByRole("row", { name: /Lightning Bolt/ })));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

/**
 * The wall — the layout this view opens on.
 *
 * One tile per **wish**, never per card: the collection's wall merges two entries for one
 * printing into one piece of art, and here the opposite is true, because a foil wish and a
 * nonfoil wish are two wishes with two prices. What these hold is the part a tile cannot copy
 * from the table — which printing it draws, what it says about it, and the two writes that had
 * to move into a panel to fit.
 */
describe("the wall", () => {
  /** The default, held where the `beforeEach` above cannot reach it: the store's initial state. */
  it("is what the wishlist opens on", () => {
    expect(useAppStore.getInitialState().wishlistView).toBe("grid");
  });

  it("draws one tile per wish, with what is owned of it over the art", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
    // The fraction the table spells out, in the two glyphs a corner mark has room for — and
    // the sentence beside it, which is what a screen reader and a tooltip get.
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 owned")).toBeInTheDocument();
  });

  /**
   * The one thing a picture must not settle. An any-printing wish is drawn as *a* printing —
   * the newest of its oracle card, which is the only way it can have art at all — so the caption
   * goes on saying what the wish is for rather than what the tile happens to be showing.
   */
  it("captions a wish for any printing as one, over the art it is drawn as", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    expect(await screen.findByAltText("Ancestral Recall")).toBeInTheDocument();
    expect(screen.getByText("Any printing")).toBeInTheDocument();
    // And a pinned wish's caption is its printing *and* its finish, which together are what
    // make two wishes for one card two wishes.
    expect(screen.getByText("LEA · 161 · Foil")).toBeInTheDocument();
  });

  /**
   * A wish outlives the printing it was made from, so the wall has to answer for one whose card
   * has left the database: the name, no picture, and nothing to press. Fetching art for it would
   * be a request that can only 404.
   */
  it("draws an orphaned wish as a frame with its name and no card to open", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([{ ...BOLT, artCardId: null }]));
    wrap(<WishlistPage />);

    // The no-art fallback prints the name and says which kind of nothing this is — "No card",
    // not "No image": there is no printing to have a picture of. No `<img>` at all.
    expect(await screen.findByText("No card")).toBeInTheDocument();
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    // `BoltNo` with no space: the accname algorithm puts no separator between two inline boxes,
    // which is the same quirk `ResetAll`'s own name works around.
    expect(screen.getByRole("button", { name: /Lightning BoltNo card/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /** What finishing the wish still costs, in the corner the search spends on its printings
   *  count — over the copies still *missing*, which is the header's own arithmetic. */
  it("marks a tile with the cost of the copies still missing", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    // Three still to find at $400.50 each, and not the four the wish asks for. Scoped to the
    // tile: a one-wish list prints the same amount in the header, and an unscoped query cannot
    // tell the sum from the term it was summed from.
    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("$1,201.50")).toBeInTheDocument();
  });

  /** Nothing left to buy is nothing to say: the corner collapses rather than quoting $0.00. */
  it("draws no cost on a wish the collection already covers", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([{ ...BOLT, ownedQuantity: 4 }]));
    wrap(<WishlistPage />);

    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("4/4")).toBeInTheDocument();
    expect(within(tile).queryByText(/^\$/)).not.toBeInTheDocument();
  });

  /**
   * The two writes the table does in place. A 170px caption holds one 24px control, so both
   * moved into a panel behind it — a wall the reader cannot maintain their list from would be
   * the wrong thing to open on.
   */
  it("edits the copies wanted from a tile", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await user.click(
      await screen.findByRole("button", { name: /Edit Lightning Bolt .* on your wishlist/ }),
    );
    await user.click(screen.getByRole("button", { name: /Increase Copies wanted of Lightning/i }));

    await waitFor(() => expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 5));
  });

  it("removes a wish from a tile", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await user.click(
      await screen.findByRole("button", { name: /Edit Lightning Bolt .* on your wishlist/ }),
    );
    await user.click(
      screen.getByRole("button", { name: /Remove Lightning Bolt .* from your wishlist/ }),
    );

    await waitFor(() => expect(wishlistRemove).toHaveBeenCalledWith(7));
  });

  /**
   * The same rule the table's rows follow, on the same wishes: a wish for any printing names no
   * cardboard to ask a question about, so it is offered no menu — and two drawings of one list
   * must not answer differently.
   */
  it("offers a menu on a pinned wish's tile and none on an any-printing one", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    const any = (await screen.findByAltText("Ancestral Recall")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    await act(async () => rightClick(any));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const bolt = screen.getByAltText("Lightning Bolt").closest("[data-grid-index]") as HTMLElement;
    await act(async () => rightClick(bolt));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  /** The toggle is the whole of what changes: one list, two drawings of it. */
  it("switches to the table and back", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await screen.findByAltText("Lightning Bolt");
    await user.click(screen.getByRole("button", { name: "Table view" }));
    expect(await screen.findByRole("row", { name: /Lightning Bolt/ })).toBeInTheDocument();
    expect(useAppStore.getState().wishlistView).toBe("table");

    await user.click(screen.getByRole("button", { name: "Card view" }));
    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
  });
});

/**
 * The list the printings modal's own arrow keys walk, published to the store by this page.
 *
 * It goes through the store because `AllPrintingsDialog` is mounted at `App` level, outside every
 * view, and the order is this page's — a query narrowed by its filter bar. What the modal *does*
 * with a walk belongs to `AllPrintingsDialog.test.tsx`; what this file owes is that a walk of the
 * right shape is published at all, and taken back when the page goes.
 */
describe("the walk it publishes for the printings modal", () => {
  const walk = () => useAppStore.getState().cardWalk;

  /**
   * **`artCardId`, not `cardId`** — the printing each tile is *drawn as*, which for a pinned wish
   * is the one it names and for an any-printing wish is the newest printing of its oracle card.
   * {@link ANY} is that second kind, and it is a stop rather than a hole: it is a tile the reader
   * can see, the modal lists its oracle card's printings, and the card pane behind the scrim
   * opens on the printing the wall was already showing. A walk built from `cardId` would drop it.
   */
  it("publishes the wishes in their drawn order, by the printing each is drawn as", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    await waitFor(() =>
      expect(walk().stops).toEqual([
        { cardId: "c1", oracleId: "o-bolt", name: "Lightning Bolt", deck: null },
        { cardId: "c-recall", oracleId: "o-bolt", name: "Ancestral Recall", deck: null },
      ]),
    );
  });

  /** An orphan has no oracle card, so there are no printings to list and nothing to step onto —
   *  the same rule the deck's own walk drops a row whose printing has left the corpus by. */
  it("steps over a wish whose card has left the corpus", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, oracleId: null }, ANY]));
    wrap(<WishlistPage />);

    await waitFor(() => expect(walk().stops.map((stop) => stop.cardId)).toEqual(["c-recall"]));
  });

  /** The noun the modal's chevrons read into their own names — `Next card in your wishlist`. */
  it("says which list it is", async () => {
    wrap(<WishlistPage />);

    await waitFor(() => expect(walk().label).toBe("your wishlist"));
  });

  /** And it goes when the page does: a walk left behind would step a modal opened somewhere else
   *  through a list nobody is looking at. */
  it("clears the walk when the page goes", async () => {
    const view = wrap(<WishlistPage />);
    await waitFor(() => expect(walk().stops).toHaveLength(1));

    view.unmount();

    expect(walk().stops).toEqual([]);
  });
});

/**
 * The cabinet: the breadcrumb, the folder cards above whichever view is on, and the four writes
 * that shape a folder. Design spec §4 and §9.
 *
 * **The filing is the backend's and nothing here filters.** `wishlist_list` takes `folderId` and
 * `flatten`, so what these tests drive is which read the page asks for and what it draws around
 * the answer — which is why the list mock below answers *per query* rather than resolving once.
 */
describe("the folders", () => {
  /** The root's two wishes, `Ordered`'s one, and all three when the filing is ignored. */
  const listByLevel = async (q: WishlistQuery) =>
    q.flatten === true
      ? page([BOLT, ANY, FILED])
      : page(q.folderId === 1 ? [FILED] : q.folderId === undefined ? [BOLT, ANY] : []);

  beforeEach(() => {
    wishlistList.mockReset().mockImplementation(listByLevel);
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
  });

  /** The `Wishes` figure's own value, which is a `<dd>` beside the label rather than inside it. */
  const wishes = () => screen.getByText("Wishes").nextElementSibling as HTMLElement;

  /** The trail, re-queried each time: every level change replaces the whole `<nav>`. */
  const crumbs = () => screen.getByRole("navigation", { name: "Wishlist folders" });

  /**
   * A real Escape at `document.body`, reporting whether **anything consumed it** —
   * `useDismissOnEscape.test.tsx`'s own helper, here because `userEvent.keyboard` throws the
   * answer away and the answer is the whole of what the three "does nothing" tests below assert.
   * A rung that acted on a press it had no level to spend it on would swallow it from everything
   * behind this page, and a no-op state write looks identical on screen.
   */
  const pressEscape = () => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  };

  /**
   * **A folder card's face is the recursive total, and the summary row it is drawn from is not.**
   * `Ordered` holds one wish itself and a sub-folder holding two, so a card reading its own row
   * raw would say `1 wish` over a drawer holding three — and `Someday`, which has no row at all
   * because the read groups the wishes, would draw nothing rather than the `0 wishes` that is the
   * whole point of seeding an empty folder.
   */
  it("adds a folder's sub-folders into the count on its card", async () => {
    wrap(<WishlistPage />);

    expect(
      await screen.findByRole("button", { name: /^Ordered folder, 3 wishes/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Someday folder, 0 wishes" })).toBeInTheDocument();
    // Direct children only: a card is a door into one drawer, not a picture of the cabinet.
    expect(screen.queryByRole("button", { name: /^Backordered folder/ })).not.toBeInTheDocument();
  });

  /**
   * Drilling in **replaces the level**: the read is a different read, so the root's wishes are
   * gone rather than filtered out of a list that still holds them.
   */
  it("drills into a folder, and the breadcrumb says where the reader is", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));

    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    await waitFor(() => expect(lastQuery().folderId).toBe(1));
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());

    // The last segment is where the reader is standing, so it is neither a link nor a target.
    const trail = screen.getByRole("navigation", { name: "Wishlist folders" });
    expect(within(trail).getByText("Ordered")).toHaveAttribute("aria-current", "page");
    // And the way back out is the segment before it.
    expect(within(trail).getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
    // One level down, the folder inside is what is drawn.
    expect(
      await screen.findByRole("button", { name: /^Backordered folder, 2 wishes/ }),
    ).toBeInTheDocument();
  });

  /**
   * Escape is the way back out, and the breadcrumb is where a reader reads that it worked.
   * `useDismissOnEscape`'s `"navigation"` rung — the floor, the press nothing nearer wanted.
   *
   * **Two levels deep on purpose.** A rung that sent the reader to the root would pass a
   * one-level test and strand anyone who had drilled twice, which is exactly the failure the
   * trail-derived parent exists to prevent.
   */
  it("walks up one folder per Escape", async () => {
    wrap(<WishlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Backordered folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(2));

    await userEvent.keyboard("{Escape}");

    // Its parent, not the root.
    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");

    await userEvent.keyboard("{Escape}");

    // And out of the cabinet altogether: the root's own wishes are back.
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  /**
   * At the top of the cabinet the press is **not this page's**, and it has to be left unconsumed
   * rather than spent on a no-op — a press this rung swallows is one nothing else in the app can
   * ever be given. `defaultPrevented` is the only thing that can tell those two apart, which is
   * why this one test fires a real `KeyboardEvent` instead of driving `userEvent`.
   */
  it("leaves Escape alone at the root", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(pressEscape()).toBe(false);

    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  /**
   * **Flatten is not a rung, and that is a decision.** Escape walks folders; it does not switch
   * the chip off. With the filing ignored there is no level on screen to leave — the breadcrumb
   * says so in inert words — so the press stays unconsumed and the chip stays on.
   */
  it("does not switch Flatten off", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    await userEvent.click(screen.getByRole("button", { name: "Flatten" }));
    await screen.findByText("Rhystic Study");

    expect(pressEscape()).toBe(false);

    expect(screen.getByRole("button", { name: "Flatten" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Wishlist · all folders")).toBeInTheDocument();
  });

  /**
   * The same decision from the side that can actually go wrong: a reader who flattens *while
   * standing in a folder* still has a `folderId` under the flattened list, and walking it would
   * move a level they cannot see — so that un-flattening later would drop them somewhere they
   * never left. Nothing moves, and pressing Flatten back off returns them to `Ordered`.
   */
  it("moves nothing under a flattened list, even standing in a folder", async () => {
    wrap(<WishlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Flatten" }));
    await waitFor(() => expect(lastQuery().flatten).toBe(true));

    expect(pressEscape()).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Flatten" }));
    await waitFor(() =>
      expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page"),
    );
  });

  /**
   * **The filter box owns the first press, and only while it has something to spend it on.**
   *
   * This is the pair the `"navigation"` rung could not ship without. Chromium empties an
   * `<input type="search">` on Escape by itself and does **not** mark the press handled, so one
   * key in a filtered folder would clear the box *and* walk the reader out of the folder they
   * were filtering. jsdom implements no native clear, so what can go red here is the JS half:
   * the box empties, the level holds, and the next press is the view's again.
   */
  it("spends Escape on the filter box first, and on the folder next", async () => {
    wrap(<WishlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await waitFor(() => expect(lastQuery().folderId).toBe(1));

    const box = screen.getByLabelText("Search your wishlist");
    await userEvent.type(box, "rhystic");

    await userEvent.keyboard("{Escape}");

    expect(box).toHaveValue("");
    // The folder is exactly where it was — this is the press that used to do both.
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");

    // Empty now, so the box has nothing to undo and the press falls through to the folder rung.
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  /**
   * **Both header figures describe what is on screen**, which is the level rather than the list.
   * A header that always totalled the whole wishlist would contradict every folder card under it.
   */
  it("counts what is on screen, at the root and inside a folder", async () => {
    wrap(<WishlistPage />);

    await screen.findByText("Lightning Bolt");
    expect(wishes()).toHaveTextContent("2");

    await userEvent.click(screen.getByRole("button", { name: /^Ordered folder/ }));

    await waitFor(() => expect(wishes()).toHaveTextContent("1"));
  });

  /**
   * Flatten is not a filter: it says how much of the tree is on screen. With the filing ignored
   * there is no level to be standing in, so the cards, the drill-down and `+ New folder` all go
   * — the last because there is no current folder to create one inside.
   */
  it("shows every wish while flattened, and puts the cabinet away", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(screen.getByRole("button", { name: "Flatten" }));

    await waitFor(() => expect(lastQuery().flatten).toBe(true));
    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(wishes()).toHaveTextContent("3");
    expect(screen.queryByRole("button", { name: /^Ordered folder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New folder" })).not.toBeInTheDocument();
    // Each wish captioned with where it is filed — without it, flattened is just the old list.
    expect(screen.getAllByText("Filed in").length).toBeGreaterThan(0);
  });

  /**
   * **A plain move is answered by a re-read, not by a guess about where the wish went.**
   *
   * This is the regression test for what the live pass of 2026-08-22 found: the write removed the
   * row from every cached page and then invalidated only the folder summary, so a filed wish was
   * gone from the app until a reload — the destination folder's card counted it while the
   * folder's own list said "Nothing filed here yet." Only the *merge* path re-read, so the common
   * case was the uncovered one.
   *
   * The mock is a backend that really moves the wish, because that is the only thing that can put
   * the row in the destination's list: it is sorted and paged by the backend, and this page knows
   * neither the position nor the page.
   */
  it("re-reads the whole wishlist after a plain move, so the wish is where it was filed", async () => {
    let filed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) => {
      const bolt = { ...BOLT, folderId: filed ? 1 : null };
      if (q.flatten === true) return page([bolt, ANY, FILED]);
      if (q.folderId === 1) return page(filed ? [FILED, bolt] : [FILED]);
      return page(filed ? [ANY] : [bolt, ANY]);
    });
    wishlistSetFolder.mockImplementation(async (id: number) => {
      filed = true;
      // The **same** id, which is what makes this the plain path rather than the merge one.
      return { id, quantity: 4, removed: false };
    });

    // **The app's own `staleTime`, which is what made the live bug persist rather than blink.**
    // `src/lib/query.ts` keeps an answered query fresh for 30s, so the folder's list is served
    // from cache when the reader drills back into it and an invalidation is the only thing that
    // can mark it stale. At this file's default of 0 every navigation refetches and the whole
    // defect is invisible — which is why the folder is visited *before* the move below.
    const { client, container } = wrap(<WishlistPage />, { staleTime: 30_000 });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("Lightning Bolt");

    // Open the destination once, so its (wishless) page is in the cache and fresh.
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");
    const trail = screen.getByRole("navigation", { name: "Wishlist folders" });
    await userEvent.click(within(trail).getByRole("button", { name: "Wishlist" }));
    await screen.findByText("Lightning Bolt");

    const card = (await screen.findByRole("button", { name: /^Ordered folder/ })).closest("li")!;
    await dragOnto(container.querySelector('[draggable="true"]')!, card);

    expect(wishlistSetFolder).toHaveBeenCalledWith(7, 1);
    // The whole root, never the summary alone: the level being left, the level being joined and
    // both folder subtotals have all moved, and the backend is the only thing that knows any of
    // them.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    // The root loses the row because the *answer* says so, and the header follows the answer.
    await waitFor(() => expect(wishes()).toHaveTextContent("1"));

    // And the wish really is in the folder — the half the optimistic removal lost outright.
    await userEvent.click(screen.getByRole("button", { name: /^Ordered folder/ }));
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * **Flattened, a moved wish stays listed and changes its caption**, which is where the removal
   * was wrong in a second way: with the filing ignored the list is not a level, so nothing about
   * the move takes the row off it — and a wish blinking out of a list that has just promised to
   * show every one of them is the switch contradicting itself.
   *
   * It is also the keyboard's whole route to `wishlist_set_folder`, which is why the panel keeps
   * it: a drag-only affordance is half a feature, and it is the half a keyboard cannot use.
   */
  it("keeps a moved wish listed while flattened, and moves its caption", async () => {
    let filed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      q.flatten === true
        ? page([{ ...BOLT, folderId: filed ? 1 : null }, ANY, FILED])
        : page(q.folderId === 1 ? [FILED] : [BOLT, ANY]),
    );
    wishlistSetFolder.mockImplementation(async (id: number) => {
      filed = true;
      return { id, quantity: 4, removed: false };
    });
    /** The Bolt's own row, re-queried each time: the re-read replaces the element. */
    const boltRow = () => screen.getByText("Lightning Bolt").closest('[role="row"]') as HTMLElement;

    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    await userEvent.click(screen.getByRole("button", { name: "Flatten" }));
    await screen.findByText("Rhystic Study");
    expect(within(boltRow()).getByText("Wishlist")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Lightning Bolt (LEA 161, Foil) on your wishlist",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Move to folder: Lightning Bolt (LEA 161, Foil)" }),
    );
    const destinations = await screen.findByRole("group", {
      name: "Move Lightning Bolt (LEA 161, Foil) to a folder",
    });
    await userEvent.click(within(destinations).getByRole("button", { name: /Ordered/ }));

    expect(wishlistSetFolder).toHaveBeenCalledWith(7, 1);
    // The panel is shut first, and not for tidiness: it is drawn *inside this row*, and its own
    // Folder line says the same word the caption is about to — so a query for it against an open
    // panel matches two elements and cannot tell which one moved.
    await userEvent.keyboard("{Escape}");

    // Listed throughout — and captioned with where it went, once the answer is in.
    await waitFor(() => expect(within(boltRow()).getByText("Ordered")).toBeInTheDocument());
    expect(wishes()).toHaveTextContent("3");
  });

  /**
   * `+ New folder` promises "here", which is the whole reason it is hidden while flattened — so
   * the parent it sends is the folder the reader is standing in and never the root by default.
   */
  it("creates a folder inside the one the reader is standing in", async () => {
    wrap(<WishlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");

    await userEvent.click(screen.getByRole("button", { name: "+ New folder" }));
    await userEvent.type(await screen.findByLabelText("New folder name"), "Paid for");
    await userEvent.click(screen.getByRole("button", { name: "Create folder" }));

    expect(wishlistFolderCreate).toHaveBeenCalledWith(1, "Paid for");
  });

  /**
   * The `⋯` trigger is the app's first click-opened menu, and it reaches the three things a
   * folder can have done to it. The delete question is the one a reader guesses wrong: the two
   * cascades point opposite ways, and the sentence says both with the reassuring half first.
   */
  it("reaches Rename, Move and Delete from a folder card, and says what a delete takes", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Manage Ordered" }));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Rename/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Move to folder/ })).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole("menuitem", { name: /Delete/ }));

    expect(
      await screen.findByText(
        "Its wishes move back to your wishlist; folders inside it are deleted.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));

    expect(wishlistFolderDelete).toHaveBeenCalledWith(1);
  });

  /** The rename field is the same one field the create uses, doing its other job. */
  it("renames a folder from the same field", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Manage Ordered" }));
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Rename/ }),
    );

    // **The caret is already in the field with the name selected**, which is why the keystrokes
    // are sent to whatever holds it rather than typed *at* the field: `userEvent.type` clicks
    // first, and a click collapses the selection — so it would append to the old name and the
    // test would pass over a field that had never selected anything.
    const field = await screen.findByLabelText("Rename Ordered");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Ordered");
    await userEvent.keyboard("On its way");
    await userEvent.click(screen.getByRole("button", { name: "Rename folder" }));

    expect(wishlistFolderRename).toHaveBeenCalledWith(1, "On its way");
  });

  /**
   * A folder may not go inside itself or inside anything it holds — `wishlist_folders.parent_id`
   * cascades onto itself, so a cycle is a graph SQLite would walk forever the day the folder is
   * deleted. The backend refuses it in words; this is the fence drawn before the reader can ask.
   */
  it("offers a folder every destination but itself and what it holds", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Manage Ordered" }));
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Move to folder/ }),
    );

    const list = await screen.findByRole("group", { name: "Move Ordered into a folder" });
    // Its own row and its child's are inert; the third folder is a live destination.
    expect(within(list).getByRole("button", { name: /Ordered/ })).toBeDisabled();
    expect(within(list).getByRole("button", { name: /Backordered/ })).toBeDisabled();
    await userEvent.click(within(list).getByRole("button", { name: /Someday/ }));

    expect(wishlistFolderMove).toHaveBeenCalledWith(1, 3);
  });

  /**
   * The drag's write, and it is `wishlist_set_folder` — the same command `Move to folder…`
   * calls, so a drag and the keyboard's route merge on a taken grain identically.
   */
  it("files a wish dropped on a folder card", async () => {
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const row = container.querySelector('[draggable="true"]')!;
    const card = (await screen.findByRole("button", { name: /^Ordered folder/ })).closest("li")!;

    await dragOnto(row, card);

    expect(wishlistSetFolder).toHaveBeenCalledWith(7, 1);
  });

  /**
   * And the way back **out**, which is the half a folder card cannot do: a card only ever takes a
   * wish deeper, so without the breadcrumb the gesture would be one-way.
   */
  it("un-files a wish dropped on the breadcrumb's root", async () => {
    const { container } = wrap(<WishlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");

    const row = container.querySelector('[draggable="true"]')!;
    const trail = screen.getByRole("navigation", { name: "Wishlist folders" });
    await dragOnto(row, within(trail).getByRole("button", { name: "Wishlist" }));

    expect(wishlistSetFolder).toHaveBeenCalledWith(12, null);
  });

  /**
   * An empty folder is not an empty wishlist, and telling the reader how to put a card on a list
   * they already have is answering a question they did not ask.
   */
  it("says a folder is empty without repeating the root's instruction", async () => {
    wrap(<WishlistPage />);

    await userEvent.click(await screen.findByRole("button", { name: /^Someday folder/ }));

    expect(await screen.findByText("Nothing filed here yet.")).toBeInTheDocument();
    expect(
      screen.queryByText(/Add cards from search with the \+ on any row or tile/),
    ).not.toBeInTheDocument();
  });

  /**
   * **A folder card counts a wish that is gone** — the first half of the settle that was missing
   * from `remove` until 2026-08-22, and the reason both halves are pinned at the app's own
   * `staleTime` rather than at this file's default of 0.
   *
   * `remove` patched the row out of `["wishlist", "list"]` and then invalidated `["cards",
   * "search"]` and nothing else, on the argument that the page already held the answer. It held
   * the answer about the *row*. `wishlist_folder_summary` is a `GROUP BY` with an owned-copies
   * subquery and a price expression behind it — arithmetic this page cannot redo — so the drawer
   * the wish had been in went on advertising it: `Ordered folder, 3 wishes, $30.00` over a
   * backend holding two at $20. On a shopping list that subtotal is the number somebody buys
   * against.
   *
   * **What `staleTime: 30_000` buys, precisely.** The summary's observer is mounted for the life
   * of this page — nothing here unmounts it, so there is no remount to refetch on — and at the
   * app's own number the answer stays *fresh* as well as mounted, which leaves an invalidation as
   * the only thing in the app that can move it. Drilling in and climbing back out is deliberate:
   * at a `staleTime` of 0 that round trip repairs the **list** for free on the new observer's
   * mount, and a reader watching only the row would conclude the write settles correctly.
   */
  it("re-reads a folder's subtotal when a wish inside it is crossed off", async () => {
    let removed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      removed && q.folderId === 1 ? page([]) : listByLevel(q),
    );
    // The backend after the delete: `Ordered`'s own row is gone from the `GROUP BY` entirely,
    // because the read groups the wishes and there are none left directly in it. Its card is
    // still the recursive total, so `Backordered`'s two survive underneath.
    wishlistFolderSummary.mockImplementation(async () =>
      removed ? SUMMARY.filter((s) => s.folderId !== 1) : SUMMARY,
    );
    wishlistRemove.mockImplementation(async (id: number) => {
      removed = true;
      return { id, quantity: 0, removed: true };
    });

    wrap(<WishlistPage />, { staleTime: 30_000 });
    expect(
      await screen.findByRole("button", { name: "Ordered folder, 3 wishes, $30.00" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");
    await userEvent.click(
      screen.getByRole("button", { name: /^Remove Rhystic Study \(PCY 45\) from your wishlist/ }),
    );
    expect(wishlistRemove).toHaveBeenCalledWith(12);

    const trail = screen.getByRole("navigation", { name: "Wishlist folders" });
    await userEvent.click(within(trail).getByRole("button", { name: "Wishlist" }));

    expect(
      await screen.findByRole("button", { name: "Ordered folder, 2 wishes, $20.00" }),
    ).toBeInTheDocument();
  });

  /**
   * The same hole under the other writer: **a stepper press multiplies straight through into the
   * subtotal**, and `setQuantity` was the second of the two that re-read only the search.
   *
   * A copy count is exactly what a folder's money is a function of, so this is the case where the
   * card's figure and the backend's disagree by a number the reader chose themselves — the drawer
   * kept saying `$30.00` while the wish inside it had just been doubled.
   */
  it("re-reads a folder's subtotal when the stepper changes a wish inside it", async () => {
    let quantity = 1;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      q.folderId === 1 ? page([{ ...FILED, quantity }]) : listByLevel(q),
    );
    wishlistFolderSummary.mockImplementation(async () =>
      SUMMARY.map((s) =>
        s.folderId === 1 ? { ...s, missing: quantity, cost: 10 * quantity } : s,
      ),
    );
    wishlistSetQuantity.mockImplementation(async (id: number, next: number) => {
      quantity = next;
      return { id, quantity: next, removed: false };
    });

    wrap(<WishlistPage />, { staleTime: 30_000 });
    expect(
      await screen.findByRole("button", { name: "Ordered folder, 3 wishes, $30.00" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");
    await userEvent.click(
      screen.getByRole("button", { name: "Increase Copies wanted of Rhystic Study (PCY 45)" }),
    );
    expect(wishlistSetQuantity).toHaveBeenCalledWith(12, 2);

    const trail = screen.getByRole("navigation", { name: "Wishlist folders" });
    await userEvent.click(within(trail).getByRole("button", { name: "Wishlist" }));

    expect(
      await screen.findByRole("button", { name: "Ordered folder, 3 wishes, $40.00" }),
    ).toBeInTheDocument();
  });

  /**
   * **The export dialog names the drawer, because the drawer is what is narrowing the sweep.**
   *
   * Nothing about the export was ever *wrong* — `folderId` and `flatten` ride in
   * `wishlist.filters` and in the sweep's key, and the escape hatch sends `flatten: true` — but
   * standing in `Ordered` with nothing typed and no chip pressed, the two sentences read
   * "3 cards matching your filters" and "Export everything, ignoring the filters", and the only
   * thing doing any narrowing was the one thing neither of them mentioned.
   *
   * The clause is on the checkbox at the **root** too, and that is not an oversight: an absent
   * `folderId` asks for the wishes filed nowhere rather than for all of them, so a reader at the
   * top of a cabinet is also looking at a sweep that leaves every drawer out.
   */
  it("names the folder the export is being taken from, and offers the whole cabinet", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    // At the root there is no drawer to name, but ticking the box still widens past the drawers.
    await user.click(await screen.findByRole("button", { name: "Export wishlist" }));
    expect(
      await screen.findByRole("checkbox", {
        name: "Export everything, ignoring the filters and folders",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close export" }));

    await user.click(await screen.findByRole("button", { name: /^Ordered folder/ }));
    await screen.findByText("Rhystic Study");
    await user.click(screen.getByRole("button", { name: "Export wishlist" }));

    expect(await screen.findByText("1 card in Ordered matching your filters")).toBeInTheDocument();
  });

  /**
   * And the root with drawers but nothing loose says **nothing**: the cards are the content, and
   * a sentence over them would be the page contradicting itself.
   */
  it("leaves the status line empty where the folder cards are the content", async () => {
    wishlistList.mockImplementation(async () => page([]));
    wrap(<WishlistPage />);

    await screen.findByRole("button", { name: /^Ordered folder/ });
    expect(screen.queryByText(/Nothing on your wishlist yet/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing filed here yet.")).not.toBeInTheDocument();
  });
});
