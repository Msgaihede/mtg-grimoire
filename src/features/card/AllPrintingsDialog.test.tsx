import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { openDropdown } from "@/test-dropdown";
import type { DeckFinish, DeckVariant, Printing, PrintingsResponse } from "@/lib/ipc";
import { MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
// Type-only, so it is erased before the `vi.mock` below runs — the store's *value* import stays
// under the mock, with the component's, where the hoisting order needs it.
import type { PaneDeckContext, PrintingsRequest } from "@/lib/store";
// Same reason, one module over: the walk's stop shape is a type and nothing else here needs the
// module's runtime half.
import type { CardWalkStop } from "@/features/decks/deckWalk";

/**
 * One printing, with every field the wall and the filters read.
 *
 * The same shape `printingFilters.test.ts` builds, deliberately: two fixtures of one wire type
 * that drift are two suites testing two different cards.
 */
const p = (id: string, setCode: string, setName = "Limited Edition Alpha"): Printing => ({
  promoTypes: null,
  id,
  setCode,
  setName,
  collectorNumber: "233",
  releasedAt: "1993-08-05",
  rarity: "uncommon",
  illustrationId: `art-${id}`,
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  finishPrices: { nonfoil: 1.5, foil: null, etched: null },
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
});

const page = (items: Printing[], total = items.length): PrintingsResponse => ({ items, total });

/**
 * The deck slot the modal is opened from in the swap tests — all five parts of a deck card's
 * grain, because a context naming fewer has rewritten the wrong row twice in this repo's history
 * (see `PaneDeckContext`).
 */
const slot: PaneDeckContext = {
  deckId: 4,
  categoryId: 9,
  categoryName: "Ramp",
  cardId: "card-1",
  variant: "live",
  finish: null,
};

/** Another row of the same deck, differing in the parts of the grain a walk has to tell apart. */
const rowOf = (categoryId: number, categoryName: string, cardId: string): PaneDeckContext => ({
  deckId: 4,
  categoryId,
  categoryName,
  cardId,
  variant: "live",
  finish: null,
});

/**
 * The open deck as the desk is drawing it: three cards, in deck order, {@link slot} in the middle.
 *
 * `DeckEditor` publishes this — the order depends on the editor's grouping, its sorting and its
 * filter, none of which this component can see — and it is `[]` whenever no editor is open, which
 * is why the walk is a *fixture* here rather than something a request implies. The middle stop is
 * the one every step test opens on, so both chevrons have somewhere to go and neither end state is
 * being tested by accident.
 */
const WALK: CardWalkStop[] = [
  {
    cardId: "bolt-1",
    oracleId: "o-bolt",
    name: "Lightning Bolt",
    deck: rowOf(9, "Ramp", "bolt-1"),
  },
  { cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot },
  {
    cardId: "forest-1",
    oracleId: "o-forest",
    name: "Forest",
    deck: rowOf(11, "Land", "forest-1"),
  },
];

/**
 * The same three cards as a **page's** list rather than a deck's: no slot on any of them.
 *
 * Published by the Collection, the Wishlist and the search results, all three of which draw a
 * list of printings that no press inside this modal writes to — so a stop is the cardboard and
 * nothing else, and the step behind the scrim is `setSelectedCardId` rather than a re-anchoring
 * of the card pane onto a deck row. The `cardId`s are the ones {@link p} builds printings for, so
 * a step can be checked against the ring on the wall as well as against the store.
 */
const LIST_WALK: CardWalkStop[] = [
  { cardId: "bolt-1", oracleId: "o-bolt", name: "Lightning Bolt", deck: null },
  { cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null },
  { cardId: "forest-1", oracleId: "o-forest", name: "Forest", deck: null },
];

const cardPrintings = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();
const printingGroupBy = vi.fn();
const setPrintingGroupBy = vi.fn();
/**
 * The deck read `useSwapFromPane` brings with the mutation — the modal asks it one question, *is
 * this deck still there*, and routes a press to the card pane instead of a swap when it is not.
 */
const deckGet = vi.fn();
const deckSwapPrinting = vi.fn();
const collectionAdd = vi.fn();
const wishlistAdd = vi.fn();
/**
 * The other write a press can be: the wish this modal was opened about, repointed onto the tile
 * that was pressed. `deckSwapPrinting`'s twin one surface over — see the `wish` tests below.
 */
const wishlistSetPrinting = vi.fn();

/**
 * Every command the modal's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it, and the mocked
 * module is pulled in by the component's own imports — so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal. `CardDetailModal.test.tsx` mocks the same module the same way and for the same
 * reason.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardPrintings: (oracleId: string, marketplace: MarketplaceId, limit?: number) =>
      cardPrintings(oracleId, marketplace, limit),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
    printingGroupBy: () => printingGroupBy(),
    setPrintingGroupBy: (mode: string) => setPrintingGroupBy(mode),
    deckGet: (id: number, variant: DeckVariant, marketplace: MarketplaceId) =>
      deckGet(id, variant, marketplace),
    deckSwapPrinting: (
      deckId: number,
      from: string,
      to: string,
      categoryId: number,
      variant: DeckVariant,
      finish: DeckFinish,
    ) => deckSwapPrinting(deckId, from, to, categoryId, variant, finish),
    collectionAdd: (input: unknown) => collectionAdd(input),
    wishlistAdd: (input: unknown) => wishlistAdd(input),
    wishlistSetPrinting: (id: number, cardId: string | null) => wishlistSetPrinting(id, cardId),
  },
}));

import { AllPrintingsDialog } from "./AllPrintingsDialog";
import { DECK_CARD_ATTR, deckCardSlot } from "@/features/decks/dnd";
import { CardToDeckProvider } from "./cardMenu";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import {
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TooltipProvider,
} from "@/components/tooltip/TooltipProvider";
import { useAppStore } from "@/lib/store";

/**
 * jsdom lays nothing out, so `@tanstack/react-virtual` measures a scroll container of zero height
 * and renders an empty window — **no tiles at all**, which reads exactly like a broken wall.
 * `CardGrid.test.tsx` opens with these same two lines and for the same reason: the virtualiser
 * sizes its viewport with `offsetHeight` and scrolls it with `Element.scrollTo`, and jsdom
 * implements neither.
 *
 * The *width* needs nothing: the wall's `ResizeObserver` (a no-op stub from `test-setup.ts`)
 * reports 0, and `columnsFor` floors at one column rather than dividing by zero — so a jsdom wall
 * is one tile per row, which is all these tests ask of it.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  cardPrintings.mockReset().mockResolvedValue(page([]));
  // Nobody has chosen a marketplace, which is what a fresh install reads.
  getMarketplace.mockReset().mockResolvedValue(null);
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  // No stored ordering: `usePrintingGroupBy` falls back to `artist`, whose sort is stable, so the
  // wall below is in the order the fixtures were written in.
  printingGroupBy.mockReset().mockResolvedValue(null);
  setPrintingGroupBy.mockReset().mockResolvedValue(undefined);
  deckGet.mockReset().mockResolvedValue({ deck: { id: 4, name: "Burn" }, cards: [] });
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 1 });
  collectionAdd.mockReset();
  wishlistAdd.mockReset();
  // The shape `wishlist_set_printing` answers: an `EntryChange`, whose `id` is the row that now
  // holds the quantity — **not necessarily the row that was asked about**, since a repoint onto a
  // printing another wish in the same folder already names merges the two. The modal closes
  // either way and reads none of it; it is here so the mutation resolves rather than `undefined`.
  wishlistSetPrinting.mockReset().mockResolvedValue({ id: 7, quantity: 1, removed: false });
  // The modal is driven by one store field and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
  // The stand-ins {@link deckCard} and {@link standInDialog} leave in the document. They are
  // appended to `body` rather than to the render container — which is what makes them stand in for
  // surfaces this suite does not mount — so React's own cleanup never sees them.
  //
  // **Swept here rather than removed at the end of each test that makes one**, which is the same
  // rule as any other fixture teardown and is not fastidiousness: a test that fails before its own
  // clean-up line leaves a second `role="dialog"` in the document, and every later `getByRole`
  // then finds two. Measured while mutation-checking this file — one broken assertion cost seven
  // failures in tests that had nothing to do with it.
  document.querySelectorAll(`[${STAND_IN_ATTR}]`).forEach((node) => node.remove());
});

/**
 * The dialog under the three providers `App.tsx` mounts above it, in that order.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider is
 * above it, so a tile's right-click would open nothing and the menu test below would pass by
 * never being asked. `CardToDeckProvider` is **outside** it because the menu panel is a sibling
 * of the menu provider's children.
 *
 * `TooltipProvider` is here for exactly the same reason one hook over — `useTooltip` answers a
 * no-op with nothing above it, so the language corner's hover test would hover a mark that binds
 * nothing and pass by never being asked.
 */
function renderDialog(): ReactElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CardToDeckProvider>
          <ContextMenuProvider>
            <AllPrintingsDialog />
          </ContextMenuProvider>
        </CardToDeckProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  render(tree);
  return tree;
}

