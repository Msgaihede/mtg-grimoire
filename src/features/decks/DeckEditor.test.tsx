import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import userEvent from "@testing-library/user-event";
import type { UserEvent } from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type {
  CardDetail,
  CardSummary,
  CategoryKind,
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  DeckLabel,
  FormatSpec,
  ImportMatch,
  SyncStatus,
} from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import { fromDeckCard } from "@/features/transfer/TransferCard";
import { boxed, pointerDrag, startPointerDrag } from "@/test-drag";
import { openDropdown, pickOption } from "@/test-dropdown";
import {
  CARD_BODY_ATTR,
  DECK_CARD_VARIANT,
  DECK_GROUP_ATTR,
  LANDED_ATTR,
  SELECTED_ATTR,
} from "./cardControl";
import { THEORY_MATCH_ATTR } from "./CardMarks";
import { deckCardSlot, DECK_CARD_ATTR } from "./dnd";
import { SEARCH_OVER_ATTR } from "./DeckSearchPanel";
import { CUT_CARDS_NOTE } from "./PriceStrip";
import { theorySlot } from "./theoryMatch";
import { QUICK_ZONE_ATTR } from "./QuickZones";
import { card, resetRowIds, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
// The cut: since schema v25 a decrease on the **Live** list goes through this instead, because
// it files the copies the deck's group was holding into `Recently removed` in the same
// transaction. Every removal in this view is one of these two, never both.
const deckToCollection = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckPullPlan = vi.hoisted(() => vi.fn());
const deckPullFromCollection = vi.hoisted(() => vi.fn());
// The `Collection ▸` submenu's read and its write (issue #350). The read is the one command in
// this file fired **imperatively at a press** rather than by a mounted query — a right-click has
// to cost nothing — so a test that never presses that row asserts it was never called.
const deckQuickAddWishes = vi.hoisted(() => vi.fn());
const deckQuickAddToCollection = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
// The other write that changes a row's *address* rather than its quantity — the card menu's
// `Set as foil` / `Set as regular`.
const deckSetCardFinish = vi.hoisted(() => vi.fn());
// Not a card write: the tab, the `Group by` and the `Sort` the reader leaves the deck on.
const deckSetViewState = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
// The docked search panel is the editor's own filter bar, set picker and result wall — and the
// toolbar's quick add resolves a typed name through the same command.
const searchCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
// Which way the reader last left that panel, and the write a press on its disclosure makes.
// Both are needed rather than one: the read is a query and would merely fail, but the write is
// called straight out of a click handler, where `undefined` is a synchronous TypeError nothing
// catches. `true` is the shipped default (issue #183), so the column is drawn open here exactly
// as it is on a fresh install — which is what `openSearchPanel` below is idempotent about.
const deckSearchOpen = vi.hoisted(() => vi.fn());
const setDeckSearchOpen = vi.hoisted(() => vi.fn());
// The five consulted overlays' own reads — categories, labels, history, the theory difference and
// deck settings. Each is unmounted while closed, so these answer only for the tests that open
// one — but the whole `ipc` object is replaced here, so a command left out is a `TypeError`
// rather than a missing answer.
const deckCategoryList = vi.hoisted(() => vi.fn());
const deckLabelList = vi.hoisted(() => vi.fn());
const deckLabelAll = vi.hoisted(() => vi.fn());
// The two writes a card's own right-click reaches — the deck's label put on a row, and the
// label made by the menu's own "New label…" field. `setLabel` had no control anywhere in the app
// until that menu; this is its first caller.
const deckCardSetLabel = vi.hoisted(() => vi.fn());
const deckLabelCreate = vi.hoisted(() => vi.fn());
// The one write a card's menu makes that is not a deck write at all — "Add to → Collection".
// Its refusal is the editor's second banner, because the menu has closed by the time one lands.
const collectionAdd = vi.hoisted(() => vi.fn());
// The quick zones' New category — a pile made from a drop, then filed into. The only caller of
// `deck_category_create` outside the Categories dialog.
const deckCategoryCreate = vi.hoisted(() => vi.fn());
// What the auto-add path reads to file a card by what it *does*. `useDeck`'s `oracleTagsFor`
// catches a refusal and answers `[]`, so an empty list here is not a stub of nothing: it is the
// state every install is in until the taxonomy has been downloaded, and the type-line fallback
// is what these tests then exercise.
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
/** The write a pile dragged past its neighbours on the desk makes — `useDeckMeta`'s, and the one
 *  category command with no menu row anywhere: the grip in a heading is its only caller here. */
const deckCategoryReorder = vi.hoisted(() => vi.fn());
// The three category writes a pile's right-click reaches, through `useDeckMeta`.
const deckCategoryRename = vi.hoisted(() => vi.fn());
const deckCategorySetActive = vi.hoisted(() => vi.fn());
const deckCategoryDelete = vi.hoisted(() => vi.fn());
/** `Clear stack…`'s write, and it is a **card** command through `useDeck` rather than one of
 *  the three above — a clear empties a pile and changes nothing about the category itself. */
const deckCategoryClear = vi.hoisted(() => vi.fn());
const deckAuditList = vi.hoisted(() => vi.fn());
// Undo and redo: the cursor read, and the two writes behind Ctrl+Z / Ctrl+Y.
const deckUndoState = vi.hoisted(() => vi.fn());
const deckUndoApply = vi.hoisted(() => vi.fn());
const deckRedoApply = vi.hoisted(() => vi.fn());
const deckTheoryDiff = vi.hoisted(() => vi.fn());
// Which rows of the plan the Live list is standing in for -- the four views' theory tick.
// Two columns of one indexed scan, and the only read the editor makes of the list the
// reader is *not* looking at.
const deckTheorySlots = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
// The import dialog's three commands, and the sync it reads to tell "your list is wrong" from
// "the card database is not filled in yet".
const importResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const importReadFile = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
// The editor warms the `art` its own views draw — the variant the deck builder renders, and
// a different URL on the CDN from the `grid` the search wall warms. Fire-and-forget, so the
// stub only has to resolve; what it is *called with* is asserted in its own test below.
const prefetchImages = vi.hoisted(() => vi.fn(() => Promise.resolve()));
// The three an **owned** add reaches, and nothing else in this file touches them: the card's own
// oracle identity, the hunt for a copy no deck is holding, and the move that files it into this
// deck's group. `collectionAdd` and `deckCategoryCreate` above are the fourth and fifth, and are
// already here for the card menu and the quick zones.
const cardDetail = vi.hoisted(() => vi.fn());
const collectionList = vi.hoisted(() => vi.fn());
const collectionToDeck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    prefetchImages,
    deckGet,
    deckUpdate,
    deckSetCardQuantity,
    deckToCollection,
    deckMoveCard,
    deckAddCard,
    deckMissingToWishlist,
    deckPullPlan,
    deckPullFromCollection,
    deckQuickAddWishes,
    deckQuickAddToCollection,
    deckSwapPrinting,
    deckSetCardFinish,
    deckSetViewState,
    formatSpecs,
    searchCards,
    deckSearchOpen,
    setDeckSearchOpen,
    // The docked search panel's filter row asks for facet counts beside the page. Answered
    // **cold** — `ready: false`, every map empty — so nothing greys and every control keeps
    // its name.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    listSets,
    deckCategoryList,
    deckLabelList,
    deckLabelAll,
    deckCardSetLabel,
    deckLabelCreate,
    collectionAdd,
    deckCategoryCreate,
    oracleTagsForPrintings,
    deckCategoryReorder,
    deckCategoryRename,
    deckCategorySetActive,
    deckCategoryDelete,
    deckCategoryClear,
    deckAuditList,
    deckUndoState,
    deckUndoApply,
    deckRedoApply,
    deckTheoryDiff,
    deckTheorySlots,
    deckFolderList,
    importResolve,
    deckImportCommit,
    importReadFile,
    syncStatus,
    cardDetail,
    collectionList,
    collectionToDeck,
  },
}));

import { DeckEditor, exportFileName, exportSubject, layerMatches } from "./DeckEditor";
import { useAppStore, type CardWalkStop } from "@/lib/store";

/** The change the Undo button would reverse — a history row like any other, because that is
 *  what the state command answers and what `auditText` words the button's name from. */
const UNDOABLE = {
  id: 77,
  deckId: 4,
  at: 1_800_000_000,
  variant: "live" as const,
  kind: "remove" as const,
  cardId: "p1",
  cardName: "Lightning Bolt",
  payload: '{"category":"Main deck","quantity":2,"reason":null}',
  delta: -2,
};

const DECK: DeckRow = {
  gameKey: "any",
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: null,
  coverArtist: null,
  archived: false,
  cardCount: 6,
  updatedAt: 1_800_000_000,
  // The four v8 deck columns. Every real row carries all four, so the fixture does too.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read. The defaults, so a test that says nothing about them opens on
  // Live, grouped by category, sorted alphabetically — and a test about the memory overrides the
  // one field it is about through `detail()`.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  // Schema v13, and `0` is the column's own default: a deck counts an `{X}` spell at the mana
  // value Scryfall gives it until the reader says otherwise.
  separateXGroup: false,
  // Schema v16, and `0` is `AUTO_CATEGORY` — the column's own default and the state every deck
  // is born in: an add that names no pile is filed by what the card does. A test about the
  // setting overrides it through `detail()`, which is the *only* way to move it now — it was a
  // `useState` in this component with a select in the docked search panel until 2026-08-15.
  defaultCategoryId: 0,
  bracket: 0,
};

/** The picker, as `format_specs` serves it — every enabled row in `sort_order`. */
const PICKER: FormatSpec[] = [spec("modern"), spec("commander"), spec("gladiator"), spec("casual")];

/**
 * One `deck_categories` row.
 *
 * **`isActive` is derived from the kind by default**, mirroring `schema::PREDEFINED_CATEGORIES`:
 * the Maybeboard is the one predefined pile seeded switched off, and every other category a
 * deck is born with is on. A test about the switch itself passes `isActive` and says so.
 *
 * **`origin` defaults to `"user"`, which is what all three of Rust's writing sites but one
 * produce**: `create_category` (the panel's button) and `ensure_predefined_categories` (the four
 * seeds) both write it, and only `category_for_name` — the app filing a card — writes `"auto"`.
 * The default matters because it decides whether an **empty** pile is drawn at all: a pile of the
 * reader's own always is, an auto one never is. A test about that rule passes `origin` and says
 * so, and no test may reach for the *name* instead — "Ramp" and "Draw" are what a reader calls a
 * pile of their own as readily as what the app calls one.
 */
function category(
  id: number,
  name: string,
  kind: CategoryKind,
  over: Partial<DeckCategory> = {},
): DeckCategory {
  return {
    id,
    deckId: DECK.id,
    name,
    kind,
    isActive: kind !== "maybe",
    origin: "user",
    sortOrder: id - 1,
    // The heading counts the rows it was handed, so these three are read by nothing here.
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: over.cardCount ?? 0,
    ...over,
  };
}

/**
 * The categories every deck in this file has, in `sortOrder` — and therefore the groups the
 * editor draws when it is grouping by category, since schema v8 made the two the same list.
 *
 * `schema::PREDEFINED_CATEGORIES`' four, plus the `Main deck` the v8 migration files every
 * legacy main-deck row into. The **ids are `validation/fixtures`' own**: `card()` files a row
 * under one category per kind.
 */
const CATEGORIES: DeckCategory[] = [
  category(1, "Main deck", "main"),
  category(2, "Sideboard", "side"),
  category(3, "Commander", "commander"),
  category(4, "Companion", "companion"),
  category(5, "Maybeboard", "maybe"),
];

/** The two ids every write below is addressed by — every deck command takes a category id now,
 *  where it used to take one of five words. */
const MAIN = CATEGORIES[0].id;
const SIDE = CATEGORIES[1].id;

function detail(
  deck: Partial<DeckRow>,
  cards: DeckCard[],
  categories: DeckCategory[] = CATEGORIES,
  labels: DeckLabel[] = [],
): DeckDetail {
  return { deck: { ...DECK, ...deck }, cards, categories, labels };
}

function bolt(overrides: Partial<DeckCard> = {}): DeckCard {
  return card({
    name: "Lightning Bolt",
    typeLine: "Instant",
    quantity: 4,
    unitPrice: 4.5,
    ownedQuantity: 3,
    ...overrides,
  });
}

/** One search result, for the tests that drive the docked panel or the quick add. */
function found(name: string): CardSummary {
  return {
    promoTypes: null,
    id: `s-${name}`,
    name,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "12",
    rarity: "rare",
    typeLine: "Creature — Goblin",
    manaCost: "{R}",
    price: 1.5,
    layout: "normal",
    oracleId: `o-${name}`,
    finishes: `["nonfoil"]`,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: 1.5,
    priceHigh: 1.5,
    gameChanger: false,
  };
}

/**
 * The same printing as {@link found}, as `card_detail` answers it.
 *
 * **Complete rather than shaped for its caller**, and that is the point: an owned add reads this
 * command for the card's oracle id, and `CardDetailModal` reads it for a dozen fields it indexes
 * without a fence (`card.setCode.toUpperCase()`, `card.faces[face]`). A partial stub therefore
 * takes the modal down as an *unhandled* error the moment a test leaves a card open, and vitest
 * reports it against whichever test ran next.
 */
function detailOf(name: string): CardDetail {
  return {
    id: `s-${name}`,
    oracleId: `o-${name}`,
    name,
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "12",
    rarity: "rare",
    layout: "normal",
    lang: "en",
    manaCost: "{R}",
    cmc: 1,
    typeLine: "Creature — Goblin",
    oracleText: null,
    illustrationId: null,
    artist: null,
    releasedAt: null,
    legalities: null,
    finishPrices: { nonfoil: 1.5, foil: null, etched: null },
    finishes: `["nonfoil"]`,
    promoTypes: null,
    imageStatus: "highres_scan",
    faces: [],
  };
}
/** The one printing `import_resolve` answers with here — everything the plan does not
 *  read filled in as nothing, `plan.test.ts`'s own builder cut to one row. */
const SOL_RING: ImportMatch = {
  cardId: "sol-ring",
  name: "Sol Ring",
  setCode: "ltc",
  collectorNumber: "285",
  lang: "en",
  oracleId: null,
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

/** A card database that is filled in and idle. */
const SYNCED: SyncStatus = {
  cardCount: 116_695,
  lastCheckAt: null,
  bulkUpdatedAt: null,
  lastError: null,
  lastIngestSkipped: null,
  dataDir: "C:/data",
  syncing: false,
  imageStoreFailures: 0,
};

/**
 * The editor, under the two hosts the shipped app always puts above it.
 *
 * `ContextMenuProvider` is `App.tsx`'s and is what a right-click actually reaches:
 * `useContextMenu` degrades to a **no-op** without one — deliberately, so an unwrapped story
 * cannot redden the whole suite — which means a menu test that forgot it would pass by drawing
 * nothing and asserting nothing. It costs the tests that are not about menus one `contextmenu`
 * listener on `document` and no state at all: nothing else is registered until a menu opens.
 */
function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const hosts = (inner: ReactElement) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ContextMenuProvider>{inner}</ContextMenuProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(hosts(ui));
  return {
    ...view,
    /**
     * Swap the editor **under the same three hosts** — and this is the whole reason it exists:
     * `rerender` replaces the *root*, so `rerender(<DeckEditor …/>)` drops the
     * `QueryClientProvider` and every hook in the tree throws "No QueryClient set". The one
     * caller is the per-deck test below, which needs one query cache across two deck ids.
     */
    rerenderIn: (inner: ReactElement) => view.rerender(hosts(inner)),
  };
}

/**
 * The docked panel's disclosure — **a pattern, because its name says what pressing it does** and
 * therefore changes with the state: `Collapse card search` open, `Expand card search` collapsed.
 * It was the literal `Search cards` until 2026-08-25, when the words became a heading beside the
 * button and the control became a bare chevron. `aria-expanded` is what a test asserts the state
 * on; the `$` anchor keeps this off the drag handle's `Resize card search`.
 */
const PANEL_TOGGLE = /card search$/;

/** The editor, rendered and waited for — every test starts from a deck on screen. */
async function open() {
  const view = wrap(<DeckEditor deckId={4} />);
  await screen.findByLabelText("Deck name");
  return view;
}

/**
 * The docked search panel, expanded — because it is the one surface here that starts **shut**.
 *
 * It is 384px plus a `gap-4` out of a desk row measured at 602px at the app's own 1280×800 with
 * the card pane docked, so open by default every reader paid the width of the wall on every deck
 * they opened whether or not they were adding cards. One press gets it back. Every test below
 * that reads the wall, the "Add to" select or the set filter presses that button first, which is
 * what keeps each of them testing what it meant to test rather than testing the default.
 *
 * **Idempotent on purpose**: it presses only when the disclosure says it is shut. This helper is
 * a claim about the panel being *open*, never about which way it starts — that is
 * `DeckSearchPanel.test.tsx`'s to pin, and pinning it twice would make one of the two a copy
 * that quietly stops meaning anything.
 */
async function openSearchPanel() {
  const toggle = await screen.findByRole("button", { name: PANEL_TOGGLE });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  // **And then the tab**, since the panel grew a two-tab strip and opens on the *collection*
  // one. Every test below reaches the card search's wall, which is the second tab's body, so a
  // helper that stopped at the disclosure would hand back a searchbox that is not mounted. Same
  // shape as the press above and for the same reason: it is idempotent, so a caller that has
  // already switched tabs pays nothing and no test here is a claim about which tab the panel
  // opens on — that is `DeckSearchPanel.test.tsx`'s to pin, and pinning it twice would make one
  // of the two a copy that quietly stops meaning anything.
  const cards = await screen.findByRole("button", { name: "All cards" });
  if (cards.getAttribute("aria-pressed") !== "true") await userEvent.click(cards);
  return screen.findByRole("searchbox", { name: "Search cards" });
}

/**
 * The panel's card search **with its filter tray open** — Set, Format, Owned, Rarity, Price and
 * Printings, which the filter row has kept behind a disclosure since it was redesigned.
 *
 * Idempotent for {@link openSearchPanel}'s reason and by the same test: it presses only when the
 * button says the tray is shut, so no case here is a claim about which state it opens in. That
 * claim is `FilterBar.test.tsx`'s, and making it twice would leave one of the two a copy that
 * quietly stopped meaning anything.
 */
async function openFilterTray() {
  await openSearchPanel();
  const toggle = await screen.findByRole("button", { name: /^(Show|Hide) filters/ });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
}

/**
 * The deck settings dialog's `Add cards to` picker, opened.
 *
 * **This is where "every pile of this deck, drawn or not" is now asked**, and it is one of the
 * two surfaces built from `deck.categories` rather than from the drawn groups — the card's
 * right-click `Move to` being the other. The docked search panel's own `Add to` select carried
 * that claim until 2026-08-15, when the choice became a deck setting; the claim did not move,
 * only the control that shows it.
 *
 * **A `Dropdown` since Task 14 of the unified-dropdowns migration, not the native `<select>`
 * this helper used to `findByLabelText` and hand back.** Its panel is a listbox that mounts only
 * while open, so there is no element to return any more — a caller reads the rows off `screen`
 * (`getAllByRole("option")`/`getByRole("option", { name })`) once this has opened it, and reads
 * the picked value off the trigger's own text (`getByRole("button", { name: "Add cards to" })`)
 * rather than off a `.value`.
 */
async function openAddTo(user: UserEvent) {
  await userEvent.click(screen.getByRole("button", { name: "Deck settings" }));
  await openDropdown(user, "Add cards to");
}

/** A group, by the heading it draws. Every view labels its section with the group's name and
 *  nothing else — the count and the price are text beside it, not part of what it is called. */
const group = (name: string) => screen.getByRole("region", { name });

/**
 * Wait until `format_specs` has answered, for the deck under test.
 *
 * The seed is a query, so on the first deck of a session the editor mounts before it lands and
 * the docked panel's format default is `null` for a render or two — which looks exactly like a
 * deck the fence deliberately left unfiltered. Anything asserting on that default has to be past
 * this line or it is testing a query in flight.
 *
 * **It waited on an option of the header's `Deck format` select until 2026-08-24**, and that
 * select is gone — the question is Deck settings' now. The ledger's check button is the tell that
 * replaced it, and it is a *stronger* one: it is drawn only once a spec is in hand and it names
 * the ruleset it checked against, where the old sentinel merely proved that some other row of the
 * same table had arrived.
 *
 * So it takes the deck's own format rather than a sentinel — and the one fixture whose key the
 * seed does not carry (`historic`) can never satisfy it, which is honest: there is no spec for
 * that deck, so there is nothing for this to wait for. That test says so at its own site.
 */
const seeded = (format: string) =>
  screen.findByRole("button", { name: new RegExp(`· ${format}$`) });

/**
 * Make a deck-row write, in the fewest acts a test can spend.
 *
 * **The header's `Deck game` select was this and is gone** (2026-08-24): both selects are Deck
 * settings' now, and reaching one from here would be a dialog and four presses for a write whose
 * *field* no caller cares about. The name field is the header's remaining one-act `deck_update` —
 * Enter commits without waiting for the caret to leave — and it goes through exactly the same
 * mutation, so the refusal banner, the re-read and the gone message are reached the same way.
 */
async function writeToDeck(name = "Sunday burn") {
  const field = screen.getByLabelText("Deck name");
  await userEvent.clear(field);
  await userEvent.type(field, `${name}{Enter}`);
}

/** What the stepper on the fixture's Bolt is called. Named by the **slot** — the card and the
 *  pile — because the same printing sits in two categories often enough that a name without one
 *  would be two controls a screen reader cannot tell apart. */
const COPIES = "Copies of Lightning Bolt in Main deck";

/** The X toggle's whole accessible name, which `ToggleChip` also spends as its tooltip. Written
 *  out once because three tests address the control, and a regex over its two-word label alone
 *  would keep passing on the day the sentence went missing — which is the half of the name that
 *  has to stand up read out of context, with no Group by picker beside it. */
const SPLIT_X =
  "Split X — give cards with X in their cost a group of their own, instead of counting X as zero";

/** `VIEWS`' own `id → label` map, read back here because it is not exported: the two
 *  `it.each(["stacks", "table", "text", "grid"])` sweeps below pass the id as both the test's
 *  own `%s` name and `pickOption`'s second argument, and that argument is the row's visible
 *  text — never the value a `<select>` used to take. */
const VIEW_LABEL: Record<string, string> = {
  stacks: "Stacks",
  table: "Table",
  text: "Text",
  grid: "Grid",
};

/**
 * jsdom lays nothing out, so the docked panel's virtualised wall measures a scroll container of
 * zero height and renders no tiles at all. One number is the whole of what it is missing;
 * `scrollTo` is the other thing the virtualiser reaches for that jsdom does not implement.
 *
 * Put back afterwards: these are patches to a *global* prototype, and a file that leaves one
 * behind is a file that decides how the next one measures the DOM.
 */
const patched: [string, PropertyDescriptor | undefined][] = [];
function patch(name: string, descriptor: PropertyDescriptor) {
  patched.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
}

beforeAll(() => {
  patch("offsetHeight", { value: 600 });
  patch("scrollTo", { value: vi.fn() });
});

afterAll(() => {
  for (const [name, original] of patched.reverse()) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

/**
 * Pretend the editor's desk is `px` wide for the duration of one test.
 *
 * jsdom measures every element at zero, which the editor reads as "not measured yet" and
 * therefore as room — so the narrow case cannot be reached without saying how wide things are.
 * `clientWidth` is what the desk is measured with, since the `ResizeObserver` in `test-setup`
 * is a no-op.
 *
 * **`document.documentElement` inherits this too**, so the editor's other measurement — the
 * window, for the half-of-it cap on the docked panel's width — reads the same number. That is
 * harmless where the deck's own floor is the tighter of the two caps, which it is at every width
 * these tests use; {@link viewport} is how the other one is reached.
 */
function desk(px: number) {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  return () => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    if (original && !Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")) {
      Object.defineProperty(Element.prototype, "clientWidth", original);
    }
  };
}

/**
 * Pretend the *window* is `px` wide, independently of {@link desk}.
 *
 * An **own** property on `document.documentElement`, which is what makes the two separable: a
 * value defined on the element itself shadows the one `desk` puts on `HTMLElement.prototype`, so
 * a test can say "a 2000px desk in a 1000px window" and mean it. Which is the only way to reach
 * the half-the-window cap, since it never binds while the two numbers are equal — the deck's
 * floor is tighter than half the row at every width below 416.
 *
 * `documentElement.clientWidth` rather than `window.innerWidth`, because that is what the editor
 * reads and why: `innerWidth` counts the classic vertical scrollbar and the layout does not.
 */
function viewport(px: number) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  return () => {
    delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
  };
}

beforeEach(() => {
  resetRowIds();
  useAppStore.setState({
    activeView: "decks",
    openDeckId: 4,
    selectedCardId: null,
    paneDeckContext: null,
    // Which side of the desk the pane would be drawn over. Reset with the rest so a test that
    // opens a card is reading its own editor's answer rather than the previous one's.
    paneFromDeckSearch: false,
    printingsRequest: null,
    // The order the printings modal steps through, published by this editor. Reset with the rest
    // so a test reading it is reading its own editor's answer and not the previous one's.
    cardWalk: { label: "", stops: [] },
  });
  deckGet
    .mockReset()
    .mockResolvedValue(
      detail({}, [bolt(), card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 })]),
    );
  deckUpdate.mockReset().mockResolvedValue(DECK);
  deckSetCardQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 0, removed: true });
  // What a cut gave back: the row in `Recently removed` the copies landed in, and how many.
  // `deckCardId` is `null` from this direction by design — the caller handed the id in, and a
  // whole cut has deleted the row it named.
  deckToCollection
    .mockReset()
    .mockResolvedValue({ entryId: 21, fromDeck: null, deckCardId: null, quantity: 1 });
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  deckAddCard.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  deckMissingToWishlist.mockReset().mockResolvedValue(3);
  // **A plan of no rows, which is the ordinary answer rather than a failure** — a deck whose
  // shortfall is all cards the reader has never owned. Every test here is about the layer
  // rather than about the list inside it (`PullFromCollectionDialog.test.tsx` owns that), and
  // the empty state still draws the ✕, Cancel and Pull that the Tab sweep walks.
  deckPullPlan.mockReset().mockResolvedValue([]);
  deckPullFromCollection.mockReset().mockResolvedValue({ copies: 0, cards: 0 });
  // **No wish matches, which is the commonest answer and the one that draws nothing at all.**
  // `chooseWish` writes straight through on an empty list, so the default here is the state in
  // which `Quick add N and remove from wishlist` is exactly `Quick add N` — and every test about
  // the dialog states its own two rows.
  deckQuickAddWishes.mockReset().mockResolvedValue([]);
  deckQuickAddToCollection
    .mockReset()
    .mockResolvedValue({ copies: 1, entryId: 91, wishCopies: 0 });
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  deckSetCardFinish.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  deckSetViewState.mockReset().mockResolvedValue(undefined);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  // Nothing found by default: a result named after a card already in the deck would be a
  // second button by that name, and every test here addresses cards by name.
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  listSets.mockReset().mockResolvedValue([]);
  deckSearchOpen.mockReset().mockResolvedValue(true);
  setDeckSearchOpen.mockReset().mockResolvedValue(undefined);
  deckCategoryList.mockReset().mockResolvedValue(CATEGORIES);
  deckLabelList.mockReset().mockResolvedValue([]);
  deckLabelAll.mockReset().mockResolvedValue([]);
  deckCardSetLabel.mockReset().mockResolvedValue(undefined);
  deckLabelCreate
    .mockReset()
    .mockResolvedValue({ id: 12, name: "Cut candidate", color: "gold", cardCount: 0 });
  collectionAdd.mockReset().mockResolvedValue({ id: 77, quantity: 1, removed: false });
  deckCategoryCreate.mockReset().mockResolvedValue(category(9, "Removal", "main"));
  // The **own** arm's three. An empty binder by default, which is the state every other test
  // here is written against and the one an owned add records a new row in.
  /**
   * **Refused by default, which is what this command did here before it was stubbed at all** —
   * the whole `ipc` object is replaced above, so `cardDetail` was `undefined` and every caller
   * of it threw. `CardDetailModal` is the other caller and reads a dozen fields off the answer
   * without a fence, so a stub shaped for the add path takes the modal down as an *unhandled*
   * error that vitest then reports against whichever test happened to be running. The four tests
   * that drive an owned add state their own answer.
   */
  cardDetail.mockReset().mockRejectedValue(new Error("card_detail is not stubbed in this test"));
  collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  // **Both ids, and they are different rows.** `entryId` is the collection row the copies
  // landed in; `deckCardId` is the `deck_cards` row the move wrote, which is what the editor
  // glows for five seconds. A mock without it answers `undefined` and the owned add reads as a
  // press that did nothing — an impossible backend answer, since this command always names one.
  collectionToDeck
    .mockReset()
    .mockResolvedValue({ entryId: 77, fromDeck: null, deckCardId: 55, quantity: 1 });
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  // The whole list back, which is what `deck_category_reorder` answers. Nothing here reads it —
  // the desk shows the order it sent and the query refetch is what settles it — so the value is
  // only the shape.
  deckCategoryReorder.mockReset().mockResolvedValue(CATEGORIES);
  deckCategoryRename.mockReset().mockResolvedValue(CATEGORIES[0]);
  deckCategorySetActive.mockReset().mockResolvedValue(CATEGORIES[0]);
  deckCategoryDelete.mockReset().mockResolvedValue(undefined);
  // The copies it removed, which is what the command answers.
  deckCategoryClear.mockReset().mockResolvedValue(4);
  deckAuditList.mockReset().mockResolvedValue([]);
  // One change to undo and nothing to redo — the state a deck that has just been edited is in,
  // and the one that makes both buttons' two halves testable in the same render.
  deckUndoState.mockReset().mockResolvedValue({ undo: UNDOABLE, redo: null });
  deckUndoApply.mockReset().mockResolvedValue(undefined);
  deckRedoApply.mockReset().mockResolvedValue(undefined);
  deckTheoryDiff.mockReset().mockResolvedValue([]);
  // A plan that asks for nothing: the tick is drawn by the tests that are about it and by
  // no other, so a card name assertion elsewhere never has to know this mark exists.
  deckTheorySlots.mockReset().mockResolvedValue([]);
  deckFolderList.mockReset().mockResolvedValue([]);
  // One printing, so a one-line paste has something to resolve to and the Import button is
  // live. What the plan makes of it is `plan.test.ts`'s and the dialog's own to prove.
  importResolve
    .mockReset()
    .mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  deckImportCommit.mockReset().mockResolvedValue({ added: 1, removed: 0, categoriesCreated: 0 });
  importReadFile.mockReset().mockResolvedValue("");
  syncStatus.mockReset().mockResolvedValue(SYNCED);
  prefetchImages.mockClear();
});

