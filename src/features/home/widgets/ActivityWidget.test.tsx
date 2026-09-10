import { createElement, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickOption } from "@/test-dropdown";
import { LAYER } from "@/lib/layers";
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

import { activityKey } from "../keys";
import { ActivityWidget, ACTIVITY_LIMITS, DEFAULT_ACTIVITY_CONFIG } from "./ActivityWidget";

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

const widgetOf = (config: unknown = null): HomeWidget => ({
  id: "activity",
  kind: "activity",
  span: 1,
  config,
});

interface World {
  /** Seeded under {@link activityKey}, which is the whole of how a case says "the read landed". */
  entries?: ActivityEntry[];
  /** The limit the seed is filed under — the stored config's, or the default. */
  limit?: number;
  config?: unknown;
  editing?: boolean;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function draw({ entries, limit = DEFAULT_ACTIVITY_CONFIG.limit, config = null, editing }: World = {}) {
  client = new QueryClient({
    defaultOptions: {
      // `Infinity` only where an answer was seeded: it is what stops the seed being refetched
      // out from under the first assertion. A world with no seed wants the real read.
      queries: { retry: false, staleTime: entries === undefined ? 0 : Infinity },
    },
  });
  if (entries !== undefined) client.setQueryData<ActivityEntry[]>(activityKey(limit), entries);
  const onConfig = vi.fn();
  const view = render(
    <ActivityWidget
      widget={widgetOf(config)}
      editing={editing ?? false}
      onConfig={onConfig}
      onRemove={vi.fn()}
      onSpan={vi.fn()}
      dragHandleRef={vi.fn()}
      onNudge={vi.fn()}
    />,
    { wrapper },
  );
  return { ...view, onConfig };
}

/** The card itself — a `region` named by its heading, which is `WidgetCard`'s contract. */
const card = () => screen.getByRole("region", { name: "Activity" });

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
   * A day that gained seven copies and lost six is `+7 / −6` and never `+1`: netting them says
   * a busy afternoon was a quiet one. Read literally the drawing is "plus seven slash minus
   * six", so the figure is spoken as a sentence beside it.
   */
  it("rolls the day's copies up as two figures, drawn and spoken", () => {
    draw({
      entries: [
        entry({ delta: 3 }),
        entry({ delta: 4 }),
        entry({ kind: "remove", delta: -6 }),
      ],
    });

    expect(within(card()).getByText("+7 / −6")).toBeInTheDocument();
    expect(within(card()).getByText("7 copies added, 6 copies removed")).toBeInTheDocument();
  });

  /** A day of moves and renames changed no counts at all, and `+0 / −0` would be a figure
   *  pretending to be news. */
  it("says a day moved no copies rather than drawing two zeros", () => {
    draw({ entries: [entry({ kind: "move", delta: 0 })] });

    expect(within(card()).getByText("no copies")).toBeInTheDocument();
    expect(within(card()).getByText("no copies changed")).toBeInTheDocument();
  });

  /**
   * The header rides over the rows scrolling under it, and the rung is `LAYER.header` — the one
   * a sticky header takes everywhere in this app. Asserted through `classList`, never a string
   * match on `className`, and against `LAYER` itself so a renamed rung comes here.
   */
  it("makes the day header sticky at the header rung", () => {
    draw({ entries: [entry()] });

    const header = screen.getByRole("heading", { level: 4, name: "Today" }).parentElement;
    expect(header?.classList.contains("sticky")).toBe(true);
    expect(header?.classList.contains(LAYER.header)).toBe(true);
  });
});

