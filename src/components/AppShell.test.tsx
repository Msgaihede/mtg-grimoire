import { useEffect, useRef, type ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render as renderBare, screen, waitFor, within } from "@testing-library/react";
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
/** The two writes a card dropped on the sidebar means, and the read that names the open
 *  deck — the sidebar borrows `useDeck`, so the shell asks for a deck like the editor does. */
const deckAddCard = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
const deckGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun,
    onSyncProgress,
    onCollectionReconciled,
    searchCards: vi.fn(),
    deckAddCard,
    wishlistAdd,
    deckGet,
  },
}));

import { AppShell, DROP_OVER, DROP_RING } from "./AppShell";
import { REPORT_MS } from "./useSidebarDrops";
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
 */
const render = (ui: ReactElement) =>
  renderBare(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

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
  deckAddCard.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1, removed: false });
  deckGet.mockReset().mockResolvedValue(null);
});

it("renders nav and refresh button", async () => {
  render(
    <AppShell update={noUpdate}>
      <div>content</div>
    </AppShell>,
  );

  // By role, not by text: the ribbon now renders the active view's title with the same
  // word the nav item uses, so a bare `getByText("Search")` is ambiguous.
  expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Decks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /refresh/i })).toBeInTheDocument();
  expect(screen.getByText("content")).toBeInTheDocument();
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

    expect(await screen.findByText(/116,568 cards/)).toHaveAttribute(
      "title",
      "C:\\Users\\x\\AppData\\Roaming\\mtg\\data",
    );
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
 * The sidebar as a place to let a card go.
 *
 * Driven over the drag library's own code path (`src/test-drag.ts`) from a source registered
 * the way every card surface in the app registers one — `cardDraggable` with a payload — so
 * what these tests exercise is the real `readDragData` boundary and the real drop target, not
 * a callback called by hand. What jsdom still cannot reach is recorded in `test-drag.ts` and
 * is the live CDP pass's to prove.
 */
describe("the sidebar's drop targets", () => {
  const BOLT: DragPayload = { kind: "card", cardId: "c-bolt", name: "Lightning Bolt" };

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
  const addedToDeck = (deckId: number) => [deckId, "c-bolt", null, "Main deck", "live", 1];

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
    const held = await pickUp({ kind: "search-card", cardId: "c-bolt", name: "Lightning Bolt" });

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
});
