import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DND_SOURCE_ATTR } from "@/lib/dndTarget";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { readDragData } from "@/features/decks/dnd";
import type {
  CardSummary,
  SearchRequest,
  SearchResponse,
  SetSummary,
  TagHit,
  TagProgressEvent,
  TagStatus,
} from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";

const searchCards = vi.hoisted(() => vi.fn());
/** Hoisted so a test can read what the *facet* request carried — see
 *  `sends the card text box and the tag chips to the facet index together`. */
const facetCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the filter row and asks for the set list on the way up, so the
// mock has to answer it — a missing `listSets` is a rejected query, not a compile error.
const listSets = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
const collectionAdd = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
/** The three tag reads and the one tag write this page makes. */
const tagSearch = vi.hoisted(() => vi.fn());
const tagChildren = vi.hoisted(() => vi.fn());
const tagMute = vi.hoisted(() => vi.fn());
const artTagsStatus = vi.hoisted(() => vi.fn());
const oracleTagsStatus = vi.hoisted(() => vi.fn());
/**
 * The art taxonomy's progress channel, captured rather than stubbed.
 *
 * The page subscribes to it so a finished ingest takes the notice down without a reload, and the
 * only way to drive that is to hold the callback the page handed over. A bare
 * `mockReturnValue(() => {})` would leave the subscription unregistered from the test's point
 * of view and the heal untestable.
 */
const onArtTagProgress = vi.hoisted(() => vi.fn());
/**
 * The shell's own reads, for the two tests that mount this page **inside `AppShell`**.
 *
 * The sidebar is the only drop target a card found on this page can reach — the Tags wall and
 * the deck editor never coexist — so the drag those tests drive cannot be observed anywhere
 * else, and the shell has to be real for it. Everything here is a listener registration or a
 * status poll: left off, the synchronous `TypeError` of calling `undefined` escapes a mount
 * effect where no `.catch` can reach it, which passes green while printing hundreds of errors.
 */
const syncStatus = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    getMarketplace,
    // The shell mounts `useCardZoomPersistence`, which reads this row once as it launches and
    // writes back after a gesture. Mocked rather than left off for the event subscriptions'
    // reason: a `.catch` cannot catch the synchronous TypeError of calling `undefined`. An
    // empty row is a database nobody has zoomed, so every wall opens at its default.
    cardZoom: vi.fn().mockResolvedValue({}),
    // `useListViewPersistence`' launch read, beside the zoom's — this file mounts the whole
    // `App` for its sidebar drags. `{}` leaves every list on its own default.
    listView: vi.fn().mockResolvedValue({}),
    setListView: vi.fn().mockResolvedValue(undefined),
    // `useFlattenPersistence`' launch read, beside the other two. `{}` leaves both switches on
    // their own defaults; the Tags page has no filing to ignore and never reads either.
    flattenState: vi.fn().mockResolvedValue({}),
    setFlattenState: vi.fn().mockResolvedValue(undefined),
    setCardZoom: vi.fn().mockResolvedValue(undefined),
    // And the rail's own width, read once on the way up. `false` is a database nobody has
    // collapsed the sidebar in, which is the shell every test here means to render.
    navCollapsed: vi.fn().mockResolvedValue(false),
    setNavCollapsed: vi.fn().mockResolvedValue(undefined),
    // Answered **cold** — `ready: false`, every map empty — which leaves every filter control
    // live and every accessible name plain, so this file's queries say what they always said.
    // The greying itself is `FilterBar.test.tsx`'s and `facets.test.ts`'s subject.
    facetCards,
    listSets,
    prefetchImages,
    collectionAdd,
    wishlistAdd,
    tagSearch,
    tagChildren,
    tagMute,
    artTagsStatus,
    oracleTagsStatus,
    onArtTagProgress,
    syncStatus,
    syncRun: vi.fn(),
    onSyncProgress: vi.fn().mockReturnValue(() => {}),
    onCollectionReconciled: vi.fn().mockReturnValue(() => {}),
    onMarketplaceProgress: vi.fn().mockReturnValue(() => {}),
    onOracleTagProgress: vi.fn().mockReturnValue(() => {}),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
    deckAddCard,
    deckGet,
  },
}));

import { AppShell } from "@/components/AppShell";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { CardToDeckProvider } from "@/features/card/cardMenu";
import { HIDDEN_TAGS_KEY } from "@/features/settings/useHiddenTags";
import { DEFAULT_ZOOM, ZOOM_SECTIONS } from "@/lib/cardZoom";
import { WALL_CARD_VARIANT } from "@/lib/images";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import type { Update } from "@/lib/useUpdate";
import { HIDE_BACKGROUND_LABEL } from "./TagChips";
import { TagsPage } from "./TagsPage";

/**
 * One printing, priced, unowned.
 *
 * Lightning Bolt because the fake's own art seed uses it for the fact this page turns on: the
 * `lightning` motif is on **one** of its four printings, so a wall that collapsed them would show
 * a reader three pictures with no lightning in them.
 */
const BOLT: CardSummary = {
  promoTypes: null,
  id: "c-bolt-lea",
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
  gameChanger: false,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
};

/** The same card, a different piece of cardboard — the pair the collapse rule is about. */
const BOLT_2ED: CardSummary = {
  ...BOLT,
  id: "c-bolt-2ed",
  setCode: "2ed",
  setName: "Unlimited Edition",
  collectorNumber: "162",
  price: 210,
  priceLow: 210,
  priceHigh: 210,
};

const page = (
  items: CardSummary[],
  total = items.length,
  totalIsCapped = false,
): SearchResponse => ({ items, total, totalIsCapped });

/** `n` distinct rows starting at `from`, so a page-2 row is tellable from a page-1 one. */
const cards = (n: number, from = 0): CardSummary[] =>
  Array.from({ length: n }, (_, i) => ({ ...BOLT, id: `c${from + i}`, name: `Card ${from + i}` }));

const hit = (over: Partial<TagHit> & Pick<TagHit, "slug" | "label">): TagHit => ({
  id: `id-${over.slug}`,
  namespace: "art",
  description: null,
  cardCount: 3,
  childCount: 0,
  parents: [],
  ...over,
});

/**
 * The rail's two roots, and neither is `dog`.
 *
 * `landscape` is the fake's own weight-floor example — three rows open, two once the floor is on
 * — and `removal` is its oracle counterpart, which is what makes `Both` worth opening on.
 */
