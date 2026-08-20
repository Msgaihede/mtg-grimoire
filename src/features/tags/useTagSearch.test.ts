import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TagHit, TagNamespace } from "@/lib/ipc";

const tagSearch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { tagSearch },
}));

import { DEBOUNCE_MS } from "../search/useCardSearch";
import { TAG_SEARCH_LIMIT, useTagSearch } from "./useTagSearch";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

/** The motifs the Storybook fake actually carries, so nothing here reads as a tag that exists
 *  only in a test. `landscape` is the one the weight floor visibly moves. */
function hit(slug: string, namespace: TagNamespace = "art"): TagHit {
  return {
    slug,
    id: `${namespace}-${slug}-id`,
    label: slug[0].toUpperCase() + slug.slice(1),
    namespace,
    description: null,
    cardCount: 3,
    childCount: 1,
    parents: [],
  };
}

/** Past the debounce with room to spare. Real time rather than `vi.useFakeTimers`, which would
 *  also freeze React Query's own scheduling — `useCardSearch.test.ts`'s reason. */
const pastDebounce = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 150));
  });

describe("useTagSearch", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    tagSearch.mockReset().mockResolvedValue([]);
  });

  /**
   * **The one hazard in this hook.** `tag_search` answers *every* tag for an empty needle — by
   * design, so an untouched box could offer the widest-reaching tags — and there are ~16 000 of
   * them. A hook that merely debounced the empty string would ask for all of them on mount, on
   * every remount, and again each time the reader cleared the box. It has to skip the query.
   */
  it("never asks the backend anything for an empty box", async () => {
    const { result } = renderHook(() => useTagSearch("", "both"), { wrapper });
    await pastDebounce();

    expect(tagSearch).not.toHaveBeenCalled();
    expect(result.current.hits).toEqual([]);
    expect(result.current.isPending).toBe(false);
  });

  /** A box holding only spaces is an empty box. */
  it("never asks the backend anything for a blank box", async () => {
    renderHook(() => useTagSearch("   ", "both"), { wrapper });
    await pastDebounce();

    expect(tagSearch).not.toHaveBeenCalled();
  });

  it("asks with the trimmed needle, the namespace and a cap", async () => {
    renderHook(() => useTagSearch("  landscape  ", "art"), { wrapper });

    await waitFor(() => expect(tagSearch).toHaveBeenCalledTimes(1));
    expect(tagSearch).toHaveBeenCalledWith("landscape", "art", TAG_SEARCH_LIMIT);
    await pastDebounce();
    // **Not once with an empty needle** — the settled needle this hook starts from is `""`,
    // and a box that mounts holding a word must not fire that first. It is the same
    // whole-taxonomy request the empty box is fenced against, arriving through the other door.
    expect(tagSearch.mock.calls.map(([needle]) => needle)).toEqual(["landscape"]);
  });

  /** Four keystrokes, one request — the whole point of the debounce, and the difference
   *  between a type-ahead and four round trips per word. */
  it("coalesces a burst of keystrokes into one request", async () => {
    const { rerender } = renderHook(({ text }) => useTagSearch(text, "both"), {
      wrapper,
      initialProps: { text: "l" },
    });
    rerender({ text: "la" });
    rerender({ text: "lan" });
    rerender({ text: "land" });

    await waitFor(() => expect(tagSearch).toHaveBeenCalledTimes(1));
    expect(tagSearch).toHaveBeenCalledWith("land", "both", TAG_SEARCH_LIMIT);

    // And nothing follows it — a second call here would mean an intermediate needle escaped.
    await pastDebounce();
    expect(tagSearch).toHaveBeenCalledTimes(1);
  });

  it("hands back the hits it was answered with", async () => {
    tagSearch.mockResolvedValue([hit("landscape"), hit("forest")]);
    const { result } = renderHook(() => useTagSearch("la", "both"), { wrapper });

    await waitFor(() =>
      expect(result.current.hits.map((h) => h.slug)).toEqual(["landscape", "forest"]),
    );
  });

  /**
   * Clearing the box empties the list **and stops the query**, rather than leaving the last
   * word's hits under an empty box or letting the now-empty needle become a request for the
   * whole taxonomy.
   */
  it("empties and goes quiet when the box is cleared", async () => {
    tagSearch.mockResolvedValue([hit("landscape")]);
    const { result, rerender } = renderHook(({ text }) => useTagSearch(text, "both"), {
      wrapper,
      initialProps: { text: "landscape" },
    });
    await waitFor(() => expect(result.current.hits).toHaveLength(1));
    const asked = tagSearch.mock.calls.length;

    rerender({ text: "" });

    expect(result.current.hits).toEqual([]);
    expect(result.current.isPending).toBe(false);
    await pastDebounce();
    expect(tagSearch.mock.calls.length).toBe(asked);
  });

  /**
   * Clearing the box has to make the query **inactive**, not merely quiet: an invalidation
   * refetches every active query, and muting a tag is exactly such an invalidation. Without the
   * live needle in `enabled` the settled one keeps the old query active for the length of the
   * debounce, so a mute pressed over an empty box re-asks for a word the reader has erased.
   */
  it("goes inactive when the box is cleared, so an invalidation cannot revive it", async () => {
    tagSearch.mockResolvedValue([hit("landscape")]);
    const { result, rerender } = renderHook(({ text }) => useTagSearch(text, "both"), {
      wrapper,
      initialProps: { text: "landscape" },
    });
    await waitFor(() => expect(result.current.hits).toHaveLength(1));
    const asked = tagSearch.mock.calls.length;

    rerender({ text: "" });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["tag-search"] });
    });

    expect(tagSearch.mock.calls.length).toBe(asked);
  });

  /** The taxonomy toggle is part of the question, so flipping it asks again rather than
   *  redrawing the other taxonomy's answer. */
  it("asks again when the namespace changes", async () => {
    const { rerender } = renderHook(
      ({ ns }: { ns: TagNamespace | "both" }) => useTagSearch("forest", ns),
      { wrapper, initialProps: { ns: "both" as TagNamespace | "both" } },
    );
    await waitFor(() => expect(tagSearch).toHaveBeenCalledTimes(1));

    rerender({ ns: "oracle" });

    await waitFor(() => expect(tagSearch).toHaveBeenCalledTimes(2));
    expect(tagSearch).toHaveBeenLastCalledWith("forest", "oracle", TAG_SEARCH_LIMIT);
  });

  /** Pending covers the debounce too, not only the round trip: the reader typed and something
   *  is coming, and a box that looked idle for 300 ms would read as a search that found
   *  nothing. */
  it("reports pending from the keystroke until the answer lands", async () => {
    tagSearch.mockResolvedValue([hit("landscape")]);
    const { result, rerender } = renderHook(({ text }) => useTagSearch(text, "both"), {
      wrapper,
      initialProps: { text: "" },
    });
    expect(result.current.isPending).toBe(false);

    rerender({ text: "landsc" });
    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.hits).toHaveLength(1);
  });
});