describe("the lines", () => {
  /**
   * **The two halves of the feed, side by side.** A `deck` row came out of `deck_audit` and is
   * worded by the deck history's own sentence builder, so it reads here exactly as it reads in
   * that dialog; a `collection` row is worded by `activityText.ts`. This widget writes neither
   * and adds nothing of its own to either.
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

    const rows = within(card()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Added 3 × Lightning Bolt");
    expect(rows[0]).toHaveTextContent("to Binder A · Foil");
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

      expect(within(card()).getAllByRole("listitem")).toHaveLength(2);
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

    const stamp = within(card()).getByText("08:30");
    expect(stamp).toHaveAttribute("datetime", new Date(at(2026, 8, 11, 8, 30) * 1000).toISOString());
  });
});

describe("the four sentences", () => {
  /** A read in flight is not an empty database, and the two look identical drawn as a blank
   *  card. */
  it("says it is still reading", () => {
    activityRecent.mockReturnValue(new Promise(() => {}));
    draw();

    expect(within(card()).getByText("Reading recent activity…")).toBeInTheDocument();
    expect(screen.queryByText("Nothing has happened yet.")).toBeNull();
  });

  /** A new database is a complete answer rather than a failure, and it is worth an invitation. */
  it("says nothing has happened yet, for a database with no rows", async () => {
    draw();

    expect(await within(card()).findByText("Nothing has happened yet.")).toBeInTheDocument();
  });

  /**
   * **`deck_audit` is synced and `activity` is not**, so in a paired group the deck lines arrive
   * from every device and the collection and wishlist lines are this one's. There is no UI for
   * that asymmetry — inventing one would be a chip on a page most readers have no group for —
   * but the empty state may not claim the feed is everything the reader has ever done either.
   */
  it("keeps the empty state honest about being this device's feed", async () => {
    draw();
    await within(card()).findByText("Nothing has happened yet.");

    expect(within(card()).getByText(/this device/i)).toBeInTheDocument();
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

    expect(await within(card()).findByText("Recent activity could not be read.")).toBeInTheDocument();
    expect(
      within(card()).getByText(/BUSY: the database is being written to/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nothing has happened yet.")).toBeNull();
  });
});

describe("the limit", () => {
  /** The default is 50, and an unconfigured widget is what every reader starts with. */
  it("asks for fifty changes by default", async () => {
    draw();

    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(50));
  });

  /** A stored config is read through `widgetConfig`, so a widget a reader has narrowed asks for
   *  what they chose — and files the answer under a key of its own. */
  it("asks for the stored limit and files it under that key", async () => {
    draw({ config: { limit: 25 } });

    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(25));
  });

  /**
   * **`widgetConfig` checks the shape and never the range**, which its own doc says: a stored
   * `NaN` is a number and passes, and `NaN` reaches SQLite as a limit no row can be read under.
   * The floor and the ceiling are the backend's own clamp, said once on this side so the request
   * is answerable before it is sent.
   */
  it("narrows a stored limit the backend could not answer", async () => {
    draw({ config: { limit: 9_999 } });
    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(500));

    activityRecent.mockClear();
    draw({ config: { limit: Number.NaN } });
    await waitFor(() => expect(activityRecent).toHaveBeenCalledWith(50));
  });

  /**
   * **The config is spread, never replaced.** `setConfig` stores whatever a widget hands it, and
   * `widgetConfig` carries keys this build has never heard of straight through — so a widget that
   * wrote `{ limit }` alone would silently delete a newer build's settings on the first press.
   */
  it("writes the chosen limit back and keeps what it does not understand", async () => {
    const user = userEvent.setup();
    const { onConfig } = draw({
      entries: [entry()],
      config: { limit: 50, futureThing: "keep me" },
      editing: true,
    });

    await user.click(screen.getByRole("button", { name: "Settings for Activity" }));
    await pickOption(user, "Changes to show", `${ACTIVITY_LIMITS[2]} changes`);

    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith({ limit: ACTIVITY_LIMITS[2], futureThing: "keep me" });
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
      expect(within(card()).getByText("Added Sol Ring")).toBeInTheDocument();
      expect(activityRecent).not.toHaveBeenCalled();

      activityRecent.mockResolvedValue([entry({ cardName: "Lightning Bolt" })]);
      await act(async () => {
        await client.invalidateQueries({ queryKey: [root] });
      });

      await waitFor(() =>
        expect(within(card()).getByText("Added Lightning Bolt")).toBeInTheDocument(),
      );
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
});
