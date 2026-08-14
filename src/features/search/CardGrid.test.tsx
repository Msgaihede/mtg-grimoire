import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { readDragData } from "@/features/decks/dnd";
import { IMAGE_RETRY_FLOOR_MS, IMAGE_RETRY_SPREAD_MS } from "@/lib/images";
import type { CardSummary, WishInput } from "@/lib/ipc";
import { startDrag } from "@/test-drag";

// The tiles carry a quick-add now, and a wish written from one is a real `invoke` — which
// in jsdom is a rejected promise about a missing Tauri runtime rather than a call anything
// here could read.
const wishlistAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionAdd: vi.fn(), wishlistAdd },
}));

import { CardGrid, columnsFor, tileWidthFor } from "./CardGrid";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { OwnedBadge } from "@/components/OwnedBadge";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { DEFAULT_ZOOM, scaled } from "@/lib/cardZoom";
import { parseFinishes } from "@/lib/finish";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The tile's trailing control, as `SearchPage` builds it.
 *
 * It lives at the call site now: the wall is generic over anything with a name, a set and a
 * number, and a quick-add needs two fields — the finishes this printing exists in, and the
 * oracle card it is of — that only a search row carries. A collection row has neither, and a
 * tile that guessed would offer a nonfoil entry for a foil-only printing.
 */
const quickAdd = (card: CardSummary) => (
  <AddToCollectionButton
    align="start"
    className={cn(REVEAL_ON_HOVER, "static")}
    target={{
      cardId: card.id,
      name: card.name,
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      oracleId: card.oracleId,
      finishes: parseFinishes(card.finishes),
    }}
  />
);

const card = (id: string, name: string, finishes = `["nonfoil","foil"]`): CardSummary => ({
  id,
  name,
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  price: 400.5,
  layout: "normal",
  oracleId: "o-bolt",
  finishes,
  // Off by default, which is what all but a few hundred of the corpus's cards are. The rows
  // that wear the crown say so by spreading this — see `SearchPage`'s `tileGameChanger` for
  // the one-line callback the wall is really handed.
  gameChanger: false,
  ownedQuantity: 0,
  wishlisted: false,
  printings: 1,
  priceLow: 400.5,
  priceHigh: 400.5,
});

