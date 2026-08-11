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
} from "@/lib/ipc";
import { dragOnto, startDrag } from "@/test-drag";
import { card, resetRowIds, spec } from "./validation/fixtures";

const deckGet = vi.hoisted(() => vi.fn());
const deckUpdate = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
const formatSpecs = vi.hoisted(() => vi.fn());
// The docked search panel is the editor's own filter bar, set picker and result wall — and the
// toolbar's quick add resolves a typed name through the same command.
const searchCards = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
// The four overlays' own reads. Each is unmounted while closed, so these answer only for the
// tests that open one — but the whole `ipc` object is replaced here, so a command left out is a
// `TypeError` rather than a missing answer.
const deckCategoryList = vi.hoisted(() => vi.fn());
const deckTagList = vi.hoisted(() => vi.fn());
const deckTagSuggestions = vi.hoisted(() => vi.fn());
const deckAuditList = vi.hoisted(() => vi.fn());
const deckTheoryDiff = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckUpdate,
    deckSetCardQuantity,
    deckMoveCard,
    deckAddCard,
    deckMissingToWishlist,
    deckSwapPrinting,
    formatSpecs,
    searchCards,
    listSets,
    deckCategoryList,
    deckTagList,
    deckTagSuggestions,
    deckAuditList,
    deckTheoryDiff,
    deckFolderList,
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
};

/** The picker, as `format_specs` serves it — every enabled row in `sort_order`. */
const PICKER: FormatSpec[] = [spec("modern"), spec("commander"), spec("gladiator"), spec("casual")];

/**
 * One `deck_categories` row.
 *
 * **`isActive` is derived from the kind by default**, mirroring `schema::PREDEFINED_CATEGORIES`:
 * the Maybeboard is the one predefined pile seeded switched off, and every other category a
 * deck is born with is on. A test about the switch itself passes `isActive` and says so.
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
    sortOrder: id - 1,
    // The heading counts the rows it was handed, so these three are read by nothing here.
    cardCount: 0,
    totalPriceUsd: null,
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
    unitPriceUsd: 4.5,
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
    priceUsd: 1.5,
    layout: "normal",
    oracleId: `o-${name}`,
    finishes: `["nonfoil"]`,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: 1.5,
    priceHigh: 1.5,
  };
}

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

/** A group, by the heading it draws. Every view labels its section with the group's name and
 *  nothing else — the count and the price are text beside it, not part of what it is called. */
const group = (name: string) => screen.getByRole("region", { name });

/** What the stepper on the fixture's Bolt is called. Named by the **slot** — the card and the
 *  pile — because the same printing sits in two categories often enough that a name without one
 *  would be two controls a screen reader cannot tell apart. */
const COPIES = "Copies of Lightning Bolt in Main deck";

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

/** The stats block is open by default and is counted against the panel's floor, so the three
 *  width tests below close it first — they are about the panel and the deck, not about three
 *  columns at once. */
async function hideStats() {
  await userEvent.click(screen.getByRole("button", { name: "Stats" }));
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
});

