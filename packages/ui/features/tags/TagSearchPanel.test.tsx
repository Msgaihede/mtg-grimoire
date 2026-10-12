import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardSummary, SearchRequest, TagHit, TagProgressEvent, TagStatus } from "@/lib/ipc";

const searchCards = vi.hoisted(() => vi.fn());
const tagSearch = vi.hoisted(() => vi.fn());
const tagChildren = vi.hoisted(() => vi.fn());
const tagMute = vi.hoisted(() => vi.fn());
const artTagsStatus = vi.hoisted(() => vi.fn());
const oracleTagsStatus = vi.hoisted(() => vi.fn());
const onArtTagProgress = vi.hoisted(() => vi.fn());
const searchOpen = vi.hoisted(() => vi.fn());
const setSearchOpen = vi.hoisted(() => vi.fn());
const panelWidth = vi.hoisted(() => vi.fn());
const setPanelWidth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    searchCards,
    getMarketplace: vi.fn().mockResolvedValue("tcgplayer"),
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
    listSets: vi.fn().mockResolvedValue([]),
    prefetchImages: vi.fn().mockResolvedValue(undefined),
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
    tagSearch,
    tagChildren,
    tagMute,
    artTagsStatus,
    oracleTagsStatus,
    onArtTagProgress,
    searchOpen,
    setSearchOpen,
    panelWidth,
    setPanelWidth,
  },
}));

import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { CardToDeckProvider } from "@/features/card/cardMenu";
import { SearchPage } from "@/features/search/SearchPage";
import { SEARCH_OPEN_KEY } from "@/features/search/useSearchOpen";
import { PANEL_WIDTH_KEY, PANEL_WIDTH_WRITE_DELAY_MS } from "@/features/search/usePanelWidth";
import { HIDDEN_TAGS_KEY } from "@/features/settings/useHiddenTags";
import { useAppStore } from "@/lib/store";
import { HIDE_BACKGROUND_LABEL } from "./TagChips";

/**
 * Tag search as the search page's collapsible sidebar (issue #937) — the Tagger page's rail,
 * moved. These cases are that page's suite carried across to the new home, plus what the move
 * itself promises: nothing about tags is read until the sidebar is opened, the chips keep
 * narrowing the wall while it is a rail, and both the open state and the dragged width are
 * written to the backend so the next launch opens the way the reader left it.
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
  releasedAt: null,
};

const hit = (over: Partial<TagHit> & Pick<TagHit, "slug" | "label">): TagHit => ({
  id: `id-${over.slug}`,
  namespace: "art",
  description: null,
  cardCount: 3,
  childCount: 0,
  parents: [],
  ...over,
});
const LANDSCAPE = hit({ slug: "landscape", label: "Landscape", childCount: 1 });
const REMOVAL = hit({ slug: "removal", label: "Removal", namespace: "oracle", cardCount: 6686 });
const FOREST = hit({ slug: "forest", label: "Forest" });

const INGESTED: TagStatus = {
  updatedAt: "2026-08-19T09:00:00.000Z",
  ingestedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  tagCount: 11_531,
  taggingCount: 475_163,
  stale: false,
  refreshing: false,
};
const NEVER: TagStatus = {
  updatedAt: null,
  ingestedAt: null,
  checkedAt: null,
  tagCount: null,
  taggingCount: null,
  stale: true,
  refreshing: false,
};

let client: QueryClient;
let artProgress: ((e: TagProgressEvent) => void) | null = null;

/**
 * The page under the providers `App` mounts above it, with the sidebar's stored answers seeded
 * into the cache the way `AppShell`'s launch prefetch leaves them — `open` is the reader's last
 * press, and `width` their last drag.
 */
function renderPage({ open = true, width }: { open?: boolean; width?: number } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SEARCH_OPEN_KEY, { tags: open });
  client.setQueryData(PANEL_WIDTH_KEY, width === undefined ? {} : { tags: width });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CardToDeckProvider>
          <ContextMenuProvider>
            <SearchPage />
          </ContextMenuProvider>
        </CardToDeckProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const sidebar = () => screen.getByRole("region", { name: "Search by tag" });

const railRow = (label: string) =>
  screen.findByRole(
    "button",
    { name: new RegExp(`^${label}, (art|oracle) tag, \\d`) },
    { timeout: 5000 },
  );

const lastRequest = () =>
  searchCards.mock.calls[searchCards.mock.calls.length - 1][0] as SearchRequest;

