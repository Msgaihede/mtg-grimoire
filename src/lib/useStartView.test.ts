import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const startView = vi.hoisted(() => vi.fn());
const setStartView = vi.hoisted(() => vi.fn());
// The original is spread back in rather than replaced wholesale: `ipc` is a hand-written mirror
// and a bare `vi.fn()` object erases every field this module does not name, so a command added
// later fails at run time instead of at `tsc`. `useNavCollapsed.test.ts`' shape. The fixtures here
// are bare words, so there is no struct for a `mockResolvedValue` to get wrong.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { startView, setStartView },
}));

import { useAppStore } from "./store";
import {
  isStartView,
  START_VIEW_KEY,
  useStartView,
  useStartViewHydration,
  type StartView,
} from "./useStartView";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * StrictMode's double mount is what "mounted once" has to survive — `main.tsx` wraps the whole app
 * in it, so in a dev build every mount effect in this app runs twice.
 *
 * ⚠️ **Reaching it takes `renderHook`'s `reactStrictMode` option and _not_ a `StrictMode` element
 * in the `wrapper`**, which is the opposite of what the wrapper's shape suggests. Measured in this
 * tree on 2026-09-10: one effect, counted both ways in one test, ran **once** under a wrapper that
 * rendered `<StrictMode>` around the children and **twice** under the option. A wrapper reads like
 * the obvious mechanism and is silently inert — a guard tested that way is a test that passes
 * whether or not the guard is there.
 */
const STRICT = { wrapper, reactStrictMode: true } as const;

/**
 * The store, plus the action Task 24 of the home-page plan adds to it.
 *
 * ⚠️ **The seam this suite drives, and it is the one `useStartView.ts` documents.**
 * `hydrateStartView` is genuinely absent from `store.ts` today — it lands beside `hydrateCardZoom`
 * in a later task — so the hook names it as optional and calls it with `?.`, and this suite
 * installs a spy in its place. On the day the action lands, {@link installHydrator} overwrites the
 * real one for the duration of a test and {@link afterEach} puts it back; nothing here needs to
 * change then.
 */
type StoreSeam = ReturnType<typeof useAppStore.getState> & {
  hydrateStartView?: (view: StartView) => void;
};

function installHydrator(hydrate: (view: StartView) => void): void {
  useAppStore.setState({ hydrateStartView: hydrate } as Partial<StoreSeam>);
}

let original: ((view: StartView) => void) | undefined;
let hydrate: Mock<(view: StartView) => void>;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who set the app to open on Search, which is the case that proves the row is read at
  // all rather than the fallback being right by accident — `"home"` is what every failure below
  // also answers with.
  startView.mockReset().mockResolvedValue("search");
  setStartView.mockReset().mockResolvedValue(undefined);
  original = (useAppStore.getState() as StoreSeam).hydrateStartView;
  hydrate = vi.fn<(view: StartView) => void>();
  installHydrator(hydrate);
});

afterEach(() => {
  // Put the store back, so this suite cannot leak an action into the next file in the run.
  useAppStore.setState({ hydrateStartView: original } as Partial<StoreSeam>);
});

/**
 * Which view the app opens on: one `app_meta` row holding a bare word, read once per app run and
 * written optimistically.
 *
 * **The vocabulary check is this side's and there is deliberately none in Rust.**
 * `startview.rs` hands back a word it has never heard of rather than refusing it, because which
 * pages exist is a fact about this app's router — an allow-list there would make every new view a
 * Rust change, and would strand a reader who ran a downgrade by refusing the newer build's word at
 * the door. So the word survives the round trip as itself and degrades here.
 */
