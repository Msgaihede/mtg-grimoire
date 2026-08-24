import { useEffect, useRef, type ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckDetail, SyncOutcome, SyncProgressEvent, SyncStatus } from "@/lib/ipc";

const syncStatus = vi.hoisted(() => vi.fn());
const syncRun = vi.hoisted(() => vi.fn());
const onSyncProgress = vi.hoisted(() => vi.fn());
// The shell invalidates the query cache when a sync finishes, and registers a listener for
// the reconcile event on the way up. Mocked because a `.catch` cannot catch the
// synchronous `TypeError` of calling `undefined`.
const onCollectionReconciled = vi.hoisted(() => vi.fn());
/** The third event this window subscribes to, and the one this file is most about: the ribbon
 *  describes a price-feed fetch the same way it describes a sync, and the fetch can be started
 *  by the backend at app start rather than by anything on screen. */
const onMarketplaceProgress = vi.hoisted(() => vi.fn());
/** The fourth, and the one whose *status* read matters more than its event: the taxonomy
 *  refresh is spawned at launch, so the ribbon learns about it from `oracle_tags_status`
 *  rather than from an event this window was too late to hear. */
const onOracleTagProgress = vi.hoisted(() => vi.fn());
/** The two writes a card dropped on the sidebar means, and the read that names the open
 *  deck — the sidebar borrows `useDeck`, so the shell asks for a deck like the editor does. */
const deckAddCard = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
/** The rail's own `app_meta` row: whether the sidebar opens as 68px of icons or 208px of
 *  labels. Hoisted spies rather than a fixed answer, because the collapse block below drives
 *  all three of its states — stored open, stored collapsed, and a read that fails. */
const navCollapsed = vi.hoisted(() => vi.fn());
const setNavCollapsed = vi.hoisted(() => vi.fn());
// `TitleBar` is the one thing in this shell that does not go through `@/lib/ipc` — it reads the
// window, through `@/lib/window`. The workbench's fakes rather than hand-rolled stubs, so this
// file and Storybook agree about what a window does. Left off, the real `@tauri-apps/api`
// reaches for `window.__TAURI_INTERNALS__`, which jsdom does not have, and because both calls
// are in a mount effect the rejection is unhandled rather than caught — every test here still
// passes while the run prints hundreds of errors.
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun,
    onSyncProgress,
    onCollectionReconciled,
    onMarketplaceProgress,
    onOracleTagProgress,
    // A database that has never ingested the taxonomy: every field null, stale, and nothing
    // running. The honest resting state, and the one that puts no fourth job in the ribbon.
    oracleTagsStatus: vi.fn().mockResolvedValue({
      updatedAt: null,
      ingestedAt: null,
      checkedAt: null,
      tagCount: null,
      taggingCount: null,
      stale: true,
      refreshing: false,
    }),
    // The shell reads the feeds' state to describe a running fetch. Empty is "nothing known
    // yet", which is what every test in this file is standing in.
    marketplaceFeedStatus: vi.fn().mockResolvedValue([]),
    getMarketplace: vi.fn().mockResolvedValue("tcgplayer"),
    // The shell mounts `useCardZoomPersistence`, which reads this once as it launches. An empty
    // row is a database nobody has zoomed, so every wall opens at `DEFAULT_ZOOM` — which is what
    // every test in this file is standing in.
    cardZoom: vi.fn().mockResolvedValue({}),
    setCardZoom: vi.fn().mockResolvedValue(undefined),
    // The shell reads the rail's width once as it launches and writes it back on every press.
    // Answered `false` in the `beforeEach` below, which is a database nobody has collapsed the
    // sidebar in — the state every test in this file but the collapse block stands in.
    navCollapsed,
    setNavCollapsed,
    // And the deck editor's search column, read here at launch rather than where it is drawn —
    // the shell mounts `usePrefetchDeckSearchOpen` so the answer is in the cache long before a
    // deck is opened. Nothing in this file draws a deck editor, so the value it answers is not
    // the point; being callable is, because a `queryFn` reaching `undefined` is a rejection this
    // shell's error boundary would have to survive for no reason.
    deckSearchOpen: vi.fn().mockResolvedValue(true),
    setDeckSearchOpen: vi.fn().mockResolvedValue(undefined),
    searchCards: vi.fn(),
    // The filter row asks for facet counts beside the page. Answered **cold** — `ready:
    // false`, every map empty — so nothing greys and every control keeps its plain name.
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
    deckAddCard,
    wishlistAdd,
    deckGet,
  },
}));

import { AppShell } from "./AppShell";
import { REPORT_MS } from "./useSidebarDrops";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { CardToDeckProvider, useAddCardToDeck } from "@/features/card/cardMenu";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { LAYER } from "@/lib/layers";
import { DURATION } from "@/lib/motion";
import type { Update } from "@/lib/useUpdate";
import { cardDraggable, type DragPayload } from "@/features/decks/dnd";
import { queryClient } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { startDrag } from "@/test-drag";