const LANDSCAPE = hit({ slug: "landscape", label: "Landscape", childCount: 1 });
const REMOVAL = hit({ slug: "removal", label: "Removal", namespace: "oracle", cardCount: 6686 });
/** `landscape`'s child, so a disclosure has something to open onto. */
const FOREST = hit({ slug: "forest", label: "Forest" });

/** A taxonomy that has been ingested — the resting state of a machine that can reach Scryfall. */
const INGESTED: TagStatus = {
  updatedAt: "2026-08-19T09:00:00.000Z",
  ingestedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  tagCount: 11_531,
  taggingCount: 475_163,
  stale: false,
  refreshing: false,
};

/**
 * The never-ingested row: every field null, `stale: true`, nothing running.
 *
 * **Not a failure.** It is what every install is on its first launch and what a machine that
 * cannot reach Scryfall stays in permanently — the command resolves rather than refusing, which
 * is why the page can say so in words instead of drawing an error.
 */
const NEVER: TagStatus = {
  updatedAt: null,
  ingestedAt: null,
  checkedAt: null,
  tagCount: null,
  taggingCount: null,
  stale: true,
  refreshing: false,
};

/** One set with printings, so the picker has something to pick. */
const ALPHA: SetSummary = {
  code: "lea",
  name: "Limited Edition Alpha",
  setType: "core",
  releasedAt: "1993-08-05",
  cardCount: 295,
};

/**
 * A right-click, and nothing awaited.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the surface's handler is on the
 * row or the tile, never on the cell the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * The page, under the three providers `App` mounts above it.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider is
 * above it, so a page rendered bare would suppress nothing, open nothing, and pass every menu
 * assertion below by never being asked. `CardToDeckProvider` goes **above** it and not inside,
 * because the menu panel is drawn as a *sibling* of that provider's children — a provider around
 * this page is around none of the menu's rows. `TooltipProvider` is here for `useTooltip`'s own
 * no-op reason.
 */
function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQueryClient = qc;
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CardToDeckProvider>
          <ContextMenuProvider>{ui}</ContextMenuProvider>
        </CardToDeckProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The client the last {@link wrap} built, for the one assertion about a key **no observer on
 *  this page holds** — see `puts the Settings list out of date too`. */
let lastQueryClient: QueryClient | null = null;

/** The shell's update state, in its resting position — `App` owns the real one. */
const noUpdate: Update = {
  status: null,
  progress: null,
  busy: false,
  action: "none",
  error: null,
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  openReleasePage: vi.fn(),
};

/**
 * The page inside the real sidebar, under the app's own query client.
 *
 * The module's client rather than a fresh one, because that is the one the sidebar's Decks entry
 * borrows `useDeck` through — the same arrangement `AppShell.test.tsx` renders in.
 */
function wrapInShell(ui: ReactElement) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CardToDeckProvider>
          <ContextMenuProvider>
            <AppShell update={noUpdate}>{ui}</AppShell>
          </ContextMenuProvider>
        </CardToDeckProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The page's `art-tags:progress` handler, once it has subscribed. */
let artProgress: ((e: TagProgressEvent) => void) | null = null;

/**
 * One rail row, by the accessible name `TagTree` composes: label, taxonomy, reach.
 *
 * **The reach is in the pattern and it is what makes this unambiguous.** A chip is named
 * `Landscape, art tag, included`, so a needle that stopped at the taxonomy would match both the
 * row and the chip the moment a tag is picked — and every test that presses the same row twice
 * would fail with "found multiple elements" rather than with what it was asking about. A reach
 * always starts with a digit; neither chip word does.
 */
/**
 * A rail row, waited for with an explicit timeout rather than testing-library's default.
 *
 * **The default is 1000 ms and it is a bet on machine speed, not a statement about this
 * page.** The rail is fetched lazily — a level arrives from the component that draws it —
 * so every one of these is a wait on an async round trip rather than on a render, and the
 * assertions that follow are about *what* the rail asked for, never about how fast. It
 * failed once at 1000 ms in a full-suite run on a loaded machine (2026-08-28) while passing
 * that same file in isolation, on this branch and on `main` alike.
 *
 * Five seconds is chosen to be far outside the noise while still failing in seconds if the
 * rail genuinely stops loading. It is deliberately on this helper and not on the whole file:
 * a blanket `testTimeout` would also slacken the assertions that are about behaviour.
 */
const railRow = (label: string) =>
  screen.findByRole(
    "button",
    { name: new RegExp(`^${label}, (art|oracle) tag, \\d`) },
    { timeout: 5000 },
  );

/** The last `search_cards` payload — what every filter assertion below reads. */
const lastRequest = () =>
  searchCards.mock.calls[searchCards.mock.calls.length - 1][0] as SearchRequest;

/** The newest **facet** request — a different statement from the page's, and the one whose cost
 *  `index/facets.rs` documents. */
const lastFacetRequest = () =>
  facetCards.mock.calls[facetCards.mock.calls.length - 1][0] as SearchRequest;

/** How tall the scroll container pretends to be. */
let viewportHeight = 600;
const scrollTo = vi.fn();

