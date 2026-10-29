import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { installWorld } from "@grimoire/fake/world";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ipc } from "@/lib/ipc";
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

describe("useGraphQL", () => {
  it("answers the document, and re-asks it when a root its fields read is invalidated", async () => {
    installWorld({ seed: "starter" });
    const tray = vi.spyOn(ipc, "scannerTray");
    const { client, wrapper } = harness();
    const { result } = renderHook(() => useGraphQL("{ scannerTray { key } }"), { wrapper });

    await waitFor(() => expect(result.current.data?.data).toEqual({ scannerTray: [] }));
    expect(tray).toHaveBeenCalledTimes(1);

    // A root the document does not read moves nothing.
    await client.invalidateQueries({ queryKey: ["decks"] });
    expect(tray).toHaveBeenCalledTimes(1);

    // The one it does — the way the scanner's own write would say it — re-asks the document,
    // though no query of the scanner's own is cached: the bridge's marker is what it matches.
    await client.invalidateQueries({ queryKey: ["scanner"] });
    await waitFor(() => expect(tray).toHaveBeenCalledTimes(2));
  });

  it("re-asks a priced document when the marketplace is switched, which invalidates nothing", async () => {
    installWorld({ seed: "starter" });
    const { client, wrapper } = harness();
    const { result } = renderHook(
      () => useGraphQL<{ marketplace: { id: string } }>("{ marketplace { id } }"),
      {
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.data?.data?.marketplace.id).toBe("tcgplayer"));

    // What `useMarketplace().select` does on success.
    client.setQueryData(MARKETPLACE_KEY, "cardmarket");
    await waitFor(() => expect(result.current.data?.data?.marketplace.id).toBe("cardmarket"));
  });

  it("makes a document that answered nothing the query's error", async () => {
    installWorld({ seed: "starter" });
    const { wrapper } = harness();
    const { result } = renderHook(() => useGraphQL("{ noSuchField }"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/noSuchField/);
  });
});
