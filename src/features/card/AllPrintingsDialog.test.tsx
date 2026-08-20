import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { DeckFinish, DeckVariant, Printing, PrintingsResponse } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
// Type-only, so it is erased before the `vi.mock` below runs — the store's *value* import stays
// under the mock, with the component's, where the hoisting order needs it.
import type { PaneDeckContext } from "@/lib/store";
// Same reason, one module over: the walk's stop shape is a type and nothing else here needs the
// module's runtime half.
import type { DeckWalkStop } from "@/features/decks/deckWalk";

/**
 * One printing, with every field the wall and the filters read.
 *
 * The same shape `printingFilters.test.ts` builds, deliberately: two fixtures of one wire type
 * that drift are two suites testing two different cards.
 */
const p = (id: string, setCode: string, setName = "Limited Edition Alpha"): Printing => ({
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
const WALK: DeckWalkStop[] = [
  { oracleId: "o-bolt", name: "Lightning Bolt", deck: rowOf(9, "Ramp", "bolt-1") },
  { oracleId: "o1", name: "Sol Ring", deck: slot },
  { oracleId: "o-forest", name: "Forest", deck: rowOf(11, "Land", "forest-1") },
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
 * Every command the modal's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it, and the mocked
 * module is pulled in by the component's own imports — so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal. `CardDetailPane.test.tsx` mocks the same module the same way and for the same
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
  },
}));

import { AllPrintingsDialog } from "./AllPrintingsDialog";
import { CardToDeckProvider } from "./cardMenu";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
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
  // The modal is driven by one store field and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

/**
 * The dialog under the two providers `App.tsx` mounts above it, in that order.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider is
 * above it, so a tile's right-click would open nothing and the menu test below would pass by
 * never being asked. `CardToDeckProvider` is **outside** it because the menu panel is a sibling
 * of the menu provider's children.
 */
function renderDialog(): ReactElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={qc}>
      <CardToDeckProvider>
        <ContextMenuProvider>
          <AllPrintingsDialog />
        </ContextMenuProvider>
      </CardToDeckProvider>
    </QueryClientProvider>
  );
  render(tree);
  return tree;
}

/** What a card surface's menu row does: one store write, and nothing else moves. */
function open(request: { oracleId: string; name: string; deck: PaneDeckContext | null }): void {
  act(() => useAppStore.getState().openAllPrintings(request));
}

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
  act(() => useAppStore.getState().setDeckWalk(WALK));
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

