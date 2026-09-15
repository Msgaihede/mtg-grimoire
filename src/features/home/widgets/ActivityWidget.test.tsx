import { createElement, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, HomeWidget } from "@/lib/ipc";

/**
 * The one command this file stubs, and it is typed rather than bare.
 *
 * Every case that can be stated as *data* seeds the query cache through {@link activityKey}
 * instead — that is both the cheaper harness and a real assertion, since a seeded answer only
 * reaches the screen if the widget is reading the key it exports. What a cache cannot hold is a
 * read still in flight and a read that was refused, and those are two of the four sentences this
 * widget owes the reader, so the transport is stubbed for them.
 *
 * The generic is what keeps that stub honest: a bare `vi.fn()` accepts any fixture at all, so a
 * required field added to `ActivityEntry` in `ipc.ts` would fail at runtime inside a `useMemo`
 * rather than under `tsc`.
 */
const activityRecent = vi.hoisted(() => vi.fn<(limit: number) => Promise<ActivityEntry[]>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  // Spread, so every other command stays the real one: this file's subject reads exactly one.
  return { ...actual, ipc: { ...actual.ipc, activityRecent } };
});

import { activityDays } from "../activityText";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { activityKey } from "../keys";
import { ActivityWidget, fitDays } from "./ActivityWidget";

/** Unix **seconds** from a local wall-clock time, like every stamp in this schema. Local rather
 *  than UTC so the day boundaries below are the same in every timezone. */
const at = (y: number, m: number, d: number, h: number, min: number) =>
  Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

/** The instant the whole file is read against. Fixed, because "Today" and "Yesterday" are
 *  computed from the clock — and a roll-up test whose two rows are a minute apart would file
 *  them under two days on the one run that happened to start a minute before midnight. */
const TODAY_9AM = new Date(2026, 8, 11, 9, 0);

let nextId = 1;

/**
 * One feed row.
 *
 * Annotated with the real `ActivityEntry` so the mirror in `ipc.ts` checks these fixtures — see
 * the mock above. The default is the commonest row there is: one copy added to the collection.
 */
function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: nextId++,
    at: at(2026, 8, 11, 8, 30),
    scope: "collection",
    kind: "add",
    deckId: null,
    cardId: "c-1",
    cardName: "Lightning Bolt",
    payload: "{}",
    delta: 1,
    ...over,
  };
}

/** `n` rows on one day, a minute apart and newest first — the order `activity_recent` answers. */
function day(n: number, d: number, over: Partial<ActivityEntry> = {}): ActivityEntry[] {
  return Array.from({ length: n }, (_, i) => entry({ at: at(2026, 8, d, 8, 59 - i), ...over }));
}

const widgetOf = (config: unknown = null): HomeWidget => ({
  id: "activity",
  kind: "activity",
  x: 0,
  y: 0,
  w: 3,
  h: 3,
  config,
});

/** A `w × h` card on 104px cells. */
const fitOf = (w: number, h: number): WidgetFit =>
  makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });

/** The kind's widest and tallest card — room for 26 lines, so a test about wording is never also
 *  a test about the cut. */
const ROOMY = fitOf(4, 8);

/** The kind's default footprint: room for **eight** lines, a day heading counting as one. */
const DEFAULT = fitOf(3, 3);

