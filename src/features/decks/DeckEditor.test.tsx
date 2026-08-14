import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type {
  CardSummary,
  CategoryKind,
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  DeckTag,
  FormatSpec,
  ImportMatch,
  SyncStatus,
} from "@/lib/ipc";
import { dragOnto, startDrag } from "@/test-drag";
import { DECK_CARD_VARIANT } from "./cardControl";
import { card, resetRowIds, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
// Not a card write: the tab, the `Group by` and the `Sort` the reader leaves the deck on.
const deckSetViewState = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
// The docked search panel is the editor's own filter bar, set picker and result wall — and the
// toolbar's quick add resolves a typed name through the same command.
const searchCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
// The five consulted overlays' own reads — categories, tags, history, the theory difference and
// deck settings. Each is unmounted while closed, so these answer only for the tests that open
// one — but the whole `ipc` object is replaced here, so a command left out is a `TypeError`
// rather than a missing answer.
const deckCategoryList = vi.hoisted(() => vi.fn());
const deckTagList = vi.hoisted(() => vi.fn());
const deckTagSuggestions = vi.hoisted(() => vi.fn());
const deckAuditList = vi.hoisted(() => vi.fn());
const deckTheoryDiff = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
// The import dialog's three commands, and the sync it reads to tell "your list is wrong" from
// "the card database is not filled in yet".
const deckImportResolve = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
const deckImportReadFile = vi.hoisted(() => vi.fn());
const syncStatus = vi.hoisted(() => vi.fn());
// The editor warms the `art` its own views draw — the variant the deck builder renders, and
// a different URL on the CDN from the `grid` the search wall warms. Fire-and-forget, so the
// stub only has to resolve; what it is *called with* is asserted in its own test below.
const prefetchImages = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    prefetchImages,
    deckGet,
    deckUpdate,
    deckSetCardQuantity,
    deckMoveCard,
    deckAddCard,
    deckMissingToWishlist,
    deckSwapPrinting,
    deckSetViewState,
    formatSpecs,
    searchCards,
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
    deckTagList,
    deckTagSuggestions,
    deckAuditList,
    deckTheoryDiff,
    deckFolderList,
    deckImportResolve,
    deckImportCommit,
    deckImportReadFile,
    syncStatus,
  },
}));

import { DeckEditor } from "./DeckEditor";
import { useAppStore } from "@/lib/store";