describe("DeckEditor", () => {
  /** The header is the deck: what it is called, what it is for, and whether it is sleeved up. */
  it("heads the editor with the deck's name, format and build state", async () => {
    await open();

    expect(screen.getByLabelText("Deck name")).toHaveValue("Burn");
    expect(screen.getByLabelText("Deck format")).toHaveValue("modern");
    const built = screen.getByRole("button", { name: /^Built/ });
    expect(built).toHaveAttribute("aria-pressed", "false");
    expect(built).toHaveAttribute("title", "Reserves your copies for this deck");
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
   * **The groups are the deck's categories, and the format has nothing to say about them.**
   *
   * There used to be a filter here: Modern got a sideboard and no commander column, because
   * `sideboard_max` and `requires_commander` decided which of the five fixed zones were slots
   * this format had. Schema v8 makes a category a row the *user* named, ordered and switched on
   * or off, so hiding one would hide a pile they built. This deck is Modern and its Commander
   * group is drawn — which is the whole of what changed.
   *
   * The default grouping is Categories, so the deck opens on exactly this list.
   */
  it("draws one group per category, whatever the format says about them", async () => {
    await open();

    expect(
      screen.getAllByRole("region", { name: /^(Main deck|Sideboard|Commander|Companion|Maybeboard)$/ }),
    ).toHaveLength(5);
    // Empty ones included: a category is a *place* as well as a heading, and a column that
    // vanished with its last card is one the reader cannot put a card back into.
    expect(within(group("Sideboard")).getByText("0 cards")).toBeInTheDocument();
    // Modern requires no commander and this deck has none, and the group is here all the same.
    expect(group("Commander")).toBeInTheDocument();
  });

  /** And the same five for a Commander deck, whose `sideboard_max` is 0: a category is data the
   *  user made, so re-formatting a deck never takes a pile away from it. */
  it("draws the same groups for a commander deck", async () => {
    deckGet.mockResolvedValue(detail({ formatKey: "commander", formatName: "Commander" }, []));

    await open();

    expect(await screen.findByRole("region", { name: "Commander" })).toBeInTheDocument();
    expect(group("Sideboard")).toBeInTheDocument();
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
   * The click path a move needs, and the one that is not a layer.
   *
   * A native `<select>` rather than the anchored row menu it replaces: the browser draws it in
   * its own layer, so it needs no rung in the editor's Escape union, no z-index and no focus
   * hand-back — three things the old menu had to get right and this cannot get wrong.
   */
  it("moves a card between categories from its own control", async () => {
    await open();

    await userEvent.selectOptions(
      screen.getByLabelText("Move Lightning Bolt out of Main deck"),
      String(SIDE),
    );

    expect(deckMoveCard).toHaveBeenCalledWith(4, "c-Lightning Bolt", MAIN, SIDE, "live");
    // The caret follows the card to the pile that now has it.
    await waitFor(() => expect(group("Sideboard")).toHaveFocus());
  });

  /** A card cannot be moved to the pile it is already in — `deck_move_card` would touch the
   *  deck, reallocate and bump `updated_at` to leave the list exactly as it was. */
  it("does not offer a card its own category as a move target", async () => {
    await open();

    const select = screen.getByLabelText("Move Lightning Bolt out of Main deck");
    expect([...within(select).getAllByRole("option")].map((o) => o.textContent)).toEqual([
      "Move…",
      "Sideboard",
      "Commander",
      "Companion",
      "Maybeboard",
    ]);
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
    expect(within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ })).toBeVisible();

    await press("Grid");
    expect(within(group("Main deck")).getByRole("button", { name: /^Lightning Bolt/ })).toBeVisible();

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
   * and a legality panel can never disagree. It is an aside beside the deck rather than a band
   * over it, and it is the reader's to put away.
   */
  it("adds the deck up in an aside the reader can put away", async () => {
    await open();

    const stats = screen.getByRole("region", { name: "Deck stats" });
    // Four Bolts and two Bears, both nonlands, both mana value 1.
    expect(within(stats).getByText("Cards").nextElementSibling).toHaveTextContent("6");
    expect(
      within(within(stats).getByRole("list", { name: "Mana curve" })).getByText(
        "6 cards at mana value 1",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Stats" }));

    expect(screen.queryByRole("region", { name: "Deck stats" })).not.toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole("button", { name: /^Goblin Guide/ }));

    expect(useAppStore.getState().selectedCardId).toBe("s-Goblin Guide");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * The fastest way to put a card in a deck whose name you already know — one search for the
   * best match's newest printing, then the same `deck_add_card` the panel's button sends. Where
   * it lands is the panel's "Add to": one control for one decision.
   */
  it("adds the best match for a typed name", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
    await userEvent.type(
      screen.getByLabelText("Quick add a card to Main deck"),
      "goblin guide{Enter}",
    );

    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", MAIN, null, "live", 1),
    );
    // Cleared on a hit, because the next action is the next card.
    expect(screen.getByLabelText("Quick add a card to Main deck")).toHaveValue("");
  });

  /** A miss is said in words rather than swallowed, and the field keeps what was typed —
   *  because the next action there is to correct it. */
  it("says when a quick add finds nothing, and keeps what was typed", async () => {
    await open();

    await userEvent.type(
      screen.getByLabelText("Quick add a card to Main deck"),
      "Blakc Lotus{Enter}",
    );

    expect(await screen.findByText("No card found for “Blakc Lotus”.")).toBeInTheDocument();
    expect(deckAddCard).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Quick add a card to Main deck")).toHaveValue("Blakc Lotus");
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
    screen.getByLabelText("Quick add a card to Main deck").focus();
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", MAIN, null, "live", 1);
  });

  /** Every category the deck has, in the order the groups are drawn — one list, one source. */
  it("offers every category as an add target", async () => {
    await open();

    const select = (await screen.findByLabelText("Add to")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Main deck",
      "Sideboard",
      // Modern requires no commander, and the group and the option are here anyway: a category
      // is data the user made, not a slot the format implies.
      "Commander",
      "Companion",
      "Maybeboard",
    ]);
  });

  /**
   * A category can leave the deck under an open editor — deleted from another window, or
   * renamed away — and a select left holding an id that is not among its own options shows
   * nothing selected while every press files a card into a group nothing is drawing.
   *
   * The fallback is the **first** category rather than a hard-coded word: there is no `main` to
   * fall back to any more, and a deck always has at least the four predefined piles.
   */
  it("falls back to the first category when the one it was holding leaves the deck", async () => {
    searchCards.mockResolvedValue({
      items: [found("Goblin Guide")],
      total: 1,
      totalIsCapped: false,
    });

    await open();
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
    // *shows* "Main deck" whatever the state behind it says. Without the reset, every press
    // would still file its card into a category the editor is no longer drawing.
    expect(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
    ).toBeInTheDocument();
  });

  /**
   * Three docked columns do not fit in a 1024px window — sidebar, page padding, the card pane
   * and the panel come to 1044 before the deck gets a pixel — and the deck was measured at
   * **2px** before this existed, which reads as a rendering fault rather than as a squeeze. The
   * narrowest thing gives way first.
   *
   * 376 is what a 1024px window leaves this row with the card pane docked beside the view
   * (measured at 361 once the page's own scrollbar is out); 608 is `DECK_FLOOR` plus the panel
   * and the `gap-4` between them — the exact width at which both fit again, so the pair of
   * tests pins the floor to the pixel. (604 in the previous editor, whose desk row was `gap-3`.)
   */
  it("falls back to the rail when the deck and the panel cannot both fit", async () => {
    const restore = desk(376);
    try {
      await open();
      await hideStats();

      const rail = await screen.findByRole("button", { name: "Search cards" });
      expect(rail).toHaveAttribute("aria-expanded", "false");
      // Not a control that records an intention and moves nothing: there is no width for what
      // it would open, and it says so rather than doing nothing.
      expect(rail).toHaveAttribute("aria-disabled", "true");
      expect(rail).toHaveAttribute("title", expect.stringMatching(/not enough room/i));
      expect(screen.queryByRole("searchbox", { name: "Search cards" })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("draws the panel at the width where the deck still clears its floor", async () => {
    const restore = desk(608);
    try {
      await open();
      await hideStats();

      expect(await screen.findByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search cards" })).not.toHaveAttribute(
        "aria-disabled",
      );
    } finally {
      restore();
    }
  });

  /** And one pixel under it is the rail — the floor is a number, not a feeling. */
  it("gives way one pixel below that", async () => {
    const restore = desk(607);
    try {
      await open();
      await hideStats();

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
   * The stats aside is counted against that floor, which is the one thing the rebuild changed
   * about it: the desk row holds three things where it held two. A reader who opens Stats in a
   * window that was exactly wide enough for the deck and the panel gets the rail — and closing
   * either gives the panel back, because nothing here records an intention it cannot honour.
   */
  it("gives the panel up to the stats block when only one of them fits", async () => {
    const restore = desk(608);
    try {
      await open();
      // Stats is open by default, so the panel is already a rail at this width.
      expect(await screen.findByRole("button", { name: "Search cards" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );

      await hideStats();

      expect(await screen.findByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
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
      within(pile).getByRole("button", { name: /^Lightning Bolt/ }).getAttribute("aria-label"),
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
   * Each of the three header buttons opens its own full-window surface, and Escape closes the
   * one that is up and hands the caret back to the control that opened it — the editor stays a
   * *view*, so the deck is still on screen afterwards.
   */
  it.each([
    ["Categories & tags", "Categories and tags"],
    ["History", "Deck history"],
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
   * back" exactly as Escape is — the drawer calls `onDismiss`, and the editor's `dismiss`
   * focuses the trigger *before* the close, while the trigger is still mounted. Asserted here
   * rather than in each layer's own test file, because the hand-back is the **opener's** half
   * of the contract: a layer handed two callbacks can only be checked for calling the right one
   * (which `AuditDrawer.test.tsx` does), and where the caret lands is decided out here.
   */
  it.each([
    ["Categories & tags", "Categories and tags", "Close categories and tags"],
    ["History", "Deck history", "Close the history"],
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
   * Two `"inner"` layers open at once are not ordered by the Escape protocol at all — both
   * would consume one press — so the editor holds *one* piece of state for all five, and
   * opening any of them takes whichever was up down with it.
   */
  it("never has two of its own layers open at once", async () => {
    await open();

    await userEvent.click(await screen.findByRole("button", { name: "1 issue" }));
    expect(screen.getByRole("dialog", { name: "Modern check" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Categories & tags" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Categories and tags" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Deck history" })).toBeInTheDocument();
  });

  /**
   * The **sixth** `"inner"` peer on this screen, and the one no state union covers: the set
   * filter inside the docked search panel owns its own Escape rung (`SetCombobox`). What keeps
   * it exclusive with the editor's own five is focus and click mechanics — each of them closes
   * on focus-out or on a press outside its root — so it is pinned here in the assembled editor,
   * both ways round. Neither direction is a structural guarantee, and a test is the only thing
   * that would notice one of them being dropped.
   */
  it("never has the set filter and one of the editor's own layers open at once", async () => {
    await open();
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
    await userEvent.click(screen.getByRole("button", { name: "Categories & tags" }));

    expect(await screen.findByRole("dialog", { name: "Categories and tags" })).toBeInTheDocument();
    expect(filterOpen()).not.toBeInTheDocument();
  });

  /**
   * A deck deleted under an open layer takes its trigger with it. The state that says one is
   * open does not go on its own — and an `"inner"` layer nothing draws is a layer that eats the
   * first Escape of whatever the reader does next.
   */
  it("closes an open layer when the deck turns out to be gone", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Categories & tags" }));
    await screen.findByRole("dialog", { name: "Categories and tags" });

    // Staged *after* the drawer is up, because the drawer mounts a second observer of the
    // editor's own deck read — a `staleTime: 0` query with a new observer refetches, so a `null`
    // queued before the press would take the deck away on the way in rather than on the write.
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

    await waitFor(() => expect(deckGet).toHaveBeenCalledWith(4, "theory"));
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
  it("says how old its prices are", async () => {
    await open();

    expect(screen.getByText("Prices as of the last card-data sync.")).toBeInTheDocument();
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Goblin Guide to Main deck" }),
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
   * Three of the family's six writes have no control in this view as it stands — the printing
   * swap is pressed on the **card pane**, which is a sibling of this editor rather than part of
   * it, and `setQuantity`/`moveCard` lost their controls when the rebuilt views replaced the
   * category columns that carried a stepper and a "Move to" menu.
   *
   * None of the three can honestly be tested from here, and the swap is tested where the two
   * components meet: `App.test.tsx`'s "says a refused swap in the pane, and the deck behind it
   * goes with it". What actually carries a pane-fired refusal back to this view is not this
   * file's `newest` list at all — two `useMutation` call sites share no state — but the
   * `onError` invalidation on the mutation's single definition (`useDeck.ts`). The entries in
   * `lastOfAny` stay as the belt to those braces, for the day a control in this view fires one
   * of the three.
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

  /** One result in the panel, for the drags that start there. */
  function panelHolds(name: string) {
    searchCards.mockResolvedValue({ items: [found(name)], total: 1, totalIsCapped: false });
    return async () => {
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
    await userEvent.selectOptions(await screen.findByLabelText("Add to"), String(SIDE));

    await dragOnto(await tile(), group("Main deck"));

    expect(deckAddCard).toHaveBeenCalledWith(4, "s-Goblin Guide", MAIN, null, "live", 1);
    expect(screen.getByLabelText("Add to")).toHaveValue(String(SIDE));
  });

  /**
   * A card dropped on another pile is the move select's write by another route — the same
   * command, and the same hand-off afterwards: the card the reader was holding has left, so the
   * caret goes to the pile that now has it.
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
