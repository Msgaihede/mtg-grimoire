import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { CardSummary, DeckZone, SearchResponse } from "@/lib/ipc";
import { startDrag } from "@/test-drag";
import { readDragData } from "./dnd";

const searchCards = vi.hoisted(() => vi.fn());
// The set picker mounts with the filter bar and asks for the set list on the way up.
const listSets = vi.hoisted(() => vi.fn());
// The panel writes through `useDeck`, which reads the deck it is adding to.
const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const prefetchImages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { searchCards, listSets, deckGet, deckAddCard, prefetchImages },
}));

import { DeckSearchPanel } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";
import { useAppStore } from "@/lib/store";

const BOLT: CardSummary = {
  id: "1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  priceUsd: 400.5,
  layout: "normal",
  oracleId: "o-bolt",
  finishes: `["nonfoil","foil"]`,
  ownedQuantity: 3,
  wishlisted: false,
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
});

/** The zones a Modern deck offers, as the editor derives them from the seeded spec. */
const MODERN: DeckZone[] = ["main", "side", "maybe"];

/**
 * The panel with the editor's own write behind it.
 *
 * The mutation is a prop — the editor holds `useDeck` and hands `addCard` down, so that one
 * open deck is one `deck_get` — and this stands in for the editor holding it.
 */
interface Props {
  zones: DeckZone[];
  targetZone: DeckZone;
  roomy: boolean;
}

function Harness({
  onTargetZoneChange,
  ...props
}: Props & { onTargetZoneChange: (zone: DeckZone) => void }) {
  const deck = useDeck(4);
  return <DeckSearchPanel add={deck.addCard} onTargetZoneChange={onTargetZoneChange} {...props} />;
}