function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  searchCards.mockReset().mockResolvedValue({ items: [BOLT], total: 1, totalIsCapped: false });
  tagChildren
    .mockReset()
    .mockImplementation((_ns: string, slug: string | null) =>
      Promise.resolve(slug === null ? [LANDSCAPE, REMOVAL] : [FOREST]),
    );
  tagSearch.mockReset().mockResolvedValue([LANDSCAPE]);
  tagMute.mockReset().mockResolvedValue(undefined);
  artTagsStatus.mockReset().mockResolvedValue(INGESTED);
  oracleTagsStatus.mockReset().mockResolvedValue(INGESTED);
  searchOpen.mockReset().mockResolvedValue({});
  setSearchOpen.mockReset().mockResolvedValue(undefined);
  panelWidth.mockReset().mockResolvedValue({});
  setPanelWidth.mockReset().mockResolvedValue(undefined);
  artProgress = null;
  onArtTagProgress.mockReset().mockImplementation((cb: (e: TagProgressEvent) => void) => {
    artProgress = cb;
    return () => {};
  });
  useAppStore.setState({ activeView: "search", searchView: "grid", selectedCardId: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sidebar", () => {
  it("draws railed by default, and reads no tag data until it is opened", async () => {
    const user = userEvent.setup();
    renderPage({ open: false });

    const toggle = await screen.findByRole("button", { name: "Expand tag search" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    expect(tagChildren).not.toHaveBeenCalled();
    expect(artTagsStatus).not.toHaveBeenCalled();
    expect(oracleTagsStatus).not.toHaveBeenCalled();
    expect(onArtTagProgress).not.toHaveBeenCalled();

    await user.click(toggle);

    expect(await railRow("Landscape")).toBeInTheDocument();
    expect(tagChildren.mock.calls).toEqual([["both", null]]);
    expect(artTagsStatus).toHaveBeenCalled();
    // The press is what is remembered, under its own section of the `search_open` map.
    expect(setSearchOpen).toHaveBeenCalledWith("tags", true);
    expect(screen.getByRole("button", { name: "Collapse tag search" })).toBeInTheDocument();
  });

  it("opens on the reader's stored answer", async () => {
    renderPage({ open: true });

    expect(await railRow("Landscape")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse tag search" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("remembers that it was shut", async () => {
    const user = userEvent.setup();
    renderPage({ open: true });
    await railRow("Landscape");

    await user.click(screen.getByRole("button", { name: "Collapse tag search" }));

    expect(setSearchOpen).toHaveBeenCalledWith("tags", false);
    expect(screen.queryByPlaceholderText(/search tags/i)).not.toBeInTheDocument();
  });

  it("opens at the width the reader last dragged it to", async () => {
    renderPage({ open: true, width: 300 });
    await railRow("Landscape");

    expect(sidebar()).toHaveStyle({ width: "300px" });
  });

  /**
   * The splitter answers the arrow keys (`ResizeHandle`), which is the same `onResize` a drag
   * calls — and the width reaches the backend once the gesture goes quiet, not per step.
   */
  it("stores a resized width once the gesture settles", async () => {
    renderPage({ open: true, width: 300 });
    await railRow("Landscape");
    vi.useFakeTimers();

    const handle = within(sidebar()).getByRole("separator", { name: /tag search/i });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(setPanelWidth).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(PANEL_WIDTH_WRITE_DELAY_MS);
    });
    // The mutation itself is scheduled by the query client; let it run on real timers.
    vi.useRealTimers();

    await waitFor(() => expect(setPanelWidth).toHaveBeenCalledTimes(1));
    const [section, width] = setPanelWidth.mock.calls[0] as [string, number];
    expect(section).toBe("tags");
    expect(width).toBeGreaterThan(300);
    expect(sidebar()).toHaveStyle({ width: `${width}px` });
  });
});

describe("picking a tag", () => {
  it("sends the picked tag as an art term and chips it over the filter row", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await railRow("Landscape"));

    await waitFor(() =>
      expect(lastRequest()).toMatchObject({ artTags: { include: ["landscape"], exclude: [] } }),
    );
    expect(
      screen.getByRole("button", { name: /^Landscape, art tag, included/ }),
    ).toBeInTheDocument();
  });

  it("draws no chips row while nothing is picked", async () => {
    renderPage();
    await railRow("Landscape");

    expect(screen.queryByRole("group", { name: "Picked tags" })).not.toBeInTheDocument();
    expect(lastRequest().artTags).toBeUndefined();
  });

  it("takes the tag off again when its row is pressed a second time", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await railRow("Landscape"));
    await waitFor(() =>
      expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] }),
    );
    await user.click(await railRow("Landscape"));

    await waitFor(() => expect(lastRequest().artTags).toBeUndefined());
    expect(
      screen.queryByRole("button", { name: /^Landscape, art tag, included/ }),
    ).not.toBeInTheDocument();
  });

  /** The chips are the page's filter, not the sidebar's: shutting it keeps them narrowing. */
  it("keeps narrowing the wall after the sidebar is shut", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await railRow("Landscape"));
    await waitFor(() =>
      expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] }),
    );

    await user.click(screen.getByRole("button", { name: "Collapse tag search" }));

    expect(
      screen.getByRole("button", { name: /^Landscape, art tag, included/ }),
    ).toBeInTheDocument();
    expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] });

    await user.click(screen.getByRole("button", { name: "Remove Landscape, art tag" }));
    await waitFor(() => expect(lastRequest().artTags).toBeUndefined());
  });

  it("intersects an oracle tag with an art one", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await railRow("Landscape"));
    await user.click(await railRow("Removal"));

    await waitFor(() =>
      expect(lastRequest()).toMatchObject({
        artTags: { include: ["landscape"], exclude: [] },
        oracleTags: { include: ["removal"], exclude: [] },
      }),
    );
  });

  it("flips a chip to an exclude", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await railRow("Landscape"));

    await user.click(await screen.findByRole("button", { name: /^Landscape, art tag, included/ }));

    await waitFor(() =>
      expect(lastRequest()).toMatchObject({ artTags: { include: [], exclude: ["landscape"] } }),
    );
  });

  it("offers the weight floor, and drops it when the last art include is toggled off", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await railRow("Landscape"));

    await user.click(screen.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }));
    await waitFor(() => expect(lastRequest().artWeightFloor).toBe("strong"));

    await user.click(await railRow("Landscape"));
    await waitFor(() => expect(lastRequest().artWeightFloor).toBeUndefined());
  });

  it("searches the tag taxonomies for what is typed in the box", async () => {
    const user = userEvent.setup();
    renderPage();
    await railRow("Landscape");

    await user.type(screen.getByPlaceholderText(/search tags/i), "landsca");

    await waitFor(() => expect(tagSearch).toHaveBeenCalledWith("landsca", "both", 50));
  });

  it("opens on the chips and the tag box the reader left", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.click(await railRow("Landscape"));
    await user.type(screen.getByPlaceholderText(/search tags/i), "land");
    await screen.findByRole("button", { name: /^Landscape, art tag, included/ });
    first.unmount();

    renderPage();

    expect(
      await screen.findByRole("button", { name: /^Landscape, art tag, included/ }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search tags/i)).toHaveValue("land");
    await waitFor(() =>
      expect(lastRequest().artTags).toEqual({ include: ["landscape"], exclude: [] }),
    );
  });
});

