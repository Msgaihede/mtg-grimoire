import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import type { FormatFilterOption } from "@/features/search/useCardSearch";
import type { CardSummary, CollectionRow, DeckCategory, SearchResponse } from "@/lib/ipc";
import { startDrag } from "@/test-drag";
import { pickOption } from "@/test-dropdown";
import { readDragData } from "./dnd";

const searchCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the filter bar and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The panel writes through `useDeck`, which reads the deck it is adding to.
const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
// The disclosure is an `app_meta` row behind a query now, so the panel reads one on the way up
// and writes one on every press. Answered `true`, which is the shipped default — a test that
// wants the other state seeds the cache through `panel({ storedOpen: false })` rather than
// re-pointing this, because that is the state a *stored* preference puts the panel in and a
// resolved mock and a resolved cache entry are not the same moment.
const deckSearchOpen = vi.hoisted(() => vi.fn());
const setDeckSearchOpen = vi.hoisted(() => vi.fn());
/**
 * The collection tab's three reads and its one write — **and the panel opens on that tab**, so
 * these are asked for on every mount in this file rather than only by the tests that name them.
 *
 * They were missing when the strip landed (T1-c). An `ipc` mock is an object literal, so a
 * command it does not carry is `undefined` and calling it is a synchronous `TypeError` — which,
 * fired from inside a hook on the way up, no `.catch` in a `queryFn` can reach.
 */
const collectionList = vi.hoisted(() => vi.fn());
const collectionToDeck = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
// `useMarketplace` is the real hook on both tabs — the marketplace is in every price-bearing
// key — so its two reads need answers as well.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    // The panel's filter row asks for facet counts beside the page. Answered **cold** —
    // `ready: false`, every map empty — so nothing greys and every control keeps its name.
    facetCards: vi.fn().mockResolvedValue({
      colors: {},
      manaValues: {},
      manaX: 0,
      formats: {},
      sets: {},
      owned: { owned: 0, missing: 0 },
      total: 0,
      ready: false,
    }),
    listSets,
    deckGet,
    deckAddCard,
    prefetchImages,
    deckSearchOpen,
    setDeckSearchOpen,
    collectionList,
    collectionToDeck,
    collectionFolderList,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { DECK_SEARCH_TAB_KEY, DeckSearchPanel, type DeckSearchTab } from "./DeckSearchPanel";
import { DECK_SEARCH_OPEN_KEY } from "./useDeckSearchOpen";
import { useDeck } from "./useDeck";
import { useAppStore } from "@/lib/store";

const BOLT: CardSummary = {
  promoTypes: null,
  id: "1",
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
  ownedQuantity: 3,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
  gameChanger: false,
};

/**
 * A card on the Commander game-changer list, which Bolt is not.
 *
 * Its own row rather than a flag on `BOLT`, because the point of the crown is that it tells two
 * cards apart on one wall — and because every other test in this file reads the unmarked tile.
 */
const RHYSTIC_STUDY: CardSummary = {
  ...BOLT,
  id: "2",
  name: "Rhystic Study",
  setCode: "pcy",
  setName: "Prophecy",
  collectorNumber: "45",
  typeLine: "Enchantment",
  manaCost: "{2}{U}",
  oracleId: "o-rhystic",
  gameChanger: true,
};

/**
 * The **collection**'s answer for the same card — a `CollectionRow`, which is a different object
 * from the `CardSummary` above and is the whole distinction between the two tabs.
 *
 * One row is one printing, one finish, one condition and one folder: `folderId: null` is the root
 * of the collection, which is a copy on the reader's desk and the ordinary case.
 */
const OWNED_BOLT: CollectionRow = {
  id: 1,
  cardId: "1",
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
  quantity: 2,
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
};

const page = (items: CardSummary[]): SearchResponse => ({
  items,
  total: items.length,
  totalIsCapped: false,
});

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height and
 * renders an empty window — one number is the whole of what it is missing. `scrollTo` is the
 * other thing it reaches for that jsdom does not implement.
 *
 * Put back afterwards: these are patches to a *global* prototype, and a file that leaves one
 * behind is a file that decides how the next one measures the DOM.
 */
const patched: [string, PropertyDescriptor | undefined][] = [];

beforeAll(() => {
  for (const [name, descriptor] of [
    ["offsetHeight", { value: 600 }],
    ["scrollTo", { value: vi.fn() }],
  ] as const) {
    patched.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  }
});

afterAll(() => {
  for (const [name, original] of patched.reverse()) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

beforeEach(() => {
  useAppStore.setState({ selectedCardId: null });
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
  listSets.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue(null);
  deckAddCard.mockReset().mockResolvedValue({ id: 7, quantity: 1, removed: false });
  prefetchImages.mockReset().mockResolvedValue(undefined);
  deckSearchOpen.mockReset().mockResolvedValue(true);
  setDeckSearchOpen.mockReset().mockResolvedValue(undefined);
  collectionList.mockReset().mockResolvedValue({ items: [OWNED_BOLT], total: 1 });
  // `deckCardId` is the `deck_cards` row the move landed on — always named by this command,
  // so a mock that omitted it would encode an answer the backend cannot give.
  collectionToDeck
    .mockReset()
    .mockResolvedValue({ entryId: 9, fromDeck: null, deckCardId: 41, quantity: 1 });
  collectionFolderList.mockReset().mockResolvedValue([]);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

/**
 * One of the deck's categories, as `deck_get` answers it.
 *
 * Local rather than borrowed — `.storybook/fake/fixtures.ts` is the Storybook fake's — and only
 * two fields matter to this panel: the `id` an add is addressed by and the `name` the select
 * and every Add button read.
 */
function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: 4,
    name: "Main deck",
    kind: "main",
    // Before the spread so a caller may override it. This panel never reads it — it offers
    // every category by name whatever made them — but the DTO carries it, and a fixture that
    // lied about the shape would be the wrong kind of local.
    origin: "user",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: over.cardCount ?? 0,
    ...over,
  };
}

const MAIN = category();
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 1 });
const MAYBE = category({ id: 5, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 4 });

/**
 * A deck's format as the editor hands it down — the `legalities` key the backend filters by,
 * and the word the picker draws it as.
 *
 * One of `FORMATS`' seven on purpose. Folding an *unlisted* key into the option list is
 * `useCardSearch`'s and `FilterBar`'s to be right about, and a fixture reaching for one here
 * would make this file's claims fail for their reasons rather than for this panel's.
 */
const COMMANDER: FormatFilterOption = { value: "commander", label: "Commander" };

/** What the editor hands down for a deck with the seeded piles and nothing of the reader's
 *  own yet. */
const SEEDED: DeckCategory[] = [MAIN, SIDE, MAYBE];

/**
 * The panel with the editor's own write behind it.
 *
 * The mutation is a prop — the editor holds `useDeck` and hands `addCard` down, so that one
 * open deck is one `deck_get` — and this stands in for the editor holding it.
 */