/**
 * jsdom lays nothing out: every element measures 0, so the virtualiser computes an empty window
 * and renders no rows at all. `@tanstack/react-virtual` sizes its scroll container with
 * `offsetHeight`, so one number is the whole of what it is missing. It scrolls through
 * `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => viewportHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
});

beforeEach(() => {
  viewportHeight = 600;
  scrollTo.mockClear();
  searchCards.mockReset().mockResolvedValue(page([BOLT]));
  // Answered **cold** — `ready: false`, every map empty — which leaves every filter control live
  // and every accessible name plain, so this file's queries say what they always said. The
  // greying itself is `FilterBar.test.tsx`'s and `facets.test.ts`'s subject.
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
  listSets.mockReset().mockResolvedValue([ALPHA]);
  prefetchImages.mockReset().mockResolvedValue(undefined);
  collectionAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  // The roots of both taxonomies, and one level under `landscape`. Keyed on the parent slug so a
  // disclosure gets its own answer rather than the roots again.
  tagChildren
    .mockReset()
    .mockImplementation((_ns: string, slug: string | null) =>
      Promise.resolve(slug === null ? [LANDSCAPE, REMOVAL] : [FOREST]),
    );
  tagSearch.mockReset().mockResolvedValue([LANDSCAPE]);
  tagMute.mockReset().mockResolvedValue(undefined);
  // Both taxonomies in, so the honest empty state below is the one thing that has to ask for it.
  artTagsStatus.mockReset().mockResolvedValue(INGESTED);
  oracleTagsStatus.mockReset().mockResolvedValue(INGESTED);
  syncStatus.mockReset().mockResolvedValue({
    cardCount: 100,
    lastSyncAt: null,
    running: false,
    lastError: null,
    dataDir: "C:/data",
    imageStoreFailures: 0,
  });
  deckAddCard.mockReset();
  deckGet.mockReset();
  artProgress = null;
  onArtTagProgress.mockReset().mockImplementation((cb: (e: TagProgressEvent) => void) => {
    artProgress = cb;
    return () => {};
  });
  // **The shell-mounted tests share the app's module-level client**, whose `staleTime` is 30 s —
  // so without this the second of them reads the first's cached search page instead of calling
  // `searchCards`, and passes only because both fixtures happen to be the same card.
  // `AppShell.test.tsx` clears it in its own `beforeEach` for exactly this reason.
  queryClient.clear();
  useAppStore.setState({
    activeView: "tags",
    tagsView: "grid",
    searchView: "grid",
    selectedCardId: null,
    openDeckId: null,
  });
});

describe("the tag rail", () => {
  it("opens on both taxonomies' roots, and asks for them lazily", async () => {
    wrap(<TagsPage />);

    expect(await railRow("Landscape")).toBeInTheDocument();
    expect(await railRow("Removal")).toBeInTheDocument();
    // The roots and nothing else: a level is fetched by the component that draws it, and no
    // disclosure has been opened.
    expect(tagChildren.mock.calls).toEqual([["both", null]]);
  });

  it("searches the tag taxonomies for what is typed in the box", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await railRow("Landscape");

    await user.type(screen.getByPlaceholderText(/search tags/i), "landsca");

    await waitFor(() => expect(tagSearch).toHaveBeenCalledWith("landsca", "both", 50));
  });

  /** The rail is a graph, not a list: a category's children arrive when it is opened. */
  it("fetches a branch when its disclosure is opened, in that branch's own taxonomy", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await screen.findByRole("button", { name: /Show tags under Landscape/ }));

    expect(await railRow("Forest")).toBeInTheDocument();
    expect(tagChildren).toHaveBeenCalledWith("art", "landscape");
  });
});

describe("picking a tag", () => {
  it("sends the picked tag as an art term and chips it", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await railRow("Landscape"));

    await waitFor(() =>
      expect(lastRequest()).toMatchObject({
        artTags: { include: ["landscape"], exclude: [] },
      }),
    );
    expect(
      screen.getByRole("button", { name: /^Landscape, art tag, included/ }),
    ).toBeInTheDocument();
  });

  /**
   * Issue #181, end to end: the row is a **toggle**, so the press that turned the filter on turns
   * it off again. It used to only ever add — `addChip` answers an already-picked tag with the
   * same object — which left "on" reachable from the rail and "off" reachable only from the
   * chip's ×, two controls away from the one the reader had just used.
   *
   * `artTags` goes **absent** rather than empty, which is `termsFor`'s rule and not a detail: a
   * taxonomy nobody picked from carries no predicate, and an `include: []` riding on the request
   * would be a payload claiming a filter the reader has taken off.
   */
  it("takes the tag off again when its row is pressed a second time", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await railRow("Landscape"));
    await waitFor(() => expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] }));
    await screen.findByRole("button", { name: /^Landscape, art tag, included/ });

    await user.click(await railRow("Landscape"));

    await waitFor(() => expect(lastRequest().artTags).toBeUndefined());
    expect(
      screen.queryByRole("button", { name: /^Landscape, art tag, included/ }),
    ).not.toBeInTheDocument();
  });

  /** The rail says which rows are on, and `aria-pressed` is where a toggle button says it. */
  it("presses the row in and lets it back out", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    expect(await railRow("Landscape")).toHaveAttribute("aria-pressed", "false");

    await user.click(await railRow("Landscape"));
    await waitFor(async () =>
      expect(await railRow("Landscape")).toHaveAttribute("aria-pressed", "true"),
    );

    await user.click(await railRow("Landscape"));
    await waitFor(async () =>
      expect(await railRow("Landscape")).toHaveAttribute("aria-pressed", "false"),
    );
  });

  /**
   * The floor is settled on **every** write to the selection, and a toggle is a fourth path into
   * the empty state — so un-picking the last art include has to take a `strong` floor down with
   * it. Left set, `TagChips` would grey a control that is still on, which is the one state
   * `filterChipState` says never occurs: a filter that is on and unreachable.
   */
  it("drops the weight floor when the last art include is toggled off", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await railRow("Landscape"));
    await user.click(screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }));
    await waitFor(() => expect(lastRequest().artWeightFloor).toBe("strong"));

    await user.click(await railRow("Landscape"));

    await waitFor(() => expect(lastRequest().artWeightFloor).toBeUndefined());
  });

  /** The two taxonomies AND with each other: "a landscape that removes something" is one ask. */
  it("intersects an oracle tag with an art one", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await railRow("Landscape"));
    await user.click(await railRow("Removal"));

    await waitFor(() =>
      expect(lastRequest()).toMatchObject({
        artTags: { include: ["landscape"], exclude: [] },
        oracleTags: { include: ["removal"], exclude: [] },
      }),
    );
  });

  it("flips a chip to an exclude and removes it again", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));
    await screen.findByRole("button", { name: /^Landscape, art tag, included/ });

    await user.click(screen.getByRole("button", { name: /^Landscape, art tag, included/ }));
    await waitFor(() =>
      expect(lastRequest()).toMatchObject({ artTags: { include: [], exclude: ["landscape"] } }),
    );

    await user.click(screen.getByRole("button", { name: "Remove Landscape, art tag" }));
    await waitFor(() => expect(lastRequest().artTags).toBeUndefined());
  });

  /**
   * The one thing this page contributes to the weight control: it is **drawn at all**.
   *
   * `TagChips` follows `ManaValueChips`' X-chip shape — the control renders only where the
   * handler is supplied — so a page that forgot `onFloorChange` would ship a feature that is
   * silently absent rather than dead, and nothing in that component's own tests could see it.
   */
  it("offers the weight floor, and sends it once an art tag can be narrowed", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));

    const floor = screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    await user.click(floor);

    await waitFor(() => expect(lastRequest().artWeightFloor).toBe("strong"));
    expect(floor).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * **A filter that is on and unreachable is the one state `filterChipState` says never occurs.**
   *
   * The floor narrows the art side's *include* half alone, so the moment the last one leaves
   * `TagChips` greys the control — and a chip drawn pressed *and* greyed would be a filter the
   * reader can neither see the effect of nor turn off. `settleFloor` in the page is what takes it
   * down, on every write rather than on the removal alone: two paths reach the empty state, and
   * this is the second of them.
   */
  it("takes the weight floor down when its last art include is flipped to an exclude", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));
    await user.click(screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }));
    await waitFor(() => expect(lastRequest().artWeightFloor).toBe("strong"));

    await user.click(screen.getByRole("button", { name: /^Landscape, art tag, included/ }));

    const floor = screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    await waitFor(() => expect(floor).toHaveAttribute("aria-disabled", "true"));
    expect(floor).toHaveAttribute("aria-pressed", "false");
    expect(lastRequest().artWeightFloor).toBeUndefined();
  });
});