/**
 * What a card surface's menu row does: one store write, and nothing else moves.
 *
 * `wish` is the one field a caller may leave out here, and only here: the *store's* field is
 * required precisely so that every production construction site has to say `null` out loud, and
 * this file has eighteen opens of which two are about a wish. Defaulted in the helper rather than
 * written eighteen times, so the field appears in a test only where it is the subject of one.
 */
function open(request: Omit<PrintingsRequest, "wish"> & { wish?: PrintingsRequest["wish"] }) {
  act(() => useAppStore.getState().openAllPrintings({ ...request, wish: request.wish ?? null }));
}

/**
 * What a walk **stop** becomes when the modal steps onto it: the stop's own four fields, and
 * `wish: null`.
 *
 * The `null` is the assertion rather than boilerplate. `CardWalkStop` deliberately carries no
 * wish, so a step clears whatever wish the modal was opened about — the reader asked about wish
 * A, and arrowing to card B must not repoint A. Every step assertion below reads through this,
 * so the day the stop shape grows the field these all go red at once.
 */
const stepped = (stop: CardWalkStop): PrintingsRequest => ({ ...stop, wish: null });

/**
 * An open deck editor, publishing {@link WALK}.
 *
 * Through the store's own action rather than a raw `setState`, for the reason {@link open} goes
 * through `openAllPrintings`: the action is the door the editor uses, and a test that wrote the
 * field directly would go on passing after that door grew a rule. What the *order* of the walk is
 * belongs to `deckWalk.ts` and `DeckEditor`; what this file is about is what the modal does with
 * one it was handed.
 */
function withDeckWalk(): void {
  act(() => useAppStore.getState().setCardWalk({ label: "the deck", stops: WALK }));
}

/** The same, for a surface whose rows are not deck rows — see {@link LIST_WALK}. */
function withListWalk(): void {
  act(() => useAppStore.getState().setCardWalk({ label: "your collection", stops: LIST_WALK }));
}

/** What every hand-made element below is marked with, so `beforeEach` can sweep them all. */
const STAND_IN_ATTR = "data-stand-in";