interface Props {
  categories: DeckCategory[];
  /** The deck the collection tab's write is addressed with — the editor's own id, threaded
   *  through this panel since 2026-08-23 rather than inferred from `categories[0].deckId`. */
  deckId: number;
  targetCategoryId: number;
  roomy: boolean;
  defaultFormat?: FormatFilterOption | null;
  /** The editor's cap on the drag. Absent is `Infinity`, which is what a story and the first
   *  paint both get — see the prop's own doc. */
  maxWidth?: number;
}

function Harness(props: Props) {
  const deck = useDeck(4);
  return <DeckSearchPanel add={deck.addCard} {...props} />;
}

function panel({
  categories = SEEDED,
  deckId = 4,
  targetCategoryId = MAIN.id,
  roomy = true,
  // `null` rather than an omission, because `null` is what the editor actually sends for a deck
  // it has no format to seed the search with — the annotation is what keeps the other cases
  // assignable.
  defaultFormat = null as FormatFilterOption | null,
  maxWidth = undefined as number | undefined,
  /**
   * What `app_meta` already holds about the disclosure, or `undefined` for a database that has
   * never been asked.
   *
   * Seeded into the cache rather than sent through the mocked command, and the difference is a
   * frame: a `mockResolvedValue` is still a round trip, so the panel's first paint is the
   * *default* either way and a test asking about the stored state would be asking about the
   * moment before it arrived. A seeded entry is the state a second deck opens in — the query is
   * `staleTime: Infinity`, so this is exactly what the reader's own last press leaves behind.
   */
  storedOpen = undefined as boolean | undefined,
  /**
   * Which tab the cache already holds, or `undefined` for a session in which nobody has
   * pressed one.
   *
   * Seeded rather than pressed for {@link storedOpen}'s reason, and it stands for the same
   * thing one scope smaller: {@link DECK_SEARCH_TAB_KEY} is the app's memory of the reader's
   * last press, so a seeded entry is a *second* deck opened after they made a choice.
   */
  storedTab = undefined as DeckSearchTab | undefined,
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (storedOpen !== undefined) client.setQueryData(DECK_SEARCH_OPEN_KEY, storedOpen);
  if (storedTab !== undefined) client.setQueryData(DECK_SEARCH_TAB_KEY, storedTab);
  let props: Props = {
    categories,
    deckId,
    targetCategoryId,
    roomy,
    defaultFormat,
    maxWidth,
  };
  const ui = (p: Props) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Harness {...p} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  let view = render(ui(props));
  /** Re-render with one prop changed — what the editor does when the deck row answers a new
   *  default category, or when it re-measures the row the deck and the panel share. */
  const update = (patch: Partial<Props>) => {
    props = { ...props, ...patch };
    view.rerender(ui(props));
  };
  /**
   * Close this editor and open the **same deck** again, over the same query cache.
   *
   * That is what a reader does every time they leave a deck and come back, and it is a very
   * different thing from {@link update}: the editor is keyed on the deck id, so the whole panel
   * is torn down and a fresh one is built. Anything held in a `useState` in this component goes
   * with it; anything in the query cache — which is app-scoped and is the same client here —
   * does not.
   *
   * Queries afterwards have to go through `screen` rather than through the returned `container`,
   * which is the first render's and is detached once this has run.
   */
  const remount = () => {
    view.unmount();
    view = render(ui(props));
  };
  return {
    ...view,
    update,
    remount,
    retarget: (categoryId: number) => update({ targetCategoryId: categoryId }),
  };
}

/**
 * The panel with its wall up — which is what most of this file is about, and **the state it
 * renders in again** (issue #183, 2026-08-22).
 *
 * It pressed the disclosure until then, because the panel opened collapsed and a test that
 * reached straight for the wall was asking about a wall that was not drawn. The default is open
 * now, so the press would *shut* it — and every one of those tests would go on to fail for a
 * reason that had nothing to do with what it was asking. Kept as a name rather than inlined:
 * "this test needs the wall" is what these call sites mean, and the day the default moves again
 * it is one function that has to change rather than forty call sites.
 */
async function openPanel(options: Parameters<typeof panel>[0] = {}) {
  const view = panel(options);
  await screen.findByRole("button", { name: PANEL_TOGGLE });
  // **And one more press than it used to be** (2026-08-23). The card search is a *tab* now and
  // the panel opens on the other one, so a test that reached straight for the wall would be
  // asking about a body that is not mounted — the same failure this helper was named for when
  // the disclosure opened collapsed, one control further in.
  //
  // Skipped when the editor has railed the panel, because there is no strip in 36px of rail and
  // `roomy: false` is a state two tests here open in deliberately. Nothing is lost: neither of
  // them looks at a body.
  const cards = screen.queryByRole("button", { name: ALL_CARDS });
  if (cards) await userEvent.click(cards);
  return view;
}

/**
 * The tab that draws today's card search, by the words on it.
 *
 * A constant rather than the string typed out at each call site: it is this file's most-repeated
 * accessible name, and the two tabs are one `TABS` array in the component — so a rename that
 * reached the component and not this file should fail in one obvious place rather than in thirty
 * `getByRole` calls that each read as "the wall never arrived".
 */
/**
 * The panel's disclosure — **matched on a pattern, because its name says what pressing it does
 * and therefore changes with the state**: `Collapse card search` open, `Expand card search`
 * collapsed.
 *
 * It was the literal `Search cards` until 2026-08-25, when the words became a heading beside the
 * button and the control became a bare chevron with an `aria-label` of its own. A test asking
 * about *which state it is in* asserts `aria-expanded`, which is the attribute that carries it —
 * matching the name for that would be reading the label as the state.
 *
 * The `$` anchor keeps it off `Resize card search`, the drag handle's name — which is a
 * `separator` rather than a `button`, so nothing here could reach it anyway, and the anchor is
 * what keeps that true if either name moves.
 */
const PANEL_TOGGLE = /card search$/;

const ALL_CARDS = "All cards";
/** Its sibling — the tab the panel opens on. */
const COLLECTION = "Collection";

/** One tab, by its words. Both are plain buttons: the strip is `aria-pressed` over a `.map` and
 *  deliberately not `role="tab"`, which would bring a keyboard contract nothing else here has. */
const tab = (name: string) => screen.getByRole("button", { name });

/**
 * The filter row's Format picker, reached by its accessible name.
 *
 * `FilterBar`'s own, drawn inside this panel — the row's other controls are deliberately worded
 * to keep clear of the word "Format", so the exact string matches one control here. Named through
 * `TrayField`'s `<label>` and the picker's own `labelledBy`, since a `<label htmlFor>` alone
 * would reach only a `<select>`'s accessible name, never a `<button>`'s (see `SharedProps` in
 * `Dropdown.tsx`). An `Unplayable` chip beside it used to be the one at risk of colliding, and it
 * is a row *inside* this picker now (`Any card`): a listbox row carries no label of its own, so
 * the widest thing this control offers can be worded plainly.
 */
const formatSelect = (): HTMLElement => screen.getByRole("button", { name: "Format" });

/**
 * Open the filter row's tray, where Set, Format, Owned, Rarity, Price and Printings live since
 * the row was redesigned. Only the search box, the colours, the mana values and the sort are on
 * the bar at every width.
 *
 * Idempotent, so a case may call it after a railing without asking whether the press survived —
 * which is the question the railing case below actually cares about, and it asks it of the query
 * and the format rather than of a disclosure this panel does not own.
 */
async function openFilterTray(): Promise<void> {
  const toggle = await screen.findByRole("button", { name: /^(Show|Hide) filters/ });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
}

describe("DeckSearchPanel", () => {
  /**
   * The state a deck opens in, and the reason it changed **back** (issue #183, 2026-08-22).
   *
   * The case for opening collapsed was width, and it was arithmetic: 384px of panel plus the
   * desk's 16px gap out of a 602px row at 1280×800 *with the card pane docked beside the editor*
   * left the deck 202px, one stack column. The card pane is not docked beside the editor any
   * more — it is an overlay over one of the desk's two columns and takes no width from either —
   * so the row that number was measured on has gone, and with it the reason a reader who wanted
   * a search column had to ask for one on every deck they opened.
   *
   * `roomy` is left true here on purpose: this is the reader's own default, not the editor
   * refusing for want of width, and the two are kept apart everywhere else in this file.
   */
  it("starts open, so a reader who searches while they build has a wall", async () => {
    panel();

    const rail = await screen.findByRole("button", { name: PANEL_TOGGLE });
    expect(rail).toHaveAttribute("aria-expanded", "true");
    expect(rail).not.toHaveAttribute("aria-disabled");
    // The strip rather than the searchbox, since 2026-08-23: what "open" draws is a *body*, and
    // which body is the tab's question rather than this one's. `DeckSearchPanel tabs` below is
    // where the answer to that is pinned.
    expect(screen.getByRole("group", { name: "Search in" })).toBeInTheDocument();
  });

  /**
   * The other half of the default, and the half that makes it defensible: the reader's answer
   * outlives the deck they gave it on.
   *
   * Both directions, because they fail differently. The **write** is what the press produces —
   * a boolean through `set_deck_search_open`, and asserting the argument is what would catch a
   * panel that remembered the drawn state rather than the choice. The **read** is a second panel
   * mounted over a cache the first one's press left behind, which is exactly what opening a
   * second deck is: the editor is keyed on the deck id, so the panel is thrown away and the query
   * entry is not.
   */
  it("remembers which way the reader left it, across decks", async () => {
    const first = panel();
    await screen.findByRole("group", { name: "Search in" });

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    expect(setDeckSearchOpen).toHaveBeenCalledWith(false);
    // The strip is the tell that the body has gone, whichever tab was on: a searchbox would have
    // asked about the card search alone, which the panel no longer opens on.
    expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();
    first.unmount();

    // A fresh editor over a database that has been told. Seeded rather than pressed, for the
    // reason `panel`'s own `storedOpen` gives: this is the state the *stored* answer puts the
    // panel in, and it is the first paint that has to be right.
    panel({ storedOpen: false });
    expect(screen.getByRole("button", { name: PANEL_TOGGLE })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));
    expect(setDeckSearchOpen).toHaveBeenLastCalledWith(true);
  });

  /**
   * **A shut panel costs no query**, which was the fix for opening collapsed and is worth *more*
   * now rather than less: `useCardSearch` used to be called unconditionally in the panel's root,
   * so a state that draws no wall ran the wall's query anyway. Open is the resting state again,
   * so the readers this saves a `search_cards` for are exactly the ones who shut the column on
   * purpose — and they are the ones who meant it.
   *
   * Started from a **stored** collapse rather than a pressed one, because a press would leave the
   * search mounted for the frame before it and prove nothing about the deck this reader is
   * opening. **The press at the end is what makes the silence discriminate**: a mock wired to
   * nothing would pass the first assertion on its own, and the second one is what says the search
   * really is behind the disclosure. Seeded on the card search tab as well, so that one press is
   * still all it takes to reach the wall this test is about.
   */
  it("asks the backend for nothing while it is shut", async () => {
    panel({ storedOpen: false, storedTab: "all" });

    const rail = await screen.findByRole("button", { name: PANEL_TOGGLE });
    expect(rail).toHaveAttribute("aria-expanded", "false");
    expect(searchCards).not.toHaveBeenCalled();
    // The filter row's set list goes with it: the whole body is unmounted, not just the wall.
    expect(listSets).not.toHaveBeenCalled();

    await userEvent.click(rail);

    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(searchCards).toHaveBeenCalled();
  });

  /** The search view's own parts, in a column: not a second search implementation. */
  it("renders the search filters and the results as a wall of art", async () => {
    await openPanel();

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color identity" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mana value" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * The panel is always a wall of art — it is 384px wide and there is no table in it — so the
   * layout pair would be a control that changes the *search view* and nothing the reader can
   * see from here.
   */
  it("leaves the grid-or-table choice to the search view", async () => {
    await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    expect(screen.queryByRole("button", { name: "Table view" })).not.toBeInTheDocument();
  });

  /**
   * No default is `Any format`, which is the search every other surface mounting this hook
   * gets: `SearchPage` and the collection row pass no default at all, and a panel handed none
   * has to be the browse this app has always opened on. It is also the editor's own answer
   * while the format seed is still loading and for a deck with no legality data to filter by,
   * so this is a live state rather than only a test's.
   */
  it("opens on Any format when it is handed no default", async () => {
    // `openPanel`, not `panel`: the filter row lives in `OpenPanel`, which mounts on the
    // disclosure press (2026-08-14). "Opens on" is now literally true of these three — the
    // seed is applied when the search mounts, and the search mounts when the reader asks
    // for the wall.
    await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });
    await openFilterTray();

    expect(formatSelect()).toHaveTextContent("Any format");
  });

  /**
   * A deck is built out of the cards it may legally hold, so the wall beside it starts there
   * rather than at the whole corpus.
   *
   * The trigger's own text is the whole of what the reader has. A `<Dropdown>` given a value
   * none of its options carries falls back to its own placeholder dash rather than to a picked
   * row's label (`DEFAULT_PLACEHOLDER`, `Dropdown.tsx`) — so this one assertion is what would
   * catch a seeded key the picker's own list has dropped, the way the old select's `value`
   * reading back `""` used to.
   */
  it("opens on the deck's own format when it is handed one", async () => {
    await openPanel({ defaultFormat: COMMANDER });
    await screen.findByRole("button", { name: "Lightning Bolt" });
    await openFilterTray();

    expect(formatSelect()).toHaveTextContent(COMMANDER.label);
  });

  /**
   * **A default and not a constraint** — the request's second sentence, and the half a seeded
   * filter is easiest to get wrong.
   *
   * The reader may move the select anywhere, including to a format this deck is not legal in,
   * and the search that comes back is the one they asked for. A card the deck's format does not
   * allow is `validation/engine.ts`'s `RULE BREAK` to draw once it is in the deck; a search
   * that would not show it in the first place would be this panel enforcing a rule it does not
   * own. `Any format` is one press further, which is the way back to the whole corpus.
   */
  it("lets the reader move the select off the deck's format, and keeps searching", async () => {
    const user = userEvent.setup();
    await openPanel({ defaultFormat: COMMANDER });
    await screen.findByRole("button", { name: "Lightning Bolt" });
    await openFilterTray();

    await pickOption(user, "Format", "Modern");

    expect(formatSelect()).toHaveTextContent("Modern");
    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith(expect.objectContaining({ format: "modern" })),
    );
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();

    await pickOption(user, "Format", "Any format");

    expect(formatSelect()).toHaveTextContent("Any format");
    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith(expect.objectContaining({ format: undefined })),
    );
  });

  /**
   * **The `Add to` select is gone from this panel** (2026-08-15) — it is the deck's own setting
   * now, asked in `DeckSettingsForm` and stored on `decks.default_category_id`, so what arrives
   * here is a value and there is nothing to hand back.
   *
   * Asserted rather than merely deleted, because the failure this guards against is the control
   * coming back beside the settings one: two places to answer one question is exactly the shape
   * that made the toolbar's quick-add field and this panel able to disagree.
   */
  it("draws no category control of its own", async () => {
    await openPanel();

    expect(screen.queryByLabelText("Add to")).toBeNull();
    expect(screen.queryByText("Auto (by what it does)")).toBeNull();
  });

  /**
   * The tile is the drag's handle, and what it carries is the card it is showing.
   *
   * The registration is the half that can go wrong silently — a wall builds its own tiles, so
   * the panel reaches them through one callback ref, and a callback that closed over the wrong
   * card would drag a card the reader is not touching. So this asks the drag itself rather
   * than the `draggable="true"` attribute: pick the tile up, and read what the library was
   * handed. Where the card *lands* is the group's business (`views/views.test.tsx`) and the
   * whole gesture is the editor's (`DeckEditor.test.tsx`).
   */
  it("hands each drawn tile to the drag adapter, carrying the card it draws", async () => {
    const { container } = await openPanel();
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContainElement(art);

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(tiles[0]);
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      // The type line rides along even though every drop target *inside* the editor names its
      // own category: a tile can also be let go on the sidebar's Decks entry, which names none.
      { kind: "search-card", cardId: BOLT.id, name: BOLT.name, typeLine: BOLT.typeLine },
    ]);
  });

  /**
   * The tile's one control keeps its press.
   *
   * The same guard the deck rows need (`cardDraggable`), for the same reason: the press
   * lands on the button and the `dragstart` lands on the tile, so a press that slips a few
   * pixels would add nothing and drag instead. The tile's *art* is a button too and is
   * deliberately still a drag handle — the exclusion is marked, not guessed from the tag.
   */
  it("does not drag a tile when the press landed on its Add button", async () => {
    const { container } = await openPanel();
    const add = await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" });
    const tile = container.querySelector('[draggable="true"]')!;

    const held = await startDrag(tile, { pressOn: add });
    expect(held.started).toBe(false);
    await held.cancel();

    const art = screen.getByRole("button", { name: "Lightning Bolt" });
    const again = await startDrag(tile, { pressOn: art });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * One copy, into the category the header names. `deck_add_card` folds it into whatever is
   * already there, so pressing twice is two copies rather than an error.
   *
   * The `null` in the middle is the command's other arm going unused: `deck_add_card` takes
   * either a category **id** or a **name** to find-or-create, and a panel that has a column to
   * point at always sends the id (`useDeck`'s `DEFAULT_CATEGORY_NAME` is for the surfaces that
   * do not).
   */
  it("adds one copy of a card to the target category", async () => {
    await openPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", MAIN.id, null, "live", null, 1);
  });

  it("adds to whichever category is picked, and says so on the button", async () => {
    const view = await openPanel();
    await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" });

    view.retarget(SIDE.id);
    await userEvent.click(screen.getByRole("button", { name: "Add Lightning Bolt to Sideboard" }));

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", SIDE.id, null, "live", null, 1);
  });

  /**
   * A picked id the handed-down list does not hold, which is a single commit's worth of state:
   * a deleted category reaches the deck row and the category list together, and nothing orders
   * those two.
   *
   * The button says what it can honestly say rather than reading `.name` off `undefined` and
   * taking the whole panel down over a label.
   */
  it("names the deck rather than crashing when the picked category is not in the list", async () => {
    await openPanel({ targetCategoryId: 404 });

    expect(
      await screen.findByRole("button", { name: "Add Lightning Bolt to this deck" }),
    ).toBeInTheDocument();
  });

  /** The result still tells the collection story: a card already in the binder is a card the
   *  deck can be built out of today. */
  it("marks a result with what the collection holds", async () => {
    await openPanel();

    expect(await screen.findByText("×3")).toBeInTheDocument();
  });

  /**
   * The crown, on the one wall a Commander deck is actually built out of.
   *
   * `gameChanger` is a fact about the *card*, so this panel says it exactly as the search view
   * does — a card marked on one wall and bare on the other would be the reader learning that the
   * mark means something about the view. Named rather than shaped: the mark's accessible name is
   * the whole of what a screen reader gets from a 12px glyph.
   *
   * And it lands on the card it is about. Two tiles on one wall is the only arrangement that can
   * catch a mark drawn per *wall* instead of per card, which a callback closing over the wrong
   * row would be — the same failure `tileRef` is asked about above.
   */
  it("crowns a game changer, and leaves the tile beside it unmarked", async () => {
    searchCards.mockResolvedValue(page([BOLT, RHYSTIC_STUDY]));
    const { container } = await openPanel();
    const crowned = await screen.findByRole("button", { name: "Rhystic Study" });

    const marks = screen.getAllByLabelText("Game changer");
    expect(marks).toHaveLength(1);
    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(2);
    const crownedTile = tiles.find((tile) => tile.contains(crowned))!;
    expect(crownedTile).toContainElement(marks[0]);
  });

  /** The tiles stay selectable, so the card pane keeps working from inside the editor. */
  it("opens the card in the pane from a tile", async () => {
    await openPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("1");
  });

  /** The editor has to be usable at 1024px with the card pane docked beside it, and 384px of
   *  search is what has to give. */
  it("collapses to a rail that says what it is, and opens again", async () => {
    await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    const rail = screen.getByRole("button", { name: PANEL_TOGGLE });
    expect(rail).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(rail);

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  /**
   * **The rail is a column with a hairline down its edge, not a bordered button standing in an
   * empty strip** (2026-08-26). The border used to be on the disclosure, and it was there for a
   * real reason — at 36px a hairline beside a bordered control is two lines saying one thing —
   * so the edit that puts it back reads as a restoration rather than as a regression. What it
   * costs is that the one control a reader sees at that width is drawn as a box where every
   * other icon button in the app is a bare glyph, and the panel's own left edge is missing from
   * exactly the state that most needs to say *everything right of this line is not your deck*.
   *
   * A class sweep, because **jsdom lays nothing out and loads no stylesheet**: there is no
   * computed border here and no selection to make, so a browser is the only witness to either
   * fact and this is the fence that keeps them from being quietly undone. `classList.contains`
   * rather than `className.includes` — a substring test passes on `border-l` when asked about
   * `border`, which would make the button's assertion vacuous in the one direction it exists to
   * catch.
   */
  it("keeps its hairline on the column and its disclosure flat, drawn or railed", async () => {
    await openPanel();

    const drawn = screen.getByRole("region", { name: "Add cards" });
    expect(drawn.classList.contains("border-l")).toBe(true);
    expect(
      screen.getByRole("button", { name: PANEL_TOGGLE }).classList.contains("border"),
    ).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    const railed = screen.getByRole("region", { name: "Add cards" });
    expect(railed.classList.contains("border-l")).toBe(true);
    expect(
      screen.getByRole("button", { name: PANEL_TOGGLE }).classList.contains("border"),
    ).toBe(false);

    // The sideways title is the whole of what the rail draws besides the chevron, so a pointer
    // dragged down the shut column would otherwise highlight the panel's own name. Found by the
    // writing mode rather than by the words: `Search cards` is also the search box's accessible
    // name, and the two are on screen together whenever the body is drawn.
    const sideways = screen
      .getAllByText("Search cards")
      .filter((el) => el.style.writingMode === "vertical-rl");
    expect(sideways).toHaveLength(1);
    expect(sideways[0].classList.contains("select-none")).toBe(true);
  });

  /**
   * The editor measures the row the two of them share and says whether there is room. With
   * none, the rail is what is drawn whatever the reader last chose — and the disclosure is
   * disabled, because a press could not open anything and a control that records an intention
   * and moves nothing is worse than one that says why.
   *
   * The panel is drawn open first, which is what makes the last two acts discriminate: the
   * refusal draws the same rail a collapse does, so a test that started from a shut panel would
   * pass against a component that had thrown the reader's choice away — and the point of the
   * last two lines is that it has not.
   */
  it("draws its rail, refused and explained, when the editor has no room for it", async () => {
    const view = await openPanel();
    view.update({ roomy: false });

    const rail = screen.getByRole("button", { name: PANEL_TOGGLE });
    expect(rail).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    // The reason moved off `title` to `useTooltip()` — a description of an already-named
    // control (the button's own visible words are "Search cards"), so it is `describes: true`
    // by default and the panel carries `role="tooltip"`, found by role and by its content.
    fireEvent.pointerEnter(rail);
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(tooltip).toHaveTextContent(/not enough room/i);
    expect(document.getElementById(TOOLTIP_PANEL_ID)).toBe(tooltip);
    fireEvent.pointerLeave(rail);

    // `aria-disabled` and a press that does nothing, never the `disabled` attribute: a
    // disabled button leaves the tab order, and the reason for the refusal would then be
    // reachable only by hovering — which is not something a keyboard has.
    expect(rail).toHaveAttribute("aria-disabled", "true");
    expect(rail).not.toBeDisabled();
    rail.focus();
    expect(rail).toHaveFocus();

    // And "does nothing" has to include not quietly flipping the reader's own choice: a press
    // that toggled it would look inert here and then keep the panel shut when the room came
    // back, which is the reader being answered by a control they never operated.
    await userEvent.click(rail);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  /**
   * The panel is what took the caret away, so the panel is what gives it somewhere to go.
   *
   * At 1024 a tile press opens the card pane, the pane's arrival squeezes this panel down to
   * its rail, and the tile that was pressed unmounts with it — so `CardDetailPane`'s hand-back
   * finds an opener that is not connected, and Escape drops the caret on `<body>` with the next
   * Tab restarting from the top of the app.
   */
  it("takes the caret when the pane closes and the tile that opened it has gone", async () => {
    const view = await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    // The card opens, and its arrival is what squeezes the panel out.
    act(() => useAppStore.setState({ selectedCardId: "1" }));
    view.update({ roomy: false });
    // The pane closes with the caret on it and nothing connected to hand it back to.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => useAppStore.setState({ selectedCardId: null }));

    expect(screen.getByRole("button", { name: PANEL_TOGGLE })).toHaveFocus();

    // And it is still there one commit later, when the width the closing pane gave back
    // reopens the panel around it. The disclosure is one node across both states for exactly
    // this: two shapes would mean a fresh button here, and the caret back on `<body>`.
    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PANEL_TOGGLE })).toHaveFocus();
  });

  /** And it does not steal one: an opener still on screen has already been handed the caret
   *  back, which is where the reader was. */
  it("leaves the caret alone when something else still has it", async () => {
    const view = await openPanel();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);

    act(() => useAppStore.setState({ selectedCardId: "1" }));
    view.update({ roomy: false });
    elsewhere.focus();
    act(() => useAppStore.setState({ selectedCardId: null }));

    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  /**
   * The two states are kept apart on purpose: the measurement decides what is *drawn*, the
   * reader decides what they *want*. So a panel that was pushed aside by a card pane comes
   * back when the pane closes, and one the reader shut stays shut.
   */
  it("comes back when the room does, unless the reader was the one who shut it", async () => {
    const view = await openPanel();
    await screen.findByRole("searchbox", { name: "Search cards" });

    view.update({ roomy: false });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    view.update({ roomy: true });
    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));
    view.update({ roomy: false });
    view.update({ roomy: true });

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  /**
   * **What the reader typed survives the editor taking the width away**, which the assertion
   * above cannot see and which this branch broke.
   *
   * `OpenPanel` — where `useCardSearch`, the filter state, the facets and the wall live — was
   * mounted on `open && roomy`, folding together the two things the rest of this component is
   * careful to keep apart: what the reader *chose* and whether the editor has *room*. So a
   * **width** change unmounted the search. The measured flow: at 1024 the reader opens the
   * panel and types; a tile press opens the card pane; the pane's arrival squeezes the desk row
   * and rails the panel; Escape closes the pane, the width comes back — and the panel reopened
   * with an empty box on the deck's default format, having thrown away a search nobody shut.
   *
   * So this asserts on the **state**, not on the searchbox merely existing again: "the searchbox
   * is back" is exactly what the test above checks, and a freshly remounted panel passes it.
   * Both filters are read, because they fail differently — the text is state the hook holds, and
   * the format is state a remount actively *overwrites* from `defaultFormat`.
   *
   * The reader's own collapse is the other half and is asserted here beside it: that one really
   * does throw the state away, and a fix that made the railing survive by never unmounting at
   * all would have lost the distinction this whole component is built on.
   */
  it("keeps the reader's query and filters across a railing, and drops them on a collapse", async () => {
    const user = userEvent.setup();
    const view = await openPanel({ defaultFormat: COMMANDER });
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await user.type(screen.getByRole("searchbox", { name: "Search cards" }), "goblin");
    await openFilterTray();
    await pickOption(user, "Format", "Modern");
    expect(formatSelect()).toHaveTextContent("Modern");

    // The wrapper the body now hangs on generates **no box** while the panel is drawn, which is
    // what keeps `OpenPanel`'s children flex items of the panel's own column: the row's `gap-2`,
    // the wall's `flex-1` and the `min-h-0` chain distribute exactly as they did when there was
    // no wrapper there at all. A `block` in its place would read identically in jsdom, which
    // lays nothing out, and would be a different layout on screen — so the class is the assertion.
    const section = screen.getByRole("region", { name: "Add cards" });
    expect(section.lastElementChild).toHaveClass("contents");

    // The card pane arrives and the desk row has no width for the panel. The body is hidden
    // rather than unmounted, which is invisible to a role query — `hidden` takes the whole
    // subtree out of the accessibility tree — and is the whole of the fix.
    view.update({ roomy: false });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(section.lastElementChild).toHaveAttribute("hidden");

    // The pane closes and the room comes back. Nothing the reader did was a decision to start
    // over, so nothing has started over.
    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toHaveValue("goblin");
    await openFilterTray();
    expect(formatSelect()).toHaveTextContent("Modern");

    // And a press is still a press: shutting the panel is the reader saying they are done, so
    // the next open is a clean search seeded from the deck's format again.
    await user.click(screen.getByRole("button", { name: PANEL_TOGGLE }));
    await user.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toHaveValue("");
    await openFilterTray();
    expect(formatSelect()).toHaveTextContent(COMMANDER.label);
  });

  /**
   * The Escape stack, from inside the panel: the set picker is an `"inner"` layer and consumes
   * its press in the capture phase, and the next press reaches `window` untouched — which is
   * where the card detail pane listens, in the bubble phase. Observed in the running window;
   * this is what holds it.
   */
  it("spends the first Escape on the set picker and lets the second through to the pane", async () => {
    listSets.mockResolvedValue([
      {
        code: "lea",
        name: "Limited Edition Alpha",
        setType: "core",
        releasedAt: "1993-08-05",
        cardCount: 295,
      },
    ]);
    await openPanel();
    await openFilterTray();
    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await screen.findByRole("combobox", { name: /search sets/i });

    const heard: boolean[] = [];
    // The bubble phase, which is the rung the card pane is on.
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: /search sets/i })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen);

    // Consumed, then not: one layer per press, and the panel itself is not one of them.
    expect(heard).toEqual([true, false]);
  });

  /** A refused add is said in the app's own words, where the reader is looking. */
  it("says so when an add is refused", async () => {
    deckAddCard.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    await openPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
  });

  /**
   * The search view warms the page it just fetched because a 1 200px wall shows forty tiles at
   * once. Two tiles per row is not that wall: the grid's own overscan mounts the next two rows
   * of `<img>`s, which is the same warming by a shorter path.
   */
  it("leaves image warming to the grid's overscan", async () => {
    await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(prefetchImages).not.toHaveBeenCalled();
  });
});