/**
 * **The card text box and the tag chips reach the facet index in one request**, which two
 * documents used to say could not happen.
 *
 * `index/facets.rs` and `search-faceting.md` both argued that one closure probe per picked slug
 * was affordable because the Tags page's only text box searches *tags*, so the facet key moves
 * on a chip press and never on a keystroke. It moves on both: this page also renders
 * `FilterBar`, whose `#card-search-text` is unconditional and feeds `debouncedText` into
 * `facetReq.text`. Driven in the shipped window on 2026-08-20 with `plane` picked (38,144
 * illustrations), one debounced keystroke cost 47 ms, and 142-152 ms with the weight floor on.
 *
 * Asserted here because nobody greps for `card-search-text` under `features/tags/`, and a claim
 * about which requests are reachable is exactly the kind that rots in a `///` where no CI job
 * can see it.
 */
it("sends the card text box and the tag chips to the facet index together", async () => {
  const user = userEvent.setup();
  wrap(<TagsPage />);
  await user.click(await railRow("Landscape"));
  await waitFor(() => expect(lastFacetRequest().artTags?.include).toEqual(["landscape"]));

  await user.type(screen.getByPlaceholderText("Search cards\u2026"), "bolt");

  await waitFor(() => expect(lastFacetRequest().text).toBe("bolt"));
  // Both halves in the *same* request. Two requests each carrying one would be a different
  // design and a cheaper one; this is the one that is shipped.
  expect(lastFacetRequest().artTags?.include).toEqual(["landscape"]);
});

describe("hiding a tag", () => {
  /** The rail's menu is on the tag button, which is what a right-click has to reach. */
  const openRowMenu = async (label: string) => {
    rightClick(await railRow(label));
    return screen.findByRole("menu");
  };

  it("mutes the tag and puts both tag lists out of date", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await openRowMenu("Landscape");

    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    await waitFor(() => expect(tagMute).toHaveBeenCalledWith("art", "id-landscape", "landscape"));
    // The first invalidation, observed as the refetch it causes: the rail's level is re-read.
    // Without it the hidden tag would sit on screen for the client's whole 30 s `staleTime`,
    // which reads as the mute having silently failed.
    await waitFor(() => expect(tagChildren.mock.calls.length).toBeGreaterThan(1));
  });

  /**
   * The **second** key, and it needs a live needle to be observable at all: `["tag-search", …]`
   * has no observer until the box has text in it, so a page tested only through the tree would
   * pass with that invalidation missing. A muted tag has to leave the type-ahead too — it is the
   * other list the reader is looking at, and the one they found the tag in.
   */
  it("re-asks the type-ahead as well, for a tag hidden out of its answer", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.type(screen.getByPlaceholderText(/search tags/i), "landsca");
    await waitFor(() => expect(tagSearch).toHaveBeenCalledTimes(1));

    await openRowMenu("Landscape");
    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    await waitFor(() => expect(tagSearch.mock.calls.length).toBeGreaterThan(1));
  });

  /**
   * The **third** key, and the only one this page never draws: Settings' hidden-tag list.
   *
   * It cannot be observed as a refetch the way the two above are, because nothing on this page
   * subscribes to it — which is exactly why it was missed. The rail's own answer to a hide is a
   * live line saying hidden tags "come back from Settings", so a reader who had opened Settings
   * once and followed that sentence back inside the client's 30 s `staleTime` would arrive at a
   * cached list **without the tag they had just hidden on it** — the same broken promise
   * `HiddenTagsPanel` exists to end, in a narrower window. Asserted on the cache's own state,
   * since a stale mark is the whole of what the writer owes a reader it cannot see.
   */
  it("puts the Settings list out of date too, though nothing here reads it", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    const qc = lastQueryClient!;
    // Seeded rather than fetched: an unobserved key has no query at all until something puts one
    // there, and `invalidateQueries` on a key with no entry is silently a no-op — so without this
    // the assertion would pass against a page that named the wrong key.
    qc.setQueryData(HIDDEN_TAGS_KEY, []);
    expect(qc.getQueryState(HIDDEN_TAGS_KEY)?.isInvalidated).toBe(false);

    await openRowMenu("Landscape");
    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    await waitFor(() =>
      expect(qc.getQueryState(HIDDEN_TAGS_KEY)?.isInvalidated).toBe(true),
    );
  });

  /**
   * A refusal is real: `tag_mute` turns down a blank `TagHit.id` in words, because one stored
   * mute with a blank id would equal every row predating an id-writing refresh.
   *
   * The greyed row's accessible name **includes its reason**, so it is matched with a regex — an
   * exact-string query fails on it and reads as "the row is missing".
   */
  it("greys the hide row for a tag with no stable id, and says why", async () => {
    tagChildren.mockResolvedValue([{ ...LANDSCAPE, id: "" }]);
    wrap(<TagsPage />);
    await openRowMenu("Landscape");

    const row = screen.getByRole("menuitem", { name: /^Hide this tag/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleName(/next tag refresh/i);
  });

  it("says a refused hide where the reader asked for it", async () => {
    tagMute.mockRejectedValue("the tag database is busy");
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await openRowMenu("Landscape");

    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not hide Landscape — the tag database is busy/,
    );
    // **And the rail does not claim the tag went anywhere.** The handler rethrows after saying
    // why, which is the whole reason it rethrows: `TagTree` awaits the write before printing
    // "hidden tags come back from Settings", and a handler that swallowed would have that
    // sentence appear over a tag still sitting in the list beside it.
    expect(screen.queryByText(/come back from Settings/i)).not.toBeInTheDocument();
    expect(await railRow("Landscape")).toBeInTheDocument();
    // Neither list is re-read for a write that changed nothing.
    expect(tagChildren.mock.calls).toHaveLength(1);
  });
});

