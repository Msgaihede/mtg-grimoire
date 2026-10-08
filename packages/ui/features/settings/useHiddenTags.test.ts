import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { MutedTag } from "@/lib/ipc";

const tagsMuted = vi.hoisted(() => vi.fn());
const tagUnmute = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { tagsMuted, tagUnmute },
}));

import { useHiddenTags, HIDDEN_TAGS_KEY } from "./useHiddenTags";

const CLOUD: MutedTag = {
  namespace: "art",
  tagId: "6921d06c-0a94-4c63-970e-c41a2cf13c3c",
  slug: "cloud",
  mutedAt: 1_787_252_107,
};

let client: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** The roots one press marked stale, flattened to their heads for a readable assertion. */
const invalidatedRoots = () =>
  invalidate.mock.calls.map(([filters]) => (filters?.queryKey as string[])[0]);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(Promise.resolve());
  tagsMuted.mockReset().mockResolvedValue([CLOUD]);
  tagUnmute.mockReset().mockResolvedValue(undefined);
});

describe("useHiddenTags", () => {
  it("reads the hidden tags and hands them over once they land", async () => {
    const { result } = renderHook(() => useHiddenTags(), { wrapper });

    expect(result.current.tags).toBeNull();
    await waitFor(() => expect(result.current.tags).toEqual([CLOUD]));
  });

  /** Keyed on `(namespace, tagId)`, which is what `muted_tags` is keyed on — the two taxonomies
   *  are separate id spaces, so a slug alone would give back whichever one the table found. */
  it("unmutes by namespace and id, never by slug", async () => {
    const { result } = renderHook(() => useHiddenTags(), { wrapper });
    await waitFor(() => expect(result.current.tags).toEqual([CLOUD]));

    act(() => result.current.show(CLOUD));

    await waitFor(() => expect(tagUnmute).toHaveBeenCalledWith("art", CLOUD.tagId));
  });

  /**
   * **The assertion this file exists for.** Giving a tag back makes three cached reads wrong and
   * only one of them is this panel's: the rail draws `tag-children` and the type-ahead draws
   * `tag-search`, and a muted tag is absent from both. Invalidating only the list a reader is
   * looking at leaves them pressing Show again and then finding nothing on the Tags page until
   * the app's 30 s `staleTime` runs out.
   */
  it("marks the rail and the type-ahead stale as well as its own list", async () => {
    const { result } = renderHook(() => useHiddenTags(), { wrapper });
    await waitFor(() => expect(result.current.tags).toEqual([CLOUD]));
    invalidate.mockClear();

    act(() => result.current.show(CLOUD));

    await waitFor(() =>
      expect(invalidatedRoots().sort()).toEqual(["tag-children", "tag-search", "tags-muted"]),
    );
  });

  /** Nothing goes stale on a refusal: the tag is still hidden, so every list is still right. */
  it("invalidates nothing when the write is refused", async () => {
    tagUnmute.mockRejectedValue(new Error("the database is locked"));
    const { result } = renderHook(() => useHiddenTags(), { wrapper });
    await waitFor(() => expect(result.current.tags).toEqual([CLOUD]));
    invalidate.mockClear();

    act(() => result.current.show(CLOUD));

    await waitFor(() => expect(result.current.error).toBe("the database is locked"));
    expect(invalidatedRoots()).toEqual([]);
    expect(result.current.tags).toEqual([CLOUD]);
  });

  /**
   * A failed **read** has to say so too. Without this the panel prints its explanatory sentence
   * over an empty space for good — indistinguishable from "you have not hidden any tags", which
   * is the one claim it must not make about a table nothing successfully read.
   */
  it("reports a failed read rather than looking like an empty list", async () => {
    tagsMuted.mockRejectedValue(new Error("the database is locked"));
    const { result } = renderHook(() => useHiddenTags(), { wrapper });

    await waitFor(() => expect(result.current.error).toBe("the database is locked"));
    expect(result.current.tags).toBeNull();
  });

  /** The key is exported because `TagsPage`'s hide has to name it — a write on another page that
   *  did not would leave this list one tag short for the length of the `staleTime`. */
  it("exports the key its other writer invalidates", () => {
    expect(HIDDEN_TAGS_KEY).toEqual(["tags-muted"]);
  });
});