/** One element appended to `body`, outside anything React owns, and marked for the sweep. */
function standIn(tag: string, attrs: Record<string, string>): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute(STAND_IN_ATTR, "");
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.appendChild(el);
  return el;
}

/**
 * The deck's own control for one slot, as the deck editor would have drawn it.
 *
 * **A stand-in rather than the real thing, and it has to be one here.** The caret hand-back is a
 * document-wide `querySelector` for {@link DECK_CARD_ATTR} — that is the whole design, because the
 * modal is not in the deck's tree and a ref taken when it opened points at an element the swap
 * deletes — and this suite mounts no editor at all. So the deck is one button carrying the slot
 * the swap moves *to*, which is what the pile looks like once the refetch has landed.
 *
 * `App.test.tsx` is where the same hand-back is driven against the real editor, with a real swap
 * rebuilding a real card. This one pins the wiring; that one pins the joint.
 */
function deckCard(row: PaneDeckContext): HTMLElement {
  const el = standIn("button", {
    type: "button",
    [DECK_CARD_ATTR]: deckCardSlot(row.categoryId, row.cardId, row.finish),
  });
  el.textContent = "the deck's card";
  return el;
}

/** Some other modal, still standing when this one closes — see the fence it is driven against. */
function standInDialog(): HTMLElement {
  return standIn("div", { role: "dialog" });
}

/**
 * A right-click, as the browser sends one.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the handler is on the **tile**
 * rather than on the art the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * The **chin** of the wall's one tile — the bar under the art, not the tile as a whole.
 *
 * The distinction is the whole point of the price assertions below. `CardGrid` draws a tile as a
 * `relative` box (the art button, its two corner marks and the hover-revealed action strip) with
 * the chin as that box's *sibling*, so a query over the tile finds a figure in either — which is
 * exactly what a price left wired to `action` as well as to `money` would look like. Scoped here,
 * a chin assertion fails while the money is anywhere else on the tile.
 *
 * One tile, because jsdom's wall is one column and every price fixture here holds one printing.
 */
async function tileChin(): Promise<HTMLElement> {
  const art = await screen.findByRole("button", { name: /LEA/ });
  const tile = art.parentElement?.parentElement as HTMLElement;
  return tile.lastElementChild as HTMLElement;
}