describe("the results wall", () => {
  /**
   * **The single most load-bearing thing on this page.**
   *
   * `collapse` folds every printing of a card into one row drawn by the newest, which for an art
   * theme is precisely wrong: the tagged thing is *this illustration*, so a collapsed row would
   * show a reader a picture that has nothing to do with what they searched for.
   *
   * **The payload assertion is the whole of the proof, and the two tiles are not.** The mock
   * answers `[BOLT, BOLT_2ED]` whatever it is asked, so `toHaveLength(2)` says the wall draws two
   * rows when handed two rows — true of a collapsing page as well. It is kept because it is what
   * a reader sees and it fences the wall against dropping a row for some unrelated reason; the
   * claim about *collapse* rests on `collapse` being absent from the request. A test that made
   * the two independent would need the mock to fold its own rows, which is the backend's job and
   * `search.rs`' subject.
   */
  it("does not collapse printings, so each tagged illustration is its own row", async () => {
    searchCards.mockResolvedValue(page([BOLT, BOLT_2ED]));
    wrap(<TagsPage />);

    expect(await screen.findAllByRole("button", { name: "Lightning Bolt" })).toHaveLength(2);
    // Absent rather than `false`: uncollapsed is the backend's own default, and sending it would
    // make the payload lie about intent.
    expect(lastRequest().collapse).toBeUndefined();
  });

  /** A view mode and not a lock: a reader narrowed to an oracle tag is asking "which cards do
   *  this", and one row per card is the right answer to that. */
  it("collapses again when the reader presses All printings", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    // A view mode, and it lives in the filter row's tray with the other five since the row was
    // redesigned — only the box, the colours, the mana values and the sort stay on the bar.
    await user.click(screen.getByRole("button", { name: /^Show filters/ }));
    await user.click(screen.getByRole("button", { name: "All printings" }));

    await waitFor(() => expect(lastRequest().collapse).toBe(true));
  });

  it("opens the clicked tile's card", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);

    await user.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("c-bolt-lea");
  });

  it("badges what the reader owns and wants, and crowns a game changer", async () => {
    searchCards.mockResolvedValue(
      page([{ ...BOLT, ownedQuantity: 2, wishlisted: true, gameChanger: true }]),
    );
    wrap(<TagsPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });
    const tile = art.parentElement?.parentElement as HTMLElement;

    // The badge's words rather than its glyph: the whole art overlay is `aria-hidden` — a
    // chip inside the tile's button would otherwise join the button's accessible name — so what
    // a reader is *told* lives in the caption beside it and in the badge's own text.
    expect(within(tile).getByText("2 in your collection")).toBeInTheDocument();
    expect(within(tile).getByText("On your wishlist")).toBeInTheDocument();
    expect(
      within(tile).getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).toBeInTheDocument();
    expect(within(tile).getByText(`, ${GAME_CHANGER_LABEL}`)).toHaveClass("sr-only");
  });

  /**
   * **The chin's money slot, from the same helper the table beside it uses.**
   *
   * `priceRange` — the spread across the printings a row stands for — so this wall and the Tags
   * table are two drawings of one search that cannot quote different money.
   *
   * Uncollapsed (which is this page's default and the thing it is built on), nearly every row is
   * one printing and both ends carry the same figure, which `priceRange` collapses to a single
   * price. So the fixture widens them: on an equal-ended row a chin built from `card.priceLow`
   * alone is indistinguishable from a correct one, and this is the only shape that tells them
   * apart. The reader can press All printings back off, at which point every row here is a
   * genuine span.
   */
  it("quotes the spread across the printings a tile stands for", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, priceLow: 0.45, priceHigh: 88 }]));
    wrap(<TagsPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tile = art.parentElement?.parentElement as HTMLElement;
    expect(within(tile).getByText("$0.45–$88.00")).toBeInTheDocument();
  });

  /**
   * **Spec §5: a price is never shown without saying how old it is** — said once under the wall,
   * now that its chins quote money.
   *
   * Through `pricesAsOf` rather than the sentence typed out here: spelling it would pin a copy of
   * the wording rather than the function, so a reworded sentence would fail here while a wall
   * drawing a stale one passed. The count is what makes it a claim about *this* wall — the table
   * says the same thing in its Price column header, so a line drawn in both views would show up
   * as two.
   */
  it("says how old the wall's prices are, once, under the grid", async () => {
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    expect(screen.getAllByText(pricesAsOf(MARKETPLACES.tcgplayer))).toHaveLength(1);
  });

  /** The sheen the art cannot show: a printing that exists in one finish, and not the assumed
   *  one. `soleFinish`'s job, wired through the wall's `finish` callback. */
  it("marks a foil-only printing", async () => {
    searchCards.mockResolvedValue(page([{ ...BOLT, finishes: `["foil"]` }]));
    wrap(<TagsPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tile = art.parentElement?.parentElement as HTMLElement;
    // **The glyph twice, the word once**, and the two halves are asserted apart because they are
    // reached differently. The chip over the picture is inside the `aria-hidden` overlay, so it
    // takes `hidden: true` and is scoped to the art button it lives in — it is decoration.
    expect(within(art).getByRole("img", { name: "Foil", hidden: true })).toBeInTheDocument();
    // And `CardChin`'s own `FinishMark` in the foot, which is a sibling of that button and is
    // therefore **in** the accessibility tree — no `hidden`, and exactly one of it. This is what
    // a screen reader hears, and it is why the tile no longer appends an `sr-only` `, Foil` of
    // its own: the mark's `aria-label` is that same word, so the span said it a second time.
    expect(within(tile).getAllByRole("img", { name: "Foil" })).toHaveLength(1);
    expect(within(tile).queryByText(", Foil")).toBeNull();
  });

  it("adds a copy to the collection from a tile, without opening the card", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await user.click(screen.getByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ }));
    expect(await screen.findByRole("dialog", { name: "Add Lightning Bolt" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to collection" }));

    await waitFor(() =>
      expect(collectionAdd).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: "c-bolt-lea", quantity: 1 }),
      ),
    );
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * The arrow keys walk the wall and the selection walks with them, which on this page means the
   * card pane really does move to the card the caret lands on. `arrowNav` is a **prop**, and
   * three of `CardGrid`'s callers deliberately do without it — so a wall can have the whole
   * mechanism and say nothing about it.
   *
   * One column, because jsdom measures the wall at 0px. `userEvent.keyboard` on a caret placed by
   * hand, never `type`, which focuses what it is handed and would pass for the wrong reason.
   */
  it("walks the wall with the arrow keys and moves the selection with it", async () => {
    searchCards.mockResolvedValue(page(cards(3)));
    wrap(<TagsPage />);

    const first = await screen.findByRole("button", { name: "Card 0" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(useAppStore.getState().selectedCardId).toBe("c1");
    expect(screen.getByRole("button", { name: "Card 1" })).toHaveFocus();
  });

  /**
   * The wall's own zoom section. A gesture here must not resize the search view's wall — that is
   * the whole reason `ZOOM_SECTIONS` is a list rather than one number — so the other sections are
   * swept rather than named, and a seventh added later is covered the day it exists.
   */
  it("steps only the tags section on a ctrl+wheel over the wall", async () => {
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    fireEvent.wheel(screen.getByRole("group", { name: "Tag results" }), {
      ctrlKey: true,
      deltaY: -240,
    });

    const { cardZoom, zoomSection } = useAppStore.getState();
    expect(cardZoom.tags).toBe(1.1);
    for (const section of ZOOM_SECTIONS.filter((s) => s !== "tags")) {
      expect(cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
    expect(zoomSection).toBe("tags");
  });

  /** A wall of empty frames is what a reader browsing by motif came *not* to see. */
  it("warms the front faces of the page that just landed, at the wall's own size", async () => {
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await waitFor(() =>
      expect(prefetchImages).toHaveBeenCalledWith(["c-bolt-lea"], WALL_CARD_VARIANT),
    );
  });

  /**
   * The assertion above is through the constant, so it cannot see the failure that actually
   * matters — and this page is the proof that it happens. `TagResults` was written as a copy of
   * `SearchPage`'s twin with a `"grid"` literal in it, and it kept that literal across the merge
   * that moved every wall to {@link WALL_CARD_VARIANT}: the pre-warm would have reported every
   * card warmed and then every tile would have fetched cold, exactly as the deck arm did until
   * 2026-08-11 (`images::DECK_PREWARM`).
   *
   * So this reads the variant back out of a **mounted tile's `src`** and holds the prefetch to
   * it. Nothing here names a size; the two sites simply have to agree.
   */
  it("warms the same size the tiles actually draw", async () => {
    wrap(<TagsPage />);

    const tile = await screen.findByRole("img", { name: "Lightning Bolt" });
    // Read against the id and face the URL ends with rather than by parsing it: `mtgimg:` is a
    // custom scheme, and what this needs is the one segment in front of `/<id>/<face>`.
    const drawn = /\/([a-z]+)\/c-bolt-lea\/0$/.exec(tile.getAttribute("src") ?? "")?.[1];

    expect(drawn).toBeDefined();
    await waitFor(() => expect(prefetchImages).toHaveBeenCalledWith(["c-bolt-lea"], drawn));
  });

  it("does not warm anything for the table, which shows no art", async () => {
    useAppStore.setState({ tagsView: "table" });
    wrap(<TagsPage />);
    await screen.findByRole("row", { name: /Lightning Bolt/ });

    expect(prefetchImages).not.toHaveBeenCalled();
  });
});

describe("the layout toggle", () => {
  /**
   * The Tags page keeps its own layout preference. Bound to the search's, the pair here would
   * silently re-lay-out a page the reader is not on and change nothing they can see — the
   * "control that lies" the deck panel's `layoutToggle={false}` exists to avoid, read from the
   * other end.
   */
  it("moves the Tags page's own preference and leaves the search's alone", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await user.click(screen.getByRole("button", { name: "Table view" }));

    expect(useAppStore.getState().tagsView).toBe("table");
    expect(useAppStore.getState().searchView).toBe("grid");
    expect(await screen.findByRole("row", { name: /Lightning Bolt/ })).toBeInTheDocument();
  });
});

describe("the table", () => {
  beforeEach(() => useAppStore.setState({ tagsView: "table" }));

  it("names itself, and prices in the selected marketplace's currency", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    searchCards.mockResolvedValue(
      page([{ ...BOLT, price: 12.5, priceLow: 12.5, priceHigh: 12.5 }]),
    );
    wrap(<TagsPage />);

    expect(await screen.findByRole("table", { name: "Tag results" })).toBeInTheDocument();
    expect(await screen.findByText("€12.50")).toBeInTheDocument();
    await waitFor(() => expect(lastRequest().marketplace).toBe("cardmarket"));
  });

  it("asks the backend for the column a pressed header names", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await screen.findByRole("row", { name: /Lightning Bolt/ });

    await user.click(screen.getByRole("button", { name: /^Rarity/ }));

    await waitFor(() => expect(lastRequest().sort).toEqual([{ key: "rarity", dir: "asc" }]));
  });

  it("opens the card from a row, and keeps the tag terms while it sorts", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));
    await screen.findByRole("row", { name: /Lightning Bolt/ });

    await user.click(screen.getByRole("button", { name: /^Name/ }));
    await waitFor(() => expect(lastRequest().sort).toEqual([{ key: "name", dir: "asc" }]));
    expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] });

    await user.click(screen.getByRole("row", { name: /Lightning Bolt/ }));
    expect(useAppStore.getState().selectedCardId).toBe("c-bolt-lea");
  });
});

