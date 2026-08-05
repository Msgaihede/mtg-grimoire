import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardSummary, DeckZone, SearchResponse } from "@/lib/ipc";

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
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
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
function Harness({
  zones,
  targetZone,
  onTargetZoneChange,
}: {
  zones: DeckZone[];
  targetZone: DeckZone;
  onTargetZoneChange: (zone: DeckZone) => void;
}) {
  const deck = useDeck(4);
  return (
    <DeckSearchPanel
      add={deck.addCard}
      zones={zones}
      targetZone={targetZone}
      onTargetZoneChange={onTargetZoneChange}
    />
  );
}

function panel({
  zones = MODERN,
  targetZone = "main" as DeckZone,
  onTargetZoneChange = vi.fn(),
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = (props: { zones: DeckZone[]; targetZone: DeckZone }) => (
    <QueryClientProvider client={client}>
      <Harness
        zones={props.zones}
        targetZone={props.targetZone}
        onTargetZoneChange={onTargetZoneChange}
      />
    </QueryClientProvider>
  );
  const view = render(ui({ zones, targetZone }));
  return {
    ...view,
    onTargetZoneChange,
    /** Re-render with a different target zone — what the editor does when the select moves. */
    retarget: (zone: DeckZone) => view.rerender(ui({ zones, targetZone: zone })),
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