const DECK: DeckRow = {
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: null,
  coverArtist: null,
  isBuilt: false,
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
  tags: DeckTag[] = [],
): DeckDetail {
  return { deck: { ...DECK, ...deck }, cards, categories, tags };
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

/** The one printing `deck_import_resolve` answers with here — everything the plan does not
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

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
  const toggle = await screen.findByRole("button", { name: "Search cards" });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  return screen.findByRole("searchbox", { name: "Search cards" });
}

/** A group, by the heading it draws. Every view labels its section with the group's name and
 *  nothing else — the count and the price are text beside it, not part of what it is called. */
const group = (name: string) => screen.getByRole("region", { name });

/**
 * Wait until `format_specs` has answered.
 *
 * The seed is a query, so on the first deck of a session the editor mounts before it lands and
 * the docked panel's format default is `null` for a render or two — which looks exactly like a
 * deck the fence deliberately left unfiltered. Anything asserting on that default has to be past
 * this line or it is testing a query in flight.
 *
 * **The sentinel has to be a `PICKER` format the deck under test is _not_ on**: `pickerFormats`
 * folds a deck's own format into the header's list whether or not anything has loaded, so that
 * option is there from the first paint and waiting for it would gate on nothing. `Gladiator` is
 * the default because every deck fixture here is on something else; the one test whose deck *is*
 * Gladiator passes another of `PICKER`'s four.
 */
const seeded = (sentinel = "Gladiator") =>
  waitFor(() =>
    expect(
      within(screen.getByLabelText("Deck format")).getByRole("option", { name: sentinel }),
    ).toBeInTheDocument(),
  );

/** What the stepper on the fixture's Bolt is called. Named by the **slot** — the card and the
 *  pile — because the same printing sits in two categories often enough that a name without one
 *  would be two controls a screen reader cannot tell apart. */
const COPIES = "Copies of Lightning Bolt in Main deck";

/** The X toggle's whole accessible name, which `ToggleChip` also spends as its tooltip. Written
 *  out once because three tests address the control, and a regex over its two-word label alone
 *  would keep passing on the day the sentence went missing — which is the half of the name that
 *  has to stand up read out of context, with no Group by select beside it. */
const SPLIT_X =
  "Split X — give cards with X in their cost a group of their own, instead of counting X as zero";

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
  useAppStore.setState({ openDeckId: 4, selectedCardId: null, paneDeckContext: null });
  deckGet
    .mockReset()
    .mockResolvedValue(
      detail({}, [bolt(), card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 })]),
    );
  deckUpdate.mockReset().mockResolvedValue(DECK);
  deckSetCardQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 0, removed: true });
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  deckAddCard.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
  deckMissingToWishlist.mockReset().mockResolvedValue(3);
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  deckSetViewState.mockReset().mockResolvedValue(undefined);
  formatSpecs.mockReset().mockResolvedValue(PICKER);
  // Nothing found by default: a result named after a card already in the deck would be a
  // second button by that name, and every test here addresses cards by name.
  searchCards.mockReset().mockResolvedValue({ items: [], total: 0, totalIsCapped: false });
  listSets.mockReset().mockResolvedValue([]);
  deckCategoryList.mockReset().mockResolvedValue(CATEGORIES);
  deckTagList.mockReset().mockResolvedValue([]);
  deckTagSuggestions.mockReset().mockResolvedValue([]);
  deckAuditList.mockReset().mockResolvedValue([]);
  deckTheoryDiff.mockReset().mockResolvedValue([]);
  deckFolderList.mockReset().mockResolvedValue([]);
  // One printing, so a one-line paste has something to resolve to and the Import button is
  // live. What the plan makes of it is `plan.test.ts`'s and the dialog's own to prove.
  deckImportResolve
    .mockReset()
    .mockResolvedValue([{ index: 0, matched: SOL_RING, hintMissed: false }]);
  deckImportCommit.mockReset().mockResolvedValue({ added: 1, removed: 0, categoriesCreated: 0 });
  deckImportReadFile.mockReset().mockResolvedValue("");
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

  /** The header is the deck: what it is called, what it is for, and whether it is sleeved up. */
  it("heads the editor with the deck's name, format and build state", async () => {
    await open();

    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
    expect(screen.getByLabelText("Deck format")).toHaveValue("modern");
    const built = screen.getByRole("button", { name: /^Built/ });
    expect(built).toHaveAttribute("aria-pressed", "false");
    expect(built).toHaveAttribute("title", "Reserves your copies for this deck");
  });

  /**
   * **Alphabetically by display name, not in the `sortOrder` Rust answers in.** The seed ranks
   * the formats by how the game groups them and the mock keeps that ranking — Modern,
   * Commander, Gladiator, Casual — so the sequence below is the picker's own doing. A reader
   * changing a deck's format looks for Modern under M, not in seventh place.
   *
   * The whole sequence rather than one position: an ordering asserted a row at a time still
   * passes once somebody adds a format that lands in the wrong half of it.
   */
  it("offers the formats alphabetically, whatever order the table answered in", async () => {
    await open();

    const format = screen.getByLabelText("Deck format");
    expect(within(format).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Casual",
      "Commander",
      "Gladiator",
      "Modern",
    ]);
  });

  /**
   * A deck on a format the seed no longer offers still shows its own format — `decks.format_key`
   * is deliberately not a foreign key, so this state can exist, and a select that cannot show
   * its own value would silently re-format the deck on the first other change.
   *
   * **The row is folded into the alphabet rather than pinned first**: it is an option like any
   * other, and the select's own `value` is what marks it as the current one. Historic sits
   * between Gladiator and Modern here, which is the whole assertion — pinned, it would be
   * first, and the list would be telling the reader something the `value` already says.
   */
  it("folds a deck's own format into the list when the seed no longer offers it", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "historic", formatName: "Historic" }, [bolt()]));
    await open();

    const format = screen.getByLabelText("Deck format");
    expect(format).toHaveValue("historic");
    expect(within(format).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Casual",
      "Commander",
      "Gladiator",
      "Historic",
      "Modern",
    ]);
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
   *   pixels of "N cards differ" hit-tested to the format select.
   *
   * Reverting any one of the three brings the collapse back, so all three are asserted.
   */
  it("keeps the deck name from collapsing between the controls beside it", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    // A floor, and not `min-w-0` — the class Tailwind emits is the whole of the fix.
    expect(name.className).toContain("min-w-40");
    expect(name.className).not.toContain("min-w-0");
    // …and an intrinsic width small enough that the floor is the only floor.
    expect(name).toHaveAttribute("size", "1");

    const identity = name.parentElement!;
    expect(identity.className).toContain("flex-wrap");
    expect(identity.className).not.toContain("min-w-0");

    // The controls: shrinkable, so they fold rather than pushing the name out of the window.
    const controls = identity.parentElement!.lastElementChild!;
    expect(controls.className).toContain("flex-wrap");
    expect(controls.className).not.toContain("shrink-0");
  });

  /** The way back, and the only thing that closes the editor. */
  it("returns to the gallery from the back control", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /back to decks/i }));

    expect(useAppStore.getState().openDeckId).toBeNull();
  });

  /** There is no Save: the row in the database *is* the draft, so a name is committed the
   *  moment the reader is done with the field. */
  it("renames the deck when the name field is left", async () => {
    await open();

    const name = screen.getByLabelText("Deck name");
    await userEvent.clear(name);
    await userEvent.type(name, "Sunday burn");
    await userEvent.tab();

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunday burn" }));
  });

  it("renames the deck on Enter without waiting for the caret to leave", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.type(screen.getByLabelText("Deck name"), "Sunday burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { name: "Sunday burn" }));
  });

  /**
   * Enter commits and then blurs, and the blur handler commits too — in the same tick, off a
   * draft the first call had already decided to send. Two identical `deck_update`s for one
   * press, which the assertion above cannot see because it matches arguments rather than
   * counting calls.
   */
  it("writes one rename for one press of Enter", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.type(screen.getByLabelText("Deck name"), "Sunday burn{Enter}");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledTimes(1));
  });

  /** A blank name is not a rename — the backend refuses it in words, and the field should not
   *  have to be told twice. */
  it("keeps the old name when the field is emptied", async () => {
    await open();

    await userEvent.clear(screen.getByLabelText("Deck name"));
    await userEvent.tab();

    expect(deckUpdate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
  });

  it("re-formats the deck from the header select", async () => {
    await open();

    await userEvent.selectOptions(screen.getByLabelText("Deck format"), "commander");

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { formatKey: "commander" }));
  });

  /** Built is the one switch with a consequence outside this deck, so it says what it does. */
  it("marks the deck built", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { isBuilt: true }));
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
    const auto = category(6, "Ramp", "main", { origin: "auto" });
    const mine = category(7, "Draw", "main");
    deckGet.mockResolvedValue(detail({}, [bolt()], [...CATEGORIES, auto, mine]));

    await open();

    expect(screen.queryByRole("region", { name: "Ramp" })).not.toBeInTheDocument();
    expect(within(group("Draw")).getByText("0 cards")).toBeInTheDocument();
    // Every pile of the deck is still filable-into, drawn or not. The select lives in the docked
    // search panel, which opens collapsed, so the panel is opened to read it — the claim is that
    // it is built from `deck_category_list` and not from the drawn groups, which the disclosure
    // does not touch.
    await openSearchPanel();
    const addTo = within(screen.getByLabelText("Add to"));
    expect(addTo.getByRole("option", { name: "Ramp" })).toBeInTheDocument();
    expect(addTo.getByRole("option", { name: "Draw" })).toBeInTheDocument();
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
    // 2026-08-14, so the toolbar's "Add to" is what carries it now. It sits in the docked
    // search panel, which opens collapsed since the same day — so the panel is opened here to
    // read it. That the select is built from `deck_category_list` rather than from the drawn
    // groups is what the assertion is about, and the disclosure changes neither.
    await openSearchPanel();
    const addTo = within(screen.getByLabelText("Add to"));
    expect(addTo.getByRole("option", { name: "Sunday brew" })).toBeInTheDocument();
    // The auto pile too: its heading is gone from the desk and it is still a place to file a
    // card, which is the half that makes losing the heading survivable.
    expect(addTo.getByRole("option", { name: "Ramp" })).toBeInTheDocument();

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
   * Zero removes, and it is `deck_set_card_quantity` that does it — never a `−1` through
   * `deck_add_card`, which refuses the orphaned cards a reader most needs to be able to clear.
   */
  it("removes a card when its stepper reaches zero", async () => {
    deckGet
      .mockResolvedValueOnce(detail({}, [bolt({ quantity: 1 })]))
      .mockResolvedValue(detail({}, []));

    await open();
    await userEvent.click(screen.getByRole("button", { name: `Decrease ${COPIES}` }));

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", 0);
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

    expect(deckSetCardQuantity.mock.calls.map((c) => c[4])).toEqual([5, 6, 7]);
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
    deckSetCardQuantity.mockRejectedValue("The database is busy with a sync — try again.");
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
    await open();
    expect(screen.getByRole("list", { name: "Main deck" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Group by"), "type");
    expect(screen.getByRole("list", { name: "Instant" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Main deck" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Group by"), "manaValue");
    expect(screen.getByRole("list", { name: "Mana value 1" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Instant" })).not.toBeInTheDocument();
  });

  /**
   * The two toolbar pickers, alphabetically — the app-wide rule (`src/lib/options.ts`), applied
   * to lists that already happened to read that way.
   *
   * That coincidence is exactly why this is pinned: `GROUP_BY_OPTIONS` and `SORT_OPTIONS` are
   * written in the order that explains the modes, and the first entry appended to either would
   * land at the end of the dropdown with nothing to notice it. The sequences are asserted whole
   * so the *property* fails, not one position.
   */
  it("offers both toolbar pickers alphabetically", async () => {
    await open();

    const labels = (select: HTMLElement) =>
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent);

    expect(labels(screen.getByLabelText("Group by"))).toEqual([
      "Categories",
      "Mana value",
      "Type",
    ]);
    expect(labels(screen.getByLabelText("Sort"))).toEqual([
      "Alphabetical",
      "Mana cost",
      "Price",
      "Type",
    ]);
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
    await open();
    expect(screen.queryByRole("button", { name: SPLIT_X })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Group by"), "manaValue");
    expect(screen.getByRole("button", { name: SPLIT_X })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Group by"), "type");
    expect(screen.queryByRole("button", { name: SPLIT_X })).not.toBeInTheDocument();
  });

  /**
   * **The switch is the deck's, not the editor's** — `decks.separate_x_group`, written through
   * the same `update` the Built toggle writes.
   *
   * A `useState` here would look identical for one session and lose the reader's answer the
   * moment they closed the deck, which is the one thing a per-deck reading preference exists to
   * avoid. So the assertion is on the *write*: nothing about this control is local.
   */
  it("writes the X split onto the deck rather than holding it in the editor", async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Group by"), "manaValue");

    await userEvent.click(screen.getByRole("button", { name: SPLIT_X }));

    await waitFor(() => expect(deckUpdate).toHaveBeenCalledWith(4, { separateXGroup: true }));
  });

  /** And it is drawn from the deck the read answered with — a chip whose pressed state came from
   *  anywhere else would disagree with the columns beside it after any other window changed the
   *  deck. */
  it("draws the X split pressed for a deck that carries it", async () => {
    deckGet.mockResolvedValue(detail({ separateXGroup: true }, [bolt()]));

    await open();
    await userEvent.selectOptions(screen.getByLabelText("Group by"), "manaValue");

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
    await open();
    const names = () =>
      within(group("Main deck"))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));

    expect(names()[0]).toMatch(/^Bear/);

    await userEvent.selectOptions(screen.getByLabelText("Sort"), "price");

    // Dearest first, which is what a money column means everywhere else in this app.
    expect(names()[0]).toMatch(/^Lightning Bolt/);
  });

  /** One deck, four ways of looking at it. The switch says which, and every one of them draws
   *  the same headings from the same `CardGroup[]`. */
  it("draws the deck in whichever of the four views is chosen", async () => {
    await open();
    const press = (label: string) => userEvent.click(screen.getByRole("button", { name: label }));

    await press("Table");
    expect(screen.getByRole("table", { name: "This deck" })).toBeInTheDocument();

    await press("Text");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ }),
    ).toBeVisible();

    await press("Grid");
    expect(
      within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ }),
    ).toBeVisible();

    await press("Stacks");
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

  /** The deck's own labels, as filters. Nothing at all for a deck with no tags — an empty group
   *  with a name is a control that says there is something to press. */
  it("offers no tag filter to a deck with no tags", async () => {
    await open();

    expect(screen.queryByRole("group", { name: "Filter by tag" })).not.toBeInTheDocument();
  });

  it("filters by tag", async () => {
    deckGet.mockResolvedValue(
      detail(
        {},
        [bolt({ tagId: 7, tagName: "Wincon", tagColor: "gold" }), card({ name: "Bear" })],
        CATEGORIES,
        [{ id: 7, deckId: 4, name: "Wincon", color: "gold", cardCount: 4 }],
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
    expect(within(stats).getByText("Cards").nextElementSibling).toHaveTextContent("6");
    expect(
      within(within(stats).getByRole("list", { name: "Mana curve" })).getByText(
        "6 cards at mana value 1",
      ),
    ).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Stats" })).not.toBeInTheDocument();
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
    expect(
      asOf.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    });
  });

  /**
   * The other card surface in this view, and the one that must *not* leave a deck context: a
   * tile in the docked panel is a card the deck does not have, so the pane it opens has no slot
   * to offer to rewrite. It goes through `setSelectedCardId`, which clears the context in the
   * same write — the property this asserts is the store's, and this is where it can be seen
   * happening between two surfaces one screen apart.
   */
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
      expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", null, "Creature", "live", 1),
    );
    // Cleared on a hit, because the next action is the next card.
    expect(screen.getByLabelText("Quick add a card")).toHaveValue("");
  });

  /**
   * …and an explicit "Add to" overrides the rule, which is the other half of it: a reader filing
   * ten cards into the Sideboard makes one choice and then ten presses, and every press sends
   * the **id** with no name at all.
   */
  it("sends the picked category instead when the reader named one", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await openSearchPanel();
    await userEvent.selectOptions(await screen.findByLabelText("Add to"), String(SIDE));
    await userEvent.type(
      screen.getByLabelText("Quick add a card to Sideboard"),
      "goblin guide{Enter}",
    );

    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", SIDE, null, "live", 1),
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
   * because that is where the card detail pane listens.
   *
   * React's synthetic `stopPropagation` stops the *native* event at the root container — so a
   * cell that stops `keydown` to keep Enter off its row also stops every Escape pressed inside
   * it from ever leaving the app's own tree. The pane then cannot be closed from a card or a
   * toolbar field at all, and nothing on screen says why.
   */
  it("lets Escape through to the card pane when no layer of its own is open", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    screen.getByRole("button", { name: /^Lightning Bolt/ }).focus();
    await userEvent.keyboard("{Escape}");
    screen.getByLabelText("Quick add a card").focus();
    await userEvent.keyboard("{Escape}");
    // The name field is the third way in, and the one that *does* consume a press — but only
    // while it is holding something to revert.
    screen.getByLabelText("Deck name").focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    // Heard every time, and consumed by nothing: the pane's bubble-phase listener acts on
    // exactly this.
    expect(heard).toEqual([false, false, false]);
  });

  /**
   * The other side of it: a field that has been typed in owns one press, and one only. The
   * second is the pane's again — otherwise a reader who half-typed a name and pressed Escape
   * twice would find the second press had gone nowhere, with the pane still open beside them
   * and nothing on screen to say why.
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
    const second = fireEvent.keyDown(name, { key: "Escape" });

    expect([first, second]).toEqual([false, true]);
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

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", null, "Creature", "live", 1);
  });

  /** Every category the deck has, in the order the groups are drawn — one list, one source —
   *  behind the one option that is not a category and is the default. */
  it("offers auto first, then every category, as add targets", async () => {
    await open();
    await openSearchPanel();

    const select = (await screen.findByLabelText("Add to")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Auto (by what it does)",
      "Main deck",
      "Sideboard",
      // Modern requires no commander, and the group and the option are here anyway: a category
      // is data the user made, not a slot the format implies.
      "Commander",
      "Companion",
      "Maybeboard",
    ]);
    // The default, and the whole of the fix: it used to be `categories[0]`, which on a deck with
    // no user category of its own is the seeded **Commander** pile.
    expect(select.value).toBe("0");
  });

  /**
   * A category can leave the deck under an open editor — deleted from another window, or
   * renamed away — and a select left holding an id that is not among its own options shows
   * nothing selected while every press files a card into a group nothing is drawing.
   *
   * The fallback is **auto** rather than another category: the reader's choice is gone, so the
   * honest replacement is "nobody has said", not somebody else's first column. It used to be
   * `categories[0]`, which was also what the initial state fell through — see the select's
   * default above.
   */
  it("falls back to auto when the category it was holding leaves the deck", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await openSearchPanel();
    await userEvent.selectOptions(await screen.findByLabelText("Add to"), String(SIDE));
    await screen.findByRole("button", { name: "Add Goblin Guide to Sideboard" });

    // The same deck, one category short — and it is the one the picker is pointed at.
    deckGet.mockResolvedValue(
      detail(
        {},
        [],
        CATEGORIES.filter((c) => c.id !== SIDE),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

    // Read off the Add button rather than off the select, because the select cannot see this
    // bug: HTML selects the first option when the selected one is removed, so the control
    // *shows* the first option whatever the state behind it says. Without the reset, every press
    // would still file its card into a category the editor is no longer drawing — and now that
    // the first option *is* auto, reading the select would pass even with the reset deleted.
    expect(
      await screen.findByRole("button", { name: "Add Goblin Guide to Creature" }),
    ).toBeInTheDocument();
  });

  /**
   * The editor draws **two** format controls and they ask different questions about the same
   * word: the header's `Deck format` says what the deck *is* and writes it, and the panel's
   * `Format` narrows what the search *offers* and writes nothing. Both are read in each of the
   * three tests below, so a rename that collapsed the two names into one fails here rather than
   * passing by matching whichever control the query happened to reach first.
   */
  it("opens the docked panel's format filter on the deck's own format", async () => {
    await open();
    // The panel comes up collapsed (2026-08-14) and the filter row is inside `OpenPanel`, so
    // there is no Format select to read until the disclosure is pressed. The seed is applied
    // when the search mounts, which is that press — so "opens on" is literally what this
    // asserts rather than a state the editor arranged in advance.
    await openSearchPanel();
    await seeded();

    expect(screen.getByLabelText("Format")).toHaveValue("modern");
    expect(screen.getByLabelText("Deck format")).toHaveValue("modern");
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
    await openSearchPanel();
    await seeded();

    expect(screen.getByLabelText("Format")).toHaveValue("");
    expect(screen.getByLabelText("Deck format")).toHaveValue("casual");
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
   */
  it("opens on Any format for a deck whose format the seed does not carry", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "historic", formatName: "Historic" }, [bolt()]));
    await open();
    await openSearchPanel();
    await seeded();

    expect(screen.getByLabelText("Format")).toHaveValue("");
    expect(screen.getByLabelText("Deck format")).toHaveValue("historic");
  });

  /**
   * **A format the filter row's own list has never carried, driven the whole way** — editor to
   * panel to `FilterBar`. `gladiator` is a seeded `format_specs` row with legality data behind
   * it and is not one of `FORMATS`' seven, which is the ordinary case for a deck: the deck picker
   * offers every enabled row and this filter offers seven keys.
   *
   * So the select can only read `Gladiator` because the hook folded the default into its own
   * option list. Without that the value would match no option, React would select the first row
   * that is not disabled, and the panel would say `Any format` over a wall already narrowed to
   * Gladiator. Both assertions are made for that reason: `value` reads back `""` under the bug
   * and the option's text is the whole of what the reader sees.
   *
   * The sentinel is `Commander` here rather than the helper's `Gladiator`, because this deck's
   * own format is folded into the header's list before the seed lands.
   */
  it("draws a deck format the filter row's own list has never carried", async () => {
    deckGet.mockResolvedValue(
      detail({ formatKey: "gladiator", formatName: "Gladiator" }, [bolt()]),
    );
    await open();
    // The filter row lives in `OpenPanel`, which mounts on the disclosure press (2026-08-14).
    await openSearchPanel();
    await seeded("Commander");

    const filter = screen.getByLabelText("Format") as HTMLSelectElement;
    expect(filter).toHaveValue("gladiator");
    expect(filter.selectedOptions[0]).toHaveTextContent("Gladiator");
    expect(screen.getByLabelText("Deck format")).toHaveValue("gladiator");
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
   */
  it("falls back to the rail when the deck and the panel cannot both fit", async () => {
    const restore = desk(376);
    try {
      await open();

      const rail = await screen.findByRole("button", { name: "Search cards" });
      expect(rail).toHaveAttribute("aria-expanded", "false");
      // Not a control that records an intention and moves nothing: there is no width for what
      // it would open, and it says so rather than doing nothing.
      expect(rail).toHaveAttribute("aria-disabled", "true");
      expect(rail).toHaveAttribute("title", expect.stringMatching(/not enough room/i));
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
      // **And pressing it really is refused**, which is the half of this that a shut-by-default
      // panel would otherwise be answering for: `aria-expanded="false"` is now true of a panel
      // nobody has opened yet as well as of one there is no room for, so the refusal has to be
      // demonstrated rather than read off the flag.
      await userEvent.click(rail);
      expect(rail).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("draws the panel at the width where the deck still clears its floor", async () => {
    const restore = desk(414);
    try {
      await open();

      expect(await openSearchPanel()).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search cards" })).not.toHaveAttribute(
        "aria-disabled",
      );
      // Squeezed to its minimum rather than drawn at the 384 it opens with, which is what
      // leaves the deck exactly its 192: 414 − 16 − 206.
      expect(screen.getByRole("region", { name: "Add cards" })).toHaveStyle({ width: "206px" });
    } finally {
      restore();
    }
  });

  /** And one pixel under it is the rail — the floor is a number, not a feeling. */
  it("gives way one pixel below that", async () => {
    const restore = desk(413);
    try {
      await open();

      expect(await screen.findByRole("button", { name: "Search cards" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
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
   * box belongs to the card pane, which listens on `window` in the bubble phase. A panel that
   * consumed the press would leave a card pinned open with nothing to close it.
   */
  it("lets Escape through from the docked search panel", async () => {
    await open();
    await openSearchPanel();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    screen.getByRole("searchbox", { name: "Search cards" }).focus();
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([false]);
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

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));

    expect(
      screen.getByText("Modern decks need at least 60 cards; you have 6."),
    ).toBeInTheDocument();
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
   * Each of the five toolbar buttons opens its own full-window dialog, and Escape closes the
   * one that is up and hands the caret back to the control that opened it — the editor stays a
   * *view*, so the deck is still on screen afterwards.
   *
   * **Five, because Categories & tags became two.** The piles and the labels were two sections
   * of one right-hand drawer; a sweep that went on listing four surfaces while the editor grew
   * a fifth would be the failure this file's counts exist to prevent.
   */
  it.each([
    ["Import cards", "Import a decklist"],
    ["Categories", "Categories"],
    ["Tags", "Tags"],
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
   * back" exactly as Escape is — `DeckDialog` calls `onDismiss`, and the editor's `dismiss`
   * focuses the trigger *before* the close, while the trigger is still mounted. Asserted here
   * rather than in each layer's own test file, because the hand-back is the **opener's** half
   * of the contract: a layer handed two callbacks can only be checked for calling the right one
   * (which `DeckHistoryDialog.test.tsx` does), and where the caret lands is decided out here.
   */
  it.each([
    ["Categories", "Categories", "Close categories"],
    ["Tags", "Tags", "Close tags"],
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
   * **The full-window overlays are modal, and Tab cannot leave one.**
   *
   * Each paints a scrim over the whole app, which is a statement that what is behind it is not
   * available right now — a pointer already cannot cross one. Two of them used to let the
   * caret walk back into the editor anyway, which offered the capability to one input method and
   * denied it to the other while the docs argued it was deliberate.
   *
   * **The editor has seven and this drives the six with a control in the view.** The seventh is
   * the export dialog, opened from a category heading's right-click, so there is no button here
   * to point the sweep at; it is a `DeckDialog` like four of the six, which is what the four
   * cases below hold to the shell's behaviour.
   *
   * **Five of the seven are one component now (`DeckDialog`) and two are not**: the import dialog
   * and the theory diff still carry their own scrim, `aria-modal` and `onKeyDown={trapTab}`,
   * which is why this sweep is driven per surface rather than pointed at the shell. It is the
   * only thing holding the two copies to the shell's behaviour, and it is what would go red if
   * one of them were converted badly — or if a modality fix reached `DeckDialog.tsx` and stopped
   * there.
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
    ["Categories", "Categories", null],
    ["Tags", "Tags", null],
    ["History", "History", null],
    ["Deck settings", "Deck settings", null],
    [
      "2 cards differ",
      "Theory to Live difference",
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
   * Two `"inner"` layers open at once are not ordered by the Escape protocol at all — both
   * would consume one press — so the editor holds *one* piece of state for all eight, and
   * opening any of them takes whichever was up down with it.
   */
  it("never has two of its own layers open at once", async () => {
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));
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
   * The piles and the labels were two sections of one drawer called "Categories & tags", so the
   * only way to be wrong about which one a press opened was to scroll. Two dialogs make the
   * press the whole of the choice, and a wiring that opened the same body from both buttons
   * would look identical to a test that only ever pressed one of them.
   */
  it.each([
    ["Categories", "Tags"],
    ["Tags", "Categories"],
  ])("opens %s from its own button and not %s", async (pressed, other) => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: pressed }));

    expect(await screen.findByRole("dialog", { name: pressed })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: other })).not.toBeInTheDocument();
  });

  /**
   * …and the second press *replaces* the first rather than stacking on it.
   *
   * The `Layer` union already guarantees this — there is one slot — but the guarantee is the
   * reason the Escape ladder is safe to have, and a guarantee nothing reads is a guarantee that
   * survives being deleted. Two `"inner"` rungs enabled at once are not ordered at all: one
   * press would close both and two focus hand-backs would race for the caret. These two are the
   * pair most likely to be reached for in a row, because they were one surface until now.
   */
  it("replaces the categories dialog with the tags one rather than stacking them", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Categories" }));
    await screen.findByRole("dialog", { name: "Categories" });

    await userEvent.click(screen.getByRole("button", { name: "Tags" }));

    expect(await screen.findByRole("dialog", { name: "Tags" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Categories" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  /**
   * **Each toolbar button reports its own layer, and only its own.**
   *
   * `aria-expanded` is how a screen reader is told which of these five presses has a dialog
   * behind it, and the mapping is one expression over one union — so the failure mode is not
   * "one button forgot" but "every button says what the *open* one says", which is exactly what
   * a test pressing one button and reading one button cannot see. Read as a row, and read after
   * a press: five buttons, one `true`, four `false`.
   */
  it("reflects the open layer on the toolbar button that owns it, and on no other", async () => {
    await open();
    const BUTTONS = ["Import cards", "Categories", "Tags", "History", "Deck settings"];
    const expanded = () =>
      BUTTONS.map((name) => screen.getByRole("button", { name }).getAttribute("aria-expanded"));

    expect(expanded()).toEqual(["false", "false", "false", "false", "false"]);

    // Straight down the row without closing anything in between: one slot means the next press
    // takes the last one down, so five presses are also five checks that it did.
    for (const [i, name] of BUTTONS.entries()) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(expanded()).toEqual(BUTTONS.map((_, j) => String(i === j)));
    }

    // And pressing the open one again is the way back out — `openLayer` toggles on a repeat.
    await userEvent.click(screen.getByRole("button", { name: "Deck settings" }));
    expect(expanded()).toEqual(["false", "false", "false", "false", "false"]);
  });

  /** The toolbar's last full-window surface, and the only one that writes cards in bulk. */
  it("opens the import dialog from the toolbar", async () => {
    await open();

    await userEvent.click(screen.getByRole("button", { name: "Import cards" }));

    const dialog = await screen.findByRole("dialog", { name: "Import a decklist" });
    // Into *this* deck, so the choice the gallery's entry point cannot offer is here.
    expect(within(dialog).getByText(/Into Burn · Live/)).toBeInTheDocument();
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

    await waitFor(() =>
      expect(deckImportCommit).toHaveBeenCalledWith(4, "theory", "merge", [
        { cardId: "sol-ring", quantity: 1, categoryName: "Artifact" },
      ]),
    );
  });

  /**
   * The Escape handshake, from the layer that was added last: an `"inner"` rung consumes the
   * press in the **capture** phase and calls `preventDefault()`, so the card detail pane docked
   * beside this view — a bubble-phase listener that returns early on `defaultPrevented` — keeps
   * its own press for the next one. One press, one layer.
   */
  it("closes the import dialog on Escape and leaves the card pane open", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    await userEvent.click(screen.getByRole("button", { name: "Import cards" }));
    await screen.findByRole("dialog", { name: "Import a decklist" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Import a decklist" })).not.toBeInTheDocument(),
    );
    // With the dialog gone, the next press is the pane's.
    await userEvent.keyboard("{Escape}");

    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([true, false]);
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
    await openSearchPanel();
    const setFilter = () => screen.getByRole("button", { name: "Set" });
    const filterOpen = () => screen.queryByRole("combobox", { name: "Search sets" });

    // The format check, then the set filter: taking the caret out of the check closes it.
    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));
    await userEvent.click(setFilter());

    expect(filterOpen()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // ...and back the other way: opening the check takes the set filter down.
    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));

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
    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

    expect(await screen.findByText(/this deck is not there any more/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([false]);
  });

  /**
   * The Live/Theory switch, and the readout that is the reason to open the difference dialog.
   *
   * Reading the other list is a **query-key change** rather than a refetch, so both are cached
   * and flipping back is instant — which is why the editor can afford to read the other one
   * just to count what differs.
   */
  it("switches between the deck's two lists, and says how many cards differ", async () => {
    const live = detail({ theoryEnabled: true }, [bolt({ quantity: 4 })]);
    const theory = detail({ theoryEnabled: true }, [
      bolt({ quantity: 2, variant: "theory" }),
      card({ name: "Bear", variant: "theory" }),
    ]);
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : live),
    );

    await open();

    // One row at a different count, one row Live has not got at all.
    expect(await screen.findByRole("button", { name: "2 cards differ" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Theory" }));

    await waitFor(() => expect(deckGet).toHaveBeenCalledWith(4, "theory", "tcgplayer"));
    // The card the plan adds is on screen, and the pane context it writes says which list.
    await userEvent.click(await screen.findByRole("button", { name: /^Bear/ }));
    expect(useAppStore.getState().paneDeckContext?.variant).toBe("theory");
  });

  /** A deck with one list has no switch to press: the other half of a two-way control over a
   *  deck that keeps no plan is empty by construction. Deck settings is where a plan is
   *  started. */
  it("offers no Live/Theory switch to a deck that keeps no plan", async () => {
    await open();

    expect(screen.queryByRole("group", { name: "Deck list" })).not.toBeInTheDocument();
    expect(screen.queryByText(/cards differ/)).not.toBeInTheDocument();
  });

  /**
   * One of the two tabs, looked up **fresh every time**: switching variant puts the editor
   * through a beat with no row, which takes the whole header down and back — so a node held
   * from before a press is a node the assertion after it would be reading out of a detached
   * tree.
   */
  const tab = (name: "Live" | "Theory") =>
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

  /** The two tabs, and which of them the reader's eye lands on first. **Theory before Live**:
   *  the plan is the list a deck is built in, and it is where turning the switch on now puts
   *  the cards. Asserted as a sequence, because both being present says nothing about that. */
  it("draws the plan's tab before the deck's", async () => {
    withPlan();
    await open();

    const tabs = within(await screen.findByRole("group", { name: "Deck list" })).getAllByRole(
      "button",
    );
    expect(tabs.map((b) => b.textContent)).toEqual(["Theory", "Live"]);
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
    expect(tab("Live")).toHaveAttribute("aria-pressed", "true");
    expect(tab("Theory")).toHaveAttribute("aria-pressed", "false");
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

    expect(screen.getByLabelText("Group by")).toHaveValue("manaValue");
    expect(screen.getByLabelText("Sort")).toHaveValue("price");
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
    deckGet.mockResolvedValue(
      detail({ lastGroupBy: "colour", lastSortBy: "rarity" }, [bolt()]),
    );
    await open();

    expect(screen.getByLabelText("Group by")).toHaveValue("category");
    expect(screen.getByLabelText("Sort")).toHaveValue("alphabetical");
    expect(screen.getByRole("list", { name: "Main deck" })).toBeInTheDocument();
  });

  /**
   * Every press is stored, and **only the control that moved travels**: absent means "leave it",
   * so a press on Sort cannot write back a grouping read out of a stale render.
   */
  it("remembers each control the reader presses, one field at a time", async () => {
    withPlan({ lastVariant: "live" });
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "Theory" }));
    await waitFor(() => expect(deckSetViewState).toHaveBeenCalledWith(4, { variant: "theory" }));

    await userEvent.selectOptions(screen.getByLabelText("Group by"), "manaValue");
    await waitFor(() =>
      expect(deckSetViewState).toHaveBeenLastCalledWith(4, { groupBy: "manaValue" }),
    );

    await userEvent.selectOptions(screen.getByLabelText("Sort"), "price");
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

    await userEvent.click(tab("Live"));

    await waitFor(() => expect(deckSetViewState).toHaveBeenCalledWith(4, { variant: "live" }));
    expect(tab("Live")).toHaveAttribute("aria-pressed", "true");
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
    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

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
   * One of the family's six writes has no control in this view — the printing swap is pressed
   * on the **card pane**, which is a sibling of this editor rather than part of it.
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
    await userEvent.click(screen.getByRole("button", { name: /^Built/ }));

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
  /** A card in the deck, from the name it shows. The `<li>` is the drag handle — the whole
   *  card is. */
  const card_ = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!;

  /** One result in the panel, for the drags that start there. The getter opens the panel first,
   *  because it starts shut and a tile that is not drawn is not a drag source. */
  function panelHolds(name: string) {
    searchCards.mockResolvedValue({ items: [found(name)], total: 1, totalIsCapped: false });
    return async () => {
      await openSearchPanel();
      const art = await screen.findByRole("button", { name });
      return art.closest('[draggable="true"]')!;
    };
  }

  /**
   * **The pile that took the card decides, not the "Add to" select** — which is still saying
   * Sideboard while the card lands in the main deck. That is the whole difference between the
   * drag and the button beside it, and the reason a drop carries its own category.
   */
  it("adds a card dragged out of the panel to the group it was dropped on", async () => {
    const tile = panelHolds("Goblin Guide");
    await open();
    await openSearchPanel();
    await userEvent.selectOptions(await screen.findByLabelText("Add to"), String(SIDE));

    await dragOnto(await tile(), group("Main deck"));

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", MAIN, null, "live", 1);
    expect(screen.getByLabelText("Add to")).toHaveValue(String(SIDE));
  });

  /**
   * A card dropped on another pile is `deck_move_card`, and **since 2026-08-14 this is the only
   * route to it** — it used to be the move select's write by another road. The hand-off is the
   * same one the stepper's zero makes: the card the reader was holding has left the pile it was
   * in, so the caret goes to the pile that now has it.
   */
  it("moves a card into the group it was dropped on, and hands the caret to it", async () => {
    await open();

    await dragOnto(card_("Lightning Bolt"), group("Sideboard"));

    await waitFor(() =>
      expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, SIDE, "live"),
    );
    await waitFor(() => expect(group("Sideboard")).toHaveFocus());
  });

  /**
   * The tray is the drag's own way out of the deck: it is not there until a card is in the air,
   * it names the card once it has it, and it writes the zero the stepper's last press writes.
   */
  it("offers a way out of the deck while a card is in the air", async () => {
    await open();
    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();

    const held = await startDrag(card_("Lightning Bolt"));
    const tray = screen.getByText("Remove from deck");
    await held.over(tray);
    expect(screen.getByText("Remove Lightning Bolt from deck")).toBeInTheDocument();
    await held.drop();

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, "live", 0);
    await waitFor(() => expect(screen.queryByText(/remove/i)).not.toBeInTheDocument());
  });

  /**
   * And it is not there for a card being dragged *in*: there is nothing in this deck to take
   * out, so a tray that appeared would be offering to undo something that never happened.
   */
  it("does not offer the tray for a card dragged in from the panel", async () => {
    const tile = panelHolds("Goblin Guide");
    await open();

    const held = await startDrag(await tile());
    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();

    await held.cancel();
  });

  /**
   * **A cancelled drag is not a press of Escape as far as this app is concerned.**
   *
   * The platform cancels a drag itself — in Chromium the keypress goes to the drag operation
   * and the page is told by a `dragend`, which is what takes the tray down here. jsdom has no
   * drag to cancel, so what this pins is the app's half of that contract: while a card is in
   * the air the editor is listening for no keys at all, so an Escape that reaches the window
   * arrives with nothing consumed and the card detail pane behind this view still closes on its
   * own press. An editor that treated a drag as a dismissible layer would eat that press and
   * leave a card pinned open.
   */
  it("takes the tray away on the drag's own end, without spending the app's Escape", async () => {
    await open();
    const heard: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") heard.push(e.defaultPrevented);
    };
    window.addEventListener("keydown", listen);

    const held = await startDrag(card_("Lightning Bolt"));
    expect(screen.getByText("Remove from deck")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(heard).toEqual([false]);

    await held.cancel();

    expect(screen.queryByText(/remove/i)).not.toBeInTheDocument();
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
    expect(deckMoveCard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", listen);
  });
});