/**
 * The shell's update state, in its resting position: nothing found, nothing running.
 *
 * These tests are about the sidebar, the sync and the drop targets, and `App` — not the
 * shell — is what actually calls `useUpdate`. The ribbon's update button has its own tests
 * in `Ribbon.test.tsx`, where the interesting values are.
 */
const noUpdate: Update = {
  status: null,
  progress: null,
  busy: false,
  action: "none",
  error: null,
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  openReleasePage: vi.fn(),
};

/**
 * The shell, under the app's own query client.
 *
 * It used to render bare, and the two hooks that avoid `useQueryClient` say so as their
 * reason. It cannot any more: the sidebar's Decks entry borrows `useDeck`'s write and the
 * read that names the deck, which is a provider's job — and `App` has always wrapped the shell
 * in exactly this client, so this is what the shell really renders in. The *module's* client
 * rather than a fresh one per test, so a query seeded here is the one the sidebar reads and
 * `invalidate` below is the spy it fires.
 *
 * **`TooltipProvider` joined the stack 2026-08-20**, outside `CardToDeckProvider` in `App.tsx`'s
 * own order — without it the ribbon's status-line tooltip (below) binds the no-op API and never
 * opens, which is `useTooltip()`'s documented trade for a dropped provider rather than a throw.
 */
const render = (ui: ReactElement) =>
  renderBare(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* The shell draws the sentence a refused card-menu deck add leaves and reads it through
            this context, so it is as much a part of the shell's surroundings as the query client.
            `App.tsx` mounts it **above `ContextMenuProvider`** rather than here, because that
            provider draws its panel as a sibling of the shell — a menu's rows are not inside the
            shell, which is a trap that cost one commit. */}
        <CardToDeckProvider>{ui}</CardToDeckProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  cardCount: 116_568,
  lastCheckAt: "1800000000",
  bulkUpdatedAt: "2026-08-03T21:16:27.869+00:00",
  lastError: null,
  lastIngestSkipped: 0,
  dataDir: "D:\\app\\data",
  syncing: false,
  imageStoreFailures: 0,
  ...over,
});

/** A promise this test settles by hand, standing in for a sync that takes minutes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing else awaits these, and an unsettled rejection would be an unhandled one.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** The cache every write here settles through, spied once and cleared per test rather than
 *  re-wrapped in each one. */
const invalidate = vi.spyOn(queryClient, "invalidateQueries");

beforeEach(() => {
  // The open deck decides whether the Decks entry can take a card, so it is reset with the
  // view — a deck left open by one test would make the next one's inert case a lie.
  useAppStore.setState({ activeView: "search", openDeckId: null });
  queryClient.clear();
  invalidate.mockClear();
  syncStatus.mockReset().mockResolvedValue(status());
  syncRun.mockReset().mockResolvedValue({ updated: false, cardCount: 116_568, updatedAt: null });
  onSyncProgress.mockReset().mockResolvedValue(() => {});
  onCollectionReconciled.mockReset().mockResolvedValue(() => {});
  onMarketplaceProgress.mockReset().mockResolvedValue(() => {});
  onOracleTagProgress.mockReset().mockResolvedValue(() => {});
  deckAddCard.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  deckGet.mockReset().mockResolvedValue(null);
  navCollapsed.mockReset().mockResolvedValue(false);
  setNavCollapsed.mockReset().mockResolvedValue(undefined);
});

it("renders nav and refresh button", async () => {
  render(
    <AppShell update={noUpdate}>
      <div>content</div>
    </AppShell>,
  );

  // By role, not by text: the ribbon now renders the active view's title with the same
  // word the nav item uses, so a bare `getByText("Search")` is ambiguous.
  //
  // **In DOM order, because the order is a decision rather than the array's history** — the two
  // ways into the database, then the three lists the reader owns, then Settings. Six separate
  // `getByRole` calls stayed green through any shuffle of the column, which is the one thing
  // about this list a reader would notice from across the room. `within` the rail keeps the
  // ribbon's own title out of the answer, and the toggle at the rail's foot is the seventh
  // button inside it.
  const nav = screen.getByRole("navigation", { name: "Views" });
  expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Search",
    "Tagger",
    "Decks",
    "Collection",
    "Wishlist",
    "Settings",
    "Collapse",
  ]);
  expect(await screen.findByRole("button", { name: /refresh/i })).toBeInTheDocument();
  expect(screen.getByText("content")).toBeInTheDocument();
});

/**
 * The three controls that stop being optional the moment `tauri.conf.json` says
 * `decorations: false`.
 *
 * `TitleBar` has its own file for how each behaves; this asserts only that the shell still
 * mounts it — which is the difference between a window the reader can put down and one they
 * cannot. Nothing else in the app draws a close button, so dropping this component is not a
 * cosmetic regression and would leave every other test in this file green.
 */
it("draws the window's own caption, because Windows no longer does", () => {
  render(
    <AppShell update={noUpdate}>
      <div>content</div>
    </AppShell>,
  );

  expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
});

