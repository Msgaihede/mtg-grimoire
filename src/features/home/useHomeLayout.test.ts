import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const homeLayout = vi.hoisted(() => vi.fn());
const setHomeLayout = vi.hoisted(() => vi.fn());
// The original is spread back in rather than replaced wholesale: `ipc` is a hand-written mirror
// and a bare `vi.fn()` object erases every field this module does not name, so a command added
// later fails at run time instead of at `tsc`. `useFolderPane.test.ts`' shape — and every fixture
// below goes through a typed factory for the other half of that hole, which is that a
// `mockResolvedValue` accepts a struct missing a required field.
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { homeLayout, setHomeLayout },
}));

import type { HomeLayout, HomeWidget } from "@/lib/ipc";
import { HOME_LAYOUT_KEY, useHomeLayout } from "./useHomeLayout";
import { DEFAULT_LAYOUT } from "./widgets";

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** A widget, annotated so the mirror checks the fixture — see the mock note above. */
function widget(over: Partial<HomeWidget> = {}): HomeWidget {
  return { id: "activity", kind: "activity", span: 1, config: null, ...over };
}

/** A layout, likewise. One widget by default, so a fixture is never mistakable for the seeded six. */
function layout(over: Partial<HomeLayout> = {}): HomeLayout {
  return { version: 1, widgets: [widget()], ...over };
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A reader who has customised the page down to one widget, which is the case that proves the row
  // is read at all rather than the fallback being right by accident — the seeded six are what
  // every failure below also answers with.
  homeLayout.mockReset().mockResolvedValue(layout());
  setHomeLayout.mockReset().mockResolvedValue(undefined);
});

/**
 * The home page's arrangement: one `app_meta` row holding a whole document, read once per app run
 * and written optimistically.
 *
 * **The case this hook exists to get right is the empty page**, and it is why `ready` is in the
 * tuple. A layout holding no widgets is a reader who cleared the page, and a page that has not
 * answered yet also holds no widgets — two entirely different things a beat apart, and the second
 * must never be drawn as the first.
 */