describe("useStartView", () => {
  it("reads the view the last run stored", async () => {
    const { result } = renderHook(() => useStartView(), { wrapper });

    await waitFor(() => expect(result.current.view).toBe("search"));
  });

  /**
   * **A word this build does not draw is Home, not a strand.**
   *
   * This is the downgrade: a reader on a newer build sets the app to open on a view that build
   * added, then runs an older copy of the portable exe. The word comes back intact — Rust never
   * looked at it — and the older build has no page to draw for it.
   */
  it("reads a word this build does not draw as Home", async () => {
    startView.mockResolvedValue("nonesuch");

    const { result } = renderHook(() => useStartView(), { wrapper });

    await waitFor(() => expect(startView).toHaveBeenCalled());
    expect(result.current.view).toBe("home");
  });

  /**
   * **A read that fails is Home**, never an error.
   *
   * What is left to fail is the IPC boundary and a `BUSY` under a sync — a state the app spends
   * whole minutes in on a first run. Neither is worth a Settings panel that will not draw. The
   * query is driven all the way into `error` rather than merely observed for a beat, so this
   * cannot pass on a read that had not answered yet.
   */
  it("reads a row that cannot be read at all as Home", async () => {
    startView.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    const { result } = renderHook(() => useStartView(), { wrapper });

    await waitFor(() => expect(client.getQueryState(START_VIEW_KEY)?.status).toBe("error"));
    expect(result.current.view).toBe("home");
  });

  /**
   * The row shows the new choice on the press, not a round trip later.
   *
   * The write here never settles, which is what makes the claim a real one: a picker that waited
   * on it would still read `search` at the end of this test.
   */
  it("moves before the write has answered", async () => {
    setStartView.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useStartView(), { wrapper });
    await waitFor(() => expect(result.current.view).toBe("search"));

    act(() => result.current.setView("decks"));

    await waitFor(() => expect(result.current.view).toBe("decks"));
    expect(setStartView).toHaveBeenCalledWith("decks");
  });

  /**
   * **A refused write keeps the reader's choice**, and says nothing — `useNavCollapsed`'s trade
   * for its reason. `set_start_view` answers `BUSY` while a sync holds the write connection, and
   * putting the picker back under the reader's hand with nothing on screen saying why is worse
   * than losing one launch's memory of the choice.
   */
  it("keeps a choice a refused write never stored, and raises nothing", async () => {
    setStartView.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useStartView(), { wrapper });
    await waitFor(() => expect(result.current.view).toBe("search"));

    act(() => result.current.setView("decks"));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.view).toBe("decks");
  });

  /**
   * **The key is exported so a story seeds the cache instead of mocking IPC**, and the seeded word
   * is narrowed exactly as a stored one is — a seed is not a way past the check.
   */
  it("narrows a word seeded through the exported key, with no round trip", async () => {
    client.setQueryData(START_VIEW_KEY, "nonesuch");

    const { result } = renderHook(() => useStartView(), { wrapper });

    expect(result.current.view).toBe("home");
    await waitFor(() => expect(startView).not.toHaveBeenCalled());
  });

  /** The prototype trap `isWidgetKind` names, one vocabulary over: `in` would answer `true` for
   *  every method on `Object.prototype`, and a stored `"toString"` is a word a hand-edit can leave. */
  it("does not mistake a method on Object.prototype for a view", () => {
    expect(isStartView("settings")).toBe(true);
    expect(isStartView("toString")).toBe(false);
    expect(isStartView("constructor")).toBe(false);
  });
});

/**
 * The launch read — mounted once by `AppShell`, and the only thing in the app that turns a stored
 * word into where the reader actually is.
 */
describe("useStartViewHydration", () => {
  it("lands the app on the view the last run stored", async () => {
    renderHook(() => useStartViewHydration(), { wrapper });

    await waitFor(() => expect(hydrate).toHaveBeenCalledWith("search"));
  });

  /**
   * **The word is narrowed before it crosses into the store**, never after.
   *
   * `activeView` is a `ViewId` and what Rust stored is a `string`; this hook is the one door
   * between them. Handing the store an unchecked word would put the app on a view no arm of
   * `App.tsx` draws, which is a blank window rather than a wrong page.
   */
  it("hands the store Home rather than a word this build does not draw", async () => {
    startView.mockResolvedValue("nonesuch");

    renderHook(() => useStartViewHydration(), { wrapper });

    await waitFor(() => expect(hydrate).toHaveBeenCalledWith("home"));
  });

  /**
   * **Once, even under StrictMode's double mount.**
   *
   * A second seed is not harmless: the store drops a seed that lands after the reader's first
   * press, so two copies of this read would disagree about whether the session had been seeded at
   * all — `useCardZoomPersistence`'s rule, arrived at from the same place. `fetchQuery` dedupes
   * the round trip on its own, which is exactly why the guard has to be over the *hydration*: two
   * effects awaiting one shared promise both resolve.
   */
  it("does not hydrate twice under StrictMode's double mount", async () => {
    const { rerender } = renderHook(() => useStartViewHydration(), STRICT);

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startView).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  /**
   * A read that fails hydrates nothing and raises nothing — the app opens where it already was.
   *
   * Outside a Tauri window there is no command to call at all, which is the case a plain
   * `vite dev` and a story with no fake registered are both in.
   */
  it("says nothing when the row cannot be read", async () => {
    startView.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    renderHook(() => useStartViewHydration(), { wrapper });

    await waitFor(() => expect(client.getQueryState(START_VIEW_KEY)?.status).toBe("error"));
    expect(hydrate).not.toHaveBeenCalled();
  });

  /**
   * **One round trip serves both readers**, which is the whole reason the query is spelled once.
   *
   * The launch read fills the entry the Settings row reads back from, so a panel opened later
   * costs nothing — and a second cache entry under a differently-spelled key would show up here as
   * a second call.
   */
  it("fills the entry the Settings row reads, at the cost of one call", async () => {
    const { result } = renderHook(() => {
      useStartViewHydration();
      return useStartView();
    }, { wrapper });

    await waitFor(() => expect(result.current.view).toBe("search"));
    expect(startView).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