describe("hiding a tag", () => {
  it("mutes the tag and puts the rail and Settings' list out of date", async () => {
    const user = userEvent.setup();
    renderPage();
    rightClick(await railRow("Landscape"));
    await screen.findByRole("menu");
    client.setQueryData(HIDDEN_TAGS_KEY, []);

    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    await waitFor(() => expect(tagMute).toHaveBeenCalledWith("art", "id-landscape", "landscape"));
    await waitFor(() => expect(tagChildren.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(client.getQueryState(HIDDEN_TAGS_KEY)?.isInvalidated).toBe(true));
  });

  it("says a refused hide where the reader asked for it", async () => {
    tagMute.mockRejectedValue("the tag database is busy");
    const user = userEvent.setup();
    renderPage();
    rightClick(await railRow("Landscape"));
    await screen.findByRole("menu");

    await user.click(screen.getByRole("menuitem", { name: /^Hide this tag/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Couldn't hide Landscape — the tag database is busy/,
    );
  });
});

describe("a taxonomy this machine has never downloaded", () => {
  it("names each missing taxonomy on its own", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([REMOVAL]);
    renderPage();

    expect(await screen.findByText(/art tags are still downloading/i)).toBeInTheDocument();
    expect(await railRow("Removal")).toBeInTheDocument();
    expect(screen.queryByText(/oracle tags are still downloading/i)).not.toBeInTheDocument();
  });

  it("takes the art sentence down by itself when the ingest finishes", async () => {
    artTagsStatus.mockResolvedValue(NEVER);
    tagChildren.mockResolvedValue([REMOVAL]);
    renderPage();
    await screen.findByText(/art tags are still downloading/i);

    artTagsStatus.mockResolvedValue(INGESTED);
    tagChildren.mockResolvedValue([LANDSCAPE, REMOVAL]);
    act(() => artProgress?.({ phase: "done", done: 1, total: 1 }));

    await waitFor(() =>
      expect(screen.queryByText(/art tags are still downloading/i)).not.toBeInTheDocument(),
    );
    expect(await railRow("Landscape")).toBeInTheDocument();
  });

  it("says nothing at all when both taxonomies are in", async () => {
    renderPage();
    await railRow("Landscape");

    expect(screen.queryByText(/are still downloading/i)).not.toBeInTheDocument();
  });
});