/** The wall's own slot, exactly as `SearchPage` passes it: a field read, held still. */
const rowIsGameChanger = (c: CardSummary) => c.gameChanger;

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height
 * and renders an empty window. `@tanstack/react-virtual` sizes it with `offsetHeight` and
 * scrolls it with `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  // The wall's tile size is the reader's, and it lives in a module-level store that outlives a
  // render — so a test that zooms would hand the next one a 2× wall to measure.
  useAppStore.setState({ cardZoom: DEFAULT_ZOOM });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Long enough to cover the first dithered wait whatever `Math.random` returned. */
const PAST_THE_RETRY = IMAGE_RETRY_FLOOR_MS + IMAGE_RETRY_SPREAD_MS;

/** For the tests that open a quick-add popup, which is a mutation and wants a client. */
function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("CardGrid", () => {
  it("renders a card image per row, named for the card", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt"), card("bbb", "Lightning Helix")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    const bolt = screen.getByAltText("Lightning Bolt");
    // The alt text is what a screen reader and a failed load both fall back to, so it has
    // to be the card's name rather than "card image".
    expect(bolt).toBeInTheDocument();
    expect(bolt).toHaveAttribute("src", expect.stringContaining("/grid/aaa/0"));
    // *Not* `loading="lazy"`. The virtualiser already bounds the wall to the rows on screen
    // plus two, so the browser's own intersection gate has nothing left to save on a 117 k-row
    // browse — it only delays the two dozen images that are about to be looked at.
    expect(bolt).not.toHaveAttribute("loading");
  });

  /**
   * The tile's own root is what a caller may make draggable, and the art must not compete for
   * it: an `<img>` is draggable by default and the browser picks the *nearest* draggable
   * ancestor as a drag's source, so without this the deck editor's tile drag would never
   * start — the art would drag itself instead, carrying an `mtgimg:` URL that means nothing
   * anywhere.
   */
  it("hands a caller the tile's root element and keeps the art from stealing the drag", () => {
    const seen: [string, string][] = [];
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        tileRef={(c, el) => {
          if (el) seen.push([c.id, el.tagName]);
        }}
      />,
    );

    expect(seen).toEqual([["aaa", "DIV"]]);
    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("draggable", "false");
  });

  /**
   * A wall of cards is a drag source only where its caller says what a tile carries.
   *
   * Two halves of one contract, and the silent one is the first: the same wall draws the
   * search results *and* the collection, and only the search's tiles are printings a deck can
   * be built from — a collection tile is an *entry*, whose finish and condition a drop cannot
   * answer (spec §1's judgment call, from the other end). So the payload is a prop and a wall
   * given none registers nothing at all.
   */
  it("drags a tile only where the caller says what it carries", async () => {
    const inert = render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );
    expect(inert.container.querySelector('[draggable="true"]')).toBeNull();
    inert.unmount();

    const { container } = render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        dragPayload={(c) => ({
          kind: "card",
          cardId: c.id,
          name: c.name,
          typeLine: c.typeLine,
        })}
      />,
    );

    const tiles = [...container.querySelectorAll('[draggable="true"]')];
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toContainElement(screen.getByAltText("Lightning Bolt"));

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    const held = await startDrag(tiles[0]);
    await held.cancel();
    stop();

    expect(carried.map(readDragData)).toEqual([
      { kind: "card", cardId: "aaa", name: "Lightning Bolt", typeLine: "Instant" },
    ]);
  });

  it("opens the card that was clicked", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={onSelect}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    // Named exactly, because the tile now holds two buttons: the art, whose name is the
    // card, and the quick-add, whose name is the card plus what it does to it.
    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt" }));

    expect(onSelect).toHaveBeenCalledWith("aaa");
  });

  /**
   * A button inside a button is invalid HTML that React warns about and browsers render
   * unpredictably — so the tile is a wrapper, the art is one button and the quick-add is
   * another beside it in the caption.
   */
  it("puts a quick-add beside the art rather than inside it", async () => {
    const onSelect = vi.fn();
    wrap(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={onSelect}
        onNeedNextPage={vi.fn()}
        listKey="k"
        action={quickAdd}
      />,
    );

    const art = screen.getByRole("button", { name: "Lightning Bolt" });
    const add = screen.getByRole("button", { name: /^Add Lightning Bolt \(LEA 161\)/ });
    expect(art.contains(add)).toBe(false);

    await userEvent.click(add);

    // Adding a card is not opening it: the reader stays on the wall they were scanning.
    expect(await screen.findByRole("dialog", { name: "Add Lightning Bolt" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  /**
   * The tile's popup is built from the row, so it offers what the printing exists in — the
   * search DTO carries `finishes` for exactly this. Offering nonfoil for every tile is how
   * a foil-only printing takes a nonfoil entry, which then prices through a `usd` key its
   * blob does not have and quietly under-reports what the collection is worth.
   */
  it("offers a foil-only printing nothing but foil", async () => {
    wrap(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt", `["foil"]`)]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        action={quickAdd}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^Add Lightning Bolt/ }));

    const chips = within(await screen.findByRole("group", { name: "Finish" })).getAllByRole(
      "button",
    );
    expect(chips.map((c) => c.textContent)).toEqual(["Foil"]);
  });

  /**
   * A wall of art is where a reader decides they want a card, and a wish is usually for the
   * card rather than the cardboard — so the tile carries the oracle id that keys one.
   */
  it("wishes for any printing of the card the tile shows", async () => {
    wrap(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        action={quickAdd}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^Add Lightning Bolt/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Wishlist" }));
    await userEvent.click(screen.getByRole("button", { name: "Any printing" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));

    const wish = wishlistAdd.mock.calls[0][0] as WishInput;
    expect(wish).toMatchObject({ oracleId: "o-bolt", name: "Lightning Bolt" });
    // Naming the printing would pin the wish to it, which is the opposite of what was asked.
    expect(wish.cardId).toBeUndefined();
  });

  /**
   * A row is positioned *and* transformed, which makes it a stacking context: the popup's
   * own `z-20` cannot lift it over the next row, which paints later simply for being later
   * in the DOM — so the tiles below would be drawn over the open popup. The row it is open
   * in has to come forward, and `:has` is what says so where the stacking context is.
   */
  it("brings the row holding an open popup in front of the rows below it", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    const row = screen.getByRole("button", { name: "Lightning Bolt" }).closest(".absolute");
    expect(row).toHaveClass("has-[[aria-expanded=true]]:z-10");
  });

  /**
   * Hidden until the tile is hovered or holds the caret — 40 plus signs over a wall of art
   * is the wall competing with itself — but never removed from the tab order, because
   * "visible on hover" is not a state a keyboard has.
   */
  it("keeps the quick-add out of sight and in the tab order", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        action={quickAdd}
      />,
    );

    const add = screen.getByRole("button", { name: /^Add Lightning Bolt/ });
    expect(add.closest("span")).toHaveClass("opacity-0", "group-hover:opacity-100");
    expect(add).not.toHaveAttribute("tabindex", "-1");
  });

  /**
   * The two slots that make one wall serve two views. A badge is a fact about the *card* —
   * how many are owned — so it sits over the art rather than in a caption line that is
   * already a set, a number and a control at 12px; and it sits *outside* the button, because
   * inside it a wall of forty cards would be forty buttons named "Lightning Bolt ×3".
   */
  it("marks a tile without renaming the button underneath it", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        badge={(c) => <span>owned: {c.name}</span>}
      />,
    );

    const art = screen.getByRole("button", { name: "Lightning Bolt" });
    const badge = screen.getByText(/owned: Lightning Bolt/);
    expect(badge).toBeInTheDocument();
    expect(art.contains(badge)).toBe(false);
    expect(art).toHaveAccessibleName("Lightning Bolt");

    // The corner is the wall's, not the badge's: every caller hands over a plain inline mark
    // and this is the one place that decides where a mark goes, so two views cannot drift
    // into two corners.
    expect(badge.parentElement).toHaveClass("absolute", "bottom-1", "left-1");
  });

  /**
   * The corner takes its own pointer events — which is what lets a `title` on the mark inside
   * it surface at all — and pays for that by opening the card itself.
   *
   * It used to be `pointer-events-none`, so the press fell through to the art and the whole
   * tile was one target. A tooltip cannot come out of an element that receives no pointer
   * events, and these marks are abbreviations (`×3`, a heart) whose plain words are exactly
   * what a reader hovers for. So both corners answer a click with the same `onSelect` the
   * button underneath would have: hoverable, and not a dead spot.
   */
  it("opens the card from a mark's corner, which is hoverable rather than click-through", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={onSelect}
        onNeedNextPage={vi.fn()}
        listKey="k"
        badge={(c) => <span title="3 in your collection">×{c.printings}</span>}
        topLeft={() => <span title="3 printings matched these filters">×3</span>}
      />,
    );

    const bottomLeft = screen.getByTitle("3 in your collection").parentElement!;
    const topLeft = screen.getByTitle("3 printings matched these filters").parentElement!;
    expect(bottomLeft).toHaveClass("pointer-events-auto");
    expect(topLeft).toHaveClass("pointer-events-auto");

    await userEvent.click(bottomLeft);
    await userEvent.click(topLeft);

    expect(onSelect.mock.calls).toEqual([["aaa"], ["aaa"]]);
  });

  /**
   * The Commander bracket's crown, in the chip the finish mark already owns.
   *
   * Drawn from the wall's own slot rather than from a field on `GridCard`, for the reason the
   * `finish` slot beside it exists: the search's rows carry the fact and a mapped collection
   * row does not, so a wall that guessed would crown nothing or everything.
   *
   * `hidden: true`, because the whole overlay the chip sits in is `aria-hidden` — it is inside
   * the tile's button, where any text of its own would join the button's accessible name and
   * make a wall of game changers forty buttons called "… Game changer". Which is the other
   * half of this test.
   */
  it("crowns a game changer's tile, and leaves an ordinary card's alone", () => {
    render(
      <CardGrid
        rows={[
          { ...card("aaa", "Rhystic Study"), gameChanger: true },
          card("bbb", "Lightning Bolt"),
        ]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        gameChanger={rowIsGameChanger}
      />,
    );

    const crowns = screen.getAllByRole("img", { name: GAME_CHANGER_LABEL, hidden: true });
    expect(crowns).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Rhystic Study" })).toContainElement(crowns[0]);
    expect(screen.getByRole("button", { name: "Rhystic Study" })).toHaveAccessibleName(
      "Rhystic Study",
    );
  });

  /**
   * And the fact stated in words, because the chip that draws it is decoration: the caption is
   * a *sibling* of the button, so a sentence here reaches a screen reader without renaming
   * forty tiles. The same treatment the finish word gets, one line above it.
   */
  it("states the crown in the caption, where the art's chip cannot", () => {
    render(
      <CardGrid
        rows={[{ ...card("aaa", "Rhystic Study"), gameChanger: true }]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        gameChanger={rowIsGameChanger}
      />,
    );

    const stated = screen.getByText(`, ${GAME_CHANGER_LABEL}`);
    expect(stated).toHaveClass("sr-only");
    // In the caption beside the set and number, not inside the button that names the card.
    expect(screen.getByRole("button", { name: "Rhystic Study" })).not.toContainElement(stated);
  });

  /** A wall told nothing crowns nothing — the collection's, which has no such fact to give. */
  it("crowns no tile at all when the caller passes no answer", () => {
    render(
      <CardGrid
        rows={[{ ...card("aaa", "Rhystic Study"), gameChanger: true }]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    expect(
      screen.queryByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(`, ${GAME_CHANGER_LABEL}`)).not.toBeInTheDocument();
  });

  /**
   * The corner exists for a mark, so a mark with nothing to say takes the corner with it —
   * on a search of 116 k cards almost every tile owns none and wishes for none, and a wall of
   * empty backings is forty stickers saying nothing.
   *
   * Both shapes of "nothing", because they reach here differently: a callback that returns
   * `null` never builds an element, while `OwnedBadge` (which every real caller hands over
   * unconditionally) *is* a truthy element that renders nothing — React cannot be asked which
   * before it runs, so `empty:hidden` on the backing is what answers for the second case.
   */
  it("draws no corner for a mark with nothing to say", () => {
    const { container, rerender } = render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        badge={() => null}
      />,
    );
    expect(container.querySelector('[class*="bg-bg/85"]')).toBeNull();

    rerender(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        badge={() => <OwnedBadge owned={0} />}
      />,
    );
    const corner = container.querySelector('[class*="bg-bg/85"]');
    expect(corner).toBeEmptyDOMElement();
    expect(corner).toHaveClass("empty:hidden");
  });

  /** The wall says what it is a wall of — the search's results, or somebody's collection. */
  it("takes the name of the list it is showing", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        label="Your collection"
      />,
    );

    expect(screen.getByRole("group", { name: "Your collection" })).toBeInTheDocument();
  });

  /**
   * The self-healing half of the rate limit. A 429 anywhere in the image fetcher makes
   * every uncached tile fail fast with a 503, and a plain `<img>` that errors once shows
   * a broken tile for the rest of the session — the art never comes back, even though the
   * lockout ends in half a minute.
   */
  it("keeps a failed tile readable and fetches it again after the rate-limit floor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    fireEvent.error(screen.getByAltText("Lightning Bolt"));

    // The tile is still a card, not a broken-image icon: the name is what the reader came
    // for and it is known without the art.
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();

    // Retrying inside the window is what Scryfall escalates to bans over.
    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_FLOOR_MS - 1));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    const retried = screen.getByAltText("Lightning Bolt");
    expect(retried).toHaveAttribute("src", expect.stringContaining("/grid/aaa/0"));
  });

  /**
   * The first retry lands 30 s in, which is inside any lockout longer than the floor —
   * a real `Retry-After: 60` fails it against a gate that is still shut. Spending the
   * only attempt there is how a self-healing tile stops healing, so it re-arms once more
   * at double the wait.
   */
  it("re-arms once at double the delay when the first retry lands in the lockout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    fireEvent.error(screen.getByAltText("Lightning Bolt"));

    // Not on the first schedule again: the second wait is twice the floor, which is past
    // the 60 s lockout that swallowed the first one.
    await act(async () => void vi.advanceTimersByTime(2 * IMAGE_RETRY_FLOOR_MS - 1));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(IMAGE_RETRY_SPREAD_MS + 1));
    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute(
      "src",
      expect.stringContaining("/grid/aaa/0"),
    );
  });

  it("stops after those two retries rather than hammering a protocol that is saying no", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    await act(async () => void vi.advanceTimersByTime(2 * PAST_THE_RETRY));
    fireEvent.error(screen.getByAltText("Lightning Bolt"));

    // Ten minutes later, still no fourth request: a tile that has failed three times over
    // five minutes is a tile whose card has no art the app can reach, and 40 of them
    // polling forever is the herd the backoff exists to prevent. Scrolling it out of view
    // and back is what asks again, because that is a reader saying "now".
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  it("leaves nothing scheduled once a tile has its art", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    // One timer per tile, never a queue of them.
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    fireEvent.load(screen.getByAltText("Lightning Bolt"));

    // The retry landed, so the schedule is spent: nothing is left to fire into a tile
    // that is already showing its card.
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getByAltText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * Tiles are keyed by their slot in the grid rather than by card id — two pages fetched
   * either side of a sync can carry one printing twice, and a duplicate React key drops a
   * card. So a new search reuses the component that failed, and its failure has to leave
   * with the card it belonged to.
   */
  it("gives a new card in a reused slot its own attempt", () => {
    const props = { onSelect: vi.fn(), onNeedNextPage: vi.fn(), listKey: "k" };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    rerender(<CardGrid rows={[card("ccc", "Ancestral Recall")]} {...props} listKey="k2" />);

    expect(screen.getByAltText("Ancestral Recall")).toHaveAttribute(
      "src",
      expect.stringContaining("/grid/ccc/0"),
    );
  });

  /**
   * The same slot reuse seen from the other side, and the one a reader actually complains
   * about: a browser keeps painting an `<img>`'s last decoded frame until the new `src`
   * decodes, so a wall whose rows are reused shows the *previous* search's art under the new
   * search's captions for as long as the fetch takes. The art has to leave with the card.
   */
  it("never leaves the last card's art in a slot it has handed to another card", () => {
    const props = { onSelect: vi.fn(), onNeedNextPage: vi.fn(), listKey: "k" };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);
    const before = screen.getByAltText("Lightning Bolt");

    rerender(<CardGrid rows={[card("ccc", "Ancestral Recall")]} {...props} listKey="k2" />);

    expect(screen.getByAltText("Ancestral Recall")).not.toBe(before);
    expect(before).not.toBeInTheDocument();
  });

  /** The other half: a wall that replaced its images every render would flicker constantly. */
  it("keeps a tile's art across a re-render that did not change the card", () => {
    const props = { onSelect: vi.fn(), onNeedNextPage: vi.fn(), listKey: "k" };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);
    const before = screen.getByAltText("Lightning Bolt");

    rerender(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);

    expect(screen.getByAltText("Lightning Bolt")).toBe(before);
  });

  /**
   * Both halves of the layout, away from the component: jsdom measures every container at
   * zero, so the only place this arithmetic can be exercised is on its own.
   */
  it("never asks for fewer than one column, however narrow the container", () => {
    // A container measured before layout settles, and one too narrow for a whole tile.
    // Zero columns divides the row count by zero and hands the virtualizer `Infinity`.
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(100)).toBe(1);
    expect(tileWidthFor(0)).toBeGreaterThan(0);
  });

  it("fits whole tiles across, then shares the leftover out so the wall reaches both edges", () => {
    expect(columnsFor(352)).toBe(2); // exactly two minimum-width tiles and a gap
    expect(columnsFor(363)).toBe(2); // and a strip too narrow to be a third
    expect(columnsFor(534)).toBe(3);

    const columns = columnsFor(1200);
    const tile = tileWidthFor(1200);
    // No gutter left over at the right edge, and no tile narrower than the minimum that
    // decided the column count in the first place.
    expect(columns * tile + (columns - 1) * 12).toBeCloseTo(1200);
    expect(tile).toBeGreaterThanOrEqual(170);
  });

  /**
   * The one wall that is not a page-width wall: the deck editor's docked panel measures 331px
   * inside the panel's own padding, the scrollbar and this wall's padding — 330 in the running
   * window — which is 23 short of two standard tiles, so it drew one 330px card per row in a
   * 341px-tall column, less than a whole card ever on screen. The floor is a prop for exactly
   * that, and the numbers here are the measured ones.
   */
  it("fits two tiles in the deck panel's column when it is given a lower floor", () => {
    expect(columnsFor(330)).toBe(1);
    expect(columnsFor(330, 150)).toBe(2);
    // Still a floor and not a width: the pair share out the whole column, gap included — 159px
    // each, which is what the running window measures.
    expect(tileWidthFor(330, 150)).toBeCloseTo(159);
  });

  /**
   * The zoom is arithmetic on the **floor**, and this is the whole of it: a bigger floor fits
   * fewer columns across the same wall, and the tiles then share out the leftover — so zooming
   * in grows every tile *and* the wall still reaches both edges. That flushness is the reason
   * the floor is the seam; a scaled tile would have left a widening gutter down one side.
   *
   * On the exported pair rather than through a render, for the reason the two tests above are:
   * jsdom measures every container at zero, so a 1200px wall exists nowhere else.
   */
  it("fits fewer, larger tiles across the same wall as the reader zooms in", () => {
    expect(columnsFor(1200, scaled(170, 0.5))).toBe(12);
    expect(columnsFor(1200, scaled(170, DEFAULT_ZOOM))).toBe(6);
    expect(columnsFor(1200, scaled(170, 2))).toBe(3);

    for (const zoom of [0.5, DEFAULT_ZOOM, 1.25, 2]) {
      const floor = scaled(170, zoom);
      const columns = columnsFor(1200, floor);
      const tile = tileWidthFor(1200, floor);
      // Flush at every zoom, and never a tile narrower than the floor that decided the count.
      expect(columns * tile + (columns - 1) * 12).toBeCloseTo(1200);
      expect(tile).toBeGreaterThanOrEqual(floor);
    }
  });

  /**
   * A wall given its own floor is scaled by the same factor, so the deck editor's docked column
   * zooms with the rest of the app instead of staying at the size it was scoped for. The numbers
   * are that panel's measured 331px column: one card at 2×, three at 0.5×, and the column full
   * either way.
   */
  it("scales a wall's own floor with the zoom rather than pinning it", () => {
    expect(scaled(150, 2)).toBe(300);

    expect(columnsFor(330, scaled(150, 2))).toBe(1);
    expect(tileWidthFor(330, scaled(150, 2))).toBeCloseTo(330);

    expect(columnsFor(330, scaled(150, 0.5))).toBe(3);
    expect(tileWidthFor(330, scaled(150, 0.5))).toBeCloseTo(102);
  });

  /**
   * The store is this wall's only zoom input, and that is the point of putting it here: the
   * search, the collection and the deck panel are all this component, so they are one setting
   * rather than three, and not one of those call sites passes anything.
   *
   * jsdom measures the container at zero and `tileWidthFor` answers a zero-width wall with its
   * floor — so the width drawn on a tile here *is* the scaled floor, which is the number under
   * test. Live, rather than at mount, because a reader zooms while looking at the wall.
   */
  it("resizes its tiles when the reader zooms, with no call site involved", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );
    const tile = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".group");

    expect(tile()).toHaveStyle({ width: "170px" });

    act(() => useAppStore.setState({ cardZoom: 2 }));
    expect(tile()).toHaveStyle({ width: "340px" });

    act(() => useAppStore.setState({ cardZoom: 0.5 }));
    expect(tile()).toHaveStyle({ width: "85px" });
  });

  /**
   * The caption grows with the tiles and never shrinks below them, and the asymmetry is
   * arithmetic rather than taste: nothing *in* the strip scales — it is a 24px quick-add beside
   * 12px text at every zoom. The row's height is what the virtualiser positions rows from, so a
   * strip budgeted under the height of its own contents is a wall whose rows overlap.
   */
  it("grows the caption with the tiles but never below what stands in it", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );
    const row = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".absolute");

    // A 170px card is 238px of art, under the measured 28px strip.
    expect(row()).toHaveStyle({ height: "266px" });

    // Twice the card is twice the strip: 476 of art and 56 of caption.
    act(() => useAppStore.setState({ cardZoom: 2 }));
    expect(row()).toHaveStyle({ height: "532px" });

    // Half the card is *not* half the strip: 119 of art and the same 28, because the button in
    // the caption is 24px whatever the tiles are doing.
    act(() => useAppStore.setState({ cardZoom: 0.5 }));
    expect(row()).toHaveStyle({ height: "147px" });
  });

  /**
   * The gesture is on the **scroller**, which is the element the pointer is over: the sizer
   * inside it sits within this wall's padding and the rows on top of that are positioned
   * absolutely, so a wheel over the padding — or in the gap between two rows — would miss a
   * listener bound any further in.
   *
   * Directional rather than exact on purpose. How far one notch moves the zoom, and where the
   * range stops, are `useCardZoomGesture`'s and are tested there; what belongs to this wall is
   * that the element the reader is over is the element listening, and that an ordinary scroll
   * is still an ordinary scroll.
   */
  it("zooms on ctrl+wheel over the scroller and leaves a plain scroll alone", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
      />,
    );
    const scroller = screen.getByRole("group", { name: "Search results" });

    // A wall of cards is a thing readers scroll, and 117 k results is a lot of scrolling.
    fireEvent.wheel(scroller, { deltaY: -240 });
    expect(useAppStore.getState().cardZoom).toBe(DEFAULT_ZOOM);

    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: -240 });
    expect(useAppStore.getState().cardZoom).toBeGreaterThan(DEFAULT_ZOOM);

    act(() => useAppStore.setState({ cardZoom: DEFAULT_ZOOM }));
    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: 240 });
    expect(useAppStore.getState().cardZoom).toBeLessThan(DEFAULT_ZOOM);
  });

  it("asks for the next page once the reader is near the bottom of the loaded rows", () => {
    const onNeedNextPage = vi.fn();
    // Two rows of one column each, both rendered: the last tile on screen is also the
    // last tile there is, which is as deep as a reader can get.
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt"), card("bbb", "Lightning Helix")]}
        onSelect={vi.fn()}
        onNeedNextPage={onNeedNextPage}
        listKey="k"
      />,
    );

    expect(onNeedNextPage).toHaveBeenCalled();
  });
});