/**
 * The two searches this column offers, and the strip that picks between them.
 *
 * The strip is `aria-pressed` over a `.map` — the shape `DeckEditor`'s Theory/Live switch
 * already uses — and deliberately **not** `role="tab"`: that role brings a keyboard contract
 * (arrow-key roving focus, `aria-controls`, a `tabpanel`) that nothing else in this app
 * implements, so adopting it here would either be half-built or would make this one control
 * behave unlike every other two-way choice on screen. So every query below is `getByRole
 * ("button")`, which is what a reader's screen reader is actually handed.
 */
describe("DeckSearchPanel tabs", () => {
  /**
   * **The panel opens on the reader's own cards**, which is the product decision this whole
   * change is (spec §7.2).
   *
   * A deck is built out of cards you have; a search of everything Scryfall has printed is the
   * thing you go to when your binder does not answer. So the collection is the resting state and
   * the wider search is one press away, which is the reverse of what this panel did until now.
   *
   * `searchCards` is the half that discriminates. The two tabs' bodies are two components and
   * only the mounted one has a hook — so "the card search is not on screen" and "the card search
   * was never asked for" are different claims, and the second is the one that would catch a strip
   * drawn over a body that had been mounted all along.
   */
  it("opens on the collection tab rather than on the card search", async () => {
    panel();

    const strip = await screen.findByRole("group", { name: "Search in" });
    expect(within(strip).getByRole("button", { name: COLLECTION })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(strip).getByRole("button", { name: ALL_CARDS })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Nothing of the card search is mounted, so nothing of it has been asked for: no page, and
    // no set list for a filter row that is not drawn.
    expect(searchCards).not.toHaveBeenCalled();
    expect(listSets).not.toHaveBeenCalled();
    // **And the collection body really is mounted**, which is the half a marked strip cannot
    // prove. `collection_to_deck` shipped in PR 3 fully tested with no caller at all and nothing
    // went red; this is the assertion that makes "wired" a thing the suite checks.
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
  });

  /**
   * The panel's default state, end to end: the reader's own copies, and **only the ones no deck is
   * holding**.
   *
   * Asserted on the payload as well as on the row, because `allocation` is a field nothing in this
   * app had ever sent before this tab: a body that mounted, listed and quietly dropped the field
   * would look right on screen and answer the wrong question.
   */
  it("draws the reader's own copies, and asks only for the free ones", async () => {
    panel();

    // The tile's Add button rather than a line of text: since 2026-08-24 this tab is a wall of
    // art, so the copy it is about is said in an accessible **name** — see `CollectionSearchTab`.
    expect(
      await screen.findByRole("button", { name: /^Add Lightning Bolt \(LEA 161/ }),
    ).toBeInTheDocument();
    expect(collectionList.mock.calls[0][0].allocation).toBe("unallocated");
  });

  /**
   * **The collection tab is addressed by the deck the editor named**, not by the piles it was
   * handed.
   *
   * It read `categories[0].deckId` for a day — true of every deck the editor can open, since
   * `deck_create` seeds four piles in the deck's own transaction — and the objection is not that
   * it answered wrongly but that a list of *piles* is a different fact from *which deck this is*.
   * The categories here belong to another deck, which is a state nothing in the app produces and
   * is exactly what tells the two apart.
   */
  it("addresses the collection tab's write with the deck it was given", async () => {
    panel({ categories: [category({ deckId: 99 })], deckId: 4 });

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(OWNED_BOLT.id, 4, { id: MAIN.id }, 1),
    );
  });

  /**
   * The other direction of the switch, from the collection body's side.
   *
   * The existing pair above proves the card search is not asked for while the collection is up;
   * this proves the reverse, which is the half that would go unnoticed — a `collection_list`
   * running under a wall of Scryfall printings costs a round trip nobody can see.
   */
  it("stops reading the collection once the reader leaves the tab", async () => {
    panel();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    const asked = collectionList.mock.calls.length;

    await userEvent.click(tab(ALL_CARDS));
    await screen.findByRole("searchbox", { name: "Search cards" });

    expect(collectionList.mock.calls.length).toBe(asked);
    // **The two tabs are told apart by their search boxes, not by a card.** Both are walls of the
    // same `CardGrid` since 2026-08-24, and the fixture behind each is the same printing — so a
    // query for the card's name, or for its caption, matches whichever tab is up and proves
    // nothing about which one that is. Each tab's box is named for what it searches.
    expect(
      screen.queryByRole("searchbox", { name: "Search your collection" }),
    ).not.toBeInTheDocument();
  });

  /**
   * The press, in both directions, and what it does to the *other* tab.
   *
   * Two bodies, one mounted at a time, is the whole design: each tab's data hook lives in its own
   * component so it can be called conditionally, which is `OpenPanel`'s reason exactly one level
   * out. So the assertion is not merely that the wall appears — it is that going back takes it
   * away again, and that the collection tab costs the card search nothing while it is on.
   */
  it("switches bodies on a press, and mounts only the tab being read", async () => {
    panel();
    await screen.findByRole("group", { name: "Search in" });

    await userEvent.click(tab(ALL_CARDS));

    expect(tab(ALL_CARDS)).toHaveAttribute("aria-pressed", "true");
    expect(tab(COLLECTION)).toHaveAttribute("aria-pressed", "false");
    // **Each tab is identified by its own search box and never by a card**: both bodies draw the
    // same `CardGrid` over the same fixture printing since 2026-08-24, so a tile named
    // "Lightning Bolt" is on screen either way and asserting on it would pass whichever tab were
    // mounted. The boxes are named for what they search, which is the difference itself.
    expect(await screen.findByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search your collection" }),
    ).not.toBeInTheDocument();
    const asked = searchCards.mock.calls.length;
    expect(asked).toBeGreaterThan(0);

    await userEvent.click(tab(COLLECTION));

    expect(tab(COLLECTION)).toHaveAttribute("aria-pressed", "true");
    // Unmounted, not hidden: the wall's own filter row goes with it.
    expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("searchbox", { name: "Search your collection" }),
    ).toBeInTheDocument();
    expect(searchCards.mock.calls.length).toBe(asked);
  });

  /**
   * **The choice outlives the deck**, which is what makes a default defensible at all.
   *
   * The editor is keyed on the deck id, so leaving a deck and coming back tears this panel down
   * and builds a new one — a `useState` here would put every reader who works from the wider
   * search back on the collection tab on every deck they opened, which is the complaint that
   * moved the disclosure into `app_meta` (issue #183) one control over.
   *
   * Remounted over the **same query client**, because that is where the answer lives and it is
   * what the app has: one client for the process. The wall coming back is the half that says the
   * memory reaches the *body* rather than only the strip's marking.
   */
  it("keeps the reader's tab across a remount of the same deck", async () => {
    const view = panel();
    await screen.findByRole("group", { name: "Search in" });

    await userEvent.click(tab(ALL_CARDS));
    await screen.findByRole("button", { name: "Lightning Bolt" });

    view.remount();

    expect(await screen.findByRole("button", { name: ALL_CARDS })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(tab(COLLECTION)).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /**
   * A collapse is not a change of mind about *which* search, so it does not answer one.
   *
   * The strip goes with the body — there is no room for it in 36px of rail — and the choice it
   * draws is in the cache rather than in the strip, so it is still the reader's when the column
   * comes back. This is the same split the disclosure itself is built on: what is *drawn* and
   * what was *chosen* are two things.
   */
  it("keeps the tab across a collapse, and draws no strip in the rail", async () => {
    await openPanel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: PANEL_TOGGLE }));

    expect(tab(ALL_CARDS)).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "Lightning Bolt" })).toBeInTheDocument();
  });

  /** The editor's refusal takes the strip with the rest of the body — a control for a body that
   *  is not drawn is a control that cannot do the thing it names. */
  it("draws no strip when the editor has no room for the panel", async () => {
    panel({ roomy: false });

    await screen.findByRole("button", { name: PANEL_TOGGLE });
    expect(screen.queryByRole("group", { name: "Search in" })).not.toBeInTheDocument();
  });

  /**
   * **The strip is a line of its own, above the search box and below the disclosure** — moved off
   * the header row on 2026-08-24, when it stopped being a gold segmented pill and became an
   * underlined tab bar. `TabStrip`'s own doc carries why; this is the placement, which is the half
   * a class assertion can hold onto.
   *
   * Two claims, and the second is the one that would fail a tidy that folded it back: it is **not**
   * inside the header row, and it is a **sibling** that comes after it — a bar drawn below the
   * filters would be a tab bar under the thing it switches.
   */
  it("draws the strip on its own line under the header row", async () => {
    await openPanel();

    const strip = screen.getByRole("group", { name: "Search in" });
    const disclosure = screen.getByRole("button", { name: PANEL_TOGGLE });
    const header = disclosure.parentElement!;

    expect(header).not.toContainElement(strip);
    expect(strip.parentElement).toBe(header.parentElement);
    // `compareDocumentPosition` rather than an index: it says "the strip follows the header" in
    // the DOM's own terms, and survives anything else being added to the panel between them.
    expect(
      header.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * **Half the panel each, and it still cannot hang out of one dragged to its floor**
   * ({@link MIN_PANEL_WIDTH_PX}), which is 206px — a ~193px content box.
   *
   * The pill this replaced measured **141px** and had to be two short words, because a segmented
   * pair cannot wrap inside the one rounded box it is drawn as. Two `flex-1` items are safe for a
   * stronger reason than the `flex-wrap` row that stood here until 2026-08-25: each is already
   * asking for half a line, so neither can wrap past the other, and the wider word (`Collection`,
   * ~68px) fits the 96 that half of a 193px content box gives it. `min-w-0` is what keeps that
   * true if the labels ever grow — without it a flex item's floor is its own min-content, and an
   * overhang here is a horizontal scrollbar across the whole deck builder, which the app's 1024px
   * floor forbids (`src/CLAUDE.md`; `ManaValueChips` shipped it once already).
   *
   * **jsdom lays nothing out, so the classes are the assertion.**
   */
  it("gives each tab half the panel, so neither can hang out of a narrow one", async () => {
    await openPanel();

    const strip = screen.getByRole("group", { name: "Search in" });
    // Not `flex-wrap` — two halves of a bar are one bar, and a wrapped tab strip is two.
    expect(strip).not.toHaveClass("flex-wrap");
    for (const label of [COLLECTION, ALL_CARDS]) {
      const button = within(strip).getByRole("button", { name: label });
      expect(button).toHaveClass("flex-1");
      expect(button).toHaveClass("min-w-0");
    }
  });

  /**
   * **The own/need pair is gone from this row, and nothing replaced it** (2026-08-25).
   *
   * It was `AddModeStrip` — `Cards I own` / `Cards I need`, drawn beside the disclosure on the
   * card-search tab — and it decided what an Add wrote: a `deck_cards` row that reads as missing,
   * or a move of a copy the reader already had. Every add means the first of those now, and the
   * Collection tab is where the second is done, because it can name the deck a spoken-for copy
   * would come out of and ask before taking it.
   *
   * Asserted on the tab that used to draw it, which is the only place it could come back.
   */
  it("no longer asks what kind of add the card search makes", async () => {
    await openPanel();

    expect(screen.queryByRole("group", { name: "Adding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cards I own" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cards I need" })).not.toBeInTheDocument();
  });
});


/**
 * The panel's own width, which the reader owns from its left edge.
 *
 * Every number here is a px width read off the `<section>`'s inline style. The panel is a fixed
 * column in a flex row, so that style *is* what it measures — there is no layout engine under
 * these tests to disagree with it, and none is needed: the arithmetic is the component's.
 */
describe("DeckSearchPanel resizing", () => {
  const column = () => screen.getByRole("region", { name: "Add cards" });
  const handle = () => screen.getByRole("separator", { name: "Resize card search" });

  /**
   * One pointer event with a real `clientX` on it.
   *
   * Built as a `MouseEvent` rather than through `fireEvent.pointerDown`, for the reason
   * `src/test-drag.ts` builds its own: jsdom ships no `PointerEvent`, so Testing Library's
   * pointer helpers fall back to a plain `Event` and the coordinate never arrives — the drag
   * would read `undefined` and the panel would be `NaN` wide, which `toHaveStyle` reports as a
   * missing style rather than as the wrong one. React dispatches on the event's **type**, not on
   * its class, so a `MouseEvent` named `pointermove` reaches `onPointerMove` carrying the
   * `clientX` a mouse event has natively.
   */
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(handle(), event);
  };

  /** A whole drag: press at `from`, move to `to`, let go. Leftward is wider. */
  const drag = (from: number, to: number) => {
    pointer("pointerdown", from);
    pointer("pointermove", to);
    pointer("pointerup", to);
  };

  it("opens at its default width and grows as the edge is pulled left", async () => {
    await openPanel();
    expect(column()).toHaveStyle({ width: "384px" });

    drag(900, 800);

    expect(column()).toHaveStyle({ width: "484px" });
    // The value the separator reports is the width, so a screen reader hears the same number the
    // panel is drawn at rather than a percentage of something it cannot see.
    expect(handle()).toHaveAttribute("aria-valuenow", "484");
  });

  /** And narrower the other way, down to the one card `MIN_PANEL_WIDTH_PX` is measured from. */
  it("stops at one card's width however far the edge is pushed right", async () => {
    await openPanel();

    drag(900, 1600);

    expect(column()).toHaveStyle({ width: "206px" });
    expect(handle()).toHaveAttribute("aria-valuemin", "206");
  });

  /**
   * The editor's cap, which is the deck's floor and half the window in one number. The drag is
   * refused at it rather than allowed and corrected afterwards: a reader pulling past the edge
   * sees the panel stop, which is what an edge is.
   */
  it("stops at the width the editor allows however far the edge is pulled left", async () => {
    await openPanel({ maxWidth: 500 });

    drag(900, 200);

    expect(column()).toHaveStyle({ width: "500px" });
    expect(handle()).toHaveAttribute("aria-valuemax", "500");
  });

  /**
   * **The cap corrects what is drawn and never what was asked for**, which is the whole of
   * "reopens at the last valid width". The window narrowing, or a card pane opening beside the
   * editor, is not the reader changing their mind — so when the room comes back, so does their
   * column. Holding the clamped number instead makes every momentary squeeze permanent.
   */
  it("gives the reader's width back when the room returns", async () => {
    const view = await openPanel();

    drag(900, 600);
    expect(column()).toHaveStyle({ width: "684px" });

    // The card pane opens beside the editor and the desk has 300px to spare.
    view.update({ maxWidth: 300 });
    expect(column()).toHaveStyle({ width: "300px" });

    // And closes again.
    view.update({ maxWidth: undefined });
    expect(column()).toHaveStyle({ width: "684px" });
  });

  /**
   * A collapse throws the *search* away — `OpenPanel` unmounts, and that is deliberate — but not
   * the column it was drawn in. The width lives in the root beside `open` for exactly this: a
   * reader who sized this panel for the job, shut it, and opened it again is not asking to start
   * from 384.
   */
  it("reopens at the width the reader left it at", async () => {
    await openPanel();

    drag(900, 700);
    expect(column()).toHaveStyle({ width: "584px" });

    const toggle = screen.getByRole("button", { name: PANEL_TOGGLE });
    await userEvent.click(toggle);
    expect(screen.queryByRole("separator", { name: "Resize card search" })).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(column()).toHaveStyle({ width: "584px" });
  });

  /**
   * The keyboard half, which is not an extra: a caret cannot perform a drag, and a resize that
   * only a pointer can reach is a layout choice taken away from anyone who does not use one.
   * Left widens and right narrows, matching the pointer — the key moves the *separator*.
   */
  it("moves with the arrow keys and jumps to either end with Home and End", async () => {
    await openPanel({ maxWidth: 500 });
    handle().focus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(column()).toHaveStyle({ width: "408px" });

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(column()).toHaveStyle({ width: "360px" });

    await userEvent.keyboard("{Home}");
    expect(column()).toHaveStyle({ width: "206px" });

    await userEvent.keyboard("{End}");
    expect(column()).toHaveStyle({ width: "500px" });
  });

  /**
   * There is nothing to resize in the rail, and an edge to pull on it would be an affordance for
   * a width the editor has already refused. The panel says why in words on its disclosure
   * instead — see the railing tests above.
   */
  it("draws no handle when the editor has railed it", async () => {
    await openPanel({ roomy: false });

    expect(screen.queryByRole("separator", { name: "Resize card search" })).not.toBeInTheDocument();
  });
});
