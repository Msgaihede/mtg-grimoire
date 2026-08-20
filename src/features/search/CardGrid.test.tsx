import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { ReactElement } from "react";
import { readDragData } from "@/features/decks/dnd";
import { IMAGE_RETRY_FLOOR_MS, IMAGE_RETRY_SPREAD_MS, WALL_CARD_VARIANT } from "@/lib/images";
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

import { CardGrid, columnsFor, sideGutterFor, tileWidthFor } from "./CardGrid";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { OwnedBadge } from "@/components/OwnedBadge";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import {
  DEFAULT_SECTION_ZOOMS,
  DEFAULT_ZOOM,
  ZOOM_STEPS,
  scaled,
  type ZoomSection,
} from "@/lib/cardZoom";
import { consumeCaretNote } from "@/lib/caretWalk";
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
 * One section's zoom, with the other three left at their default.
 *
 * `setState({ cardZoom: 2 })` was the whole of this and no longer type-checks: `cardZoom` is a
 * number *per card section* now, so a test has to say which wall it is talking about. Spreading
 * the defaults rather than patching what is there is deliberate — it makes every write from here
 * a statement about all four sections, so a test that means "only this one moved" cannot be read
 * against whatever the previous line left behind.
 */
const setZoom = (section: ZoomSection, zoom: number) =>
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, [section]: zoom } });

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
  // render — so a test that zooms would hand the next one a 2× wall to measure. **Every**
  // section, not this file's own: the walls here are `search`, but a sibling suite that left
  // `collection` at 2× would be measured by the two tests below that render one.
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS } });
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
        zoomSection="search"
      />,
    );

    const bolt = screen.getByAltText("Lightning Bolt");
    // The alt text is what a screen reader and a failed load both fall back to, so it has
    // to be the card's name rather than "card image".
    expect(bolt).toBeInTheDocument();
    expect(bolt).toHaveAttribute("src", expect.stringContaining(`/${WALL_CARD_VARIANT}/aaa/0`));
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
    // 4px in from the corner on a card at 100% zoom, and scaled with it — a fixed inset walks the
    // mark toward the middle of a doubled card and off the edge of a halved one.
    expect(badge.parentElement).toHaveClass(
      "absolute",
      "bottom-[calc(0.25rem*var(--mark-scale,1))]",
      "left-[calc(0.25rem*var(--mark-scale,1))]",
    );
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
        zoomSection="search"
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
    expect(retried).toHaveAttribute("src", expect.stringContaining(`/${WALL_CARD_VARIANT}/aaa/0`));
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
        zoomSection="search"
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
      expect.stringContaining(`/${WALL_CARD_VARIANT}/aaa/0`),
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
        zoomSection="search"
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
        zoomSection="search"
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
    const props = {
      onSelect: vi.fn(),
      onNeedNextPage: vi.fn(),
      listKey: "k",
      // `as const`, because a spread object's `"search"` widens to `string` and the wall's
      // prop is the union — the whole point of it being one.
      zoomSection: "search" as const,
    };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    rerender(<CardGrid rows={[card("ccc", "Ancestral Recall")]} {...props} listKey="k2" />);

    expect(screen.getByAltText("Ancestral Recall")).toHaveAttribute(
      "src",
      expect.stringContaining(`/${WALL_CARD_VARIANT}/ccc/0`),
    );
  });

  /**
   * The same slot reuse seen from the other side, and the one a reader actually complains
   * about: a browser keeps painting an `<img>`'s last decoded frame until the new `src`
   * decodes, so a wall whose rows are reused shows the *previous* search's art under the new
   * search's captions for as long as the fetch takes. The art has to leave with the card.
   */
  it("never leaves the last card's art in a slot it has handed to another card", () => {
    const props = {
      onSelect: vi.fn(),
      onNeedNextPage: vi.fn(),
      listKey: "k",
      // `as const`, because a spread object's `"search"` widens to `string` and the wall's
      // prop is the union — the whole point of it being one.
      zoomSection: "search" as const,
    };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);
    const before = screen.getByAltText("Lightning Bolt");

    rerender(<CardGrid rows={[card("ccc", "Ancestral Recall")]} {...props} listKey="k2" />);

    expect(screen.getByAltText("Ancestral Recall")).not.toBe(before);
    expect(before).not.toBeInTheDocument();
  });

  /** The other half: a wall that replaced its images every render would flicker constantly. */
  it("keeps a tile's art across a re-render that did not change the card", () => {
    const props = {
      onSelect: vi.fn(),
      onNeedNextPage: vi.fn(),
      listKey: "k",
      // `as const`, because a spread object's `"search"` widens to `string` and the wall's
      // prop is the union — the whole point of it being one.
      zoomSection: "search" as const,
    };
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

  it("fits whole tiles across and centres the leftover rather than filling with it", () => {
    expect(columnsFor(352)).toBe(2); // exactly two tiles and a gap
    expect(columnsFor(363)).toBe(2); // and a strip too narrow to be a third
    expect(columnsFor(534)).toBe(3);

    const columns = columnsFor(1200);
    const tile = tileWidthFor(1200);
    // The tile is the size asked for — not a share of the row — so the row does not fill the
    // wall, and what it does not use is split either side of it.
    expect(tile).toBe(170);
    const used = columns * tile + (columns - 1) * 12;
    expect(used).toBeLessThan(1200);
    expect(sideGutterFor(1200)).toBeCloseTo((1200 - used) / 2);
    // Which is the whole of it: the row plus its two gutters is the wall, to the pixel.
    expect(used + 2 * sideGutterFor(1200)).toBeCloseTo(1200);
  });

  /**
   * The one wall that is not a page-width wall: the deck editor's docked panel measures 331px
   * inside the panel's own padding, the scrollbar and this wall's padding — 330 in the running
   * window — which is 23 short of two standard tiles, so it drew one 330px card per row in a
   * 341px-tall column, less than a whole card ever on screen. The base is a prop for exactly
   * that, and the numbers here are the measured ones.
   */
  it("fits two tiles in the deck panel's column when it is given a smaller base", () => {
    expect(columnsFor(330)).toBe(1);
    expect(columnsFor(330, 150)).toBe(2);
    // The pair are 150 each and the column keeps the 18px they leave, 9 down each side.
    expect(tileWidthFor(330, 150)).toBe(150);
    expect(sideGutterFor(330, 150)).toBeCloseTo(9);
  });

  /**
   * **The defect this change is about.** The zoom used to move a *floor*, and the tiles then
   * stretched to share out the row — so the drawn width was a function of the column count,
   * which is a step function of the zoom. On this panel's 331px column the ten stops of
   * `ZOOM_STEPS` collapsed to three distinct widths (102, 102, 159, 159, 159, 331, 331, 331,
   * 331, 331): seven gestures in a row that moved nothing on screen.
   *
   * Sized directly, every stop is its own width. That is the assertion — ten stops, ten answers,
   * each strictly bigger than the last — and it is the one a floor cannot pass.
   *
   * On the exported functions rather than through a render, for the reason the tests around it
   * are: jsdom measures every container at zero, so a 331px wall exists nowhere else.
   */
  it("draws a different tile at every stop on the ladder, not only where a column is lost", () => {
    const widths = ZOOM_STEPS.map((zoom) => tileWidthFor(331, scaled(150, zoom)));

    expect(widths).toEqual([75, 101, 113, 135, 150, 165, 188, 225, 263, 300]);
    expect(new Set(widths).size).toBe(ZOOM_STEPS.length);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
  });

  /**
   * The count is what falls out of the size, and the wall stays centred at every one of them.
   */
  it("fits fewer, larger tiles across the same wall as the reader zooms in", () => {
    expect(columnsFor(1200, scaled(170, 0.5))).toBe(12);
    expect(columnsFor(1200, scaled(170, DEFAULT_ZOOM))).toBe(6);
    expect(columnsFor(1200, scaled(170, 2))).toBe(3);

    for (const zoom of ZOOM_STEPS) {
      const size = scaled(170, zoom);
      const columns = columnsFor(1200, size);
      const tile = tileWidthFor(1200, size);
      // The tile is exactly what the zoom asked for, and the row sits centred in the wall.
      expect(tile).toBe(size);
      expect(columns * tile + (columns - 1) * 12 + 2 * sideGutterFor(1200, size)).toBeCloseTo(1200);
      expect(sideGutterFor(1200, size)).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * A wall given its own base is scaled by the same factor, so the deck editor's docked column
   * zooms with the rest of the app instead of staying at the size it was scoped for. The numbers
   * are that panel's measured 331px column: one 300px card at 2×, three 75px ones at 0.5×.
   */
  it("scales a wall's own base with the zoom rather than pinning it", () => {
    expect(scaled(150, 2)).toBe(300);

    expect(columnsFor(330, scaled(150, 2))).toBe(1);
    expect(tileWidthFor(330, scaled(150, 2))).toBe(300);
    expect(sideGutterFor(330, scaled(150, 2))).toBeCloseTo(15);

    expect(columnsFor(330, scaled(150, 0.5))).toBe(3);
    expect(tileWidthFor(330, scaled(150, 0.5))).toBe(75);
  });

  /**
   * The one case the cap exists for, and the reason it is a cap rather than an assertion: a
   * reader who zooms a narrow column past its own width. `columnsFor` floors at one column
   * whatever the arithmetic says, so without the clamp the tile would be wider than the box it
   * is in — and the deck editor is `overflow-y-auto`, which computes `overflow-x` to `auto`, so a
   * 300px card in a 206px column is a horizontal scrollbar across the whole deck builder. That is
   * the one thing the app's 1024px floor forbids, and it arrives with nothing on screen naming
   * the culprit.
   */
  it("never draws a tile wider than the wall it is in", () => {
    // `MIN_PANEL_WIDTH_PX` (206) less the panel's chrome is one 150px tile — at 2× the reader is
    // asking for 300 in a box that holds 150.
    expect(columnsFor(150, 300)).toBe(1);
    expect(tileWidthFor(150, 300)).toBe(150);
    expect(sideGutterFor(150, 300)).toBe(0);
  });

  /**
   * The store is this wall's only zoom *value*, and the only thing a call site supplies is which
   * of the four sections it is asking about — the search, the collection and the deck panel are
   * all this component, and they are three settings on purpose (see the two tests after this
   * one). What is asserted here is unchanged by that: the number in the store reaches the tiles.
   *
   * jsdom measures the container at zero and `tileWidthFor` answers a zero-width wall with its
   * floor — so the width drawn on a tile here *is* the scaled floor, which is the number under
   * test. Live, rather than at mount, because a reader zooms while looking at the wall.
   */
  it("resizes its tiles when its own section's zoom moves", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );
    const tile = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".group");

    expect(tile()).toHaveStyle({ width: "170px" });

    act(() => setZoom("search", 2));
    expect(tile()).toHaveStyle({ width: "340px" });

    act(() => setZoom("search", 0.5));
    expect(tile()).toHaveStyle({ width: "85px" });
  });

  /**
   * The defect this whole change is about, seen from the wall's end: a gesture belongs to the
   * section the pointer is over and to nothing else. It was one number for every card surface,
   * so a reader sizing up the deck editor's docked search column was resizing the deck laid out
   * beside it — two questions asked in the same second, answered together when only one was
   * asked.
   *
   * Rendered rather than done on the exported `columnsFor`/`tileWidthFor` pair, unlike the four
   * arithmetic tests above, because the arithmetic is not what changed: *which* number is fed to
   * it is, and only a mounted wall reads that. The `ResizeObserver` in `src/test-setup.ts` is a
   * no-op, so the container measures 0 and `tileWidthFor` answers a zero-width wall with its
   * floor — the width on a tile here *is* the scaled floor, which is exactly the number under
   * test. Driven through `zoomCards`, the store's one door, rather than through `setZoom`: a
   * gesture is what has to land on one section, and the action is where that is decided.
   */
  it("leaves its tiles alone when another section is zoomed", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );
    const tile = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".group");

    expect(tile()).toHaveStyle({ width: "170px" });

    // Three real gestures, one on each of the other sections. Every one of them is a store
    // write the badge counts, and not one of them is about this wall.
    act(() => {
      const { zoomCards } = useAppStore.getState();
      zoomCards("collection", 1);
      zoomCards("deckSearch", 1);
      zoomCards("deck", -1);
    });
    expect(useAppStore.getState().cardZoom.collection).toBeGreaterThan(DEFAULT_ZOOM);
    expect(useAppStore.getState().cardZoom.deck).toBeLessThan(DEFAULT_ZOOM);
    expect(tile()).toHaveStyle({ width: "170px" });

    // And the half that must still work: its own section moves it. One stop up from 1× is
    // 1.1, and 170 at 1.1 is 187.
    act(() => useAppStore.getState().zoomCards("search", 1));
    expect(tile()).toHaveStyle({ width: "187px" });
  });

  /**
   * The read half of the same rule: a wall draws at *its own* section's stored size, not at
   * whatever the last gesture anywhere left behind. Two walls of one component over one row,
   * differing in nothing but the prop — which is the whole of what a section is here.
   *
   * It is also what makes "each section remembers its own zoom" true across a remount: the
   * collection wall below has never been rendered before and comes up at 2× because that is
   * where the reader left the collection, which is why the value stayed in the store when the
   * key moved into a prop.
   */
  it("draws at its own section's stored zoom rather than another section's", () => {
    // No `act`, and none is owed: nothing is mounted yet, so this is the state both walls
    // below are *born* into rather than a change either of them has to react to.
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: 0.5, collection: 2 } });
    const tile = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".group");

    const searchWall = render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );
    expect(tile()).toHaveStyle({ width: "85px" });
    searchWall.unmount();

    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        label="Your collection"
        zoomSection="collection"
      />,
    );
    expect(tile()).toHaveStyle({ width: "340px" });
  });

  /**
   * The caption grows with the tiles and never shrinks below them, and the asymmetry is
   * arithmetic rather than taste: nothing *in* the strip scales — it is a 24px quick-add beside
   * 12px text at every zoom. The row's height is what the virtualiser positions rows from, so a
   * strip budgeted under the height of its own contents is a wall whose rows overlap.
   */
  /**
   * **The tile is where the reader's zoom becomes something a mark can read**, and this is the only
   * place in the suite that can say so.
   *
   * Every mark drawn on a card — the owned badge in the corner, the printings chip opposite it, the
   * finish chip and crown `CardArt` lays over the art, the gem and the quick-add in the caption —
   * sizes itself against `--mark-scale`/`--control-scale` rather than against a prop, because each
   * of those components is *also* drawn in a table or in the card pane, where nothing zooms. Those
   * surfaces set no variable and take the `, 1` fallback. So the wiring is: this element publishes
   * the pair, and everything inside it inherits them.
   *
   * **What this cannot check is that any of it worked.** jsdom has no layout engine and resolves no
   * `calc()`, so a mark whose class was mistyped — and a mistyped Tailwind arbitrary value emits no
   * rule at all, silently — reads exactly like a correct one here. This pins the half a test can
   * see: that the tile publishes the numbers, and that they are the section's own zoom rather than
   * some other wall's.
   */
  it("publishes the card's scale to every mark drawn on it", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );
    // The tile is the button's grandparent: the button is the art, its parent is the box the
    // corners are positioned against, and the tile is the card — art, corners and caption.
    const tile = () =>
      screen.getByRole("button", { name: "Lightning Bolt" }).parentElement!.parentElement!;

    expect(tile().style.getPropertyValue("--mark-scale")).toBe("1");
    expect(tile().style.getPropertyValue("--control-scale")).toBe("0.85");

    act(() => setZoom("search", 2));
    expect(tile().style.getPropertyValue("--mark-scale")).toBe("2");
    expect(tile().style.getPropertyValue("--control-scale")).toBe("1.7");

    // Down as well as up. This is the direction the marks did not follow before — and the
    // direction three separate budgets used to refuse to follow either.
    act(() => setZoom("search", 0.5));
    expect(tile().style.getPropertyValue("--mark-scale")).toBe("0.5");

    // Another section's gesture is not this wall's: the value is read from `zoomSection`.
    act(() => setZoom("collection", 2));
    expect(tile().style.getPropertyValue("--mark-scale")).toBe("1");
  });

  it("moves the caption with the tiles in both directions", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        zoomSection="search"
      />,
    );
    const row = () => screen.getByRole("button", { name: "Lightning Bolt" }).closest(".absolute");

    // A 170px card is 238px of art, under a 25px strip — the quick-add trigger at `CONTROL_SHRINK`
    // (24 × 0.85, ceiled to 21) plus the tile's own 4px gap.
    expect(row()).toHaveStyle({ height: "263px" });

    // Twice the card is twice the strip: 476 of art and 50 of caption.
    act(() => setZoom("search", 2));
    expect(row()).toHaveStyle({ height: "526px" });

    // **And half the card is half the strip**, which is the reversal: 119 of art and 13 of
    // caption. It used to hold at 28 here, because the button and the type in that strip were
    // fixed sizes and a halved budget would have been shorter than its own contents. Both scale
    // now, so the floor would be 28px of strip around 6px of type on an 85px card.
    act(() => setZoom("search", 0.5));
    expect(row()).toHaveStyle({ height: "132px" });
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
        zoomSection="search"
      />,
    );
    const scroller = screen.getByRole("group", { name: "Search results" });

    // A wall of cards is a thing readers scroll, and 117 k results is a lot of scrolling.
    fireEvent.wheel(scroller, { deltaY: -240 });
    expect(useAppStore.getState().cardZoom.search).toBe(DEFAULT_ZOOM);

    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: -240 });
    expect(useAppStore.getState().cardZoom.search).toBeGreaterThan(DEFAULT_ZOOM);

    act(() => setZoom("search", DEFAULT_ZOOM));
    fireEvent.wheel(scroller, { ctrlKey: true, deltaY: 240 });
    expect(useAppStore.getState().cardZoom.search).toBeLessThan(DEFAULT_ZOOM);
  });

  /**
   * And the section the listener writes to is the wall's own, rather than a literal the hook
   * call was given once. The wall above is the `search` one, which a hard-coded `"search"` would
   * pass just as happily — so this is the same gesture over a `collection` wall, which is the
   * cheapest thing that can tell the two apart. The other three sections are asserted still at
   * their default, because "zooms this one" and "zooms only this one" are two claims.
   */
  it("writes the gesture to the section the wall was told it is", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        listKey="k"
        label="Your collection"
        zoomSection="collection"
      />,
    );

    fireEvent.wheel(screen.getByRole("group", { name: "Your collection" }), {
      ctrlKey: true,
      deltaY: -240,
    });

    const { cardZoom } = useAppStore.getState();
    expect(cardZoom.collection).toBeGreaterThan(DEFAULT_ZOOM);
    expect(cardZoom.search).toBe(DEFAULT_ZOOM);
    expect(cardZoom.deckSearch).toBe(DEFAULT_ZOOM);
    expect(cardZoom.deck).toBe(DEFAULT_ZOOM);
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
        zoomSection="search"
      />,
    );

    expect(onNeedNextPage).toHaveBeenCalled();
  });
});