function panel({
  zones = MODERN,
  targetZone = "main" as DeckZone,
  roomy = true,
  onTargetZoneChange = vi.fn(),
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let props: Props = { zones, targetZone, roomy };
  const ui = (p: Props) => (
    <QueryClientProvider client={client}>
      <Harness {...p} onTargetZoneChange={onTargetZoneChange} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  /** Re-render with one prop changed — what the editor does when the select moves, or when it
   *  re-measures the row the deck and the panel share. */
  const update = (patch: Partial<Props>) => {
    props = { ...props, ...patch };
    view.rerender(ui(props));
  };
  return {
    ...view,
    onTargetZoneChange,
    update,
    retarget: (zone: DeckZone) => update({ targetZone: zone }),
  };
}

/**
 * What the target-zone select offers, by name.
 *
 * Read off the select rather than by `role: "option"`: the filter bar's format picker sits in
 * the same panel and offers a "Commander" of its own, which is a format and not a zone.
 */
const zoneOptions = (): string[] => {
  const select = screen.getByLabelText("Add to") as HTMLSelectElement;
  return [...select.options].map((o) => o.textContent ?? "");
};

describe("DeckSearchPanel", () => {
  /** The search view's own parts, in a column: not a second search implementation. */
  it("renders the search filters and the results as a wall of art", async () => {
    panel();

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
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    expect(screen.queryByRole("button", { name: "Table view" })).not.toBeInTheDocument();
  });

  /**
   * The select is the click path's zone choice and therefore the keyboard's, which is what
   * makes drag optional. Its options are the deck's own zones — seeded data drives it, the
   * same list the row menus move cards along.
   */
  it("offers the deck's own zones as targets, with the main deck first", () => {
    panel();

    expect(screen.getByLabelText("Add to")).toHaveValue("main");
    expect(zoneOptions()).toEqual(["Main deck", "Sideboard", "Maybe"]);
  });

  /** The other half of the same rule, and the reason the list is a prop: a commander deck has
   *  a commander zone to add to and a Modern deck does not. */
  it("offers the commander zone only to a format that has one", () => {
    const modern = panel({ zones: ["main", "side", "maybe"] });
    expect(zoneOptions()).not.toContain("Commander");
    modern.unmount();

    panel({ zones: ["main", "commander", "maybe"] });
    expect(zoneOptions()).toContain("Commander");
  });

  /**
   * The tile is the drag's handle, and what it carries is the card it is showing.
   *
   * The registration is the half that can go wrong silently — a wall builds its own tiles, so
   * the panel reaches them through one callback ref, and a callback that closed over the wrong
   * card would drag a card the reader is not touching. So this asks the drag itself rather
   * than the `draggable="true"` attribute: pick the tile up, and read what the library was
   * handed. Where the card *lands* is the zone's business (`ZoneColumn.test.tsx`) and the
   * whole gesture is the editor's (`DeckEditor.test.tsx`).
   */
  it("hands each drawn tile to the drag adapter, carrying the card it draws", async () => {
    const { container } = panel();
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
      { kind: "search-card", cardId: BOLT.id, name: BOLT.name },
    ]);
  });

  /** One copy, into the zone the header names. `deck_add_card` folds it into whatever is
   *  already there, so pressing twice is two copies rather than an error. */
  it("adds one copy of a card to the target zone", async () => {
    panel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" }),
    );

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", "main", 1);
  });

  it("adds to whichever zone is picked, and says so on the button", async () => {
    const view = panel();
    await screen.findByRole("button", { name: "Add Lightning Bolt to Main deck" });

    view.retarget("side");
    await userEvent.click(screen.getByRole("button", { name: "Add Lightning Bolt to Sideboard" }));

    expect(deckAddCard).toHaveBeenCalledWith(4, "1", "side", 1);
  });

  it("hands the zone choice back to the editor", async () => {
    const view = panel();

    await userEvent.selectOptions(screen.getByLabelText("Add to"), "side");

    expect(view.onTargetZoneChange).toHaveBeenCalledWith("side");
  });

  /** The result still tells the collection story: a card already in the binder is a card the
   *  deck can be built out of today. */
  it("marks a result with what the collection holds", async () => {
    panel();

    expect(await screen.findByText("×3")).toBeInTheDocument();
  });

  /** The tiles stay selectable, so the card pane keeps working from inside the editor. */
  it("opens the card in the pane from a tile", async () => {
    panel();

    await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));

    expect(useAppStore.getState().selectedCardId).toBe("1");
  });

  /** The editor has to be usable at 1024px with the card pane docked beside it, and 384px of
   *  search is what has to give. */
  it("collapses to a rail that says what it is, and opens again", async () => {
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await userEvent.click(screen.getByRole("button", { name: "Search cards" }));

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    const rail = screen.getByRole("button", { name: "Search cards" });
    expect(rail).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(rail);

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  /**
   * The editor measures the row the two of them share and says whether there is room. With
   * none, the rail is what is drawn whatever the reader last chose — and the disclosure is
   * disabled, because a press could not open anything and a control that records an intention
   * and moves nothing is worse than one that says why.
   */
  it("draws its rail, refused and explained, when the editor has no room for it", async () => {
    const view = panel({ roomy: false });

    const rail = screen.getByRole("button", { name: "Search cards" });
    expect(rail).toHaveAttribute("aria-expanded", "false");
    expect(rail).toHaveAttribute("title", expect.stringMatching(/not enough room/i));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

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
    const view = panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    // The card opens, and its arrival is what squeezes the panel out.
    act(() => useAppStore.setState({ selectedCardId: "1" }));
    view.update({ roomy: false });
    // The pane closes with the caret on it and nothing connected to hand it back to.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => useAppStore.setState({ selectedCardId: null }));

    expect(screen.getByRole("button", { name: "Search cards" })).toHaveFocus();

    // And it is still there one commit later, when the width the closing pane gave back
    // reopens the panel around it. The disclosure is one node across both states for exactly
    // this: two shapes would mean a fresh button here, and the caret back on `<body>`.
    view.update({ roomy: true });

    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search cards" })).toHaveFocus();
  });

  /** And it does not steal one: an opener still on screen has already been handed the caret
   *  back, which is where the reader was. */
  it("leaves the caret alone when something else still has it", async () => {
    const view = panel();
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
    const view = panel();
    await screen.findByRole("searchbox", { name: "Search cards" });

    view.update({ roomy: false });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    view.update({ roomy: true });
    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Search cards" }));
    view.update({ roomy: false });
    view.update({ roomy: true });

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
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
    panel();
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
    panel();

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
    panel();
    await screen.findByRole("button", { name: "Lightning Bolt" });

    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(prefetchImages).not.toHaveBeenCalled();
  });
});