describe("the card menu", () => {
  it("opens on a right-click of a tile, without opening the card", async () => {
    wrap(<TagsPage />);

    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /** A menu only a mouse can open is a menu half this app's readers do not have. */
  it("opens the same menu on Shift+F10", async () => {
    wrap(<TagsPage />);

    fireEvent.keyDown(await screen.findByRole("button", { name: "Lightning Bolt" }), {
      key: "F10",
      shiftKey: true,
    });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  it("opens on the ContextMenu key too", async () => {
    wrap(<TagsPage />);

    fireEvent.keyDown(await screen.findByRole("button", { name: "Lightning Bolt" }), {
      key: "ContextMenu",
    });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("is about the tile it was opened on, and names no finish", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    rightClick(await screen.findByRole("button", { name: "Lightning Bolt" }));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /Add to/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Wishlist" }));

    // No `preferredFinish`: a result row is a printing rather than a copy, and the reader has not
    // said which finish they hold.
    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith({
        cardId: "c-bolt-lea",
        quantity: 1,
        preferredFinish: undefined,
        // The root wishlist. Written out because the menu always sends one: a wishlist with no
        // folders draws the single row this press used, and that row's destination is `null`
        // rather than an omitted field.
        folderId: null,
      }),
    );
  });

  it("opens from the mouse and the keyboard on a table row", async () => {
    useAppStore.setState({ tagsView: "table" });
    wrap(<TagsPage />);
    const row = await screen.findByRole("row", { name: /Lightning Bolt/ });

    rightClick(row);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    // The row's own handler is not replaced by the menu's: Enter still opens the card.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });
});

describe("dragging a tile", () => {
  /**
   * The tile, **with a box**: jsdom has no layout engine, so every `getBoundingClientRect` is
   * four zeroes and dnd-kit hit-tests by coordinate — a source with no box is pressed at the
   * origin and travels nowhere. The wall sits at the top and every drop target below it.
   */
  const boxedTile = (container: HTMLElement) =>
    boxed(container.querySelector<HTMLElement>(`[${DND_SOURCE_ATTR}]`)!, 0);

  /** A sidebar entry, boxed clear of the wall above it, so a drop really arrives somewhere
   *  else. */
  const boxedEntry = (name: string) => boxed(screen.getByRole("button", { name }), 300, 40);

  it("carries the printing the tile draws", async () => {
    const { container } = wrap(<TagsPage />);
    const art = await screen.findByRole("button", { name: "Lightning Bolt" });

    const tiles = [...container.querySelectorAll<HTMLElement>(`[${DND_SOURCE_ATTR}]`)];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContainElement(art);

    const drags = recordDrags();
    const held = await startPointerDrag(boxed(tiles[0], 0));
    // Asked while the drag is still up: `started` is a live reading of the manager's operation
    // rather than a remembered one, so after a cancel it is false for every drag there has been.
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map(readDragData)).toEqual([
      { kind: "card", cardId: "c-bolt-lea", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  /**
   * The whole wire, and the only place it can be seen: the sidebar is the one drop target a card
   * found on this page can reach, and it lives in the shell rather than in the view. A payload
   * assertion alone would pass for a wall whose tiles the sidebar refuses.
   */
  it("wishes for a tile dropped on the sidebar's Wishlist entry", async () => {
    const { container } = wrapInShell(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    const held = await startPointerDrag(boxedTile(container));
    await held.over(boxedEntry("Wishlist"));
    await held.drop();

    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "c-bolt-lea", quantity: 1 }),
    );
  });

  it("adds a tile dropped on the sidebar's Decks entry to the open deck", async () => {
    useAppStore.setState({ openDeckId: 7 });
    queryClient.setQueryData(["decks", "detail", 7], { deck: { id: 7, name: "Burn" }, cards: [] });
    deckAddCard.mockResolvedValue({ id: 1, quantity: 1 });
    const { container } = wrapInShell(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });
    const tile = boxedTile(container);

    // **The guard for the `queryClient.clear()` above, and it is not ceremony.** These two
    // tests share the app's module-level client at a 30 s `staleTime`, so without that clear
    // this one reads the previous test's cached page and never calls the backend at all —
    // measured, not assumed. It passes either way while both fixtures are the same card, which
    // is exactly the kind of test that stops meaning anything without anyone noticing.
    expect(searchCards).toHaveBeenCalled();
    const held = await startPointerDrag(tile);
    await held.over(boxedEntry("Decks"));
    await held.drop();

    // Filed by what the card does — no category id, because a nav item several views away from
    // the deck has no column the reader can have pointed at.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "c-bolt-lea", null, "Instant", "live", null, 1),
    );
  });
});

describe("the filter bar over a picked tag", () => {
  it("narrows by colour without dropping the tag terms", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));
    await waitFor(() => expect(lastRequest().artTags).toBeDefined());

    await user.click(screen.getByRole("button", { name: "Green" }));

    await waitFor(() => expect(lastRequest().colors).toBe("G"));
    expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] });
  });

  /**
   * Reset all clears what it captions and nothing else. The chips are not on that row — they are
   * the page's own filter, with their own × on each — so a press must leave them exactly where
   * they were rather than silently emptying the wall's whole subject.
   */
  it("leaves the picked tags alone when Reset all is pressed", async () => {
    const user = userEvent.setup();
    wrap(<TagsPage />);
    await user.click(await railRow("Landscape"));
    await user.click(screen.getByRole("button", { name: "Green" }));
    await waitFor(() => expect(lastRequest().colors).toBe("G"));

    await user.click(screen.getByRole("button", { name: /^Reset all/ }));

    await waitFor(() => expect(lastRequest().colors).toBeUndefined());
    expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] });
  });

  /** Driven through the table, which is the layout jsdom can be given a height for — the
   *  virtualiser sizes its scroller with `offsetHeight` and lays nothing else out. */
  it("keeps paging through a tag's cards", async () => {
    viewportHeight = 2400;
    useAppStore.setState({ tagsView: "table" });
    searchCards.mockResolvedValueOnce(page(cards(50), 120));
    searchCards.mockResolvedValue(page(cards(50, 50), 120));
    wrap(<TagsPage />);

    await waitFor(() => expect(searchCards).toHaveBeenCalledTimes(2));
    expect(searchCards.mock.calls[1][0]).toMatchObject({ offset: 50, limit: 50 });
  });
});