describe("AllPrintingsDialog", () => {
  it("draws nothing until a card is asked for", () => {
    renderDialog();
    expect(screen.queryByRole("dialog")).toBeNull();
    // And asks nothing: a closed modal costs no query, which is the whole point of the body
    // living inside `Dialog`'s children.
    expect(cardPrintings).not.toHaveBeenCalled();
  });

  it("names the card and counts its printings", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    // `toBeInTheDocument` rather than `toBeVisible`, which is `CategoriesDialog.test.tsx`'s
    // convention. The race it was avoiding is gone as of 2026-08-20 — `src/test-setup.ts` now
    // runs motion's batch inline, so `AllPrintingsDialog`'s panel no longer paints its `initial`
    // (`opacity: 0`) for a frame — and this stays because it is the honest assertion anyway:
    // `findByRole` has already proved the dialog is in the tree and accessible, and what this
    // line is about is *which card* it names.
    expect(await screen.findByRole("dialog", { name: /Sol Ring/ })).toBeInTheDocument();
    expect(await screen.findByText("2 printings")).toBeVisible();
  });

  /** A capped page must say what it is a page *of*, or the wall claims to be the whole list. */
  it("says what it is a truncation of when the page is capped", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea")], 862));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Forest", deck: null });

    expect(await screen.findByText("1 of 862 printings")).toBeVisible();
  });

  it("asks the backend for the wide page, because it filters", async () => {
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await waitFor(() => expect(cardPrintings).toHaveBeenCalledWith("o1", expect.anything(), 1000));
  });

  it("narrows the wall and says how much of it is showing", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha"), p("b", "leb", "Beta")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await user.type(await screen.findByRole("searchbox", { name: "Filter printings" }), "beta");

    expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();
    // The tile that fell out is gone from the wall, not merely uncounted.
    expect(screen.queryByRole("button", { name: /LEA/ })).toBeNull();
    expect(screen.getByRole("button", { name: /LEB/ })).toBeVisible();
  });

  /**
   * The corner's two letters say *which* language and nothing about what the letters are for.
   *
   * Issue #161: a reader met `PH` on Elesh Norn, hovered it and was told nothing, so the mark
   * read as a code the app had forgotten to expand. The corner is a mark on a photograph — there
   * is no room to print "Phyrexian" — so the words are the hover, and this is the assertion that
   * the mark is a *hoverable* one at all: `CardGrid`'s corners were `pointer-events-none` until
   * 2026-08-15, and a tooltip inside one of those is bound, correct and unreachable.
   *
   * Fake timers rather than a `waitFor`, because the panel opens on a 400ms rest — the whole
   * point of which is that a pointer merely crossing the wall opens nothing.
   */
  it("says what a language corner is short for when the pointer rests on it", async () => {
    cardPrintings.mockResolvedValue(page([{ ...p("a", "one"), lang: "ph" }]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Elesh Norn", deck: null });

    const mark = await screen.findByText("ph");
    vi.useFakeTimers();
    fireEvent.pointerEnter(mark);
    act(() => void vi.advanceTimersByTime(TOOLTIP_OPEN_MS));

    expect(document.getElementById(TOOLTIP_PANEL_ID)).toHaveTextContent("Printed in Phyrexian");
    vi.useRealTimers();
  });

  /**
   * **The chin's money slot: the cheapest finish this printing is sold in.**
   *
   * A printings row is one piece of cardboard sold in one to three finishes, so the figure under
   * it is `cheapestPrice` — which is what this dialog's own `price` sort already ranks on, so the
   * order the reader picked and the number under each tile come from one definition.
   *
   * The fixture is foil-only because that is the case a nonfoil-column chin gets wrong: 12 849
   * foil-only and 892 etched-only printings would read as unpriced on the one screen in the app
   * built for comparing prices. `formatPrice` draws the em dash for a printing no marketplace
   * quotes, and never invents `$0.00`.
   *
   * It lives **in the chin** rather than in a hover-revealed strip over the art, which is where
   * this dialog drew it until 2026-08-26 (`action={tilePrice}`). One fact, drawn once, in the
   * place every other wall in the app now draws it — and reachable without a pointer, since the
   * chin is a sibling of the tile's button rather than swallowed by its accessible name.
   */
  it("quotes the cheapest finish a printing is sold in, in the chin", async () => {
    cardPrintings.mockResolvedValue(
      page([
        {
          ...p("a", "lea"),
          finishes: '["foil"]',
          finishPrices: { nonfoil: null, foil: 31.18, etched: null },
        },
      ]),
    );
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    expect(within(await tileChin()).getByText("$31.18")).toBeInTheDocument();
    // **Once.** A price in the chin *and* in a hover strip over the art is one fact drawn twice,
    // and this is the assertion that catches leaving both wired.
    expect(screen.getAllByText("$31.18")).toHaveLength(1);
  });

  /**
   * **Spec §5: a price is never shown without saying how old it is**, on the one wall in the app
   * that is nothing but prices — and the one that had never said it.
   *
   * It also restores what `tilePrice`'s tooltip used to carry and the chin's bare figure cannot:
   * *whose* prices these are, which matters with five marketplaces in the picker. That tooltip
   * said the marketplace and never the date, once per tile, behind a hover; this says both, once,
   * in text.
   *
   * Through `pricesAsOf` rather than the sentence typed out here — spelling it would pin a copy
   * of the wording rather than the function.
   */
  it("says whose prices these are and how old they are, under the wall", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea")]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await screen.findByRole("button", { name: /LEA/ });

    expect(screen.getByText(pricesAsOf(MARKETPLACES.tcgplayer))).toBeInTheDocument();
    // The half the chin's bare figure cannot say, asserted in its own right: `getMarketplace`
    // answers `null` here — a fresh install — so this is the default resolving to TCGplayer
    // rather than a label anything on this wall hard-codes.
    expect(screen.getByText(/TCGplayer/)).toBeInTheDocument();
  });

  /** A printing no marketplace quotes costs a dash, not a `$0.00` nobody asked for — and not
   *  another feed's figure, since no two feeds have the same holes. */
  it("draws an em dash in the chin for a printing this marketplace does not price", async () => {
    cardPrintings.mockResolvedValue(
      page([{ ...p("a", "lea"), finishPrices: { nonfoil: null, foil: null, etched: null } }]),
    );
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    expect(within(await tileChin()).getByText("—")).toBeInTheDocument();
  });

  /**
   * The picker's rows are the same abbreviation with the same problem, and they had the room for
   * the answer all along: the count sentence is what both readers get, so it carries the words
   * rather than repeating the two letters the row already draws.
   */
  it("names the language in full in the picker's row, not just its code", async () => {
    cardPrintings.mockResolvedValue(
      page([p("a", "lea"), { ...p("b", "leb"), lang: "ja" }, { ...p("c", "lec"), lang: "ph" }]),
    );
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    expect(await screen.findByRole("checkbox", { name: "Japanese — 1 printing" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Phyrexian — 1 printing" })).toBeVisible();
    // The visible column is still the code — 128px of box, and a column of full names would
    // truncate to nothing.
    expect(screen.getByText("JA")).toBeVisible();
  });

  /**
   * The sets are `SetCombobox`, the search page's own picker, rather than a row of chips — and
   * it is handed **this card's** sets rather than the corpus's ~1 050.
   *
   * Two things are asserted and the second is the load-bearing one. The picker narrows the wall,
   * which is what any set control has to do; and it offers exactly the two sets these printings
   * are in, which is what tells a caller-supplied `options` list apart from the session-cached
   * `list_sets()` the search page gets. The `ipc` mock above carries no `listSets` at all, so a
   * picker that reached for the corpus here would not draw a longer list — it would throw.
   */
  it("narrows the wall by set, from a picker holding only this card's sets", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha"), p("b", "leb", "Beta")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await user.click(await screen.findByRole("button", { name: "Set" }));

    // **Scoped to the picker's own listbox.** Until 2026-08-26 this had to be: the `Sort
    // printings by` `<select>` beside it held four native `<option>`s, and a native option's
    // implicit role is `option` too, so an unscoped count answered 6 here and read as a picker
    // offering the corpus. `Sort printings by` is a closed `Dropdown` now and draws no `option`
    // role at all while shut — but the scope stays, because a second open panel would raise the
    // exact same ambiguity and costs nothing to guard against.
    const listbox = within(await screen.findByRole("listbox"));
    const alpha = listbox.getByRole("option", { name: /Alpha/ });
    // Presence rather than visibility: the popup is a `motion` surface, so its first painted
    // frame carries `initial`'s `opacity: 0` and everything inside it fails `toBeVisible` for
    // one frame. Which rows are *offered* is the fact under test.
    expect(listbox.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
    expect(listbox.getAllByRole("option")).toHaveLength(2);

    await user.click(alpha);

    expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();
    expect(screen.queryByRole("button", { name: /LEB/ })).toBeNull();
  });

  it("says why an over-narrowed wall is empty, and offers the way out", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await user.type(await screen.findByRole("searchbox", { name: "Filter printings" }), "zzz");
    expect(await screen.findByText(/No printings match/)).toBeVisible();

    // **`Clear all` is the filter bar's, and it is the only one.** The empty state says why the
    // wall is empty and points at that control rather than drawing a second one — two buttons
    // whose names both match /Clear/ would make this line throw on an ambiguous match.
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(await screen.findByText("1 printing")).toBeVisible();
  });

  /** A different fact, in a different sentence: nothing the reader did can undo this one. */
  it("tells a card with no paper printings apart from a filter that matched none", async () => {
    cardPrintings.mockResolvedValue(page([]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    expect(await screen.findByText("This card has no paper printings.")).toBeVisible();
    expect(screen.queryByText(/No printings match/)).toBeNull();
  });

  it("swaps the deck slot and closes when the modal was opened from a deck row", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    // `ipc.deckSwapPrinting` is **positional** — (deckId, fromCardId, toCardId, categoryId,
    // variant, finish) — even though the mutation that calls it takes an object with four of
    // those and closes over the other two.
    await waitFor(() =>
      expect(deckSwapPrinting).toHaveBeenCalledWith(4, "card-1", "b", 9, "live", null),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /**
   * **The half of a live region a text assertion cannot see**: it is there, and it is empty.
   *
   * A region that first appears with its sentence already inside it announces nothing, so the
   * shape being pinned is *mounted before the write*. Asserted on a wall whose reader has done
   * nothing at all, and outside every gate the body has — the query has not resolved on the first
   * commit either, and drawing the region behind `query.data` would put it back a fetch away.
   */
  it("mounts the swap announcement empty, before there is anything to say", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });
    expect(within(dialog).getByRole("status")).toBeEmptyDOMElement();
  });

  /**
   * **A fold is the one swap that owes the reader a sentence, and the modal stays open to say it.**
   *
   * A category holds a printing at most once, so swapping onto one it already had turns two rows
   * into one: the card the reader was looking at leaves the deck and its copies land on another
   * row. `SwapResult.folded` exists to say so and nothing was drawing it.
   *
   * The close is what makes this a *behaviour* rather than a string. The plain swap above closes
   * on success, and announcing into a panel that is unmounting announces nothing — so the sentence
   * and the surface it is read on are one decision, and both halves are asserted here.
   */
  it("says a fold and stays open, so the sentence can be read", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    deckSwapPrinting.mockResolvedValue({ folded: true, quantity: 3 });
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    // The server's own arithmetic and the context's own category name — neither is a guess this
    // surface makes, and both are in the sentence.
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Folded into one row of 3 in Ramp.",
      ),
    );
    expect(screen.getByRole("dialog", { name: /Sol Ring/ })).toBeInTheDocument();
    // And the wall is re-pointed at the row the deck holds now. Without this the modal would go on
    // offering to swap *from* a slot the write has just deleted, and the reader's next press would
    // be refused for a reason nothing on screen could explain.
    expect(useAppStore.getState().printingsRequest).toEqual({
      cardId: "b",
      oracleId: "o1",
      name: "Sol Ring",
      deck: { ...slot, cardId: "b" },
      wish: null,
    });
  });

  /**
   * **The caret, handed to the deck's card for the printing the deck now holds.**
   *
   * A swap deletes the control the modal was opened from — the row it was drawn from is gone and
   * the new printing's row is a different React key — so the caret has nowhere to fall back to and
   * lands on `<body>`, from which the next Tab restarts at the top of the app. The way home is the
   * slot, looked up in the document after the fact ({@link DECK_CARD_ATTR}), because the modal owns
   * none of the deck's elements. See `deckControl.ts`.
   */
  it("hands the caret to the deck's card when a swap closes the modal", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    // The pile as the refetch leaves it: the same slot, on the printing that was pressed.
    const home = deckCard({ ...slot, cardId: "b" });
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(home).toHaveFocus());
  });

  /**
   * **And it refuses while another modal is still standing, which is what keeps the hand-back
   * inside the modality rather than breaking it.**
   *
   * This wall is opened two ways: from a deck card's own menu, where it is the only surface up and
   * the caret is genuinely owed to the deck — and from the card modal's `View all printings`, where
   * closing it leaves *that* modal on screen. Walking the caret into the view behind an
   * `aria-modal` panel is the defect `caretWalk.ts` was written for one surface over, and this
   * modal's own step used to commit it.
   *
   * The stand-in is a bare `role="dialog"`, because the test is for **any** dialog: this file has
   * no business naming another surface, and the shell keeps a panel mounted for the length of its
   * fade, so at the moment the close runs the dialog still standing is usually this one.
   */
  it("leaves the caret alone while another modal is still on screen", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    const home = deckCard({ ...slot, cardId: "b" });
    standInDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Sol Ring/ })).toBeNull());
    expect(home).not.toHaveFocus();
  });

  /**
   * A press that wrote nothing to a deck takes no caret with it either.
   *
   * The fall-through opens the card on the printing that was pressed, which is a *navigation*: the
   * reader is being moved somewhere, and the deck card the swap would have rebuilt was never
   * touched. Driven with a deck control in the document for exactly that slot, so a hand-back that
   * fired on every close would have somewhere to land and would be visible here.
   */
  it("takes no caret to the deck when the press was a look rather than a swap", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    const home = deckCard({ ...slot, cardId: "b" });
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(home).not.toHaveFocus();
  });

  it("keeps the modal open and says why when a swap is refused", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    deckSwapPrinting.mockRejectedValue(new Error("that deck is gone"));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    expect(await screen.findByText(/that deck is gone/)).toBeVisible();
    // Still open — the refusal is drawn *in* the modal rather than closing it, which is the one
    // thing the card pane could not do with this sentence.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens the card pane on the printing when there is no deck to write to", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("b"));
    // **And no deck row travels with it.** The modal is opened from twelve surfaces; a pane left
    // anchored to some *other* card's deck slot would offer to swap that row onto this printing.
    expect(useAppStore.getState().paneDeckContext).toBeNull();
    expect(deckSwapPrinting).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * **The third thing a press can be: repointing a wish.**
   *
   * `request.wish` is `request.deck` one field over — the same mechanism, addressed at a
   * wishlist row instead of a deck row — and it is read *first*, before the deck branch and
   * before the fall-through that opens the card pane. A wish is what the reader was asking
   * about, so it is what the press answers.
   */
  it("repoints the wish and closes when the modal was opened from a wishlist row", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null, wish: { id: 7 } });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    // The wish's id and the printing pressed, and nothing about the printing it was on: the
    // backend addresses the row, not the grain, so there is no `from` to send.
    await waitFor(() => expect(wishlistSetPrinting).toHaveBeenCalledWith(7, "b"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // And no deck was touched on the way through — the wish branch is taken *instead of*, not
    // as well as, and a request carrying both would otherwise write twice.
    expect(deckSwapPrinting).not.toHaveBeenCalled();
  });

  /** The same sentence beside the wall a refused swap draws, in the same place, and still open. */
  it("keeps the modal open and says why when a repoint is refused", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    wishlistSetPrinting.mockRejectedValue(new Error("that wish is gone"));
    const user = userEvent.setup();
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null, wish: { id: 7 } });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    expect(await screen.findByText(/that wish is gone/)).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Not the card pane either: a refusal is not a fall-through, or a reader would be moved off
    // the wall by the press that failed.
    expect(useAppStore.getState().selectedCardId).toBeNull();
  });

  /**
   * **After a step, a press no longer repoints — and that is the design rather than a gap.**
   *
   * `CardWalkStop` deliberately does not carry `wish`, so `step` re-opens the modal with
   * `wish: null` and the target clears. The reader asked about wish A; arrowing to card B and
   * pressing a printing of B must not silently rewrite A onto a card it is not for. What the
   * press falls through to is the plain no-target answer — the card pane on that printing.
   */
  it("no longer repoints the wish once the walk has stepped to another card", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    withListWalk();
    open({ ...LIST_WALK[1], wish: { id: 7 } });
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });

    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await screen.findByRole("dialog", { name: /Forest/ });
    // The field really did clear, and this is the half the press test below cannot show on its
    // own: a press that wrote nothing would also pass if the tile had simply not been found.
    expect(useAppStore.getState().printingsRequest).toEqual(stepped(LIST_WALK[2]));

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    expect(wishlistSetPrinting).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("b"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  /**
   * Inside the list, the row would re-ask the question already on screen.
   *
   * The fence is an **oracle** comparison rather than a printing one, which is what this drives:
   * the tile right-clicked is a different printing from the one the modal was opened on, and it
   * is still the same list.
   */
  it("greys its own tiles' View all printings, because you are already looking at them", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });

    rightClick(await screen.findByRole("button", { name: /LEB/ }));

    // A regex, because a greyed row's accessible name carries its **reason** as well as its
    // label — an exact-string query here fails and reads as "the row is missing".
    const row = await screen.findByRole("menuitem", { name: /View all printings/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAccessibleName(/you are already looking at them/);
  });

  /** The "you are here" mark: the printing the deck slot plays, ringed on the wall. */
  it("marks the printing the deck currently holds", async () => {
    cardPrintings.mockResolvedValue(page([p("card-1", "lea"), p("b", "leb")]));
    renderDialog();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: slot });

    const held = await screen.findByAltText("Sol Ring (LEA 233)");
    const other = screen.getByAltText("Sol Ring (LEB 233)");
    // `CardArt` rings the selected card's frame, which is the `<img>`'s parent.
    expect(held.parentElement).toHaveClass("ring-accent");
    expect(other.parentElement).not.toHaveClass("ring-accent");
  });

  /**
   * **A step is two writes, and the second is what makes the first survivable.**
   *
   * `openAllPrintings` moves the modal; `openCardFromDeck` moves the desk behind it — the gold
   * ring on the deck card and the card pane docked beside it. Without the second, a reader who
   * walked six cards and closed the modal would land back on the row they started from, with the
   * pane still about a card they had left; and this modal's own press would go on writing that
   * first row, because a press is addressed by `request.deck`.
   *
   * All three fields are asserted rather than just the request. The pane's context is the one that
   * has silently gone wrong before in this repo — see `PaneDeckContext` — and a test that only
   * watched the modal would pass on exactly that failure.
   */
  it("steps to the next card in the deck on ArrowRight, and takes the desk with it", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });

    // The caret is on the panel — `Dialog` puts it there on open — so the press bubbles to
    // the panel's own handler, which is the only thing entitled to it. Waited for rather than
    // assumed: a press made while the caret is still on `<body>` reaches no handler at all, and
    // would read as the step being broken.
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(useAppStore.getState().printingsRequest).toEqual(stepped(WALK[2])));
    expect(useAppStore.getState().paneDeckContext).toEqual(WALK[2].deck);
    expect(useAppStore.getState().selectedCardId).toBe(WALK[2].cardId);
    // The modal is a window onto the deck, so it stays open and re-captions itself.
    expect(await screen.findByRole("dialog", { name: /Forest/ })).toBeInTheDocument();
  });

  /** The same step the other way, and the chevron makes it — one gesture, the same two writes. */
  it("steps to the previous card when the left chevron is pressed", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    // Named by what it does **and what it lands on** — a chevron says neither on its own.
    await user.click(
      await screen.findByRole("button", { name: "Previous card in the deck, Lightning Bolt" }),
    );

    await waitFor(() => expect(useAppStore.getState().printingsRequest).toEqual(stepped(WALK[0])));
    expect(useAppStore.getState().paneDeckContext).toEqual(WALK[0].deck);
    expect(useAppStore.getState().selectedCardId).toBe(WALK[0].cardId);
  });

  /**
   * **No walk, no chevrons and no arrow keys** — the state every surface but a deck row opens in.
   *
   * A search tile, the collection, a wishlist row: `request.deck` is null, so the index is `-1`
   * and there is nothing to step along. The arrow press is the half worth driving, because a
   * chevron that is not drawn is obvious and a key that quietly did something would not be.
   */
  it("draws no chevrons and answers no arrow keys when the card is not on a walk", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open({ cardId: "elsewhere-1", oracleId: "o-elsewhere", name: "Counterspell", deck: null });
    const dialog = await screen.findByRole("dialog", { name: /Counterspell/ });

    expect(screen.queryByRole("button", { name: /card in the deck/ })).toBeNull();

    // The press really does reach the panel — otherwise this would pass on a caret that was never
    // in the dialog rather than on a handler that declined.
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().printingsRequest?.name).toBe("Counterspell");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * The same absence for a deck row that is **not on this walk** — a card opened from one deck
   * while the editor is showing another.
   *
   * It needs no test of its own in the component: the index answers it, which is the whole reason
   * there is no second "is this the same deck" comparison to keep true. This asserts that the one
   * test really does cover the case.
   */
  it("draws no chevrons for a deck row the open editor is not showing", async () => {
    renderDialog();
    withDeckWalk();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: { ...slot, deckId: 77 } });
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    expect(screen.queryByRole("button", { name: /card in the deck/ })).toBeNull();
  });

  /**
   * The two ends: the chevron is **drawn and disabled**, never dropped.
   *
   * Both are still there so that the first step of a walk is not the moment a second control
   * appears under the reader's pointer. `disabled` rather than `aria-disabled` is
   * `QuantityStepper`'s exception — a control with nothing left to do buys the caret a stop and no
   * action to take there — and it is also what `trapTab` reads when it decides what is in the
   * cycle.
   */
  it("greys the chevron at each end of the walk and keeps the other one live", async () => {
    renderDialog();
    withDeckWalk();
    open(WALK[0]);
    await screen.findByRole("dialog", { name: /Lightning Bolt/ });

    expect(screen.getByRole("button", { name: "Previous card in the deck" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Next card in the deck, Sol Ring" }),
    ).not.toBeDisabled();

    // And the far end, where the pair is the other way round.
    open(WALK[2]);
    await screen.findByRole("dialog", { name: /Forest/ });
    expect(screen.getByRole("button", { name: "Next card in the deck" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous card in the deck, Sol Ring" }),
    ).not.toBeDisabled();
  });

  /**
   * **ArrowUp and ArrowDown are not this dialog's**, and the assertion is that nothing moved.
   *
   * The thing under them is a virtualised wall of card art whose native scrolling is exactly what
   * those two keys are for. They are not handled at all — no branch and no `preventDefault` — so
   * this is a test of an absence, which is the only kind of test it can be: a swallowed press and
   * a press that walked the deck look identical to a reader who was trying to scroll.
   */
  it("leaves ArrowUp and ArrowDown alone", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });
    await waitFor(() => expect(dialog).toHaveFocus());

    await user.keyboard("{ArrowUp}");
    await user.keyboard("{ArrowDown}");

    expect(useAppStore.getState().printingsRequest).toEqual(stepped(WALK[1]));
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **An open dropdown owns the arrow keys**, and this is the guard that would otherwise have
   * shipped — twice now, in two shapes.
   *
   * It was a `<select>` until 2026-08-26, where ArrowLeft *changes the value* in Chromium and in
   * WebView2 with it, so a reader re-sorting the wall would step to another card as well. A
   * `Dropdown` has the opposite shape: a **closed** trigger does nothing with ArrowLeft, so the
   * walk is welcome to it — and an **open** panel is where the caret is and where the arrows
   * belong. `ARROW_OWNERS` was rewritten to match the second shape and this test moved with it.
   *
   * **Opened the way a reader opens it**, not with `focus()`. Starting a keyboard flow from a
   * programmatic focus tests a caret nobody can produce, and here it would skip the very state
   * being tested: the panel has to be open for the exemption to be in force at all.
   */
  it("yields the arrow keys to an open dropdown in the filter row", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    await openDropdown(user, "Sort printings by");

    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");

    expect(useAppStore.getState().printingsRequest).toEqual(stepped(WALK[1]));
  });

  /**
   * **A step starts a clean session, filter included** — which is `Body`'s `key` and not an effect.
   *
   * The filter belongs to the card the reader left. Carried across, a set or a text filter that
   * the next card cannot match draws an empty wall, and an empty wall reads as an answer about the
   * card rather than as a filter that is still running. This is the assertion that says the
   * remount really happens: the box is empty and the count line is back to the unfiltered wording.
   */
  it("clears the filter when it steps, because the next card is a new session", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha"), p("b", "leb", "Beta")]));
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    const box = await screen.findByRole("searchbox", { name: "Filter printings" });
    act(() => box.focus());
    await user.keyboard("beta");
    expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();

    // The caret is in the box, which is a control that owns the arrow keys — so the step is made
    // with the pointer, exactly as a reader who had just filtered would have to.
    await user.click(screen.getByRole("button", { name: "Next card in the deck, Forest" }));

    expect(await screen.findByRole("dialog", { name: /Forest/ })).toBeInTheDocument();
    expect(await screen.findByRole("searchbox", { name: "Filter printings" })).toHaveValue("");
    expect(await screen.findByText("2 printings")).toBeVisible();
  });

  /**
   * **The same walk from a page's list, where there is no deck row at either end.**
   *
   * Reported 2026-08-20 (#128): the arrow keys stepped the modal from a deck row and did nothing
   * from the search results, the collection or the wishlist, because the only walk that existed
   * was the desk's. The three lists now publish theirs, and the difference between the two kinds
   * is exactly one thing — a step re-anchors the card pane to a deck row where there is one, and
   * opens the card the way every other surface in this app does where there is not.
   *
   * `paneDeckContext` is asserted `null` for that reason and not as a formality: a reader who had
   * a deck card open, left for the Collection and stepped along it would otherwise be sat in a
   * pane still anchored to the row they left, offering to swap it onto whatever they walked to.
   */
  it("steps along a page's list on ArrowRight, and the selection follows", async () => {
    const user = userEvent.setup();
    renderDialog();
    withListWalk();
    open(LIST_WALK[1]);
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });

    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");

    await waitFor(() =>
      expect(useAppStore.getState().printingsRequest).toEqual(stepped(LIST_WALK[2])),
    );
    // **The selection really follows** — this is the half a walk is for. Close the modal here and
    // the reader is standing on the card they walked to, not on the one they started from.
    expect(useAppStore.getState().selectedCardId).toBe("forest-1");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
    expect(await screen.findByRole("dialog", { name: /Forest/ })).toBeInTheDocument();
  });

  /** And back, by the chevron rather than the key — one gesture, the same two writes. */
  it("steps back along a page's list when the left chevron is pressed", async () => {
    const user = userEvent.setup();
    renderDialog();
    withListWalk();
    open(LIST_WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    await user.click(
      await screen.findByRole("button", {
        name: "Previous card in your collection, Lightning Bolt",
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().printingsRequest).toEqual(stepped(LIST_WALK[0])),
    );
    expect(useAppStore.getState().selectedCardId).toBe("bolt-1");
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **The chevrons name the list they are walking, and the noun is the walk's own.**
   *
   * The same control is drawn over the deck, the collection, the wishlist and the search results;
   * "in the deck" over a wishlist would be the one part of this feature that lies, and a chevron
   * is silent about all three of what it does, where, and what it lands on.
   */
  it("names the list the chevrons are stepping along", async () => {
    renderDialog();
    withListWalk();
    open(LIST_WALK[0]);
    await screen.findByRole("dialog", { name: /Lightning Bolt/ });

    expect(screen.getByRole("button", { name: "Previous card in your collection" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Next card in your collection, Sol Ring" }),
    ).not.toBeDisabled();
  });

  /**
   * **The "you are here" ring, on a wall that is not a deck's.**
   *
   * It used to be the deck slot's printing and nothing outside a deck, which was defensible while
   * the modal was about one card and became wrong the moment the arrow keys could walk a list:
   * two printings of one card are two stops drawing the *same* wall, so with nothing ringed a
   * step between them moves nothing a reader can see. Here the step is between two different
   * cards, and the assertion is the ring landing on the one that was walked to.
   */
  it("rings the printing the walk has landed on, with no deck anywhere", async () => {
    cardPrintings.mockResolvedValue(page([p("card-1", "lea"), p("forest-1", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    withListWalk();
    open(LIST_WALK[1]);
    const dialog = await screen.findByRole("dialog", { name: /Sol Ring/ });

    // Before: the card the question was asked from.
    const here = await screen.findByAltText("Sol Ring (LEA 233)");
    expect(here.parentElement).toHaveClass("ring-accent");

    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");

    // After: the card the walk landed on. Same wall — the fixture answers every oracle id with
    // these two printings — and the ring is what has moved.
    await screen.findByRole("dialog", { name: /Forest/ });
    const landed = await screen.findByAltText("Forest (LEB 233)");
    expect(landed.parentElement).toHaveClass("ring-accent");
    expect(screen.getByAltText("Forest (LEA 233)").parentElement).not.toHaveClass("ring-accent");
  });

  /**
   * A card the page's list does not contain — opened from the card pane, which can be showing
   * something no row on screen names. The index answers it, exactly as it does for a deck row
   * belonging to a deck the open editor is not showing.
   */
  it("draws no chevrons for a card the published list does not contain", async () => {
    renderDialog();
    withListWalk();
    open({ cardId: "elsewhere-1", oracleId: "o-elsewhere", name: "Counterspell", deck: null });
    await screen.findByRole("dialog", { name: /Counterspell/ });

    expect(screen.queryByRole("button", { name: /card in your collection/ })).toBeNull();
  });

  /**
   * **A modal opened from a surface with no slot must not walk the deck behind it.**
   *
   * The deck editor's docked search panel publishes no walk of its own — the desk owns the store's
   * one walk while the editor is up — and its tiles carry no `printingsDeck`, so a request from
   * there has `deck: null`. Without the `stop.deck === null` half of the lookup, a printing that
   * happens to be *in* the deck would be found by card id and the panel would start arrow-stepping
   * the desk. `card-1` is exactly that printing: {@link slot} names it.
   */
  it("does not find a deck row for a request that names no slot", async () => {
    renderDialog();
    withDeckWalk();
    open({ cardId: "card-1", oracleId: "o1", name: "Sol Ring", deck: null });
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    expect(screen.queryByRole("button", { name: /card in the deck/ })).toBeNull();
  });
});
