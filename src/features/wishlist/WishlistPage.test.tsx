import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TOOLTIP_OPEN_MS, TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import { MENU_CONDITION } from "@/lib/conditions";
import { readWishDrag } from "./wishDrag";
import type {
  CardSummary,
  DeckRow,
  ImportMatch,
  ShelfCount,
  WishlistFolder,
  WishlistFolderSummary,
  WishlistQuery,
  WishOptimizeMove,
  WishRow,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { boxed, pointerDrag, recordDrags, startPointerDrag } from "@/test-drag";
import { openDropdown, pickOption } from "@/test-dropdown";

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
const wishlistFolderReorder = vi.hoisted(() => vi.fn());
const wishlistFolderDelete = vi.hoisted(() => vi.fn());
// The two folder writes that delete wishes (issue #471) — a card's `Clear…`, and the delete
// question's second answer.
const wishlistFolderClear = vi.hoisted(() => vi.fn());
const wishlistFolderDeleteWithWishes = vi.hoisted(() => vi.fn());
const wishlistSetFolder = vi.hoisted(() => vi.fn());
// The price sweep (issue #352). Two commands and one dialog — the plan writes nothing, and only
// the ticked rows reach the apply.
const wishlistOptimizePlan = vi.hoisted(() => vi.fn());
const wishlistOptimizeApply = vi.hoisted(() => vi.fn());
// The docked search column (2026-09-07). `search_cards` is its wall, `facet_cards` and
// `list_sets` are the filter row it draws, `prefetch_images` is what its tiles ask for, and the
// `search_open` pair is the disclosure's memory. Every one of them is a real `invoke`, so an
// unmocked member is a `TypeError` on a page that now mounts this column by default.
const searchCards = vi.hoisted(() => vi.fn());
const facetCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
// The shelves' two reads and their one write. Every one is a real `invoke`, so an unmocked member
// is a `TypeError` on a page that reads the counts and the folds before it draws a shelf.
const wishlistShelfCounts = vi.hoisted(() => vi.fn());
const shelfFolds = vi.hoisted(() => vi.fn());
const setShelfFolds = vi.hoisted(() => vi.fn());
// The deck list — read only where a deck keeps a managed folder here, for the Compare view each
// folder follows (an empty one says that view's sentence).
const deckList = vi.hoisted(() => vi.fn());
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
    wishlistFolderReorder,
    wishlistFolderDelete,
    wishlistFolderClear,
    wishlistFolderDeleteWithWishes,
    wishlistSetFolder,
    wishlistOptimizePlan,
    wishlistOptimizeApply,
    searchCards,
    facetCards,
    listSets,
    prefetchImages,
    searchOpen,
    setSearchOpen,
    wishlistShelfCounts,
    shelfFolds,
    setShelfFolds,
    deckList,
  },
}));

import { WishlistPage } from "./WishlistPage";
import { MANAGED_EMPTY, MANAGED_EMPTY_UNKNOWN } from "./managed";
import { NEW_FOLDER_SHELF } from "./wishShelfPlan";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { SHELF_FOLDS_KEY } from "@/features/shelves/useShelfFolds";
import { EMPTY_SHELF_COPY } from "@/features/shelves/EmptyShelf";
import { FOLD_PAUSED_REASON } from "@/features/shelves/ShelfToolbar";
import { useAppStore } from "@/lib/store";

/** The one printing `import_resolve` answers with for the import test below —
 *  `CollectionPage.test.tsx`'s own `SOL_RING`, copied rather than shared for its reason. */
const SOL_RING: ImportMatch = {
  ownedQuantity: 0,
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
};

/** A wish pinned to one printing, for four copies. */
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
  unitPrice: 30,
};

/**
 * What the **docked search column** finds — a `CardSummary`, which is a different object from the
 * `WishRow`s above and is the whole distinction between the two walls this page now mounts.
 *
 * `finishes` is the JSON the column stores, because `parseFinishes` is what the tile's drag record
 * and the `+` popup both read it through: an unparsed list would be a drag `readSearchCardDrag`
 * refuses rather than one that lands somewhere wrong.
 */
const SEARCH_BOLT: CardSummary = {
  promoTypes: null,
  ownedQuantity: 0,
  id: "c1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  price: 400.5,
  layout: "normal",
  oracleId: "o-bolt",
  finishes: `["nonfoil","foil"]`,
  wishlisted: true,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
  gameChanger: false,
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
const ORDERED: WishlistFolder = { id: 1, parentId: null, name: "Ordered", sortOrder: 0, managedDeckId: null, managedTokens: false };
const BACKORDERED: WishlistFolder = { id: 2, parentId: 1, name: "Backordered", sortOrder: 0, managedDeckId: null, managedTokens: false };
const SOMEDAY: WishlistFolder = { id: 3, parentId: null, name: "Someday", sortOrder: 1, managedDeckId: null, managedTokens: false };
const FOLDERS: WishlistFolder[] = [ORDERED, BACKORDERED, SOMEDAY];

/** Direct per folder, and `Someday` is deliberately absent rather than zeroed. */
const SUMMARY: WishlistFolderSummary[] = [
  { folderId: 1, wishes: 1, copies: 1, cost: 10, unpriced: 0 },
  { folderId: 2, wishes: 2, copies: 2, cost: 20, unpriced: 0 },
];

const page = (items: WishRow[], total = items.length) => ({ items, total });

/**
 * What `wishlist_shelf_counts` answers for a set of wishes — one row per non-empty shelf, `tiles`
 * as rows and `value` as `unit × quantity`, `null` where nothing in the shelf is priced. Only the
 * shelves asked about, as the command is scoped. `peek` is up to four card ids per shelf taken from
 * `unfiltered` — the command's peek ignores the search, so a heading's thumbnails do not change
 * with the box.
 */
function countsFor(
  items: readonly WishRow[],
  shelves?: readonly number[],
  unfiltered: readonly WishRow[] = items,
): ShelfCount[] {
  const peekOf = (id: number) =>
    unfiltered
      .filter((w) => (w.folderId ?? 0) === id)
      .map((w) => w.artCardId ?? w.cardId)
      .filter((cardId): cardId is string => cardId !== null)
      .slice(0, 4);
  const by = new Map<number, ShelfCount>();
  for (const w of items) {
    const id = w.folderId ?? 0;
    if (shelves !== undefined && !shelves.includes(id)) continue;
    const c = by.get(id) ?? {
      folderId: id,
      tiles: 0,
      copies: 0,
      value: null,
      unpriced: 0,
      peek: peekOf(id),
    };
    c.tiles += 1;
    c.copies += w.quantity;
    if (w.unitPrice === null) c.unpriced += 1;
    else c.value = (c.value ?? 0) + w.unitPrice * w.quantity;
    by.set(id, c);
  }
  return [...by.values()];
}

/**
 * A list mock that answers the way `wishlist_list` does since `shelves`: the pool's wishes on the
 * shelves asked for, whose name contains the box's text. A fixture that ignored `shelves` would
 * draw every wish on whatever shelf it names whether the page asked for it or not.
 */
const listByShelves = (pool: readonly WishRow[]) => async (q: WishlistQuery) => {
  const text = q.text?.toLowerCase() ?? "";
  return page(
    pool.filter(
      (w) =>
        (q.shelves === undefined || q.shelves.includes(w.folderId ?? 0)) &&
        w.name.toLowerCase().includes(text),
    ),
  );
};

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
 * The filter bar's sort trigger.
 *
 * By role and exact name, and more load-bearing than it used to be: a sortable column header is
 * `role="button"` too, and a header's own **accessible name** can still contain "Sort"
 * (`headerLabel`, e.g. "Cost. Prices as of…"). Before this control became a `Dropdown` its own
 * `combobox` role kept the two apart by role alone; now both are buttons, so the exact-match
 * `{ name: "Sort" }` — never a `/sort/i` regex — is the whole of what keeps this query off a
 * header.
 */
// **`Sort results` and not the bare `Sort` this page drew before it shared `FilterBar`** -
// see `CollectionPage.test.tsx`, whose note this is, and `FilterBar`'s own label. The page
// lost its own filter bar on 2026-08-26 and draws the shared row now, so the control is named
// for what it orders.
//
// **A `button`, not a `combobox`** - it became a `Dropdown` in the same window. The combobox
// role belongs to a `searchable` dropdown's search box and this one has none.
const sortTrigger = () => screen.getByRole("button", { name: "Sort results" });
/**
 * Open the filter tray, so a cell behind the Filters disclosure can be pressed.
 *
 * Everything but the box, the colours, the order and the layout pair lives behind that button
 * since this page started drawing `FilterBar` - so a suite that reached straight for a chip is
 * now reaching into a tray that is not mounted. Matched on a prefix: the button's name carries
 * the live count (`Show filters - 2 active`), which moves as a case presses things.
 */
async function openTray(user: {
  // Structural, so the bare `userEvent` module and a `userEvent.setup()` instance both satisfy it
  // - this file uses each in different cases, and the two are not the same type.
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
  (await screen.findByText(`Total cost (${currency})`)).closest("div") as HTMLElement;

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
function wrap(
  ui: ReactElement,
  {
    staleTime = 0,
    searchOpen: panelOpen = false,
    folds = {},
  }: { staleTime?: number; searchOpen?: boolean; folds?: Record<string, boolean> } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime } } });
  /**
   * The docked search column, **shut unless a case asks for it** — and that is a deliberate
   * inversion of the app's own default (`DEFAULT_SEARCH_OPEN.wishlist` is `true`).
   *
   * Two `FilterBar`s are mounted together when the column is open, and `FilterBar` names its own
   * controls: the `Show filters` disclosure, the `Sort results` trigger and every tray chip carry
   * the same accessible name in both rows. That is not a bug in either — a control means the same
   * thing wherever it appears — but it makes an unscoped `getByRole` on this page ambiguous, and
   * `test-dropdown.ts`'s helpers query `screen` and cannot be scoped from here.
   *
   * So the hundred cases about *the wishlist* run with the column railed, which is a state a
   * reader reaches with one press, and the cases about *the column* seed it open and say so. It is
   * `DeckSearchPanel.test.tsx`'s `panel({ storedOpen })` seam, reached from the page side.
   *
   * Seeded into the cache rather than through the `search_open` command, because `useSearchOpen`'s
   * query is `staleTime: Infinity` — a seeded entry is the answer, with no round trip to race.
   */
  client.setQueryData(SEARCH_OPEN_KEY, { wishlist: panelOpen });
  // The stored folds, seeded for `useSearchOpen`'s reason one line up: `useShelfFolds` is
  // `staleTime: Infinity`, so a seeded entry is the answer with no round trip to race.
  client.setQueryData(SHELF_FOLDS_KEY, { collection: {}, wishlist: folds });
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

/** The **wish** drag sources on screen, in document order. A heading is picked up by
 *  `folderDraggable`, which marks nothing, so every `[data-dnd-source]` is a wish row or tile. */
const cardSources = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(`[${DND_SOURCE_ATTR}]`),
];

/**
 * Whether a card on the wall is wearing either drop mark.
 *
 * **Both marks moved onto the card's own `<button>` face on 2026-09-03**, off the `<li>` around
 * it — `lib/dropMarks.ts` carries the reason (a ring is a box shadow painted *outside* the border
 * box, so on the wrapper it stood 2px proud of the dashed edge it was meant to agree with, which
 * is the misalignment a reader reported). The drop *registrations* did not move and could not;
 * only the `className` did.
 *
 * **This helper exists because the assertion it replaces would otherwise have gone quietly
 * vacuous.** It read `classList.contains("ring-2")` on the `<li>` and asserts `false` — a target
 * that lights up and then refuses the drop is a promise this page cannot keep. Nothing on this
 * page draws a `ring-2` any more, so left alone it would pass in every state and prove nothing.
 *
 * It asks the whole subtree rather than the face alone, so it goes on answering if a card ever
 * carries its edge somewhere else. The two marks are checked separately because `tailwind-merge`
 * replaces one with the other rather than stacking them: an armed card reads `DROP_EDGE`'s
 * `border-accent/45`, and the one actually under the pointer reads a solid `border-accent` beside
 * `DROP_OVER`'s `bg-accent/15`.
 */
const wearsDropMark = (card: HTMLElement): boolean =>
  [card, ...card.querySelectorAll("*")].some(
    (box) =>
      box.classList.contains("border-accent/45") || box.classList.contains("bg-accent/15"),
  );

/**
 * A shelf's heading, by folder id — `0` is Not sorted, `NEW_FOLDER_SHELF` the folder being added.
 *
 * **Addressed by the row `ShelfHeading` stamps (`data-shelf-heading`), which is the one element its
 * drop target and its drag source both attach to**, and that is the reason rather than a
 * convenience: dnd-kit hit-tests that element's own rectangle and reads a press off it, and jsdom
 * measures every rectangle as zero, so a test that boxed an ancestor of the chevron instead would
 * drop onto nothing, or press nothing, for a reason that is not the page's.
 */
const queryHeading = (id: number) =>
  document.querySelector<HTMLElement>(`[data-shelf-heading="${id}"]`);
