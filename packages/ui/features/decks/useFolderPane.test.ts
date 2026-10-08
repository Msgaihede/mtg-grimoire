import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const deckFolderPane = vi.hoisted(() => vi.fn());
const setDeckFolderPane = vi.hoisted(() => vi.fn());
// The original is spread back in rather than replaced wholesale: `ipc` is a hand-written mirror
// and a bare `vi.fn()` object erases every field this module does not name, so a command added
// later fails at run time instead of at `tsc`. `useNavCollapsed.test.ts`' shape.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckFolderPane, setDeckFolderPane },
}));

import { DEFAULT_FOLDER_TREE_WIDTH_PX } from "./FolderTree";
import { FOLDER_PANE_KEY, FOLDER_WIDTH_WRITE_DELAY_MS, useFolderPane } from "./useFolderPane";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who had dragged the tree wider last time, which is the case that proves the row is
  // read at all rather than the fallback being right by accident — the default is what every
  // failure below also answers.
  deckFolderPane.mockReset().mockResolvedValue({ width: 320, collapsed: false });
  setDeckFolderPane.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

function mount() {
  return renderHook(() => useFolderPane(), { wrapper });
}

/**
 * Open the page with a stored answer already in hand, **by seeding the cache rather than by
 * mocking the command**.
 *
 * That is what {@link FOLDER_PANE_KEY} is exported for, so every timer test below is also the
 * assertion that the key works the way a story would use it. It is also what keeps those tests
 * out of a round trip: the entry is fresh (`staleTime: Infinity`), so nothing is fetched and there
 * is no promise to settle before the clock can be held still.
 */
function seed(pane: { width: number | null; collapsed: boolean }): void {
  client.setQueryData(FOLDER_PANE_KEY, pane);
}

/**
 * `setTimeout`/`clearTimeout` only — the repo's shape, and the reason is the mutation: faking the
 * microtask-adjacent globals stalls the write rather than the timer, so a debounce test would
 * assert about a command that had never been reached.
 */
function holdTheClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/**
 * Do a thing, then let both queues catch up.
 *
 * **Query delivers its notifications on a `setTimeout(0)`**, so an optimistic `setQueryData` is
 * not in `result.current` until the clock is nudged — a nudge of 0 fires exactly that and leaves
 * a 400ms debounce still pending for the assertion about to check it. The `await` is the other
 * half: `mutate` reaches its `mutationFn` a microtask later, so a synchronous `act` would read a
 * command that had not been called yet.
 */
async function settle(fn: () => void = () => {}): Promise<void> {
  await act(async () => {
    fn();
    vi.advanceTimersByTime(0);
  });
}

/** Let a stretch of quiet pass, and let whatever it fires settle. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * The decks page's folder tree: one `app_meta` row holding a width and a fold, read once per app
 * run and written optimistically — the width on a trailing debounce, the fold at once.
 *
 * Two things shape every test here. The row is **one struct carrying two facts**, so every write
 * says both and a write scheduled by one gesture can arrive carrying the other gesture's stale
 * half; and the width arrives from a **stream** while the fold arrives from a **press**, which is
 * why only one of them is debounced.
 */
