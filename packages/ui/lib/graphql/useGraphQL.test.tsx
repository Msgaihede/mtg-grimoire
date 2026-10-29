import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ipc, type GraphResponse } from "@/lib/ipc";
import { MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { useGraphQL } from "./useGraphQL";

afterEach(() => {
  vi.restoreAllMocks();
});

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

/** The desktop's answer, as `graphql_query` sends it: the data and the roots it read. */
function answering(answer: GraphResponse) {
  return vi.spyOn(ipc, "graphqlQuery").mockResolvedValue(answer);
}

describe("useGraphQL", () => {
  it("answers the document, and re-asks it when a root its answer names is invalidated", async () => {
    installWorld({ seed: "starter" });
    const call = answering({ data: { decks: [] }, extensions: { invalidatedBy: ["decks"] } });
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useGraphQL("{ decks { id } }"), { wrapper });

    await waitFor(() => expect(result.current.data?.data).toEqual({ decks: [] }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("{ decks { id } }", null, null, "tcgplayer");

    // A root the answer does not name moves nothing.
    await client.invalidateQueries({ queryKey: ["collection"] });
    expect(call).toHaveBeenCalledTimes(1);

    // The one it does — the way a deck write would say it — re-asks the document, though no
    // query of the decks' own is cached: the bridge's marker is what it matches.
    await client.invalidateQueries({ queryKey: ["decks"] });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });

  it("re-asks a document when the marketplace is switched, which invalidates nothing", async () => {
    installWorld({ seed: "starter" });
    const call = answering({ data: { deckValues: [] }, extensions: { invalidatedBy: ["decks"] } });
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useGraphQL("{ deckValues { value } }"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // What `useMarketplace().select` does on success.
    client.setQueryData(MARKETPLACE_KEY, "cardmarket");
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(expect.any(String), null, null, "cardmarket"),
    );
  });

  it("makes a document that answered nothing the query's error", async () => {
    installWorld({ seed: "starter" });
    answering({ data: null, errors: [{ message: 'Unknown field "nmae" on type "Deck".' }] });
    const { wrapper } = harness();
    const { result } = renderHook(() => useGraphQL("{ decks { nmae } }"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/nmae/);
  });

  it("keeps an answer in part as data, with its errors beside it", async () => {
    installWorld({ seed: "starter" });
    answering({
      data: { decks: [], collectionSummary: null },
      errors: [{ message: "The collection could not be read.", path: ["collectionSummary"] }],
      extensions: { invalidatedBy: ["collection", "decks"] },
    });
    const { wrapper } = harness();
    const { result } = renderHook(
      () => useGraphQL("{ decks { id } collectionSummary { value } }"),
      {
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.errors?.[0].path).toEqual(["collectionSummary"]);
  });
});