describe("AllPrintingsDialog", () => {
  it("draws nothing until a card is asked for", () => {
    renderDialog();
    expect(screen.queryByRole("dialog")).toBeNull();
    // And asks nothing: a closed modal costs no query, which is the whole point of the body
    // living inside `DeckDialog`'s children.
    expect(cardPrintings).not.toHaveBeenCalled();
  });

  it("names the card and counts its printings", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    // `toBeInTheDocument` rather than `toBeVisible`, which is `CategoriesDialog.test.tsx`'s
    // convention and for a reason worth carrying: `DeckDialog`'s panel carries its `initial` —
    // `opacity: 0` — on the frame it mounts, so a visibility assertion on the first render is a
    // race against a fade that `MotionGlobalConfig.skipAnimations` shortens but does not skip.
    expect(await screen.findByRole("dialog", { name: /Sol Ring/ })).toBeInTheDocument();
    expect(await screen.findByText("2 printings")).toBeVisible();
  });

  /** A capped page must say what it is a page *of*, or the wall claims to be the whole list. */
  it("says what it is a truncation of when the page is capped", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea")], 862));
    renderDialog();
    open({ oracleId: "o1", name: "Forest", deck: null });

    expect(await screen.findByText("1 of 862 printings")).toBeVisible();
  });

  it("asks the backend for the wide page, because it filters", async () => {
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    await waitFor(() => expect(cardPrintings).toHaveBeenCalledWith("o1", expect.anything(), 1000));
  });

  it("narrows the wall and says how much of it is showing", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha"), p("b", "leb", "Beta")]));
    const user = userEvent.setup();
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    await user.type(await screen.findByRole("searchbox", { name: "Filter printings" }), "beta");

    expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();
    // The tile that fell out is gone from the wall, not merely uncounted.
    expect(screen.queryByRole("button", { name: /LEA/ })).toBeNull();
    expect(screen.getByRole("button", { name: /LEB/ })).toBeVisible();
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
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    await user.click(await screen.findByRole("button", { name: "Set" }));

    // **Scoped to the picker's own listbox**, because the `Sort printings by` `<select>` beside
    // it holds four native `<option>`s and a native option's implicit role is `option` too — an
    // unscoped count answers 6 here and reads as a picker offering the corpus.
    const listbox = within(await screen.findByRole("listbox"));
    const alpha = listbox.getByRole("option", { name: /Alpha/ });
    expect(listbox.getByRole("option", { name: /Beta/ })).toBeVisible();
    expect(listbox.getAllByRole("option")).toHaveLength(2);

    await user.click(alpha);

    expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();
    expect(screen.queryByRole("button", { name: /LEB/ })).toBeNull();
  });

  it("says why an over-narrowed wall is empty, and offers the way out", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea", "Alpha")]));
    const user = userEvent.setup();
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

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
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    expect(await screen.findByText("This card has no paper printings.")).toBeVisible();
    expect(screen.queryByText(/No printings match/)).toBeNull();
  });

  it("swaps the deck slot and closes when the modal was opened from a deck row", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    const user = userEvent.setup();
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: slot });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    // `ipc.deckSwapPrinting` is **positional** — (deckId, fromCardId, toCardId, categoryId,
    // variant, finish) — even though the mutation that calls it takes an object with four of
    // those and closes over the other two.
    await waitFor(() =>
      expect(deckSwapPrinting).toHaveBeenCalledWith(4, "card-1", "b", 9, "live", null),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the modal open and says why when a swap is refused", async () => {
    cardPrintings.mockResolvedValue(page([p("a", "lea"), p("b", "leb")]));
    deckSwapPrinting.mockRejectedValue(new Error("that deck is gone"));
    const user = userEvent.setup();
    renderDialog();
    open({ oracleId: "o1", name: "Sol Ring", deck: slot });

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
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

    await user.click(await screen.findByRole("button", { name: /LEB/ }));

    await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("b"));
    // **And no deck row travels with it.** The modal is opened from twelve surfaces; a pane left
    // anchored to some *other* card's deck slot would offer to swap that row onto this printing.
    expect(useAppStore.getState().paneDeckContext).toBeNull();
    expect(deckSwapPrinting).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
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
    open({ oracleId: "o1", name: "Sol Ring", deck: null });

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
    open({ oracleId: "o1", name: "Sol Ring", deck: slot });

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

    // The caret is on the panel — `DeckDialog` puts it there on open — so the press bubbles to
    // the panel's own handler, which is the only thing entitled to it. Waited for rather than
    // assumed: a press made while the caret is still on `<body>` reaches no handler at all, and
    // would read as the step being broken.
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(useAppStore.getState().printingsRequest).toEqual(WALK[2]));
    expect(useAppStore.getState().paneDeckContext).toEqual(WALK[2].deck);
    expect(useAppStore.getState().selectedCardId).toBe(WALK[2].deck.cardId);
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

    await waitFor(() => expect(useAppStore.getState().printingsRequest).toEqual(WALK[0]));
    expect(useAppStore.getState().paneDeckContext).toEqual(WALK[0].deck);
    expect(useAppStore.getState().selectedCardId).toBe(WALK[0].deck.cardId);
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
    open({ oracleId: "o-elsewhere", name: "Counterspell", deck: null });
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
    open({ oracleId: "o1", name: "Sol Ring", deck: { ...slot, deckId: 77 } });
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

    expect(useAppStore.getState().printingsRequest).toEqual(WALK[1]);
    expect(useAppStore.getState().paneDeckContext).toBeNull();
  });

  /**
   * **A focused `<select>` owns the arrow keys**, and this is the guard that would otherwise have
   * shipped.
   *
   * ArrowLeft on a focused `<select>` changes its value in Chromium and in WebView2 with it, so a
   * reader re-sorting the wall would step to another card as well — or instead, depending on which
   * handler answered. The sort control is the one on this row that is a native select.
   *
   * `focus()` and then `user.keyboard`, never `user.type`: `type` focuses whatever element it is
   * handed, so a test written that way passes for the wrong reason on a component that never
   * looked at the target at all.
   */
  it("yields the arrow keys to a focused select in the filter row", async () => {
    const user = userEvent.setup();
    renderDialog();
    withDeckWalk();
    open(WALK[1]);
    await screen.findByRole("dialog", { name: /Sol Ring/ });

    const sort = screen.getByRole("combobox", { name: "Sort printings by" });
    act(() => sort.focus());
    expect(sort).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");

    expect(useAppStore.getState().printingsRequest).toEqual(WALK[1]);
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
});