describe("what the summary says", () => {
  /**
   * `summaryOf` is imported from `SearchPage` rather than rewritten, and this is the sentence a
   * second copy would have got wrong: an unfiltered browse's empty answer is a statement about
   * the *database*, not about the query.
   */
  it("blames the empty database, not the query, when nothing has been synced", async () => {
    searchCards.mockResolvedValue(page([]));
    wrap(<TagsPage />);

    expect(
      await screen.findByText(/Card database is empty — waiting for the first sync/),
    ).toBeInTheDocument();
  });

  /** And the other half: a picked tag **is** the reader asking, even though no control on the
   *  filter row can set one. */
  it("says the motif matched nothing once a tag is picked", async () => {
    const user = userEvent.setup();
    searchCards.mockResolvedValue(page([]));
    wrap(<TagsPage />);

    await user.click(await railRow("Landscape"));

    expect(await screen.findByText("No cards match these filters.")).toBeInTheDocument();
  });

  it("counts the matches", async () => {
    searchCards.mockResolvedValue(page([BOLT], 5000, true));
    wrap(<TagsPage />);

    expect(await screen.findByText("5,000+ cards")).toBeInTheDocument();
  });
});

describe("a taxonomy this machine has never downloaded", () => {
  /**
   * **Not a failure, and it must not read as one.** It is what every install is on its first
   * launch and what a machine that cannot reach Scryfall stays in permanently — `art_tags_status`
   * resolves with every field null, `tag_search` and `tag_children` answer nothing for `art` and
   * still answer for `oracle`, and a wall filtered by an art tag comes back empty rather than
   * refusing. The page's job is to say which file is missing, because otherwise a reader typing a
   * motif into a rail with only oracle tags in it blames their spelling.
   */
  it("says so when the art taxonomy has never been ingested", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([REMOVAL]);
    wrap(<TagsPage />);

    expect(await screen.findByText(/art tags have not been downloaded/i)).toBeInTheDocument();
    // The oracle half still works, which is what makes the sentence about *art* rather than
    // about tags.
    expect(await railRow("Removal")).toBeInTheDocument();
    expect(screen.queryByText(/oracle tags have not been downloaded/i)).not.toBeInTheDocument();
  });

  it("names each missing taxonomy on its own, and both when both are missing", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    oracleTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([]);
    wrap(<TagsPage />);

    expect(await screen.findByText(/art tags have not been downloaded/i)).toBeInTheDocument();
    expect(await screen.findByText(/oracle tags have not been downloaded/i)).toBeInTheDocument();
    // Direction rather than mood: there is no button for this anywhere in the app.
    expect(screen.getByText(/fetches them in the background/i)).toBeInTheDocument();
  });

  /**
   * **The half that shipped broken and is the reason for the art hook.**
   *
   * `AppShell` mounts `useOracleTagProgress`, so the *oracle* sentence takes itself down when
   * that taxonomy lands. Nothing mounted an art twin, so on the exact cold first run this notice
   * exists for, the sentence about the page's **primary** taxonomy sat there until a window
   * refocus — healed by a 30 s `staleTime` rather than by the thing that finished.
   */
  it("takes the art sentence down by itself when the ingest finishes", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([REMOVAL]);
    wrap(<TagsPage />);
    await screen.findByText(/art tags have not been downloaded/i);

    // The ingest lands. The page hears it on `art-tags:progress` — the channel `lib.rs`'s
    // startup refresh emits on — and re-reads a taxonomy that is now there.
    artTagsStatus.mockResolvedValue(INGESTED);
    tagChildren.mockResolvedValue([LANDSCAPE, REMOVAL]);
    act(() => artProgress?.({ phase: "done", done: 1, total: 1 }));

    await waitFor(() =>
      expect(screen.queryByText(/art tags have not been downloaded/i)).not.toBeInTheDocument(),
    );
    // And the rail with it: healing the sentence while leaving the rail empty for the client's
    // whole 30 s `staleTime` would be the more visible half left undone.
    expect(await railRow("Landscape")).toBeInTheDocument();
  });

  /** A failed refresh leaves the taxonomy exactly where it was, so there is nothing new to read
   *  — but `refreshing` is still true on the status this window last saw, and only a refetch
   *  takes it down. Both terminal phases, not just `done`. */
  it("re-reads on a failed refresh too, which is what clears a stuck `refreshing`", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([REMOVAL]);
    wrap(<TagsPage />);
    await screen.findByText(/art tags have not been downloaded/i);
    const readsBefore = artTagsStatus.mock.calls.length;

    act(() => artProgress?.({ phase: "error", done: 0, total: 0 }));

    await waitFor(() => expect(artTagsStatus.mock.calls.length).toBeGreaterThan(readsBefore));
    // The taxonomy really is still absent, so the sentence stays. It is the *read* that was owed.
    expect(screen.getByText(/art tags have not been downloaded/i)).toBeInTheDocument();
  });

  it("says nothing at all when both taxonomies are in", async () => {
    wrap(<TagsPage />);
    await railRow("Landscape");

    expect(screen.queryByText(/have not been downloaded/i)).not.toBeInTheDocument();
  });

  /** A read that has not landed says nothing rather than flashing the notice onto a page that
   *  has every tag — `data` is `undefined` until it answers, and neither command refuses. */
  it("waits for the read rather than assuming the worst", () => {
    artTagsStatus.mockReturnValue(new Promise(() => {}));
    oracleTagsStatus.mockReturnValue(new Promise(() => {}));
    wrap(<TagsPage />);

    expect(screen.queryByText(/have not been downloaded/i)).not.toBeInTheDocument();
  });
});

describe("the walk it publishes for the printings modal", () => {
  it("publishes these results in their drawn order, and says which list they are", async () => {
    searchCards.mockResolvedValue(page([BOLT, BOLT_2ED]));
    wrap(<TagsPage />);
    await screen.findAllByRole("button", { name: "Lightning Bolt" });

    const walk = useAppStore.getState().cardWalk;
    expect(walk.label).toBe("these tag results");
    expect(walk.stops.map((s) => s.cardId)).toEqual(["c-bolt-lea", "c-bolt-2ed"]);
  });

  it("clears the walk when the page goes", async () => {
    const { unmount } = wrap(<TagsPage />);
    await screen.findByRole("button", { name: "Lightning Bolt" });

    unmount();

    expect(useAppStore.getState().cardWalk.stops).toEqual([]);
  });
});