/**
 * The arrow keys, on the two walls that ask for them.
 *
 * **What can honestly be asserted here is the wiring and nothing about direction.** jsdom has no
 * layout engine: `src/test-setup.ts` stubs `ResizeObserver` to a no-op, so this wall measures
 * itself at 0px, `columnsFor` floors at one column, and every tile is its own row. Up and down
 * are therefore ±1 here exactly as left and right are, and a test written against a two-column
 * wall would be a test of a grid that does not exist in this process. The grid cases — the row
 * boundary, the part-full last row, the clamp — live in `gridNav.test.ts`, where the column count
 * is an argument rather than a measurement.
 *
 * Every press below goes through `userEvent.keyboard` on a caret placed by hand, never
 * `userEvent.type`: `type` focuses whatever element it is handed, so a focus assertion after it
 * passes whether or not anything moved the caret.
 */
describe("the arrow-key walk", () => {
  /**
   * The caret note is module state and is deliberately *not* cleared on read — see
   * `caretWalk.ts`, where StrictMode's double-invoked mount effect is why. So a test that leaves
   * one behind hands it to the next, and the case asserting a note is **absent** is the one that
   * would read as a failure. Discarded here with a card id nothing uses, which is the only way
   * to clear it from outside.
   */
  beforeEach(() => {
    consumeCaretNote("no-test-walks-to-this-id");
  });

  const THREE = [
    card("aaa", "Lightning Bolt"),
    card("bbb", "Lightning Helix"),
    card("ccc", "Ancestral Recall"),
  ];

  /**
   * Everything about these walls that is not the subject of a test.
   *
   * `as const` on the section for the reason the three `props` objects above it give: a spread
   * object's `"search"` widens to `string`, and the wall's prop is the union — which is the whole
   * point of it being one. `arrowNav` is in here rather than passed per test because all but one
   * of the walls below have it; the ones that do not say so after the spread, where an explicit
   * `arrowNav={false}` reads as the subject rather than as an omission.
   */
  const base = {
    onNeedNextPage: vi.fn(),
    listKey: "k",
    zoomSection: "search" as const,
    arrowNav: true,
  };

  /** A tile's art button — the element the caret sits on, and the one it is moved to. */
  const art = (name: string) => screen.getByRole("button", { name });

  /**
   * The two halves of a press, in one test because they are one behaviour: the reader asked for
   * the next card to be **selected**, so `onSelect` firing is the feature and the caret following
   * it is what makes a second press possible.
   *
   * `onSelect` is what the two calling pages write `selectedCardId` with, so on a real page this
   * is the docked card pane moving to the new card.
   */
  it("selects the next card along and takes the caret with it", async () => {
    const onSelect = vi.fn();
    render(<CardGrid rows={THREE} onSelect={onSelect} {...base} />);

    art("Lightning Bolt").focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).toHaveBeenLastCalledWith("bbb");
    // The art button, not the tile's wrapper: the wrapper is `tabIndex={-1}` so a menu can hand
    // the caret back to it, and it wears no focus ring — a reader arrowing across a wall with
    // nothing visibly focused would be worse served than by no arrow keys at all.
    expect(document.activeElement).toBe(art("Lightning Helix"));

    await userEvent.keyboard("{ArrowLeft}");

    expect(onSelect).toHaveBeenLastCalledWith("aaa");
    expect(document.activeElement).toBe(art("Lightning Bolt"));
  });

  /**
   * **A press on a tile keeps the caret too, and it is the gesture a keyboard test cannot make.**
   *
   * Every case in this block starts by focusing a tile by hand, which is a caret that was never
   * anywhere else. A reader's is: they *click* a tile, `onSelect` writes `selectedCardId`, the
   * card pane's body mounts and focuses itself — and their first arrow then moves nothing at all.
   * Measured in the shipped window 2026-08-19, on this wall and on the deck's piles.
   *
   * The pane is not mounted here, so what is asserted is the **note** rather than the caret: no
   * jsdom test can watch a pane steal something no pane is drawing. `consumeCaretNote` is
   * idempotent, so reading it is a question rather than a write.
   */
  it("keeps the caret for a tile that was pressed, not only for one arrowed to", async () => {
    render(<CardGrid rows={THREE} onSelect={vi.fn()} {...base} />);

    await userEvent.click(art("Lightning Bolt"));

    expect(consumeCaretNote("aaa")).toBe(true);
  });

  /**
   * **And a wall the arrows do not move goes on handing the caret over**, which is the printings
   * modal's case and not a detail: a press there is a swap or a look, the modal closes on it, and
   * a caret held on a tile of a wall that no longer exists is a caret on `<body>`. `arrowNav` is
   * the test for both behaviours because it is the same question — is this a wall the reader
   * navigates, or one they are passing through.
   */
  it("hands the caret over on a wall the arrows do not move", async () => {
    render(<CardGrid rows={THREE} onSelect={vi.fn()} {...base} arrowNav={false} />);

    await userEvent.click(art("Lightning Bolt"));

    expect(consumeCaretNote("aaa")).toBe(false);
  });

  /**
   * Down and up reach the same two tiles here, and that is the single column speaking rather than
   * the implementation: at one column the row below a tile *is* the tile after it. This pins that
   * the two keys are wired at all — `gridNav.test.ts` is where they are told apart.
   */
  it("answers up and down too, which are the same step in a single column", async () => {
    const onSelect = vi.fn();
    render(<CardGrid rows={THREE} onSelect={onSelect} {...base} />);

    art("Lightning Bolt").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith("bbb");

    await userEvent.keyboard("{ArrowUp}");
    expect(onSelect).toHaveBeenLastCalledWith("aaa");
    expect(document.activeElement).toBe(art("Lightning Bolt"));
  });

  /**
   * A press the wall used is a press nothing else may have — without `preventDefault` the
   * scroller underneath would also do its own arrow-key scrolling, so the caret would land on a
   * tile and the wall would slide out from under it.
   *
   * `fireEvent` returns `false` for an event whose default was prevented, which is the only way
   * to ask this question; `userEvent.keyboard` throws the answer away.
   */
  it("claims a press it acted on, and leaves an unused one for whatever is under it", () => {
    render(<CardGrid rows={THREE} onSelect={vi.fn()} {...base} />);

    expect(fireEvent.keyDown(art("Lightning Bolt"), { key: "ArrowRight" })).toBe(false);
    // The end of the list. Nothing moves and nothing is claimed — no wrapping round to the top,
    // which on a 117 k-row browse would be a reader losing their place to one keystroke.
    expect(fireEvent.keyDown(art("Ancestral Recall"), { key: "ArrowRight" })).toBe(true);
    // And a key this wall has no answer for stays with the tile, which is how Enter still opens
    // a card and Shift+F10 still opens its menu.
    expect(fireEvent.keyDown(art("Lightning Bolt"), { key: "Enter" })).toBe(true);
  });

  it("stops at the end of the list rather than wrapping round it", async () => {
    const onSelect = vi.fn();
    render(<CardGrid rows={THREE} onSelect={onSelect} {...base} />);

    art("Ancestral Recall").focus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(art("Ancestral Recall"));
  });

  /**
   * Ctrl+arrow, Alt+arrow and their friends belong to the browser or the window manager, and this
   * wall already reads Ctrl for a gesture of its own (ctrl+wheel zooms it). Shift is in the guard
   * for a different reason: Shift+arrow extends a *selection* everywhere else it exists, and this
   * wall has no range to extend — swallowing it would promise one.
   */
  it("keeps its hands off a modified arrow", async () => {
    const onSelect = vi.fn();
    render(<CardGrid rows={THREE} onSelect={onSelect} {...base} />);

    art("Lightning Bolt").focus();
    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(art("Lightning Bolt"));
  });

  /**
   * A caret in a field is a caret the field is using: the arrows move it through the text, and a
   * wall that jumped at the same time would be taking a key that was already spoken for.
   *
   * The general rule, stated as a deny-list of what a caret may be sitting in. The test after
   * this one is the tighter half of it — the one that covers the controls a list of input types
   * cannot see.
   */
  it("yields to a caret in a field the caller drew on the tile", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={THREE}
        onSelect={onSelect}
        {...base}
        action={() => <input aria-label="Copies" defaultValue="1" />}
      />,
    );
    const field = screen.getAllByLabelText("Copies")[0];

    field.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  /**
   * **Inside a tile is not the same as on it**, and this is the case the field guard above cannot
   * see. The search's quick-add opens a `role="dialog"` *in the tile's own caption* — `static`
   * anchoring, so a 256px panel on a 170px tile opens from the tile's left edge rather than off
   * the scroller's — and its finish chips and condition rows are **buttons**. A reader stepping
   * through them is holding a caret that `closest` reports as being on a card; walking the wall
   * out from under them would be taking a key the control they opened is using.
   *
   * The two positions that do count are the art button, which is where a walk starts and lands,
   * and the tile's own root, which is what a closing context menu focuses back to.
   */
  it("leaves a control the caller drew inside a tile holding its own keys", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={THREE}
        onSelect={onSelect}
        {...base}
        action={() => <button type="button">Foil</button>}
      />,
    );
    const chip = screen.getAllByRole("button", { name: "Foil" })[0];

    chip.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(chip).toHaveFocus();

    // And the tile's root does count — it is where `ContextMenu` puts the caret when a tile's
    // menu closes, so the walk survives a right-click.
    const tile = art("Lightning Bolt").closest<HTMLElement>("[data-grid-index]");
    tile?.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).toHaveBeenLastCalledWith("bbb");
  });

  /**
   * The prop is the whole of the opt-in, and this is the state three of the four callers are in.
   * `AllPrintingsDialog` is the one that must never take it: left and right *there* step through
   * a card's printings, and one key cannot mean two things on one screen.
   */
  it("does nothing at all on a wall that was not given the prop", async () => {
    const onSelect = vi.fn();
    render(<CardGrid rows={THREE} onSelect={onSelect} {...base} arrowNav={false} />);

    art("Lightning Bolt").focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(art("Lightning Bolt"));
  });

  /**
   * The number every step of the move is keyed off, published on the tile's root.
   *
   * **Absolute, and unconditional.** Absolute because selecting a card opens the 384px detail
   * pane, which re-flows the wall to fewer columns *as a result of the very press being handled*
   * — a tile's row and column have a shelf life of one render and its place in the list does not.
   * Unconditional because it states a fact about the tile rather than about a feature: the wall
   * below takes no arrow keys and still carries it.
   */
  it("publishes each tile's place in the whole list, whether or not it is being walked", () => {
    const { container, rerender } = render(<CardGrid rows={THREE} onSelect={vi.fn()} {...base} />);
    const indices = () =>
      [...container.querySelectorAll("[data-grid-index]")].map((t) =>
        t.getAttribute("data-grid-index"),
      );

    expect(indices()).toEqual(["0", "1", "2"]);
    // On the tile's root, which is what contains all four of a tile's parts — the art, both
    // corners and the caption — so a press on any of them walks up to the same element.
    expect(art("Lightning Helix").closest("[data-grid-index]")).toHaveAttribute(
      "data-grid-index",
      "1",
    );

    rerender(<CardGrid rows={THREE} onSelect={vi.fn()} {...base} arrowNav={false} />);
    expect(indices()).toEqual(["0", "1", "2"]);
  });
});