describe("DeckEditor", () => {
  /**
   * The deck warms **the variant its own views draw**, and the variant is the point of the effect
   * rather than an incidental argument: each is a different URL on the CDN, so a fully warm cache
   * of the wrong one contributes nothing at all and the builder fetches every tile cold. Measured
   * against the live database on 2026-08-11, when the two disagreed: all 17 deck cards had a
   * `grid` row, 12 had an `art` one, and the deck arm of the pre-warm was the only work there was.
   *
   * Asserted through `DECK_CARD_VARIANT` rather than against the word, because the contract is
   * that this effect and the views agree — spelling the variant out here would let them drift
   * apart and still pass. It is `grid` today, which is what the collection and the search wall
   * warm too, so a card that is both owned and in a deck is one cache key rather than two.
   */
  it("warms the variant its own card views draw", async () => {
    await open();

    await waitFor(() =>
      expect(prefetchImages).toHaveBeenCalledWith(
        expect.arrayContaining(["c-Lightning Bolt", "c-Bear"]),
        DECK_CARD_VARIANT,
      ),
    );
  });

  /**
   * The header is the deck: what it is called and what it is judged by.
   *
   * **The format is a word on the ledger and no longer a select** (2026-08-24). Both of the
   * header's selects moved out — `DeckSettingsDialog` had been asking the same two questions all
   * along, and this row was printing the answers at the cost of ~250px on a row that already
   * wrapped. What had to stay is the *answer*: a ledger that says `2 issues` without saying issues
   * with what is a count with no scope.
   */
  it("heads the editor with the deck's name and the ruleset it is judged by", async () => {
    await open();

    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
    // Scoped to the term, because `Modern` is also an `<option>` of the docked panel's own
    // format filter — which is the pair the four tests further down are about.
    expect(
      await screen.findByText("Format", { selector: "dt" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Format", { selector: "dt" }).closest("div")).toHaveTextContent(
      "Modern",
    );
  });

  /** Changing either is a Deck settings trip, and this row draws neither control. Asserted as an
   *  absence, which is the only thing that would catch one creeping back. */
  it("draws no format or game select of its own", async () => {
    await open();

    expect(screen.queryByLabelText("Deck format")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Deck game")).not.toBeInTheDocument();
  });

  /** The caret starts in the editor rather than on `<body>`: the gallery's New deck button —
   *  which is what had it — unmounts the moment this view takes over. */
  it("takes the caret when it opens", async () => {
    await open();

    await waitFor(() =>
      expect(screen.getByRole("region", { name: /deck editor: burn/i })).toHaveFocus(),
    );
  });

  /**
   * **The title row, pinned by the three things that let it collapse.**
   *
   * jsdom lays nothing out, so no test here can see a width — this is the same bargain
   * `CardStack.test.tsx` strikes over its Tailwind literals. What a test *can* see is the three
   * decisions, each of which was a bug on its own in the shipped window (measured over CDP with
   * the Theory switch on, at 1100/1200/1280):
   *
   * * the field had `min-w-0` and no floor, so it collapsed to **18px**;
   * * the field had no `size`, so its intrinsic 20-character width — over 240px at `text-xl` —
   *   was what the row's line-breaking read, and the deck's controls wrapped to a second line
   *   even when the name had room;
   * * the controls beside it were `shrink-0`, which pins a `flex-wrap` container at its
   *   max-content width (**692px at every window size**), so every pixel of the squeeze fell on
   *   the name and the switch beside it spilled 180px over the controls — at 1200 the last
   *   pixels of the control beside it (then a "N cards differ" readout, now Compare) hit-tested
   *   to the format select.
   *
   * **The third of those is deliberately reversed since 2026-08-24, and the reversal is safe for
   * a reason the old shape did not have.** The controls are `shrink-0 flex-nowrap` again — but
   * the block gives width back *itself* now, dropping the four labelled buttons to their icons as
   * the column narrows, so it is a fixed run whose fixed width is a function of the column. What
   * catches the width below which even the narrow run does not fit is the row's own `flex-wrap`:
   * the whole block folds to a line of its own rather than crushing the name. The wrapper that
   * used to sit between the field and this row went with the Compare button that made it a group.
   */
  it("keeps the deck name from collapsing between the controls beside it", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    // A floor, and not `min-w-0` — the class Tailwind emits is the whole of the fix.
    expect(name.className).toContain("min-w-40");
    expect(name.className).not.toContain("min-w-0");
    // …and an intrinsic width small enough that the floor is the only floor.
    expect(name).toHaveAttribute("size", "1");

    // The field is the row's own flexible child: no wrapper between it and the wrapping row.
    const row = name.parentElement!;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).not.toContain("min-w-0");

    // The controls are the row's last child, pinned to the right and never squeezed.
    const controls = row.lastElementChild!;
    expect(controls.className).toContain("shrink-0");
    expect(controls.className).toContain("ml-auto");
    expect(controls.className).not.toContain("flex-wrap");
  });

  /**
   * **The deck grows; only the page scrolls — and only the virtualised table is given a height.**
   *
   * jsdom lays nothing out, so no test here can see the failure this pins: a deck with more piles
   * than the window is tall, letterboxed in a box of the desk's height with the editor's own
   * scrollbar an inch away. It was measured in the shipped window at 1280×800 on a 132-card,
   * 17-pile deck — 7 123px of piles, `scrollHeight - clientHeight` of 0 in the view, 702 visible
   * against 7 635 of page — and every figure is in
   * [frontend-design.md](../../../docs/reference/frontend-design.md).
   *
   * What a test *can* see is the four class decisions that produce it, each of which was the
   * whole of a bug on its own:
   *
   * * the view box carrying `overflow` or `min-h-0` is the letterbox — `min-h-0` more than the
   *   overflow, because it is the line that says "this box may be squeezed below its content";
   * * the same `min-h-0` and `overflow-auto` are exactly what the table *must* keep, because a
   *   virtualiser holds a spacer open for the rows it has not mounted and a scrollport is what it
   *   is. Given no height it drew its own scrollbar **and** the page's;
   * * `min-h-96` on the **desk row** is a ceiling as well as a floor — a `min-height` number
   *   replaces a flex item's `auto` automatic minimum size — which is why it sits on the view box
   *   for the three walls and stays on the row only under the table;
   * * and `tailwind-merge` has to resolve that pair the table's way, since `min-h-96` and
   *   `min-h-0` are one group and a floor under a scrollport is a floor under a scrollbar.
   */
  it("gives the deck's walls no height and the virtualised table one", async () => {
    const user = userEvent.setup();
    await open();

    const deskOf = () => {
      const dock = screen.getByRole("region", { name: "Add cards" }).parentElement!;
      return { row: dock.parentElement!, view: dock.parentElement!.firstElementChild! };
    };

    // Stacks is where the editor opens, and the two boxes say opposite things about height.
    const stacks = deskOf();
    expect(stacks.view.className).toContain("min-h-96");
    expect(stacks.view.className).not.toContain("min-h-0");
    expect(stacks.view.className).not.toContain("overflow");
    expect(stacks.row.className).not.toContain("min-h-");

    for (const label of ["Text", "Grid"]) {
      await pickOption(user, "View", label);
      const wall = deskOf();
      expect(wall.view.className, label).toContain("min-h-96");
      expect(wall.view.className, label).not.toContain("overflow");
      expect(wall.row.className, label).not.toContain("min-h-");
    }

    await pickOption(user, "View", "Table");
    const table = deskOf();
    // The squeezable box, back where it was — and `min-h-96` merged away rather than fighting it.
    expect(table.view.className).toContain("min-h-0");
    expect(table.view.className).toContain("overflow-auto");
    expect(table.view.className).not.toContain("min-h-96");
    // …and the row is what holds it to the page's leftover height.
    expect(table.row.className).toContain("min-h-96");
  });

  /**
   * **The editor does not scroll; `AppShell`'s `main` does** — one scroller, not two nested
   * (changed 2026-08-24 by `f02b284`, "fix scroll").
   *
   * This section carried `overflow-y-auto` and was therefore a scroll container *inside* `main`,
   * which is `relative min-h-0 flex-1 overflow-auto p-5` and has been for as long as the shell has
   * had that element. Two nested scrollers is two scrollbars an inch apart moving different
   * things, with nothing on screen saying which — the complaint the deck views' own boxes were
   * given no height to avoid, one level further out.
   *
   * **What this asserts is the absence, because the absence is the fix** and an absence is exactly
   * what a tidy re-adds. A `overflow-y-auto` put back on this element would look right in every
   * other test in this file and would silently restore the pair.
   *
   * `relative` stays and is asserted with it. It is inert on a box that clips nothing — but the
   * rule it comes from is about whichever box carries the `overflow`, so leaving it here costs
   * nothing and removing it would be a second edit nobody asked for. **The rule itself is pinned
   * on the box that now scrolls**, in `AppShell.test.tsx`.
   *
   * **The measurement that produced the old class belongs to the old arrangement** and is kept
   * because it is the reason the rule exists at all: 2026-08-15, `tauri dev`, a debug build,
   * 1280×800, a 24-card deck — `documentElement.scrollHeight` **1704** against a `clientHeight` of
   * 800, `window.innerWidth - documentElement.clientWidth` **15**, while `body.scrollHeight` and
   * the `h-screen` shell root both read 800 and the shell's `overflow-hidden` reported nothing
   * overflowing. The deepest escapee was `DeckStats`' curve label
   * `"0 cards at mana value 8 or more"` at y **1703**. `relative` on the scroller took it to
   * **800 / 0**; `relative` on `main` *instead* moved the phantom scroll rather than removing it
   * (`main.scrollHeight` **742 → 1646**, same pass) — which was true while this element was the
   * scroller and is the case that no longer arises, since `main` is now both.
   *
   * **None of that is checkable here** — jsdom has no layout engine — which is why this is a class
   * assertion and why the numbers are the record of where the rule came from.
   */
  it("does not nest a scroller inside the shell's own", async () => {
    await open();

    const page = screen.getByRole("region", { name: /^Deck editor:/ });
    expect(page.className).not.toContain("overflow-y-auto");
    expect(page.className).not.toContain("overflow-auto");
    expect(page.className).toContain("relative");
  });

  /**
   * **The docked panel is pinned, not stretched** — the other half of the deck growing.
   *
   * A sibling of a 7 000px desk row is drawn 7 000px tall unless it opts out, which takes its
   * search field off the top of the window and mounts tiles for a wall nobody can see at once.
   * `sticky top-0` and `self-start` are the opt-out; the height is measured, because `100%` here
   * is the deck's height and a viewport unit is wrong by the app chrome above the scroller — and
   * a measured height is exactly what jsdom cannot check, so the classes are what this pins.
   * Driven at six scroll positions in the shipped window: 489px at rest, 702 once scrolled past
   * the header, bottom edge flush with the scrollport at every one.
   */
  it("pins the search panel's dock rather than stretching it down the deck", async () => {
    await open();

    const dock = screen.getByRole("region", { name: "Add cards" }).parentElement!;
    expect(dock.className).toContain("sticky");
    expect(dock.className).toContain("top-0");
    expect(dock.className).toContain("self-start");
  });

  /** The way back, and the only thing that closes the editor. */
  it("returns to the gallery from the back control", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /back to decks/i }));

    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /**
   * The second header write, and it is here for the same reason the format select above it is:
   * this file owns the **wiring** — that the field's decision reaches `deck.update` with the
   * field the backend renames on.
   *
   * `DeckNameField.test.tsx` pins the field's own half (the draft, the blank and unchanged
   * refusals, blur and Enter both committing) against an `onRename` spy, which is a claim about
   * a prop and says nothing about what this editor hands it. Extracting the field moved the four
   * assertions that had covered `renameDeck` into that file, and for a moment nothing here
   * asserted a `name` at all: `deck.update.mutate({ name })` could be deleted outright, or sent
   * as `{ title: name }`, and the whole suite stayed green. Proved by doing it, 2026-08-16.
   */
  it("renames the deck from the name field", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunday burn" }));
  });

  /**
   * **The groups are the deck's categories; the format decides only whether an *empty* command
   * zone is one of them.**
   *
   * Two rules have lived here in turn and this is neither of them whole. The first filtered the
   * **category list** by the seeded spec — no commander column unless `requires_commander`, no
   * sideboard when `sideboard_max` was 0 — and schema v8 killed it, because a category is a row
   * the *user* named, ordered and switched on or off, so cutting one out hides a pile they
   * built. The second was "draw every category, whatever the format says", which is what this
   * test asserted until now.
   *
   * What replaced it reaches only the **empty** piles, and only through `buildGroups`' rules
   * argument — `deck.categories` is untouched, which is why the "Add to" tests below still see
   * every pile and none is unreachable. This deck is Modern: no empty Commander
   * heading (the format needs none) and no empty Companion heading (a companion is nominated,
   * never handed out, so an empty slot says nothing). Everything else is drawn empty — the two
   * fixed zones Modern does use, and a pile the reader made and emptied, which is the reverse of
   * the old rule and the whole reason this changed.
   *
   * **Every category here is `origin: "user"`**, which is the fixture's default and is what makes
   * this test about the *format* alone. The third class — a pile the app made while filing a card
   * — is never drawn empty in any format, and has its own tests below.
   *
   * The default grouping is Categories, so the deck opens on exactly this list.
   */
  it("draws no empty command zone or companion slot for a format with neither", async () => {
    const brew = category(6, "Sunday brew", "main");
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, brew]));

    await open();

    expect(screen.queryByRole("region", { name: "Commander" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Companion" })).not.toBeInTheDocument();
    // A category is a *place* as well as a heading, and a column that vanished with its last
    // card is one the reader cannot put a card back into — so the reader's own emptied pile is
    // drawn, and so are the two fixed zones this format plays with.
    expect(group("Main deck")).toBeInTheDocument();
    expect(within(group("Sideboard")).getByText("0 cards")).toBeInTheDocument();
    expect(within(group("Maybeboard")).getByText("0 cards")).toBeInTheDocument();
    expect(within(group("Sunday brew")).getByText("0 cards")).toBeInTheDocument();
  });

  /**
   * And the other way for a Commander deck, which is the whole reason the format is asked at
   * all: an empty command zone is itself a fact about a deck that needs one — it is where the
   * commander goes, and the deck is not legal until something is in it.
   *
   * The Companion heading stays away even here. Commander's `allows_companion` is true, but the
   * format hands nobody a companion; the reader nominates one, so an empty slot is a heading
   * about a decision that has not been made. It appears with the card — see the test below.
   *
   * Nothing else moved: Commander's `sideboard_max` is 0 and the Sideboard is still the
   * reader's own pile, so it draws for the reason it always did.
   */
  it("draws the empty command zone for a commander deck", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "commander", formatName: "Commander" }, []));

    await open();

    expect(await screen.findByRole("region", { name: "Commander" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Companion" })).not.toBeInTheDocument();
    expect(group("Sideboard")).toBeInTheDocument();
    expect(group("Maybeboard")).toBeInTheDocument();
  });

  /**
   * **A pile holding a card draws whatever the format says**, and that is the rule the two tests
   * above are the exception to rather than the other way round. `drawsWhenEmpty` is asked only
   * about a group with nothing in it, so a Modern deck still carrying a commander and a
   * companion — a deck the reader re-formatted — shows both piles and the cards in them.
   *
   * The editor never hides cardboard: a card nothing draws is a card the reader cannot find,
   * count or take out, and the format check in the header is where a deck is told it is wrong.
   */
  it("draws a commander and a companion holding cards in a format that wants neither", async () => {
    deckGet.mockResolvedValue(
      detail({}, [
        card({ name: "Kenrith", categoryKind: "commander", typeLine: "Legendary Creature" }),
        card({ name: "Lurrus", categoryKind: "companion", typeLine: "Legendary Creature — Cat" }),
      ]),
    );

    await open();

    expect(
      within(await screen.findByRole("region", { name: "Commander" })).getByRole("button", {
        name: /^Kenrith/,
      }),
    ).toBeInTheDocument();
    expect(within(group("Companion")).getByRole("button", { name: /^Lurrus/ })).toBeInTheDocument();
  });

  /**
   * **A pile the app made appears with its first card, and that is the whole of what the reader
   * asked for**: *"Ramp should only show once a ramp card is added."* No filter, no format — an
   * empty `origin: "auto"` pile draws no heading, and an empty pile of the reader's own always
   * does, because they made it on purpose and it is where the next card of that kind goes.
   *
   * **The two fixtures are one letter apart from being interchangeable, and that is the test.**
   * Both are `main`, both are empty, and *both are called something the app itself files cards
   * under* — `Ramp` and `Draw` are two of `AUTO_CATEGORY_NAMES`. Only `origin` differs. A rule
   * that hid empty piles by that name list was considered and rejected for exactly this case: it
   * would hide the reader's own `Draw`, which is the failure "the name is the user's; the kind is
   * what the rules read" exists to prevent. Rust records the provenance at the two creation paths
   * — `category_for_name` on the filing path writes `auto`, `create_category` behind the panel's
   * button writes `user` — and this layer concludes from it.
   *
   * The hidden pile is not an unreachable one: `deck.categories` is untouched, so the toolbar
   * goes on offering it by name, and that select is the route by which it gets its first card and
   * therefore its heading.
   */
  it("draws no heading for an empty auto pile, whatever the pile is called", async () => {
    const user = userEvent.setup();
    const auto = category(6, "Ramp", "main", { origin: "auto" });
    const mine = category(7, "Draw", "main");
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, auto, mine]));

    await open();

    expect(screen.queryByRole("region", { name: "Ramp" })).not.toBeInTheDocument();
    expect(within(group("Draw")).getByText("0 cards")).toBeInTheDocument();
    // Every pile of the deck is still filable-into, drawn or not — the claim is that the list is
    // built from `deck.categories` and not from the drawn groups.
    await openAddTo(user);
    expect(screen.getByRole("option", { name: "Ramp" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Draw" })).toBeInTheDocument();
  });

  /** The other half of the same sentence: with a card in it the auto pile is a pile like any
   *  other — `drawsWhenEmpty` is asked about empty groups only, so nothing here can hide
   *  cardboard whoever made the column it is under. */
  it("draws an auto pile as soon as it holds a card", async () => {
    const auto = category(6, "Ramp", "main", { origin: "auto" });
    deckGet.mockResolvedValue(
      detail(
        {},
        [bolt(), card({ name: "Llanowar Elves", categoryId: 6, categoryName: "Ramp" })],
        [...CATEGORIES, auto],
      ),
    );

    await open();

    expect(
      within(group("Ramp")).getByRole("button", { name: /^Llanowar Elves/ }),
    ).toBeInTheDocument();
  });

  /**
   * **What a filter takes off the screen is auto piles, and it takes them off for being empty
   * rather than for being filtered.** A pile the filter empties *is* empty, so the rule above
   * answers it with no second clause: the wall of twenty headings over three cards was always
   * Removal, Ramp, Draw and the type buckets, and those are gone the moment nothing matches in
   * them. What goes on drawing under a filter is the reader's own deliberate handful, which is
   * exactly what "always shown, unless you delete it" asks for.
   *
   * **This test asserted the reverse until now, and the rule it asserted has been deleted.** PR
   * #56 added `EmptyGroupRules.narrowed`: while a filter ran, `isPredefined` became the test for
   * an empty pile, so the four fixed zones survived and a pile the reader had made and emptied —
   * `Sunday brew` — went with the auto ones. That knob was never the reader's ask and the auto
   * rule subsumes it, so it is gone from `EmptyGroupRules` entirely rather than left unread. The
   * observation that survives from the old doc is the *cost*, which is unchanged and now falls on
   * auto piles alone: the shape of the deck moves as the reader types, and a heading that is not
   * drawn is not a drop target.
   *
   * **Both sides in one test**, because either alone passes against a rule that is simply wrong
   * in the other direction: "the auto pile goes" is satisfied by `narrowed`, and "the user pile
   * stays" is satisfied by a `drawsWhenEmpty` that has stopped hiding anything at all.
   *
   * It stays a fact about the view and never about the deck: `deck.categories` does not change,
   * so the toolbar's "Add to" goes on offering **both** piles by name throughout, and clearing
   * the box brings the heading straight back.
   */
  it("keeps the reader's own empty piles under a filter and drops the app's", async () => {
    const user = userEvent.setup();
    const brew = category(6, "Sunday brew", "main");
    const ramp = category(7, "Ramp", "main", { origin: "auto" });
    deckGet.mockResolvedValue(
      detail(
        {},
        [bolt(), card({ name: "Llanowar Elves", categoryId: 7, categoryName: "Ramp" })],
        [...CATEGORIES, brew, ramp],
      ),
    );

    await open();
    expect(group("Sunday brew")).toBeInTheDocument();
    expect(group("Ramp")).toBeInTheDocument();

    const box = screen.getByLabelText("Filter this deck");
    await userEvent.type(box, "bolt");

    // The reader made it, so it draws — a filter is not a reason to take away a place they chose
    // to keep.
    expect(within(group("Sunday brew")).getByText("0 cards")).toBeInTheDocument();
    // The app made it, and the filter has left nothing in it.
    expect(screen.queryByRole("region", { name: "Ramp" })).not.toBeInTheDocument();
    expect(group("Main deck")).toBeInTheDocument();
    expect(group("Sideboard")).toBeInTheDocument();
    expect(group("Maybeboard")).toBeInTheDocument();
    // Both are still somewhere a card can be filed while one of them is not a heading — the whole
    // reason hiding one is survivable is that no surface a reader files a card with is built
    // from the drawn groups. The per-card "Move…" select made the same point and was removed on
    // 2026-08-14, and the docked panel's "Add to" carried it until 2026-08-15, when the choice
    // became a deck setting; `Add cards to` in the settings dialog is what carries it now, built
    // from the same `deck.categories` the filter never touches.
    await openAddTo(user);
    expect(screen.getByRole("option", { name: "Sunday brew" })).toBeInTheDocument();
    // The auto pile too: its heading is gone from the desk and it is still a place to file a
    // card, which is the half that makes losing the heading survivable.
    expect(screen.getByRole("option", { name: "Ramp" })).toBeInTheDocument();
    // The panel closes on its own Escape rung before the dialog's — one press, one layer — so
    // the dialog's own close button is still there to press next.
    await user.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close deck settings" }));

    await userEvent.clear(box);

    expect(await screen.findByRole("region", { name: "Ramp" })).toBeInTheDocument();
  });

  /** A card is drawn in the group its `categoryId` names, which is the whole of the filing: the
   *  read answers cards and categories, and `grouping.ts` joins them on that id. */
  it("draws a card in the group its category names", async () => {
    deckGet.mockResolvedValue(
      detail({}, [
        card({ name: "Kenrith", categoryKind: "commander", typeLine: "Legendary Creature" }),
      ]),
    );

    await open();

    expect(
      within(await screen.findByRole("region", { name: "Commander" })).getByRole("button", {
        name: /^Kenrith/,
      }),
    ).toBeInTheDocument();
  });

  /**
   * The default view is the stack, and a stacked card is a card frame: a title bar with the
   * count and the cost, the art, and a data line with the printing and its price.
   */
  it("opens the deck as stacked card frames with the printings' facts", async () => {
    const { container } = await open();

    expect(screen.getAllByText("LEA · 161")).toHaveLength(2);
    expect(screen.getByText("$4.50")).toBeInTheDocument();
    // Decoration beside a named button, never an `alt` repeating the card's name.
    expect(container.querySelector('li img[alt=""]')).not.toBeNull();
  });

  /**
   * Zero removes — and on the **Live** list it is `deck_to_collection` that does it, because
   * removing a card from a deck the reader has built is also a statement about where the copies
   * physically are: they go to `Recently removed` in the same transaction.
   *
   * **The row's own `deck_cards.id` and a delta**, which is the one deck command in this app
   * addressed that way; every other one takes the grain and an absolute. The editor looks the
   * row up to supply them, so a wrong lookup would cut a different card — which is why the id
   * is asserted rather than matched loosely.
   *
   * The absolute write is asserted *absent*: `deck_to_collection` decrements the row itself, so
   * sending both would take the copies off the list twice.
   */
  it("removes a card when its stepper reaches zero", async () => {
    const row = bolt({ quantity: 1 });
    deckGet.mockResolvedValueOnce(detail({}, [row])).mockResolvedValue(detail({}, []));

    await open();
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${COPIES}` }));

    expect(deckToCollection).toHaveBeenCalledWith(row.id, 1);
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Lightning Bolt/ })).not.toBeInTheDocument(),
    );
  });

  /**
   * The stepper is controlled by the cache, so a press before the last answer would be computed
   * from the number the last press was computed from: hold `+` on a 4-of and three presses all
   * read 4, all send 5, and the deck lands on 5 instead of 7. The optimistic patch is what makes
   * the second press know about the first — `CollectionPage`'s fix and `WishlistPage`'s, in the
   * third place that needed it.
   */
  it("computes a held-down stepper from the press before it, not from the cache", async () => {
    // Never answers: the only thing that can move the second press's number is the guess.
    deckSetCardQuantity.mockReturnValue(new Promise(() => {}));
    await open();

    const up = screen.getByRole("button", { name: `Increase ${COPIES}` });
    await userEvent.click(up);
    await userEvent.click(up);
    await userEvent.click(up);

    // `c[5]` is the quantity: `finish` joined the address at `c[4]` in schema v18.
    expect(deckSetCardQuantity.mock.calls.map((c) => c[5])).toEqual([5, 6, 7]);
  });

  /**
   * And the guess is rolled back when the write is refused — zero *removes* here, so a refusal
   * that stayed on screen would be a card silently gone from the deck.
   *
   * The re-read that a refusal also triggers is left hanging on purpose: it would put the card
   * back by itself, and a test that cannot tell the rollback from the refetch is a test that
   * passes with no rollback at all.
   */
  it("puts a refused removal back before the re-read answers", async () => {
    // The cut, because this is the Live list — see `removes a card when its stepper reaches
    // zero`. The rollback is the mutation's and does not care which command was refused.
    deckToCollection.mockRejectedValue("The database is busy with a sync — try again.");
    deckGet
      .mockResolvedValueOnce(detail({}, [bolt({ quantity: 1 })]))
      .mockReturnValue(new Promise(() => {}));

    await open();
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${COPIES}` }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument();
  });

  /** The card the caret was on leaves with the last copy. The pile it left is where the reader
   *  is looking, and it announces its own name — the hand-off a move makes. */
  it("hands the caret to the group when a card is stepped away", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt({ quantity: 1 })]));

    await open();
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${COPIES}` }));

    expect(group("Main deck")).toHaveFocus();
  });

  /**
   * **There is no click path to a move any more, and the drag is the whole of it** (2026-08-14).
   *
   * The card carried a native `Move…` `<select>` listing every other pile of the deck; it was
   * removed whole, with a different control expected later. Two tests went with it — the
   * selection itself, and the one pinning that a card is never offered the pile it is already in
   * — and this is what replaces both: the control is gone from the editor, not merely from the
   * view module that drew it.
   *
   * `deck_move_card` is still reached, by a drop; `DeckEditor drag and drop` below is where that
   * is driven, and `dnd.ts` is where the refusals it used to share with the select now live.
   */
  it("offers no move control on a card in the deck", async () => {
    await open();

    expect(screen.queryByLabelText(/^Move Lightning Bolt/)).toBeNull();
    expect(screen.queryByRole("option", { name: "Move…" })).toBeNull();
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /** Three ways to read the same list, and the deck decides which one answers the question in
   *  front of you. The headings are `grouping.ts`'s, in all four views. */
  it("regroups the deck from the toolbar", async () => {
    const user = userEvent.setup();
    await open();
    expect(screen.getByRole("list", { name: "Main deck" })).toBeInTheDocument();

    await pickOption(user, "Group by", "Type");
    expect(screen.getByRole("list", { name: "Instant" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Main deck" })).not.toBeInTheDocument();

    await pickOption(user, "Group by", "Mana value");
    expect(screen.getByRole("list", { name: "Mana value 1" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Instant" })).not.toBeInTheDocument();
  });

  /**
   * The three toolbar pickers, alphabetically — the app-wide rule (`src/lib/options.ts`), applied
   * to lists that already happened to read that way.
   *
   * That coincidence is exactly why this is pinned: `GROUP_BY_OPTIONS` and `SORT_OPTIONS` are
   * written in the order that explains the modes, and the first entry appended to either would
   * land at the end of the dropdown with nothing to notice it. The sequences are asserted whole
   * so the *property* fails, not one position.
   *
   * **`VIEWS` is the one that does not read that way**, so this is the assertion that says the
   * view switch became an option list like the other two rather than a segmented group wearing a
   * select's clothes: `Stacks` is written first because it is the default, and it is drawn third.
   */
  it("offers all three toolbar pickers alphabetically", async () => {
    const user = userEvent.setup();
    await open();

    // One dropdown is open at a time — opening the next closes the last, the same way a native
    // `<select>` never left two panels up at once — so the listbox in scope is always the one
    // just opened.
    const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent);

    await openDropdown(user, "View");
    expect(optionLabels()).toEqual(["Grid", "Stacks", "Table", "Text"]);

    await openDropdown(user, "Group by");
    expect(optionLabels()).toEqual(["Categories", "Mana value", "Type"]);

    await openDropdown(user, "Sort");
    expect(optionLabels()).toEqual(["Alphabetical", "Mana cost", "Price", "Type"]);
  });

  /**
   * The X toggle is a modifier of the Group by select, so it exists exactly where it has
   * something to say.
   *
   * Under Categories and Type there is no curve for it to change: a control that persists
   * across a grouping it has no effect on is one whose scope the reader has to remember. The
   * claim is mostly about the two absences, which nothing else in this file can settle.
   */
  it("offers the X split only while the deck is grouped by mana value", async () => {
    const user = userEvent.setup();
    await open();
    expect(screen.queryByRole("button", { name: SPLIT_X })).not.toBeInTheDocument();

    await pickOption(user, "Group by", "Mana value");
    expect(screen.getByRole("button", { name: SPLIT_X })).toBeInTheDocument();

    await pickOption(user, "Group by", "Type");
    expect(screen.queryByRole("button", { name: SPLIT_X })).not.toBeInTheDocument();
  });

  /**
   * **The switch is the deck's, not the editor's** — `decks.separate_x_group`, written through
   * the same `update` the header's rename and format select write.
   *
   * A `useState` here would look identical for one session and lose the reader's answer the
   * moment they closed the deck, which is the one thing a per-deck reading preference exists to
   * avoid. So the assertion is on the *write*: nothing about this control is local.
   */
  it("writes the X split onto the deck rather than holding it in the editor", async () => {
    const user = userEvent.setup();
    await open();
    await pickOption(user, "Group by", "Mana value");

    await userEvent.click(screen.getByRole("button", { name: SPLIT_X }));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { separateXGroup: true }));
  });

  /** And it is drawn from the deck the read answered with — a chip whose pressed state came from
   *  anywhere else would disagree with the columns beside it after any other window changed the
   *  deck. */
  it("draws the X split pressed for a deck that carries it", async () => {
    deckGet.mockResolvedValue(detail({ separateXGroup: true }, [bolt()]));

    const user = userEvent.setup();
    await open();
    await pickOption(user, "Group by", "Mana value");

    const chip = screen.getByRole("button", { name: SPLIT_X });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    // Never the `disabled` attribute, which would take it out of the tab order: the caret can
    // land on it whichever way it is set, and a keyboard reader hears the state from
    // `aria-pressed`.
    expect(chip).toBeEnabled();
    await userEvent.click(chip);
    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { separateXGroup: false }));
  });

  /** The order *inside* a heading, which the grouping does not decide. Alphabetical by default,
   *  because a decklist is read by name. */
  it("sorts inside each group from the toolbar", async () => {
    const user = userEvent.setup();
    await open();
    // The **stack**, not the whole section: the heading above it carries a button of its own —
    // the grip a pile is dragged past its neighbours by — and a section-wide sweep would read
    // that as the first card. The list is what the order is a claim about anyway.
    const names = () =>
      within(screen.getByRole("list", { name: "Main deck" }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));

    expect(names()[0]).toMatch(/^Bear/);

    await pickOption(user, "Sort", "Price");

    // Dearest first, which is what a money column means everywhere else in this app.
    expect(names()[0]).toMatch(/^Lightning Bolt/);
  });

  /** One deck, four ways of looking at it. The switch says which, and every one of them draws
   *  the same headings from the same `CardGroup[]`. */
  it("draws the deck in whichever of the four views is chosen", async () => {
    const user = userEvent.setup();
    await open();

    // The trigger's own content is the picked view — a Dropdown's `<button>` has no `.value`,
    // so what a segmented group said with a colour and a `<select>` said with `.value` this
    // says in its own visible text.
    expect(screen.getByRole("button", { name: "View" })).toHaveTextContent("Stacks");

    await pickOption(user, "View", "Table");
    expect(screen.getByRole("table", { name: "This deck" })).toBeInTheDocument();

    await pickOption(user, "View", "Text");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ }),
    ).toBeVisible();

    await pickOption(user, "View", "Grid");
    expect(
      within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ }),
    ).toBeVisible();

    await pickOption(user, "View", "Stacks");
    expect(screen.getByRole("list", { name: "Main deck" })).toBeInTheDocument();
  });

  /**
   * The deck's own filter, which narrows the rows **before** they are grouped — so a heading's
   * count is a count of what is under it. A heading saying 6 over one visible card is a heading
   * lying about the only thing it is for.
   */
  it("filters the deck by name, and the headings count what is left", async () => {
    await open();

    await userEvent.type(screen.getByLabelText("Filter this deck"), "bolt");

    const main = group("Main deck");
    expect(within(main).getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: /^Bear/ })).not.toBeInTheDocument();
    expect(within(main).getByText("4 cards")).toBeInTheDocument();
  });

  /** The deck's own labels, as filters. Nothing at all for a deck with no labels — an empty group
   *  with a name is a control that says there is something to press. */
  it("offers no label filter to a deck with no labels", async () => {
    await open();

    expect(screen.queryByRole("group", { name: "Filter by label" })).not.toBeInTheDocument();
  });

  it("filters by label", async () => {
    deckGet.mockResolvedValue(
      detail(
        {},
        [bolt({ labelId: 7, labelName: "Wincon", labelColor: "gold" }), card({ name: "Bear" })],
        CATEGORIES,
        [{ id: 7, name: "Wincon", color: "gold", cardCount: 4 }],
      ),
    );

    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Wincon" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /^Bear/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument();
  });

  /**
   * What the deck adds up to, over the same rows the view is drawn from — one query, so a curve
   * and a legality panel can never disagree. A band at the foot of the page rather than an aside
   * beside the deck, and **nothing puts it away**: there is no toggle, because a block that
   * takes no width off the desk row is a block nobody has to trade anything for.
   */
  it("adds the deck up in a band under the deck", async () => {
    await open();

    const stats = screen.getByRole("region", { name: "Deck stats" });
    // Four Bolts and two Bears, both nonlands, both mana value 1.
    expect(
      within(within(stats).getByRole("list", { name: "Mana curve" })).getByText(
        "6 cards at mana value 1",
      ),
    ).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Stats" })).not.toBeInTheDocument();
  });

  /**
   * **The five figures are the header's ledger and are drawn exactly once** (2026-08-24). They
   * were the band's `FigureRow` until then, under two screens of deck — the wrong end of the page
   * for the numbers a reader edits against — and both surfaces derive them from `deckStats` over
   * the same rows, so moving them could only ever have left a duplicate rather than a
   * disagreement. The absence below is what pins that it did not.
   */
  it("heads the deck with a ledger of what it adds up to, and draws it once", async () => {
    await open();

    // Four Bolts and two Bears, none of them lands.
    const cards = screen.getByText("Cards", { selector: "dt" });
    expect(cards.closest("div")).toHaveTextContent("6");
    expect(screen.getAllByText("Cards", { selector: "dt" })).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Deck stats" })).queryByText("Cards"),
    ).not.toBeInTheDocument();
  });

  /**
   * Under the deck means **under the price strip too**, which is where the remove tray is drawn
   * for the length of a drag. A band between the two would put four charts between a card and
   * the one drop that takes it out of the deck, so the order of these three is a fact about the
   * drag rather than about the charts.
   */
  it("draws the stats band below the deck and the price strip", async () => {
    await open();

    const stats = screen.getByRole("region", { name: "Deck stats" });
    const asOf = screen.getByText(/prices as of the last/i);
    // `DOCUMENT_POSITION_FOLLOWING` — the band comes after the as-of line in document order,
    // which in this one flex column is after it on screen.
    expect(asOf.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * A card opens in the pane the app already docks — **and it says which slot the card came out
   * of.** The pane offers to swap that slot's printing, which is a write addressed by deck,
   * category, card *and variant*, so a click here is the one place in the app that writes a
   * `paneDeckContext` and all four parts travel with it. The category's **name** goes because
   * the pane has no category list to look one up in; the **variant** because a deck is two lists
   * and a swap sent to the wrong one either misses or rewrites a row nobody is looking at.
   */
  it("opens the card from the deck, as a row of this deck", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

    expect(useAppStore.getState().selectedCardId).toBe("c-Lightning Bolt");
    expect(useAppStore.getState().paneDeckContext).toEqual({
      deckId: 4,
      categoryId: MAIN,
      categoryName: "Main deck",
      cardId: "c-Lightning Bolt",
      variant: "live",
      // The fifth part of the slot: the pane's swap and its foil button both write to one of
      // the two rows a pile can hold of this printing.
      finish: null,
    });
  });

  /**
   * The other card surface in this view, and the one that must *not* leave a deck context: a
   * tile in the docked panel is a card the deck does not have, so the pane it opens has no slot
   * to offer to rewrite. It goes through `setSelectedCardId`, which clears the context in the
   * same write — the property this asserts is the store's, and this is where it can be seen
   * happening between two surfaces one screen apart.
   */
  /**
   * **One card at a time, and a printing in two piles is two cards** — the reported defect, at
   * the seam that produced it.
   *
   * `views.test.tsx` pins the four views against a slot they are handed; this pins what the
   * editor *hands* them. The mark used to be `selectedCardId` read straight off the store, so a
   * click on the Main deck's Bolt also marked the Sideboard's — and in Stacks, which is the view
   * under test here, stood a card clear of two piles from one press. `paneDeckContext` is where
   * the answer already was: it is the store's own record of which row the card came out of.
   *
   * Named by the slot in the DOM as well as counted, because a count of 1 would also pass if the
   * mark had landed on the *wrong* copy.
   */
  it("marks one copy when the deck holds the card in two piles", async () => {
    deckGet.mockResolvedValue(
      detail({}, [bolt(), bolt({ categoryKind: "side", categoryId: SIDE, quantity: 1 })]),
    );

    await open();
    // The fixture is the claim: two drawn copies, or the count below passes for want of a
    // second card rather than because the rule is right.
    //
    // `*=` rather than `$=`: a slot ends in its **finish** since v18 (`c-Lightning Bolt:` for
    // the regular copy), so a suffix match on the card id stopped matching anything at all —
    // which would have made this fixture check pass vacuously at zero had it been a `>=`.
    expect(
      document.querySelectorAll(`[${DECK_CARD_ATTR}*="c-Lightning Bolt"]`),
    ).toHaveLength(2);

    await userEvent.click(
      within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ }),
    );

    const marked = [...document.querySelectorAll(`[${SELECTED_ATTR}]`)];
    expect(marked).toHaveLength(1);
    expect(marked[0].querySelector(`[${DECK_CARD_ATTR}]`) ?? marked[0]).toHaveAttribute(
      DECK_CARD_ATTR,
      deckCardSlot(MAIN, "c-Lightning Bolt", null),
    );
  });

  /**
   * **A card opened from anywhere that is not a row of this deck marks no row of it**, which is
   * the deliberate second half of the change above.
   *
   * The panel's tiles go through `setSelectedCardId`, which clears `paneDeckContext` in the same
   * write — so there is no slot, and nothing is picked. The rule this replaced marked the deck's
   * copy by `cardId`, which sounds like a courtesy and is the reported defect reached by a
   * different gesture: a panel tile for a card the deck holds in two piles lit up both. There is
   * no one slot to pick here, so the honest answer is none.
   *
   * The panel is searched for a card the deck already holds, which is the only shape of this
   * that could ever have marked anything.
   */
  it("marks no deck row for a card opened from the docked panel", async () => {
    searchCards.mockResolvedValue({
      items: [found("Lightning Bolt")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    expect(document.querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(1);

    await openSearchPanel();
    const panel = screen.getByRole("region", { name: "Add cards" });
    await userEvent.click(await within(panel).findByRole("button", { name: /^Lightning Bolt/ }));

    expect(useAppStore.getState().paneDeckContext).toBeNull();
    expect(document.querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(0);
  });

  /**
   * **A card opened from the deck outlives the deck going away under it.**
   *
   * The pane that used to draw this sentence was the editor's own — a sticky overlay over one of
   * the desk's two columns (issue #183), and the structural claim was that its frame was a
   * sibling of the desk row rather than a child, so unmounting the row left the card standing.
   * The card is an `App`-level modal since 2026-09-03 and is not in this tree at all, so what is
   * left here is the half this file can still see: the editor stops painting a deck that is gone
   * and **does not clear the reader's card on the way**.
   *
   * That is not nothing — `setSelectedCardId(null)` is one line away in three handlers in this
   * file — and it is the state `App.test.tsx`'s refused-swap case is built on top of.
   */
  it("keeps the reader's card when the deck read says the deck is gone", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await waitFor(() => expect(useAppStore.getState().selectedCardId).not.toBeNull());

    // The deck goes, and the editor's own re-read is what tells it. Any deck write would do it;
    // the name field is the cheapest one left in this header.
    deckGet.mockResolvedValue(null);
    await writeToDeck();

    expect(
      await screen.findByText(/this deck is not there any more\. it may have been deleted/i),
    ).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).not.toBeNull();
  });

  it("opens a panel tile as a card and not as a row of this deck", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    expect(useAppStore.getState().paneDeckContext).not.toBeNull();

    await openSearchPanel();
    await userEvent.click(await screen.findByRole("button", { name: /^Goblin Guide/ }));

    expect(useAppStore.getState().selectedCardId).toBe("s-Goblin Guide");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **Putting the card down.** A click on the desk — the gap between two piles, a group's
   * padding, the blank under a short column — clears the selection, which is also what closes
   * the pane, because the gold ring on the card and the pane beside it are one fact.
   *
   * The click lands on the group's own section, which is exactly what a reader hits when they
   * mean nothing at all.
   */
  it("puts the card down when the reader clicks the desk", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    expect(useAppStore.getState().selectedCardId).toBe("c-Lightning Bolt");

    await userEvent.click(group("Main deck"));

    expect(useAppStore.getState().selectedCardId).toBeNull();
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **…and never by the press that picked one up**, which is the whole reason the rule tests
   * what was clicked rather than simply clearing on every click.
   *
   * A card's own press and the editor's listener run in the *same* event, the card's first — so
   * without the test the second card would be selected and then immediately unselected, and the
   * editor would answer `null` to a reader who had just clicked a card. Two cards rather than
   * one, because the handler reads the selection it had *before* the click: from nothing to a
   * card, the early return hides the bug.
   */
  it("moves the selection to the next card rather than clearing it", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Bear/ }));

    expect(useAppStore.getState().selectedCardId).toBe("c-Bear");
  });

  /**
   * **Where the card landed, marked for five seconds.**
   *
   * The add is made in the docked panel and the card lands somewhere in a deck the reader is not
   * looking at, which is the whole reason the mark exists. It is keyed by the **row** the write
   * answered with (`EntryChange.id`) rather than by the printing, because `deck_add_card` folds:
   * a second copy of a card the deck already holds is the row that is already there, and that is
   * the row worth pointing at.
   */
  it("marks the row an add landed in", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    deckAddCard.mockResolvedValue({ id: 99, quantity: 1, removed: false });

    await open();
    await openSearchPanel();
    // What the deck reads back as once the add has been written — the same row id the write
    // answered with, which is what ties the two together.
    deckGet.mockResolvedValue(
      detail({}, [
        bolt(),
        { ...card({ name: "Goblin Guide", typeLine: "Creature — Goblin" }), id: 99 },
      ]),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    );

    const landed = await waitFor(() => {
      const marks = document.querySelectorAll(`[${LANDED_ATTR}]`);
      expect(marks).toHaveLength(1);
      return marks[0];
    });
    expect(landed.closest(`[${CARD_BODY_ATTR}]`)?.textContent).toContain("Goblin Guide");
  });

  /**
   * The fastest way to put a card in a deck whose name you already know — one search for the
   * best match's newest printing, then the same `deck_add_card` the panel's button sends.
   *
   * **Where it lands is the card's own type line**, because "Add to" defaults to
   * `AUTO_CATEGORY`: no `categoryId` and the name `autoCategoryFor` answers, which
   * `deck_add_card` finds or creates. `found()` is a `Creature — Goblin`, so the pile is
   * `Creature` — and the deck fixture has no such category, which is the case worth driving:
   * an auto add may have to *make* the pile it names.
   */
  it("adds the best match for a typed name, filed by its type line", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.type(screen.getByLabelText("Quick add a card"), "goblin guide{Enter}");

    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", null, "Creature", "live", null, 1),
    );
    // Cleared on a hit, because the next action is the next card.
    expect(screen.getByLabelText("Quick add a card")).toHaveValue("");
  });

  /**
   * …and a deck whose settings name a pile overrides the rule, which is the other half of it: a
   * reader filing ten cards into the Sideboard makes one choice and then ten presses, and every
   * press sends the **id** with no name at all.
   *
   * **The choice arrives on the deck row** (`defaultCategoryId`) rather than from a control in
   * this editor, which is the whole of what moved on 2026-08-15: it was a `useState` here, set
   * from a select in the docked search panel, so it survived neither closing the deck nor the
   * reader looking for it anywhere a *setting* would be.
   */
  it("sends the deck's default category instead when it names one", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    deckGet.mockResolvedValue(detail({ defaultCategoryId: SIDE }, [bolt()]));

    await open();
    await userEvent.type(
      screen.getByLabelText("Quick add a card to Sideboard"),
      "goblin guide{Enter}",
    );

    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", SIDE, null, "live", null, 1),
    );
  });

  /** A miss is said in words rather than swallowed, and the field keeps what was typed —
   *  because the next action there is to correct it. */
  it("says when a quick add finds nothing, and keeps what was typed", async () => {
    await open();

    await userEvent.type(screen.getByLabelText("Quick add a card"), "Blakc Lotus{Enter}");

    expect(await screen.findByText("No card found for “Blakc Lotus”.")).toBeInTheDocument();
    expect(deckAddCard).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Quick add a card")).toHaveValue("Blakc Lotus");
  });

  /**
   * The half of the Escape protocol a component test would never think to check, and the
   * running app found in a minute: with no layer open, the press has to reach the **window**,
   * because that is where every rung below this editor's own controls listens.
   *
   * React's synthetic `stopPropagation` stops the *native* event at the root container — so a
   * cell that stops `keydown` to keep Enter off its row also stops every Escape pressed inside
   * it from ever leaving the app's own tree. Nothing below could then be closed from a card or a
   * toolbar field at all, and nothing on screen would say why.
   *
   * **What arrives at `window` is now consumed rather than free, and that is the change rather
   * than a weakening.** The editor registers a `"navigation"` rung — Escape closes the deck —
   * and it is a bubble listener registered when this editor mounted, which is before the probe
   * below. So the probe hearing `true` three times says both halves at once: the press reached
   * `window` (nothing in React's tree ate it) and something already on `window` spent it. Which
   * something is the second assertion's job — `openDeckId` back to `null` is the floor acting,
   * and it is re-armed between presses so each of the three entry points is proved on its own
   * rather than by the first one that worked.
   */
  it("lets Escape reach the window from every field, where the deck's own floor takes it", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    const closed: (number | null)[] = [];
    const press = async (from: HTMLElement) => {
      // Re-armed rather than read once at the end: a single `null` at the end would be satisfied
      // by *any* one of the three presses having worked.
      useAppStore.setState({ openDeckId: 4 });
      from.focus();
      await userEvent.keyboard("{Escape}");
      closed.push(useAppStore.getState().openDeckId);
    };

    await press(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await press(screen.getByLabelText("Quick add a card"));
    // The name field is the third way in, and the one that *does* consume a press — but only
    // while it is holding something to revert, which it is not here.
    await press(screen.getByLabelText("Deck name"));

    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([true, true, true]);
    expect(closed).toEqual([null, null, null]);
  });

  /**
   * **Escape closes the deck, and it closes it the way the back button does.**
   *
   * The two assertions are one claim: not merely that `openDeckId` went to `null`, but that
   * `returnToDeckId` was written with it — that note is the whole of the hand-back, and
   * `DecksPage` reads it to open the folder the deck is filed in and put the caret on its tile.
   * A close that dropped it would land the reader on the top level with the caret on `<body>`,
   * which looks like working software until they try to press anything.
   *
   * Both routes are driven in one case on purpose: the point is that they are the *same*
   * callback, so a test that only pressed the key could not tell a shared one from a copy that
   * agrees today.
   */
  it("closes the deck on Escape, exactly as the back button does", async () => {
    await open();

    screen.getByRole("button", { name: /^Lightning Bolt/ }).focus();
    await userEvent.keyboard("{Escape}");
    const byKey = useAppStore.getState();

    useAppStore.setState({ openDeckId: 4, returnToDeckId: null });
    await userEvent.click(screen.getByRole("button", { name: "Back to decks" }));
    const byButton = useAppStore.getState();

    expect([byKey.openDeckId, byKey.returnToDeckId]).toEqual([null, 4]);
    expect([byButton.openDeckId, byButton.returnToDeckId]).toEqual([null, 4]);
  });

  /**
   * **The deck's own filter box owns one press while it has something to empty, and the deck
   * closes on the next one.**
   *
   * This is the hazard the `"navigation"` rung arrived with rather than a nicety on top of it:
   * Chromium clears an `<input type="search">` on Escape by itself and does **not** set
   * `defaultPrevented`, so without the field's own handler one press would empty the box *and*
   * close the deck the reader was filtering. jsdom implements no native clear, so the half this
   * suite can see is the half that matters — the field consuming the press and the box coming
   * out empty by the app's own hand.
   */
  it("empties the deck filter on Escape before the deck itself can close", async () => {
    await open();

    const box = screen.getByRole("searchbox", { name: "Filter this deck" });
    await userEvent.type(box, "bolt");
    expect(box).toHaveValue("bolt");

    await userEvent.keyboard("{Escape}");

    expect(box).toHaveValue("");
    expect(useAppStore.getState().openDeckId).toBe(4);

    // …and the next press is the deck's, because an empty box owns nothing.
    await userEvent.keyboard("{Escape}");

    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  describe("undo and redo", () => {
    /** The glyph says nothing, so the accessible name is the whole sentence — and it is the
     *  same sentence the history drawer draws, out of `auditText` rather than written here. */
    it("names the change each button would reverse", async () => {
      await open();

      await screen.findByRole("button", { name: "Undo — Removed 2 × Lightning Bolt" });
      // Nothing has been undone in this session, so the other half is the bare verb.
      expect(screen.getByRole("button", { name: "Redo" })).toBeInTheDocument();
    });

    it("undoes on Ctrl+Z and redoes on Ctrl+Y and Ctrl+Shift+Z", async () => {
      // The backend's actual contract rather than two canned answers: the redo half is
      // answered **for the id the webview hands in**, because the redo stack lives in the page
      // and dies with the window. Modelling that is what makes the press order below real.
      deckUndoState.mockImplementation((_deckId: number, redoId: number | null) =>
        Promise.resolve(
          redoId === null ? { undo: UNDOABLE, redo: null } : { undo: null, redo: UNDOABLE },
        ),
      );
      await open();
      await screen.findByRole("button", { name: /^Undo —/ });

      await userEvent.keyboard("{Control>}z{/Control}");
      await waitFor(() => expect(deckUndoApply).toHaveBeenCalledWith(4, 77));

      // Both spellings, because both are what a reader's hands know: Ctrl+Y is Windows' and
      // Ctrl+Shift+Z is everywhere else's, and this app ships to people who use both.
      await screen.findByRole("button", { name: /^Redo —/ });
      await userEvent.keyboard("{Control>}y{/Control}");
      await waitFor(() => expect(deckRedoApply).toHaveBeenCalledWith(4, 77));

      deckRedoApply.mockClear();
      await userEvent.keyboard("{Control>}z{/Control}");
      await waitFor(() => expect(deckUndoApply).toHaveBeenCalledTimes(2));
      await screen.findByRole("button", { name: /^Redo —/ });
      await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
      await waitFor(() => expect(deckRedoApply).toHaveBeenCalledWith(4, 77));
    });

    /**
     * **The one that keeps the editor usable.** Ctrl+Z inside a text field is the browser's own
     * undo — the only thing that can put back a character the reader just typed — and a
     * shortcut that swallowed it would take that away in the quick-add box, the deck name and
     * the notes. `isTextField` is `useContextMenu`'s, the same predicate the native
     * context-menu carve-out turns on.
     */
    it("leaves Ctrl+Z to the browser when the caret is in a text field", async () => {
      await open();
      await screen.findByRole("button", { name: /^Undo —/ });

      screen.getByLabelText("Quick add a card").focus();
      await userEvent.keyboard("{Control>}z{/Control}");
      screen.getByLabelText("Deck name").focus();
      await userEvent.keyboard("{Control>}z{/Control}");

      expect(deckUndoApply).not.toHaveBeenCalled();
    });

    /** `aria-disabled`, never the attribute: this greys and un-greys as the reader edits, and a
     *  `disabled` button drops out of the tab order under a caret sitting on it. */
    it("greys rather than disables a button with nothing to do", async () => {
      deckUndoState.mockResolvedValue({ undo: null, redo: null });
      await open();

      const undoButton = await screen.findByRole("button", { name: "Undo" });
      expect(undoButton).toHaveAttribute("aria-disabled", "true");
      expect(undoButton).not.toBeDisabled();

      await userEvent.click(undoButton);
      expect(deckUndoApply).not.toHaveBeenCalled();
    });

    /** A refusal goes in the banner the editor's other refused writes already use, rather than
     *  a second line of its own — see `bannerFailure`. */
    it("reports a refused undo in the deck's own banner", async () => {
      deckUndoApply.mockRejectedValue("That is not the most recent change any more.");
      await open();
      await screen.findByRole("button", { name: /^Undo —/ });

      await userEvent.keyboard("{Control>}z{/Control}");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Could not change this deck/);
      expect(alert).toHaveTextContent(/most recent change/);
    });
  });

  /**
   * The other side of it: a field that has been typed in owns one press, and one only. The
   * second belongs to whatever is open behind it — otherwise a reader who half-typed a name and
   * pressed Escape twice would find the second press had gone nowhere, with nothing on screen to
   * say why.
   *
   * **`fireEvent`'s answer stopped being able to tell the two apart, so the store is what
   * separates them now.** It reports `false` whenever *something* consumed the press, and since
   * the editor took a `"navigation"` rung both presses are consumed — the first by the field,
   * the second by the floor. The evidence for "one and only one" is therefore that the deck is
   * still open after the first and closed after the second: a field that ate both would leave
   * `openDeckId` at 4 throughout, and a field that ate neither would close the deck on the
   * first press and never revert the name.
   */
  it("spends exactly one Escape on reverting the name", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday");
    // Back to back in one tick, which is what a held key sends: `fireEvent` answers `false`
    // when the press was consumed. Read off the state rather than the ref, the second press
    // sees a draft React has not cleared yet and eats a press it has nothing to spend.
    const first = fireEvent.keyDown(name, { key: "Escape" });
    const afterFirst = useAppStore.getState().openDeckId;
    const second = fireEvent.keyDown(name, { key: "Escape" });

    expect([first, second]).toEqual([false, false]);
    // The field spent the first press and nothing behind it moved…
    expect(afterFirst).toBe(4);
    // …and the second went past it, to the floor.
    expect(useAppStore.getState().openDeckId).toBeNull();
    expect(name).toHaveValue("Burn");
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * The path by which cards enter a deck. Docked rather than a dialog, so the deck it is
   * filling stays on screen next to it.
   */
  it("docks a card search beside the deck and adds what it finds", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await openSearchPanel();
    // The button names the pile it computed, so a reader knows where the press lands before
    // making it — `Creature`, off this card's type line.
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", null, "Creature", "live", null, 1);
  });

  /**
   * **Every add this editor makes is `deck_add_card`, and none of them moves a copy** —
   * the deleted own/need pair's other half, asserted where it would come back (2026-08-25).
   *
   * A press on the panel's Add button was one of two writes for two days: `deck_add_card`, which
   * writes a list row that reads as *missing*, or `collection_to_deck`, which took a copy out of
   * the reader's binder. The second is the Collection tab's now, where the copy being taken is on
   * screen and a spoken-for one is confirmed by name first — so what this asserts is not that a
   * control is missing (`DeckSearchPanel.test.tsx` owns that) but that the **command** it used to
   * reach is unreachable from this side of the desk.
   *
   * Both paths the pair governed, because they were one answer: the panel's Add button and the
   * toolbar's quick-add field.
   */
  it("adds through the list write alone, from the panel and the quick-add field", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await openSearchPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    );
    await waitFor(() => expect(deckAddCard).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText("Quick add a card"), "goblin guide{Enter}");
    await waitFor(() => expect(deckAddCard).toHaveBeenCalledTimes(2));

    // The write that took a copy out of the binder, and the read the hunt for one began with.
    expect(collectionToDeck).not.toHaveBeenCalled();
    expect(collectionAdd).not.toHaveBeenCalled();
  });

  /** Every category the deck has, in the order the groups are drawn — one list, one source —
   *  behind the one option that is not a category and is the default. Read from **deck
   *  settings**, which is where the question is asked since 2026-08-15. */
  it("offers auto first, then every category, as add targets", async () => {
    const user = userEvent.setup();
    await open();

    await openAddTo(user);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Auto (by what it does)",
      "Main deck",
      "Sideboard",
      // Modern requires no commander, and the group and the option are here anyway: a category
      // is data the user made, not a slot the format implies.
      "Commander",
      "Companion",
      // Seeded switched off, and offered like any other: `isActive` decides what a pile counts
      // toward and never whether a card may be filed into it.
      "Maybeboard (off)",
    ]);
    // The default, and the whole of the fix that came with the sentinel: it used to be
    // `categories[0]`, which on a deck with no user category of its own is the seeded
    // **Commander** pile. The trigger's own text is the read now — a `Dropdown` has no `.value`.
    expect(screen.getByRole("button", { name: "Add cards to" })).toHaveTextContent(
      "Auto (by what it does)",
    );
  });

  /**
   * A category can leave the deck under an open editor — deleted from another window, or
   * renamed away — and an editor left filing into an id no pile answers to would write every add
   * into a group nothing is drawing.
   *
   * The fallback is **auto** rather than another category: the reader's choice is gone, so the
   * honest replacement is "nobody has said", not somebody else's first column.
   *
   * **It is a read now rather than the repairing write it was**, and that is what the move to a
   * deck column bought: the backend puts every deck filing by a deleted pile back to `0` in the
   * transaction that deletes it, so what is left for this layer is the single commit where the
   * row and the category list disagree. Reading it as Auto there is not a repair, it is where
   * the deck already is.
   */
  it("falls back to auto when the category it was filing into leaves the deck", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    deckGet.mockResolvedValue(detail({ defaultCategoryId: SIDE }, []));

    await open();
    await openSearchPanel();
    await screen.findByRole("button", { name: "Add Goblin Guide to Sideboard" });

    // The same deck, one category short — and it is the one the row still points at, which is
    // exactly the half-commit the read-side fallback is for.
    deckGet.mockResolvedValue(
      detail(
        { defaultCategoryId: SIDE },
        [],
        CATEGORIES.filter((c) => c.id !== SIDE),
      ),
    );
    await writeToDeck();

    // Read off the Add button, which is where the answer is visible: `Creature` is what
    // `autoCategoryFor` makes of this card, so the editor is on Auto.
    expect(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    ).toBeInTheDocument();
  });

  /**
   * The docked panel's `Format` narrows what the search *offers* and writes nothing; what the
   * deck **is** is a word on the ledger and a control in Deck settings.
   *
   * **The editor drew two format controls until 2026-08-24 and the three tests below read both**,
   * so that a rename collapsing the two names into one failed here rather than passing by
   * matching whichever the query reached first. There is one control called `Format` on this
   * screen now, which retires the ambiguity rather than the tests: each still reads the deck's own
   * format off the ledger beside the filter, which is the pair that could disagree.
   */
  it("opens the docked panel's format filter on the deck's own format", async () => {
    await open();
    // The panel comes up collapsed (2026-08-14) and the filter row is inside `OpenPanel`, so
    // there is no Format select to read until the disclosure is pressed. The seed is applied
    // when the search mounts, which is that press — so "opens on" is literally what this
    // asserts rather than a state the editor arranged in advance.
    await openFilterTray();
    await seeded("Modern");

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
    expect(screen.getByText("Format", { selector: "dt" }).closest("div")).toHaveTextContent(
      "Modern",
    );
  });

  /**
   * **The fence, and the case it exists for.** `casual` is what every deck is born in, and it is
   * one of the two `format_specs` rows seeded `has_legality_data = 0` — `legalities` carries no
   * key for it, so `filters.rs` looks it up in `legalities::bit()`, finds nothing and pushes the
   * literal SQL `0`. That is *no rows*, deliberately, so an unknown format cannot quietly answer
   * with the whole corpus — which means a panel defaulted to `casual` would draw an empty wall
   * with nothing on screen saying why, on the commonest deck there is.
   *
   * The deck is still Casual and the header still says so: what the fence decides is only what
   * the *filter* opens on, and `Any format` is a working panel the reader can narrow themselves.
   */
  it("opens on Any format for a deck whose format has no legality data", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "casual", formatName: "Casual" }, [bolt()]));
    await open();
    await openFilterTray();
    await seeded("Casual");

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    expect(screen.getByText("Format", { selector: "dt" }).closest("div")).toHaveTextContent(
      "Casual",
    );
  });

  /**
   * The other `null` spec, and it answers the same way. `historic` here is a key **this
   * fixture's `PICKER` does not carry**, standing in for one the seed has lost: `decks.format_key`
   * is deliberately not a foreign key, so a deck whose format left the seed is a state that can
   * exist and must still open. (The real seed does carry `historic`, and a Historic deck in the
   * shipped app opens on Historic — what is being driven here is `formatSpecFor` answering
   * `null`, whatever made it do so.) There is no `hasLegalityData` cell to read then — and
   * inferring one from the key would be this file guessing at what the database can answer — so
   * the panel opens unfiltered rather than on a filter nothing behind it has heard of.
   *
   * **This is the one test `seeded` cannot gate**, and the reason is the state it is about: there
   * is no spec for this deck, so the ledger's check button — the thing that says a spec has
   * arrived — is never drawn at all. Nothing is lost by waiting on the ledger's own `Format` term
   * instead, because the fence's answer here is `Any format` before the seed lands and after it:
   * the wait was never what made the assertion true. What that term reads is a second claim worth
   * having — with no spec to name the ruleset, it falls back to the deck row's own `formatName`.
   */
  it("opens on Any format for a deck whose format the seed does not carry", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "historic", formatName: "Historic" }, [bolt()]));
    await open();
    await openFilterTray();
    await screen.findByText("Historic");

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Any format");
    expect(screen.queryByRole("button", { name: /issues? ·|No issues ·/ })).not.toBeInTheDocument();
  });

  /**
   * **A format the filter row's own list has never carried, driven the whole way** — editor to
   * panel to `FilterBar`. `gladiator` is a seeded `format_specs` row with legality data behind
   * it and is not one of `FORMATS`' seven, which is the ordinary case for a deck: the deck picker
   * offers every enabled row and this filter offers seven keys.
   *
   * So the trigger can only read `Gladiator` because the hook folded the default into its own
   * option list. Without that the value would match no option, and `Dropdown` draws its own
   * em-dash placeholder for an unmatched value rather than falling back to the first row while
   * still reporting the old one — so the panel would read as showing nothing over a wall already
   * narrowed to Gladiator. The assertion is made for that reason: the trigger's own text is the
   * whole of what the reader sees.
   */
  it("draws a deck format the filter row's own list has never carried", async () => {
    deckGet.mockResolvedValue(
      detail({ formatKey: "gladiator", formatName: "Gladiator" }, [bolt()]),
    );
    await open();
    // The filter row lives in `OpenPanel`, which mounts on the disclosure press (2026-08-14),
    // and the Format control is one press further in — inside the row's own filter tray.
    await openFilterTray();
    await seeded("Gladiator");

    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Gladiator");
  });

  /**
   * Three docked columns do not fit in a 1024px window — sidebar, page padding, the card pane
   * and the panel come to 1044 before the deck gets a pixel — and the deck was measured at
   * **2px** before this existed, which reads as a rendering fault rather than as a squeeze. The
   * narrowest thing gives way first.
   *
   * 376 is what a 1024px window leaves this row with the card pane docked beside the view
   * (measured at 361 once the page's own scrollbar is out); **414** is `DECK_FLOOR` plus the
   * panel's *minimum* and the `gap-4` between them — the exact width at which both fit again, so
   * the pair of tests pins the floor to the pixel.
   *
   * **414 rather than 592, since the panel became draggable** (2026-08-14). The threshold was
   * `DECK_FLOOR` plus the panel's one fixed width, 192 + 384 + 16; a panel with a range is asked
   * whether its *narrowest* useful width fits instead — `MIN_PANEL_WIDTH_PX` (206), one card and
   * its chrome — which is 192 + 206 + 16. Across the 178px between the two the panel now draws
   * squeezed rather than railing, and at 414 exactly the deck sits on its floor to the pixel.
   * (592 while the panel was fixed; 608 while `DECK_FLOOR` was 208, and 604 in the previous
   * editor, whose desk row was `gap-3`.)
   *
   * `desk()` patches `HTMLElement.prototype.clientWidth`, which `document.documentElement`
   * inherits — so the window reads as the same number, and the half-of-it cap on the panel's
   * drag is `floor(414/2)` = 207, one pixel *above* what the deck's floor allows. Which cap
   * binds is therefore the deck's at these widths, and that is the one this pair is about; the
   * other has a test of its own below.
   *
   * **What 376 no longer means is a refusal** (2026-08-29). It means the panel is not *docked*:
   * it is drawn over the deck instead, at the desk's own width, so the door out of the rail is
   * the whole of what this width now shows. The refusal survives for the one desk that can hold
   * the panel neither way — a card pane already covering the deck — which is the second half of
   * this test and the only place its sentence is still true.
   */
  it("draws the search over the deck where the two cannot both fit, and refuses only where neither will", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    const restore = desk(376);
    try {
      await open();

      const rail = await screen.findByRole("button", { name: PANEL_TOGGLE });
      expect(rail).toHaveAttribute("aria-expanded", "true");
      expect(rail).not.toHaveAttribute("aria-disabled");
      const panel = screen.getByRole("region", { name: "Add cards" });
      expect(panel).toHaveAttribute(SEARCH_OVER_ATTR, "deck");

      // **A tile in that overlay is how a reader at this width opens a card**, and it is what
      // takes the overlay away: the pane covers the deck too, and only one of the two can be on
      // top — see `panelOverWidth`, where the paint-order argument is written out.
      await openSearchPanel();
      await userEvent.click(await screen.findByRole("button", { name: /^Goblin Guide/ }));
      // The card itself is an `App`-level modal and is not in this tree, so the open card is
      // read off the store — which is what `panelOverWidth` reads too.
      await waitFor(() => expect(useAppStore.getState().selectedCardId).not.toBeNull());

      await waitFor(() => expect(panel).not.toHaveAttribute(SEARCH_OVER_ATTR));
      // Not a control that records an intention and moves nothing: there is no width for what
      // it would open, and it says so rather than doing nothing.
      expect(rail).toHaveAttribute("aria-disabled", "true");
      // The reason moved off `title` to `useTooltip()` — a description of an already-named
      // control, so it is `describes: true` by default and the panel carries `role="tooltip"`.
      fireEvent.pointerEnter(rail);
      const tooltip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
      expect(tooltip).toHaveTextContent(/not enough room/i);
      expect(document.getElementById(TOOLTIP_PANEL_ID)).toBe(tooltip);
      fireEvent.pointerLeave(rail);
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
      // **And pressing it really is refused**, which is the half of this that a shut-by-default
      // panel would otherwise be answering for: `aria-expanded="false"` is now true of a panel
      // nobody has opened yet as well as of one there is no room for, so the refusal has to be
      // demonstrated rather than read off the flag.
      await userEvent.click(rail);
      expect(rail).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();

      // And "does nothing" includes not quietly flipping the reader's own choice: the card
      // closing gives the width back and the search is where they left it.
      act(() => useAppStore.setState({ selectedCardId: null, paneFromDeckSearch: false }));

      expect(panel).toHaveAttribute(SEARCH_OVER_ATTR, "deck");
      expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("draws the panel at the width where the deck still clears its floor", async () => {
    const restore = desk(414);
    try {
      await open();

      expect(await openSearchPanel()).toBeInTheDocument();
      expect(screen.getByRole("button", { name: PANEL_TOGGLE })).not.toHaveAttribute(
        "aria-disabled",
      );
      // Squeezed to its minimum rather than drawn at the 384 it opens with, which is what
      // leaves the deck exactly its 192: 414 − 16 − 206.
      expect(screen.getByRole("region", { name: "Add cards" })).toHaveStyle({ width: "206px" });
    } finally {
      restore();
    }
  });

  /**
   * And one pixel under it is the rail — the floor is a number, not a feeling.
   *
   * **The rail, and no longer a refusal**, since 2026-08-29: below 414 the panel is drawn *over*
   * the deck instead, so what this pins is that it stopped being docked. Whether the disclosure
   * still works there is the pair of tests below, and it is the half this one used to assert.
   */
  it("gives way one pixel below that", async () => {
    const restore = desk(413);
    try {
      await open();

      await screen.findByRole("button", { name: PANEL_TOGGLE });
      expect(screen.getByRole("region", { name: "Add cards" })).toHaveAttribute(
        SEARCH_OVER_ATTR,
        "deck",
      );
      expect(screen.getByRole("region", { name: "Add cards" })).not.toHaveStyle({
        width: "206px",
      });
    } finally {
      restore();
    }
  });

  /**
   * **The deck search opens over the deck on a phone, and until 2026-08-29 it could not be
   * opened at all.**
   *
   * `roomForPanel` is `DECK_FLOOR` (192) plus `MIN_PANEL_WIDTH_PX` (206) plus this row's `gap-4`
   * — **414** — so a 390px window's desk was below it, the panel railed, *and the rail refused*:
   * `aria-disabled`, with a sentence offering to widen a window that has no width to give. The
   * arithmetic was right and the question was wrong. There is no room for the deck and the panel
   * **beside each other**, which is not the same as no room for a search — so the editor now
   * sends the desk's own width and the panel draws itself over the deck, which is issue #183's
   * arrangement for the card pane reused rather than a second mechanism.
   *
   * **The press is the assertion**, in both directions, because that is the half the guard it
   * replaced would fail: `onClick={() => roomy && setOpen(!open)}` is a control that records an
   * intention and moves nothing, which is what the rail was. The attribute is the other half —
   * the difference between the two placements is a `position` and a width, and jsdom reads both
   * as `0`.
   */
  it("opens the card search over the deck at a phone-width desk", async () => {
    const restore = desk(390);
    try {
      await open();

      const rail = await screen.findByRole("button", { name: PANEL_TOGGLE });
      expect(rail).not.toHaveAttribute("aria-disabled");
      const panel = screen.getByRole("region", { name: "Add cards" });
      expect(panel).toHaveAttribute(SEARCH_OVER_ATTR, "deck");
      expect(panel).toHaveStyle({ width: "390px" });

      // Shut by a press, and the deck is the whole desk again.
      await userEvent.click(rail);
      expect(rail).toHaveAttribute("aria-expanded", "false");
      expect(panel).not.toHaveAttribute(SEARCH_OVER_ATTR);

      // And opened again by another one, which is the door this task exists to cut.
      await userEvent.click(rail);
      expect(rail).toHaveAttribute("aria-expanded", "true");
      expect(panel).toHaveAttribute(SEARCH_OVER_ATTR, "deck");
      expect(await screen.findByRole("button", { name: "All cards" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  /**
   * The panel's drag is capped by two numbers and this is the second of them — **half the
   * window**, which is the one that binds on a wide monitor. There the deck's floor would allow
   * the search column most of the app: at a 2000px desk it can spare 1792, and a card search
   * three quarters of the way across the deck builder has stopped being a column beside the deck
   * and become the view.
   *
   * The two are reached apart here because they cannot be told apart otherwise — `desk()` moves
   * the window with the row, and below 416px of desk the deck's floor is always the tighter of
   * them. A 2000px desk in a 1000px window is where only this one can be answering.
   */
  it("caps the panel's drag at half the window, however much the desk could spare", async () => {
    const restoreDesk = desk(2000);
    const restoreViewport = viewport(1000);
    try {
      await open();
      await openSearchPanel();

      expect(screen.getByRole("separator", { name: "Resize card search" })).toHaveAttribute(
        "aria-valuemax",
        "500",
      );
    } finally {
      restoreViewport();
      restoreDesk();
    }
  });

  /**
   * **Two things share the desk row, and the stats band is not one of them.** It was: the
   * rebuild put a 280px aside between the view and the panel and subtracted it from this floor,
   * so a reader who opened Stats at a width where the deck and the panel both fit lost the
   * panel to its rail. The band is under the deck now and takes no width from either, so the
   * pair of tests above is the whole of the arithmetic — this one holds the band to that.
   */
  it("keeps the panel open beside a deck at the floor, stats and all", async () => {
    const restore = desk(414);
    try {
      await open();

      expect(await openSearchPanel()).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Deck stats" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  /**
   * The panel is a fixture of the editor, not a dismissible layer: Escape pressed in its search
   * box belongs to whatever is open behind it — a card pane, and failing that the editor's own
   * `"navigation"` floor. A panel that consumed the press would leave a card pinned open with
   * nothing to close it, and a deck that could not be left from the one control a reader spends
   * the most time in.
   *
   * **The probe listens in the _capture_ phase, which is what makes the claim narrow.** An
   * `"inner"` layer — which is what the panel would be if somebody made it dismissible — consumes
   * in capture, so a probe registered after it reads `true`. Every rung below is a *bubble*
   * listener and has not run yet, so `false` here means precisely "no layer of this panel's own
   * took it" rather than "nothing took it at all". The floor did take it, which is the second
   * assertion.
   */
  it("lets Escape through from the docked search panel", async () => {
    await open();
    await openSearchPanel();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen, true);

    screen.getByRole("searchbox", { name: "Search cards" }).focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen, true);
    expect(heard).toEqual([false]);
    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /**
   * The Maybeboard is a group like the rest — **no drawer, and nothing to open.**
   *
   * It used to be a disclosure under the deck, shut by default, because `maybe` was the one
   * zone that counted toward nothing. Schema v8 moves that fact onto `is_active`, which any
   * category can carry, so the Maybeboard is one seeded row that starts switched off and there
   * is no word left for a drawer to be attached to. Its cards are on screen from the first
   * paint, under an `INACTIVE` marker.
   *
   * Its `0` owned is by design and not a shortage — the allocator claims nothing for an
   * inactive category — which is why the card draws no shortage mark.
   */
  it("draws the maybe pile as a group of its own, with no disclosure to open", async () => {
    deckGet.mockResolvedValue(
      detail({}, [bolt({ categoryKind: "maybe", quantity: 3, ownedQuantity: 0 })]),
    );

    await open();

    const pile = await screen.findByRole("region", { name: "Maybeboard" });
    expect(within(pile).getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument();
    expect(within(pile).getByText("INACTIVE")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Maybeboard/ })).not.toBeInTheDocument();
    expect(within(pile).queryByText("0/3")).not.toBeInTheDocument();
  });

  /**
   * **`categoryActive === false` is the whole of what `maybe` used to mean, and it is not the
   * Maybeboard's alone.**
   *
   * A pile of the user's own — kind `main`, their own name — that they switched off counts
   * toward nothing exactly as the seeded Maybeboard does: the allocator claims no copy for it,
   * so every card in it reads `ownedQuantity` 0 **by design** rather than for want of copies,
   * and a shortage mark there would tell the reader to go and buy four Bolts they already have.
   *
   * This is the case that fails against any implementation still branching on the *word*
   * `maybe`: the pile is `main`, so a kind check draws the mark and a `categoryActive` check
   * does not. It is drawn like any other group for the same reason — hiding a switched-off pile
   * would hide the affordance for switching it back on.
   */
  it("draws a switched-off category like any other, and its cards own nothing", async () => {
    const off = category(6, "Sunday brew", "main", { isActive: false, sortOrder: 5 });
    deckGet.mockResolvedValue(
      detail(
        {},
        [
          bolt({
            categoryId: off.id,
            categoryName: off.name,
            categoryKind: "main",
            categoryActive: false,
            quantity: 4,
            ownedQuantity: 0,
          }),
        ],
        [...CATEGORIES, off],
      ),
    );

    await open();

    const pile = await screen.findByRole("region", { name: "Sunday brew" });
    expect(within(pile).getByRole("button", { name: /^Lightning Bolt/ })).toBeInTheDocument();
    // No "0/4", and nothing in the card's name either: the mark is drawn only where it says
    // something, and here it would say something untrue.
    expect(within(pile).queryByText("0/4")).not.toBeInTheDocument();
    expect(
      within(pile)
        .getByRole("button", { name: /^Lightning Bolt/ })
        .getAttribute("aria-label"),
    ).not.toMatch(/you own/i);
  });

  /** Six cards is not a Modern deck, and the chip says so before it is opened. */
  it("counts the format's findings on a chip in the header", async () => {
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue · Modern" }));

    expect(
      screen.getByText("Modern decks need at least 60 cards; you have 6."),
    ).toBeInTheDocument();
  });

  /**
   * Issue #134: a card in a pile the reader has switched off drew no mark at all, so a Golgari
   * card dropped into a mono-white Commander deck's Maybeboard looked exactly like a card that
   * fits.
   *
   * **Both halves in one test, because either alone is satisfied by the wrong fix.** The mark
   * has to be on the parked card — that is what the reader reported missing — *and* the chip
   * beside it has to go on counting only the deck, or the change has quietly put the Maybeboard
   * back inside the validation that schema v8 took it out of. The chip reads `1 issue` for the
   * size and nothing else: the colour-identity sentence exists on the card and nowhere in the
   * panel.
   */
  it("marks a rule break on a parked card without counting it as a finding of the deck", async () => {
    deckGet.mockResolvedValue(
      detail({ formatKey: "commander", formatName: "Commander" }, [
        card({
          name: "Sram, Senior Edificer",
          categoryKind: "commander",
          typeLine: "Legendary Creature — Dwarf Advisor",
          manaCost: "{2}{W}",
          cmc: 3,
          colors: "W",
          colorIdentity: "W",
          quantity: 1,
        }),
        card({
          name: "Deadly Rollick",
          categoryKind: "maybe",
          categoryActive: false,
          typeLine: "Instant",
          manaCost: "{3}{B}",
          cmc: 4,
          colors: "B",
          colorIdentity: "BG",
          quantity: 1,
        }),
      ]),
    );
    wrap(<DeckEditor deckId={4} />);

    const parked = await screen.findByRole("button", { name: /^Deadly Rollick/ });
    expect(parked.getAttribute("aria-label")).toContain(
      "rule break: Deadly Rollick's color identity (BG) is outside your commander's (W).",
    );

    await userEvent.click(screen.getByRole("button", { name: "1 issue · Commander" }));
    expect(
      screen.getByText("Commander decks are exactly 100 cards including the commander; you have 1."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/color identity/)).not.toBeInTheDocument();
  });

  /**
   * Beside the check chip rather than folded into it, because the two answer different
   * questions: the chip counts what is *wrong*, and this counts what is *powerful*. A game
   * changer is legal by definition — it is the bracket conversation, not the legality one — so
   * a chip reading "4 issues · 2 game changers" would invent two problems.
   */
  it("says how many game changers the deck plays, and nothing when it plays none", async () => {
    await open();
    expect(screen.queryByText(/game changer/)).not.toBeInTheDocument();

    deckGet.mockResolvedValue(detail({}, [bolt({ gameChanger: true, quantity: 2 })]));
    wrap(<DeckEditor deckId={4} />);

    expect(await screen.findByText("2 game changers")).toBeInTheDocument();
  });

  /**
   * Each toolbar button opens its own full-window dialog, and Escape closes the one that is up
   * and hands the caret back to the control that opened it — the editor stays a *view*, so the
   * deck is still on screen afterwards.
   *
   * **The list is the row, and it has grown twice.** Categories & labels was one right-hand drawer
   * and became two dialogs; `Export deck` arrived beside `Import cards` when the export layer
   * grew a deck scope. A sweep that went on listing the old set while the editor drew one more
   * is the failure this file's lists exist to prevent — so it is written out rather than counted
   * in the prose.
   */
  it.each([
    ["Import cards", "Import a decklist"],
    ["Export deck", 'Export "Burn"'],
    ["Categories", "Categories"],
    ["Labels", "Labels"],
    ["History", "History"],
    ["Deck settings", "Deck settings"],
  ])("opens %s and closes it on Escape, caret back on the trigger", async (button, dialog) => {
    await open();
    const trigger = screen.getByRole("button", { name: button });

    await userEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: dialog })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: dialog })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * The other way out of a layer, and the one no test covered: its own ✕.
   *
   * The ✕ is *inside* the layer that is about to unmount, so it is the reader saying "put me
   * back" exactly as Escape is — `Dialog` calls `onDismiss`, and the editor's `dismiss`
   * focuses the trigger *before* the close, while the trigger is still mounted. Asserted here
   * rather than in each layer's own test file, because the hand-back is the **opener's** half
   * of the contract: a layer handed two callbacks can only be checked for calling the right one
   * (which `DeckHistoryDialog.test.tsx` does), and where the caret lands is decided out here.
   */
  it.each([
    ["Categories", "Categories", "Close categories"],
    ["Labels", "Labels", "Close labels"],
    ["History", "History", "Close history"],
  ])("closes %s on its own ✕, caret back on the trigger", async (button, dialog, close) => {
    await open();
    const trigger = screen.getByRole("button", { name: button });

    await userEvent.click(trigger);
    const layer = await screen.findByRole("dialog", { name: dialog });

    await userEvent.click(within(layer).getByRole("button", { name: close }));

    expect(screen.queryByRole("dialog", { name: dialog })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  /**
   * **The pull, which is the one layer opened from outside the header** — its control is in the
   * stats band at the foot of the page, beside the shortfall number it acts on.
   *
   * The hand-back is the interesting half and it is why this is not folded into the sweeps
   * above. Those triggers are named elements this file holds a ref to; `DeckStats` owns this
   * one and hands no ref up, so `openPull` reads `document.activeElement` at the press —
   * `openAddTag`'s answer, made for `openAddTag`'s reason. A browser focuses what it presses, so
   * the caret is on the button by the time the callback runs; if that ever stopped being true
   * the layer would still open and only this assertion would notice.
   */
  it("opens the pull from the stats band and hands the caret back on Escape", async () => {
    await open();
    const trigger = await screen.findByRole("button", { name: "Pull from collection" });

    await userEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Pull from collection" }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "Pull from collection" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    // One press, one layer: the deck is still open behind it, which is the floor Escape falls
    // to once every dismissible rung above it has passed.
    expect(useAppStore.getState().openDeckId).toBe(4);
  });

  /**
   * **The plan is not read until the dialog that draws it is open**, which is the `Layer` doc's
   * rule made checkable: a `deck_pull_plan` is every hole in the list joined to every
   * unallocated copy that could fill one, and nothing on the screen behind the dialog draws a
   * word of it.
   *
   * The two halves are one test on purpose. "It was not called" passes just as well against a
   * gate that never opens, so the press has to follow it in the same case.
   */
  it("reads no pull plan until the dialog is opened", async () => {
    await open();
    // Past the first paint and every query the editor makes for itself.
    await screen.findByRole("button", { name: "Pull from collection" });
    expect(deckPullPlan).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Pull from collection" }));

    await waitFor(() => expect(deckPullPlan).toHaveBeenCalledWith(4));
  });

  /**
   * **No pull on the plan, and it is the list rather than the feature.** Since schema v25 a deck
   * holds a card because a collection row sits in its group, so a theory row holds no cards at
   * all and there is nothing on that tab to pull copies into — which is also why
   * `deck_pull_plan` takes no variant.
   *
   * The Live half is asserted in the same case, because a button absent on both tabs would pass
   * a bare absence check while being broken everywhere.
   */
  it("offers the pull on the deck and not on the plan", async () => {
    const over = { theoryEnabled: true };
    const live = detail(over, [bolt({ quantity: 4 })]);
    const theory = detail(over, [bolt({ quantity: 4, variant: "theory" })]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );
    await open();

    expect(await screen.findByRole("button", { name: "Pull from collection" })).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("group", { name: "Deck list" })).getByRole("button", {
        name: "Theory",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Pull from collection" })).not.toBeInTheDocument(),
    );
    // The other half of the line is still there, so the absence above is this one prop: a plan
    // is exactly the list a reader wants a shopping list for.
    expect(
      screen.getByRole("button", { name: "Send missing to wishlist" }),
    ).toBeInTheDocument();
  });

  /**
   * **The full-window overlays are modal, and Tab cannot leave one.**
   *
   * Each paints a scrim over the whole app, which is a statement that what is behind it is not
   * available right now — a pointer already cannot cross one. Two of them used to let the
   * caret walk back into the editor anyway, which offered the capability to one input method and
   * denied it to the other while the docs argued it was deliberate.
   *
   * **This drives every full-window overlay with a control in the view**, which the export
   * dialog joined when the header grew `Export deck` — it was the one surface named here as
   * unreachable, on the argument that a category heading's right-click was its only opener. The
   * ones still outside the sweep are the delete-category and clear-stack confirmations and the
   * quick zones' New category, all opened without a button to point it at.
   *
   * **Every one of them is `Dialog` since 2026-08-16**, and this sweep is still driven per
   * surface rather than pointed at the shell — deliberately. The claim is that *this overlay*,
   * opened by *that* button, traps the caret; a sweep aimed at the shell would prove the shell
   * and say nothing about a host that passed the wrong thing, and it was this sweep that held
   * the three hand-copies to the shell's behaviour for as long as they existed. It is what would
   * go red if a modality fix reached `Dialog.tsx` and a host stopped using it.
   *
   * Asserted **here**, in the assembled editor, because "must not reach anything behind it" is a
   * claim about what is behind it: each layer's own test file mounts it alone, where there is
   * nothing to escape to and the test would pass on a broken trap.
   *
   * **The walk is measured from the layer, not a round number**, and that is not tidiness — a
   * fixed count is a test whose strength depends on which layer it is pointed at. Written first
   * as 15 presses, it caught the history drawer (a ✕ and five chips) and *missed* the categories
   * drawer, whose thirty-odd controls swallow fifteen presses without ever reaching the end.
   * One full cycle plus three is the shortest walk that must leave every layer if nothing holds
   * it, and the three are what catch a trap that wraps once and then leaks.
   */
  it.each([
    ["Import cards", "Import a decklist", null],
    ["Export deck", 'Export "Burn"', null],
    ["Categories", "Categories", null],
    ["Labels", "Labels", null],
    ["History", "History", null],
    ["Deck settings", "Deck settings", null],
    // The one row here whose control is not in the header: `Pull from collection` is drawn in
    // the stats band at the foot of the page, beside the shortfall it acts on. It belongs in
    // this sweep by the sweep's own rule — a full-window overlay with a control in the view —
    // and the fixture deck is short of three copies, which is what draws that control at all.
    ["Pull from collection", "Pull from collection", null],
    [
      "Compare",
      "Theory to Actual difference",
      () => {
        const live = detail({ theoryEnabled: true }, [bolt({ quantity: 4 })]);
        const theory = detail({ theoryEnabled: true }, [
          bolt({ quantity: 2, variant: "theory" }),
          card({ name: "Bear", variant: "theory" }),
        ]);
        deckGet.mockImplementation((_id: number, variant: string) =>
          Promise.resolve(variant === "theory" ? theory : live),
        );
      },
    ],
  ] as const)("keeps Tab inside %s", async (button, dialog, stage) => {
    stage?.();
    await open();

    await userEvent.click(await screen.findByRole("button", { name: button }));
    const layer = await screen.findByRole("dialog", { name: dialog });
    // The claim it makes to assistive tech, and the trap below is what makes it true.
    expect(layer).toHaveAttribute("aria-modal", "true");

    const stops = layer.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ).length;
    expect(stops).toBeGreaterThan(0);
    for (let i = 0; i < stops + 3; i += 1) {
      await userEvent.tab();
      expect(layer.contains(document.activeElement)).toBe(true);
    }
  });

  /**
   * Two of these open at once would be two scrims, two `aria-modal` panels and two focus traps
   * over one screen — so the editor holds *one* piece of state for every member of `Layer`, and
   * opening any of them takes whichever was up down with it.
   *
   * **The Escape argument that used to stand here is gone rather than reworded.** It read "two
   * `"inner"` layers open at once are not ordered by the Escape protocol at all — both would
   * consume one press", and neither half survives: `useDismissOnEscape` keeps a stack of
   * capture-phase registrations and only the token on top acts, so peers *are* ordered by mount
   * depth; and the old hook did not close both either — its capture rung checks
   * `defaultPrevented`, so the first-registered peer took the press and the newer one was
   * starved. The reason above never depended on any of it. No count either: the union grew twice
   * in one day, and a number here was wrong both times.
   */
  it("never has two of its own layers open at once", async () => {
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue · Modern" }));
    expect(screen.getByRole("dialog", { name: "Modern check" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Categories" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Categories" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "History" })).toBeInTheDocument();
  });

  /**
   * **The split, from the toolbar: two buttons, two dialogs, and neither draws the other.**
   *
   * The piles and the labels were two sections of one drawer called "Categories & labels", so the
   * only way to be wrong about which one a press opened was to scroll. Two dialogs make the
   * press the whole of the choice, and a wiring that opened the same body from both buttons
   * would look identical to a test that only ever pressed one of them.
   */
  it.each([
    ["Categories", "Labels"],
    ["Labels", "Categories"],
  ])("opens %s from its own button and not %s", async (pressed, other) => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: pressed }));

    expect(await screen.findByRole("dialog", { name: pressed })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: other })).not.toBeInTheDocument();
  });

  /**
   * …and the second press *replaces* the first rather than stacking on it.
   *
   * The `Layer` union already guarantees this — there is one slot — but a guarantee nothing
   * reads is a guarantee that survives being deleted. These two are the pair most likely to be
   * reached for in a row, because they were one surface until 2026-08-14.
   *
   * **What is *not* the reason any more, because the claim was false:** this used to read "two
   * `"inner"` rungs enabled at once are not ordered at all — one press would close both and two
   * focus hand-backs would race for the caret". `useDismissOnEscape` keeps a module-level stack
   * of capture-phase registrations and only the token on top acts, so two `"inner"` peers *are*
   * ordered, by mount depth. Nor did the old hook close both: its capture rung checked
   * `defaultPrevented` too, so the **first-registered** peer consumed the press and the newer
   * one — the thing on top — was starved. The reason for one slot is two scrims, two
   * `aria-modal` panels and two focus traps over one screen, which never depended on Escape.
   */
  it("replaces the categories dialog with the labels one rather than stacking them", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Categories" }));
    await screen.findByRole("dialog", { name: "Categories" });

    await userEvent.click(screen.getByRole("button", { name: "Labels" }));

    expect(await screen.findByRole("dialog", { name: "Labels" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Categories" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /**
   * **Each toolbar button reports its own layer, and only its own.**
   *
   * `aria-expanded` is how a screen reader is told which of these presses has a dialog behind
   * it, and the mapping is one expression over one union — so the failure mode is not "one
   * button forgot" but "every button says what the *open* one says", which is exactly what a
   * test pressing one button and reading one button cannot see. Read as a row, and read after a
   * press: one `true` and the rest `false`, however long the row grows.
   *
   * **`Export deck` is the case that expression had to grow for.** `export` is the only kind two
   * controls reach, so `layer?.kind === kind` would have lit this button while a *pile's* export
   * was up — which no press here can reach (the scrim is in the way), and which `layerMatches`'
   * own tests pin directly. What this row proves is that widening the expression did not cost
   * the five buttons that were already right.
   */
  it("reflects the open layer on the toolbar button that owns it, and on no other", async () => {
    await open();
    const BUTTONS = [
      "Import cards",
      "Export deck",
      "Categories",
      "Labels",
      "History",
      "Deck settings",
    ];
    const expanded = () =>
      BUTTONS.map((name) => screen.getByRole("button", { name }).getAttribute("aria-expanded"));

    expect(expanded()).toEqual(BUTTONS.map(() => "false"));

    // Straight down the row without closing anything in between: one slot means the next press
    // takes the last one down, so every press is also a check that it did.
    for (const [i, name] of BUTTONS.entries()) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(expanded()).toEqual(BUTTONS.map((_, j) => String(i === j)));
    }

    // And pressing the open one again is the way back out — `openLayer` toggles on a repeat.
    await userEvent.click(screen.getByRole("button", { name: "Deck settings" }));
    expect(expanded()).toEqual(BUTTONS.map(() => "false"));
  });

  /** The toolbar's one surface that writes cards in bulk, and the mirror of the export beside
   *  it. */
  it("opens the import dialog from the toolbar", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Import cards" }));

    const dialog = await screen.findByRole("dialog", { name: "Import a decklist" });
    // Into *this* deck, so the choice the gallery's entry point cannot offer is here.
    expect(within(dialog).getByText(/Into Burn · Actual/)).toBeInTheDocument();
  });

  /**
   * **The export's deck scope, which is what the header button is for.**
   *
   * The dialog is titled for the *deck* — `Export "Burn"` — where the category menu's row titles
   * it for the pile, and that title is the whole of what tells the two presses apart on screen.
   * The cards are the deck's own list, so a card in a pile nothing filtered to is in the text: a
   * whole-deck export that quietly exported one column would look identical to this one at the
   * dialog's frame.
   */
  it("exports the whole deck from the header", async () => {
    deckGet.mockResolvedValue(
      detail({}, [bolt(), card({ name: "Sol Ring", categoryId: SIDE, quantity: 1 })]),
    );
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "Export deck" }));

    const dialog = await screen.findByRole("dialog", { name: 'Export "Burn"' });
    // The preview opens shut and is **unmounted** while it is — the press is what a reader makes
    // to read the text, and this suite has to make it too. See `ExportDialog.tsx`.
    await userEvent.click(within(dialog).getByRole("button", { name: /Show decklist/ }));
    expect(within(dialog).getByText(/Lightning Bolt/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Sol Ring/)).toBeInTheDocument();
  });

  /**
   * **An import lands in the list on screen and nowhere else.**
   *
   * `variant` is in the deck-card grain precisely so a plan can be pasted over without touching
   * what is sleeved up — so a `replace` pressed with Theory showing must clear Theory, and the
   * warning must count Theory's cards. Getting this wrong is a reader losing their built deck to
   * a paste they made into the plan.
   */
  it("imports into the variant on screen", async () => {
    const live = detail({ theoryEnabled: true }, [bolt({ quantity: 4 })]);
    const theory = detail({ theoryEnabled: true }, [
      bolt({ quantity: 2, variant: "theory" }),
      card({ name: "Bear", variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "Theory" }));
    await userEvent.click(screen.getByRole("button", { name: "Import cards" }));
    await userEvent.click(await screen.findByLabelText("Decklist"));
    await userEvent.paste("1 Sol Ring");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    // The count is the variant's own copies, not the deck's: 2 Bolts and 1 Bear.
    expect(
      await screen.findByLabelText("Replace — removes the 3 cards in Theory first"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    // `inactive` rides on every item now — Archidekt's `{noDeck}`, `false` for a paste that
    // names no such pile — and this assertion is an exact object, so the field is not optional
    // here even though `ImportItem` makes it so.
    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "theory", "merge", [
        {
          cardId: "sol-ring",
          quantity: 1,
          finish: null,
          categoryName: "Artifact",
          inactive: false,
        },
      ]),
    );
  });

  /**
   * The Escape handshake, from the layer that was added last: an `"inner"` rung consumes the
   * press in the **capture** phase and calls `preventDefault()`, so the rung under it — a
   * bubble-phase listener that returns early on `defaultPrevented` — keeps its own press for the
   * next one. One press, one layer.
   *
   * **The middle rung of this ladder is not in this tree.** It was the docked card pane, which
   * the editor drew itself; the card is an `App`-level modal since 2026-09-03, so what this file
   * can still see is the dialog and the floor beneath it. `App.test.tsx`'s
   * "gives one Escape to each layer" is where the three-rung version lives now, and it is the
   * only place that can render all three.
   */
  it("closes the import dialog on Escape and leaves the deck open", async () => {
    cardDetail.mockResolvedValue(detailOf("Lightning Bolt"));
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    // Registered after the editor mounted, so the editor's own `"navigation"` rung is ahead of
    // this probe on `window` — which is what makes both readings below `true` rather than one of
    // each, and is the half that would change if a rung were ever added between them.
    window.addEventListener("keydown", listen);

    await userEvent.click(screen.getByRole("button", { name: "Import cards" }));
    await screen.findByRole("dialog", { name: "Import a decklist" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Import a decklist" })).not.toBeInTheDocument(),
    );
    // The deck is still open behind it: the dialog took that press and nothing else did.
    expect(useAppStore.getState().openDeckId).toBe(4);

    // With the dialog gone, the next press reaches the floor.
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    // `true` from the dialog's `"inner"` rung, running in capture ahead of this probe; `true`
    // again from the editor's `"navigation"` rung, which was registered before it.
    expect(heard).toEqual([true, true]);
    await waitFor(() => expect(useAppStore.getState().openDeckId).toBeNull());
  });

  /**
   * The **ninth** `"inner"` peer on this screen, and the one no state union covers: the set
   * filter inside the docked search panel owns its own Escape rung (`SetCombobox`). What keeps
   * it exclusive with the editor's own eight is focus and click mechanics — each of them closes
   * on focus-out or on a press outside its root — so it is pinned here in the assembled editor,
   * both ways round. Neither direction is a structural guarantee, and a test is the only thing
   * that would notice one of them being dropped.
   */
  it("never has the set filter and one of the editor's own layers open at once", async () => {
    await open();
    await openFilterTray();
    const setFilter = () => screen.getByRole("button", { name: "Set" });
    const filterOpen = () => screen.queryByRole("combobox", { name: "Search sets" });

    // The format check, then the set filter: taking the caret out of the check closes it.
    await userEvent.click(await screen.findByRole("button", { name: "1 issue · Modern" }));
    await userEvent.click(setFilter());

    expect(filterOpen()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // ...and back the other way: opening the check takes the set filter down.
    await userEvent.click(await screen.findByRole("button", { name: "1 issue · Modern" }));

    expect(screen.getByRole("dialog", { name: "Modern check" })).toBeInTheDocument();
    expect(filterOpen()).not.toBeInTheDocument();

    // And an overlay is the same both ways — it covers the panel, so the filter cannot even be
    // reached while one is up.
    await userEvent.click(setFilter());
    expect(filterOpen()).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Categories" }));

    expect(await screen.findByRole("dialog", { name: "Categories" })).toBeInTheDocument();
    expect(filterOpen()).not.toBeInTheDocument();
  });

  /**
   * A deck deleted under an open layer takes its trigger with it. The state that says one is
   * open does not go on its own — and an `"inner"` layer nothing draws is a layer that eats the
   * first Escape of whatever the reader does next.
   */
  it("closes an open layer when the deck turns out to be gone", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Categories" }));
    await screen.findByRole("dialog", { name: "Categories" });

    // Staged *after* the dialog is up, because it mounts a second observer of the editor's own
    // deck read — a `staleTime: 0` query with a new observer refetches, so a `null` queued
    // before the press would take the deck away on the way in rather than on the write.
    deckUpdate.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValue(null);
    await writeToDeck();

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    // **Capture, because that is the phase the phantom would be in.** An `"inner"` layer consumes
    // the press before it has descended to its target, so a probe registered after one reads
    // `true`; every rung below is a bubble listener that has not run yet. `false` here is
    // therefore the exact claim — no undrawn layer took the press — where a bubble probe would
    // now read the editor's own `"navigation"` floor and say `true` whether or not the bug was
    // back.
    window.addEventListener("keydown", listen, true);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen, true);
    expect(heard).toEqual([false]);
  });

  /**
   * The Theory/Actual switch, and the button that is the way to the difference dialog.
   *
   * **The button says `Compare` and carries no count** (2026-08-20). It used to read "N cards
   * differ", computed in `DeckEditor` over a second `deck_get` of the other variant — a second
   * implementation of a comparison `deck_theory_diff` already owns, and one that disagreed with
   * it: it keyed rows on `(categoryId, cardId)` and counted both directions, so a card the two
   * lists file in different piles scored two and a hundred-card deck read as 150-odd
   * differences. The number a reader wants is the dialog's own figure strip, one press away.
   *
   * **The second assertion is the test**, and it is the one that fails if the readout comes
   * back: nothing may read the deck's *other* list until the reader asks for that list.
   */
  it("switches between the deck's two lists, and opens the difference on a Compare button", async () => {
    const live = detail({ theoryEnabled: true }, [bolt({ quantity: 4 })]);
    const theory = detail({ theoryEnabled: true }, [
      bolt({ quantity: 2, variant: "theory" }),
      card({ name: "Bear", variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );

    await open();

    expect(await screen.findByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(screen.queryByText(/cards? differs?/)).not.toBeInTheDocument();
    expect(deckGet).not.toHaveBeenCalledWith(4, "theory", "tcgplayer");

    await userEvent.click(screen.getByRole("button", { name: "Theory" }));

    await waitFor(() => expect(deckGet).toHaveBeenCalledWith(4, "theory", "tcgplayer"));
    // The card the plan adds is on screen, and the pane context it writes says which list.
    await userEvent.click(await screen.findByRole("button", { name: /^Bear/ }));
    expect(useAppStore.getState().paneDeckContext?.variant).toBe("theory");
  });

  /** A deck with one list has no switch to press: the other half of a two-way control over a
   *  deck that keeps no plan is empty by construction. Deck settings is where a plan is
   *  started. */
  it("offers no Theory/Actual switch to a deck that keeps no plan", async () => {
    await open();

    expect(screen.queryByRole("group", { name: "Deck list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
  });

  /**
   * One of the two tabs, looked up **fresh every time**: switching variant puts the editor
   * through a beat with no row, which takes the whole header down and back — so a node held
   * from before a press is a node the assertion after it would be reading out of a detached
   * tree.
   */
  const tab = (name: "Actual" | "Theory") =>
    within(screen.getByRole("group", { name: "Deck list" })).getByRole("button", { name });

  /** Both lists on screen at once, so the pair can be read in the order they are drawn. */
  function withPlan(deck: Partial<DeckRow> = {}) {
    const over = { theoryEnabled: true, ...deck };
    const live = detail(over, [bolt({ quantity: 4 })]);
    const theory = detail(over, [
      bolt({ quantity: 2, variant: "theory" }),
      card({ name: "Bear", variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );
  }

  /**
   * The two tabs, in the order they are painted, and `Compare` standing outside them.
   *
   * Asserted as a sequence, because both being present says nothing about their order — and the
   * group's membership is asserted too, which is the half that fails if `Compare` is folded back
   * between the words: it is an action *about* the two lists rather than a third list, so a
   * `role="group"` named `Deck list` is exactly what it must not be inside.
   *
   * **Theory before Actual** since 2026-08-26, which reverses the 2026-08-24 order this test was
   * last written for. Neither flip is about where the caret lands when the switch is *turned on* —
   * that is `lastVariant`'s doing, and the test below ("opens on the list the deck remembers") is
   * the one that would catch it moving.
   */
  it("draws the plan's tab before the deck's, with Compare beside the group", async () => {
    withPlan();
    await open();

    const group = await screen.findByRole("group", { name: "Deck list" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Theory",
      "Actual",
    ]);

    // Outside the group, and immediately after it in the row.
    const compare = screen.getByRole("button", { name: "Compare" });
    expect(group.contains(compare)).toBe(false);
    expect(group.nextElementSibling).toBe(compare);
    // The word is drawn beside the glyph — jsdom lays nothing out, so the tight-header
    // arrangement that drops it is never the one under test here.
    expect(compare).toHaveTextContent("Compare");
  });

  /**
   * A deck opens on the tab it was left on, which is the whole point of the three columns.
   *
   * Restoring writes **nothing** back: it is a read of what is already stored, and a restore
   * that wrote would put a `deck_set_view_state` behind every deck anyone merely looked at.
   */
  it("opens on the list the deck remembers", async () => {
    withPlan({ lastVariant: "theory" });
    await open();

    await screen.findByRole("group", { name: "Deck list" });
    await waitFor(() => expect(tab("Theory")).toHaveAttribute("aria-pressed", "true"));
    // The plan's own cards are what is drawn — the tab is not just painted.
    expect(await screen.findByRole("button", { name: /^Bear/ })).toBeInTheDocument();
    expect(deckSetViewState).not.toHaveBeenCalled();
  });

  /** The other half of the same rule, so neither word is being read as "not the other one". */
  it("opens on the deck when that is what it remembers", async () => {
    withPlan({ lastVariant: "live" });
    await open();

    await screen.findByRole("group", { name: "Deck list" });
    expect(tab("Actual")).toHaveAttribute("aria-pressed", "true");
    expect(tab("Theory")).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * **The tick is a statement the Live list makes, and pressing `Theory` has to take it off
   * every row** (issue #159).
   *
   * On the plan every row *is* the plan, so a tick on all of them is a mark that says nothing —
   * which is why `theoryMatchPlan` keeps `undefined` apart from the empty map and why the slots
   * query is not enabled on this tab. **Not being enabled turned out not to be enough.**
   * `useQuery` serves whatever sits in the cache under its key whether or not it may fetch, and
   * that key is the *deck*'s rather than the tab's — so a reader who had Live on screen first,
   * which is where every deck without a remembered tab opens, carried its answer straight over.
   * Anything that invalidates `["decks"]` while Live is showing refills it, which is why the
   * report was written from a printing swapped through `View all printings` and why it read as
   * intermittent.
   *
   * Both halves in one press, because "no ticks on the plan" passes on its own for a deck that
   * never drew one.
   */
  it("takes the theory tick off every row when the reader switches to the plan", async () => {
    withPlan();
    deckTheorySlots.mockResolvedValue([{ key: theorySlot(bolt()), quantity: 1 }]);

    await open();

    await waitFor(() =>
      expect(document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`).length).toBeGreaterThan(0),
    );

    await userEvent.click(tab("Theory"));

    // The plan's own card, so the press has actually landed before the count below is read.
    await screen.findByRole("button", { name: /^Bear/ });
    expect(document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(0);
  });

  /**
   * **The count reaches the mark from the two reads the editor already makes**
   * ([issue #212](https://github.com/Msgaihede/mtg-grimoire/issues/212)).
   *
   * `theoryMatchDelta`'s arithmetic is unit-tested and `CardStack` is tested against a map handed
   * to it directly; neither says the editor *joins* the plan's quantities to the live list's. This
   * is that wiring — `deckTheorySlots`' `quantity` against `deck.cards`' own — and it is the half
   * that can be fully correct and reach nothing.
   *
   * `withPlan` sleeves up four Bolts and this plan asks for two, so the mark says `+2` rather than
   * the tick: the live list is two copies **over** the plan, which is a cut the reader has not
   * made yet.
   */
  it("says how far the live count is from the plan on the card itself", async () => {
    withPlan();
    deckTheorySlots.mockResolvedValue([{ key: theorySlot(bolt()), quantity: 2 }]);

    await open();

    await waitFor(() =>
      expect(document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`).length).toBeGreaterThan(0),
    );
    for (const mark of document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)) {
      expect(mark).toHaveTextContent("+2");
    }
    // …and in words, on the one thing a keyboard reader gets from the card.
    expect(screen.getByRole("button", { name: /^Lightning Bolt/ })).toHaveAccessibleName(
      expect.stringContaining("in the theory list · 2 more than planned"),
    );
  });

  /**
   * **A deck that no longer keeps a plan opens on Live, whatever it remembers.**
   *
   * Switching the theory list off does not rewrite `lastVariant`, so `"theory"` on a deck with
   * no switch is an ordinary state rather than a corrupt one — and honouring it would leave the
   * reader reading a list with no control to get back from. Two things hold it: the restore
   * asks for Live on a deck that keeps no plan, and the clamp that has always run after the
   * restore still catches the switch being turned off under an open editor.
   */
  it("opens on the deck when it keeps no plan, whatever tab it remembers", async () => {
    deckGet.mockResolvedValue(
      detail({ theoryEnabled: false, lastVariant: "theory" }, [bolt({ quantity: 4 })]),
    );
    await open();

    expect(screen.queryByRole("group", { name: "Deck list" })).not.toBeInTheDocument();
    // Never even read: the editor asked for one list, and it was the live one.
    expect(deckGet).not.toHaveBeenCalledWith(4, "theory", "tcgplayer");
    expect(deckGet).toHaveBeenCalledWith(4, "live", "tcgplayer");
  });

  /** The other two remembered controls, restored the same way and from the same row. */
  it("opens with the grouping and the sort the deck remembers", async () => {
    deckGet.mockResolvedValue(
      detail({ lastGroupBy: "manaValue", lastSortBy: "price" }, [
        bolt(),
        card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 }),
      ]),
    );
    await open();

    expect(screen.getByRole("button", { name: "Group by" })).toHaveTextContent("Mana value");
    expect(screen.getByRole("button", { name: "Sort" })).toHaveTextContent("Price");
    // And it is the list that was regrouped, not just the select.
    expect(await screen.findByRole("list", { name: "Mana value 1" })).toBeInTheDocument();
  });

  /**
   * A stored word this build does not offer lands on the default rather than sticking.
   *
   * The columns are `string` on the wire on purpose — a database outlives the app, and a mode
   * a future build stops offering must not put the editor somewhere its own select cannot draw
   * and the reader cannot press their way out of.
   */
  it("falls back to the defaults for a grouping or a sort it no longer offers", async () => {
    deckGet.mockResolvedValue(detail({ lastGroupBy: "colour", lastSortBy: "rarity" }, [bolt()]));
    await open();

    expect(screen.getByRole("button", { name: "Group by" })).toHaveTextContent("Categories");
    expect(screen.getByRole("button", { name: "Sort" })).toHaveTextContent("Alphabetical");
    expect(screen.getByRole("list", { name: "Main deck" })).toBeInTheDocument();
  });

  /**
   * Every press is stored, and **only the control that moved travels**: absent means "leave it",
   * so a press on Sort cannot write back a grouping read out of a stale render.
   */
  it("remembers each control the reader presses, one field at a time", async () => {
    const user = userEvent.setup();
    withPlan({ lastVariant: "live" });
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "Theory" }));
    await waitFor(() => expect(deckSetViewState).toHaveBeenCalledWith(4, { variant: "theory" }));

    await pickOption(user, "Group by", "Mana value");
    await waitFor(() =>
      expect(deckSetViewState).toHaveBeenLastCalledWith(4, { groupBy: "manaValue" }),
    );

    await pickOption(user, "Sort", "Price");
    await waitFor(() => expect(deckSetViewState).toHaveBeenLastCalledWith(4, { sortBy: "price" }));

    expect(deckSetViewState).toHaveBeenCalledTimes(3);
  });

  /**
   * **The row does not fight the reader.** The restore is honoured once per stored *triple*, so
   * a row still saying `"theory"` — `rememberView` does not invalidate, so it is not re-read
   * after the press — cannot pull the reader back off the tab they just chose.
   */
  it("keeps the tab the reader pressed while the row still says the old one", async () => {
    withPlan({ lastVariant: "theory" });
    await open();
    await screen.findByRole("group", { name: "Deck list" });
    await waitFor(() => expect(tab("Theory")).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(tab("Actual"));

    await waitFor(() => expect(deckSetViewState).toHaveBeenCalledWith(4, { variant: "live" }));
    expect(tab("Actual")).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * **The two cached rows can name each other's tab, and the restore must not chase that.**
   *
   * Each list is its own query key, so each holds its *own* snapshot of the one deck row — and
   * `rememberView` writes `last_variant` without invalidating either, so a `deck_get` that
   * raced the write comes back carrying the tab the reader has just left. Two snapshots that
   * each name the other tab used to be an editor that could not settle: the restore moved the
   * variant, the variant moved which snapshot the restore read, and that snapshot asked for the
   * move back. React counts nested renders and throws **"Too many re-renders"**, and there is no
   * error boundary above this component — so the whole window went blank.
   *
   * Reproduced in the shipped window on 2026-08-16 (`npm run tauri dev`, a **debug** build):
   * pressing the two tabs at ~40 ms intervals took the app down in three presses, with
   * `Uncaught Error: Too many re-renders` naming `<DeckEditor>` in the console, and a patched
   * `ipc.deckGet` caught a `live` read answering `lastVariant: "theory"` 20 ms after the
   * `deck_set_view_state` that had just asked for `live`. Feeding the crossed pair in
   * deliberately — this test — took it down on the way in, with no press at all.
   */
  it("survives two cached rows that name each other's tab", async () => {
    const live = detail({ theoryEnabled: true, lastVariant: "theory" }, [bolt({ quantity: 4 })]);
    const theory = detail({ theoryEnabled: true, lastVariant: "live" }, [
      bolt({ quantity: 2, variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );

    await open();

    await screen.findByRole("group", { name: "Deck list" });
    // It settles, and on the tab the row it opened with asked for. The other row's answer is
    // read by nothing: a restore is honoured once per deck and switch, never once per value.
    await waitFor(() => expect(tab("Theory")).toHaveAttribute("aria-pressed", "true"));
    expect(tab("Actual")).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * **Switching the plan off under an open editor must not take the window down** —
   * reported from the shipped app as "it crashes the entire frontend app".
   *
   * The same two-cached-rows shape as the test above, one field along, and reached by an ordinary
   * press rather than by a race the reader has to be quick to feel. `deck_update` invalidates
   * `["decks"]`, so **both** lists re-read — and until the second answer lands, the query the
   * editor is not looking at goes on serving the row it already had. `theoryEnabled` is read off
   * *that* row, which is the whole bug: the restore's marker was the deck and the switch, so the
   * switch it keyed on moved with the variant the restore had just set. Off, on the plan's row,
   * said "land on Actual"; on, on the deck's row, said "land on `lastVariant`" — and `lastVariant`
   * is `"theory"` on exactly the decks the report is about, because that is the tab their reader
   * was last on. Round and round, until React threw **"Too many re-renders"** into a tree with no
   * error boundary above it and the window went blank.
   *
   * A deck whose plan is empty is a deck nobody has switched to, so its `lastVariant` is `"live"`,
   * both readings ask for Actual and nothing oscillates — which is why the report says *"a deck
   * that already has cards in the theory deck"*, and why an empty plan looked fine.
   *
   * Driven the way the reader drives it, and back again: the switch goes off, the tab strip goes
   * with it, and turning it back on finds the plan's cards exactly where they were left.
   * **Nothing about this write touches a row** — see `deck.rs`, where only the column moves.
   */
  it("survives the plan being switched off under it, and keeps the plan's cards", async () => {
    const ON: Partial<DeckRow> = { theoryEnabled: true, lastVariant: "theory" };
    const OFF: Partial<DeckRow> = { theoryEnabled: false, lastVariant: "theory" };
    let deckRow = ON;
    /** Holds the *deck's* re-read so it is the slower of the two and its old row is still what
     *  the editor reads when the plan's lands — a race in the shipped app, a certainty here.
     *
     *  An array rather than a `let`, and only because of TypeScript: a mutable binding assigned
     *  solely inside a callback is still `null` to control-flow analysis at the call below, so
     *  `releaseLive?.()` narrowed to `never`. A `length` check is a claim the test can make
     *  about the same thing without a cast. */
    const held: (() => void)[] = [];
    deckGet.mockImplementation((_id: number, variant: string) => {
      const answer = () =>
        variant === "theory"
          ? detail(deckRow, [
              bolt({ quantity: 2, variant: "theory" }),
              card({ name: "Bear", variant: "theory" }),
            ])
          : detail(deckRow, [bolt({ quantity: 4 })]);
      if (variant === "live" && deckRow === OFF && held.length === 0) {
        return new Promise((resolve) => {
          held.push(() => resolve(answer()));
        });
      }
      return Promise.resolve(answer());
    });

    await open();
    await screen.findByRole("group", { name: "Deck list" });
    await waitFor(() => expect(tab("Theory")).toHaveAttribute("aria-pressed", "true"));

    // Deck settings is the only place the switch lives, and opening it is what puts the deck's
    // own list in the cache beside the plan's — the second row the restore can read.
    await userEvent.click(screen.getByRole("button", { name: "Deck settings" }));
    await screen.findByText("Theory deck");
    const theorySwitch = () => within(screen.getByRole("dialog")).getByRole("switch");

    deckUpdate.mockImplementation(async () => {
      deckRow = OFF;
      return { ...DECK, theoryEnabled: false };
    });
    await userEvent.click(theorySwitch());

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryEnabled: false }));
    await waitFor(() => expect(held).toHaveLength(1));
    held[0]?.();

    // Alive — the assertion the bug failed, and it failed by rendering nothing at all.
    expect(await screen.findByLabelText("Deck name")).toBeInTheDocument();
    // The plan is hidden, which is the whole of what the reader asked the switch for.
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Deck list" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();

    // And back: the plan is still there to be read, because turning the switch off hid it and
    // wrote nothing to the cards.
    deckUpdate.mockImplementation(async () => {
      deckRow = ON;
      return { ...DECK, theoryEnabled: true };
    });
    await userEvent.click(theorySwitch());

    await waitFor(() => expect(deckUpdate).toHaveBeenLastCalledWith(4, { theoryEnabled: true }));
    await userEvent.click(screen.getByRole("button", { name: "Close deck settings" }));
    await screen.findByRole("group", { name: "Deck list" });
    await userEvent.click(tab("Theory"));
    await waitFor(() => expect(tab("Theory")).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByRole("button", { name: /^Bear/ })).toBeInTheDocument();
  });

  /**
   * The same invariant with no press to reach it: **two cached rows that disagree about the
   * switch settle**, exactly as two that name each other's tab do.
   *
   * Fed in crossed on the way in, which is what the test above reaches through a write — and the
   * shape the restore has to be safe against however it arises, since the two rows are two round
   * trips and any invalidation can land between them.
   */
  it("survives two cached rows that disagree about the theory switch", async () => {
    const live = detail({ theoryEnabled: true, lastVariant: "theory" }, [bolt({ quantity: 4 })]);
    const theory = detail({ theoryEnabled: false, lastVariant: "theory" }, [
      bolt({ quantity: 2, variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );

    await open();

    expect(await screen.findByLabelText("Deck name")).toBeInTheDocument();
  });

  /**
   * **The plan's ticks go with the switch.** The slots query is only `enabled` on a deck that
   * keeps a plan, and this file's own note says why that is not enough: a disabled `useQuery`
   * still serves whatever sits in the cache under its key, and that key is the deck's. So a
   * reader who had the marks on screen and then switched the plan off kept every one of them —
   * a mark about a list the deck no longer admits to having.
   *
   * The same argument as "takes the theory tick off every row when the reader switches to the
   * plan", one axis over: the gate belongs on the **derivation**, where the question is asked.
   */
  it("takes the theory tick off every row when the plan is switched off", async () => {
    let deckRow: Partial<DeckRow> = { theoryEnabled: true, lastVariant: "live" };
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(
        variant === "theory"
          ? detail(deckRow, [bolt({ quantity: 2, variant: "theory" })])
          : detail(deckRow, [bolt({ quantity: 4 })]),
      ),
    );
    deckTheorySlots.mockResolvedValue([{ key: theorySlot(bolt()), quantity: 2 }]);

    await open();
    await waitFor(() =>
      expect(document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`).length).toBeGreaterThan(0),
    );

    await userEvent.click(screen.getByRole("button", { name: "Deck settings" }));
    await screen.findByText("Theory deck");
    deckUpdate.mockImplementation(async () => {
      deckRow = { theoryEnabled: false, lastVariant: "live" };
      return { ...DECK, theoryEnabled: false };
    });
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("switch"));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { theoryEnabled: false }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Deck list" })).not.toBeInTheDocument(),
    );
    expect(document.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(0);
  });

  /** The one write on the stats aside, end to end: what the deck is short of becomes wishes,
   *  and the aside says how many in words. */
  it("sends what the deck is missing to the wishlist", async () => {
    await open();

    expect(screen.getByText("3 of 6 missing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

    await waitFor(() => expect(deckMissingToWishlist).toHaveBeenCalledWith(4));
    // Wishes are cards and the shortfall is copies, so the sentence says which it counts.
    expect(
      await screen.findByText("Added 3 wishes — one per card, for every copy you are short."),
    ).toBeInTheDocument();
  });

  /** Spec §5: a price is never shown without saying how old it is. */
  /** Spec §5 — and, since a reader can now pick, whose prices these are as well as how old. */
  it("says how old its prices are, and whose", async () => {
    await open();

    expect(screen.getByText("TCGplayer prices as of the last card-data sync.")).toBeInTheDocument();
  });

  /**
   * **Where a cut card goes, said once and standing.** A Live row's copies are collection rows
   * filed into this deck's group, so cutting one returns them to `Recently removed` — and there
   * are three ways to make that cut (the tray, a stepper stepped to zero, the card menu's
   * `Remove card`). This is the strip's own argument for the price line applied to the second
   * fact: one sentence at the foot of the deck rather than three spellings at three controls.
   *
   * **Not a `role="status"`**, which is the other half of the claim: a held stepper firing this
   * sentence per press is noise, so nothing here announces it and it is simply always there.
   */
  it("says once, standing, where a card cut from the deck goes", async () => {
    await open();

    expect(screen.getByText(CUT_CARDS_NOTE)).toBeInTheDocument();
    // Every live region in this view speaks for a press — the refile note, the wishlist
    // sentence. A standing fact is in none of them.
    for (const region of screen.queryAllByRole("status")) {
      expect(region).not.toHaveTextContent(CUT_CARDS_NOTE);
    }
  });

  /**
   * **And it is a claim about the Live list only.** A Theory row is a plan: it holds no copy, so
   * a cut has nothing to give back and a sentence promising otherwise would be the one kind of
   * wrong a reader cannot check against their own binder.
   */
  it("does not promise a cut card back on the plan", async () => {
    withPlan();
    await open();

    expect(screen.getByText(CUT_CARDS_NOTE)).toBeInTheDocument();

    await userEvent.click(tab("Theory"));

    await waitFor(() => expect(screen.queryByText(CUT_CARDS_NOTE)).toBeNull());
    // The price line is the strip's permanent half and is drawn on both tabs — so the absence
    // above is this sentence being withheld rather than the strip having gone.
    expect(screen.getByText("TCGplayer prices as of the last card-data sync.")).toBeInTheDocument();
  });

  /** A deck deleted from another view is a deck the editor is holding a ghost of. It says so
   *  and offers the way back rather than throwing. */
  it("says so when the deck is not there any more", async () => {
    deckGet.mockResolvedValue(null);

    wrap(<DeckEditor deckId={4} />);

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /back to decks/i })).toBeInTheDocument();
  });

  /**
   * Every write goes through `touch_deck`, which answers "That deck is not there any more."
   * when the deck has been deleted under the reader. So a refused write re-reads the deck —
   * and the read is what decides whether this is a busy database or a deck that is gone.
   */
  it("re-reads the deck when a write is refused, and lands on the gone message if it is", async () => {
    deckUpdate.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await writeToDeck();

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
  });

  /**
   * The panel's add is in that family too, and it is the one that could have been left out of
   * it: `add_card` goes through `touch_deck` like every other write, so a press on a deck that
   * has been deleted answers the same sentence. Without the re-read the panel would say the
   * deck is gone while the view beside it went on painting it, and every further press would
   * fail the same way with nothing on screen explaining it.
   */
  it("re-reads the deck when an add from the panel is refused", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    deckAddCard.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await openSearchPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    );

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
  });

  /**
   * And the next: `missing_to_wishlist` reads the deck before it writes anything and answers
   * the same `GONE`, so the stats aside's button belongs in the family for the family's reason
   * — no refused deck write may leave a dead deck painted.
   */
  it("re-reads the deck when the wishlist write is refused", async () => {
    deckMissingToWishlist.mockRejectedValue("That deck is not there any more.");
    deckGet.mockResolvedValueOnce(detail({}, [bolt()])).mockResolvedValue(null);

    await open();
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
  });

  /**
   * One member of the refused-write family has no control in this view — the printing swap is
   * pressed on the **card pane**, which is a sibling of this editor rather than part of it.
   * (No count: read `DeckEditor`'s `writes` array and the `newestWrite` call beside it. A
   * number stood here, went stale twice in one day as the two menus landed, and is not coming
   * back.)
   *
   * It cannot honestly be tested from here, and it is tested where the two components meet:
   * `App.test.tsx`'s "says a refused swap in the pane, and the deck behind it goes with it".
   * What actually carries a pane-fired refusal back to this view is not this file's `newest`
   * list at all — two `useMutation` call sites share no state — but the `onError` invalidation
   * on the mutation's single definition (`useDeck.ts`). Its entry in `lastOfAny` stays as the
   * belt to those braces, for the day a control in this view fires it.
   *
   * `moveCard` used to be named here beside it and no longer is: the `Move…` select that fired
   * it is gone, but a **drop** fires the same mutation through `applyDrop`, so the entry is live
   * coverage rather than a placeholder.
   */

  /** A refused write is said in the app's own words, where the reader is looking. */
  it("says so when a write is refused", async () => {
    deckUpdate.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    await open();
    await writeToDeck();

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });
});

/**
 * The drag that still has a source, end to end: a tile out of the docked panel, let go over the
 * deck.
 *
 * Real drag events at the real registrations — `src/test-drag.ts` explains why jsdom can carry
 * them and lists what it cannot (the platform's drag preview, pointer hit-testing, auto-scroll
 * and Escape, which the browser handles without telling the page). There is a click path beside
 * it — the panel's own Add button, tested above — so what this proves is that the drag reaches
 * the *same* write, not a second one.
 */
describe("DeckEditor drag and drop", () => {
  /**
   * The tray's own words, in both its shapes — "Remove from deck" and "Remove <card> from deck".
   *
   * **`/remove/i` used to be enough and is not any more.** The strip the tray is drawn on now
   * carries a standing sentence naming `Recently removed` ({@link CUT_CARDS_NOTE}), so a loose
   * match finds the *fact* wherever the *affordance* is absent — and every assertion below is
   * about the affordance being absent. A query that cannot tell one from the other is the shape
   * of thing that passes for months and then reads as a regression on a prose edit.
   */
  const TRAY_TEXT = /remove(\s.*)? from deck/i;

  /**
   * A card in the deck, from the name it shows, **with a box**. The `<li>` is the drag handle —
   * the whole card is.
   *
   * jsdom has no layout engine, so every `getBoundingClientRect` is four zeroes and dnd-kit
   * hit-tests by coordinate: a source with no box is pressed at the origin, which is wherever the
   * last boxed thing happens to be. The card sits at the top and every target below it.
   */
  const card_ = (name: string) =>
    boxed(screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!, 0);

  /** A pile, boxed clear of the card above it, so a drop really arrives somewhere else. */
  const boxedGroup = (name: string) => boxed(group(name), 300, 80);

  /** One box in the bar. Addressed by its attribute rather than by its text: the bar is
   *  `aria-hidden` and `Sideboard` is also a heading on the desk behind it. */
  const zone = (label: string) =>
    document.querySelector<HTMLElement>(`[${QUICK_ZONE_ATTR}="${label}"]`)!;

  /** One quick zone or the remove tray, boxed where the bar and the tray really are: the zones
   *  ride the top of the editor and the tray the foot of it, so neither can be mistaken for a
   *  pile in between. Boxed at the moment it is asked for, because both are drawn only while a
   *  card is in the air. */
  const boxedZone = (label: string) => boxed(zone(label), 100, 60);

  /** One result in the panel, for the drags that start there. The getter opens the panel first,
   *  because it starts shut and a tile that is not drawn is not a drag source. */
  function panelHolds(name: string) {
    searchCards.mockResolvedValue({ items: [found(name)], total: 1, totalIsCapped: false });
    return async () => {
      await openSearchPanel();
      const art = await screen.findByRole("button", { name });
      return art.closest<HTMLElement>(`[${DND_SOURCE_ATTR}]`)!;
    };
  }

  /**
   * **The pile that took the card decides, not the deck's default** — which is still Sideboard
   * while the card lands in the main deck. That is the whole difference between the drag and the
   * button beside it, and the reason a drop carries its own category.
   *
   * And the drop writes no setting: the deck goes on filing unnamed adds into the Sideboard
   * afterwards, which is what the second assertion is about — a drag is not a reader changing
   * their mind about where cards go.
   */
  it("adds a card dragged out of the panel to the group it was dropped on", async () => {
    const tile = panelHolds("Goblin Guide");
    deckGet.mockResolvedValue(detail({ defaultCategoryId: SIDE }, [bolt()]));
    await open();
    await openSearchPanel();

    await pointerDrag(boxed(await tile(), 0), boxedGroup("Main deck"));

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", MAIN, null, "live", null, 1);
    expect(deckUpdate).not.toHaveBeenCalled();
  });

  /**
   * A card dropped on another pile is `deck_move_card`, and **since 2026-08-14 this is the only
   * route to it** — it used to be the move select's write by another road. The hand-off is the
   * same one the stepper's zero makes: the card the reader was holding has left the pile it was
   * in, so the caret goes to the pile that now has it.
   */
  it("moves a card into the group it was dropped on, and hands the caret to it", async () => {
    await open();

    await pointerDrag(card_("Lightning Bolt"), boxedGroup("Sideboard"));

    await waitFor(() =>
      expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, SIDE, null, "live", null),
    );
    await waitFor(() => expect(group("Sideboard")).toHaveFocus());
  });

  /**
   * **And the same drag with the search drawn over the deck** — which is the half a new overlay
   * is never evidence for (2026-08-29).
   *
   * The cost that placement accepts is that there is nothing to drag a *search tile* into while
   * it covers the deck; what it must not touch is the drags that were already there. It adds no
   * drag source, no drop target and no `touch-action`, and it covers no element carrying one —
   * but "it should not have" is an argument, and this is the drag run in the new state. Same
   * source, same target, same write.
   *
   * jsdom has no layout engine and dnd-kit hit-tests by rect, so what this cannot show is
   * whether the overlay is *in the way* of a pointer — that is a live-window question, and the
   * answer it would give is the one already written down: the piles under the overlay are still
   * droppable by rect, which is why adding from the search here is a tap rather than a drag.
   */
  it("still moves a card between piles while the search is drawn over the deck", async () => {
    const restore = desk(390);
    try {
      await open();
      expect(screen.getByRole("region", { name: "Add cards" })).toHaveAttribute(
        SEARCH_OVER_ATTR,
        "deck",
      );

      await pointerDrag(card_("Lightning Bolt"), boxedGroup("Sideboard"));

      await waitFor(() =>
        expect(deckMoveCard).toHaveBeenCalledWith(
          4,
          "c-Lightning Bolt",
          MAIN,
          SIDE,
          null,
          "live",
          null,
        ),
      );
    } finally {
      restore();
    }
  });

  /**
   * The tray is the drag's own way out of the deck: it is not there until a card is in the air,
   * it names the card once it has it, and it writes the zero the stepper's last press writes.
   */
  it("offers a way out of the deck while a card is in the air", async () => {
    await open();
    expect(screen.queryByText(TRAY_TEXT)).not.toBeInTheDocument();

    const held = await startPointerDrag(card_("Lightning Bolt"));
    const tray = boxed(screen.getByText("Remove from deck"), 500, 40);
    await held.over(tray);
    expect(screen.getByText("Remove Lightning Bolt from deck")).toBeInTheDocument();
    await held.drop();

    // The same cut the stepper's zero makes, addressed by the row the drag started from — the
    // tray writes no command of its own.
    expect(deckToCollection).toHaveBeenCalledWith(expect.any(Number), 4);
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(TRAY_TEXT)).not.toBeInTheDocument());
  });

  /**
   * And it is not there for a card being dragged *in*: there is nothing in this deck to take
   * out, so a tray that appeared would be offering to undo something that never happened.
   */
  it("does not offer the tray for a card dragged in from the panel", async () => {
    const tile = panelHolds("Goblin Guide");
    await open();

    const held = await startPointerDrag(boxed(await tile(), 0));
    expect(screen.queryByText(TRAY_TEXT)).not.toBeInTheDocument();

    await held.cancel();
  });

  /**
   * **Escape ends the drag and spends nothing else, and that reverses what this case used to
   * pin.**
   *
   * It asserted that the press fell through to the editor's `"navigation"` floor and closed the
   * deck, on the reasoning that the editor registers no dismissible layer while a card is in the
   * air — which is still true, and was never the whole story. Its own comment said the other
   * half: *"in Chromium the keypress goes to the drag operation"*, and it only read the other way
   * because **jsdom had no drag to cancel**. A native HTML5 drag is the platform's, and the page
   * hears about the cancel as a `dragend`.
   *
   * `@dnd-kit/dom` cancels its own drag from a document-level listener, so jsdom now behaves the
   * way the shipped window always did: the press ends the gesture, the tray goes, nothing is
   * written, and the deck the reader is looking at stays open. A second press closes it.
   *
   * **Capture, so what the app sees is what is being asked about.** The probe is a window
   * capture listener, which runs before the sensor's, so `defaultPrevented` is false there — the
   * press arrives unspent and is consumed further down.
   */
  it("takes the tray away on the drag's own Escape, and leaves the deck open", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen, true);

    const held = await startPointerDrag(card_("Lightning Bolt"));
    expect(screen.getByText("Remove from deck")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(heard).toEqual([false]);
    // The drag took the press, so the view behind it is untouched.
    expect(useAppStore.getState().openDeckId).toBe(4);

    await held.cancel();

    await waitFor(() => expect(screen.queryByText(TRAY_TEXT)).not.toBeInTheDocument());
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    expect(deckToCollection).not.toHaveBeenCalled();
    expect(deckMoveCard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", listen, true);
  });

  /**
   * The quick zones, wired to this editor's writes.
   *
   * `QuickZones.test.tsx` drives the bar itself against a stub payload; what these prove is the
   * other half — that the writes a drop resolves to reach the same commands the controls beside
   * them do, and that the two-step New category really makes a pile and then files into it.
   */
  describe("quick zones", () => {

    /**
     * **They answer for a card dragged *in*, which is exactly what the remove tray does not** —
     * and it is the whole reason they own a monitor of their own rather than reading the state
     * the tray is drawn from. A drop on `Auto` names no category, so `deck_add_card` is sent a
     * `categoryId` of `null` and a pile name the rule worked out.
     */
    it("files a panel tile by what it does when it lands on the Auto zone", async () => {
      const tile = panelHolds("Goblin Guide");
      await open();

      const held = await startPointerDrag(boxed(await tile(), 0));
      expect(zone("Auto")).toBeInTheDocument();
      // The tray is not: there is nothing in this deck to take out.
      expect(screen.queryByText(TRAY_TEXT)).not.toBeInTheDocument();
      await held.over(boxedZone("Auto"));
      await held.drop();

      await waitFor(() =>
        expect(deckAddCard).toHaveBeenCalledWith(
          4,
          "s-Goblin Guide",
          // No column was pointed at, so `useDeck.addCard` names the pile — which name is
          // `autoCategory.test.ts`'s to pin, and pinning it twice would make one of the two a
          // copy that quietly stops meaning anything.
          null,
          expect.any(String),
          "live",
          null,
          1,
        ),
      );
    });

    /** A fixed zone is an ordinary category drop, and it moves a card that is already in the
     *  deck — the same write a drop onto that pile's own heading makes. */
    it("moves a deck card into the sideboard from the quick zone", async () => {
      await open();

      const held = await startPointerDrag(card_("Lightning Bolt"));
      await held.over(boxedZone("Sideboard"));
      await held.drop();

      await waitFor(() =>
        expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, SIDE, null, "live", null),
      );
    });

    /**
     * **`Auto` re-files a card the deck already holds** (2026-08-15), where it used to grey and
     * refuse. End to end this is the add rule run backwards: the card's Oracle tags, then
     * `autoCategoryFor`, then the move's **name arm** — `toCategoryId` null — so the pile is
     * found or created inside the move's own transaction and comes out `origin: 'auto'`.
     *
     * The type line reaching the rule is the half only this test can see: it is read off the
     * deck's own row rather than carried in the drag, which is `dnd.ts`'s decision and the reason
     * the payload did not have to grow a field.
     */
    it("re-files a deck card dropped on Auto by what it does", async () => {
      oracleTagsForPrintings.mockResolvedValue([
        { cardId: "c-Lightning Bolt", slugs: ["removal"] },
      ]);
      await open();

      const held = await startPointerDrag(card_("Lightning Bolt"));
      await held.over(boxedZone("Auto"));
      await held.drop();

      await waitFor(() =>
        expect(deckMoveCard).toHaveBeenCalledWith(
          4,
          "c-Lightning Bolt",
          MAIN,
          null,
          "Removal",
          "live", null),
      );
    });

    /**
     * The two answers that move nothing say so, because a deliberate gesture that changes the
     * screen not at all is the shape of thing that reads as a broken control. `Lightning Bolt`
     * is in `Main deck` and the rule with no tags files an `Instant` under `Instant`, so this
     * is the *unplaceable* half's sibling: a pile the card is not in, reached with no IPC.
     */
    it("says when a re-file had nothing to do, and writes nothing", async () => {
      oracleTagsForPrintings.mockResolvedValue([]);
      deckGet.mockResolvedValue(
        detail(
          {},
          [bolt({ categoryName: "Instant" })],
          [category(1, "Instant", "main"), ...CATEGORIES.slice(1)],
        ),
      );
      await open();

      const held = await startPointerDrag(card_("Lightning Bolt"));
      await held.over(boxedZone("Auto"));
      await held.drop();

      // By its text, not by its role: the quick-add field keeps a `role="status"` mounted for
      // the life of the toolbar (a live region that first appears with its sentence already
      // inside announces nothing), so this view has two and `getByRole` finds both.
      const note = await screen.findByText(/already filed under Instant/);
      expect(note).toHaveAttribute("role", "status");
      expect(deckMoveCard).not.toHaveBeenCalled();
    });

    /**
     * **Two acts, and the drop is only the first.** A modal cannot be opened mid-gesture, so the
     * name is asked for after the card has landed — and the pile is made and filled in that
     * order, by the same `dropWrite` rule a drop onto a drawn heading goes through.
     */
    it("makes a pile from a drop on New category and files the card into it", async () => {
      const tile = panelHolds("Goblin Guide");
      await open();

      const held = await startPointerDrag(boxed(await tile(), 0));
      await held.over(boxedZone("New category"));
      await held.drop();

      const field = await screen.findByLabelText("New category name");
      expect(screen.getByRole("dialog", { name: "New category" })).toBeInTheDocument();
      await userEvent.type(field, "Removal");
      await userEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Removal"));
      // The id the create answered with, not the name — the second write addresses a row.
      await waitFor(() =>
        expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", 9, null, "live", null, 1),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "New category" })).not.toBeInTheDocument(),
      );
    });

    /**
     * A refused create keeps the dialog open with the name still in the field, and says so where
     * the reader is looking: the editor's own banner is behind this dialog's scrim. Nothing is
     * filed, because there is no pile to file into.
     */
    it("keeps the dialog open and says so when the pile cannot be made", async () => {
      const tile = panelHolds("Goblin Guide");
      deckCategoryCreate.mockRejectedValue("a category called Removal already exists");
      await open();

      const held = await startPointerDrag(boxed(await tile(), 0));
      await held.over(boxedZone("New category"));
      await held.drop();

      await userEvent.type(await screen.findByLabelText("New category name"), "Removal");
      await userEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already exists"));
      expect(screen.getByLabelText("New category name")).toHaveValue("Removal");
      expect(deckAddCard).not.toHaveBeenCalled();
    });
  });
});

/**
 * The pure half of the export layer, asserted **directly** rather than through the rendered
 * dialog.
 *
 * That is a stated compromise and not the usual preference: when this was written the export
 * dialog was **one of the editor surfaces with no control in this view** — the delete-category
 * and clear-stack confirmations are the others — so there was nothing here to press and no
 * rendered path to reach it through. Both functions are exported for that reason.
 *
 * **Both scopes are wired now**, so the rendered path exists twice: `DeckEditor — a category's
 * menu` presses `Export cards…` and asserts the dialog opens on the pile that was right-clicked,
 * and the header's `Export deck` opens it over the whole list. These stay all the same, because
 * they pin the *pure* answers — the file name's punctuation rules, the deleted-category title —
 * which an integration case would only reach through a dialog that draws one of them and not the
 * other.
 */
describe("exportSubject", () => {
  const REMOVAL = category(11, "Removal", "main");
  const CARDS: DeckCard[] = [
    card({ name: "Swords to Plowshares", categoryId: REMOVAL.id }),
    card({ name: "Sol Ring", categoryId: 12 }),
  ];
  const pile = (categoryId: number) => ({ kind: "category", categoryId }) as const;

  it("takes the pile's own cards and nothing from another", () => {
    const exported = exportSubject(pile(REMOVAL.id), [REMOVAL], CARDS, "Burn");

    expect(exported.subject).toBe("Removal");
    expect(exported.cards.map((c) => c.name)).toEqual(["Swords to Plowshares"]);
    expect(exported.fileName).toBe("Burn - Removal");
  });

  /**
   * The header's press, which is the other half of the same layer.
   *
   * **Every row of the variant on screen and no filtering at all** — the switched-off piles
   * included, because what a format does with a maybeboard is the *format's* decision and
   * `omittedCount` is what says so in the dialog. **Mapped rather than identical** since the
   * cards it now hands `ExportDialog` are `TransferCard`s, built through `fromDeckCard` — the
   * claim this pins is that every row survives the conversion, in order, none dropped.
   */
  it("answers the whole deck for a deck scope", () => {
    const exported = exportSubject({ kind: "deck" }, [REMOVAL], CARDS, "Burn");

    expect(exported.subject).toBe("Burn");
    expect(exported.cards).toEqual(CARDS.map(fromDeckCard));
    expect(exported.fileName).toBe("Burn");
  });

  /** `Export ""` is not an accessible name — the deleted-pile title's argument, applied to the
   *  other scope. A deck with no name is reachable: the name field takes an empty string. */
  it("names an unnamed deck rather than titling itself with nothing", () => {
    expect(exportSubject({ kind: "deck" }, [REMOVAL], CARDS, "").subject).toBe("this deck");
  });

  /** Every render but the ones the dialog is up. `""` and **not** the deleted-pile wording: a
   *  closed dialog is not a statement about a pile that has gone. */
  it("says nothing at all while the layer is closed", () => {
    expect(exportSubject(null, [REMOVAL], CARDS, "Burn")).toEqual({
      subject: "",
      cards: [],
      fileName: "Burn",
    });
  });

  /**
   * Another surface — the Categories dialog, or a second window on the same database — can
   * delete a category while this dialog is open over it, and the editor re-reads the deck
   * without it. The empty card list is honest; `Export ""` as the dialog's accessible name was
   * not, which is the whole of what this fallback is for.
   */
  it("names a pile that has been deleted rather than titling itself with nothing", () => {
    // The re-read has lost the category **and** its rows — `deck_cards.category_id` is
    // `ON DELETE CASCADE` — so this is the state the open dialog actually lands in. The filter
    // itself is not what empties the list: it answers whatever rows still claim that id, which
    // is the honest reading of a pile mid-delete.
    const cascaded = CARDS.filter((c) => c.categoryId !== REMOVAL.id);
    const exported = exportSubject(pile(REMOVAL.id), [], cascaded, "Burn");

    expect(exported.subject).toBe("a deleted category");
    expect(exported.cards).toEqual([]);
    // The category's **name**, never the subject: `Burn - a deleted category` is a sentence
    // where a file name belongs.
    expect(exported.fileName).toBe("Burn");
  });

  /** The point of the layer carrying an id and not the cards: a write under the open dialog is
   *  followed rather than frozen at the moment the menu row was pressed. */
  it("follows a rename made under the open dialog", () => {
    const renamed = { ...REMOVAL, name: "Interaction" };

    expect(exportSubject(pile(REMOVAL.id), [renamed], CARDS, "Burn").subject).toBe("Interaction");
  });
});

/**
 * **`export` is the one layer kind two controls reach**, so it is the one kind whose *kind* is
 * not enough to say which control is open.
 *
 * The header's `Export deck` and a category heading's `Export cards…` are the two, and a header
 * button reading `aria-expanded` off the kind alone would claim to be open while a *pile's*
 * dialog was up. Everything else in the union has one opener and answers on the kind, which is
 * the third case below — this must stay a widening of the old expression rather than a second
 * rule beside it.
 */
describe("layerMatches", () => {
  it("tells the header's export from a category's", () => {
    const deckScope = { kind: "export", categoryId: null } as const;

    expect(layerMatches(deckScope, deckScope)).toBe(true);
    expect(layerMatches({ kind: "export", categoryId: 3 }, deckScope)).toBe(false);
    expect(layerMatches(deckScope, { kind: "export", categoryId: 3 })).toBe(false);
    expect(layerMatches({ kind: "export", categoryId: 3 }, { kind: "export", categoryId: 3 })).toBe(
      true,
    );
  });

  it("answers on the kind for every layer that has one opener, and never for a closed one", () => {
    expect(layerMatches({ kind: "labels" }, { kind: "labels" })).toBe(true);
    expect(layerMatches({ kind: "labels" }, { kind: "history" })).toBe(false);
    expect(layerMatches(null, { kind: "labels" })).toBe(false);
    expect(layerMatches(null, { kind: "export", categoryId: null })).toBe(false);
  });

  /**
   * **The pull is the second kind two controls reach** (2026-09-03): the stats band opens it over
   * the whole deck and a card's `Collection ▸ Pull …` opens it over one row. Neither is reachable
   * while the other is up — one slot, and both are modal — so this is asserted directly, which is
   * the same reason the export case above is a unit test rather than a press.
   *
   * The card comparison is by `pullKey` rather than by object identity, because a `DeckCard` is a
   * fresh object on every `deck_get`: the two `bolt()` calls below are two objects naming one row,
   * which is exactly what a refetch under an open dialog produces.
   */
  it("tells the deck-wide pull from a card's", () => {
    const deckWide = { kind: "pull" } as const;
    const perCard = { kind: "pull", card: bolt() } as const;

    expect(layerMatches(deckWide, deckWide)).toBe(true);
    expect(layerMatches(perCard, deckWide)).toBe(false);
    expect(layerMatches(deckWide, perCard)).toBe(false);
    expect(layerMatches(perCard, { kind: "pull", card: bolt() })).toBe(true);
    expect(
      layerMatches(perCard, { kind: "pull", card: bolt({ finish: "foil" }) }),
    ).toBe(false);
  });
});

/**
 * **The card's own right-click, driven through the real editor.**
 *
 * `deckCardMenu.test.tsx` owns what the rows *are*; this file owns that the editor builds them
 * from the deck it has open and that a press reaches the write. The two halves are worth
 * separating because the interesting failures live in the wiring: an editor building the menu
 * from the drawn groups instead of its `categories` array would pass every unit test in that
 * file and still be unable to reach the one pile this menu exists for.
 */
describe("DeckEditor — a card's menu", () => {
  /**
   * A pile the app made while filing a card, with nothing in it.
   *
   * `drawsWhenEmpty` keeps an empty `auto` pile off the desk entirely — nobody asked for it, and
   * it comes back with the next card the rule files there — so it has **no heading**, and a
   * heading that is not drawn is not a drop target. It is the one pile a drag cannot reach.
   */
  const RECURSION = category(7, "Recursion", "main", { origin: "auto", sortOrder: 5 });

  const BUDGET: DeckLabel = { id: 8, name: "Budget swap", color: "moss", cardCount: 1 };

  /** Right-click the card the editor drew, found by the slot every view stamps on it. */
  async function rightClickCard(name: string) {
    const el = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, `c-${name}`, null)}"]`,
    );
    expect(el).not.toBeNull();
    // A raw dispatch outside `act()` is not flushed synchronously, which is why every caller
    // waits on the panel by role rather than reading it straight back.
    fireEvent.contextMenu(el as HTMLElement);
    return screen.findByRole("menu");
  }

  /** Open a submenu by pressing its row. Hover would do it too, after `SUBMENU_HOVER_MS` — a
   *  press is the same code path with no timer in it. */
  async function expand(name: RegExp) {
    await userEvent.click(screen.getByRole("menuitem", { name }));
  }

  it("offers the deck's own rows under the card menu every other surface draws", async () => {
    await open();
    await rightClickCard("Lightning Bolt");

    expect(screen.getByRole("menuitem", { name: "Copy card name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Add to/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Move to/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Label card/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove card" })).toBeInTheDocument();
  });

  /**
   * **`Remove card` is the stepper's zero by another road, and that is the whole of it.**
   *
   * There is no `remove` mutation in this app — the remove tray's drop and the stepper's last
   * press are both `deck_set_card_quantity(…, 0)` — so this row adds a third caller of one write
   * rather than a second way to take a card out. It gets that write's hand-off for free: the
   * caret goes to the pile the card just left, which is what the tray and the stepper already do.
   *
   * **No confirmation**, unlike the pile's `Clear stack…`: one card is one add to put back.
   */
  it("removes a card straight from its menu, with nothing to confirm", async () => {
    await open();
    await rightClickCard("Lightning Bolt");

    await userEvent.click(screen.getByRole("menuitem", { name: "Remove card" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The third caller of one removal write, which on the Live list is the cut — see
    // `removes a card when its stepper reaches zero`.
    expect(deckToCollection).toHaveBeenCalledWith(expect.any(Number), 4);
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.querySelector(`[${DECK_GROUP_ATTR}="${MAIN}"]`)).toHaveFocus(),
    );
  });

  /**
   * **Shift+F10, and it is not a nicety here.**
   *
   * The per-card `Move…` select was removed on 2026-08-14 and took the only keyboard path to
   * moving a card with it — a caret cannot drag, and stepping to zero and adding again elsewhere
   * is a different write that loses the slot. This menu is the replacement, so a menu only a
   * mouse could open would restore nothing. The panel is anchored at the card's own corner
   * rather than at a pointer that was never there, which is `menuKey`'s whole job.
   */
  it("opens a card's menu from the keyboard, and offers the move from there", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, RECURSION]));
    await open();

    const el = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, "c-Lightning Bolt", null)}"]`,
    ) as HTMLElement;
    el.focus();
    fireEvent.keyDown(el, { key: "F10", shiftKey: true });

    await screen.findByRole("menu");
    await expand(/Move to/);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Recursion" }));

    expect(deckMoveCard).toHaveBeenCalledWith(
      4,
      "c-Lightning Bolt",
      MAIN,
      RECURSION.id,
      null,
      "live", null);
  });

  /**
   * **The whole reason this menu exists.**
   *
   * The per-card `Move…` select was removed on 2026-08-14 and it was the one control built from
   * the deck's `categories` rather than from the drawn groups — so it could reach a pile with no
   * heading, which is the one thing a drag cannot do. This asserts both halves in one case: the
   * pile draws no heading, and the menu moves a card into it anyway.
   */
  it("moves a card into a pile with no heading on screen", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, RECURSION]));
    await open();
    // Not drawn: an emptied auto pile is a heading about a card the deck does not contain.
    expect(screen.queryByRole("region", { name: "Recursion" })).toBeNull();

    await rightClickCard("Lightning Bolt");
    await expand(/Move to/);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Recursion" }));

    expect(deckMoveCard).toHaveBeenCalledWith(
      4,
      "c-Lightning Bolt",
      MAIN,
      RECURSION.id,
      null,
      "live", null);
  });

  /**
   * **Every category the deck has, in the reader's own `sortOrder`** — a documented exemption
   * from `sortOptions`, of the kind whose order the reader arranged themselves. (No count and
   * no ordinal: `src/CLAUDE.md` keeps no list of the exemptions any more, precisely because
   * "exactly two" was false within a day of being written. The comment at each site is the
   * record.) Sorted, this list would read Commander, Companion,
   * Main deck, Maybeboard, Recursion, Sideboard, which is a different order in the menu from the
   * one the desk and the Categories dialog draw.
   */
  it("keeps the reader's own category order rather than sorting it", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, RECURSION]));
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Move to/);

    const panel = (await screen.findAllByRole("menu"))[1];
    const rows = within(panel).getAllByRole("menuitem");
    // The pile the card is already in is drawn and greyed rather than dropped — "every
    // category" is what makes the list findable by position — so its row carries its reason.
    expect(rows.map((r) => r.textContent)).toEqual([
      "Main deckalready here",
      "Sideboard",
      "Commander",
      "Companion",
      "Maybeboard",
      "Recursion",
    ]);
    expect(rows[0]).toHaveAttribute("aria-disabled", "true");
  });

  /** Modern has no command zone, so neither zone row is a thing this deck can be asked about. */
  it("offers no commander row in a format with no command zone", async () => {
    await open();
    await seeded("Modern");
    await rightClickCard("Lightning Bolt");

    expect(screen.queryByRole("menuitem", { name: /Set as commander/ })).not.toBeInTheDocument();
  });

  /**
   * …and in a format that has one, an ineligible card is **greyed** rather than hidden — the test
   * being `commanderIneligibility`'s, the rule the validation panel judges the built deck by.
   *
   * `aria-disabled` and never the `disabled` attribute: the row exists to be read, so it has to
   * stay in the tab order.
   *
   * **The row's whole text is its label** (2026-08-17). It drew the rule's sentence beside the
   * label until then, and a menu row is as wide as its widest content, so those two zone rows
   * set the width of the entire card menu. Asserting the *absence* here rather than only in
   * `deckCardMenu.test.tsx` is what pins the width fix to what the reader actually sees: a
   * builder that stopped passing `reason` and a primitive that stopped drawing it are two
   * different fixes and only this one is blind to which it got.
   */
  it("greys the commander row in Commander, and words no refusal on it", async () => {
    deckGet.mockResolvedValue(
      detail({ formatKey: "commander", formatName: "Commander" }, [bolt()]),
    );
    await open();
    await seeded("Commander");

    await rightClickCard("Lightning Bolt");
    const row = await screen.findByRole("menuitem", { name: /Set as commander/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent(/^Set as commander$/);
  });

  /**
   * …and a card it *can* fill gets a live row, in the editor rather than only in the unit file.
   *
   * The second assertion is the one worth having here: the primitive omits `aria-disabled`
   * **entirely** on a live row rather than writing `"false"`, so a test written against the
   * string would pass on a row that had quietly become disabled and vice versa.
   */
  it("offers the commander row live for a card the rules allow", async () => {
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    deckGet.mockResolvedValue(
      detail({ formatKey: "commander", formatName: "Commander" }, [atraxa]),
    );
    await open();
    await seeded("Commander");

    await rightClickCard("Atraxa, Praetors' Voice");
    const row = await screen.findByRole("menuitem", { name: /Set as commander/ });
    expect(row).not.toHaveAttribute("aria-disabled");

    await userEvent.click(row);
    // Into the deck's own command zone — the write is a move, not a second kind of add.
    expect(deckMoveCard).toHaveBeenCalledWith(
      4,
      "c-Atraxa, Praetors' Voice",
      MAIN,
      CATEGORIES[2].id,
      null,
      "live", null);
  });

  /** A deck card wears at most one label, so the rows are radios and the card's own is ticked. */
  it("draws the labels as a radio group with the card's own ticked", async () => {
    deckGet.mockResolvedValue(
      detail({}, [bolt({ labelId: 8, labelName: "Budget swap", labelColor: "moss" })], CATEGORIES, [
        BUDGET,
      ]),
    );
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);

    expect(await screen.findByRole("menuitemradio", { name: "None" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("menuitemradio", { name: "Budget swap" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("puts the deck's label on the card that was right-clicked", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()], CATEGORIES, [BUDGET]));
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Budget swap" }));

    expect(deckCardSetLabel).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", null, 8);
  });

  /**
   * **"New label…" is two writes, and the second one is the editor's rather than the menu's.**
   *
   * A `useMutation`'s callbacks belong to its observer, so a chain started inside the panel would
   * lose its second half to any dismissal landing during the round trip — the label created and
   * silently never attached. The mutation is mounted in `DeckEditor`, which is still on screen
   * when the answer arrives, so the row can close the menu on the press and the chain still
   * completes. That is what the second half of this case asserts: the panel is **already gone**
   * before either command has answered.
   *
   * **The field this drove became a dialog on 2026-08-20**, and the colour is why: it was a text
   * box inside the panel that created in `DEFAULT_LABEL_COLOR` because a menu has no room for a
   * picker, so every label made this way was gold. Two presses instead of one, and the label
   * arrives in the colour the reader chose — everything about the *chain* is unchanged, which is
   * what the three cases here are actually about.
   *
   * **That dialog became a picker with a create in it at schema v21**, and the chain is still
   * untouched: the row is "More labels…", the field is "Find or name a label", and the button says
   * the name back. What is new is the *other* press — see the case below this one, where an
   * existing label goes on the card with no create at all.
   */
  it("makes a label from the menu's More labels… dialog and puts it on the card", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()]));
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);

    await userEvent.click(await screen.findByRole("menuitem", { name: "More labels…" }));
    // The menu is gone the moment the row is pressed; the dialog is what is left.
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await screen.findByRole("dialog", { name: "Add label" });

    await userEvent.type(screen.getByLabelText("Find or name a label"), "Cut candidate");
    await userEvent.click(screen.getByRole("button", { name: "Slate" }));
    await userEvent.click(screen.getByRole("button", { name: "Create “Cut candidate”" }));

    // The colour the reader picked, where the field this replaced sent gold and never asked.
    await waitFor(() =>
      expect(deckLabelCreate).toHaveBeenCalledWith(4, "Cut candidate", "#c8c4bf"),
    );
    // …and the chain's second half runs with the dialog long gone.
    await waitFor(() =>
      expect(deckCardSetLabel).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", null, 12),
    );
  });

  /**
   * **The create outlives the surface it was asked for from, driven the hard way**: the reader
   * presses Escape while the label is still being written.
   *
   * This is the case the `mutate`-scoped chain could not survive and the reason the write lives
   * in the editor. The create is held open until after the dismissal, so the observer would be
   * long gone by the time it answered if it belonged to the panel — or, now, to the dialog, which
   * is a second surface with the same lifetime problem and the same answer.
   */
  it("attaches a label whose create was still in flight when the dialog was dismissed", async () => {
    let landed: (label: DeckLabel) => void = () => {};
    deckLabelCreate.mockImplementation(
      () =>
        new Promise<DeckLabel>((resolve) => {
          landed = resolve;
        }),
    );
    deckGet.mockResolvedValue(detail({}, [bolt()]));
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);

    await userEvent.click(await screen.findByRole("menuitem", { name: "More labels…" }));
    await userEvent.type(await screen.findByLabelText("Find or name a label"), "Cut candidate");
    await userEvent.click(screen.getByRole("button", { name: "Create “Cut candidate”" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add label" })).not.toBeInTheDocument(),
    );
    expect(deckCardSetLabel).not.toHaveBeenCalled();

    landed({ id: 12, name: "Cut candidate", color: "#d9b95c", cardCount: 0 });

    await waitFor(() =>
      expect(deckCardSetLabel).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", null, 12),
    );
  });

  /**
   * …and a refused *create* is spoken for by the deck's own banner, which is why the mutation is
   * in the editor's refused-write family rather than merely mounted in it.
   *
   * A label the reader typed and pressed Add label on, that never appears and never says why, is
   * the silent failure this family exists to prevent — and the dialog it was typed in closes on
   * the press, so there is nowhere else it could be said.
   */
  it("says so when the menu's label create is refused", async () => {
    deckLabelCreate.mockRejectedValue("The database is busy");
    deckGet.mockResolvedValue(detail({}, [bolt()]));
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);

    await userEvent.click(await screen.findByRole("menuitem", { name: "More labels…" }));
    await userEvent.type(await screen.findByLabelText("Find or name a label"), "Cut candidate");
    await userEvent.click(screen.getByRole("button", { name: "Create “Cut candidate”" }));

    expect(
      await screen.findByText(/Could not change this deck — The database is busy/),
    ).toBeInTheDocument();
  });

  /**
   * **The other press the dialog grew, and the one the issue is chiefly about**: a label the reader
   * already owns, that this deck's list is not wearing, goes on the card with **no create at
   * all**.
   *
   * It is one write rather than two, so nothing here needs the chain the three cases above are
   * about — which is exactly why it is worth pinning separately. The choices are the app-wide
   * list minus what the context menu already offered, subtracted in the editor because that is
   * the only place holding both halves.
   */
  it("puts a label the reader owns but this list does not wear on the card", async () => {
    deckLabelAll.mockResolvedValue([
      { id: 8, name: "Budget swap", color: "moss", cardCount: 3, deckCount: 2 },
      // Already on a card in this list, so the menu offers it and the dialog must not.
      { id: 9, name: "Wincon", color: "gold", cardCount: 1, deckCount: 1 },
    ]);
    deckGet.mockResolvedValue(
      detail({}, [bolt()], CATEGORIES, [
        { id: 9, name: "Wincon", color: "gold", cardCount: 1 },
      ]),
    );
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Label card/);

    await userEvent.click(await screen.findByRole("menuitem", { name: "More labels…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add label" });
    // The label this list already wears is a radio in the *menu*, never a row here. Scoped to the
    // dialog because the editor's toolbar draws a label filter chip by the same name.
    expect(within(dialog).queryByRole("button", { name: /Wincon/ })).not.toBeInTheDocument();

    await userEvent.click(await within(dialog).findByRole("button", { name: /Budget swap/ }));

    expect(deckLabelCreate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(deckCardSetLabel).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", null, 8),
    );
  });

  /**
   * **A refused collection add from the menu has to be said somewhere, and this is the somewhere.**
   *
   * `useCardMenuDeps` states it plainly: a page that ignores that sentence is a page where a card
   * silently fails to be added. The menu cannot draw it — `ctx.run` closes the panel before the
   * row's handler even starts the write — so the editor draws it, in a banner of its own beside
   * the one that speaks for writes to the deck.
   */
  it("says so when a card menu's collection add is refused", async () => {
    collectionAdd.mockRejectedValue("The database is busy");
    await open();
    await rightClickCard("Lightning Bolt");
    await expand(/Add to/);
    // One finish on this printing, so `Collection` is a plain row rather than a submenu — but
    // **two rows on this menu are called `Collection` since 2026-09-03**: this destination and
    // the new `Collection ▸` submenu of quick actions. `deckCardMenu.tsx` says the repeat is
    // deliberate — it is the reader's binder in both places, and a second name for it would read
    // as a second thing — and what tells them apart is the panel each is in, which is what a
    // reader sees and what a screen reader announces. So the press is scoped to the open
    // submenu's panel, which is the last `role="menu"` in the tree.
    const panels = screen.getAllByRole("menu");
    const addTo = panels[panels.length - 1];
    expect(addTo).toBeDefined();
    await userEvent.click(
      await within(addTo as HTMLElement).findByRole("menuitem", { name: "Collection" }),
    );

    expect(await screen.findByText(/Could not add to your collection/)).toBeInTheDocument();
  });

  /**
   * **Where the caret goes when the menu closes, in every view.**
   *
   * `useContextMenu` takes the element the handler is attached to as the panel's `opener`, and
   * `ContextMenu` hands the caret back to it on Escape and on every chosen row. **`focus()` on an
   * element with no `tabindex` is a no-op**, so without `deckCardMenuProps`' `tabIndex: -1` the
   * hand-back lands nowhere and the next Tab restarts from the top of the document — invisible to
   * a test that only asserts the menu closed, and worst on the one affordance this menu exists to
   * restore, since Shift+F10 → `Move to` is the keyboard's only route to a move.
   *
   * Swept across all four because three of them hang the handlers on an `<li>` and the table hangs
   * them on a row `VirtualTable` already made focusable — so the table passes either way, and a
   * sweep is what stops that masking the other three.
   */
  it.each(["stacks", "table", "text", "grid"])(
    "gives the caret back to the card when the menu closes in %s",
    async (view) => {
      const user = userEvent.setup();
      await open();
      await pickOption(user, "View", VIEW_LABEL[view]);

      const marked = await waitFor(() => {
        const el = document.querySelector<HTMLElement>(
          `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, "c-Lightning Bolt", null)}"]`,
        );
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      // The slot is stamped on the card's *button* in the three card views and on the row itself
      // in the table — and the opener is whatever the handlers were spread onto, which is the
      // `<li>` in the first three. `views.test.tsx`'s drag helper resolves it the same way.
      const opener = marked.closest("li") ?? marked;

      marked.focus();
      fireEvent.keyDown(marked, { key: "F10", shiftKey: true });
      await screen.findByRole("menu");

      await userEvent.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      // The card, not `<body>` — and the *opener* rather than merely something inside the card,
      // because the opener is what `focus()` is called on and what has to be able to take it.
      expect(document.activeElement).toBe(opener);
    },
  );

  /**
   * The docked panel's tiles are cards too, and the menu they offer is the plain one — a search
   * result is in no deck, so none of the four deck rows means anything about it.
   *
   * **Both doors in one case, deliberately.** They are two slots on `CardGrid` (a keypress has
   * no coordinates, so the panel is anchored at the tile's own corner instead) and each is
   * asserted on its own, but the setup they share is a search panel opened and a page of results
   * — the slowest thing in this file — and two copies of it made the pair the flakiest tests in
   * it under load rather than the most informative.
   */
  it("offers the panel's tiles the card menu, from the pointer and from the keyboard", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    await open();
    await openSearchPanel();

    // The tile's art button, whose name is the card and nothing else — the quick add beside it
    // is called "Add Goblin Guide to …", which is why this one is matched exactly.
    const tile = await screen.findByRole("button", { name: "Goblin Guide" });
    tile.focus();
    fireEvent.keyDown(tile, { key: "F10", shiftKey: true });

    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Copy card name" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Move to/ })).not.toBeInTheDocument();

    // Escape closes the menu it opened, so the pointer half below is a fresh open rather than a
    // panel that was already there — which is the whole of what makes it discriminate.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.contextMenu(tile);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  /**
   * **`View all printings` hands the modal the slot, not a destination** — and the slot is all
   * five parts of `DECK_CARD_GRAIN` plus the deck, which is what makes a press inside the modal
   * a swap of *this* row.
   *
   * `toEqual` rather than `toMatchObject` on purpose: the failure this guards against is a slot
   * that names four parts instead of five, and `toMatchObject` is exactly the assertion that
   * cannot see a missing one. `PaneDeckContext`'s own doc records that mistake twice — over
   * `variant` and over `finish` — each time rewriting a deck row the reader was not looking at.
   */
  it("hands the printings modal the slot the card was right-clicked in", async () => {
    await open();
    await rightClickCard("Lightning Bolt");

    await userEvent.click(screen.getByRole("menuitem", { name: "View all printings" }));

    expect(useAppStore.getState().printingsRequest).toEqual({
      cardId: "c-Lightning Bolt",
      oracleId: "o-Lightning Bolt",
      name: "Lightning Bolt",
      deck: {
        deckId: 4,
        categoryId: MAIN,
        categoryName: "Main deck",
        cardId: "c-Lightning Bolt",
        variant: "live",
        finish: null,
      },
      // No wish either: `wishlist_set_printing`'s target is set only by the wishlist's own
      // rows, and `toEqual` reads an absent key and a `null` one as two different answers.
      wish: null,
    });
  });

  /**
   * A docked search tile is **not** a row of this deck, so it supplies no slot and a press in the
   * modal opens the card pane on that printing instead of rewriting something.
   *
   * The tile and the deck card sit on one screen and draw the same menu, so this is the pair that
   * discriminates: a `printingsDeck` fixed once for the whole editor would pass the test above
   * and quietly offer a swap of some deck row from a card the deck does not hold.
   */
  it("hands it no slot from the docked search panel's tiles", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });
    await open();
    await openSearchPanel();

    fireEvent.contextMenu(await screen.findByRole("button", { name: "Goblin Guide" }));
    await screen.findByRole("menu");
    await userEvent.click(screen.getByRole("menuitem", { name: "View all printings" }));

    expect(useAppStore.getState().printingsRequest).toEqual({
      cardId: "s-Goblin Guide",
      oracleId: "o-Goblin Guide",
      name: "Goblin Guide",
      deck: null,
      // No wish either: `wishlist_set_printing`'s target is set only by the wishlist's own
      // rows, and `toEqual` reads an absent key and a `null` one as two different answers.
      wish: null,
    });
  });

  /**
   * **The deck stays open behind the modal, which is the whole point of the change.**
   *
   * The row used to be a *navigation*: it wrote `activeView`, `selectedCardId` and `openDeckId`
   * in one `set`, so asking a question about a card closed the deck it was being asked about.
   * `openAllPrintings` writes one field, and the first three assertions here are exactly the
   * three fields that write used to move. The fourth is the one a reader would have reported:
   * the editor itself, still on screen with the deck in it.
   */
  it("leaves the deck open when printings are asked for", async () => {
    await open();
    await rightClickCard("Lightning Bolt");

    await userEvent.click(screen.getByRole("menuitem", { name: "View all printings" }));

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(4);
    expect(useAppStore.getState().selectedCardId).toBeNull();
    expect(screen.getByLabelText("Deck name")).toBeInTheDocument();
  });

  /**
   * **`Set as foil` moves the row's address, so it has to move the mark with it** — the reported
   * defect (2026-08-18), and the seam it comes from is the one `swap_printing` already met.
   *
   * A deck row is addressed by `(deck, category, card, variant, finish)` — the pane's context is
   * that address, and `selectedSlot` is drawn from it. The finish write changes the fifth part,
   * so a context left alone names a row that no longer exists: the gold ring goes out, the pane
   * stays open on a card it can no longer say anything about, and its own foil button and swap
   * write to a dead slot. The swap's answer was to re-anchor through `openCardFromDeck`; this is
   * the same answer one axis over, and it is on the mutation rather than here because two
   * surfaces press this write.
   *
   * The refetched deck is the foil row, which is what the write actually leaves behind — without
   * it the mark could only be lost, and a passing assertion would mean nothing.
   */
  it("keeps the picked card picked when its finish is set", async () => {
    const FOILABLE = { finishes: '["nonfoil","foil"]' };
    deckGet.mockResolvedValue(detail({}, [bolt(FOILABLE)]));
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    expect(document.querySelectorAll(`[${SELECTED_ATTR}]`)).toHaveLength(1);

    // What the deck reads as once the write has landed: one row, now foil.
    deckGet.mockResolvedValue(detail({}, [bolt({ ...FOILABLE, finish: "foil" })]));
    await rightClickCard("Lightning Bolt");
    await userEvent.click(screen.getByRole("menuitem", { name: "Set as foil" }));

    expect(deckSetCardFinish).toHaveBeenCalledWith(
      4,
      "c-Lightning Bolt",
      MAIN,
      "live",
      null,
      "foil",
    );
    // The context follows the row, which is what keeps the pane attached to it.
    await waitFor(() =>
      expect(useAppStore.getState().paneDeckContext).toMatchObject({
        cardId: "c-Lightning Bolt",
        categoryId: MAIN,
        finish: "foil",
      }),
    );

    // Named by the slot as well as counted: a count of 1 would also pass if the ring had landed
    // on some other card.
    const marked = await waitFor(() => {
      const found = [...document.querySelectorAll(`[${SELECTED_ATTR}]`)];
      expect(found).toHaveLength(1);
      return found;
    });
    expect(marked[0].querySelector(`[${DECK_CARD_ATTR}]`) ?? marked[0]).toHaveAttribute(
      DECK_CARD_ATTR,
      deckCardSlot(MAIN, "c-Lightning Bolt", "foil"),
    );
  });
});

/**
 * **`Collection ▸` — the three presses that answer a card's shortfall** (issue #350).
 *
 * These are the editor's only menu rows that *read before they write*, and the read is what every
 * case here is really about: whether a press asks the backend anything at all, whether the answer
 * is turned into a write or into a dialog, and what happens when it refuses. The rows' own labels
 * and their greying are `deckCardMenu.test.tsx`'s — this file owns the wiring behind them.
 *
 * **A shortfall of four on every fixture**, because the count travels from the row into the label
 * *and* into the write: `bolt()` is a playset the reader owns three of, and a `1` in an assertion
 * would be indistinguishable from a hard-coded one. `ownedQuantity: 0` is what makes it four.
 */
describe("DeckEditor — the Collection submenu", () => {
  /** A live row of four the reader owns none of, so every label and every write says `4`. */
  const SHORT = () => bolt({ quantity: 4, ownedQuantity: 0 });

  /** Two wishes for one printing — the ambiguous case, and the only one that draws a dialog.
   *  One at the root and one in a folder, which is what the rows are told apart by. */
  const WISHES = [
    { id: 31, quantity: 2, folderId: null, folderName: null },
    { id: 32, quantity: 4, folderId: 8, folderName: "Modern staples" },
  ];

  /** One `deck_pull_plan` row for this card, with as many candidates as a case wants. `short` is
   *  the deck's own shortfall, so the plan and the menu label quote one number. */
  function planRow(entryIds: number[], over: Record<string, unknown> = {}) {
    return {
      cardId: "c-Lightning Bolt",
      name: "Lightning Bolt",
      setCode: "m10",
      collectorNumber: "146",
      finish: null,
      short: 4,
      categories: ["Main deck"],
      imageUris: null,
      candidates: entryIds.map((entryId) => ({
        entryId,
        quantity: 4,
        folderId: null,
        folderName: null,
        folderKind: null,
        condition: "NM",
        lang: "en",
        altered: false,
        signed: false,
        proxy: false,
        misprint: false,
        grading: null,
        serialNumber: null,
      })),
      ...over,
    };
  }

  /** Right-click the card, open `Collection ▸`, and hand back the panel. */
  async function collectionMenu(name = "Lightning Bolt") {
    const el = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, `c-${name}`, null)}"]`,
    );
    expect(el).not.toBeNull();
    fireEvent.contextMenu(el as HTMLElement);
    await screen.findByRole("menu");
    await userEvent.click(screen.getByRole("menuitem", { name: "Collection" }));
  }

  /**
   * **A right-click costs nothing**, which is the whole reason the two reads are `fetchQuery` at
   * the press rather than hooks — a mounted query per drawn card would ask the wishlist and the
   * collection about every card in the deck.
   *
   * The opening of the submenu is in the same case as the absence, because "it was not called"
   * passes just as well against a menu that never drew the rows.
   */
  it("asks the backend nothing until one of the three rows is pressed", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    await open();
    await collectionMenu();

    expect(
      await screen.findByRole("menuitem", { name: "Quick add 4 copies" }),
    ).toBeInTheDocument();
    expect(deckQuickAddWishes).not.toHaveBeenCalled();
    expect(deckPullPlan).not.toHaveBeenCalled();
  });

  /** The plain add: the copies, into this deck's group, and the wishlist untouched — which is
   *  `wishId: null` and, just as load-bearing, **no wish read at all**. */
  it("records the shortfall and never looks at the wishlist", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    await open();
    await collectionMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Quick add 4 copies" }));

    await waitFor(() =>
      expect(deckQuickAddToCollection).toHaveBeenCalledWith(
        4,
        "c-Lightning Bolt",
        null,
        "NM",
        4,
        null,
      ),
    );
    expect(deckQuickAddWishes).not.toHaveBeenCalled();
  });

  /**
   * **One matching wish is not a question**, which is `chooseWish`'s rule and the half of this
   * feature most easily broken by "just always ask": the write goes with that wish's id and no
   * dialog is drawn at all.
   *
   * The absence is asserted **after** the write has landed rather than immediately, or it would
   * pass against a dialog that had simply not opened yet.
   */
  it("clears a single matching wish without asking", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue([WISHES[0]]);
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );

    await waitFor(() => expect(deckQuickAddWishes).toHaveBeenCalledWith("c-Lightning Bolt", null));
    await waitFor(() =>
      expect(deckQuickAddToCollection).toHaveBeenCalledWith(
        4,
        "c-Lightning Bolt",
        null,
        "NM",
        4,
        31,
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Which wish?" })).not.toBeInTheDocument();
  });

  /** No matching wish is not a question either, and the press is exactly the plain add — the
   *  row still records the copies rather than refusing because there was nothing to clear. */
  it("records the copies when no wish matches at all", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );

    await waitFor(() =>
      expect(deckQuickAddToCollection).toHaveBeenCalledWith(
        4,
        "c-Lightning Bolt",
        null,
        "NM",
        4,
        null,
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Which wish?" })).not.toBeInTheDocument();
  });

  /**
   * Two wishes for one printing is the one case with an answer only the reader has, so the press
   * stops at the dialog — **nothing is written before it is answered**, which is the assertion
   * that makes "Cancel does nothing" possible at all.
   */
  it("asks which wish when two match, and writes nothing until it is answered", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue(WISHES);
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Which wish?" });
    expect(within(dialog).getByRole("radio", { name: /Wishlist/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Modern staples/ })).not.toBeChecked();
    expect(deckQuickAddToCollection).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("radio", { name: /Modern staples/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Record 4 copies" }));

    await waitFor(() =>
      expect(deckQuickAddToCollection).toHaveBeenCalledWith(
        4,
        "c-Lightning Bolt",
        null,
        "NM",
        4,
        32,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Which wish?" })).not.toBeInTheDocument(),
    );
  });

  /**
   * **Cancel does nothing at all, including the add** — the decision this dialog exists to
   * enforce, and the one a later "surely we should still record the copies" would break silently.
   *
   * The reader asked for both halves of one act and got neither; a collection row recorded
   * against a wish still standing is the exact state the row exists to prevent.
   */
  it("writes nothing at all when the wish question is cancelled", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue(WISHES);
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Which wish?" });

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Which wish?" })).not.toBeInTheDocument(),
    );
    expect(deckQuickAddToCollection).not.toHaveBeenCalled();
  });

  /**
   * **A lone candidate is unambiguous, so the pull happens with no dialog** — and that is true
   * even when it cannot cover the line: what there is, is taken. `choosePull`'s rule.
   */
  it("pulls outright when one source can supply the card", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckPullPlan.mockResolvedValue([planRow([55])]);
    await open();
    await collectionMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Pull 4 from your collection" }));

    await waitFor(() =>
      expect(deckPullFromCollection).toHaveBeenCalledWith(4, [{ entryId: 55, quantity: 4 }]),
    );
    expect(screen.queryByRole("dialog", { name: "Pull from collection" })).not.toBeInTheDocument();
  });

  /**
   * **Two candidates is the issue's own question**, so the dialog opens — and it opens holding
   * **only this card's row**.
   *
   * The second fixture row is the whole case: a dialog handed the unfiltered plan would draw the
   * other card too, which is a per-card press that quietly became the deck-wide one. The subtitle
   * is asserted beside it because it is the only thing on screen that says which of the two
   * scopes a reader is looking at.
   */
  it("opens the pull on this card alone when two sources could supply it", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT(), card({ name: "Bear", quantity: 2 })]));
    deckPullPlan.mockResolvedValue([
      planRow([55, 56]),
      planRow([57], { cardId: "c-Bear", name: "Bear", short: 2 }),
    ]);
    await open();
    await collectionMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Pull 4 from your collection" }));

    const dialog = await screen.findByRole("dialog", { name: "Pull from collection" });
    expect(
      within(dialog).getByText("Copies of Lightning Bolt you already own — into Burn"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", { name: "Pull Lightning Bolt, 4 copies" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: /^Pull Bear/ })).not.toBeInTheDocument();
    expect(deckPullFromCollection).not.toHaveBeenCalled();
  });

  /**
   * **No candidate at all still opens the dialog**, deliberately: `NOTHING_TO_PULL` explains why
   * a card the deck says it is short of has nothing to pull — the exact printing, the exact
   * finish, and never a copy another deck is holding — and a banner could only have said that it
   * found none.
   */
  it("opens the pull on a card with no candidate, so the dialog can say why", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    await open();
    await collectionMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Pull 4 from your collection" }));

    const dialog = await screen.findByRole("dialog", { name: "Pull from collection" });
    expect(within(dialog).getByText("Nothing to pull.")).toBeInTheDocument();
    expect(deckPullFromCollection).not.toHaveBeenCalled();
  });

  /**
   * **The stats band's press is still the whole deck**, which is the other half of the layer's
   * new payload: an arm that carried the card unconditionally would have narrowed the deck-wide
   * dialog to whatever card was last right-clicked.
   */
  it("keeps the stats band's press over the whole deck", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT(), card({ name: "Bear", quantity: 2 })]));
    deckPullPlan.mockResolvedValue([
      planRow([55]),
      planRow([57], { cardId: "c-Bear", name: "Bear", short: 2 }),
    ]);
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "Pull from collection" }));

    const dialog = await screen.findByRole("dialog", { name: "Pull from collection" });
    expect(
      await within(dialog).findByText(
        "Cards this deck is short of that you already own — into Burn",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /^Pull Bear/ })).toBeInTheDocument();
  });

  /**
   * **A read the reader pressed for cannot fail silently.** The menu closes before its handler
   * runs, so a refused `deck_quick_add_wishes` has nowhere of its own to be said — and a menu row
   * that sometimes does nothing at all is the worst answer available. It lands in the same banner
   * every refused write in this editor lands in.
   */
  it("says so in the banner when the wish read is refused", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockRejectedValue(new Error("database is locked"));
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change this deck — database is locked",
    );
    expect(deckQuickAddToCollection).not.toHaveBeenCalled();
  });

  /** The same for the pull's plan, which is the other read a press makes — one banner, two
   *  reads, because both are the same kind of failure: an act the reader asked for that cannot
   *  begin. */
  it("says so in the banner when the pull plan is refused", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckPullPlan.mockRejectedValue(new Error("database is locked"));
    await open();
    await collectionMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "Pull 4 from your collection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change this deck — database is locked",
    );
    expect(deckPullFromCollection).not.toHaveBeenCalled();
  });

  /**
   * **A refused write is drawn inside the wish dialog, not only in the banner behind it** —
   * `DeleteCategory`'s and `ClearCategory`'s rule, and the reason the dialog takes a `failure` at
   * all: the editor's banner is behind this dialog's `LAYER.overlay` scrim, so without this the
   * reader sees a press that did nothing and a question still open.
   */
  it("keeps the wish question open on a refusal and says why inside it", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue(WISHES);
    deckQuickAddToCollection.mockRejectedValue(new Error("that wishlist line is not there"));
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Which wish?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Record 4 copies" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not record those copies — that wishlist line is not there",
    );
    expect(screen.getByRole("dialog", { name: "Which wish?" })).toBeInTheDocument();
  });

  /**
   * **A refusal from an *earlier* press is not this dialog's**, and one mutation serving all
   * three rows is what makes that possible: a refused `Quick add 4 copies` leaves
   * `quickAddToCollection.isError` standing, so a panel that read the flag alone would open with a
   * red sentence about a press the banner had already reported.
   *
   * The banner still carries it, which is the pairing this case asserts — the sentence is not
   * lost, it is drawn where it belongs.
   */
  it("does not greet the wish question with an earlier press's refusal", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue(WISHES);
    deckQuickAddToCollection.mockRejectedValue(new Error("database is locked"));
    await open();
    await collectionMenu();

    // The plain add, refused.
    await userEvent.click(screen.getByRole("menuitem", { name: "Quick add 4 copies" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change this deck — database is locked",
    );

    // Now the row that asks. The question opens clean.
    await collectionMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Which wish?" });

    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    // And the earlier refusal is where it was said in the first place.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not change this deck — database is locked",
    );
  });

  /**
   * The caret goes back to the card the reader right-clicked, which is `ContextMenu`'s half of
   * the contract met by this editor's: `run` focuses the opener *before* it calls a row, so
   * `document.activeElement` read at the press is exact — and it is read **before** the await,
   * so a round trip cannot move it.
   */
  it("hands the caret back to the card when the wish question is dismissed", async () => {
    deckGet.mockResolvedValue(detail({}, [SHORT()]));
    deckQuickAddWishes.mockResolvedValue(WISHES);
    await open();
    await collectionMenu();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Quick add 4 and remove from wishlist" }),
    );
    await screen.findByRole("dialog", { name: "Which wish?" });
    // **The `<li>`, not the button inside it.** `ContextMenu` hands the caret back to the element
    // its handler is attached to, which in `StackView` is the card's row rather than the button
    // carrying `DECK_CARD_ATTR` — this folder's `CLAUDE.md` states the same asymmetry for
    // `caretCardSlot`. Asserting the button would fail on working behaviour.
    const opener = document
      .querySelector<HTMLElement>(
        `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, "c-Lightning Bolt", null)}"]`,
      )
      ?.closest("li");

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Which wish?" })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
    expect(deckQuickAddToCollection).not.toHaveBeenCalled();
  });
});

