import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IMAGE_RETRY_FLOOR_MS, IMAGE_RETRY_SPREAD_MS } from "@/lib/images";
import type { CardSummary } from "@/lib/ipc";
import { CardGrid, columnsFor, tileWidthFor } from "./CardGrid";

const card = (id: string, name: string): CardSummary => ({
  id,
  name,
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  priceUsd: 400.5,
  layout: "normal",
});

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height
 * and renders an empty window. `@tanstack/react-virtual` sizes it with `offsetHeight` and
 * scrolls it with `Element.scrollTo`, which jsdom does not implement either.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Long enough to cover the dithered wait whatever `Math.random` returned. */
const PAST_THE_RETRY = IMAGE_RETRY_FLOOR_MS + IMAGE_RETRY_SPREAD_MS;

describe("CardGrid", () => {
  it("renders a card image per row, named for the card", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt"), card("bbb", "Lightning Helix")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        searchKey="k"
      />,
    );

    const bolt = screen.getByAltText("Lightning Bolt");
    // The alt text is what a screen reader and a failed load both fall back to, so it has
    // to be the card's name rather than "card image".
    expect(bolt).toBeInTheDocument();
    expect(bolt).toHaveAttribute("src", expect.stringContaining("/grid/aaa/0"));
    // Off-screen tiles must not all fetch at once on a 117 k-row browse.
    expect(bolt).toHaveAttribute("loading", "lazy");
  });

  it("opens the card that was clicked", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={onSelect}
        onNeedNextPage={vi.fn()}
        searchKey="k"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Lightning Bolt/ }));

    expect(onSelect).toHaveBeenCalledWith("aaa");
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
        searchKey="k"
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

  it("stops after that one retry rather than hammering a protocol that is saying no", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        searchKey="k"
      />,
    );

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    await act(async () => void vi.advanceTimersByTime(PAST_THE_RETRY));
    fireEvent.error(screen.getByAltText("Lightning Bolt"));

    // Ten minutes later, still no third request: a tile that has failed twice is a tile
    // whose card has no art the app can reach, and 40 of them polling forever is the herd
    // the backoff exists to prevent. Scrolling the tile out of view and back is what asks
    // again, because that is a reader saying "now".
    await act(async () => void vi.advanceTimersByTime(10 * 60_000));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();
    expect(screen.getByText("Lightning Bolt")).toBeInTheDocument();
  });

  /**
   * Tiles are keyed by their slot in the grid rather than by card id — two pages fetched
   * either side of a sync can carry one printing twice, and a duplicate React key drops a
   * card. So a new search reuses the component that failed, and its failure has to leave
   * with the card it belonged to.
   */
  it("gives a new card in a reused slot its own attempt", () => {
    const props = { onSelect: vi.fn(), onNeedNextPage: vi.fn(), searchKey: "k" };
    const { rerender } = render(<CardGrid rows={[card("aaa", "Lightning Bolt")]} {...props} />);

    fireEvent.error(screen.getByAltText("Lightning Bolt"));
    expect(screen.queryByAltText("Lightning Bolt")).not.toBeInTheDocument();

    rerender(<CardGrid rows={[card("ccc", "Ancestral Recall")]} {...props} searchKey="k2" />);

    expect(screen.getByAltText("Ancestral Recall")).toHaveAttribute(
      "src",
      expect.stringContaining("/grid/ccc/0"),
    );
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

  it("asks for the next page once the reader is near the bottom of the loaded rows", () => {
    const onNeedNextPage = vi.fn();
    // Two rows of one column each, both rendered: the last tile on screen is also the
    // last tile there is, which is as deep as a reader can get.
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt"), card("bbb", "Lightning Helix")]}
        onSelect={vi.fn()}
        onNeedNextPage={onNeedNextPage}
        searchKey="k"
      />,
    );

    expect(onNeedNextPage).toHaveBeenCalled();
  });
});