describe("useHomeLayout", () => {
  it("opens on the arrangement the last run stored", async () => {
    const { result } = renderHook(() => useHomeLayout(), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout).toEqual(layout());
  });

  /**
   * **An empty widget list is a layout, not a missing document** — `home.rs` pins the same rule
   * with a Rust test, and `layout.ts` with its own.
   *
   * A reader who removed every widget has made a choice, and handing the six defaults back on the
   * next launch would undo it silently, every time, for ever. `ready` beside it is what lets the
   * page tell this state apart from the read still being in flight.
   */
  it("keeps a page the reader cleared cleared, and calls it ready", async () => {
    homeLayout.mockResolvedValue(layout({ widgets: [] }));

    const { result } = renderHook(() => useHomeLayout(), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout.widgets).toEqual([]);
  });

  /**
   * **A malformed document is the default here as well as in Rust**, so the page never sees a
   * shape it has to guard.
   *
   * `home.rs` already folds a missing or unparseable row into the seed, but the webview can still
   * be handed a document a newer build wrote or a hand-edit left half-formed — a `{ version: 1 }`
   * with no `widgets` at all is the shape a truncated write leaves. `parseLayout` in the `queryFn`
   * is what makes that one answer for every consumer rather than one per widget.
   */
  it("reads a document that is not a layout as the seeded six", async () => {
    homeLayout.mockResolvedValue({ version: 1 });

    const { result } = renderHook(() => useHomeLayout(), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
  });

  /**
   * **A read that fails is the seeded six and it is `ready`** — never an error, and never a page
   * that waits for ever.
   *
   * `home_layout` is infallible at the far end, so what is left to fail is the IPC boundary and a
   * `BUSY` under a sync — a state the app spends whole minutes in on a first run. Neither is worth
   * a landing page that will not draw. `ready` is `true` because the default it fell back to is a
   * complete page: there is nothing further to wait for, and a page that drew a spinner here would
   * draw it until the window closed.
   *
   * The query is driven all the way into `error` rather than merely observed for a beat, so this
   * cannot pass on a read that had not answered yet.
   */
  it("answers the seeded six, ready, when the row cannot be read at all", async () => {
    homeLayout.mockRejectedValue("The database is busy with a sync — try again in a moment.");

    const { result } = renderHook(() => useHomeLayout(), { wrapper });

    await waitFor(() => expect(client.getQueryState(HOME_LAYOUT_KEY)?.status).toBe("error"));
    expect(result.current.ready).toBe(true);
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
  });

  /**
   * The read in flight is `ready: false` — and the document it hands out meanwhile keeps its
   * identity across renders.
   *
   * The identity half is not ceremony: a read that failed never answers again, so a fresh copy per
   * render would give the page a new `layout` object for ever, and any consumer with an effect or
   * a memo keyed on the document would re-run for ever with it.
   */
  it("is not ready while the read is in flight, and does not churn the document", () => {
    homeLayout.mockReturnValue(new Promise(() => {}));

    const { result, rerender } = renderHook(() => useHomeLayout(), { wrapper });

    expect(result.current.ready).toBe(false);
    expect(result.current.layout).toEqual(DEFAULT_LAYOUT);
    const first = result.current.layout;
    rerender();
    expect(result.current.layout).toBe(first);
  });

  /**
   * The page rearranges on the drop, not a round trip later.
   *
   * This page is direct manipulation end to end, and a card that answers late reads as a card that
   * did not move — so the cache is written before the command is sent. The write here never
   * settles, which is what makes the claim a real one: a page that waited on it would still be
   * showing the stored arrangement at the end of this test.
   */
  it("rearranges before the write has answered", async () => {
    setHomeLayout.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useHomeLayout(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const next = layout({ widgets: [widget({ id: "decks", kind: "decks" })] });

    act(() => result.current.update(next));

    await waitFor(() => expect(result.current.layout).toEqual(next));
    expect(setHomeLayout).toHaveBeenCalledTimes(1);
    expect(setHomeLayout).toHaveBeenCalledWith(next);
  });

  /**
   * **A refused write keeps the reader's page**, and says nothing.
   *
   * `set_home_layout` answers `BUSY` while a sync holds the write connection, and it refuses a
   * document whose version it does not write. Snapping the widgets back under the reader's hand in
   * either window, with nothing on screen saying why, is worse than losing one launch's memory of
   * the arrangement.
   *
   * The mutation is driven into `error` before the assertion, so this is a settled rejection
   * rather than one still in flight — and a rejection that escaped the mutation would be an
   * unhandled rejection in this run rather than a silent pass.
   */
  it("keeps an arrangement a refused write never stored, and raises nothing", async () => {
    setHomeLayout.mockRejectedValue("The database is busy with a sync — try again in a moment.");
    const { result } = renderHook(() => useHomeLayout(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const next = layout({ widgets: [] });

    act(() => result.current.update(next));

    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe("error"));
    expect(result.current.layout).toEqual(next);
  });

  /** Reset puts the seeded six back, and it goes out on the same optimistic terms every other
   *  change to this page does. */
  it("resets to the seeded six, through the same optimistic write", async () => {
    const { result } = renderHook(() => useHomeLayout(), { wrapper });
    await waitFor(() => expect(result.current.layout.widgets).toHaveLength(1));

    act(() => result.current.reset());

    await waitFor(() => expect(result.current.layout).toEqual(DEFAULT_LAYOUT));
    expect(setHomeLayout).toHaveBeenCalledTimes(1);
    expect(setHomeLayout).toHaveBeenCalledWith(DEFAULT_LAYOUT);
  });

  /**
   * **Reset hands out a copy, never the module's own seed.**
   *
   * `DEFAULT_LAYOUT` is what a first launch falls back to and what `widgets.test.ts` pins against
   * a literal. One careless splice into the object this hook handed the page would rewrite both
   * for the rest of the process, and nothing would go red anywhere.
   */
  it("resets to a copy of the seed rather than to the seed itself", async () => {
    const { result } = renderHook(() => useHomeLayout(), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.reset());

    await waitFor(() => expect(result.current.layout).toEqual(DEFAULT_LAYOUT));
    expect(result.current.layout).not.toBe(DEFAULT_LAYOUT);
    expect(result.current.layout.widgets[0]).not.toBe(DEFAULT_LAYOUT.widgets[0]);
    expect(setHomeLayout.mock.calls[0]?.[0]).not.toBe(DEFAULT_LAYOUT);
  });

  /**
   * **The key is exported so a story seeds the cache instead of mocking IPC**, which is the house
   * pattern and what Wave 6's stories are built on.
   *
   * A seeded entry is fresh under `staleTime: Infinity`, so the command is never called at all —
   * that is the half worth asserting, because a hook that fetched anyway would race the seed and
   * the story would flicker onto whatever the fake answered.
   */
  it("opens on an arrangement seeded through the exported key, with no round trip", async () => {
    const seeded = layout({ widgets: [widget({ id: "folders", kind: "folders", span: 2 })] });
    client.setQueryData(HOME_LAYOUT_KEY, seeded);

    const { result } = renderHook(() => useHomeLayout(), { wrapper });

    expect(result.current.ready).toBe(true);
    expect(result.current.layout).toEqual(seeded);
    await waitFor(() => expect(homeLayout).not.toHaveBeenCalled());
  });
});