/**
 * **A pile's right-click — the last surface on this branch, and the one with a layer hazard.**
 *
 * The handlers hang on the view's own group element and never on `GroupHeader`, because
 * `CategoriesDialog` draws that same component inside a `Dialog` on `LAYER.overlay` (z-45)
 * and `ContextMenu` draws at `LAYER.popup` (z-30) — so a menu wired onto the shared header would
 * open **behind that dialog's scrim**, invisible and unreachable, with nothing going red because
 * jsdom has no opinion about a z-index. The sweep below is over all four views for the reason the
 * card menu's caret sweep is: four elements, one rule, and a single case would let three of them
 * quietly lose it.
 */
describe("DeckEditor — a category's menu", () => {
  /** Right-click a pile's heading, by the attribute every view's group element carries. */
  async function rightClickGroup(categoryId: number) {
    const el = document.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${categoryId}"]`);
    expect(el).not.toBeNull();
    fireEvent.contextMenu(el as HTMLElement);
    return screen.findByRole("menu");
  }

  it.each(["stacks", "table", "text", "grid"])("offers a pile its menu in %s", async (view) => {
    const user = userEvent.setup();
    await open();
    await pickOption(user, "View", VIEW_LABEL[view]);

    await rightClickGroup(MAIN);

    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Import cards…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Export cards…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Deactivate" })).toBeInTheDocument();
    // A regex, because these fixture piles hold no cards and a greyed row's `reason` is part of
    // its accessible name — "Clear stack… already empty" is deliberately one sentence. The
    // greying itself is asserted below, where a pile with cards is seeded to sit beside it.
    expect(screen.getByRole("menuitem", { name: /Clear stack…/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeInTheDocument();
  });

  /**
   * The deck the fixtures build has `cardCount: 0` on every pile, so `Clear stack…` is greyed
   * there — this is the deck the four cases below need: a Main deck holding four copies of one
   * card in the live list, and one in the theory list it must not reach.
   */
  function withCardsInMain() {
    const main = category(1, "Main deck", "main", { cardCount: 4, cardCountAllVariants: 5 });
    const categories = [main, ...CATEGORIES.slice(1)];
    deckGet.mockResolvedValue(detail({}, [bolt()], categories));
    deckCategoryList.mockResolvedValue(categories);
  }

  /**
   * **`Clear stack…` asks rather than writing**, exactly as `Delete…` does and for the same
   * reason: `CategoryMenuDeps` carries no clear mutation at all, so the menu structurally cannot
   * reach the command without the reader passing through the question.
   */
  it("asks before clearing a pile, and reaches no write until the reader says so", async () => {
    withCardsInMain();
    await open();
    await rightClickGroup(MAIN);

    await userEvent.click(screen.getByRole("menuitem", { name: "Clear stack…" }));

    const dialog = await screen.findByRole("dialog", { name: /Clear “Main deck”/ });
    expect(deckCategoryClear).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove 4 cards" }));
    await waitFor(() => expect(deckCategoryClear).toHaveBeenCalledWith(DECK.id, MAIN, "live"));
  });

  /** "Keep them" is the way out that writes nothing — the safe answer being the one a reader
   *  reaches by pressing the button that is not the destructive one. */
  it("writes nothing when the reader keeps the cards", async () => {
    withCardsInMain();
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Clear stack…" }));

    const dialog = await screen.findByRole("dialog", { name: /Clear “Main deck”/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep them" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deckCategoryClear).not.toHaveBeenCalled();
  });

  /**
   * **The question counts the list on screen and says the other one is safe.**
   *
   * `cardCount` is variant-scoped and `cardCountAllVariants` is not, so the difference is the
   * copies in the list the reader is *not* looking at — and a clear cannot reach them. Quoting
   * the wrong one of the two here would overstate a destructive press, which is the one
   * direction a confirmation must never be wrong in. (The delete confirmation quotes the other
   * number, correctly, because that command cascades through both lists.)
   */
  it("counts the variant on screen and says the other list is untouched", async () => {
    withCardsInMain();
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Clear stack…" }));

    const dialog = await screen.findByRole("dialog", { name: /Clear “Main deck”/ });
    await waitFor(() =>
      expect(within(dialog).getByText(/4 cards in it leave the actual list/)).toBeVisible(),
    );
    // **Through the verb, not up to it.** `/1 card filed here in the other list/` passed against
    // "…other list are untouched" as readily as against the "is" that agrees with one card, so
    // the assertion could not fail for the thing it looks like it is checking.
    expect(
      within(dialog).getByText(/1 card filed here in the other list is untouched/),
    ).toBeInTheDocument();
  });

  /** A refused clear is said **inside** the dialog, for the reason the delete's refusal is: the
   *  editor's own banner draws behind this dialog's scrim, and the press otherwise looks like a
   *  press that did nothing. */
  it("says so inside the clear dialog when the clear is refused", async () => {
    withCardsInMain();
    deckCategoryClear.mockRejectedValue("The database is busy");
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Clear stack…" }));

    const dialog = await screen.findByRole("dialog", { name: /Clear “Main deck”/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove 4 cards" }));

    expect(await within(dialog).findByText(/Could not clear that stack/)).toBeInTheDocument();
  });

  /** Nothing to clear, so the row stays where the reader last found it and greys — `aria-disabled`
   *  rather than `disabled`, so it is still readable and still in the tab order. */
  it("greys the clear on a pile with nothing in the list on screen", async () => {
    await open();
    await rightClickGroup(SIDE);

    const row = screen.getByRole("menuitem", { name: /Clear stack…/ });
    expect(row).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(row);
    expect(deckCategoryClear).not.toHaveBeenCalled();
  });

  /** The keyboard route, which is a requirement on every menu of this branch. The group element
   *  is already focusable — `deckGroupProps` gives every pile `tabIndex: -1` so the editor can
   *  hand it the caret when a card leaves — so the seam was prepared before it had a menu. */
  it("opens a pile's menu from the keyboard, and hands the caret back on Escape", async () => {
    await open();
    const el = document.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${MAIN}"]`) as HTMLElement;
    el.focus();
    fireEvent.keyDown(el, { key: "F10", shiftKey: true });
    await screen.findByRole("menu");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(el);
  });

  /**
   * **Two rows are absent on a predefined zone rather than greyed, and the backend is what
   * decides which two.** `rename_category` and `delete_category` both refuse a `kind` that is not
   * `main`; `set_category_active` takes every kind, which is why Deactivate stays.
   */
  it("drops rename and delete on a predefined zone, and keeps the switch", async () => {
    await open();
    await rightClickGroup(CATEGORIES[1].id); // Sideboard, kind: "side"

    expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete…" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("switches a pile off from its own heading", async () => {
    await open();
    await rightClickGroup(MAIN);

    await userEvent.click(screen.getByRole("menuitem", { name: "Deactivate" }));

    expect(deckCategorySetActive).toHaveBeenCalledWith(MAIN, false);
  });

  /** The row says what the write does rather than toggling a value read a moment earlier — a
   *  menu built just before a change would otherwise write the opposite of what it drew. */
  it("says Activate on a pile that is already off", async () => {
    deckGet.mockResolvedValue(
      detail(
        {},
        [bolt()],
        [category(1, "Main deck", "main", { isActive: false }), ...CATEGORIES.slice(1)],
      ),
    );
    await open();
    await rightClickGroup(MAIN);

    expect(screen.getByRole("menuitem", { name: "Activate" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Activate" }));
    expect(deckCategorySetActive).toHaveBeenCalledWith(MAIN, true);
  });

  it("renames a pile in its own heading, and gives the caret back to it", async () => {
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));

    const field = await screen.findByLabelText("Rename Main deck");
    await userEvent.clear(field);
    await userEvent.type(field, "Spells");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(deckCategoryRename).toHaveBeenCalledWith(MAIN, "Spells");
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector(`[${DECK_GROUP_ATTR}="${MAIN}"]`)),
    );
  });

  /**
   * **The one text field on this surface, and the primitive is what keeps it native.**
   * `menu()`/`menuKey()` test for a field before they build anything, so a right-click inside the
   * rename field gets WebView2's own cut/copy/paste — even though the field sits *inside* the
   * element carrying the pile's handler.
   */
  it("leaves the browser's own menu alone inside the rename field", async () => {
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const field = await screen.findByLabelText("Rename Main deck");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  /** `Delete…` **asks** rather than writing — `CategoryMenuDeps` carries no delete mutation at
   *  all, so the menu structurally cannot reach the command without the confirmation. */
  it("asks before deleting a pile, in the words the Categories dialog asks them in", async () => {
    await open();
    await rightClickGroup(MAIN);

    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));

    expect(await screen.findByRole("dialog", { name: /Delete “Main deck”/ })).toBeInTheDocument();
    expect(deckCategoryDelete).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: /Delete “Main deck”|Move .* and delete/ }),
    );
    await waitFor(() => expect(deckCategoryDelete).toHaveBeenCalled());
  });

  /**
   * **A refused delete has to be visible, and the editor's own banner is behind the scrim.**
   *
   * `meta.deleteCategory` is in the refused-write family, but that banner draws in the editor
   * body — under this dialog's `LAYER.overlay`. On refusal `onDeleted` never fires, so the dialog
   * stays open with its button live and, without a sentence inside it, nothing on screen changes.
   * Asserted **within the dialog**, because "somewhere on the page" is exactly what passes while
   * the reader sees nothing.
   */
  it("says so inside the delete dialog when the delete is refused", async () => {
    deckCategoryDelete.mockRejectedValue("The database is busy");
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));

    const dialog = await screen.findByRole("dialog", { name: /Delete “Main deck”/ });
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Delete “Main deck”|Move .* and delete/ }),
    );

    expect(await within(dialog).findByText(/Could not delete that category/)).toBeInTheDocument();
  });

  /**
   * **A refusal belongs to the press that produced it, and the next press has not been made yet.**
   *
   * The sentence above is drawn off `meta.deleteCategory.isError`, and that observer is the
   * **editor's** — unlike `CategoriesDialog`'s, which lives in a body `Dialog` unmounts, it
   * outlives every open of this layer. So a refused delete left the mutation in `isError` and the
   * next `Delete…` mounted its body already holding the alert: `role="alert"` announces on
   * insertion, and the reader was told that a delete they never attempted, on a pile it was never
   * about, had failed. `DecksPage`'s `decks.create.reset()`/`folders.create.reset()` before a
   * dialog is opened are the precedent this follows.
   *
   * **Two opens, on two piles, is what makes this a test of the reset**: one open can only ever
   * prove the sentence appears, which the case above already does. And the absence is asserted
   * only after the second dialog has been made to *paint* — a `motion` surface's first frame
   * carries its `initial`, so "nothing there yet" and "nothing there" look alike, and without the
   * settle this would pass against the unfixed code.
   */
  it("opens a second delete dialog with no refusal from the first still in it", async () => {
    const removal = category(6, "Removal", "main");
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, removal]));
    deckCategoryList.mockResolvedValue([...CATEGORIES, removal]);
    deckCategoryDelete.mockRejectedValue("The database is busy");
    await open();

    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const first = await screen.findByRole("dialog", { name: /Delete “Main deck”/ });
    await userEvent.click(
      within(first).getByRole("button", { name: /Delete “Main deck”|Move .* and delete/ }),
    );
    await within(first).findByText(/Could not delete that category/);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await rightClickGroup(removal.id);
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const second = await screen.findByRole("dialog", { name: /Delete “Removal”/ });
    await waitFor(() =>
      expect(
        within(second).getByRole("button", { name: /Delete “Removal”|Move .* and delete/ }),
      ).toBeVisible(),
    );

    expect(within(second).queryByRole("alert")).toBeNull();
    expect(within(second).queryByText(/Could not delete that category/)).toBeNull();
  });

  /**
   * **The caret goes back to the pile, for all three rows that open a full-window surface.**
   *
   * A menu row has no control to return to, and `Dialog` focuses its own panel and restores
   * nothing — so a `null` hand-back leaves the caret on an unmounting panel and drops it on
   * `<body>`, with the next Tab restarting from the top of the app. This is the third surface on
   * this branch to have been wired that way; here the hand-back is a function, so the rows can
   * answer with the pile rather than with nothing.
   */
  it.each([
    ["Import cards…", /Import/],
    ["Export cards…", /Main deck/],
    ["Delete…", /Delete “Main deck”/],
  ])("gives the caret back to the pile when %s is dismissed", async (row, dialogName) => {
    await open();
    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: row }));
    await screen.findByRole("dialog", { name: dialogName });

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(document.querySelector(`[${DECK_GROUP_ATTR}="${MAIN}"]`));
  });

  /** The two arms that were already built for this menu, wired to the rows that open them. */
  it("aims the importer at the pile that was right-clicked", async () => {
    await open();
    await rightClickGroup(MAIN);

    await userEvent.click(screen.getByRole("menuitem", { name: "Import cards…" }));

    expect(await screen.findByRole("dialog", { name: /Import/ })).toBeInTheDocument();
  });

  it("exports the pile that was right-clicked", async () => {
    await open();
    await rightClickGroup(MAIN);

    await userEvent.click(screen.getByRole("menuitem", { name: "Export cards…" }));

    expect(await screen.findByRole("dialog", { name: /Main deck/ })).toBeInTheDocument();
  });

  /**
   * **The table's band has to *declare* that it grew, or it paints over the card row below it.**
   *
   * Its rows are absolutely positioned at a height the virtualiser was told, so a field that
   * appears inside one without an `extraHeight` overlaps its neighbour by exactly its own
   * height — which is the failure `TableView`'s own `Row` comment already warns about for the
   * reconciler's band, arriving here by a different route. jsdom lays nothing out, so the
   * overlap itself is invisible to this suite; the **declared** height is not, and it is the
   * number the browser would use.
   *
   * 44 is `TABLE_ROW_HEIGHT`, 92 is that plus `RENAME_HEIGHT` — asserted as the pair, because a
   * band that was always tall would be as wrong as one that never grew.
   */
  it("makes the table's band taller while its pile is being renamed", async () => {
    const user = userEvent.setup();
    await open();
    await pickOption(user, "View", "Table");

    const band = () => screen.getByText("Main deck").closest("[role=row]") as HTMLElement;
    expect(band().style.height).toBe("44px");

    await rightClickGroup(MAIN);
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    await screen.findByLabelText("Rename Main deck");

    expect(band().style.height).toBe("92px");
  });

  /**
   * A derived heading is not a category: nothing about "Mana value 1" can be renamed, switched
   * off or deleted, and `deckGroupMenuProps` refuses its `null` id before a builder is reached.
   *
   * **This is also the case that would catch the handler being tidied onto `GroupHeader`.** That
   * component draws every heading, derived ones included — and it is the same component
   * `CategoriesDialog` renders inside its scrimmed dialog, where a menu would open behind the
   * scrim. A menu appearing here is the visible half of that mistake.
   *
   * No `defaultPrevented` assertion: `ContextMenuProvider` suppresses the native menu on
   * `document` for everything that is not a text field, so the flag is true either way and
   * would pin nothing. Whether a menu *opened* is the question.
   */
  it("offers no menu on a derived heading", async () => {
    const user = userEvent.setup();
    await open();
    await pickOption(user, "Group by", "Mana value");

    const heading = await screen.findByText("Mana value 1");
    fireEvent.contextMenu(heading);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("exportFileName", () => {
  it("joins the deck and the pile", () => {
    expect(exportFileName("Atraxa Superfriends", "Removal")).toBe("Atraxa Superfriends - Removal");
  });

  /** Taken out rather than replaced — nobody typed an underscore — and `save()` is handed this
   *  as a `defaultPath`, which Windows refuses outright if it holds one of them. */
  it("drops the characters a file name may not hold", () => {
    expect(exportFileName("Atraxa: Superfriends?", "Removal/Burn")).toBe(
      "Atraxa Superfriends - RemovalBurn",
    );
  });

  /** The defect a reading of this function found before anything could run it: an empty half
   *  used to leave its separator behind, so a pile with no name suggested `Atraxa -`. */
  it("leaves no dangling separator when a half is empty", () => {
    expect(exportFileName("Atraxa", "")).toBe("Atraxa");
    expect(exportFileName("", "Removal")).toBe("Removal");
  });

  /** And the same thing one step further in: a half that is *made* empty by the strip must not
   *  leave one either, which is why the parts are cleaned before they are judged. */
  it("falls back to a word rather than to nothing, or to a bare separator", () => {
    expect(exportFileName("", "")).toBe("decklist");
    expect(exportFileName(":", "?")).toBe("decklist");
  });
});

/**
 * **A pile dragged past its neighbours on the desk**, which is the half of the gesture the view
 * cannot do for itself.
 *
 * `StackView` says which pile moved and whose place it took, both as ids; `deck_category_reorder`
 * takes **every** id and writes `sort_order` from position. Resolving one into the other is this
 * component's, and the fixture below is chosen so that a component doing index arithmetic instead
 * would be wrong: the piles that flow are ids 1, 6 and 7, with the railed Sideboard sitting
 * between them in the deck's own list.
 */
describe("DeckEditor reordering the deck's piles", () => {
  /** Three piles of the reader's own and the two the rail takes — in `sortOrder`, which is the
   *  order `deck_category_list` and `deck_get` both answer in. */
  const PILES: DeckCategory[] = [
    category(1, "Main deck", "main", { sortOrder: 0 }),
    category(6, "Ramp", "main", { sortOrder: 1 }),
    category(2, "Sideboard", "side", { sortOrder: 2 }),
    category(7, "Removal", "main", { sortOrder: 3 }),
    category(5, "Maybeboard", "maybe", { sortOrder: 4 }),
  ];

  const openWithPiles = async (deck: Partial<DeckRow> = {}) => {
    deckGet.mockResolvedValue(detail(deck, [bolt()], PILES));
    deckCategoryList.mockResolvedValue(PILES);
    return open();
  };

  const grip = (name: string, position: string) =>
    screen.getByRole("button", { name: `Move ${name}, ${position}` });

  /**
   * The whole rule in one press. The deck's list is `[1, 6, 2, 7, 5]`; Ramp's neighbour **on the
   * desk** is Removal, two rows further down it with the railed Sideboard in between. So Ramp (6)
   * lands at Removal's index in *that* list and comes out `[1, 2, 7, 6, 5]` — every id, the two
   * railed piles keeping their places relative to everything they were already behind.
   *
   * That answer is only reachable from the whole list: a component counting the flow's own three
   * positions would have sent three ids and dropped the rail out of the deck.
   */
  it("sends every category id, with the dragged pile in the target's place", async () => {
    await openWithPiles();
    const user = userEvent.setup();

    grip("Ramp", "2 of 3").focus();
    await user.keyboard("{ArrowRight}");

    expect(deckCategoryReorder).toHaveBeenCalledWith(4, [1, 2, 7, 6, 5]);
  });

  /**
   * **And the pile moves before the answer comes back.** A reorder is a round trip *and* a re-read
   * of the whole deck; a column that only moved once `deck_get` had answered would snap back under
   * the reader's hand and travel a moment later, which is the shape of a broken control.
   *
   * Read off the grips' own names, because that is the one thing on screen that states a position.
   */
  it("draws the new order before the write has answered", async () => {
    await openWithPiles();
    const user = userEvent.setup();

    grip("Ramp", "2 of 3").focus();
    await user.keyboard("{ArrowRight}");

    expect(await screen.findByRole("button", { name: "Move Ramp, 3 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Removal, 2 of 3" })).toBeInTheDocument();
  });

  /** A lie about what the deck's columns look like must not outlive the write that failed — and
   *  the banner is what says why, which is the whole reason `reorderCategories` is in the
   *  editor's `writes` family. */
  it("puts the order back and says so when the reorder is refused", async () => {
    deckCategoryReorder.mockRejectedValue("The database is busy with a sync.");
    await openWithPiles();
    const user = userEvent.setup();

    grip("Ramp", "2 of 3").focus();
    await user.keyboard("{ArrowRight}");

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync.");
    expect(screen.getByRole("button", { name: "Move Ramp, 2 of 3" })).toBeInTheDocument();
  });

  /**
   * **Nothing to reorder under a derived grouping.** The headings on the desk are then buckets the
   * app made — "Mana value 1" is not a pile and has no id — so there is no order of the reader's
   * on screen to change, and the grip is not drawn at all.
   *
   * The deck is opened *on* that grouping rather than switched to it, because `lastGroupBy` is
   * what the editor restores and this is the state a reader who left it there comes back to.
   */
  it("offers no grip when the deck is not grouped by category", async () => {
    await openWithPiles({ lastGroupBy: "manaValue" });
    await screen.findByRole("region", { name: "Mana value 1" });

    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
  });
});

/**
 * **The order the printings modal's arrow keys step through, and why this component is what
 * publishes it.**
 *
 * `AllPrintingsDialog` renders at `App` level, a sibling of the shell, so no context reaches it
 * from in here — and it could not recompute the order even if one did: `groupBy` and `sortBy` are
 * this component's `useState` and the rows are `shown`, the deck narrowed by the toolbar's filter
 * box and label chips. So the editor writes `deckWalk` and the modal reads it, which is what the
 * two assertions about the filter and the unmount below are really about.
 */
describe("DeckEditor — the walk it publishes", () => {
  /**
   * Three cards in three piles, chosen so the drawn order is **not** the order `buildGroups`
   * hands the groups over in and **not** `sortOrder` either: Main deck is 0, the Sideboard 1 and
   * the Commander 2, so a walk that read `groups` straight through would put Kenrith in the
   * middle and Pyroblast last-by-accident. Both ends of `splitRail` move a pile here — the
   * command zone is pinned to the **head** of the desk and the Sideboard to the rail — which is
   * what makes this the case that discriminates a walk derived from the split from one that is
   * not, in both directions at once.
   */
  const SPREAD = [
    bolt(),
    card({ name: "Kenrith, the Returned King", categoryKind: "commander" }),
    card({ name: "Pyroblast", categoryKind: "side" }),
  ];

  const walk = () => useAppStore.getState().cardWalk.stops;

  it("publishes the deck in the order the desk draws it, the command zone first and the rail last", async () => {
    deckGet.mockResolvedValue(detail({}, SPREAD));
    await open();

    await waitFor(() =>
      expect(walk().map((stop: CardWalkStop) => stop.name)).toEqual([
        "Kenrith, the Returned King",
        "Lightning Bolt",
        "Pyroblast",
      ]),
    );
  });

  /**
   * Each stop is the whole five-part address plus the deck — the same slot `deckSlotOf` builds
   * for the card pane and for the menu's own `View all printings`, so a step is one
   * `openAllPrintings` call and a press inside the modal rewrites the row that was stepped to.
   *
   * `toEqual`, because the failure this guards is an address naming four parts, and
   * `toMatchObject` is exactly the assertion that cannot see a missing one. `deckId` is the one
   * part no `DeckCard` carries, so it is also the one this test — rather than `deckWalk.test.ts`
   * — is the only place to check.
   */
  it("addresses every stop as a deck row", async () => {
    deckGet.mockResolvedValue(detail({}, [bolt()]));
    await open();

    await waitFor(() =>
      expect(walk()).toEqual([
        {
          cardId: "c-Lightning Bolt",
          oracleId: "o-Lightning Bolt",
          name: "Lightning Bolt",
          deck: {
            deckId: 4,
            categoryId: MAIN,
            categoryName: "Main deck",
            cardId: "c-Lightning Bolt",
            variant: "live",
            finish: null,
          },
        },
      ]),
    );
  });

  /**
   * **The walk is what the reader is looking at, not what the deck holds** — which is the whole
   * argument for it being published rather than derived on the modal's side. Nothing outside this
   * component knows that three letters in the filter box have taken two of these cards off the
   * desk, so a modal walking the deck would step onto a card that is not on screen.
   */
  it("narrows with the toolbar's filter", async () => {
    deckGet.mockResolvedValue(detail({}, SPREAD));
    await open();
    await waitFor(() => expect(walk()).toHaveLength(3));

    screen.getByLabelText("Filter this deck").focus();
    await userEvent.keyboard("bolt");

    await waitFor(() =>
      expect(walk().map((stop: CardWalkStop) => stop.name)).toEqual(["Lightning Bolt"]),
    );
  });

  /**
   * **And it says it is the deck.** The store carries one walk, published by whichever surface is
   * drawing a list of cards — the desk, the search results, the collection, the wishlist — and the
   * modal reads the label straight into its chevrons' names. A walk that did not carry a noun of
   * its own would have this editor's chevrons saying somebody else's.
   */
  it("names the list its chevrons are stepping along", async () => {
    deckGet.mockResolvedValue(detail({}, SPREAD));
    await open();

    await waitFor(() => expect(useAppStore.getState().cardWalk.label).toBe("the deck"));
  });

  /** And it goes when the editor does. A walk left behind would step a modal opened from the
   *  Collection into the piles of a deck nobody has open. */
  it("clears the walk when the editor closes", async () => {
    deckGet.mockResolvedValue(detail({}, SPREAD));
    const view = await open();
    await waitFor(() => expect(walk()).toHaveLength(3));

    view.unmount();

    expect(walk()).toEqual([]);
  });
});

/**
 * **Multi-select** — issue #214. Ctrl and Shift build a set of deck rows, and every gesture that
 * acts on one card acts on the set.
 *
 * The arithmetic behind it is `lib/multiSelect.ts`'s and is tested there as a truth table; the
 * drag contract is `dndGroup.test.ts`'s. What is left for this file is the only thing neither can
 * see: that the editor's four views, its drop targets, its Delete key and its card menu are all
 * reading the *same* set, over the real registrations, through `src/test-drag.ts`.
 */
describe("DeckEditor multi-select", () => {
  /** The two cards the default fixture puts in the main deck, as the `<li>` each view makes a
   *  drag handle of. */
  const row = (name: string) =>
    boxed(screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!, 0);
  const marked = () => document.querySelectorAll(`[${SELECTED_ATTR}]`);

  /**
   * A chord press on a card, through the button the reader actually presses.
   *
   * **The modifier is held on the keyboard rather than passed as a click option**, and that is
   * not a style choice: `userEvent.click`'s options are *pointer* options and carry no modifier
   * state, so `{ ctrlKey: true }` there sets nothing at all — the press would be a plain click
   * and the test would pass while asserting about a gesture it never made. Held this way the flag
   * is on the real `mousedown`/`click` pair, which is what `readModifiers` reads.
   */
  async function pressWith(name: string, mods: { ctrl?: boolean; shift?: boolean }) {
    // **One `setup()` session for the three calls**, and this is the part that is easy to get
    // wrong: the direct `userEvent.click` / `userEvent.keyboard` helpers each open a session of
    // their own, so a modifier held by one is released before the next runs — the press lands as
    // a plain click and the test passes while asserting about a gesture it never made. It did,
    // for one run of this suite.
    const user = userEvent.setup();
    const key = mods.ctrl ? "Control" : "Shift";
    await user.keyboard(`{${key}>}`);
    await user.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
    await user.keyboard(`{/${key}}`);
  }

  /**
   * A plain click opens the card and a Ctrl-click **does not** — the whole of what makes the
   * chord a selection rather than a second way to open the pane. Both cards wear the ring, and
   * the pane is still showing the first.
   */
  it("marks a second card on Ctrl-click without opening it", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    expect(marked()).toHaveLength(1);

    await pressWith("Bear", { ctrl: true });

    expect(marked()).toHaveLength(2);
    expect(useAppStore.getState().selectedCardId).toBe("c-Lightning Bolt");
  });

  /** And a plain click puts the set back down to one, which is what keeps the ring and the pane
   *  agreeing after a reader has finished with a selection. */
  it("collapses the set on a plain click", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });
    expect(marked()).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /^Bear/ }));

    expect(marked()).toHaveLength(1);
  });

  /** Shift takes the run between the anchor and the press — two cards here, which is the whole
   *  of the fixture's main deck. */
  it("takes a range on Shift-click", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

    await pressWith("Bear", { shift: true });

    expect(marked()).toHaveLength(2);
  });

  /**
   * **The gesture the issue asked for**: one drag, every picked card moved.
   *
   * Driven over the library's own code path — a real `dragstart` on the card's `<li>`, a real
   * `drop` on the Sideboard's group — so what this pins is the group surviving the trip through
   * the untyped drag store and out the other side, not a function call.
   */
  it("moves every picked card when one of them is dragged", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    await pointerDrag(row("Lightning Bolt"), boxed(group("Sideboard"), 300, 80));

    await waitFor(() => expect(deckMoveCard).toHaveBeenCalledTimes(2));
    expect(deckMoveCard).toHaveBeenCalledWith(
      4,
      "c-Lightning Bolt",
      MAIN,
      SIDE,
      null,
      "live",
      null,
    );
    expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Bear", MAIN, SIDE, null, "live", null);
  });

  /**
   * **A card picked up from outside the set takes only itself, and throws the set away.**
   *
   * Every file manager's rule, and the one thing about multi-drag a reader will get wrong if it
   * is not true: a stray drag would otherwise rearrange cards they had forgotten were picked.
   */
  it("carries one card when the drag starts outside the set", async () => {
    deckGet.mockResolvedValue(
      detail({}, [
        bolt(),
        card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 }),
        card({ name: "Ponder", typeLine: "Sorcery", quantity: 1 }),
      ]),
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    await pointerDrag(row("Ponder"), boxed(group("Sideboard"), 300, 80));

    await waitFor(() => expect(deckMoveCard).toHaveBeenCalledTimes(1));
    expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Ponder", MAIN, SIDE, null, "live", null);
    // The set is thrown away by the drag itself. Asserted on the store rather than by counting
    // rings, because the pane is still open on Lightning Bolt and `selectedSlot` goes on marking
    // that one card — which is the ring meaning what it has always meant.
    await waitFor(() => expect(useAppStore.getState().cardSelection).toBeNull());
  });

  /**
   * Delete takes the set out — the only keyboard verb this editor has that is not undo, and the
   * same `setQuantity(…, 0)` the stepper's zero, the tray's drop and the menu's row all make.
   */
  it("removes every picked card on Delete", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    await userEvent.keyboard("{Delete}");

    await waitFor(() => expect(deckToCollection).toHaveBeenCalledTimes(2));
  });

  /**
   * **A set of one gets no Delete**, deliberately: one card already has a stepper, a menu row and
   * a tray, all of them visible, and a bare keystroke that silently removed whatever was last
   * clicked is one press away from a deck the reader did not mean to edit.
   */
  it("writes nothing on Delete with a single card picked", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));

    await userEvent.keyboard("{Delete}");

    expect(deckToCollection).not.toHaveBeenCalled();
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
  });

  /** The other fence: a reader deleting a character out of the deck's name must not lose the
   *  cards they had picked. `isTextField` is the same predicate the undo handler yields to. */
  it("leaves Delete alone inside a text field", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    await userEvent.click(screen.getByLabelText("Deck name"));
    await userEvent.keyboard("{Delete}");

    expect(deckToCollection).not.toHaveBeenCalled();
    expect(marked()).toHaveLength(2);
  });

  /**
   * The card menu goes plural for the three rows that are per-row writes, and the count is on the
   * label so the reader can see what the press is about before they make it.
   */
  it("puts the card menu in the plural for a picked set", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    const el = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, "c-Bear", null)}"]`,
    );
    fireEvent.contextMenu(el as HTMLElement);
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: /^Remove 2 cards/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Move 2 cards to/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Label 2 cards/ })).toBeInTheDocument();
  });

  /** A right-click on a card **outside** the set is about that card — the press rule that
   *  matches the drag's. */
  it("keeps the card menu singular on a card outside the set", async () => {
    deckGet.mockResolvedValue(
      detail({}, [
        bolt(),
        card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 }),
        card({ name: "Ponder", typeLine: "Sorcery", quantity: 1 }),
      ]),
    );
    await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });

    const el = document.querySelector<HTMLElement>(
      `[${DECK_CARD_ATTR}="${deckCardSlot(MAIN, "c-Ponder", null)}"]`,
    );
    fireEvent.contextMenu(el as HTMLElement);
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: /^Remove card/ })).toBeInTheDocument();
  });

  /** A picked set belongs to the deck it was made in — leaving the editor puts it down, so a
   *  reader coming back finds the deck as they find every other surface. */
  it("puts the set down when the editor closes", async () => {
    const view = await open();
    await userEvent.click(screen.getByRole("button", { name: /^Lightning Bolt/ }));
    await pressWith("Bear", { ctrl: true });
    expect(useAppStore.getState().cardSelection?.keys).toHaveLength(2);

    view.unmount();
    useAppStore.getState().setOpenDeckId(null);

    expect(useAppStore.getState().cardSelection).toBeNull();
  });
});