const heading = (id: number): HTMLElement => {
  const found = queryHeading(id);
  if (found === null) throw new Error(`no heading for shelf ${id}`);
  return found;
};
const findHeading = (id: number) => waitFor(() => heading(id));
/** The folder's own name on its heading — the press that opens it (spec §3.7). */
const titleOf = (id: number, name: string) => within(heading(id)).getByRole("button", { name });
/** The chevron, named "Collapse Binder" / "Expand Binder" (spec §3.2). */
const chevronOf = (id: number, name: string) =>
  within(heading(id)).getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${name}$`) });
/** The heading's `⋯` — found by what it declares rather than by a name, so the suite does not
 *  pin Task 3's wording of it. */
const menuOf = (id: number): HTMLElement => {
  const found = within(heading(id))
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-haspopup") === "menu");
  if (found === undefined) throw new Error(`no ⋯ on shelf ${id}`);
  return found;
};
const renameOf = (id: number) => within(heading(id)).getByRole("button", { name: /^Rename/ });
const addFolderOn = (id: number) =>
  within(heading(id)).getByRole("button", { name: /^Add folder/ });
/** The empty folders' dashed boxes on screen, in document order — `EmptyShelf` stamps
 *  `data-shelf-empty` with no value, so a case that needs one box keeps the wall to one empty
 *  folder rather than guessing which box follows which heading. */
const emptyBoxes = () => [...document.querySelectorAll<HTMLElement>("[data-shelf-empty]")];
/** The path row's Add folder — the one that is not on any heading. */
const pathAddFolder = (): HTMLElement => {
  const found = screen
    .getAllByRole("button", { name: /^Add folder/ })
    .find((button) => button.closest("[data-shelf-heading]") === null);
  if (found === undefined) throw new Error("no Add folder on the path row");
  return found;
};
/** The wall, in whichever view is on. */
const wallOf = (): HTMLElement =>
  screen.queryByRole("table", { name: "Your wishlist" }) ??
  screen.getByRole("group", { name: "Your wishlist" });
/** The naming field — the only text box on the wall; the filter box is a `searchbox`. */
const nameField = () => within(wallOf()).findByRole("textbox");
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
/** A header figure's own value — a `<dd>` beside its `<dt>`. */
const figure = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;
/**
 * Which level the last list read was for. The first shelf asked is the level's own headless shelf
 * inside a folder, and Not sorted (`0`) at the root — so `null` is the root.
 */
const levelAsked = (): number | null => {
  const first = lastQuery().shelves?.[0];
  return first === undefined || first === 0 ? null : first;
};

/**
 * A wish carried out of the list and onto one of the two places it can be filed — a folder card,
 * or a segment of the breadcrumb.
 *
 * **Both ends need a box.** jsdom has no layout engine, so every real `getBoundingClientRect` is
 * four zeroes, and dnd-kit hit-tests by **coordinate**: a source with no box is pressed at the
 * origin and a target with no box can never be collided with, both silently. The destination is
 * boxed well clear of the row, so the pointer really travels between two distinct places rather
 * than teleporting — which is what a library watching for a distance threshold has to see.
 *
 * `views.test.tsx`'s `cardOnto`, for its reason.
 */
async function wishOnto(source: HTMLElement, target: HTMLElement): Promise<void> {
  boxed(source, 0);
  boxed(target, 200, 60);
  await pointerDrag(source, target);
}

/**
 * One box and three landings, because dnd-kit hit-tests by **coordinate** and jsdom measures every
 * rectangle as zero.
 *
 * jsdom has no layout engine, so every real `getBoundingClientRect` is four zeroes and
 * `folderEdge` answers `inside` for all of them: an edge-dependent test has to state the box, and
 * a pointer-driven library needs the pointer to be somewhere real as well. `EDGE_ZONE` is a
 * quarter, so a tenth in from either end is unambiguously beside and the middle is unambiguously
 * inside. `CollectionPage.test.tsx`'s arrangement, for its reason.
 */
const SOURCE_BOX = new DOMRect(0, 0, 100, 100);
const CARD_BOX = new DOMRect(400, 400, 100, 100);

/**
 * One box and three landings along the **vertical** axis now: a heading is a row, so before and
 * after are its top and bottom quarters (`EDGE_ZONE`), and the middle half is inside.
 */
const AT_TOP = { y: 0.1 };
const AT_MIDDLE = { y: 0.5 };
const AT_BOTTOM = { y: 0.9 };

/** Give a heading's drop target somewhere to be. */
const stand = (id: number) => {
  heading(id).getBoundingClientRect = () => CARD_BOX;
};

/** Pick a heading up. The drag source is the heading's own row — `ShelfHeading` attaches `dragRef`
 *  where it attaches `dropRef` — boxed here because dnd-kit reads the press off its rectangle. A
 *  heading that is not a source (Not sorted, a deck's list) answers `started: false`. */
async function holdHeading(id: number) {
  const source = heading(id);
  source.getBoundingClientRect = () => SOURCE_BOX;
  return startPointerDrag(source);
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
  // cabinet draws no breadcrumb, no folder heading and nothing above the wall without folders —
  // all that is left of it is the path row's Add folder, which reaches nothing unless a test
  // presses it — so this default is what keeps the rest of this file a test of the list rather
  // than of the tree.
  wishlistFolderList.mockReset().mockResolvedValue([]);
  wishlistFolderSummary.mockReset().mockResolvedValue([]);
  wishlistFolderCreate.mockReset().mockResolvedValue(SOMEDAY);
  wishlistFolderRename.mockReset().mockResolvedValue(ORDERED);
  wishlistFolderMove.mockReset().mockResolvedValue(ORDERED);
  // The whole cabinet, flat, is what `wishlist_folder_reorder` answers — but the hook settles by
  // invalidating the folder list rather than seeding the cache from it, so what it resolves with
  // reaches nothing here and the empty array is the honest fixture.
  wishlistFolderReorder.mockReset().mockResolvedValue([]);
  wishlistFolderDelete.mockReset().mockResolvedValue(undefined);
  // How many wishes went, which is all either command answers.
  wishlistFolderClear.mockReset().mockResolvedValue(1);
  wishlistFolderDeleteWithWishes.mockReset().mockResolvedValue(3);
  wishlistSetFolder.mockReset().mockResolvedValue({ id: 7, quantity: 4, removed: false });
  // A wishlist already on its cheapest printings, which is what every block but the price sweep's
  // is about — so the dialog is drawable everywhere and reaches nothing unless a case presses it.
  wishlistOptimizePlan
    .mockReset()
    .mockResolvedValue({ moves: [], considered: 1, alreadyCheapest: 1, skipped: 0 });
  wishlistOptimizeApply.mockReset().mockResolvedValue({ results: [] });
  // **The counts follow the list mock, whatever a case sets it to.** Read off the list mock's own
  // implementation rather than by calling it, so it records no call — `lastQuery()` and every
  // `toHaveBeenCalledTimes` above stay about the list — and so a case that only sets the list gets
  // headings and header figures that agree with it for free.
  wishlistShelfCounts.mockReset().mockImplementation(async (q: WishlistQuery) => {
    const list = wishlistList.getMockImplementation();
    if (list === undefined) return [];
    const answer = await list({ ...q, limit: 500, offset: 0 });
    // The peek is unfiltered: the same shelves, with the box's text taken off.
    const all = await list({ ...q, text: undefined, limit: 500, offset: 0 });
    return countsFor(answer.items, q.shelves, all.items);
  });
  shelfFolds.mockReset().mockResolvedValue({ collection: {}, wishlist: {} });
  setShelfFolds.mockReset().mockResolvedValue(undefined);
  deckList.mockReset().mockResolvedValue([]);
  searchCards.mockReset().mockResolvedValue({ items: [SEARCH_BOLT], total: 1, totalIsCapped: false });
  // Answered **cold** — `ready: false`, every map empty — so nothing in the panel's filter row
  // greys and every control keeps its name. `DeckSearchPanel.test.tsx`'s fixture.
  facetCards.mockReset().mockResolvedValue({
    colors: {},
    manaValues: {},
    manaX: 0,
    formats: {},
    sets: {},
    owned: { owned: 0, missing: 0 },
    total: 0,
    ready: false,
  });
  listSets.mockReset().mockResolvedValue([]);
  prefetchImages.mockReset().mockResolvedValue(undefined);
  searchOpen.mockReset().mockResolvedValue({});
  setSearchOpen.mockReset().mockResolvedValue(undefined);
  // The table, which is not this view's default — the wall is (`store.ts`). Everything in the
  // first block below is about the list view and says so by asking for it; `the wall` block at
  // the end switches to the grid, and one test there holds the default itself. The same
  // arrangement `CollectionPage.test.tsx` uses from the other end.
  useAppStore.setState({
    wishlistView: "table",
    selectedCardId: null,
    importDefaults: { condition: "NM", finish: null },
    // **The folder hand-off, which this page *consumes*** — so a case that left one written would
    // open the next case inside a drawer nothing asked for. Store state outlives `cleanup()`, and
    // the block near the end writes one in every case.
    pendingFolder: null,
    // **The two other hand-offs this page consumes**, for the folder's reason: a case that left
    // either written would open the next case on the flagged wishes or inside the price sweep.
    pendingReviewFilter: null,
    pendingOptimize: false,
  });
});

describe("WishlistPage", () => {
  /**
   * **The list says nothing about the collection, anywhere** — the shape of this page since
   * 2026-09-08, asserted as an absence because that is the only way it can be asserted.
   *
   * There was an `Owned` column here reading `1 of 4 owned`, the word `Fulfilled` on a covered
   * wish, a `text-dim` dimming of that row and a `Fulfilled` / `Still missing` pair in the filter
   * tray. All four are gone: a wishlist is the reader's own list, kept by hand, and they take a
   * card off it when they acquire one. The four assertions below are one test rather than four
   * because they are one decision, and each names the exact string that would come back.
   */
  it("says nothing about what the collection holds", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.queryByText(/owned/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfilled")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Owned/ })).not.toBeInTheDocument();

    // And the tray offers no way to ask the question either. Opened rather than assumed shut —
    // every one of those cells lives behind the disclosure, so a query over a closed tray would
    // pass whether the chip was there or not.
    await openTray(userEvent);
    expect(screen.queryByRole("button", { name: "Still missing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fulfilled" })).not.toBeInTheDocument();
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
   * part of what makes two wishes two wishes. A row that did not say so would show two
   * identical lines for one card.
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
   * The named way out, still offered on **every** row and not only on an emptied one — crossing
   * something off is what a shopping list is for.
   *
   * **This case asserted the opposite of its last line until issue #284**, and the correction is
   * worth stating rather than quietly making: it used to check that `−` was `disabled` at one
   * copy, on the argument that a wish is where the wishlist diverges from the collection because
   * zero deletes here. Zero deletes in the collection too — since schema v24 — and that stepper
   * has floored at zero the whole time, so the floor of one was this list behaving differently
   * from the one beside it for a reason that had expired. The two controls overlap now, and both
   * stay: this button is the discoverable route and the one press that works from any quantity,
   * and the case below it — "drops a wish the stepper empties to zero" — is the other end of the
   * same write.
   */
  it("removes a wish through its own control, on a row the stepper could also empty", async () => {
    // At one copy, which is where the stepper now steps into the same deletion. The list empties
    // on the re-read for the reason the stepper's does above: `remove` settles the whole
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

    // Reachable rather than greyed, which is the floor change seen from this file: put `min`
    // back to 1 and this line goes red before anything else in the suite does.
    expect(
      screen.getByRole("button", {
        name: "Decrease Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    ).not.toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    );

    expect(wishlistRemove).toHaveBeenCalledWith(7);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
  });

  /**
   * **The bug the floor change created, and the reason `EntryChange.removed` is read rather than
   * ignored.**
   *
   * `set_wish_quantity(id, 0)` returns `remove_wish(conn, id)` — `wishlist_entries.quantity`
   * carries `CHECK (quantity > 0)`, so it always has — and with the stepper at `min={0}` that
   * delete is one press away on a single-copy wish. `CollectionPage.test.tsx`'s "drops a row the
   * stepper empties to zero" is the same case one list over.
   *
   * **What is being pinned is _when_ the row goes, and the held-open re-read is what makes that
   * askable.** `settleWhole` invalidates `["wishlist"]` whole and this list's key is
   * `["wishlist", "list", …]`, so a handler that ignored `removed` would still lose the row on
   * the refetch — which means a mock that answers the second read empties the wall whatever the
   * handler did, and the case would pass over the defect. Hung after the write, what stays on
   * screen is the previous page, so the row leaving rests on the patch alone. That is the honest
   * shape rather than a rigged one: the whole of what this handler buys is the round trip's
   * length, and a wish sitting there wanting none of something with a `+` beside it that answers
   * GONE is precisely what `remove.onSuccess` refuses to let a crossed-off wish do. This test
   * fails on the defect; a test that let the re-read land could not.
   */
  it("drops a wish the stepper empties to zero, because zero deletes it", async () => {
    let deleted = false;
    wishlistList.mockImplementation(async () => {
      if (deleted) await new Promise(() => {});
      return page([{ ...BOLT, quantity: 1 }]);
    });
    wishlistSetQuantity.mockImplementation(async (id: number) => {
      deleted = true;
      return { id, quantity: 0, removed: true };
    });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Decrease Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    );

    expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 0);
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
    // And on the one command: the delete happened inside `wishlist_set_quantity`, so a second
    // write here would be the page removing a row that is already gone.
    expect(wishlistRemove).not.toHaveBeenCalled();
  });

  /**
   * The other half of the floor change: a step to zero the backend **refuses** must put the row
   * back, rather than leaving it at none or taking it off the list.
   *
   * The optimistic patch writes a `0` into the row for the length of the round trip — accepted
   * deliberately, as the collection's twin accepts it — so a refusal here is the one press on
   * this page where the rollback is the difference between a wish and no wish. The re-read is
   * held open for the reason the case above holds it: `settleWhole` runs on the failure path too,
   * and a list answer landing mid-assert would restore the row whether or not `restore(saved)`
   * ran, which is a green test drawn over a missing rollback.
   */
  it("puts a wish back when a step to zero is refused", async () => {
    let refused = false;
    wishlistList.mockImplementation(async () => {
      if (refused) await new Promise(() => {});
      return page([{ ...BOLT, quantity: 1 }]);
    });
    wishlistSetQuantity.mockImplementation(async () => {
      refused = true;
      throw "That wishlist entry is not there any more.";
    });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Decrease Copies wanted of Lightning Bolt (LEA 161, Foil)",
      }),
    );

    expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not there any more/i);
    // The wish is still wanted, and still wanted in the number the wishlist actually holds.
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
      ).toHaveValue(1),
    );
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
   * over what is wanted — all four Bolts at $400.50, plus the Recall — because
   * a total that charged the reader for cards already in the binder is a number nobody can
   * act on. Spec §5: it says how old the prices are, and whose.
   */
  it("adds up what is still to buy, and says how old the prices are", async () => {
    wishlistList.mockResolvedValue(page([BOLT, ANY]));
    wrap(<WishlistPage />);

    // All four Bolts at $400.50, plus the Recall.
    expect(await within(await total()).findByText("$1,614.00")).toBeInTheDocument();
    // `Figure`'s own `title` prop, bound through `useTooltip()` since the tooltip sweep
    // rather than a native attribute.
    const figure = await total();
    await userEvent.hover(figure);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.tcgplayer));
    await userEvent.unhover(figure);
    // One figure, not the pair this header drew before the marketplace setting existed: two
    // totals over one shopping list is two answers to the question it is open to ask.
    expect(screen.queryByText("Total cost (EUR)")).not.toBeInTheDocument();
  });

  /**
   * **A wish the reader happens to own is charged for like any other**, which reverses what this
   * test asserted until 2026-09-08 — a covered wish used to cost nothing to finish and added
   * nothing to the total. The list does not know what is in the binder any more, and the reader
   * takes a card off it when they acquire one, so every row on it is a row they still mean to
   * buy.
   */
  it("charges for every wish on the list", async () => {
    wishlistList.mockResolvedValue(page([{ ...BOLT, quantity: 1 }, ANY]));
    wrap(<WishlistPage />);

    // One Bolt at $400.50 and the Recall at $12 — a fixture that would read $12.00 on its own
    // under the old subtraction, so the assertion can tell the two arithmetics apart.
    expect(await within(await total()).findByText("$412.50")).toBeInTheDocument();
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
  it("prices the list in euros, and counts what it could not price", async () => {
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

    // All four Bolts at €320, and nothing at all for the etched wish.
    const eur = await total("EUR");
    expect(await within(eur).findByText("€1,280.00")).toBeInTheDocument();
    expect(within(eur).getByText("1 unpriced")).toBeInTheDocument();
    await userEvent.hover(eur);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(panel).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
    await userEvent.unhover(eur);
    expect(screen.queryByText("Total cost (USD)")).not.toBeInTheDocument();
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
    // Four copies at €320 each. Scoped to the row: with one wish on the list the header's total
    // is the same number, and an unscoped query cannot tell a sum from a term — the same reason
    // `total()` above is scoped.
    await waitFor(() => expect(within(row).getByText("€1,280.00")).toBeInTheDocument());
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

    // Any filter will do; this used to press `Still missing`, which was the wishlist's own and
    // went with the rest of its comparisons against the collection.
    await openTray(userEvent);
    await userEvent.click(screen.getByRole("button", { name: "Needs review" }));

    expect(await screen.findByText(/no wishes match these filters/i)).toBeVisible();
  });

  /**
   * **The status line never moves the wall** (the live re-check's new 2). It used to be empty, and
   * so no taller than nothing, until a write's re-read put `Updating…` in it for 40–80 ms — 16px
   * that pushed the wall down for exactly the frames the grid's reveal and the drop anchor measured
   * it in. jsdom lays nothing out, so what is pinned is what produces the geometry: since the
   * header redesign (2026-09-27) the line rides the path row beside the shelf toolbar rather than
   * holding a row of its own, `truncate` keeps it to one line, and its classes do not change when
   * it starts talking.
   */
  it("holds the status line's one line open, so `Updating…` never moves the wall", async () => {
    const { client } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    const line = document.querySelector<HTMLElement>('p[role="status"]')!;
    await waitFor(() => expect(line.textContent).toBe(""));
    const silent = line.className;

    // A re-read that is still on its way — the post-write moment.
    wishlistList.mockImplementation(() => new Promise<never>(() => {}));
    act(() => {
      void client.invalidateQueries({ queryKey: ["wishlist", "list"] });
    });

    await waitFor(() => expect(line).toHaveTextContent("Updating…"));
    expect(line.className).toBe(silent);
    expect(line).toHaveClass("truncate", "text-xs");
    expect(line.parentElement).toContainElement(screen.getByRole("group", { name: "Shelves" }));
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
   * A wishlist write still reaches the **search** results, which carry a `wishlisted` flag per
   * card — so a wish added or removed here makes cached search rows wrong.
   *
   * It used to reach further. A wish's own `ownedQuantity` was computed from `collection_entries`
   * and a collection write fired this list; both directions went on 2026-09-08 with every other
   * comparison the wishlist made against the binder.
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
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await user.type(screen.getByLabelText(/search your wishlist/i), "bolt");
    await pickOption(user, "Sort results", "Highest price");

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
   * The trigger and the headers are one state seen from two ends — and the Printing column
   * is the one header in this app that is not a control at all: an any-printing wish names
   * no set, so there is nothing to sort by.
   */
  it("drives one sort from the headers and the trigger together, and leaves Printing alone", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(screen.getByRole("columnheader", { name: /^Printing/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Printing/ })).not.toBeInTheDocument();

    // **It opens on the order it is actually in, and `Custom…` is not there to open on** —
    // `CollectionPage.test.tsx`'s twin, and the trap is the same one wearing new clothes: a
    // controlled `<select>` whose value matched no option silently reported the first row, and a
    // `Dropdown` draws its placeholder dash. Either way the honest order and the fallback look
    // alike on screen, so the trigger's own text is what separates them — read as text, because
    // a `<button>` has no value and the trigger says the picked row's **label**, not its key.
    expect(sortTrigger()).toHaveTextContent("Name");
    // Closed, so there are no rows at all — the panel exists only while open.
    expect(screen.queryByRole("option", { name: "Custom…" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Wanted" }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "quantity", dir: "desc" }]));
    expect(sortTrigger()).toHaveTextContent("Most wanted");

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await user.keyboard("{/Shift}");
    await waitFor(() =>
      expect(lastQuery().sort).toEqual([
        { key: "quantity", dir: "desc" },
        { key: "cost", dir: "desc" },
      ]),
    );

    // Cost alone is an order the trigger has no option for — it offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "cost", dir: "desc" }]));
    expect(sortTrigger()).toHaveTextContent("Custom…");
    await openDropdown(user, "Sort results");
    expect(screen.getByRole("option", { name: "Custom…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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

    // Opens the panel to read its rows, then closes it again — the options only mount while
    // the dropdown is open, unlike a native `<select>`'s `<option>`s.
    const options = async () => {
      await openDropdown(user, "Sort results");
      const labels = within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent);
      await user.keyboard("{Escape}");
      return labels;
    };
    const orders = ["Highest price", "Most wanted", "Name", "Recently added"];
    expect(await options()).toEqual(orders);

    // A header this dropdown has no option for is the only way to reach "Custom…": Cost sorts
    // by what finishing the wish costs, where the dropdown offers the *unit* price.
    await user.click(screen.getByRole("button", { name: /^Cost/ }));

    await waitFor(() => expect(sortTrigger()).toHaveTextContent("Custom…"));
    expect(await options()).toEqual(["Custom…", ...orders]);
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

    const rows = cardSources(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");
    expect(rows[1]).toHaveTextContent("Ancestral Recall");

    // The payload never travels in a `DataTransfer` — it lives in the library's own store, keyed
    // off the source's `data` — so a monitor is the only way to read it, and every drag started
    // here has to be ended or the manager's one operation strands the next one.
    const drags = recordDrags();
    // A box each and well clear of each other: dnd-kit reads the press coordinate off the source's
    // own rect, and jsdom measures every rect as four zeroes, so an unboxed row is pressed at the
    // origin — which is wherever the last thing given a rect happens to be.
    const pinned = await startPointerDrag(boxed(rows[0], 0), {
      pressOn: screen.getByText("Lightning Bolt"),
    });
    // **Asked while the drag is still up.** `started` is a live reading over the manager's one
    // operation rather than a remembered flag, so after a cancel it is false for every drag there
    // has ever been.
    expect(pinned.started).toBe(true);
    await pinned.cancel();
    const loose = await startPointerDrag(boxed(rows[1], 200), {
      pressOn: screen.getByText("Ancestral Recall"),
    });
    expect(loose.started).toBe(true);
    await loose.cancel();
    drags.stop();

    expect(drags.records.map(readDragData)).toEqual([
      { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" },
      null,
    ]);
    // And both are wishes, which is what a folder card reads.
    expect(drags.records.map(readWishDrag)).toEqual([
      { wishId: 7, name: "Lightning Bolt", folderId: null },
      { wishId: 8, name: "Ancestral Recall", folderId: null },
    ]);
  });

  /**
   * **A press on the row's removal is a press on the removal.**
   *
   * The row is the drag handle and a press inside it belongs to the row, so without the mark a
   * press on the bin that travelled five pixels would drag the wish and never deliver the click.
   * The guard is the library's now and it is the same rule: `lib/dndManager.ts` configures
   * `PointerSensor.preventActivation` with the app's own `NOT_A_DRAG` selector, once, for every
   * draggable in the window — and it is asked about **where the press landed**, which is why this
   * presses one place and drags from another.
   */
  it("does not drag a wish when the press landed on its removal", async () => {
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    // The row is pressed at the centre of its own box, so it needs one — see {@link wishOnto}.
    const row = boxed(cardSources(container)[0], 0);

    const held = await startPointerDrag(row, {
      pressOn: screen.getByRole("button", {
        name: /^Remove Lightning Bolt \(LEA 161, Foil\) from your wishlist/,
      }),
    });
    // **Before the cancel, both times.** `started` reads the manager's live operation rather than
    // remembering one, so asked afterwards it is `false` whether or not a drag ever began — and
    // the second half of this test would then pass on a source that cannot be picked up at all.
    expect(held.started).toBe(false);
    await held.cancel();

    // And the row itself still is one: the guard is a control's press, not a row's.
    const again = await startPointerDrag(row, { pressOn: screen.getByText("Lightning Bolt") });
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
        // The constant rather than the grade: a one-press add makes no decision about a copy's
        // condition, and this suite must go red the day it starts making one again.
        condition: MENU_CONDITION,
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

  it("draws one tile per wish, with the copies wanted over the art", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
    // How many copies, in the glyphs a corner mark has room for — and the sentence beside it,
    // which is what a screen reader and a tooltip get. It drew `1/4` and `1 of 4 owned` until
    // 2026-09-08; the fraction went with everything else on this page that read the collection.
    expect(screen.getByText("×4")).toBeInTheDocument();
    expect(screen.getByText("4 copies wanted")).toBeInTheDocument();
    expect(screen.queryByText("1/4")).not.toBeInTheDocument();
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
    // And a pinned wish's caption is its printing. The finish is still said — it is the other
    // half of what makes two wishes for one card two wishes — but on the *wall* it is said by
    // the chin's glyph, whose accessible name is the word, rather than by the word as well:
    // `WishlistGrid.test.tsx`'s `the printing line` is where that split is pinned on both views.
    expect(screen.getByText("LEA · 161")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Foil" })).toBeInTheDocument();
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

  /** What the whole wish costs, in the tile's bottom-right corner — `unit × copies wanted`,
   *  which is the header's own arithmetic. */
  it("marks a tile with what the whole wish costs", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    // All four at $400.50 each — where this read $1,201.50 until 2026-09-08, three copies at that
    // price, the fourth being one the binder held. Scoped to the tile: a one-wish list prints the
    // same amount in the header, and an unscoped query cannot tell the sum from the term it was
    // summed from.
    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("$1,602.00")).toBeInTheDocument();
  });

  /**
   * **A tile carries two prices, and they answer different questions** — which is a reversal of
   * what this test asserted until 2026-09-08.
   *
   * It used to say that a wish the collection covered drew *one* price, the chin's, because the
   * corner collapsed rather than quoting $0.00. There is no covered wish now, so the corner is
   * always drawn: the chin quotes what **one copy** of this printing costs, a fact about the
   * cardboard, and the corner quotes what the whole wish costs. A single-copy wish is the case
   * where the two are the same number and the tile prints it twice — the honest reading of two
   * true statements, and the reason this fixture uses one rather than four.
   */
  it("quotes one copy in the chin and the whole wish in the corner", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistList.mockResolvedValue(page([{ ...BOLT, quantity: 2 }]));
    wrap(<WishlistPage />);

    const tile = (await screen.findByAltText("Lightning Bolt")).closest(
      "[data-grid-index]",
    ) as HTMLElement;
    expect(within(tile).getByText("×2")).toBeInTheDocument();
    const prices = within(tile).getAllByText(/^\$/);
    expect(prices).toHaveLength(2);
    // `CardChin` is the only element in a tile with a vertical border, which is how the unit
    // price is placed without counting `parentElement` hops through two components.
    const chin = prices.find((p) => p.closest("span.border-x") !== null);
    const corner = prices.find((p) => p.closest("span.border-x") === null);
    expect(chin).toHaveTextContent("$400.50");
    expect(corner).toHaveTextContent("$801.00");
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
    // **Scoped to the panel, because the tile draws a stepper of its own now** (issue #284) and
    // the two carry the same accessible name — one wish, one label, wherever the number is
    // edited. An unscoped query matched one control while the wall had none and matches two now,
    // which reads as the panel being broken rather than as the wall having grown a control.
    const panel = screen.getByRole("dialog", { name: "Edit Lightning Bolt" });
    await user.click(
      within(panel).getByRole("button", { name: /^Increase Copies wanted of Lightning/i }),
    );

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

  /**
   * **Spec §5: a price is never shown without saying how old it is.** Every tile's chin quotes
   * what one copy of that printing costs as of 2026-08-26, and this wall had no sentence anywhere
   * — which is what driving the shipped window found.
   *
   * **The corner's tooltip is not this line and never was.** `WishlistGrid` binds `pricesAsOf`
   * onto the cost *still to buy*, which is `unit × copies missing`; it is drawn on no wish the
   * reader has finished, and it says nothing about the chin's figure, which is on every tile. It
   * stays where it is — it dates a number the line below does not describe — and it is invisible
   * to the count here anyway, being a `useTooltip()` binding rather than text.
   *
   * Once, under the wall — not on forty tooltips, which is one statement made forty times.
   *
   * **Through `pricesAsOf` rather than the sentence typed out here**: spelling it would pin a copy
   * of the wording rather than the function, so a reworded sentence would go red in a place with
   * nothing to say about it while a wall drawing a *stale* sentence stayed green.
   *
   * The table is asserted to draw none of it, which is what proves this is the grid's line rather
   * than something the page draws in both views over a column header that already says it.
   */
  it("says how old the wall's prices are, once, under the grid", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const user = userEvent.setup();
    wrap(<WishlistPage />);

    await screen.findByAltText("Lightning Bolt");
    expect(screen.getAllByText(pricesAsOf(MARKETPLACES.tcgplayer))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Table view" }));

    // The table says it in the Cost column's header instead — as a tooltip and an accessible
    // name, not as text — so the grid's line goes with the grid.
    expect(screen.queryByText(pricesAsOf(MARKETPLACES.tcgplayer))).toBeNull();
  });
});

/**
 * **Which box scrolls the wishlist** — the page, or a box inside it.
 *
 * The wall took `CardGrid`'s `grow` on 2026-09-08 (through `WishlistGrid`, its one caller), so in
 * grid view it is as tall as its rows and `AppShell`'s `main` is what scrolls them; the table did
 * not, because `VirtualTable` mounts the rows in view and holds a spacer open for the rest, and a
 * virtualiser given no height renders every row. That split is three classes on three elements,
 * and this block is what keeps the three agreeing with each other. `CollectionPage.test.tsx`
 * carries the twin of this block, for the twin of this arrangement.
 *
 * **jsdom has no layout engine, so nothing here can measure a scroll.** What it can see is the
 * classes, which is exactly where this defect would live: a `min-h-0 flex-1` left on the desk row
 * caps a growing wall at one screen and clips the rest, and an `h-full` taken off the section
 * collapses the table to nothing. Both are silent — every other case in this file passes either
 * way, because a row still renders in a box of zero height.
 */
describe("which box scrolls the wishlist", () => {
  /** The desk row: the flex row the list column and the docked search column share. */
  const deskOf = (list: HTMLElement) => list.closest(".gap-4");
  /** The page's own root, which is the top of the table's height chain. */
  const sectionOf = (list: HTMLElement) => list.closest("section");

  it("gives the grid view no scrollport of its own, and no height to be clipped by", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);

    const wall = await screen.findByRole("group", { name: "Your wishlist" });
    // `grow`'s own half: the wall keeps its padding and drops the scrollport and the frame it used
    // to draw around one. `classList.contains` rather than `toHaveClass`, because these are the
    // classes that must be **absent**.
    expect(wall.classList.contains("overflow-auto")).toBe(false);
    expect(wall.classList.contains("border")).toBe(false);
    expect(wall).toHaveClass("shrink-0");

    // And the two boxes above it: neither may hand the wall a height, or a wall as tall as its
    // rows is drawn inside one screen and the rest of the wishlist is unreachable.
    expect(deskOf(wall)).not.toHaveClass("min-h-0");
    expect(deskOf(wall)).not.toHaveClass("flex-1");
    expect(sectionOf(wall)).not.toHaveClass("h-full");
  });

  it("keeps the table's height chain whole, from the section down to the scrollport", async () => {
    useAppStore.setState({ wishlistView: "table" });
    wrap(<WishlistPage />);

    const table = await screen.findByRole("table", { name: "Your wishlist" });
    // Read bottom-up, because that is the order the chain fails in: the scrollport is the
    // `VirtualTable`'s, it has a height only while the desk row has one, and the desk row has one
    // only while the section is pinned to `main`.
    //
    // **The scrollport is the table's parent on shelves**: the table always draws the sticky bar
    // now, and while it is live `VirtualTable` scrolls a plain box holding the bar's anchor and the
    // `role="table"` element side by side — the bar may not live inside a table.
    const scrollport = table.parentElement as HTMLElement;
    expect(scrollport.querySelector(":scope > [data-sticky-band]")).not.toBeNull();
    expect(scrollport).toHaveClass("overflow-auto");
    expect(deskOf(table)).toHaveClass("min-h-0", "flex-1");
    expect(sectionOf(table)).toHaveClass("h-full");
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
 * **Shelves** (spec §3): every card at and below the level, one shelf per folder, nested, in tree
 * order — the page a reader who files everything lands on instead of an empty one.
 */
describe("the shelves", () => {
  beforeEach(() => {
    wishlistList.mockReset().mockImplementation(listByShelves([BOLT, ANY, FILED]));
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
  });

  /**
   * **The headline bug** (spec §1): with everything filed the old root asked for the wishes filed
   * nowhere, drew a folder band and nothing else, and the header read **Wishes 0** over a list of
   * twenty-five. Every wish is on the wall now, under its folder's heading, and counted.
   */
  it("shows every wish when everything is filed, and counts all of them", async () => {
    const filed = Array.from(
      { length: 25 },
      (_, i): WishRow => ({
        ...BOLT,
        id: 100 + i,
        name: `Filed ${i + 1}`,
        cardId: `f${i}`,
        artCardId: `f${i}`,
        folderId: i < 3 ? ORDERED.id : i < 5 ? BACKORDERED.id : SOMEDAY.id,
        quantity: 1,
        unitPrice: 2,
      }),
    );
    wishlistList.mockImplementation(listByShelves(filed));
    wrap(<WishlistPage />);

    await waitFor(() => expect(figure("Wishes")).toHaveTextContent("25"));
    expect(within(await total()).getByText("$50.00")).toBeInTheDocument();
    expect(await screen.findByText("Filed 1")).toBeInTheDocument();
    expect(screen.getByText("Filed 4")).toBeInTheDocument();
    expect(follows(heading(ORDERED.id), screen.getByText("Filed 1"))).toBe(true);
    expect(follows(heading(BACKORDERED.id), screen.getByText("Filed 4"))).toBe(true);
    // Nothing is loose, so there is no Not sorted shelf — and no empty-page sentence either.
    expect(queryHeading(0)).toBeNull();
    expect(screen.queryByText(/Nothing on your wishlist yet/)).toBeNull();
    expect(lastQuery().shelves).toEqual([0, ORDERED.id, BACKORDERED.id, SOMEDAY.id]);
  });

  /** Spec §3.6: `Total cost` stops being a sum over the rows that happen to be loaded, and the
   *  "N of M counted" note that owned up to that has nothing left to own up to. */
  it("prices the header from the counts, not from the page of rows that happens to be loaded", async () => {
    wishlistList.mockReset().mockResolvedValue(page([BOLT], 2));
    wishlistShelfCounts.mockResolvedValue([
      { folderId: 0, tiles: 2, copies: 5, value: 1614, unpriced: 1, peek: [] },
    ]);
    wishlistFolderList.mockResolvedValue([]);
    wrap(<WishlistPage />);

    await screen.findByText("Lightning Bolt");
    await waitFor(() => expect(figure("Wishes")).toHaveTextContent("2"));
    const cost = await total();
    expect(within(cost).getByText("$1,614.00")).toBeInTheDocument();
    expect(within(cost).getByText("1 unpriced")).toBeInTheDocument();
    expect(screen.queryByText(/counted/)).toBeNull();
  });

  /** Decision 3: cards in no folder come first, under Not sorted — which is not a folder, so its
   *  title is plain text and it has no buttons but its chevron (spec §3.2). */
  it("draws Not sorted first, as a heading with nothing on it but its chevron", async () => {
    wrap(<WishlistPage />);
    const loose = await findHeading(0);

    expect(follows(loose, heading(ORDERED.id))).toBe(true);
    expect(chevronOf(0, "Not sorted")).toHaveAttribute("aria-expanded", "true");
    expect(within(loose).queryByRole("button", { name: "Not sorted" })).toBeNull();
    expect(within(loose).queryByRole("button", { name: /^Add folder/ })).toBeNull();
    expect(within(loose).queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(
      within(loose)
        .queryAllByRole("button")
        .some((b) => b.getAttribute("aria-haspopup") === "menu"),
    ).toBe(false);
  });

  it("draws no Not sorted shelf when nothing is loose", async () => {
    wishlistList.mockImplementation(listByShelves([FILED]));
    wrap(<WishlistPage />);

    await screen.findByText("Rhystic Study");
    expect(queryHeading(0)).toBeNull();
  });

  /**
   * **Review Focus 2**: a folder whose cards are all in its sub-folders is a container — its
   * heading and its rail over theirs, its figures their sum, and no dashed "Empty" box under it
   * contradicting the cards two headings down.
   */
  it("draws a folder whose cards are all in its sub-folders as a container, with no empty box", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    const MANA: WishlistFolder = {
      id: 10,
      parentId: null,
      name: "Mana base",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };
    const FETCH: WishlistFolder = {
      id: 11,
      parentId: 10,
      name: "Fetchlands",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };
    const SHOCK: WishlistFolder = {
      id: 12,
      parentId: 10,
      name: "Shocks",
      sortOrder: 1,
      managedDeckId: null,
      managedTokens: false,
    };
    const land = (id: number, name: string, folderId: number): WishRow => ({
      ...BOLT,
      id,
      name,
      cardId: `l${id}`,
      artCardId: `l${id}`,
      folderId,
      quantity: 1,
      unitPrice: 20,
    });
    wishlistFolderList.mockResolvedValue([MANA, FETCH, SHOCK]);
    wishlistFolderSummary.mockResolvedValue([
      { folderId: 11, wishes: 2, copies: 2, cost: 40, unpriced: 0 },
      { folderId: 12, wishes: 1, copies: 1, cost: 15, unpriced: 0 },
    ]);
    wishlistList.mockImplementation(
      listByShelves([
        land(201, "Scalding Tarn", 11),
        land(202, "Misty Rainforest", 11),
        land(203, "Steam Vents", 12),
      ]),
    );
    wrap(<WishlistPage />);

    await screen.findByAltText("Scalding Tarn");
    await waitFor(() => expect(heading(MANA.id)).toHaveTextContent("3 wishes · $55.00"));
    // No dashed box anywhere on this wall: Mana base holds folders, and both of those hold cards.
    expect(emptyBoxes()).toEqual([]);
    expect(follows(heading(MANA.id), heading(FETCH.id))).toBe(true);
    expect(follows(heading(FETCH.id), screen.getByAltText("Scalding Tarn"))).toBe(true);
    expect(heading(SHOCK.id)).toBeInTheDocument();
  });

  /**
   * **Review Focus 3**: a shut parent takes its whole subtree with it — the nested heading and every
   * card under either — none of it is asked for, and Expand all brings all of it back, the nested
   * shelf included.
   */
  it("hides a collapsed folder's whole subtree, asks for none of it, and brings it back with Expand all", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Rhystic Study");
    await findHeading(BACKORDERED.id);

    await user.click(chevronOf(ORDERED.id, "Ordered"));

    expect(setShelfFolds).toHaveBeenCalledWith("wishlist", { [ORDERED.id]: true });
    await waitFor(() => expect(screen.queryByText("Rhystic Study")).toBeNull());
    expect(queryHeading(BACKORDERED.id)).toBeNull();
    expect(chevronOf(ORDERED.id, "Ordered")).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, SOMEDAY.id]));
    // Still counted: the shut heading and the header both read the counts, which cover it.
    expect(figure("Wishes")).toHaveTextContent("3");

    await user.click(screen.getByRole("button", { name: "Expand all" }));

    expect(setShelfFolds).toHaveBeenLastCalledWith("wishlist", {
      "0": null,
      [ORDERED.id]: null,
      [BACKORDERED.id]: null,
      [SOMEDAY.id]: null,
    });
    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(await findHeading(BACKORDERED.id)).toBeInTheDocument();
  });

  it("shuts every shelf below the level with Collapse all", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await user.click(screen.getByRole("button", { name: "Collapse all" }));

    expect(setShelfFolds).toHaveBeenLastCalledWith("wishlist", {
      "0": true,
      [ORDERED.id]: true,
      [BACKORDERED.id]: true,
      [SOMEDAY.id]: true,
    });
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).toBeNull());
    expect(chevronOf(0, "Not sorted")).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **Review Focus 4**: a search whose only match is two drawers down inside a shut parent opens
   * the path to it — the parent drawn as a container reading `1 of 3` — hides every shelf with no
   * match, and emptying the box puts the stored collapse back **without writing anything**.
   */
  it("opens a collapsed parent for a search whose only match is inside it, and shuts it again when the box empties", async () => {
    const DEEP: WishRow = {
      ...FILED,
      id: 13,
      folderId: BACKORDERED.id,
      name: "Mystic Remora",
      cardId: "c-remora",
      artCardId: "c-remora",
    };
    wishlistList.mockImplementation(listByShelves([BOLT, ANY, DEEP]));
    const user = userEvent.setup();
    wrap(<WishlistPage />, { folds: { [ORDERED.id]: true } });
    await screen.findByText("Lightning Bolt");
    expect(screen.queryByText("Mystic Remora")).toBeNull();

    await user.type(screen.getByLabelText("Search your wishlist"), "remora");

    expect(await screen.findByText("Mystic Remora")).toBeInTheDocument();
    expect(chevronOf(ORDERED.id, "Ordered")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("1 of 3 wishes"));
    expect(heading(BACKORDERED.id)).toHaveTextContent("1 of 2 wishes");
    expect(queryHeading(0)).toBeNull();
    expect(queryHeading(SOMEDAY.id)).toBeNull();

    await user.clear(screen.getByLabelText("Search your wishlist"));

    await waitFor(() => expect(screen.queryByText("Mystic Remora")).toBeNull());
    expect(chevronOf(ORDERED.id, "Ordered")).toHaveAttribute("aria-expanded", "false");
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /**
   * **Folding is paused while a filter is on** (spec §3.4; the final review's C-I2 / W-M14) —
   * collapse is suspended, so a press would store a fold the reader cannot see take effect, and the
   * wall would re-fold on its own when the box empties. One rule for all three controls: the
   * chevron already wrote nothing, and Expand all and Collapse all still wrote.
   */
  it("writes no fold from a chevron, Expand all or Collapse all while a filter is on", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await user.type(screen.getByLabelText("Search your wishlist"), "bolt");
    await waitFor(() => expect(lastQuery().text).toBe("bolt"));
    await user.click(chevronOf(0, "Not sorted"));
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    await user.click(screen.getByRole("button", { name: "Collapse all" }));

    expect(setShelfFolds).not.toHaveBeenCalled();
    expect(chevronOf(0, "Not sorted")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * **And each of the three says why, in the open** — `aria-disabled` (never `disabled`, which
   * would take it out of the tab order) with `FOLD_PAUSED_REASON` as its description, and a press
   * or an Enter that writes nothing. Only while the filter is on: before it and after the box
   * empties, the control is an ordinary one. One case per control, because the page wires the
   * chevron and the path row's pair through two different components.
   */
  it.each([
    ["the chevron", () => chevronOf(0, "Not sorted")],
    ["Expand all", () => screen.getByRole("button", { name: "Expand all" })],
    ["Collapse all", () => screen.getByRole("button", { name: "Collapse all" })],
  ] as const)(
    "refuses %s in the open while a filter is on, and writes no fold",
    async (_name, control) => {
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await screen.findByText("Lightning Bolt");
      expect(control()).not.toHaveAttribute("aria-disabled");
      const box = screen.getByLabelText("Search your wishlist");

      await user.type(box, "bolt");
      await waitFor(() => expect(control()).toHaveAttribute("aria-disabled", "true"));
      expect(control()).toHaveAttribute("aria-description", FOLD_PAUSED_REASON);
      expect(control()).not.toBeDisabled();
      await user.click(control());
      control().focus();
      await user.keyboard("{Enter}");
      expect(setShelfFolds).not.toHaveBeenCalled();

      await user.clear(box);
      await waitFor(() => expect(control()).not.toHaveAttribute("aria-disabled"));
      expect(control()).not.toHaveAttribute("aria-description");
    },
  );

  /** The heading's own Add folder makes a folder *inside* that folder, drawn last among its
   *  children — after `Backordered`, before the next root folder. */
  it("adds a folder inside the heading it is pressed on, drawn last among that folder's own", async () => {
    wrap(<WishlistPage />);
    await findHeading(SOMEDAY.id);

    await userEvent.click(addFolderOn(ORDERED.id));

    const field = await nameField();
    expect(heading(NEW_FOLDER_SHELF)).toContainElement(field);
    expect(follows(heading(BACKORDERED.id), heading(NEW_FOLDER_SHELF))).toBe(true);
    expect(follows(heading(NEW_FOLDER_SHELF), heading(SOMEDAY.id))).toBe(true);
    await userEvent.keyboard("Paid for{Enter}");
    expect(wishlistFolderCreate).toHaveBeenCalledWith(ORDERED.id, "Paid for");
  });

  /** WCAG 2.5.7: the non-drag way to reorder, through the same `placeFolder` a before/after drop
   *  writes through — greyed, with its reason, where there is nowhere to go. */
  it("moves a folder up and down its own level from the heading's ⋯", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(SOMEDAY.id);

    await user.click(menuOf(ORDERED.id));
    let menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Move up/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));
    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenNthCalledWith(1, null, [SOMEDAY.id, ORDERED.id]),
    );

    await user.click(menuOf(SOMEDAY.id));
    menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Move down/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenNthCalledWith(2, null, [SOMEDAY.id, ORDERED.id]),
    );

    // An only child has neither.
    await user.click(menuOf(BACKORDERED.id));
    menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Move up/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: /^Move down/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * **Where the caret goes after a heading's own write** (live pass §8): back to the control on that
   * heading that was pressed — the `⋯` after Move up / Move down, Add folder after a folder made
   * inside it — and the heading brought into view first. In the shipped window the caret fell to
   * `<body>` on the collection because the heading had been virtualised away (the move carried it
   * past a neighbour's subtree; the new folder's field scrolled the wall down to it); the wishlist
   * passed only because its headings happened to stay mounted.
   *
   * **jsdom's window never scrolls, so the loss is emulated, not produced**: the caret is taken off
   * the opener the way an unmounted heading drops it — a blur after the move, and a press that never
   * gave the Add folder button the caret — and what is asserted is that the heading takes it back
   * once it is where it is going. Without the page's note either case ends on `<body>`. Both views,
   * because the heading is the same component in a band as on the wall.
   */
  describe("the caret after a heading's own write", () => {
    it.each(["table", "grid"] as const)(
      "comes back to a moved heading's ⋯ once its new order is on screen, in the %s",
      async (view) => {
        useAppStore.setState({ wishlistView: view });
        const user = userEvent.setup();
        let reread: ((folders: WishlistFolder[]) => void) | null = null;
        let rereading = false;
        wishlistFolderList.mockImplementation(async () =>
          rereading ? new Promise<WishlistFolder[]>((resolve) => (reread = resolve)) : FOLDERS,
        );
        wrap(<WishlistPage />);
        await findHeading(ORDERED.id);

        await user.click(menuOf(ORDERED.id));
        const menu = await screen.findByRole("menu");
        rereading = true;
        await user.click(within(menu).getByRole("menuitem", { name: "Move down" }));
        await waitFor(() => expect(wishlistFolderReorder).toHaveBeenCalled());
        await waitFor(() => expect(reread).not.toBeNull());

        // The heading has not moved yet, and the caret has gone the way an unmounted one goes.
        (document.activeElement as HTMLElement | null)?.blur();
        expect(document.activeElement).toBe(document.body);

        await act(async () =>
          reread!([
            { ...SOMEDAY, sortOrder: 0 },
            { ...ORDERED, sortOrder: 1 },
            BACKORDERED,
          ]),
        );

        await waitFor(() => expect(document.activeElement).toBe(menuOf(ORDERED.id)));
        expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true);
      },
    );

    it.each(["table", "grid"] as const)(
      "comes back to a heading's Add folder after the folder made inside it, in the %s",
      async (view) => {
        useAppStore.setState({ wishlistView: view });
        // A wall of headings alone, so the new folder's field is inside jsdom's window in the grid
        // too — that window never scrolls to it, where the shipped wall does.
        wishlistList.mockImplementation(listByShelves([]));
        wrap(<WishlistPage />);
        await findHeading(ORDERED.id);

        // A press that leaves the caret where it was (`<body>`) — the opener the page remembers is
        // then nothing it can hand the caret back to, as an unmounted heading's would be.
        fireEvent.click(addFolderOn(ORDERED.id));
        const field = await nameField();
        await userEvent.type(field, "Paid for{Enter}");

        await waitFor(() => expect(wishlistFolderCreate).toHaveBeenCalledWith(ORDERED.id, "Paid for"));
        await waitFor(() => expect(document.activeElement).toBe(addFolderOn(ORDERED.id)));
      },
    );

    /**
     * **The table brings the heading into view itself, through `VirtualTable`'s `revealIndex`**,
     * for both writes: the moved heading at its new row, and the new folder's draft band — which is
     * where the naming field is, so a draft below the fold would take the caret out of sight. What
     * jsdom can see is the table's own scroll call (the virtualiser's `scrollToIndex` lands on the
     * scroller's `scrollTo`); its window never moves, so the row itself is the live pass's.
     *
     * Twenty wishes put the row far below the table's 600px window, so it is out of view and the
     * table has to scroll. The scroller is given a height and a spy of its own after the first
     * paint — `VirtualTable.test.tsx`'s `scrollable`, for its reason: the virtualiser clamps every
     * target to `scrollHeight − clientHeight`, which jsdom reports as 0 — so what is counted is the
     * write's reveal and not the mount's reset.
     */
    const twenty = (folderId: number) =>
      Array.from(
        { length: 20 },
        (_, i): WishRow => ({
          ...BOLT,
          id: 300 + i,
          name: `Wish ${i + 1}`,
          cardId: `w${i}`,
          artCardId: `w${i}`,
          folderId,
        }),
      );
    /** The banded table's scroller — the box around `role="table"` — made scrollable, spied. */
    const scrollable = (): Mock => {
      const scroller = screen.getByRole("table", { name: "Your wishlist" }).parentElement!;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 20_000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
      const spy = vi.fn();
      Object.defineProperty(scroller, "scrollTo", { configurable: true, value: spy });
      return spy;
    };
    const scrolledDown = (spy: Mock) =>
      spy.mock.calls.some(
        ([arg]) => typeof arg === "object" && arg !== null && ((arg as ScrollToOptions).top ?? 0) > 0,
      );

    it("scrolls a moved heading's band into view in the table", async () => {
      useAppStore.setState({ wishlistView: "table" });
      wishlistList.mockImplementation(listByShelves(twenty(SOMEDAY.id)));
      let moved = false;
      wishlistFolderList.mockImplementation(async () =>
        moved ? [{ ...SOMEDAY, sortOrder: 0 }, { ...ORDERED, sortOrder: 1 }, BACKORDERED] : FOLDERS,
      );
      wishlistFolderReorder.mockImplementation(async () => {
        moved = true;
        return [];
      });
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      const spy = scrollable();

      await user.click(menuOf(ORDERED.id));
      await user.click(
        within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move down" }),
      );

      await waitFor(() => expect(scrolledDown(spy)).toBe(true));
    });

    it("scrolls the new folder's draft band into view in the table", async () => {
      useAppStore.setState({ wishlistView: "table" });
      wishlistList.mockImplementation(listByShelves(twenty(BACKORDERED.id)));
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      const spy = scrollable();

      // The draft is Ordered's last child, after Backordered's twenty wishes.
      await userEvent.click(addFolderOn(ORDERED.id));

      await waitFor(() => expect(scrolledDown(spy)).toBe(true));
    });

    /** The order a Move down on `Ordered` plans at the root: `Someday` first, `Ordered` after it. */
    const PLANNED: WishlistFolder[] = [
      { ...SOMEDAY, sortOrder: 0 },
      { ...ORDERED, sortOrder: 1 },
      BACKORDERED,
    ];
    /**
     * A folder list that answers at once until `hold()`, and then keeps its next re-read waiting
     * for `answer` — the one moment a move's request exists and is not yet decided. What it answers
     * with stays the answer for every read after it.
     */
    function slowRereads() {
      let current = FOLDERS;
      let holding = false;
      let pending: ((folders: WishlistFolder[]) => void) | null = null;
      wishlistFolderList.mockImplementation(async () =>
        holding
          ? new Promise<WishlistFolder[]>((resolve) => (pending = resolve))
          : current,
      );
      return {
        hold: () => {
          holding = true;
        },
        waiting: () => pending !== null,
        answer: async (folders: WishlistFolder[]) => {
          current = folders;
          holding = false;
          await act(async () => {
            pending!(folders);
            // The page hears an answer a task later (TanStack's notify scheduler), so wait that
            // out: two answers landing inside one task would be drawn as one, and "the first answer
            // after the write" would be one this page never saw.
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        },
        /** What every read answers from now on, without answering the one waiting. */
        becomes: (folders: WishlistFolder[]) => {
          current = folders;
        },
      };
    }
    /** Move `Ordered` down from its `⋯`, the way a reader does — the menu hands the caret back to
     *  the `⋯` before it runs the row. */
    async function moveOrderedDown(user: ReturnType<typeof userEvent.setup>) {
      await user.click(menuOf(ORDERED.id));
      await user.click(
        within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move down" }),
      );
      await waitFor(() => expect(wishlistFolderReorder).toHaveBeenCalled());
    }
    /**
     * The wall's scroller, made to scroll for real. jsdom's never moves, so this one keeps a
     * `scrollTop`, answers `scrollTo` by moving it and firing `scroll` — which is what the
     * virtualiser listens to, so a reveal really changes which rows are drawn — and counts every
     * call. The banded table scrolls the box around `role="table"`; the wall scrolls itself here
     * (`CardGrid`'s `grow` falls back to its own box where no ancestor scrolls, which under jsdom is
     * always).
     */
    const scrolling = (view: "table" | "grid"): Mock => {
      const scroller =
        view === "table"
          ? screen.getByRole("table", { name: "Your wishlist" }).parentElement!
          : screen.getByRole("group", { name: "Your wishlist" });
      let top = 0;
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 20_000 });
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
        },
      });
      const spy = vi.fn((options?: ScrollToOptions) => {
        top = Math.max(0, options?.top ?? top);
        scroller.dispatchEvent(new Event("scroll"));
      });
      Object.defineProperty(scroller, "scrollTo", { configurable: true, value: spy });
      return spy;
    };
    /** The page's own filter box — somewhere a reader can put the caret that is not on the wall. */
    const filterBox = () => screen.getByRole("searchbox", { name: "Search your wishlist" });

    /**
     * **Only the reveal can bring the heading back** (the review's missing case). `Someday`'s twenty
     * wishes are laid between the two headings once `Ordered` moves below them, so the moved heading
     * is past the virtual window and genuinely not drawn — no `⋯` for the caret to go to — until the
     * wall scrolls to it through `revealShelfId`. The cases above keep the heading mounted and only
     * emulate the loss, so they stay green with the reveal unwired; this one does not.
     */
    it("reveals a moved heading the wall had drawn away, and hands it the caret, in the grid", async () => {
      useAppStore.setState({ wishlistView: "grid" });
      wishlistList.mockImplementation(listByShelves(twenty(SOMEDAY.id)));
      const rereads = slowRereads();
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByAltText("Wish 1");
      const scrolls = scrolling("grid");

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      await rereads.answer(PLANNED);

      await waitFor(() => expect(document.activeElement).toBe(menuOf(ORDERED.id)));
      expect(scrolls).toHaveBeenCalled();
      // The wall is scrolled down past Someday's twenty to where Ordered now sits: its own heading,
      // at the top, is the one no longer drawn.
      expect(queryHeading(SOMEDAY.id)).toBeNull();
    });

    /**
     * **The heading takes the caret only while nothing else has it** — `<body>`, or still the `⋯`
     * that was pressed — and spends the request either way. A reader who has moved on before the
     * folder list came back keeps the caret where they put it; and the request, spent, does not
     * wait to snatch it later when the caret next falls to `<body>` and the page re-renders.
     */
    it.each(["table", "grid"] as const)(
      "leaves a caret the reader has put elsewhere, and does not come back for it, in the %s",
      async (view) => {
        useAppStore.setState({ wishlistView: view });
        wishlistList.mockImplementation(listByShelves([]));
        const rereads = slowRereads();
        const user = userEvent.setup();
        wrap(<WishlistPage />);
        await findHeading(ORDERED.id);

        rereads.hold();
        await moveOrderedDown(user);
        await waitFor(() => expect(rereads.waiting()).toBe(true));
        const elsewhere = filterBox();
        act(() => elsewhere.focus());
        await rereads.answer(PLANNED);

        await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
        expect(document.activeElement).toBe(elsewhere);

        // The caret falls to `<body>` and the wall re-renders (a fold write, pressed without taking
        // the caret) — a request still standing would take it now.
        act(() => elsewhere.blur());
        fireEvent.click(screen.getByRole("button", { name: /^Collapse all/ }));
        await waitFor(() => expect(setShelfFolds).toHaveBeenCalled());
        expect(document.activeElement).toBe(document.body);
      },
    );

    /**
     * **A move is decided at the folder list's first answer after the write** — here another window
     * put the order back, so the first re-read does not carry the planned order and the request is
     * dropped. It must not wait on: the planned order arriving later, by another route, is not the
     * reader's move landing, and a caret pulled to it then would be a caret nobody asked for.
     */
    it("drops a move whose first re-read does not carry its order", async () => {
      const rereads = slowRereads();
      const user = userEvent.setup();
      const { client } = wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      await rereads.answer(FOLDERS);
      (document.activeElement as HTMLElement | null)?.blur();

      rereads.becomes(PLANNED);
      await act(() => client.invalidateQueries({ queryKey: ["wishlist", "folders"] }));
      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).toBe(document.body);
    });

    /**
     * **A request lives on the level and the view it was made on.** Walked away from while its move
     * is still answering — the other view, or another level and back — it is dropped, so a wall that
     * remounts does not reveal a heading the reader has long left and take the caret to it.
     */
    it("drops a move's request when the view changes before its order arrives", async () => {
      const rereads = slowRereads();
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      act(() => useAppStore.setState({ wishlistView: "grid" }));
      await waitFor(() => expect(screen.getByRole("group", { name: "Your wishlist" })).toBeTruthy());
      (document.activeElement as HTMLElement | null)?.blur();
      await rereads.answer(PLANNED);

      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).toBe(document.body);
    });

    it("drops a move's request when the reader walks to another level before its order arrives", async () => {
      const rereads = slowRereads();
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      // Into Someday, and back out by the path row.
      await user.click(titleOf(SOMEDAY.id, "Someday"));
      await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));
      await waitFor(() => expect(queryHeading(ORDERED.id)).toBeNull());
      await user.click(
        within(screen.getByRole("navigation", { name: "Wishlist folders" })).getByRole("button", {
          name: "Wishlist",
        }),
      );
      await findHeading(ORDERED.id);
      (document.activeElement as HTMLElement | null)?.blur();
      await rereads.answer(PLANNED);

      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).toBe(document.body);
    });

    /** The level **asked for** counts as soon as it is asked: while a level nothing has cached is
     *  answering, the page still draws the one being left — and a heading on that held wall must not
     *  take the caret the reader has just walked away from. */
    it("drops a move's request as soon as another level is asked for, while the old one is still drawn", async () => {
      // Someday's level never answers, so the root stays drawn, held, for the rest of the case.
      wishlistList.mockImplementation(async (q: WishlistQuery) =>
        q.shelves?.[0] === SOMEDAY.id ? new Promise<never>(() => {}) : page([]),
      );
      const rereads = slowRereads();
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      await user.click(titleOf(SOMEDAY.id, "Someday"));
      await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));
      (document.activeElement as HTMLElement | null)?.blur();
      await rereads.answer(PLANNED);

      // Still the root's wall, re-laid in the new order — and nothing on it took the caret.
      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).toBe(document.body);
    });

    /**
     * **The next layer the page opens replaces the request** — in both of its states. Recorded and
     * waiting on its re-read, `open` drops it; still unrecorded because the write has not answered,
     * `open` supersedes it, so the write's success records nothing. Either way the caret is the new
     * layer's business. In the table, where the moved heading's band is keyed by its folder, so the
     * caret the Rename field hands back falls to `<body>` when `Someday`'s band moves — the moment a
     * standing request would take it.
     */
    it("drops a recorded move's request when the page opens another layer", async () => {
      const rereads = slowRereads();
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      rereads.hold();
      await moveOrderedDown(user);
      await waitFor(() => expect(rereads.waiting()).toBe(true));
      await user.click(renameOf(SOMEDAY.id));
      await nameField();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(within(wallOf()).queryByRole("textbox")).toBeNull());
      await rereads.answer(PLANNED);

      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).not.toBe(menuOf(ORDERED.id));
    });

    it("records nothing for a move whose write answers after the page opened another layer", async () => {
      let succeed!: () => void;
      let moved = false;
      wishlistFolderList.mockImplementation(async () => (moved ? PLANNED : FOLDERS));
      wishlistFolderReorder.mockImplementation(
        () =>
          new Promise((resolve) => {
            succeed = () => {
              moved = true;
              resolve([]);
            };
          }),
      );
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      await moveOrderedDown(user);
      await user.click(renameOf(SOMEDAY.id));
      await nameField();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(within(wallOf()).queryByRole("textbox")).toBeNull());
      await act(async () => succeed());

      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).not.toBe(menuOf(ORDERED.id));
    });

    /**
     * **Cancelling the new folder hands the caret back to Add folder, as committing does** — Escape
     * and the ✕ are the keyboard ways out. The press here leaves the caret on `<body>` (no opener the
     * page can focus), as a heading the field had scrolled away would; only the request brings it
     * back.
     */
    it.each([
      ["table", "Escape"],
      ["table", "✕"],
      ["grid", "Escape"],
      ["grid", "✕"],
    ] as const)("cancel returns to Add folder, in the %s, by %s", async (view, by) => {
      useAppStore.setState({ wishlistView: view });
      wishlistList.mockImplementation(listByShelves([]));
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      fireEvent.click(addFolderOn(ORDERED.id));
      const field = await nameField();
      await user.type(field, "Half a name");
      if (by === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(heading(NEW_FOLDER_SHELF)).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(document.activeElement).toBe(addFolderOn(ORDERED.id)));
      expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull();
      expect(wishlistFolderCreate).not.toHaveBeenCalled();
    });

    /**
     * **A blur-discard hands the caret back only when it has nowhere else to be.** Blurred to
     * nothing — the caret falling to `<body>` — it comes back to Add folder as a cancel does.
     */
    it("hands the caret back to Add folder after a blur that left it nowhere", async () => {
      wishlistList.mockImplementation(listByShelves([]));
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      fireEvent.click(addFolderOn(ORDERED.id));
      const field = await nameField();
      act(() => field.blur());

      await waitFor(() => expect(document.activeElement).toBe(addFolderOn(ORDERED.id)));
      expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull();
    });

    /**
     * **And a click on a row below the draft takes the caret itself**: the wall neither scrolls back
     * up to the heading nor has the caret taken away (review Minor 5). The draft is Ordered's last
     * child, after Backordered's twenty wishes, so the table has scrolled down to it and Ordered's
     * heading is above the window — a request recorded here would scroll back up to it.
     */
    it("neither scrolls back nor takes the caret after a blur onto a row below the draft", async () => {
      wishlistList.mockImplementation(listByShelves(twenty(BACKORDERED.id)));
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      const scrolls = scrolling("table");

      fireEvent.click(addFolderOn(ORDERED.id));
      const field = await nameField();
      await waitFor(() => expect(scrolls).toHaveBeenCalled());
      await screen.findByText("Wish 20");
      scrolls.mockClear();
      const row = screen.getByText("Wish 20").closest<HTMLElement>('[role="row"]')!;
      act(() => row.focus());
      // The blur is decided a task after it — once the caret has landed — so wait that task out, and
      // the render a recorded request would cause, before saying nothing happened.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

      await waitFor(() => expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull());
      expect(field.isConnected).toBe(false);
      expect(document.activeElement).toBe(row);
      expect(scrolls).not.toHaveBeenCalled();
    });

    /** `n` wishes filed in one folder, named `Wish 1`…, for walls longer than a page. */
    const many = (folderId: number, n: number) =>
      Array.from(
        { length: n },
        (_, i): WishRow => ({
          ...BOLT,
          id: 1000 + i,
          name: `Wish ${i + 1}`,
          cardId: `m${i}`,
          artCardId: `m${i}`,
          folderId,
        }),
      );
    /** {@link listByShelves}, paged the way `wishlist_list` pages: `limit` rows from `offset`, and
     *  the whole match as `total` — so a list past `WISHLIST_PAGE_SIZE` arrives a page at a time. */
    const pagedByShelves = (pool: readonly WishRow[]) => async (q: WishlistQuery) => {
      const all = (await listByShelves(pool)({ ...q, limit: 0, offset: 0 })).items;
      const from = q.offset ?? 0;
      return page(all.slice(from, from + (q.limit ?? all.length)), all.length);
    };
    const pagedFrom = (offset: number) =>
      wishlistList.mock.calls.some(([q]) => (q as WishlistQuery).offset === offset);

    /**
     * **Add folder in the table draws its field even where the draft's band is past the loaded
     * edge** (the final review's W-I2, ledger 146). The table's rows stop at the first shelf whose
     * cards are still loading, and the draft is Ordered's last child — after Backordered's 150
     * wishes, of which the first page brings 100 — so the field used to be drawn nowhere while its
     * layer held the Escape rung. The page pages until the band is there; the wall's scroller
     * really scrolls, so the reveal can bring the band into the window.
     */
    it("pages until the new folder's band is drawn, when it is past the table's loaded edge", async () => {
      useAppStore.setState({ wishlistView: "table" });
      wishlistList.mockImplementation(pagedByShelves(many(BACKORDERED.id, 150)));
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      scrolling("table");
      expect(pagedFrom(100)).toBe(false);

      fireEvent.click(addFolderOn(ORDERED.id));

      expect(await nameField()).toBeInTheDocument();
      expect(pagedFrom(100)).toBe(true);
    });

    /** The same edge, for a caret request (ledger 223): a Move whose heading lands after Someday's
     *  150 wishes is past the loaded edge, and paging is what brings its band — and its `⋯`, which
     *  takes the caret back — onto the table. */
    it("pages until a moved heading's band is drawn, and hands its ⋯ the caret, in the table", async () => {
      useAppStore.setState({ wishlistView: "table" });
      wishlistList.mockImplementation(pagedByShelves(many(SOMEDAY.id, 150)));
      let moved = false;
      wishlistFolderList.mockImplementation(async () => (moved ? PLANNED : FOLDERS));
      wishlistFolderReorder.mockImplementation(async () => {
        moved = true;
        return [];
      });
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      scrolling("table");

      await moveOrderedDown(user);

      await waitFor(() => expect(document.activeElement).toBe(menuOf(ORDERED.id)));
      expect(pagedFrom(100)).toBe(true);
    });

    /**
     * **A heading band being dragged stays drawn however far the table scrolls** (the final
     * review's S-I3). The table does not fold during a folder drag, so a heading carried past the
     * overscan scrolled out of the window and unmounted its own drag source. The page hands
     * `VirtualTable` the carried heading's band as `keepRow`.
     */
    it("keeps the heading band being dragged drawn however far the table scrolls", async () => {
      useAppStore.setState({ wishlistView: "table" });
      wishlistList.mockImplementation(listByShelves(many(SOMEDAY.id, 60)));
      wrap(<WishlistPage />);
      await findHeading(ORDERED.id);
      await screen.findByText("Wish 1");
      scrolling("table");
      const carried = heading(ORDERED.id);

      const held = await holdHeading(ORDERED.id);
      expect(held.started).toBe(true);
      const scroller = screen.getByRole("table", { name: "Your wishlist" }).parentElement!;
      act(() => scroller.scrollTo({ top: 2500 }));

      await waitFor(() => expect(screen.queryByText("Wish 1")).toBeNull());
      expect(queryHeading(ORDERED.id)).toBe(carried);
      await held.cancel();
    });

    /** A refused move spends the note, so it cannot fire later on an order that happens to match. */
    it("forgets a refused move", async () => {
      const user = userEvent.setup();
      wishlistFolderReorder.mockRejectedValue(new Error("refused"));
      let order = FOLDERS;
      wishlistFolderList.mockImplementation(async () => order);
      const { client } = wrap(<WishlistPage />);
      await findHeading(ORDERED.id);

      await user.click(menuOf(ORDERED.id));
      await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Move down" }));
      await waitFor(() => expect(wishlistFolderReorder).toHaveBeenCalled());
      (document.activeElement as HTMLElement | null)?.blur();

      // The order the move asked for arrives later, by another route — nothing takes the caret.
      order = [{ ...SOMEDAY, sortOrder: 0 }, { ...ORDERED, sortOrder: 1 }, BACKORDERED];
      await act(() => client.invalidateQueries({ queryKey: ["wishlist", "folders"] }));
      await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
      expect(document.activeElement).toBe(document.body);
    });
  });

  /** Spec §6: a heading takes a card expanded **or collapsed** — a shut shelf is still a drawer. */
  it("files a wish dropped on a collapsed heading", async () => {
    const { container } = wrap(<WishlistPage />, { folds: { [SOMEDAY.id]: true } });
    await screen.findByText("Lightning Bolt");
    expect(chevronOf(SOMEDAY.id, "Someday")).toHaveAttribute("aria-expanded", "false");

    await wishOnto(cardSources(container)[0], heading(SOMEDAY.id));

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, SOMEDAY.id);
  });

  /** And an empty folder's dashed box — the container the box's own words promise. */
  it("files a wish dropped on an empty folder's dashed box", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wishlistFolderList.mockResolvedValue([SOMEDAY]);
    const { container } = wrap(<WishlistPage />);
    await screen.findByAltText("Lightning Bolt");
    // `Someday` is the only folder on this wall, so its box is the only one.
    const box = await waitFor(() => {
      const [only] = emptyBoxes();
      if (only === undefined) throw new Error("no empty box for Someday");
      return only;
    });

    await wishOnto(cardSources(container)[0], box);

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, SOMEDAY.id);
  });

  /**
   * Spec §3.2: a collapsed heading peeks at its shelf's first cards — from the **counts**, because a
   * shut shelf's cards are never fetched (spec §4.1). An open shelf peeks at nothing, since its
   * cards are right under it.
   */
  it("peeks at a collapsed shelf's first cards, which it never fetched, and at nothing while open", async () => {
    const DRAIN: WishRow = {
      ...FILED,
      id: 15,
      name: "Mana Drain",
      cardId: "c-drain",
      artCardId: "c-drain",
    };
    wishlistList.mockImplementation(listByShelves([BOLT, ANY, FILED, DRAIN]));
    wrap(<WishlistPage />, { folds: { [ORDERED.id]: true } });
    await screen.findByText("Lightning Bolt");

    await waitFor(() =>
      expect(heading(ORDERED.id).querySelector("[data-shelf-peek]")?.children).toHaveLength(2),
    );
    // Pictures of the shelf, not its rows: neither wish is on the wall.
    expect(screen.queryByText("Mana Drain")).toBeNull();
    expect(screen.queryByText("Rhystic Study")).toBeNull();
    expect(heading(0).querySelector("[data-shelf-peek]")).toBeNull();
  });

  /**
   * Spec §3.3 and §3.10, the same rails in the table as on the wall: one per level, on the band and
   * on every row under it. A depth-2 shelf — `Signed`, under `Backordered`, under `Ordered` — has
   * two, at the wall's own offsets. A depth-0 shelf has none.
   */
  it("draws a rail per level on a nested shelf's band and on every row under it, in the table", async () => {
    const SIGNED: WishlistFolder = {
      id: 4,
      parentId: BACKORDERED.id,
      name: "Signed",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };
    const INSIDE: WishRow = {
      ...FILED,
      id: 14,
      folderId: SIGNED.id,
      name: "Force of Will",
      cardId: "c-fow",
      artCardId: "c-fow",
    };
    wishlistFolderList.mockResolvedValue([...FOLDERS, SIGNED]);
    wishlistList.mockImplementation(listByShelves([BOLT, ANY, FILED, INSIDE]));
    wrap(<WishlistPage />);

    const rowOf = (el: Element) => el.closest('[role="row"]') as HTMLElement;
    const rails = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-shelf-rail]")];
    const deep = rowOf(await screen.findByText("Force of Will"));

    expect(rails(deep)).toHaveLength(2);
    expect(rails(deep).map((rail) => rail.style.left)).toEqual(["11px", "43px"]);
    expect(rails(rowOf(heading(SIGNED.id)))).toHaveLength(2);
    expect(rails(rowOf(heading(BACKORDERED.id)))).toHaveLength(1);
    expect(rails(rowOf(screen.getByText("Rhystic Study")))).toHaveLength(0);
    expect(rails(rowOf(screen.getByText("Lightning Bolt")))).toHaveLength(0);
  });

  /**
   * Spec §5.3 in the table: scrolled into a shelf's rows, the sticky bar names that shelf, and its
   * **Top** scrolls the table back up. While the bar is live `VirtualTable` scrolls a plain box
   * around the `role="table"` element — the bar may not live inside a table — so that box is the
   * scroller, and the table itself scrolls nothing. **Asserted on the scroller's own `scrollTop`**,
   * never on a `scrollTo` spy, which would pass over a press aimed at the table that no longer
   * moves.
   */
  it("pins the shelf the table is scrolled inside, and its Top scrolls the table's own scroller", async () => {
    wrap(<WishlistPage />);
    const table = await screen.findByRole("table", { name: "Your wishlist" });
    await screen.findByText("Lightning Bolt");
    const scroller = table.parentElement as HTMLElement;
    // jsdom lays nothing out and keeps no scroll offset, so the scroller is given one: 50px down
    // puts `Lightning Bolt`, Not sorted's first row, under the column header's bottom edge.
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    top = 50;
    fireEvent.scroll(scroller);

    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-shelf-sticky]");
      if (found === null) throw new Error("no sticky bar");
      return found;
    });
    expect(bar).toHaveAttribute("data-shelf-sticky", "0");
    // Not inside the table: a `role="table"` may own rows and row groups only.
    expect(table).not.toContainElement(bar);

    await userEvent.click(within(bar).getByRole("button", { name: "Top" }));

    expect(top).toBe(0);
  });
});

/**
 * The cabinet on shelves: the breadcrumb, a heading per folder, and the writes that shape a folder.
 * Design spec §3–§6.
 *
 * **The filing is the backend's and nothing here filters.** `wishlist_list` takes the shelves to
 * return, so what these tests drive is which shelves the page asks for and what it draws around the
 * answer — which is why the list mock answers *per query* rather than resolving once.
 */
describe("the folders", () => {
  beforeEach(() => {
    wishlistList.mockReset().mockImplementation(listByShelves([BOLT, ANY, FILED]));
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
  });

  /** The trail, re-queried each time: every level change replaces the whole `<nav>`. */
  const crumbs = () => screen.getByRole("navigation", { name: "Wishlist folders" });

  /**
   * Whether a folder question is drawn **in the strip above the wall** — outside the wall and
   * before it in document order, which is the whole of what "above" means to a reader.
   *
   * Structural rather than a class assertion, which is the only form of this that can go red for
   * the right reason: `rounded-lg border bg-surface` matches a dozen boxes on this page, jsdom
   * paints none of them, and a panel that had wandered into the wall would still be wearing the
   * classes.
   */
  const drawnAboveTheWall = (panel: HTMLElement): boolean => {
    const wall = wallOf();
    return !wall.contains(panel) && follows(panel, wall);
  };

  /**
   * A real Escape at `document.body`, reporting whether **anything consumed it** —
   * `useDismissOnEscape.test.tsx`'s own helper, here because `userEvent.keyboard` throws the
   * answer away and the answer is the whole of what "leaves Escape alone" asserts. A rung that
   * acted on a press it had no level to spend it on would swallow it from everything behind this
   * page, and a no-op state write looks identical on screen.
   */
  const pressEscape = () => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  };

  /**
   * **A folder's heading reads the recursive total, and the summary row it is drawn from is not.**
   * `Ordered` holds one wish itself and a sub-folder holding two, so a heading reading its own row
   * raw would say `1 wish` over a drawer holding three — and `Someday`, which has no row at all
   * because the read groups the wishes, would draw nothing rather than the `0 wishes` that is the
   * whole point of seeding an empty folder.
   */
  it("adds a folder's sub-folders into the figures on its heading", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00"));
    // `Someday` has no summary row at all — the read groups the wishes — and still says so.
    expect(heading(SOMEDAY.id)).toHaveTextContent("0 wishes");
    // Every level below is on the wall now, not behind a door one drawer down.
    expect(heading(BACKORDERED.id)).toHaveTextContent("2 wishes · $20.00");
    expect(follows(heading(ORDERED.id), heading(BACKORDERED.id))).toBe(true);
    expect(follows(heading(BACKORDERED.id), heading(SOMEDAY.id))).toBe(true);
  });

  /**
   * Opening a folder **replaces the level**: the read is a different read, so the root's wishes are
   * gone rather than filtered out of a list that still holds them.
   */
  it("opens a folder from its heading's title, and the breadcrumb says where the reader is", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(titleOf(ORDERED.id, "Ordered"));

    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
    expect(lastQuery().shelves).toEqual([ORDERED.id, BACKORDERED.id]);
    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Lightning Bolt")).not.toBeInTheDocument());
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");
    expect(within(crumbs()).getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
    // The opened folder's own cards have no heading of their own — the path row names them
    // (spec §3.1) — and its sub-folder is the top shelf now.
    expect(queryHeading(ORDERED.id)).toBeNull();
    expect(await findHeading(BACKORDERED.id)).toHaveTextContent("2 wishes · $20.00");
  });

  /**
   * **A level the cache does not hold is walked to in one step, never two** (live pass §14). The
   * two reads land apart, and drawn as they landed the page showed the new level's wall without its
   * own wishes under the old level's figures for 36–106 ms. Until both have answered the page keeps
   * the level being left — trail, figures and wall — and then switches whole. Gated here so each
   * read lands on the test's word; `useWishlist.test.ts` holds the rule without the page around it.
   */
  it("keeps the level being left, trail, figures and wall, until the new one has answered", async () => {
    let openList!: () => void;
    let openCounts!: () => void;
    const listGate = new Promise<void>((resolve) => (openList = resolve));
    const countsGate = new Promise<void>((resolve) => (openCounts = resolve));
    const atOrdered = (q: WishlistQuery) => q.shelves?.[0] === ORDERED.id;
    const read = listByShelves([BOLT, ANY, FILED]);
    wishlistList.mockImplementation(async (q: WishlistQuery) => {
      if (atOrdered(q)) await listGate;
      return read(q);
    });
    wishlistShelfCounts.mockImplementation(async (q: WishlistQuery) => {
      if (atOrdered(q)) await countsGate;
      return countsFor((await read({ ...q, limit: 500, offset: 0 })).items, q.shelves);
    });
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await waitFor(() => expect(figure("Wishes")).toHaveTextContent("3"));

    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));

    const theRootWhole = () => {
      expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
      expect(figure("Wishes")).toHaveTextContent("3");
      expect(heading(ORDERED.id)).toBeInTheDocument();
      expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
    };
    theRootWhole();
    // The counts land first — Ordered's figures must not go up over the root's wall.
    await act(async () => openCounts());
    theRootWhole();

    await act(async () => openList());
    await waitFor(() =>
      expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page"),
    );
    expect(figure("Wishes")).toHaveTextContent("1");
    expect(screen.getByText("Rhystic Study")).toBeInTheDocument();
    expect(screen.queryByText("Lightning Bolt")).toBeNull();
    expect(queryHeading(ORDERED.id)).toBeNull();
  });

  /**
   * **Escape climbs from where the last press went, not from what is drawn.** While a walk is
   * answering the page still draws the level being left, so a second Escape in that beat read off
   * the drawn trail would ask for the same parent again — two presses, one level.
   */
  it("climbs two levels on two quick Escapes while the first walk is answering", async () => {
    let openOrdered!: () => void;
    const orderedGate = new Promise<void>((resolve) => (openOrdered = resolve));
    const read = listByShelves([BOLT, ANY, FILED]);
    wishlistList.mockImplementation(async (q: WishlistQuery) => {
      if (q.shelves?.[0] === ORDERED.id) await orderedGate;
      return read(q);
    });
    useAppStore.setState({ pendingFolder: { scope: "wishlist", id: BACKORDERED.id } });
    wrap(<WishlistPage />);
    await waitFor(() =>
      expect(within(crumbs()).getByText("Backordered")).toHaveAttribute("aria-current", "page"),
    );
    // Backordered answered in full — its own empty box drawn from its counts — so it is the level
    // held while Ordered is read.
    await waitFor(() => expect(emptyBoxes()).toHaveLength(1));

    act(() => void pressEscape());
    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
    // Held: still drawn at Backordered.
    expect(within(crumbs()).getByText("Backordered")).toHaveAttribute("aria-current", "page");
    act(() => void pressEscape());

    await waitFor(() => expect(levelAsked()).toBeNull());
    await act(async () => openOrdered());
    await waitFor(() =>
      expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page"),
    );
  });

  /**
   * Escape is the way back out, and the breadcrumb is where a reader reads that it worked.
   * `useDismissOnEscape`'s `"navigation"` rung — the floor, the press nothing nearer wanted.
   *
   * **Two levels deep on purpose.** A rung that sent the reader to the root would pass a
   * one-level test and strand anyone who had drilled twice, which is exactly the failure the
   * trail-derived parent exists to prevent.
   */
  it("walks up one folder per Escape, after opening two by their titles", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await findHeading(BACKORDERED.id);
    await userEvent.click(titleOf(BACKORDERED.id, "Backordered"));
    await waitFor(() => expect(levelAsked()).toBe(BACKORDERED.id));

    await userEvent.keyboard("{Escape}");

    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");

    await userEvent.keyboard("{Escape}");

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
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));

    const box = screen.getByLabelText("Search your wishlist");
    await userEvent.type(box, "rhystic");

    await userEvent.keyboard("{Escape}");

    expect(box).toHaveValue("");
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");

    await userEvent.keyboard("{Escape}");

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  /** Spec §3.6: the figures count everything the wall covers — this level and every shelf below
   *  it — which is what turned **Wishes 0** into the reader's real count. */
  it("counts everything at and below the level, at the root and inside a folder", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    // BOLT and ANY loose, and FILED under Ordered — the wish the drill-down used to hide.
    await waitFor(() => expect(figure("Wishes")).toHaveTextContent("3"));

    await userEvent.click(titleOf(ORDERED.id, "Ordered"));

    await waitFor(() => expect(figure("Wishes")).toHaveTextContent("1"));
  });

  /** Replaces "opens on the tree rather than flattened…": there is no flattened list to open on,
   *  and the read that goes out is the shelves, never a folder id or a flag. */
  it("asks for shelves, never for a folder or a flattened list", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    expect(lastQuery().shelves).toEqual([0, ORDERED.id, BACKORDERED.id, SOMEDAY.id]);
    expect(lastQuery()).not.toHaveProperty("folderId");
    expect(lastQuery()).not.toHaveProperty("flatten");
    expect(screen.queryByRole("button", { name: "Flatten" })).toBeNull();
  });

  /** Replaces "shows every wish while flattened, and puts the cabinet away": every wish is on the
   *  root's wall now, each under its folder's heading — which is what Flatten's caption was for. */
  it("shows every wish at the root, each under its folder's heading", async () => {
    wrap(<WishlistPage />);
    const filed = await screen.findByText("Rhystic Study");

    expect(follows(heading(0), screen.getByText("Lightning Bolt"))).toBe(true);
    expect(follows(screen.getByText("Lightning Bolt"), heading(ORDERED.id))).toBe(true);
    expect(follows(heading(ORDERED.id), filed)).toBe(true);
    expect(follows(filed, heading(BACKORDERED.id))).toBe(true);
    // The band it replaced is gone, and so is the word the band's tile spent.
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
  });

  /**
   * Replaces "draws Flatten with the layout pair on the filter bar…": the fence is still "not
   * among the filters" — the shelf controls ride the path row beside the breadcrumb.
   *
   * **Asserted as a containment fact rather than as a class string**, which is the only form of
   * this that cannot go quietly green: jsdom applies no container query, so nothing about where
   * the controls *paint* is observable here. What is observable is which box holds what.
   */
  it("draws the shelf controls on the path row, beside the breadcrumb and off the filter bar", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    const expand = screen.getByRole("button", { name: "Expand all" });
    let row = expand.parentElement;
    while (row !== null && !row.contains(crumbs())) row = row.parentElement;
    expect(row).not.toBeNull();
    expect(row).toContainElement(screen.getByRole("button", { name: "Collapse all" }));
    expect(row).toContainElement(pathAddFolder());
    // The smallest box holding the trail and the controls holds no filter — it is the path row.
    expect(row).not.toContainElement(screen.getByLabelText("Search your wishlist"));
  });

  /** Replaces "puts New folder first in the wall of folder cards". */
  it("offers Add folder on the path row, and no wall of folder cards", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    expect(pathAddFolder()).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
  });

  /**
   * Replaces the trap-door case: a reader with no folder still has Add folder — the path row is
   * drawn over an empty cabinet — and the field it opens is a heading on the wall.
   *
   * The press at the end is the half that makes this a regression test rather than a note about
   * markup: a button that reaches nothing would pass every line above it.
   */
  it("offers Add folder over an empty cabinet, and the field it opens is a heading on the wall", async () => {
    wishlistFolderList.mockResolvedValue([]);
    wishlistFolderSummary.mockResolvedValue([]);
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    expect(screen.queryByRole("navigation", { name: "Wishlist folders" })).toBeNull();

    await userEvent.click(pathAddFolder());

    const field = await nameField();
    expect(heading(NEW_FOLDER_SHELF)).toContainElement(field);
    expect(field).toHaveFocus();
  });

  /**
   * **Add folder takes the caret back**, by both ways out. The page's `dismiss` focuses the
   * element `open(next, opener)` latched — the path row's Add folder, which stays mounted beside
   * the breadcrumb while the field is open on the wall — so the caret has somewhere to land.
   *
   * **Both ways out, because they are two different mechanisms arriving at one place.** The ✕ is
   * the field's own button and unmounts under the caret; Escape is the page's `"inner"` rung,
   * fired at the input. A restore written for one of them and not the other would leave half the
   * gesture dropping focus to the top of the app, and nothing on screen would say so.
   *
   * **Driven by a click, never by `el.focus()`.** Starting a keyboard flow from a programmatically
   * focused element tests a caret a reader cannot produce — and the caret this asserts about is one
   * a *pointer* creates, so the pointer is what has to make it.
   */
  it("gives the caret back to the path row's Add folder, by the ✕ and by Escape", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(pathAddFolder());
    expect(await nameField()).toHaveFocus();
    await userEvent.click(within(heading(NEW_FOLDER_SHELF)).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull());
    expect(pathAddFolder()).toHaveFocus();

    await userEvent.click(pathAddFolder());
    expect(await nameField()).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull());
    expect(pathAddFolder()).toHaveFocus();
  });

  /**
   * **And the third way out, which is the one that succeeds** — the caret has to come back from a
   * committed write as well as from an abandoned one, or a reader who makes three folders in a
   * row is thrown to the top of the app after each.
   *
   * It is a different route to the same place and that is why it is its own case: pressing ✓
   * greys the tick *while the write is in flight*, so the browser blurs the control under the
   * reader's own hand and the caret is already at `<body>` before the field unmounts. Nothing in
   * the ✕ path exercises that, and a restore guarded on the wrong element would pass there and
   * fail here.
   */
  it("gives the caret back to Add folder when the create commits", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(pathAddFolder());
    await nameField();
    await userEvent.keyboard("Paid for{Enter}");

    expect(wishlistFolderCreate).toHaveBeenCalledWith(null, "Paid for");
    await waitFor(() => expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull());
    expect(pathAddFolder()).toHaveFocus();
  });

  /** Replaces "draws the naming field in the wall, in the tile's own place": the field is a heading
   *  where the new folder will live — last among the root's folders (spec §3.8). One open field
   *  across the whole wall is what `openPanel` naming exactly one thing buys. */
  it("draws the new folder's heading last among the level's folders", async () => {
    wrap(<WishlistPage />);
    await findHeading(SOMEDAY.id);

    await userEvent.click(pathAddFolder());

    const field = await nameField();
    expect(follows(heading(SOMEDAY.id), field)).toBe(true);
    expect(titleOf(ORDERED.id, "Ordered")).toBeInTheDocument();
    expect(within(wallOf()).getAllByRole("textbox")).toEqual([field]);
  });

  /**
   * **A plain move is answered by a re-read, not by a guess about where the wish went.**
   *
   * This is the regression test for what the live pass of 2026-08-22 found: the write removed the
   * row from every cached page and then invalidated only the folder summary, so a filed wish was
   * gone from the app until a reload. The mock is a backend that really moves the wish, because
   * that is the only thing that can put the row under its new heading: it is sorted and paged by
   * the backend, and this page knows neither the position nor the page. `staleTime: 30_000` is the
   * app's own number, which leaves an invalidation as the only thing that can mark the list stale.
   */
  it("re-reads the whole wishlist after a plain move, so the wish is under the heading it was filed to", async () => {
    let filed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      listByShelves([{ ...BOLT, folderId: filed ? ORDERED.id : null }, ANY, FILED])(q),
    );
    wishlistSetFolder.mockImplementation(async (id: number) => {
      filed = true;
      return { id, quantity: 4, removed: false };
    });
    const { client, container } = wrap(<WishlistPage />, { staleTime: 30_000 });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("Lightning Bolt");
    await findHeading(ORDERED.id);

    await wishOnto(cardSources(container)[0], heading(ORDERED.id));

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, ORDERED.id);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    // Moved, not removed: the wall covers every shelf, so the row changes shelf and the count holds.
    await waitFor(() =>
      expect(follows(heading(ORDERED.id), screen.getByText("Lightning Bolt"))).toBe(true),
    );
    expect(figure("Wishes")).toHaveTextContent("3");
  });

  /**
   * Replaces "keeps a moved wish listed while flattened, and moves its caption". It is also the
   * keyboard's whole route to `wishlist_set_folder`, which is why the panel keeps it: a drag-only
   * affordance is half a feature, and it is the half a keyboard cannot use.
   */
  it("keeps a wish moved from its panel on the wall, under its new heading", async () => {
    let filed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      listByShelves([{ ...BOLT, folderId: filed ? ORDERED.id : null }, ANY, FILED])(q),
    );
    wishlistSetFolder.mockImplementation(async (id: number) => {
      filed = true;
      return { id, quantity: 4, removed: false };
    });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Lightning Bolt (LEA 161, Foil) on your wishlist" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Move to folder: Lightning Bolt (LEA 161, Foil)" }),
    );
    const destinations = await screen.findByRole("group", {
      name: "Move Lightning Bolt (LEA 161, Foil) to a folder",
    });
    await userEvent.click(within(destinations).getByRole("button", { name: /Ordered/ }));

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, ORDERED.id);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(follows(heading(ORDERED.id), screen.getByText("Lightning Bolt"))).toBe(true),
    );
    expect(figure("Wishes")).toHaveTextContent("3");
  });

  /**
   * Add folder promises "here", so the parent it sends is the folder the reader is standing in and
   * never the root by default. **The whole trip**: the press opens the field on the wall, the name
   * is typed on the line the folder's own name will occupy, and Enter commits it — so this is also
   * the case that would go red if Add folder opened something that reached no write.
   */
  it("creates a folder inside the one the reader is standing in, from the path row", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await screen.findByText("Rhystic Study");

    await userEvent.click(pathAddFolder());
    await nameField();
    await userEvent.keyboard("Paid for{Enter}");

    expect(wishlistFolderCreate).toHaveBeenCalledWith(ORDERED.id, "Paid for");
  });

  /**
   * Spec §3.2: the ⋯ keeps the folder card's menu minus Rename, plus the keyboard's reorder;
   * Rename is a button on the heading. The strip still answers Move and Delete, above the wall.
   *
   * The delete question is the one a reader guesses wrong: the two cascades point opposite ways,
   * and the sentence says both with the reassuring half first. The answer to "delete this?" is a
   * sentence about what happens to the wishes inside, which is not a name typed on a heading's own
   * line — so the question is asserted to be drawn where it always was: outside the wall and above
   * it.
   */
  it("reaches Move to folder, Move up, Move down, Clear and Delete from a heading's ⋯ — Rename is on the heading", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(menuOf(ORDERED.id));

    const menu = await screen.findByRole("menu");
    for (const row of [/^Move to folder/, /^Move up/, /^Move down/, /^Clear…/, /^Delete…/]) {
      expect(within(menu).getByRole("menuitem", { name: row })).toBeInTheDocument();
    }
    expect(within(menu).queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    expect(renameOf(ORDERED.id)).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole("menuitem", { name: /^Delete…/ }));

    const question = await screen.findByText(
      "Its wishes can move back to your wishlist or be deleted with it; " +
        "folders inside it are deleted either way.",
    );
    expect(drawnAboveTheWall(question)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    expect(wishlistFolderDelete).toHaveBeenCalledWith(ORDERED.id);
    // The answer that keeps every wish reaches only the write that keeps them.
    expect(wishlistFolderDeleteWithWishes).not.toHaveBeenCalled();
  });

  /**
   * **The delete question's second answer, and the one that takes the wishes with it** (issue
   * #471). It is a second button rather than a checkbox on the first, so a reader who presses
   * `Delete folder` from habit still keeps every wish — and this is where the two presses are
   * held to two different writes.
   */
  it("deletes a folder and every wish in it from the second answer", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(menuOf(ORDERED.id));
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete…/ }),
    );
    const question = await screen.findByRole("group", { name: "Delete Ordered" });
    await userEvent.click(
      within(question).getByRole("button", { name: "Delete folder and wishes" }),
    );

    expect(wishlistFolderDeleteWithWishes).toHaveBeenCalledWith(ORDERED.id);
    expect(wishlistFolderDelete).not.toHaveBeenCalled();
    // Answered, so the question goes — `dismiss` on success, as the plain delete does.
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Delete Ordered" })).not.toBeInTheDocument(),
    );
  });

  /**
   * **`Clear…` empties a drawer and keeps it, and its question states the number** — the one
   * figure the heading cannot show. `Ordered`'s heading reads `3 wishes`, its own recursive total,
   * while a clear takes only the one filed directly in it; `Backordered`'s two are what the second
   * sentence promises are left alone.
   */
  it("clears a folder of its own wishes from its heading, and says which ones go", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    // The summary has answered, so the count in the question is a count and not a guess.
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00"));

    await userEvent.click(menuOf(ORDERED.id));
    const row = within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Clear…" });
    expect(row).not.toHaveAttribute("aria-disabled");
    await userEvent.click(row);

    const question = await screen.findByRole("group", { name: "Clear Ordered" });
    expect(drawnAboveTheWall(question)).toBe(true);
    expect(within(question).getByText("Clear “Ordered”?")).toBeInTheDocument();
    expect(
      within(question).getByText(
        "Its 1 wish filed directly in it is removed from your wishlist. " +
          "Folders inside it keep theirs.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Clear folder" }));
    expect(wishlistFolderClear).toHaveBeenCalledWith(ORDERED.id);
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Clear Ordered" })).not.toBeInTheDocument(),
    );
  });

  /** `Backordered` is on the root's wall now, so the question is asked from its heading directly.
   *  The count agrees with its verb, and a drawer with no drawers of its own is not told its
   *  sub-folders keep anything — there are none to keep it. */
  it("says a sub-folder's own count, and names no folders inside one that has none", async () => {
    wrap(<WishlistPage />);
    await findHeading(BACKORDERED.id);

    await userEvent.click(menuOf(BACKORDERED.id));
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Clear…" }),
    );

    const question = await screen.findByRole("group", { name: "Clear Backordered" });
    expect(
      within(question).getByText("Its 2 wishes filed directly in it are removed from your wishlist."),
    ).toBeInTheDocument();
    expect(question).not.toHaveTextContent("Folders inside it keep theirs.");
  });

  /**
   * **Greyed on an answer, with its reason.** `Someday` has no summary row — the read groups the
   * wishes, so an empty drawer is absent rather than zeroed — and once that summary is in, a clear
   * there could only answer `0`. The row's name carries the reason as well as the label, this
   * repo's convention for a greyed row, so it is found by the label and its name asserted whole.
   */
  it("greys Clear… on a folder with nothing filed directly in it, and says why", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(SOMEDAY.id);
    // The summary has answered once the heading reads a count rather than a dash.
    await waitFor(() => expect(heading(SOMEDAY.id)).toHaveTextContent("0 wishes"));

    await user.click(menuOf(SOMEDAY.id));
    const row = within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Clear…/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleName(/Nothing filed directly here/);

    await user.click(row);
    expect(screen.queryByRole("group", { name: "Clear Someday" })).not.toBeInTheDocument();
    expect(wishlistFolderClear).not.toHaveBeenCalled();
  });

  /**
   * **A silence is not an answer.** Before the summary is in, a missing row means nothing, so the
   * row stays live and the question names *which* wishes without guessing how many — a greyed row
   * over a drawer the summary simply had not counted yet would refuse a press that works.
   */
  it("keeps Clear… live before the summary answers, and counts nothing it has not been told", async () => {
    wishlistFolderSummary.mockReturnValue(new Promise(() => {}));
    wrap(<WishlistPage />);
    await findHeading(SOMEDAY.id);

    await userEvent.click(menuOf(SOMEDAY.id));
    const row = within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Clear…" });
    expect(row).not.toHaveAttribute("aria-disabled");
    await userEvent.click(row);

    const question = await screen.findByRole("group", { name: "Clear Someday" });
    expect(
      within(question).getByText("The wishes filed directly in it are removed from your wishlist."),
    ).toBeInTheDocument();
    await userEvent.click(within(question).getByRole("button", { name: "Clear folder" }));
    expect(wishlistFolderClear).toHaveBeenCalledWith(SOMEDAY.id);
  });

  /** Spec §3.8: Rename turns the heading's name into `FolderNameField`, with the name selected, so
   *  the keystrokes go to whatever holds the caret rather than being typed *at* the field. */
  it("renames a folder from its heading", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(renameOf(ORDERED.id));

    const field = await within(heading(ORDERED.id)).findByRole("textbox");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Ordered");
    await userEvent.keyboard("On its way{Enter}");
    expect(wishlistFolderRename).toHaveBeenCalledWith(ORDERED.id, "On its way");
  });

  /**
   * **The field opens on the drawer it is about, and every other drawer goes on resting.**
   *
   * This is the half a rename has that a create does not: there are twelve headings on a full wall
   * and one of them is being renamed, so "the field is on screen" is not the claim — "the field is
   * on *that* heading" is. `openPanel` names exactly one folder and the page compares against it,
   * which is what keeps a wall from turning into a wall of fields.
   *
   * The figures are asserted with it, because a reader renaming a drawer is looking at what is in
   * it, and a heading that dropped the count would make them check they had the right one.
   */
  it("renames on the heading itself, keeps its figures, and leaves every other heading alone", async () => {
    wrap(<WishlistPage />);
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00"));

    await userEvent.click(renameOf(ORDERED.id));

    const field = await within(heading(ORDERED.id)).findByRole("textbox");
    // The figures stay beside the field, so the reader can see which drawer this is.
    expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00");
    // The title that opens the folder is out of the tree while its name is being typed.
    expect(within(heading(ORDERED.id)).queryByRole("button", { name: "Ordered" })).toBeNull();
    // One field on the whole wall.
    expect(within(wallOf()).getAllByRole("textbox")).toEqual([field]);
    expect(titleOf(SOMEDAY.id, "Someday")).toBeInTheDocument();
    expect(menuOf(SOMEDAY.id)).toBeInTheDocument();
  });

  /**
   * **And the heading's Rename takes the caret back**, by both ways out and for
   * `useFolderFieldReturn`'s reason: the button the page latched as the opener is the Rename the
   * field replaced, so it is a detached node by the time `dismiss` focuses it and the element that
   * should have the caret is the one this render has just built.
   *
   * A committed rename as well as an abandoned one, because they leave the caret in different
   * places on the way: Escape fires at the input, and ✓ greys itself while the write is in flight
   * so the browser blurs it first.
   */
  it("gives the caret back to the heading's Rename, by Escape and by a committed rename", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(renameOf(ORDERED.id));
    expect(await within(heading(ORDERED.id)).findByRole("textbox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(heading(ORDERED.id)).queryByRole("textbox")).toBeNull());
    expect(renameOf(ORDERED.id)).toHaveFocus();

    await userEvent.click(renameOf(ORDERED.id));
    await within(heading(ORDERED.id)).findByRole("textbox");
    await userEvent.keyboard("On its way{Enter}");
    await waitFor(() => expect(within(heading(ORDERED.id)).queryByRole("textbox")).toBeNull());
    expect(renameOf(ORDERED.id)).toHaveFocus();
  });

  /**
   * **Walking into another folder puts the naming field away**, and the clause that does it
   * (`panelGone`) is the one thing here a blur cannot cover.
   *
   * The ordinary pointer gesture never reaches it: clicking a folder's title moves focus out of the
   * field, and the field discards its draft on blur, so the panel is already gone before the level
   * changes. The one state where that route is switched off is a **write in flight** — the field
   * holds itself open through the round trip, precisely so a slow create cannot be cancelled by the
   * browser blurring the tick it has just greyed — and a reader who gives up waiting and opens a
   * drawer is exactly the reader this clause is for. So the create below never answers.
   *
   * What it would cost is asserted rather than described: without the clause the panel is still
   * open at the new level, which means `useDismissOnEscape`'s `"inner"` rung is still armed and
   * takes the press in the capture phase — so Escape stops walking the reader back out of the
   * folder they have just opened, and nothing on screen says why.
   */
  it("closes the naming field when the reader walks into another folder", async () => {
    // Never answers: the field is held open by the write rather than by the caret.
    wishlistFolderCreate.mockImplementation(() => new Promise(() => {}));
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(pathAddFolder());
    await nameField();
    await userEvent.keyboard("Paid for{Enter}");
    expect(wishlistFolderCreate).toHaveBeenCalledWith(null, "Paid for");

    await userEvent.click(titleOf(ORDERED.id, "Ordered"));

    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
    await waitFor(() => expect(queryHeading(NEW_FOLDER_SHELF)).toBeNull());
    expect(pathAddFolder()).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
  });

  /**
   * A folder may not go inside itself or inside anything it holds — `wishlist_folders.parent_id`
   * cascades onto itself, so a cycle is a graph SQLite would walk forever the day the folder is
   * deleted. The backend refuses it in words; this is the fence drawn before the reader can ask.
   */
  it("offers a folder every destination but itself and what it holds", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await userEvent.click(menuOf(ORDERED.id));
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Move to folder/ }),
    );

    const list = await screen.findByRole("group", { name: "Move Ordered into a folder" });
    expect(drawnAboveTheWall(list)).toBe(true);
    expect(within(list).getByRole("button", { name: /Ordered/ })).toBeDisabled();
    expect(within(list).getByRole("button", { name: /Backordered/ })).toBeDisabled();
    await userEvent.click(within(list).getByRole("button", { name: /Someday/ }));

    expect(wishlistFolderMove).toHaveBeenCalledWith(ORDERED.id, SOMEDAY.id);
  });

  /**
   * The drag's write, and it is `wishlist_set_folder` — the same command `Move to folder…`
   * calls, so a drag and the keyboard's route merge on a taken grain identically.
   */
  it("files a wish dropped on a folder's heading", async () => {
    const { container } = wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    await findHeading(ORDERED.id);

    await wishOnto(cardSources(container)[0], heading(ORDERED.id));

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, ORDERED.id);
  });

  /**
   * And the way back **out** from inside a folder: a heading only ever takes a wish deeper, so
   * without the breadcrumb the gesture would be one-way.
   */
  it("un-files a wish dropped on the breadcrumb's root", async () => {
    const { container } = wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await screen.findByText("Rhystic Study");

    await wishOnto(
      cardSources(container)[0],
      within(crumbs()).getByRole("button", { name: "Wishlist" }),
    );

    expect(wishlistSetFolder).toHaveBeenCalledWith(FILED.id, null);
  });

  /**
   * Replaces "walks up one level when the tile is pressed". **Two levels deep on purpose**: a
   * segment that always went to the root would pass a one-level test and strand anyone who had
   * drilled twice.
   */
  it("walks up one level from the breadcrumb's parent segment", async () => {
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await findHeading(BACKORDERED.id);
    await userEvent.click(titleOf(BACKORDERED.id, "Backordered"));
    await waitFor(() => expect(levelAsked()).toBe(BACKORDERED.id));

    await userEvent.click(within(crumbs()).getByRole("button", { name: "Ordered" }));

    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
    expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");
  });

  /** Replaces "un-files a wish dropped on the up tile": at the root the drawer-sized way out is the
   *  Not sorted heading, which files to the root (spec §6). */
  it("un-files a wish dropped on the Not sorted heading", async () => {
    const { container } = wrap(<WishlistPage />);
    const filed = await screen.findByText("Rhystic Study");
    const source = cardSources(container).find((row) => row.contains(filed));
    expect(source).toBeDefined();

    await wishOnto(source!, heading(0));

    expect(wishlistSetFolder).toHaveBeenCalledWith(FILED.id, null);
  });

  /**
   * **An opened empty folder is the dashed box and nothing else, in both views, and the box takes a
   * drop in both** (live pass §13) — the collection's arrangement, which was right in both views
   * while this page was right in neither. The wall drew the status line `Nothing filed here yet.`
   * *and* the box, two messages for one fact; the table drew the status line over an empty table,
   * with no box and so nowhere to drop. And it is still not the root's instruction: an empty folder
   * is not an empty wishlist.
   */
  it.each(["table", "grid"] as const)(
    "draws an opened empty folder as its dashed box alone, a drop target, in the %s",
    async (view) => {
      // Opened through the folder hand-off rather than by its title: at the root the grid's jsdom
      // window (600px, one column) ends before Someday's heading, and how the folder was opened is
      // not what this case is about.
      useAppStore.setState({
        wishlistView: view,
        pendingFolder: { scope: "wishlist", id: SOMEDAY.id },
      });
      wrap(<WishlistPage />, { searchOpen: true });
      await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));

      const box = await waitFor(() => {
        const [only, ...rest] = emptyBoxes();
        if (only === undefined || rest.length > 0) throw new Error("not one box for Someday");
        return only;
      });
      expect(box).toHaveTextContent(EMPTY_SHELF_COPY);
      expect(wallOf().contains(box)).toBe(true);
      expect(screen.queryByText("Nothing filed here yet.")).toBeNull();
      expect(
        screen.queryByText(/Add cards from search with the \+ on any row or tile/),
      ).not.toBeInTheDocument();

      // The box is where a card is let go: a tile off the search column, filed into Someday.
      const tile = await waitFor(() => {
        const found = screen
          .getByRole("region", { name: "Add cards to your wishlist" })
          .querySelector<HTMLElement>(`[${DND_SOURCE_ATTR}]`);
        if (!found) throw new Error("no search tile");
        return found;
      });
      await wishOnto(tile, box);
      await waitFor(() =>
        expect(wishlistAdd).toHaveBeenCalledWith(
          expect.objectContaining({ cardId: "c1", folderId: SOMEDAY.id }),
        ),
      );
    },
  );

  /**
   * The folder's figures are on its heading at the root now, so no drill-in is needed to see the
   * re-read land — and `staleTime: 30_000` still makes the invalidation the only thing that can.
   *
   * `wishlist_folder_summary` is a `GROUP BY` with a price expression behind it — arithmetic this
   * page cannot redo — so a drawer whose wish was crossed off would go on advertising it without
   * the re-read. On a shopping list that subtotal is the number somebody buys against.
   */
  it("re-reads a folder's heading figures when a wish inside it is crossed off", async () => {
    let removed = false;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      listByShelves(removed ? [BOLT, ANY] : [BOLT, ANY, FILED])(q),
    );
    wishlistFolderSummary.mockImplementation(async () =>
      removed ? SUMMARY.filter((s) => s.folderId !== ORDERED.id) : SUMMARY,
    );
    wishlistRemove.mockImplementation(async (id: number) => {
      removed = true;
      return { id, quantity: 0, removed: true };
    });
    wrap(<WishlistPage />, { staleTime: 30_000 });
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00"));
    await screen.findByText("Rhystic Study");

    await userEvent.click(
      screen.getByRole("button", { name: /^Remove Rhystic Study \(PCY 45\) from your wishlist/ }),
    );

    expect(wishlistRemove).toHaveBeenCalledWith(FILED.id);
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("2 wishes · $20.00"));
  });

  /**
   * The same hole under the other writer: **a stepper press multiplies straight through into the
   * subtotal**. A copy count is exactly what a folder's money is a function of, so this is the case
   * where the heading's figure and the backend's would disagree by a number the reader chose
   * themselves.
   */
  it("re-reads a folder's heading figures when the stepper changes a wish inside it", async () => {
    let quantity = 1;
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      listByShelves([BOLT, ANY, { ...FILED, quantity }])(q),
    );
    wishlistFolderSummary.mockImplementation(async () =>
      SUMMARY.map((s) =>
        s.folderId === ORDERED.id ? { ...s, copies: quantity, cost: 10 * quantity } : s,
      ),
    );
    wishlistSetQuantity.mockImplementation(async (id: number, next: number) => {
      quantity = next;
      return { id, quantity: next, removed: false };
    });
    wrap(<WishlistPage />, { staleTime: 30_000 });
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $30.00"));
    await screen.findByText("Rhystic Study");

    await userEvent.click(
      screen.getByRole("button", { name: "Increase Copies wanted of Rhystic Study (PCY 45)" }),
    );

    expect(wishlistSetQuantity).toHaveBeenCalledWith(FILED.id, 2);
    await waitFor(() => expect(heading(ORDERED.id)).toHaveTextContent("3 wishes · $40.00"));
  });

  /** The root's sweep is every shelf now, so there is no filing left for the checkbox to set aside
   *  there; inside a folder the drawer is still what narrows it, and both sentences say so. */
  it("names the folder the export is taken from, and offers to widen past the folders only inside one", async () => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await user.click(screen.getByRole("button", { name: "Export wishlist" }));
    expect(
      await screen.findByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close export" }));

    await user.click(titleOf(ORDERED.id, "Ordered"));
    await screen.findByText("Rhystic Study");
    await user.click(screen.getByRole("button", { name: "Export wishlist" }));

    expect(await screen.findByText("1 card in Ordered matching your filters")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Export everything, ignoring the filters and folders" }),
    ).toBeInTheDocument();
  });

  /**
   * And the root with drawers but nothing in them says **nothing**: the headings are the content,
   * and a sentence over them would be the page contradicting itself.
   */
  it("leaves the status line empty where the headings are the content", async () => {
    wishlistList.mockImplementation(async () => page([]));
    wrap(<WishlistPage />);

    await findHeading(ORDERED.id);
    expect(screen.queryByText(/Nothing on your wishlist yet/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing filed here yet.")).not.toBeInTheDocument();
  });

  /**
   * **A drawer another page asked this one to open** — `store.ts`'s `pendingFolder`, whose only
   * writer today is the home page's folder shortcuts, and `CollectionPage.test.tsx`'s block on
   * the other cabinet.
   *
   * Where the reader is standing stays `useWishlist`'s own `useState`, so what arrives is a
   * **one-shot hand-off** rather than a restored folder: read once as this page renders, spent as
   * it is read, remembered by nothing. Three of the four ways it could be quietly wrong look
   * identical on screen to the behaviour that was here before the door existed — the reader lands
   * on the right page, at the root — which is why each case asserts the *query* and the *field*
   * rather than only what is drawn. Rewrite rule: `lastQuery().folderId` becomes
   * {@link levelAsked}; nothing else moves.
   */
  describe("a folder another page asked for", () => {
    it("opens the drawer it names, and spends the hand-off doing it", async () => {
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: ORDERED.id } });
      wrap(<WishlistPage />);

      await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
      expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
      expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");
      await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
    });

    /**
     * **A folder that is gone is not an error — it is a folder that was deleted**, so the reader
     * lands at the root, which is where its wishes have just gone. The hand-off is spent anyway:
     * a drawer this cabinet no longer carries must not leave one pending forever, waiting to fire
     * at a folder that never comes back.
     */
    it("lands at the root when the folder it names is gone, and refuses nothing", async () => {
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: 404 } });
      wrap(<WishlistPage />);

      expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
      expect(levelAsked()).toBeNull();
      await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
    });

    /**
     * **The one that makes it a hand-off rather than a memory.** A field that survived its read
     * would drop the reader into that drawer every later time they opened this page — precisely
     * the folder-restored-at-launch behaviour `useWishlist`'s own comment refuses, arriving
     * through the back door.
     */
    it("does not survive to a second visit", async () => {
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: ORDERED.id } });
      const first = wrap(<WishlistPage />);
      await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));

      first.unmount();
      wrap(<WishlistPage />);

      expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
      await waitFor(() => expect(levelAsked()).toBeNull());
    });

    /**
     * **One field serves both cabinets, so the check is "is there one for me" rather than "is
     * there one".** Without the `scope`, a press on a *collection* shortcut would open whichever
     * wishlist folder happened to share that id — the two cabinets number their drawers
     * independently — and the collection would then find its own post already opened and spent.
     */
    it("leaves the collection's hand-off untouched", async () => {
      useAppStore.setState({ pendingFolder: { scope: "collection", id: 1 } });
      wrap(<WishlistPage />);

      expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
      expect(levelAsked()).toBeNull();
      expect(useAppStore.getState().pendingFolder).toEqual({ scope: "collection", id: 1 });
    });
  });

  /**
   * **A level deleted from under the reader** (the final review's C-M4) — by another window, or a
   * synced device. The page used to stand on in a drawer that no longer existed: an empty wall, a
   * breadcrumb naming nothing, and Escape the only way out. Once the folder list has answered
   * without the level, the page opens its nearest surviving ancestor — the root if none survives.
   * Standing in `Backordered`, inside `Ordered`; the deletion arrives as a re-read of the list.
   */
  describe("a level deleted elsewhere", () => {
    async function standInBackordered() {
      let census = FOLDERS;
      wishlistFolderList.mockImplementation(async () => census);
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: BACKORDERED.id } });
      const { client } = wrap(<WishlistPage />);
      await waitFor(() => expect(levelAsked()).toBe(BACKORDERED.id));
      expect(within(crumbs()).getByText("Backordered")).toHaveAttribute("aria-current", "page");
      /** The folder list re-read without the deleted drawers — and, in the same moment, whatever
       *  else `alongside` does (a hand-off arriving from another page). */
      return async (after: WishlistFolder[], alongside?: () => void) => {
        census = after;
        await act(async () => {
          alongside?.();
          await client.invalidateQueries({ queryKey: ["wishlist", "folders"] });
        });
      };
    }

    it("opens the nearest surviving ancestor once the folder list answers without the level", async () => {
      const deleteElsewhere = await standInBackordered();

      await deleteElsewhere([ORDERED, SOMEDAY]);

      await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
      expect(within(crumbs()).getByText("Ordered")).toHaveAttribute("aria-current", "page");
    });

    it("opens the root when no ancestor survives", async () => {
      const deleteElsewhere = await standInBackordered();

      // `Ordered` deleted, taking `Backordered` with it.
      await deleteElsewhere([SOMEDAY]);

      await waitFor(() => expect(levelAsked()).toBeNull());
      expect(await findHeading(SOMEDAY.id)).toBeInTheDocument();
    });

    /**
     * **A hand-off waiting for this page outranks the walk** — the collection's ordering: the
     * folder another page named is where the reader asked to go, so it wins over the nearest
     * ancestor of a level that happens to vanish at the same moment, and the hand-off is spent.
     */
    it("lets a waiting hand-off win over the walk out of a deleted level", async () => {
      const deleteElsewhere = await standInBackordered();

      await deleteElsewhere([ORDERED, SOMEDAY], () =>
        useAppStore.setState({ pendingFolder: { scope: "wishlist", id: SOMEDAY.id } }),
      );

      await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));
      await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
      expect(within(crumbs()).getByText("Someday")).toHaveAttribute("aria-current", "page");
      // And it stays there: the walk does not act on the level the hand-off opened.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(levelAsked()).toBe(SOMEDAY.id);
    });
  });

  /**
   * **The path row's answer is the toolbar's Add folder, whatever the folders are called** (the
   * final re-review's N4). The caret's fallback (a folder leaving the top of the level) finds the
   * path row's button by its word, and the box it searched held the breadcrumb too — so standing
   * under a folder a reader had named "Add folder", the trail's segment for it was found first.
   */
  describe("a folder named Add folder", () => {
    const NAMED: WishlistFolder = {
      id: 20,
      parentId: null,
      name: "Add folder",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };
    const INNER: WishlistFolder = {
      id: 21,
      parentId: NAMED.id,
      name: "Inner",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };
    const DEEP: WishlistFolder = {
      id: 22,
      parentId: INNER.id,
      name: "Deep",
      sortOrder: 0,
      managedDeckId: null,
      managedTokens: false,
    };

    it("hands the caret to the toolbar's Add folder, never to a trail segment of that name", async () => {
      wishlistFolderList.mockResolvedValue([NAMED, INNER, DEEP]);
      wishlistFolderDelete.mockImplementation(async () => {
        wishlistFolderList.mockResolvedValue([NAMED, INNER]);
      });
      useAppStore.setState({ pendingFolder: { scope: "wishlist", id: INNER.id } });
      const user = userEvent.setup();
      wrap(<WishlistPage />);
      await waitFor(() => expect(levelAsked()).toBe(INNER.id));
      await findHeading(DEEP.id);
      const segment = within(crumbs()).getByRole("button", { name: "Add folder" });
      const toolbar = within(screen.getByRole("group", { name: "Shelves" })).getByRole("button", {
        name: "Add folder",
      });

      // `Deep` stands at the top of the level, so its delete hands the caret to the path row.
      await user.click(menuOf(DEEP.id));
      await user.click(
        within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete…/ }),
      );
      await user.click(await screen.findByRole("button", { name: "Delete folder" }));

      await waitFor(() => expect(wishlistFolderDelete).toHaveBeenCalledWith(DEEP.id));
      await waitFor(() => expect(toolbar).toHaveFocus());
      expect(segment).not.toHaveFocus();
    });
  });
});

/**
 * **Rearranging the cabinet itself** — a drawer dropped on another drawer's middle goes inside it,
 * and one dropped near an edge lands beside it.
 *
 * The write is always `wishlist_folder_reorder(parentId, ids)` and `ids` is the **whole** level, in
 * order: `sort_order` is written from position and `parent_id` from the argument, in one
 * transaction, so one gesture both re-parents and places. Sending only the folder that moved is
 * the mistake the command's name invites, which is why every assertion below names the whole list.
 *
 * **The three landings are driven by stating the box.** jsdom has no layout engine, so every real
 * `getBoundingClientRect` is four zeroes and `folderEdge` would answer `inside` for every drop — a
 * test that hoped for a rect would pass over any threshold at all. {@link stand} states the
 * heading's rect, and the pointer is then aimed at a fraction down it — `AT_TOP`, `AT_MIDDLE`,
 * `AT_BOTTOM` — which is the gesture rather than a coordinate posted to a target.
 *
 * **Table view, the file's default, and the table does not fold on a folder drag** (the page says
 * why), so every rect set before `holdHeading` stays on the element it was set on. The fold is
 * pinned by the one grid case at the end.
 */
describe("rearranging the wishlist's cabinet", () => {
  beforeEach(() => {
    wishlistList.mockReset().mockImplementation(async () => page([BOLT, ANY]));
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
  });

  /** Both root drawers on screen, which every test here starts from. `Ordered` holds
   *  `Backordered`; `Someday` is empty and sorts after it. */
  const wall = async () => {
    await findHeading(ORDERED.id);
    await findHeading(SOMEDAY.id);
  };

  it("files a folder inside the heading it is dropped on the middle of", async () => {
    wrap(<WishlistPage />);
    await wall();
    stand(ORDERED.id);

    const held = await holdHeading(SOMEDAY.id);
    await held.over(heading(ORDERED.id), AT_MIDDLE);
    await held.drop();

    // `Ordered`'s own child, then the folder that just arrived: `inside` says which drawer and
    // nothing about where in it, so there is no second position in the gesture to have meant.
    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenCalledWith(ORDERED.id, [BACKORDERED.id, SOMEDAY.id]),
    );
  });

  it("places a folder before the heading it is dropped on the top of", async () => {
    wrap(<WishlistPage />);
    await wall();
    stand(ORDERED.id);

    const held = await holdHeading(SOMEDAY.id);
    await held.over(heading(ORDERED.id), AT_TOP);
    await held.drop();

    // The root level, re-ordered — `null` is the destination parent and a real place rather than
    // an omission.
    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenCalledWith(null, [SOMEDAY.id, ORDERED.id]),
    );
  });

  /**
   * **A drop that would reproduce the order already on screen writes nothing at all** — not a
   * reorder of the level as it stands, which would be a transaction to arrive at the list already
   * drawn, bumping `updated_at` and re-reading the cabinet for it.
   *
   * `Someday` already follows `Ordered`, so "after Ordered" is where it is. The mark goes with the
   * write: `edge` is `null` over a landing the page refuses, so no line is drawn either.
   */
  it("draws no line and writes nothing for a drop that would change nothing", async () => {
    wrap(<WishlistPage />);
    await wall();
    stand(ORDERED.id);

    const held = await holdHeading(SOMEDAY.id);
    await held.over(heading(ORDERED.id), AT_BOTTOM);
    expect(heading(ORDERED.id).querySelector("[data-folder-drop-line]")).toBeNull();
    await held.drop();

    expect(wishlistFolderReorder).not.toHaveBeenCalled();
  });

  /** A folder dropped on itself is the gesture a reader makes most often by accident — the pointer
   *  is *on* the folder being dragged for the first few pixels of every drag. */
  it("refuses a folder dropped on itself, at every landing", async () => {
    wrap(<WishlistPage />);
    await wall();

    for (const at of [AT_TOP, AT_MIDDLE, AT_BOTTOM]) {
      heading(SOMEDAY.id).getBoundingClientRect = () => SOURCE_BOX;
      const held = await holdHeading(SOMEDAY.id);
      await held.over(heading(SOMEDAY.id), at);
      await held.drop();
    }
    expect(wishlistFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * **The cycle fence, and on shelves it is a gesture a reader can make**: `Backordered` is on the
   * root's wall under `Ordered`, so `Ordered` dragged onto it is one move. Every landing is a cycle
   * — inside its own child, or before/after it, which is inside `Ordered` itself — and no mark is
   * drawn for a write that will be refused.
   *
   * `wishlist_folders.parent_id` is `ON DELETE CASCADE` on itself, so a cycle is a graph SQLite's
   * recursive cascade would walk forever the day the folder is deleted — and the backend refuses
   * the move in words. Asked of the *destination parent*, which is what covers `inside` a
   * descendant and `before` one with a single clause.
   */
  it("refuses a folder dropped onto a heading it holds, and marks nothing", async () => {
    wrap(<WishlistPage />);
    await wall();

    for (const at of [AT_TOP, AT_MIDDLE, AT_BOTTOM]) {
      stand(BACKORDERED.id);
      const held = await holdHeading(ORDERED.id);
      expect(wearsDropMark(heading(BACKORDERED.id))).toBe(false);
      await held.over(heading(BACKORDERED.id), at);
      expect(wearsDropMark(heading(BACKORDERED.id))).toBe(false);
      await held.drop();
    }
    expect(wishlistFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * **The wish drag still files a wish**, which is the thing the folder gesture could have taken
   * away without a single folder test noticing. The two targets sit on one element the pointer is
   * over, and only `readWishDrag` refusing a folder and `readFolderDrag` refusing a wish keeps the
   * drop on the right one.
   */
  it("still files a wish dropped on a heading", async () => {
    const { container } = wrap(<WishlistPage />);
    await wall();
    await screen.findByText("Lightning Bolt");

    await wishOnto(cardSources(container)[0], heading(ORDERED.id));

    expect(wishlistSetFolder).toHaveBeenCalledWith(BOLT.id, ORDERED.id);
    expect(wishlistFolderReorder).not.toHaveBeenCalled();
  });

  /**
   * Replaces "moves a drawer up a level when it is dropped on the up tile" (spec §6's last row).
   *
   * `inside` is what a segment means, so the arriving folder goes **last** in the level it names —
   * `Ordered` and `Someday` in the order the tree already draws them, then `Backordered`. There is
   * no second position in the gesture for the reader to have meant.
   */
  it("moves a folder up a level when it is dropped on a breadcrumb segment", async () => {
    wrap(<WishlistPage />);
    await wall();
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await findHeading(BACKORDERED.id);
    const root = within(
      screen.getByRole("navigation", { name: "Wishlist folders" }),
    ).getByRole("button", { name: "Wishlist" });
    root.getBoundingClientRect = () => CARD_BOX;

    const held = await holdHeading(BACKORDERED.id);
    await held.over(root, AT_MIDDLE);
    await held.drop();

    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenCalledWith(null, [
        ORDERED.id,
        SOMEDAY.id,
        BACKORDERED.id,
      ]),
    );
  });

  /**
   * **Every part of the segment is the same landing**, which is what makes it a target a reader can
   * aim at while holding something: a heading offers its edges to a reorder, and a segment has no
   * order to point into. A drop near its edge writes exactly what a drop in the middle writes.
   */
  it("takes a folder anywhere on the segment, not only in its middle", async () => {
    wrap(<WishlistPage />);
    await wall();
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await findHeading(BACKORDERED.id);
    const root = within(
      screen.getByRole("navigation", { name: "Wishlist folders" }),
    ).getByRole("button", { name: "Wishlist" });
    root.getBoundingClientRect = () => CARD_BOX;

    const held = await holdHeading(BACKORDERED.id);
    await held.over(root, AT_BOTTOM);
    await held.drop();

    await waitFor(() =>
      expect(wishlistFolderReorder).toHaveBeenCalledWith(null, [
        ORDERED.id,
        SOMEDAY.id,
        BACKORDERED.id,
      ]),
    );
  });

  /**
   * **Spec §3.9 on the wall**: for the length of a folder drag every shelf folds to its heading —
   * the nested one included — and nothing is written. `held.started` asked *during* the fold is the
   * fence on A3: a heading row keyed by position remounts as the wall folds, its `Draggable` is
   * destroyed with it, and the drag ends itself.
   *
   * **`Backordered` is what is picked up** — the nested heading, under a parent that folds with it,
   * which is the harder of the two to keep a `Draggable` for. It is also what is on screen: the
   * grid is virtualised to jsdom's 600px, and `Someday`, below two tiles and `Backordered`'s empty
   * box, is not drawn until the wall folds — which is the fold's whole point, and is asserted.
   */
  it("folds every shelf to its heading while a folder is dragged, and unfolds when it ends", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);
    await findHeading(BACKORDERED.id);
    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();

    const held = await holdHeading(BACKORDERED.id);

    await waitFor(() => expect(screen.queryByAltText("Lightning Bolt")).toBeNull());
    expect(held.started).toBe(true);
    expect(heading(BACKORDERED.id)).toBeInTheDocument();
    // The whole tree is a column of targets now, the heading below the fold included.
    expect(await findHeading(SOMEDAY.id)).toBeInTheDocument();
    expect(chevronOf(ORDERED.id, "Ordered")).toHaveAttribute("aria-expanded", "false");
    expect(setShelfFolds).not.toHaveBeenCalled();

    await held.cancel();

    expect(await screen.findByAltText("Lightning Bolt")).toBeInTheDocument();
    expect(chevronOf(ORDERED.id, "Ordered")).toHaveAttribute("aria-expanded", "true");
  });
});

/**
 * **The price sweep** — issue #352's one press, and the preview that stands between it and a
 * shopping list somebody would have to audit card by card.
 *
 * What is checked here is the *wiring*: that nothing is fetched until the reader asks, that the
 * sweep is scoped by the same query the list is drawn from, and that the press sends exactly the
 * rows left ticked. Everything about how the preview reads — the em dash, the tri-state, the
 * outcome's wording — belongs to `OptimizeWishlistDialog.test.tsx`, which drives the dialog with
 * no page and no query client under it.
 */
describe("the price sweep", () => {
  /** One move, at the two prices the assertions below read. */
  const MOVE: WishOptimizeMove = {
    wishId: 7,
    name: "Lightning Bolt",
    quantity: 2,
    preferredFinish: null,
    folderId: null,
    from: { cardId: "c1", setCode: "lea", collectorNumber: "161", lang: "en", price: 5 },
    to: { cardId: "c2", setCode: "2x2", collectorNumber: "117", lang: "en", price: 2 },
    savedPerCopy: 3,
    saved: 6,
  };
  const SECOND: WishOptimizeMove = {
    ...MOVE,
    wishId: 8,
    name: "Ancestral Recall",
    quantity: 1,
    from: { cardId: "c3", setCode: "lea", collectorNumber: "48", lang: "en", price: 9 },
    to: { cardId: "c4", setCode: "vma", collectorNumber: "1", lang: "en", price: 4 },
    savedPerCopy: 5,
    saved: 5,
  };

  const openSweep = async () => {
    await screen.findByText("Lightning Bolt");
    await userEvent.click(screen.getByRole("button", { name: "Optimise wishlist prices" }));
    return screen.findByRole("dialog");
  };

  it("fetches nothing until the button is pressed", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    // The dialog is mounted unconditionally so its close can fade, and the query behind it is
    // gated on the flag rather than on the mount — which is the whole difference between a read
    // nobody asked for and one they did.
    expect(wishlistOptimizePlan).not.toHaveBeenCalled();

    await openSweep();
    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalledTimes(1));
  });

  it("takes the sweep over the same query the list is drawn from", async () => {
    wrap(<WishlistPage />);
    await openSweep();

    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalled());
    const asked = wishlistOptimizePlan.mock.calls[0][0] as WishlistQuery;
    // The marketplace decides every figure in the answer, so it travels with the question.
    expect(asked.marketplace).toBe(lastQuery().marketplace);
    // `limit`/`offset` are ignored by the command — the plan covers the whole query rather than
    // the page on screen, which is what makes its `considered` the header's own `Wishes` figure.
    expect(asked).toMatchObject({ limit: 0, offset: 0 });
    // The sweep covers the whole wall — every shelf at and below the level, shut ones included —
    // which is what makes its `considered` the header's own `Wishes` figure.
    expect(asked.shelves).toEqual([0]);
  });

  it("draws the moves and sends only the rows left ticked", async () => {
    wishlistOptimizePlan.mockResolvedValue({
      moves: [MOVE, SECOND],
      considered: 2,
      alreadyCheapest: 0,
      skipped: 0,
    });
    wrap(<WishlistPage />);
    const dialog = await openSweep();

    const second = await within(dialog).findByRole("checkbox", {
      name: /^Switch Ancestral Recall/,
    });
    expect(within(dialog).getByText("LEA · 161 · EN")).toBeInTheDocument();
    expect(within(dialog).getByText("2X2 · 117 · EN")).toBeInTheDocument();

    await userEvent.click(second);
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch 1 wish" }));

    await waitFor(() =>
      expect(wishlistOptimizeApply).toHaveBeenCalledWith([
        { wishId: 7, fromCardId: "c1", toCardId: "c2" },
      ]),
    );
  });

  it("re-reads the list and the search once the sweep lands", async () => {
    wishlistOptimizePlan.mockResolvedValue({
      moves: [MOVE],
      considered: 1,
      alreadyCheapest: 0,
      skipped: 0,
    });
    wishlistOptimizeApply.mockResolvedValue({ results: [{ wishId: 7, status: "changed" }] });
    const { client } = wrap(<WishlistPage />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await openSweep();

    await userEvent.click(await within(dialog).findByRole("button", { name: "Switch 1 wish" }));

    // A repointed wish changes its printing, its price and the folder subtotal above it — none of
    // it arithmetic this page could redo — and it moves the heart on every search tile of the
    // card. `settleWhole`'s two roots, made in bulk.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
  });

  it("stays open afterwards and says what it did", async () => {
    wishlistOptimizePlan.mockResolvedValue({
      moves: [MOVE],
      considered: 1,
      alreadyCheapest: 0,
      skipped: 0,
    });
    wishlistOptimizeApply.mockResolvedValue({ results: [{ wishId: 7, status: "merged" }] });
    wrap(<WishlistPage />);
    const dialog = await openSweep();

    await userEvent.click(await within(dialog).findByRole("button", { name: "Switch 1 wish" }));

    // The page underneath has no place for a transient sentence, and the reader has just asked a
    // question they are owed an answer to. One way out, and the preview's own button gone.
    expect(await within(dialog).findByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Switch/ })).not.toBeInTheDocument();

    // Scoped to the body: the same sentence is in the footer's permanently mounted `sr-only`
    // live region, which is the only arrangement that announces anything.
    const body = dialog.querySelector("footer")?.previousElementSibling as HTMLElement;
    expect(
      within(body).getByText("Switched 1 wish to the cheapest printing, saving $6.00."),
    ).toBeInTheDocument();
    expect(
      within(body).getByText(/folded into a wish you already had in the same folder/),
    ).toBeInTheDocument();
  });

  /**
   * **The dialog's own state resets on close; the mutation's does not**, and the body draws the
   * outcome *instead of* the preview whenever there is one — so a reader who optimised once and
   * pressed the button again would be handed last time's receipt and no list at all.
   */
  it("opens on a fresh preview rather than on the last sweep's receipt", async () => {
    wishlistOptimizePlan.mockResolvedValue({
      moves: [MOVE],
      considered: 1,
      alreadyCheapest: 0,
      skipped: 0,
    });
    wishlistOptimizeApply.mockResolvedValue({ results: [{ wishId: 7, status: "changed" }] });
    wrap(<WishlistPage />);
    const dialog = await openSweep();

    await userEvent.click(await within(dialog).findByRole("button", { name: "Switch 1 wish" }));
    await within(dialog).findByRole("button", { name: "Done" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    // Straight to the button rather than through `openSweep`: a closing panel is still in the
    // tree for the length of its fade, so a text query would match the row twice.
    await userEvent.click(screen.getByRole("button", { name: "Optimise wishlist prices" }));
    const reopened = await screen.findByRole("dialog");
    expect(
      await within(reopened).findByRole("button", { name: "Switch 1 wish" }),
    ).toBeInTheDocument();
    expect(within(reopened).queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });
});

/**
 * The docked card search, and the one thing it exists for: **a card the reader wants gets onto the
 * list from the page that shows the list.**
 *
 * This page's own empty state used to send them away in as many words — *"Add cards from search
 * with the + on any row or tile."* — so what is asserted here is the destination rather than the
 * search: where a press files, where a drop files, and that the two rows of filters on screen are
 * separately addressable.
 *
 * `WishlistSearchPanel.test.tsx` is where the column is the subject; this block is where the
 * **page** is, which is why every case here reads a folder id off the wire.
 */
describe("the search column", () => {
  /** The panel's `<section>`, by the name only this one answers to. */
  const panel = () => screen.getByRole("region", { name: "Add cards to your wishlist" });

  /** The `+` on the search wall's one tile, whose name states the destination it would file into. */
  const plus = (destination: string) =>
    screen.findByRole("button", { name: `Add Lightning Bolt (LEA 161) to ${destination}` });

  /** Press the `+` and then the popup's own Add — the two-step every quick add is. */
  const add = async (destination: string) => {
    await userEvent.click(await plus(destination));
    await userEvent.click(await screen.findByRole("button", { name: "Add to wishlist" }));
  };

  beforeEach(() => {
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
  });

  /**
   * **Railed is still drawn**, which is what makes this a statement about the page rather than
   * about the disclosure: the `<section>` and its chevron are the same three nodes in all three
   * states, and only the body mounts on the press.
   */
  it("draws a card search beside the list", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    const column = panel();
    expect(within(column).getByRole("button", { name: "Expand card search" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Nothing was searched, because nothing was opened.
    expect(searchCards).not.toHaveBeenCalled();

    // And the collection's panel is not this one — two sidebars answering to one name is one of
    // them being found by accident.
    expect(
      screen.queryByRole("region", { name: "Add cards to your collection" }),
    ).not.toBeInTheDocument();
  });

  /**
   * The two `FilterBar`s this page mounts together, told apart by the one thing that differs: the
   * box's own name. `FilterLabels.idStem` is the other half — two mounted rows sharing an `id`
   * would make the second row's `<label htmlFor>` name the first row's field — and it is asserted
   * here through the labels resolving at all, since a duplicate `id` is what breaks that.
   */
  it("gives the two filter rows different names", async () => {
    wrap(<WishlistPage />, { searchOpen: true });
    await screen.findByText("Lightning Bolt");

    expect(screen.getByLabelText(/search your wishlist/i)).toBeInTheDocument();
    expect(within(panel()).getByLabelText("Search cards")).toBeInTheDocument();
    // Neither name reaches the other row.
    expect(within(panel()).queryByLabelText(/search your wishlist/i)).toBeNull();
  });

  /** Nothing is open, so the destination is the root — and `null` goes on the wire as itself. */
  it("adds at the root when no folder is open", async () => {
    wrap(<WishlistPage />, { searchOpen: true });
    await screen.findByText("Lightning Bolt");

    await add("Wishlist");

    expect(wishlistAdd).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "c1", folderId: null }),
    );
  });

  /** And the whole point of the column: the drawer on screen is where a press files. */
  it("adds from the search into the folder on screen", async () => {
    wrap(<WishlistPage />, { searchOpen: true });
    await findHeading(ORDERED.id);
    await userEvent.click(titleOf(ORDERED.id, "Ordered"));
    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));

    await add("Ordered");

    expect(wishlistAdd).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "c1", folderId: 1 }),
    );
  });

  /**
   * **A wish for the printing the tile is of, not for the card.** `oracleId` is what an "any
   * printing" wish is keyed on, and that is a choice the `+` popup offers explicitly — so a press
   * that never made it must put the `cardId` on the wire and nothing else.
   */
  it("wishes for the printing the tile is of", async () => {
    wrap(<WishlistPage />, { searchOpen: true });
    await screen.findByText("Lightning Bolt");

    await add("Wishlist");

    const sent = wishlistAdd.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.cardId).toBe("c1");
    expect(sent).not.toHaveProperty("oracleId");
    // The printing's first available finish, carried rather than guessed — a wish for the foil is
    // not filled by the nonfoil.
    expect(sent.preferredFinish).toBe("nonfoil");
  });

  /**
   * The drag half, and the assertion that separates it from every other drop on this page: a card
   * nobody has wished for has no row to re-file, so the write is `wishlist_add` and **never**
   * `wishlist_set_folder`.
   */
  it("files a dropped card into the folder it was dropped on", async () => {
    wrap(<WishlistPage />, { searchOpen: true });
    await screen.findByText("Lightning Bolt");
    // The panel's tile, which is a `[data-dnd-source]` like the page's own rows — told apart by
    // the column it is in rather than by its shape.
    const tile = await waitFor(() => {
      const found = panel().querySelector<HTMLElement>(`[${DND_SOURCE_ATTR}]`);
      if (!found) throw new Error("no search tile");
      return found;
    });

    await findHeading(ORDERED.id);
    await wishOnto(tile, heading(ORDERED.id));

    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "c1", quantity: 1, preferredFinish: "nonfoil", folderId: 1 }),
      ),
    );
    expect(wishlistSetFolder).not.toHaveBeenCalled();
  });
});

/**
 * **A deck's managed wishlist** (user schema v48, issue #512): a folder a `Theory + Actual` deck
 * keeps, holding what its Compare dialog lists and rewritten by Rust after every deck write. The
 * backend refuses every hand write that touches one, so what this page owes it is the issue's two
 * sentences — *a separate section with a special icon*, and *no editing by hand* — plus the rule
 * that it is never offered as a destination.
 */
describe("a deck's managed wishlist", () => {
  const MANAGED: WishlistFolder = {
    id: 9,
    parentId: null,
    name: "Rhystic Testbed",
    sortOrder: 2,
    managedDeckId: 4,
    managedTokens: false,
  };
  /** What the deck's plan is short of — filed in the managed folder by the deck, not the reader. */
  const COPTER: WishRow = {
    ...BOLT,
    id: 30,
    folderId: MANAGED.id,
    name: "Smuggler's Copter",
    cardId: "c-copter",
    artCardId: "c-copter",
    setCode: "kld",
    collectorNumber: "235",
    preferredFinish: null,
    quantity: 2,
    unitPrice: 3,
  };
  beforeEach(() => {
    wishlistList.mockReset().mockImplementation(listByShelves([BOLT, COPTER]));
    wishlistFolderList.mockResolvedValue([...FOLDERS, MANAGED]);
    wishlistFolderSummary.mockResolvedValue([
      ...SUMMARY,
      { folderId: MANAGED.id, wishes: 1, copies: 2, cost: 6, unpriced: 0 },
    ]);
    useAppStore.setState({ activeView: "wishlist", openDeckId: null });
  });

  /** Open the deck's list by its heading's title, and wait for its one wish to be drawn — the wall
   *  names a tile by its art's `alt`, the table by a cell's text. */
  const openManaged = async () => {
    await findHeading(MANAGED.id);
    await userEvent.click(titleOf(MANAGED.id, "Rhystic Testbed"));
    await waitFor(() => expect(levelAsked()).toBe(MANAGED.id));
    await (useAppStore.getState().wishlistView === "grid"
      ? screen.findByAltText("Smuggler's Copter")
      : screen.findByText("Smuggler's Copter"));
  };

  /**
   * The section is a group label on the wall, and the managed folder is a shelf under it, **shut
   * by default** (spec §3.4: a derived list, not a binder). Its title opens it, and nothing on its
   * heading writes: no Add folder, no Rename, no `⋯`, and it is not picked up.
   */
  it("draws the managed folder as a shelf under Managed by decks, shut, with the deck glyph and nothing that writes", async () => {
    wrap(<WishlistPage />);
    const shelf = await findHeading(MANAGED.id);

    const label = screen.getByText("Managed by decks");
    expect(follows(heading(SOMEDAY.id), label)).toBe(true);
    expect(follows(label, shelf)).toBe(true);
    expect(chevronOf(MANAGED.id, "Rhystic Testbed")).toHaveAccessibleName("Expand Rhystic Testbed");
    expect(chevronOf(MANAGED.id, "Rhystic Testbed")).toHaveAttribute("aria-expanded", "false");
    // `Layers` — the collection's deck-group glyph, one fact wearing one picture.
    expect(shelf.querySelector("svg.lucide-layers")).not.toBeNull();
    // Nothing on it writes, and it is not picked up.
    expect(within(shelf).queryByRole("button", { name: /^Add folder/ })).toBeNull();
    expect(within(shelf).queryByRole("button", { name: /^Rename/ })).toBeNull();
    expect(
      within(shelf)
        .queryAllByRole("button")
        .some((b) => b.getAttribute("aria-haspopup") === "menu"),
    ).toBe(false);
    // Not a drag source: a press on its row starts nothing (spec §3.9).
    const held = await holdHeading(MANAGED.id);
    expect(held.started).toBe(false);
    await held.cancel();
    // Shut, so none of its wishes is fetched — and the reader's own folders keep their controls.
    expect(lastQuery().shelves).not.toContain(MANAGED.id);
    expect(screen.queryByText("Smuggler's Copter")).toBeNull();
    expect(addFolderOn(ORDERED.id)).toBeInTheDocument();
  });

  it("draws a managed wish with no stepper, no pencil, no removal and no drag", async () => {
    wrap(<WishlistPage />);
    await openManaged();

    expect(screen.getByText(/Follows the deck “Rhystic Testbed”/)).toBeInTheDocument();
    // Nothing can be made inside it — the path row's Add folder is absent, not greyed.
    expect(screen.queryByRole("button", { name: /^Add folder/ })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /Copies wanted of Smuggler/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit Smuggler's Copter/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove Smuggler's Copter/ })).toBeNull();
    const row = screen.getByText("Smuggler's Copter").closest('[role="row"]') as HTMLElement;
    expect(row).not.toHaveAttribute(DND_SOURCE_ATTR);
    // The count it wants is still said.
    expect(within(row).getByText("2")).toBeInTheDocument();
    // And the way up is still there — reading the folder is not a trap.
    expect(
      within(screen.getByRole("navigation", { name: "Wishlist folders" })).getByRole("button", {
        name: "Wishlist",
      }),
    ).toBeInTheDocument();
  });

  it("draws the managed wish's tile with no controls on the wall either", async () => {
    useAppStore.setState({ wishlistView: "grid" });
    wrap(<WishlistPage />);
    await openManaged();

    expect(screen.queryByRole("spinbutton", { name: /Copies wanted of Smuggler/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit Smuggler's Copter/ })).toBeNull();
    expect(cardSources(document.body)).toEqual([]);
  });

  /** Replaces "…when flattened": the managed shelf opened in place, beside the reader's wishes. */
  it("keeps the reader's own wishes editable beside a managed shelf opened in place", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(chevronOf(MANAGED.id, "Rhystic Testbed"));

    expect(setShelfFolds).toHaveBeenCalledWith("wishlist", { [MANAGED.id]: false });
    await screen.findByText("Smuggler's Copter");
    expect(
      screen.getByRole("spinbutton", { name: /Copies wanted of Lightning Bolt/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /Copies wanted of Smuggler/ })).toBeNull();
  });

  it("never offers the managed folder as somewhere to move a wish", async () => {
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Lightning Bolt (LEA 161, Foil) on your wishlist" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Move to folder: Lightning Bolt (LEA 161, Foil)" }),
    );
    const destinations = await screen.findByRole("group", {
      name: "Move Lightning Bolt (LEA 161, Foil) to a folder",
    });
    expect(within(destinations).getByRole("button", { name: /Ordered/ })).toBeInTheDocument();
    expect(within(destinations).queryByRole("button", { name: /Rhystic Testbed/ })).toBeNull();
  });

  it("opens the deck the folder follows", async () => {
    wrap(<WishlistPage />);
    await openManaged();

    await userEvent.click(screen.getByRole("button", { name: "Open deck" }));

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * **Standing inside a deck's Tokens subfolder, the note names the deck and not the folder**
   * (user schema v55, the final review's I1). The child carries the deck's id, so it is a managed
   * folder the reader can stand in — and it is named `Tokens` on every deck, so a note reading its
   * own name said *Follows the deck "Tokens"*. The deck's name is its parent's: Rust names the deck's
   * own folder after the deck and renames it with it.
   */
  it("names the deck, never the folder, inside a deck's Tokens subfolder", async () => {
    const TOKENS: WishlistFolder = {
      id: 10,
      parentId: MANAGED.id,
      name: "Tokens",
      sortOrder: 0,
      managedDeckId: MANAGED.managedDeckId,
      managedTokens: true,
    };
    const TREASURE: WishRow = {
      ...COPTER,
      id: 31,
      folderId: TOKENS.id,
      name: "Treasure",
      cardId: "c-treasure",
      artCardId: "c-treasure",
      setCode: "tlci",
      collectorNumber: "21",
      quantity: 3,
    };
    wishlistList.mockReset().mockImplementation(listByShelves([BOLT, COPTER, TREASURE]));
    wishlistFolderList.mockResolvedValue([...FOLDERS, MANAGED, TOKENS]);
    wishlistFolderSummary.mockResolvedValue([
      ...SUMMARY,
      { folderId: MANAGED.id, wishes: 1, copies: 2, cost: 6, unpriced: 0 },
      { folderId: TOKENS.id, wishes: 1, copies: 3, cost: 9, unpriced: 0 },
    ]);
    wrap(<WishlistPage />);
    await openManaged();

    await findHeading(TOKENS.id);
    await userEvent.click(titleOf(TOKENS.id, "Tokens"));
    await waitFor(() => expect(levelAsked()).toBe(TOKENS.id));
    await screen.findByText("Treasure");

    expect(screen.getByText(/Follows the deck “Rhystic Testbed”/)).toBeInTheDocument();
    expect(screen.queryByText(/Follows the deck “Tokens”/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open deck" }));
    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * **An empty managed folder says the sentence for the Compare view its deck follows — once, and
   * the same in both views** (live pass §13). It said `missing`'s sentence under every folder
   * whatever it followed — `Nothing missing — …` under a folder following `all` — and only in the
   * table, the wall drawing nothing. Said once rather than in a place: until the wall draws a box
   * for a managed shelf it is the status line's, and the box's after (`layoutShelves` decides for
   * both views), so the case pins the words and the count, never which element holds them. And it
   * is words, never the dashed drawer a reader's folder is: the folder takes no hand write.
   */
  it.each(["table", "grid"] as const)(
    "says an empty managed folder's own view's sentence, once, in the %s",
    async (view) => {
      wishlistList.mockImplementation(listByShelves([BOLT]));
      wishlistFolderSummary.mockResolvedValue(SUMMARY);
      deckList.mockResolvedValue([{ id: 4, managedWishlist: "all" } as DeckRow]);
      useAppStore.setState({
        wishlistView: view,
        pendingFolder: { scope: "wishlist", id: MANAGED.id },
      });
      wrap(<WishlistPage />);
      await waitFor(() => expect(levelAsked()).toBe(MANAGED.id));

      await waitFor(() => expect(screen.getAllByText(MANAGED_EMPTY.all)).toHaveLength(1));
      expect(screen.queryByText(MANAGED_EMPTY.missing)).toBeNull();
      expect(screen.queryByText(MANAGED_EMPTY.other)).toBeNull();
      expect(screen.queryByText(MANAGED_EMPTY_UNKNOWN)).toBeNull();
      expect(emptyBoxes()).toEqual([]);
      expect(deckList).toHaveBeenCalled();
    },
  );

  /**
   * **The live-pass case itself: an open, empty managed folder at the root** (Azula's, following
   * `all`). Standing inside it is the case above; at the root the folder is one shelf among the
   * reader's own, opened in place, and its empty box is `layoutShelves`' like every other shelf's —
   * the wall's and the table's alike. It says its view's sentence once, in its own box under its own
   * heading, and it is words rather than the dashed drawer the reader's empty folders draw beside it.
   */
  it.each(["table", "grid"] as const)(
    "says an open, empty managed folder's sentence at the root, once, under its heading, in the %s",
    async (view) => {
      wishlistList.mockImplementation(listByShelves([]));
      wishlistFolderSummary.mockResolvedValue(SUMMARY);
      deckList.mockResolvedValue([{ id: 4, managedWishlist: "all" } as DeckRow]);
      useAppStore.setState({ wishlistView: view });
      wrap(<WishlistPage />, { folds: { [String(MANAGED.id)]: false } });
      await findHeading(MANAGED.id);
      expect(chevronOf(MANAGED.id, "Rhystic Testbed")).toHaveAttribute("aria-expanded", "true");

      await waitFor(() => expect(screen.getAllByText(MANAGED_EMPTY.all)).toHaveLength(1));
      const boxes = document.querySelectorAll<HTMLElement>("[data-shelf-managed-empty]");
      expect(boxes).toHaveLength(1);
      expect(boxes[0]).toHaveTextContent(MANAGED_EMPTY.all);
      expect(follows(heading(MANAGED.id), boxes[0])).toBe(true);
      expect(levelAsked()).toBeNull();
      // The reader's two empty folders draw the dashed drawer; the deck's draws none of its own.
      expect(emptyBoxes().filter((box) => follows(heading(MANAGED.id), box))).toEqual([]);
      expect(screen.queryByText(MANAGED_EMPTY_UNKNOWN)).toBeNull();
    },
  );

  /** A wishlist no deck keeps a list in never reads the decks at all. */
  it("reads the deck list only where a deck keeps a folder", async () => {
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    expect(deckList).not.toHaveBeenCalled();
  });
});

/**
 * **The flagged wishes another page asked this one to open on** — `store.ts`'s
 * `pendingReviewFilter`, the To review widget's `Wishes` row. `CollectionPage.test.tsx`'s block
 * of the same name is the argument; this is the other cabinet.
 */
describe("a needs-review filter another page asked for", () => {
  it("asks for the flagged wishes from its first request, and spends the hand-off", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    wrap(<WishlistPage />);

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(
      wishlistList.mock.calls.every(([q]) => (q as WishlistQuery).needsReview === true),
    ).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  it("leaves the collection's hand-off untouched", async () => {
    useAppStore.setState({ pendingReviewFilter: { scope: "collection" } });
    wrap(<WishlistPage />);

    await waitFor(() => expect(wishlistList).toHaveBeenCalled());
    expect(lastQuery().needsReview).toBeUndefined();
    expect(useAppStore.getState().pendingReviewFilter).toEqual({ scope: "collection" });
  });
});

/**
 * **A needs-review hand-off over a filed wishlist** — `CollectionPage.test.tsx`'s block of the same
 * shape on the other cabinet, ported to the shelves.
 *
 * It was *"…over a list the reader has not flattened"* (main, 2026-09-26): To review counts the
 * flagged wishes in every drawer, the page used to stand at a root that showed only the unfiled
 * ones, and `useReviewHandoff` turned on a local flat read so a reader sent by the `Wishes` row did
 * not land on an empty root. **The shelves answer that by construction** — the root's wall holds
 * every wish, each under its folder's heading — so the hand-off is the filter and the root, and
 * nothing is ever flattened. What the cases still pin is the ruling's promise read the new way:
 * the flagged wish in a drawer is on screen, from the first request, with no flat read sent.
 * The Flatten-press case went with Flatten; the others keep their intent.
 */
describe("a needs-review hand-off over a filed wishlist", () => {
  /** A flagged wish filed in `Ordered` — below the root, which is where the old root missed it. */
  const FLAGGED: WishRow = { ...FILED, needsReview: REVIEW_NOTE };

  /** `listByShelves` over the three, honouring the filter — so a flagged wall is honestly just
   *  `Rhystic Study`, and the counts mock (which reads this) agrees with it. */
  const listFlagged = async (q: WishlistQuery) => {
    const all = await listByShelves([BOLT, ANY, FLAGGED])(q);
    return page(all.items.filter((row) => q.needsReview !== true || row.needsReview !== null));
  };

  const crumbs = () => screen.getByRole("navigation", { name: "Wishlist folders" });

  beforeEach(() => {
    useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } });
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderSummary.mockResolvedValue(SUMMARY);
    wishlistList.mockImplementation(listFlagged);
  });

  it("draws the flagged wish wherever it is filed, and never reads the list flat", async () => {
    wrap(<WishlistPage />);

    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(
      wishlistList.mock.calls.every(([q]) => {
        const asked = q as WishlistQuery;
        return asked.needsReview === true && asked.flatten === undefined;
      }),
    ).toBe(true);
    // At the root, asking for the drawer the wish is filed in as well as the loose shelf.
    expect(levelAsked()).toBeNull();
    expect(lastQuery().shelves).toContain(ORDERED.id);
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /** `CollectionPage.test.tsx`'s case of the same name: `useReviewHandoff`'s `settle`, the path a
   *  hand-off takes when it lands on a page that is already mounted. */
  it("answers a hand-off that lands after the page has mounted", async () => {
    useAppStore.setState({ pendingReviewFilter: null });
    wrap(<WishlistPage />);
    await screen.findByText("Lightning Bolt");
    expect(lastQuery().needsReview).toBeUndefined();

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } }));

    await waitFor(() => expect(lastQuery().needsReview).toBe(true));
    expect(lastQuery().flatten).toBeUndefined();
    expect(levelAsked()).toBeNull();
    // The wall is the flagged wish alone now — the healthy root wishes filtered away.
    await waitFor(() => expect(within(wallOf()).queryByText("Lightning Bolt")).toBeNull());
    expect(within(wallOf()).getByText("Rhystic Study")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Remove filter — Needs review" });
    // Stated in the path row, beside the shelf toolbar — not on a line of its own under the bar
    // (2026-09-27): the chip's line and the toolbar share one row.
    expect(chip.parentElement!.parentElement).toContainElement(
      screen.getByRole("group", { name: "Shelves" }),
    );
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /**
   * **What replaced the sweep: a hand-off opens the root.** A folder's wall holds only its own
   * subtree, so a reader standing in `Someday` when the hand-off lands would see an empty flagged
   * wall under a widget that has just counted one wish. The page is put at the root instead — a
   * page freshly mounted is there already, so this is the one path where the adjustment acts.
   */
  it("brings a page standing in a folder back to the root", async () => {
    useAppStore.setState({
      pendingReviewFilter: null,
      pendingFolder: { scope: "wishlist", id: SOMEDAY.id },
    });
    wrap(<WishlistPage />);
    await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));
    expect(within(crumbs()).getByText("Someday")).toHaveAttribute("aria-current", "page");

    act(() => useAppStore.setState({ pendingReviewFilter: { scope: "wishlist" } }));

    await waitFor(() => expect(levelAsked()).toBeNull());
    expect(lastQuery().needsReview).toBe(true);
    expect(await screen.findByText("Rhystic Study")).toBeInTheDocument();
    expect(within(crumbs()).getByText("Wishlist")).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /**
   * **A folder hand-off landing in the same commit wins, and nothing loops.** Both adjustments are
   * render-phase writes to `folderId`, so without the page's precedence guard they would undo each
   * other on every pass until React gave up — before either effect could spend its hand-off.
   * `setActiveView` clears both, so no press sends the pair today; this pins the guard anyway.
   */
  it("gives way to a folder hand-off arriving with it, without a render loop", async () => {
    useAppStore.setState({ pendingReviewFilter: null });
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    act(() =>
      useAppStore.setState({
        pendingReviewFilter: { scope: "wishlist" },
        pendingFolder: { scope: "wishlist", id: SOMEDAY.id },
      }),
    );

    await waitFor(() => expect(levelAsked()).toBe(SOMEDAY.id));
    expect(lastQuery().needsReview).toBe(true);
    await waitFor(() => expect(useAppStore.getState().pendingFolder).toBeNull());
    await waitFor(() => expect(useAppStore.getState().pendingReviewFilter).toBeNull());
  });

  /**
   * **Clearing the filter leaves nothing of the hand-off behind.** It was "goes back to the root",
   * because the filter going took the sweep with it; on shelves there is no sweep to spend, and the
   * root the reader is left on is the whole wishlist again — the healthy wishes back, the flagged
   * one still on its folder's shelf.
   */
  it.each([
    ["its chip", "Remove filter — Needs review"],
    ["Reset all", /^Reset all/],
  ] as const)("is the whole wishlist again when the filter is cleared by %s", async (_how, name) => {
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await screen.findByText("Rhystic Study");

    await user.click(screen.getByRole("button", { name }));

    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
    expect(lastQuery().flatten).toBeUndefined();
    expect(levelAsked()).toBeNull();
    expect(await screen.findByText("Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("Rhystic Study")).toBeInTheDocument();
  });
});

/**
 * **The price sweep another page asked for** — `store.ts`'s `pendingOptimize`, the home page's
 * Wishlist savings widget. The widget counted what *every* pinned wish would save, so the dialog it
 * opens has to plan the same list — and must not get there by writing the reader's own switches.
 */
describe("a price sweep another page asked for", () => {
  it("opens the dialog over every wish, flattened and unfiltered, and spends the hand-off", async () => {
    useAppStore.setState({ pendingOptimize: true });
    wrap(<WishlistPage />);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalled());
    const asked = wishlistOptimizePlan.mock.calls[
      wishlistOptimizePlan.mock.calls.length - 1
    ][0] as WishlistQuery;
    // `wholeWishlistQuery` plus the paging `useWishlistOptimize` adds and the command ignores —
    // no folder, no filter, and flattened whatever the page's own switch says.
    expect(asked).toEqual({ flatten: true, marketplace: "tcgplayer", limit: 0, offset: 0 });
    // The scope sentence says so, rather than naming the root the page is standing at.
    expect(within(dialog).getByText("Every folder")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().pendingOptimize).toBe(false));
    // **A scope override and never a write**: the list behind the dialog is still the page's own
    // shelves, never read flat. (It also asserted the reader's persisted Flatten switch was left
    // off, until Flatten went with the shelves.)
    expect(lastQuery().flatten).toBeUndefined();
    expect(lastQuery().shelves).toBeDefined();
  });

  /** The override is the hand-off's alone: the page's own button plans the page's own list. */
  it("plans the page's own list again when the Optimise button is pressed afterwards", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ pendingOptimize: true });
    wrap(<WishlistPage />);
    await screen.findByRole("dialog");
    await waitFor(() => expect(useAppStore.getState().pendingOptimize).toBe(false));

    await user.click(screen.getByRole("button", { name: "Close the price check" }));
    wishlistOptimizePlan.mockClear();
    // Straight to the button: a closing panel is still in the tree for the length of its fade.
    await user.click(screen.getByRole("button", { name: "Optimise wishlist prices" }));

    await waitFor(() => expect(wishlistOptimizePlan).toHaveBeenCalled());
    const asked = wishlistOptimizePlan.mock.calls[0][0] as WishlistQuery;
    expect(asked.flatten).toBeUndefined();
    expect(asked).toMatchObject({ marketplace: "tcgplayer", limit: 0, offset: 0 });
  });
});

/**
 * **The caret after the path row's Add folder, Move to folder… and Delete…** —
 * `CollectionPage.test.tsx`'s block of the same name, on this cabinet (the final review's C-I3 /
 * W-I1, ledger 217 and C-M5). jsdom neither scrolls on a focus nor lets a focus made inside a blur
 * survive the one that caused it, so the cases read the focus calls themselves, through a spy.
 */
describe("the caret after the path row's Add folder, Move to folder… and Delete…", () => {
  /** Every `focus()` made while the spy is up, with the element it was made on. */
  const watchFocus = () => {
    const spy = vi.spyOn(HTMLElement.prototype, "focus");
    return {
      spy,
      on: (element: HTMLElement | null) =>
        spy.mock.contexts
          .map((context, at) => ({ context, options: spy.mock.calls[at][0] }))
          .filter(({ context }) => context === element)
          .map(({ options }) => options),
    };
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  };
  /** Open a heading's ⋯ and press one of its rows. */
  const fromMenu = async (user: ReturnType<typeof userEvent.setup>, id: number, row: RegExp) => {
    await user.click(menuOf(id));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: row }));
  };
  /** Pick a destination in the Move to folder… strip. */
  const moveInto = async (user: ReturnType<typeof userEvent.setup>, name: string, into: string) => {
    const strip = await screen.findByRole("group", { name: `Move ${name} into a folder` });
    await user.click(within(strip).getByRole("button", { name: new RegExp(`^${into}`) }));
  };

  /** **A click away is not a keyboard cancel, on the path row either** (C-I3): the path row's Add
   *  folder is never focused on the way, which in Blink took the click's focus and scrolled. */
  it("gives the path row's field up without taking the caret back to Add folder", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    const add = pathAddFolder();
    await user.click(add);
    await nameField();

    const focus = watchFocus();
    try {
      const box = screen.getByLabelText("Search your wishlist");
      await user.click(box);
      await settle();

      expect(within(wallOf()).queryByRole("textbox")).toBeNull();
      expect(focus.on(add)).toEqual([]);
      expect(box).toHaveFocus();
    } finally {
      focus.spy.mockRestore();
    }
  });

  /** A blur that leaves the caret nowhere hands it back to the path row's Add folder — one task
   *  later, and without scrolling. */
  it("hands the caret back to the path row's Add folder, unscrolled, when a blur leaves it nowhere", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    const add = pathAddFolder();
    await user.click(add);
    const field = await nameField();

    const focus = watchFocus();
    try {
      act(() => field.blur());

      await waitFor(() => expect(add).toHaveFocus());
      expect(focus.on(add)).toEqual([{ preventScroll: true }]);
    } finally {
      focus.spy.mockRestore();
    }
  });

  /** **A committed folder leaves the page on the folder just made** (ledger 217). */
  it("hands the caret back to the path row's Add folder without scrolling, once a folder is made", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    const add = pathAddFolder();
    await user.click(add);
    const field = await nameField();

    const focus = watchFocus();
    try {
      await user.type(field, "Someday{Enter}");

      await waitFor(() => expect(wishlistFolderCreate).toHaveBeenCalledWith(null, "Someday"));
      await waitFor(() => expect(add).toHaveFocus());
      expect(focus.on(add)).toEqual([{ preventScroll: true }]);
    } finally {
      focus.spy.mockRestore();
    }
  });

  /** **A made folder starts on its own kind's fold** (R-M2): a new folder can take a deleted one's
   *  id, and with it the fold stored under that id. The create clears it. */
  it("clears a stored fold the new folder's id inherited from a deleted one", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    const user = userEvent.setup();
    wrap(<WishlistPage />, { folds: { [String(SOMEDAY.id)]: true } });
    await findHeading(ORDERED.id);
    await user.click(pathAddFolder());
    const field = await nameField();

    await user.type(field, "Someday{Enter}");

    await waitFor(() =>
      expect(setShelfFolds).toHaveBeenCalledWith("wishlist", { [String(SOMEDAY.id)]: null }),
    );
  });

  /** And a folder whose id nothing had folded writes nothing to the folds at all. */
  it("writes no fold for a new folder whose id has none stored", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await user.click(pathAddFolder());
    const field = await nameField();

    await user.type(field, "Someday{Enter}");
    await waitFor(() => expect(wishlistFolderCreate).toHaveBeenCalled());
    await settle();

    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /** **Moved to a folder still on this wall, the caret follows the heading** (C-M5), to its `⋯`,
   *  once the folder list says it is there. */
  it("hands the caret to the moved heading's ⋯ when it lands on this wall", async () => {
    wishlistFolderList.mockResolvedValue(FOLDERS);
    wishlistFolderMove.mockImplementation(async () => {
      wishlistFolderList.mockResolvedValue([
        { ...ORDERED, parentId: SOMEDAY.id },
        BACKORDERED,
        SOMEDAY,
      ]);
      return { ...ORDERED, parentId: SOMEDAY.id };
    });
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await fromMenu(user, ORDERED.id, /^Move to folder/);
    await moveInto(user, "Ordered", "Someday");

    await waitFor(() => expect(wishlistFolderMove).toHaveBeenCalledWith(ORDERED.id, SOMEDAY.id));
    // Under `Someday` now, and the table's band that drew it at the top draws `Someday` instead.
    await waitFor(() => expect(follows(heading(SOMEDAY.id), heading(ORDERED.id))).toBe(true));
    await waitFor(() => expect(menuOf(ORDERED.id)).toHaveFocus());
  });

  /** **Moved somewhere this wall does not draw it** — into a shut folder — the caret goes to the
   *  heading it was filed under. */
  it("hands the caret to the heading the folder left, when it lands where the wall does not draw it", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED, BACKORDERED, SOMEDAY]);
    wishlistFolderMove.mockImplementation(async () => {
      wishlistFolderList.mockResolvedValue([
        ORDERED,
        { ...BACKORDERED, parentId: SOMEDAY.id },
        SOMEDAY,
      ]);
      return { ...BACKORDERED, parentId: SOMEDAY.id };
    });
    const user = userEvent.setup();
    wrap(<WishlistPage />, { folds: { [String(SOMEDAY.id)]: true } });
    await findHeading(BACKORDERED.id);

    await fromMenu(user, BACKORDERED.id, /^Move to folder/);
    await moveInto(user, "Backordered", "Someday");

    await waitFor(() =>
      expect(wishlistFolderMove).toHaveBeenCalledWith(BACKORDERED.id, SOMEDAY.id),
    );
    await waitFor(() => expect(menuOf(ORDERED.id)).toHaveFocus());
  });

  /** **Moved off this wall from the top of a level**: the level has no heading, so the caret goes
   *  to the path row's Add folder. */
  it("hands the caret to the path row's Add folder when the folder leaves the level it stood at the top of", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED, BACKORDERED]);
    wishlistFolderMove.mockImplementation(async () => {
      wishlistFolderList.mockResolvedValue([ORDERED, { ...BACKORDERED, parentId: null }]);
      return { ...BACKORDERED, parentId: null };
    });
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);
    await user.click(titleOf(ORDERED.id, "Ordered"));
    await waitFor(() => expect(levelAsked()).toBe(ORDERED.id));
    await findHeading(BACKORDERED.id);

    await fromMenu(user, BACKORDERED.id, /^Move to folder/);
    await moveInto(user, "Backordered", "Wishlist");

    await waitFor(() => expect(wishlistFolderMove).toHaveBeenCalledWith(BACKORDERED.id, null));
    await waitFor(() => expect(pathAddFolder()).toHaveFocus());
  });

  /** **Deleted, the folder's `⋯` is gone with it**: the parent heading's. */
  it("hands the caret to the parent heading's ⋯ once a folder is deleted", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED, BACKORDERED]);
    wishlistFolderDelete.mockImplementation(async () => {
      wishlistFolderList.mockResolvedValue([ORDERED]);
    });
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(BACKORDERED.id);

    await fromMenu(user, BACKORDERED.id, /^Delete…/);
    await user.click(await screen.findByRole("button", { name: "Delete folder" }));

    await waitFor(() => expect(wishlistFolderDelete).toHaveBeenCalledWith(BACKORDERED.id));
    await waitFor(() => expect(menuOf(ORDERED.id)).toHaveFocus());
  });

  /** And a top-level folder deleted with its wishes: the path row's Add folder. */
  it("hands the caret to the path row's Add folder once a top-level folder is deleted with its wishes", async () => {
    wishlistFolderList.mockResolvedValue([ORDERED]);
    wishlistFolderDeleteWithWishes.mockImplementation(async () => {
      wishlistFolderList.mockResolvedValue([]);
      return 0;
    });
    const user = userEvent.setup();
    wrap(<WishlistPage />);
    await findHeading(ORDERED.id);

    await fromMenu(user, ORDERED.id, /^Delete…/);
    await user.click(await screen.findByRole("button", { name: "Delete folder and wishes" }));

    await waitFor(() => expect(wishlistFolderDeleteWithWishes).toHaveBeenCalledWith(ORDERED.id));
    await waitFor(() => expect(pathAddFolder()).toHaveFocus());
  });
});