describe("the status line", () => {
  it("counts the cards and dates the data", async () => {
    render(<AppShell update={noUpdate}>{null}</AppShell>);

    expect(await screen.findByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
  });

  it("says the database is empty rather than showing a zero", async () => {
    syncStatus.mockResolvedValue(status({ cardCount: 0, bulkUpdatedAt: null }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    expect(await screen.findByText("No card data yet")).toBeInTheDocument();
  });

  /**
   * The data directory is chosen at startup and can silently be the AppData fallback
   * rather than the folder beside the exe; spec §3 wants that visible. Nothing else in
   * the window ever names a path.
   */
  it("names the live data directory as a tooltip", async () => {
    syncStatus.mockResolvedValue(status({ dataDir: "C:\\Users\\x\\AppData\\Roaming\\mtg\\data" }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    const line = await screen.findByText(/116,568 cards/);
    await userEvent.hover(line);
    const panel = await screen.findByRole("tooltip", undefined, { timeout: 2000 });
    expect(panel).toHaveTextContent("C:\\Users\\x\\AppData\\Roaming\\mtg\\data");
  });

  /**
   * The end-to-end claim: an event out of `sync.rs` becomes a sentence in the row. Every
   * piece of this has a unit test of its own; this is the one test that proves they are
   * connected.
   *
   * Real timers, not fake ones, because the assertion is about a 400 ms threshold and
   * `findByText` is already a polling wait. It costs the suite half a second.
   */
  it("says what the sync is doing, once it has been doing it for a moment", async () => {
    let emit: ((e: SyncProgressEvent) => void) | undefined;
    onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit!({ phase: "ingesting", done: 83_000, total: 117_000, message: null }));

    // Not immediately: a sub-second phase must not flash a sentence at the reader, and the
    // corpus summary holds the row until the job has earned it.
    expect(screen.queryByText(/Importing cards/)).not.toBeInTheDocument();
    expect(screen.getByText(/116,568 cards/)).toBeInTheDocument();

    // The label is the element's own text and the count is a child span, so the whole
    // sentence is read off the line rather than matched as one string.
    const line = await screen.findByText(/Importing cards/, {}, { timeout: 3000 });
    expect(line).toHaveTextContent("Importing cards · 83,000 cards");
  });

  /** The corpus summary is not lost while it is hidden — it comes straight back, because it
   *  is a static fact about a database rather than an answer to one click. */
  it("gives the summary back when the sync stops", async () => {
    let emit: ((e: SyncProgressEvent) => void) | undefined;
    onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
      emit = cb;
      return Promise.resolve(() => {});
    });
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);
    await waitFor(() => expect(emit).toBeDefined());
    act(() => emit!({ phase: "ingesting", done: 83_000, total: 117_000, message: null }));
    await screen.findByText(/Importing cards/, {}, { timeout: 3000 });

    syncStatus.mockResolvedValue(status({ syncing: false }));

    expect(
      await screen.findByText("116,568 cards · data from 2026-08-03", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

describe("the Refresh button", () => {
  it("forces a sync and re-reads the status when the call finishes", async () => {
    const run = deferred<SyncOutcome>();
    syncRun.mockReturnValue(run.promise);
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });
    await waitFor(() => expect(syncStatus).toHaveBeenCalled());
    const pollsBefore = syncStatus.mock.calls.length;

    await userEvent.click(button);

    expect(syncRun).toHaveBeenCalledWith(true);
    // Driven by the invoke promise, not by `sync:progress`: a run throttled by the 24 h
    // window returns without emitting a single event, and a spinner waiting for one
    // would never stop.
    expect(button).toBeDisabled();

    await act(async () => {
      run.resolve({ updated: true, cardCount: 116_600, updatedAt: null });
    });

    await waitFor(() => expect(button).toBeEnabled());
    await waitFor(() => expect(syncStatus.mock.calls.length).toBeGreaterThan(pollsBefore));
  });

  /**
   * The 304 outcome, which is what most Refreshes get: nothing downloads, nothing
   * ingests, and without a word from the UI the button simply spins and stops. Spec §4.5
   * asks for "already up to date" — the one case where saying nothing is indistinguishable
   * from failing.
   */
  it("says so when a Refresh finds nothing new", async () => {
    syncRun.mockResolvedValue({ updated: false, cardCount: 116_568, updatedAt: null });
    render(<AppShell update={noUpdate}>{null}</AppShell>);

    await userEvent.click(await screen.findByRole("button", { name: /refresh/i }));

    expect(await screen.findByText(/already up to date/i)).toBeInTheDocument();
  });

  it("stays quiet when the Refresh actually ingested something", async () => {
    syncRun.mockResolvedValue({ updated: true, cardCount: 116_600, updatedAt: null });
    render(<AppShell update={noUpdate}>{null}</AppShell>);

    await userEvent.click(await screen.findByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(syncRun).toHaveBeenCalled());
    expect(screen.queryByText(/already up to date/i)).not.toBeInTheDocument();
  });

  it("stays disabled while a sync started elsewhere is running", async () => {
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled());
    expect(syncRun).not.toHaveBeenCalled();
  });

  it("surfaces a rejected sync_run", async () => {
    syncRun.mockRejectedValue("sync already running");
    // Which is what "already running" means: the run it collided with is still going.
    syncStatus.mockResolvedValueOnce(status()).mockResolvedValue(status({ syncing: true }));
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });

    await userEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent("sync already running");
  });

  /**
   * A rejection is this session's account of one click. Once a poll reports that nothing
   * is running, that account is stale — and leaving it up would shadow whatever the
   * backend has since recorded in `lastError` for the rest of the session.
   */
  it("drops a stale rejection once nothing is running any more", async () => {
    syncRun.mockRejectedValue("sync already running");
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });

    await userEvent.click(button);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("the error banner", () => {
  it("shows the failure the last run persisted", async () => {
    syncStatus.mockResolvedValue(status({ lastError: "rate limited by Scryfall" }));

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited by Scryfall");
  });

  /**
   * A poll that could not read the database at all answers `null` for every
   * database-derived field, `lastError` included. Reading that as "the error is gone"
   * would clear a banner the user has not acknowledged, and blank the card count with it.
   * (An ingest no longer produces this — `sync::status` reads through `db_read` — but an
   * unusable read connection still can.)
   */
  it("survives a poll that could read nothing", async () => {
    syncStatus.mockResolvedValueOnce(status({ lastError: "rate limited by Scryfall" }));
    syncStatus.mockResolvedValue({
      cardCount: null,
      lastCheckAt: null,
      bulkUpdatedAt: null,
      lastError: null,
      lastIngestSkipped: null,
      dataDir: "D:\\app\\data",
      // The one field here that is *not* database-derived — it is an in-memory flag — and
      // the one the assertion below depends on. A blind poll can report either, and it has
      // to be `false` for the merged count to be observable at all: while a sync is running
      // the status line reports the sync, which is the whole point of the activity line.
      syncing: false,
      imageStoreFailures: 0,
    });
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });
    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited by Scryfall");

    // Forces the second, blind poll to land.
    await userEvent.click(button);

    await waitFor(() => expect(syncStatus.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole("alert")).toHaveTextContent("rate limited by Scryfall");
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
  });
});

/**
 * The overlay covers the header, so its Retry is the only control the user can reach on
 * a first run that failed. It has to reach the same forced sync the header's button does.
 */
it("retries the first run from inside the overlay", async () => {
  syncStatus.mockResolvedValue(
    status({ cardCount: 0, bulkUpdatedAt: null, lastError: "rate limited by Scryfall" }),
  );
  render(<AppShell update={noUpdate}>{null}</AppShell>);

  await userEvent.click(await screen.findByRole("button", { name: /retry/i }));

  expect(syncRun).toHaveBeenCalledWith(true);
});

it("switches the active view", async () => {
  render(<AppShell update={noUpdate}>{null}</AppShell>);

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  expect(useAppStore.getState().activeView).toBe("decks");
  expect(screen.getByRole("button", { name: "Decks" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-current");
});

/**
 * The rail as two widths (issue #177).
 *
 * **Nothing in this block can see 68px.** jsdom has no layout engine, so the rail measures
 * nothing in either state and the width transition never runs; what is pinned instead is the
 * class that *is* the mechanism, which is what `Dialog.test.tsx` does for the two classes that
 * clamp a modal and for the same reason. The numbers belong to a live pass, and 2026-08-22's
 * recorded them: 68px is a 43×44 target inside the `<nav>`'s own `p-3` (the rail's `border-r`
 * takes the pixel that would have made it square), and it hands `main` back 140px — 1072 → 1212
 * at 1280×800, the window where the deck editor has ten of them to spare.
 *
 * What jsdom *can* see is everything that matters about whether the app is still usable
 * collapsed — the names, the presses, the writes and the live regions — and that is what the
 * rest of this block is.
 */
describe("collapsing the sidebar", () => {
  /** The rail itself. By role and name, because there is no other landmark in this shell. */
  const rail = () => screen.getByRole("navigation", { name: "Views" });

  it("takes the rail down to icons and back, storing each answer as it goes", async () => {
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    expect(rail()).toHaveClass("w-52");

    await userEvent.click(collapse);

    await waitFor(() => expect(rail()).toHaveClass("w-17"));
    await waitFor(() => expect(setNavCollapsed).toHaveBeenCalledWith(true));

    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));

    await waitFor(() => expect(rail()).toHaveClass("w-52"));
    await waitFor(() => expect(setNavCollapsed).toHaveBeenLastCalledWith(false));
  });

  it("opens collapsed when that is what the database has stored", async () => {
    navCollapsed.mockResolvedValue(true);

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(rail()).toHaveClass("w-17");
    // Reading a stored width is not a choice the reader made, so nothing is written back.
    expect(setNavCollapsed).not.toHaveBeenCalled();
  });

  /**
   * A read that fails is the one state where the shell has to *decide* rather than obey, and
   * "expanded" is the decision: a database that cannot say must open the way this app has always
   * opened — six named destinations — rather than putting them behind an icon the reader has to
   * guess their way out of. It is also not news, so nothing says it: the sidebar has no sentence
   * to spend on a preference.
   */
  it("opens expanded when the stored width cannot be read, and says nothing about it", async () => {
    navCollapsed.mockRejectedValue("no such table: app_meta");

    render(<AppShell update={noUpdate}>{null}</AppShell>);

    await waitFor(() => expect(navCollapsed).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
    expect(rail()).toHaveClass("w-52");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * The whole point of the collapsed label being `sr-only` rather than an `aria-label`: the
   * accessible name is computed from content in both states, so it is the *same string* — and
   * every `getByRole("button", { name: … })` in this repository goes on meaning what it meant.
   * An `aria-label` would be a second place each word is written, and the first of the two to
   * change would be the one nothing tested.
   */
  it("keeps the six destinations named, and pressable, while they are drawn as icons", async () => {
    navCollapsed.mockResolvedValue(true);
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    await screen.findByRole("button", { name: "Expand sidebar" });

    for (const label of ["Search", "Tagger", "Decks", "Collection", "Wishlist", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("button", { name: "Decks" }));

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(screen.getByRole("button", { name: "Decks" })).toHaveAttribute("aria-current", "page");
  });

  /** An entry's word, which is in the DOM in both states and `sr-only` in one of them. */
  const word = (label: string) =>
    screen.getByRole("button", { name: label }).querySelector("span");

  /**
   * The first half of the 2026-08-22 report, as the rule rather than as the symptom.
   *
   * The rail's width is a CSS transition and its labels are a React commit, so flipping one flag
   * put six words back in the flow at their full width while the rail was still 68px and
   * growing — painted over the view beside it for the whole 180ms, because `<nav>` carries no
   * `overflow-hidden` and cannot (the collapsed rail's floating notes hang off it at
   * `left-full`).
   *
   * **Fake timers rather than an assertion racing a real 180ms.** The window this is about is
   * exactly the tween's length, so on a loaded runner a real-timer version would be asserting
   * about whichever side of it the machine happened to be on — green or red for reasons that
   * are not the code's. `setTimeout` only, for the reason the drop-report block below gives:
   * the mutation settles on a microtask and faking that stalls the press rather than the timer.
   */
  it("keeps the words out of the rail until it has finished widening", async () => {
    navCollapsed.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(<AppShell update={noUpdate}>{null}</AppShell>);
      await act(async () => {});
      expect(word("Decks")).toHaveClass("sr-only");

      // `fireEvent` rather than `userEvent`: the latter's own scheduler runs on `setTimeout`,
      // and pointing it back at the clock this test is holding still is a knot for no gain —
      // what is being checked is one press, not a gesture.
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      // **Query delivers its notifications on a `setTimeout(0)`**, so the optimistic write is
      // not on screen until the clock is nudged — and a nudge of 0 fires exactly that and
      // nothing else, leaving the reveal 180ms out where the assertions below want it.
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // The rail is already on its way — this is the state the words must not be painted in.
      expect(rail()).toHaveClass("w-52");
      expect(word("Decks")).toHaveClass("sr-only");

      await act(async () => {
        vi.advanceTimersByTime(DURATION.base);
      });

      expect(word("Decks")).not.toHaveClass("sr-only");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * And the other direction, which is asymmetric on purpose: the words leave in the same commit
   * as the press, so nothing is ever painted wider than the rail holding it. A symmetric delay
   * here would be the same overflow with the sign flipped.
   */
  it("drops the words in the commit that starts the rail closing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(<AppShell update={noUpdate}>{null}</AppShell>);
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      expect(word("Decks")).not.toHaveClass("sr-only");

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // The same nudge that put the new width on screen: one commit, both facts.
      expect(rail()).toHaveClass("w-17");
      expect(word("Decks")).toHaveClass("sr-only");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The second half of the report, and the only part of it jsdom can hold an opinion about.
   *
   * The row used to centre its content while collapsed. That is the same place at rest — the
   * icon sits 24px from the rail's left edge either way — but the class flips on the **press**
   * and the width takes 180ms to follow, so for that 180ms each icon was being centred in a box
   * still 183px wide: out to 81.5 and slid back as the rail closed around it. There is no layout
   * engine here to measure the travel, so this pins the cause — an entry is left-anchored in both
   * states, and the only thing its width can move is the box, not the icon inside it.
   */
  it("anchors every icon to the same edge in both states", async () => {
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    const entries = () =>
      ["Search", "Tagger", "Decks", "Collection", "Wishlist", "Settings"].map((label) =>
        screen.getByRole("button", { name: label }),
      );
    for (const entry of [...entries(), collapse]) {
      expect(entry).not.toHaveClass("justify-center");
    }

    await userEvent.click(collapse);
    await waitFor(() => expect(rail()).toHaveClass("w-17"));

    for (const entry of [...entries(), screen.getByRole("button", { name: "Expand sidebar" })]) {
      expect(entry).not.toHaveClass("justify-center");
      // Still 44px, which is what the row would lose to an out-of-flow label without it.
      expect(entry).toHaveClass("h-11");
    }
  });

  /** `aria-expanded` on the control and `aria-controls` at the region: the pair is what says
   *  *what* the press did, rather than only that something happened. */
  it("says on the toggle whether the rail it controls is open", async () => {
    render(<AppShell update={noUpdate}>{null}</AppShell>);
    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-controls", rail().id);

    await userEvent.click(collapse);

    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(expand).toHaveAttribute("aria-controls", rail().id);
  });
});

/**
 * The sidebar as a place to let a card go.
 *
 * Driven over the drag library's own code path (`src/test-drag.ts`) from a source registered
 * the way every card surface in the app registers one — `cardDraggable` with a payload — so
 * what these tests exercise is the real `readDragData` boundary and the real drop target, not
 * a callback called by hand. What jsdom still cannot reach is recorded in `test-drag.ts` and
 * is the live CDP pass's to prove.
 */
describe("the sidebar's drop targets", () => {
  const BOLT: DragPayload = {
    kind: "card",
    cardId: "c-bolt",
    name: "Lightning Bolt",
    typeLine: "Instant",
  };

  /** A card that can be picked up, standing in for the four walls that carry one. */
  function CardSource({ payload }: { payload: DragPayload }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const element = ref.current;
      if (!element) return;
      return cardDraggable({ element, payload: () => payload });
    }, [payload]);
    return <div ref={ref}>a card</div>;
  }

  /** The shell with a card in it, and that card in the air. */
  async function pickUp(payload: DragPayload = BOLT) {
    render(
      <AppShell update={noUpdate}>
        <CardSource payload={payload} />
      </AppShell>,
    );
    return startDrag(screen.getByText("a card"));
  }

  /**
   * What a drop on the Decks entry sends, spelled out once.
   *
   * A sidebar entry has no column to point at, so it names **no category id** and lets the
   * command find or create one by name — `useDeck`'s `DEFAULT_CATEGORY_NAME`, which is the v8
   * migration's own word for the pile it filed every legacy main-deck row into. The name is
   * written out here rather than imported because the hook keeps it private, and a test that
   * spells it is a test that notices the day it changes (which is the day `autoCategoryFor`
   * lands and this stops being one word at all).
   */
  /**
   * What the Decks entry writes: **no category id, and the name the card's own type line
   * earned.**
   *
   * A nav item several views away from the deck has no column for the reader to have pointed at,
   * so it files by `autoCategoryFor` — and both payloads these tests drop carry `Instant`, which
   * is where the word comes from. It used to be a found-or-created "Main deck" for everything.
   */
  const addedToDeck = (deckId: number) => [deckId, "c-bolt", null, "Instant", "live", null, 1];

  const entry = (label: string) => screen.getByRole("button", { name: label });
  /** The entry's own live region — the line under its button, where a drop reports. */
  const report = (label: string) =>
    within(entry(label).parentElement as HTMLElement).getByRole("status");

  /**
   * A deck open in the editor, as the sidebar sees it: the store's id, and the detail the
   * editor's own `deck_get` has already put in the cache.
   *
   * Seeded rather than only mocked, and the key is spelled out rather than imported: the
   * sidebar shares `["decks", "detail", id]` with the editor, and a test that writes it by
   * hand is a test that would notice the day the two stopped meaning the same thing. Fresh
   * data (the client's `staleTime` is 30 s) so the name is there on the first render — no
   * `deck_get` needed, exactly as with an editor already up. Only the name is read.
   */
  const openDeck = (id: number, name: string) => {
    const detail = { deck: { id, name }, cards: [] } as unknown as DeckDetail;
    useAppStore.setState({ openDeckId: id });
    queryClient.setQueryData(["decks", "detail", id], detail);
    deckGet.mockResolvedValue(detail);
  };

  it("rings the entries a card can land on, and stands the ring down when the drag is cancelled", async () => {
    openDeck(7, "Burn");
    const held = await pickUp();

    expect(entry("Decks")).toHaveClass(DROP_RING);
    expect(entry("Wishlist")).toHaveClass(DROP_RING);
    // The collection is deliberately not a target: `collection_add` carries a finish, a
    // condition and a language that a drop cannot answer.
    expect(entry("Collection")).not.toHaveClass("ring-accent");

    await held.cancel();

    expect(entry("Decks")).not.toHaveClass("ring-accent");
    expect(entry("Wishlist")).not.toHaveClass("ring-accent");
  });

  /** Which of the ringed pair is about to take the card. Drawn from the drop target's own
   *  enter and leave, because `:hover` does not update while the pointer is holding something. */
  it("marks the entry the card is actually over, and unmarks it on the way out", async () => {
    const held = await pickUp();
    const wishlist = entry("Wishlist");

    await held.over(wishlist);
    expect(wishlist).toHaveClass(DROP_OVER);

    await held.leave();
    expect(wishlist).not.toHaveClass(DROP_OVER);
    await held.cancel();
  });

  /** The docked panel's tiles carry their own kind, and they are the drag that reaches the
   *  Decks entry most often: the panel is the one card surface an open editor coexists with. */
  it("takes the docked panel's own payload", async () => {
    openDeck(7, "Burn");
    const held = await pickUp({
      kind: "search-card",
      cardId: "c-bolt",
      name: "Lightning Bolt",
      typeLine: "Instant",
    });

    await held.over(entry("Decks"));
    await held.drop();

    await waitFor(() => expect(deckAddCard).toHaveBeenCalledWith(...addedToDeck(7)));
  });

  it("leaves Decks inert while no deck is open, and says why", async () => {
    const held = await pickUp();
    const decks = entry("Decks");

    expect(decks).not.toHaveClass("ring-accent");
    expect(decks).toHaveAttribute("title", "Open a deck to drop cards into it");
    // The wishlist takes a card from anywhere, whatever the Decks view is doing.
    expect(entry("Wishlist")).toHaveClass(DROP_RING);

    await held.over(decks);
    await held.drop();

    expect(deckAddCard).not.toHaveBeenCalled();
    expect(report("Decks")).toBeEmptyDOMElement();
  });

  it("wishes for the printing dropped on Wishlist", async () => {
    const held = await pickUp();
    // The region exists before there is anything to say: a live region that first appears
    // with its sentence already in it announces nothing.
    expect(report("Wishlist")).toBeEmptyDOMElement();

    await held.over(entry("Wishlist"));
    await held.drop();

    await waitFor(() => expect(report("Wishlist")).toHaveTextContent("Added to wishlist."));
    // Quantity 1, and the printing that was dragged — a wish made from a card the reader was
    // looking at is a wish for *that* one.
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "c-bolt", quantity: 1 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    // A search result draws `wishlisted`, so the heart on every printing of this card has
    // just changed.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
  });

  /** Every payload this app drags names a card, and a deck row is a card like any other:
   *  dropped on the wishlist it is a wish for that printing. */
  it("takes a card dragged out of a deck row too", async () => {
    const held = await pickUp({
      kind: "deck-card",
      finish: null,
      cardId: "c-bolt",
      name: "Lightning Bolt",
      // A `deck_categories.id`, which is what a deck row carries since schema v8 — and it has
      // to be a positive safe integer or `readDragData` refuses the payload outright.
      fromCategoryId: 1,
    });

    await held.over(entry("Wishlist"));
    await held.drop();

    await waitFor(() =>
      expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "c-bolt", quantity: 1 }),
    );
  });

  it("adds one copy to the open deck and names the deck", async () => {
    openDeck(7, "Burn");
    const held = await pickUp();

    await held.over(entry("Decks"));
    await held.drop();

    await waitFor(() => expect(report("Decks")).toHaveTextContent("Added to Burn."));
    expect(deckAddCard).toHaveBeenCalledWith(...addedToDeck(7));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * A card dragged **out of the open deck** and back onto Decks keeps the pile it came from,
   * because it has one: the rule is that a drag names its own destination, and `fromCategoryId`
   * is a category of this very deck (a deck row exists only while its editor is mounted).
   *
   * The `null` type line is the point of the assertion as much as the id is: this payload carries
   * none — a move or a removal has nothing to categorise — so a copy added from the Sideboard
   * lands in the Sideboard rather than in a found-or-created pile named after its type, which is
   * what the auto arm would have done with it.
   */
  it("keeps a deck row's own category when it is dropped back on Decks", async () => {
    openDeck(7, "Burn");
    const held = await pickUp({
      kind: "deck-card",
      finish: null,
      cardId: "c-bolt",
      name: "Lightning Bolt",
      fromCategoryId: 2,
    });

    await held.over(entry("Decks"));
    await held.drop();

    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(7, "c-bolt", 2, null, "live", null, 1),
    );
  });

  /**
   * A deck deleted in another view answers `GONE`, and this surface is outside the editor's
   * refused-write family — so the sentence is read here and the re-read is fired from here.
   */
  it("says a refused add in the same line, and re-reads the deck behind it", async () => {
    openDeck(7, "Burn");
    deckAddCard.mockRejectedValue("That deck is not there any more.");
    const held = await pickUp();

    await held.over(entry("Decks"));
    await held.drop();

    await waitFor(() =>
      expect(report("Decks")).toHaveTextContent("That deck is not there any more."),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  it("clears the line when the next card is picked up", async () => {
    const held = await pickUp();
    await held.over(entry("Wishlist"));
    await held.drop();
    await waitFor(() => expect(report("Wishlist")).toHaveTextContent("Added to wishlist."));

    const again = await startDrag(screen.getByText("a card"));

    expect(report("Wishlist")).toBeEmptyDOMElement();
    await again.cancel();
  });

  it("clears the line after four seconds", async () => {
    // `setTimeout` only: the drag helper waits on a real animation frame, and the mutation
    // settles on a microtask — faking either would stall the gesture rather than the timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const held = await pickUp();
      await held.over(entry("Wishlist"));
      await held.drop();
      await act(async () => {});
      expect(report("Wishlist")).toHaveTextContent("Added to wishlist.");

      await act(async () => {
        vi.advanceTimersByTime(REPORT_MS);
      });

      expect(report("Wishlist")).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  /** The same card twice is two writes: `add_wish` folds into the row that is already there,
   *  and the sum is the backend's arithmetic rather than a number this hook keeps. */
  it("sends a second identical drop as a second write", async () => {
    const held = await pickUp();
    await held.over(entry("Wishlist"));
    await held.drop();
    await waitFor(() => expect(report("Wishlist")).toHaveTextContent("Added to wishlist."));

    const again = await startDrag(screen.getByText("a card"));
    await again.over(entry("Wishlist"));
    await again.drop();

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(2));
    expect(wishlistAdd).toHaveBeenNthCalledWith(2, { cardId: "c-bolt", quantity: 1 });
  });

  /**
   * The same drop with the rail down to 68px, where the report line has no column to be a line
   * in and is drawn as a panel floating beside the rail instead.
   *
   * **The region and its mounting rule do not move** — same `role="status"`, same element,
   * mounted for the life of the entry and `sr-only` while empty — so the sentence arrives here
   * exactly as it does above, which is the half a screen reader hears and the half this can
   * check. The geometry is a live pass's; what is pinned instead is `pointer-events-none`,
   * because that class is the whole of why a panel hanging over the view for four seconds
   * cannot eat the drop it is reporting or the click after it.
   *
   * Finding the entry by its name while it is an icon is the second claim, and it comes free:
   * `entry("Wishlist")` is the ordinary query every other test here uses.
   */
  it("says where a card went in a panel beside the rail when the rail is collapsed", async () => {
    navCollapsed.mockResolvedValue(true);
    const held = await pickUp();
    await screen.findByRole("button", { name: "Expand sidebar" });

    await held.over(entry("Wishlist"));
    await held.drop();

    await waitFor(() => expect(report("Wishlist")).toHaveTextContent("Added to wishlist."));
    expect(report("Wishlist")).toHaveClass("pointer-events-none", LAYER.popup);
  });
});

/**
 * The shell is the app's **one** mount of `useCardToDeck`, and this is what that buys.
 *
 * A card menu is opened on every card surface and its deck add has to outlive the menu — `ctx.run`
 * closes the panel before it calls a row's handler — so the write is mounted here, where
 * `useSidebarDrops` is and for the same reason. Mounting it *once* rather than per surface is
 * the second reason: the sentence a refusal leaves then has one place to be drawn, and a surface
 * never holds it at all.
 */
describe("the card menu's deck write", () => {
  /** A view, standing in for any card surface. It asks the shell for the write and nothing else,
   *  which is the whole claim: there is no `error` in its hands to forget to draw. */
  function AddProbe() {
    const addToDeck = useAddCardToDeck();
    return (
      <button
        onClick={() =>
          addToDeck(
            {
              cardId: "c-bolt",
              name: "Lightning Bolt",
              setCode: "lea",
              collectorNumber: "161",
              oracleId: "o-bolt",
              finishes: '["nonfoil"]',
              typeLine: "Instant",
            },
            4,
            "live",
          )
        }
      >
        add to Burn
      </button>
    );
  }

  /** The Decks entry's own live region, which this sentence deliberately does not use. */
  const decksReport = () =>
    within(screen.getByRole("button", { name: "Decks" }).parentElement as HTMLElement).getByRole(
      "status",
    );

  beforeEach(() => {
    deckGet.mockResolvedValue({ deck: { id: 4, name: "Burn" }, cards: [], categories: [] });
  });

  it("is reachable from any view below the shell", async () => {
    const user = userEvent.setup();
    deckAddCard.mockResolvedValue(undefined);
    render(
      <AppShell update={noUpdate}>
        <AddProbe />
      </AppShell>,
    );

    await user.click(screen.getByRole("button", { name: "add to Burn" }));

    // No category id and a type line: `useDeck.addCard`'s `autoCategoryFor` arm, the same rule a
    // drag with no column under it takes. Reaching this at all is half the assertion — without
    // the provider on this shell `useAddCardToDeck` throws and the view never renders.
    await waitFor(() =>
      expect(deckAddCard).toHaveBeenCalledWith(4, "c-bolt", null, "Instant", "live", null, 1),
    );
  });

  it("says in the sidebar when the add is refused", async () => {
    const user = userEvent.setup();
    deckAddCard.mockRejectedValue(new Error("That deck is not there any more"));
    render(
      <AppShell update={noUpdate}>
        <AddProbe />
      </AppShell>,
    );

    await user.click(screen.getByRole("button", { name: "add to Burn" }));

    // Its own region, and deliberately not the Decks entry's report line: that line is about a
    // card let go *on* the entry, it clears itself after `REPORT_MS`, and one slot holding two
    // lifetimes would hide this sentence and then bring it back when the other's timer expired.
    expect(await screen.findByRole("alert")).toHaveTextContent("That deck is not there any more");
    expect(decksReport()).toBeEmptyDOMElement();
  });
});