describe("useFolderPane", () => {
  describe("reading the stored answer", () => {
    it("opens at the width and the fold the last run stored", async () => {
      deckFolderPane.mockResolvedValue({ width: 288, collapsed: true });

      const { result } = mount();

      await waitFor(() => expect(result.current.width).toBe(288));
      expect(result.current.collapsed).toBe(true);
    });

    /**
     * The stored `null` is *read*, not merely indistinguishable from the fallback.
     *
     * Every failure below also answers the default, so a hook that never called the command at
     * all would pass this for the wrong reason. Waiting for the query to reach `success` is what
     * tells the two apart — asserting on the width alone would be green before the round trip
     * had even started.
     */
    it("opens at the default width on a database nobody has dragged", async () => {
      deckFolderPane.mockResolvedValue({ width: null, collapsed: false });

      const { result } = mount();

      await waitFor(() => expect(client.getQueryState(FOLDER_PANE_KEY)?.status).toBe("success"));
      expect(deckFolderPane).toHaveBeenCalled();
      expect(result.current.width).toBe(DEFAULT_FOLDER_TREE_WIDTH_PX);
      expect(result.current.collapsed).toBe(false);
    });

    /**
     * **A read that fails is the defaults, and nothing about it reaches the page.**
     *
     * `deck_folder_pane` is infallible at the far end, so what is left to fail is the IPC
     * boundary and a `BUSY` under a sync — a state the app spends whole minutes in on a first
     * run. Neither is worth a decks page that will not draw. The query is driven all the way
     * into `error` rather than merely observed for a beat, so this cannot pass on a read that had
     * not answered yet.
     */
    it("draws the tree at its default when the preference cannot be read at all", async () => {
      deckFolderPane.mockRejectedValue("The database is busy with a sync — try again in a moment.");

      const { result } = mount();

      await waitFor(() => expect(client.getQueryState(FOLDER_PANE_KEY)?.status).toBe("error"));
      expect(result.current.width).toBe(DEFAULT_FOLDER_TREE_WIDTH_PX);
      expect(result.current.collapsed).toBe(false);
    });

    /**
     * A row holding something that could never be a width draws the default rather than a tree of
     * no width.
     *
     * The mirror types this `number | null`, which is a promise about the far end rather than a
     * fact about the row: a hand-edit, or a build that stored something else, reaches this side
     * as whatever it is. Every one of these is silent — `width: 0` is a sidebar that has
     * vanished, with a green build behind it.
     */
    it.each([0, -40, Number.NaN, Number.POSITIVE_INFINITY])(
      "reads a stored width of %s as no width at all",
      async (junk) => {
        deckFolderPane.mockResolvedValue({ width: junk, collapsed: false });

        const { result } = mount();

        await waitFor(() => expect(client.getQueryState(FOLDER_PANE_KEY)?.status).toBe("success"));
        expect(result.current.width).toBe(DEFAULT_FOLDER_TREE_WIDTH_PX);
      },
    );

    /** The same promise on the other field, and the same reason it is checked rather than trusted. */
    it("reads a fold that is not a boolean as an open tree", async () => {
      deckFolderPane.mockResolvedValue({ width: 300, collapsed: "yes" });

      const { result } = mount();

      await waitFor(() => expect(result.current.width).toBe(300));
      expect(result.current.collapsed).toBe(false);
    });
  });

  describe("dragging the divider", () => {
    /**
     * The tree follows the pointer, not the round trip.
     *
     * A drag is direct manipulation, so the cache is written before the command is sent. The
     * write here never settles, which is what makes the claim a real one: a tree that waited on
     * it would still be at its old width at the end of this test.
     */
    it("moves before the write has answered", async () => {
      setDeckFolderPane.mockReturnValue(new Promise(() => {}));
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setWidth(340));

      // Before the command has even been *sent*, let alone answered.
      expect(result.current.width).toBe(340);
      expect(setDeckFolderPane).not.toHaveBeenCalled();

      // And it stays there once it has been sent and never answers, which is the state a first
      // run's sync puts every one of these writes in.
      await wait(FOLDER_WIDTH_WRITE_DELAY_MS);
      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(340, false);
      expect(result.current.width).toBe(340);
    });

    /**
     * **The whole reason the width write is debounced.** A drag emits a `pointermove` per frame,
     * and writing per event would put a run of `set_deck_folder_pane` calls onto the write
     * connection for values that were obsolete before they committed.
     */
    it("writes once when a drag stops, not once per pointer move", async () => {
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result } = mount();

      for (const width of [212, 240, 268, 301, 340]) {
        await settle(() => result.current.setWidth(width));
        await wait(16); // one frame, far inside the delay
      }
      expect(setDeckFolderPane).not.toHaveBeenCalled();

      await wait(FOLDER_WIDTH_WRITE_DELAY_MS);

      expect(setDeckFolderPane).toHaveBeenCalledTimes(1);
      // The width the drag *settled* on, not the one it started at — each move restarts the
      // timer, so only the last one survives to write anything.
      expect(setDeckFolderPane).toHaveBeenCalledWith(340, false);
    });

    /**
     * A width write says what the fold is, because there is one command and it carries both. A
     * hook that sent a remembered `false` here would unfold the tree at the next launch — the
     * race below, arriving a session late instead of 400ms late.
     */
    it("carries the fold that is current, not the one the row was read with", async () => {
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setCollapsed(true));
      setDeckFolderPane.mockClear();

      await settle(() => result.current.setWidth(360));
      await wait(FOLDER_WIDTH_WRITE_DELAY_MS);

      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(360, true);
    });

    /**
     * A pending timer would fire into a page that is going away, and in a test it would fire into
     * the next one — which is how a debounce becomes a cross-test leak. What it drops is the tail
     * the delay's own doc names.
     */
    it("drops a width write the page unmounted inside", async () => {
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result, unmount } = mount();

      await settle(() => result.current.setWidth(360));
      unmount();
      await wait(FOLDER_WIDTH_WRITE_DELAY_MS * 2);

      expect(setDeckFolderPane).not.toHaveBeenCalled();
    });
  });

  describe("folding the tree", () => {
    /**
     * **Not debounced**, which is the whole of the asymmetry: a drag is a stream and a fold is one
     * deliberate press. A press whose memory waits 400ms is a press lost to a reader who closes
     * the window on it.
     */
    it("writes a fold at once rather than waiting out the drag's delay", async () => {
      holdTheClock();
      seed({ width: 288, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setCollapsed(true));

      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(288, true);
      expect(result.current.collapsed).toBe(true);
    });

    /**
     * The one place the hook supplies a number the reader never chose: the command's `width` is a
     * `number` where the row's is nullable, so a fold on a tree nobody has dragged has to say
     * something. It says the default — see `ipc.setDeckFolderPane`, which names what that costs.
     *
     * The **cache** keeps the `null`, deliberately: it is still the truth about what the reader
     * has done, and both spellings draw the same tree.
     */
    it("sends the default width for a fold on a tree nobody has dragged", async () => {
      holdTheClock();
      seed({ width: null, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setCollapsed(true));

      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(DEFAULT_FOLDER_TREE_WIDTH_PX, true);
      expect(client.getQueryData(FOLDER_PANE_KEY)).toEqual({ width: null, collapsed: true });
      expect(result.current.width).toBe(DEFAULT_FOLDER_TREE_WIDTH_PX);
    });

    /**
     * **The one race this shape has.**
     *
     * Both facts go through one command, so a width write scheduled 300ms ago carries the fold as
     * it was *then*. A reader who drags the divider and immediately presses the fold would have
     * their press overwritten 100ms later by a write that predates it — the tree unfolding on its
     * own at the next launch, with nothing on screen having explained why.
     *
     * The press cancels the pending write rather than racing it, and cancelling costs nothing
     * because the press's own write is a **superset**: the cache already holds the width the drag
     * settled on, so one row reaches the database saying both gestures.
     */
    it("drops a pending width write that a fold press would have undone", async () => {
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setWidth(320));
      await wait(FOLDER_WIDTH_WRITE_DELAY_MS - 100); // still inside the tail
      expect(setDeckFolderPane).not.toHaveBeenCalled();

      await settle(() => result.current.setCollapsed(true));

      // One write, carrying both gestures — the drag is remembered *by* the press.
      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(320, true);

      // And the write the drag scheduled never lands. A second call here would carry
      // `collapsed: false` and put back the tree the reader had just folded.
      await wait(FOLDER_WIDTH_WRITE_DELAY_MS * 2);
      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(320, true);
      expect(result.current.collapsed).toBe(true);
      expect(result.current.width).toBe(320);
    });

    /**
     * The drag that follows a press starts a fresh timer rather than reviving the cancelled one,
     * which is the other half of the sentence above: cancelling must not cost the reader the
     * *next* drag.
     */
    it("still debounces a drag that comes after a fold press", async () => {
      holdTheClock();
      seed({ width: 208, collapsed: false });
      const { result } = mount();

      await settle(() => result.current.setCollapsed(false));
      setDeckFolderPane.mockClear();

      await settle(() => result.current.setWidth(400));
      expect(setDeckFolderPane).not.toHaveBeenCalled();

      await wait(FOLDER_WIDTH_WRITE_DELAY_MS);
      expect(setDeckFolderPane).toHaveBeenCalledExactlyOnceWith(400, false);
    });
  });

  /**
   * **A refused write keeps the reader's choice**, and says nothing.
   *
   * `set_deck_folder_pane` answers `BUSY` while a sync holds the write connection. Putting the
   * tree back where it was under the reader's hand in that window, with nothing on screen saying
   * why, is worse than losing one launch's memory of the drag.
   *
   * The mutation is driven into `error` before the assertion, so this is a settled rejection
   * rather than one still in flight — and a rejection that escaped the mutation would be an
   * unhandled rejection in this run rather than a silent pass.
   */
  it("keeps a fold a refused write never stored, and raises nothing", async () => {
    setDeckFolderPane.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    deckFolderPane.mockResolvedValue({ width: 288, collapsed: false });
    const { result } = mount();
    await waitFor(() => expect(result.current.width).toBe(288));

    act(() => result.current.setCollapsed(true));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBe(288);
  });
});