interface World {
  /** Seeded under {@link activityKey}, which is the whole of how a case says "the read landed". */
  entries?: ActivityEntry[];
  /** The limit the seed is filed under — the stored config's, or the default. */
  limit?: number;
  config?: unknown;
  fit?: WidgetFit;
  still?: boolean;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function draw({ entries, limit = 50, config = null, fit = ROOMY, still = false }: World = {}) {
  client = new QueryClient({
    defaultOptions: {
      // `Infinity` only where an answer was seeded: it is what stops the seed being refetched
      // out from under the first assertion. A world with no seed wants the real read.
      queries: { retry: false, staleTime: entries === undefined ? 0 : Infinity },
    },
  });
  if (entries !== undefined) client.setQueryData<ActivityEntry[]>(activityKey(limit), entries);
  return render(
    <ActivityWidget
      widget={widgetOf(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  nextId = 1;
  // **`Date` alone.** `setTimeout` stays real, because `userEvent` runs its scheduler on it and
  // TanStack's notifyManager delivers on `setTimeout(0)` — faking either hangs the file.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY_9AM);
  activityRecent.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the day sections", () => {
  /**
   * Grouping is `activityDays`' and is deliberately not re-derived here — days are **local**
   * calendar days, and slicing one off an ISO string files a 23:30 change under tomorrow. What
   * this asserts is that the widget draws one section per day the way that function returns
   * them: newest first, with "Today" and "Yesterday" named rather than dated.
   */
  it("draws one section per local day, newest first", () => {
    draw({
      entries: [
        entry({ at: at(2026, 8, 11, 14, 12) }),
        entry({ at: at(2026, 8, 11, 0, 1) }),
        entry({ at: at(2026, 8, 10, 22, 40) }),
        entry({ at: at(2026, 8, 3, 18, 2) }),
      ],
    });

    const headings = screen.getAllByRole("heading", { level: 4 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Today",
      "Yesterday",
      expect.stringContaining("September 3") as unknown as string,
    ]);
  });

  /**
   * A day that gained seven copies and lost six is `+7` and `−6` and never `+1`: netting them
   * says a busy afternoon was a quiet one. Read literally the chips are "plus seven minus six", so
   * the figure is spoken as a sentence beside them and the chips are hidden from that reading.
   */
  it("rolls the day's copies up as two chips, drawn and spoken", () => {
    draw({
      entries: [entry({ delta: 3 }), entry({ delta: 4 }), entry({ kind: "remove", delta: -6 })],
    });

    expect(screen.getByText("+7")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("−6")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("7 copies added, 6 copies removed")).toBeInTheDocument();
  });

  /** A day of moves and renames changed no counts at all, and `+0 −0` would be a figure
   *  pretending to be news. */
  it("says a day moved no copies rather than drawing two zeros", () => {
    draw({ entries: [entry({ kind: "move", delta: 0 })] });

    expect(screen.getByText("no copies")).toBeInTheDocument();
    expect(screen.getByText("no copies changed")).toBeInTheDocument();
    expect(screen.queryByText("+0")).toBeNull();
  });
});

describe("the lines", () => {
  /**
   * **The two halves of the feed, side by side.** A `deck` row came out of `deck_audit` and is
   * worded by the deck history's own sentence builder, so it reads here exactly as it reads in
   * that dialog; a `collection` row is worded by `activityText.ts`. This widget writes neither
   * and adds nothing of its own to either — the detail rides after the sentence on the same line.
   */
  it("draws a deck line and a collection line, each in its own words", () => {
    draw({
      entries: [
        entry({ delta: 3, payload: '{"folder":"Binder A","finish":"foil"}' }),
        entry({
          scope: "deck",
          deckId: 4,
          delta: 2,
          payload: '{"quantity":2,"category":"Main deck"}',
        }),
      ],
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Added 3 × Lightning Bolt · to Binder A · Foil");
    expect(rows[1]).toHaveTextContent("Added 2 × Lightning Bolt");
    expect(rows[1]).toHaveTextContent("to Main deck");
  });

  /**
   * **`id` is unique within its own table and not across the feed**, which is `ActivityEntry`'s
   * own warning: a `UNION ALL` over two tables hands out colliding ids, so an `activity` row and
   * a `deck_audit` row routinely share one.
   *
   * **Asserted through React's own complaint, because the rendered DOM cannot see it.** Duplicate
   * keys still draw both children — the count below passes over the defect, which was measured
   * rather than assumed — and what they break is reconciliation on the *next* update, where a
   * row would keep the identity of a different row. The warning is the only signal available at
   * the moment the mistake is made.
   */
  it("keeps two rows that share an id apart", () => {
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      draw({
        entries: [
          entry({ id: 7, cardName: "Sol Ring" }),
          entry({ id: 7, scope: "deck", deckId: 4, cardName: "Sol Ring" }),
        ],
      });

      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(
        complaints.mock.calls.filter((args) => String(args[0]).includes("same key")),
      ).toEqual([]);
    } finally {
      complaints.mockRestore();
    }
  });

  /** The stamp is a fact about when, so it is 24-hour and machine-readable beside it. */
  it("stamps each line with its own time", () => {
    draw({ entries: [entry({ at: at(2026, 8, 11, 8, 30) })] });

    const stamp = screen.getByText("08:30");
    expect(stamp).toHaveAttribute(
      "datetime",
      new Date(at(2026, 8, 11, 8, 30) * 1000).toISOString(),
    );
  });

  /** `Show times` off is a stored `false`, and the line keeps its sentence without the stamp. */
  it("leaves the stamp off when the reader switched times off", () => {
    draw({ entries: [entry({ at: at(2026, 8, 11, 8, 30) })], config: { times: false } });

    expect(screen.getByRole("listitem")).toHaveTextContent("Added Lightning Bolt");
    expect(screen.queryByText("08:30")).toBeNull();
  });
});

/**
 * **Whole lines, never half of one.** A day heading costs a line, each day takes one fewer line
 * than is left, and a day with no line left is dropped rather than drawn as a heading over nothing.
 */
describe("cutting the feed to the box", () => {
  it("draws a heading and seven lines on the default card", () => {
    draw({ entries: day(12, 11), fit: DEFAULT });

    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("spends a heading from the budget for each day it draws", () => {
    draw({ entries: [...day(3, 11), ...day(5, 10)], fit: DEFAULT });

    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Today",
      "Yesterday",
    ]);
    // Today: a heading and three lines, four left. Yesterday: a heading and three of its five.
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  it("drops a day there is no line left for", () => {
    draw({ entries: [...day(7, 11), ...day(2, 10)], fit: DEFAULT });

    expect(screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent)).toEqual([
      "Today",
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  /** A card with room for no line still says one: `linesFit` floors at one, and a heading with
   *  no line under it is dropped, so the one line is spent on the heading and the day goes. The
   *  arithmetic's own edge, pinned so a change to it is a decision rather than an accident. */
  it("draws nothing below a heading the box has no line for", () => {
    const flat = makeFit({ w: 2, h: 1, widthPx: 220, heightPx: 50, density: "comfortable" });
    expect(fitDays(activityDays(day(3, 11)), flat, 50)).toEqual([]);
  });

  /** The budget is capped by the limit as well as the box: a tall card never promises more rows
   *  than were asked for. */
  it("never draws more than the limit, headings included", () => {
    const days = activityDays([...day(20, 11), ...day(20, 10)]);
    const cut = fitDays(days, fitOf(4, 8), 25);

    expect(cut.map((d) => d.lines.length)).toEqual([20, 3]);
  });

  /** The heading's roll-up is the whole day as read, not the lines the card had room for — a
   *  figure that shrank as the card was resized would be one a reader cannot check. */
  it("keeps a cut day's roll-up for the whole day", () => {
    const [today] = fitDays(activityDays(day(12, 11, { delta: 2 })), DEFAULT, 50);

    expect(today.lines).toHaveLength(7);
    expect(today.added).toBe(24);
  });
});

describe("the four sentences", () => {
  /** A read in flight is not an empty database, and the two look identical drawn as a blank
   *  card. */
  it("says it is still reading", () => {
    activityRecent.mockReturnValue(new Promise(() => {}));
    draw();

    expect(screen.getByText("Reading recent activity…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing has happened yet.")).toBeNull();
  });

  /** A new database is a complete answer rather than a failure, and it is worth an invitation. */
  it("says nothing has happened yet, for a database with no rows", async () => {
    draw();

    expect(await screen.findByText("Nothing has happened yet.")).toBeInTheDocument();
  });

  /**
   * **`deck_audit` is synced and `activity` is not**, so in a paired group the deck lines arrive
   * from every device and the collection and wishlist lines are this one's. There is no UI for
   * that asymmetry — inventing one would be a chip on a page most readers have no group for —
   * but the empty state may not claim the feed is everything the reader has ever done either.
   */
  it("keeps the empty state honest about being this device's feed", async () => {
    draw();
    await screen.findByText("Nothing has happened yet.");

    expect(screen.getByText(/this device/i)).toBeInTheDocument();
  });

  /**
   * **The refusal is reported before the emptiness**, which is `DeckHistoryDialog`'s rule and
   * its reason: a failed read has no rows either, and calling it "nothing has happened yet"
   * would tell a reader with a full collection that their history is gone. `ipcError` is how the
   * backend's own words reach the card.
   */
  it("says a refused read was refused, in the words the backend used", async () => {
    activityRecent.mockRejectedValue(new Error("BUSY: the database is being written to"));
    draw();

    expect(await screen.findByText("Recent activity could not be read.")).toBeInTheDocument();
    expect(screen.getByText(/BUSY: the database is being written to/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing has happened yet.")).toBeNull();
  });
});

describe("the limit", () => {
  /** The default is 50, and an unconfigured widget is what every reader starts with. */
  it("asks for fifty changes by default", async () => {
    draw();

    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(50));
  });

  /** A stored pick is read through `pickOf`, so a widget a reader has narrowed asks for what they
   *  chose — and files the answer under a key of its own. */
  it("asks for the stored limit and files it under that key", async () => {
    draw({ config: { limit: 25 } });

    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(25));
  });

  /**
   * **A stored limit no option carries reads as the default**, which is `pickValue`'s vocabulary
   * check: a `NaN` is a number and would reach SQLite as a limit no row can be read under, `9999`
   * is past the backend's clamp, `"100"` is the right number in the wrong type, and `200` is an
   * option an earlier build offered and this registry does not.
   */
  it.each([Number.NaN, 9_999, "100", 200])("reads a stored %s as fifty", async (stored) => {
    draw({ config: { limit: stored } });

    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(50));
    expect(activityRecent).toHaveBeenCalledTimes(1);
  });
});

/**
 * **Every write in this app records a row into this feed, and none of them has ever heard of an
 * `["activity"]` key.** `invalidateQueries` matches by key *prefix*, so the invalidations that
 * already follow a write — `["collection"]`, `["wishlist"]`, `["decks"]` — cannot reach a key
 * under a fourth root however it is spelled. The widget bridges the two itself.
 */
describe("staying fresh", () => {
  it.each(["collection", "wishlist", "decks"])(
    "re-reads the feed when a write invalidates %s",
    async (root) => {
      draw({ entries: [entry({ cardName: "Sol Ring" })] });
      expect(screen.getByText("Added Sol Ring")).toBeInTheDocument();
      expect(activityRecent).not.toHaveBeenCalled();

      activityRecent.mockResolvedValue([entry({ cardName: "Lightning Bolt" })]);
      await act(async () => {
        await client.invalidateQueries({ queryKey: [root] });
      });

      await waitFor(() => expect(screen.getByText("Added Lightning Bolt")).toBeInTheDocument());
    },
  );

  /** The bridge is a fact about *those* roots, not a refetch on anything that moves: a search
   *  or a corpus sync invalidates its own root many times a session and changes no history. */
  it("leaves the feed alone when an unrelated root is invalidated", async () => {
    draw({ entries: [entry({ cardName: "Sol Ring" })] });

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["cards", "search"] });
    });

    expect(activityRecent).not.toHaveBeenCalled();
  });

  /** **A still body publishes nothing.** A catalogue preview draws the feed it was handed and
   *  leaves the bridging to the live card, so a write does not refetch through the picture. */
  it("does not bridge from a still body", async () => {
    draw({ entries: [entry({ cardName: "Sol Ring" })], still: true });

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["collection"] });
    });

    expect(activityRecent).not.toHaveBeenCalled();
    expect(screen.getByText("Added Sol Ring")).toBeInTheDocument();
  });
});
