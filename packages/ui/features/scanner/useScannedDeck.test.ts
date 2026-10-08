import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDetail, DeckInput, DeckRow, ScannerTrayRow } from "@/lib/ipc";

const calls = vi.hoisted(() => ({
  cardDetail: vi.fn(),
  oracleTagsForPrintings: vi.fn(),
  deckCreate: vi.fn(),
  deckImportCommit: vi.fn(),
  deckDelete: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: calls,
}));

import { useScannedDeck } from "./useScannedDeck";

const INPUT: DeckInput = {
  name: "Scanned deck",
  formatKey: "commander",
  folderId: 8,
  description: "From the table",
  theoryEnabled: true,
};
const DECK = { id: 42, ...INPUT } as DeckRow;
const ROW: ScannerTrayRow = {
  key: "ring",
  cardId: "ring-printing",
  oracleId: "ring-oracle",
  name: "Sol Ring",
  setCode: "cmm",
  collectorNumber: "410",
  finish: "nonfoil",
  quantity: 3,
  choices: [],
  addedAt: 123,
};
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  calls.cardDetail.mockReset().mockImplementation(
    async (id: string) =>
      ({
        id,
        typeLine: id === "forest" ? "Basic Land — Forest" : "Artifact",
      }) as CardDetail,
  );
  calls.oracleTagsForPrintings
    .mockReset()
    .mockResolvedValue([{ cardId: ROW.cardId, slugs: ["ramp"] }]);
  calls.deckCreate.mockReset().mockResolvedValue(DECK);
  calls.deckImportCommit.mockReset().mockResolvedValue({ added: 7 });
  calls.deckDelete.mockReset().mockResolvedValue(undefined);
});

describe("useScannedDeck", () => {
  it("preserves exact printings, counts and distinct finishes, filing by tags and land type", async () => {
    const rows = [
      ROW,
      { ...ROW, key: "foil", finish: "foil" as const, quantity: 2 },
      { ...ROW, key: "etched", finish: "etched" as const, quantity: 1 },
      { ...ROW, key: "land", cardId: "forest", quantity: 1 },
    ];
    const original = structuredClone(rows);
    const { result } = renderHook(() => useScannedDeck(rows), { wrapper });
    await expect(result.current.mutateAsync(INPUT)).resolves.toBe(DECK);
    expect(calls.cardDetail).toHaveBeenCalledTimes(2);
    expect(calls.oracleTagsForPrintings).toHaveBeenCalledExactlyOnceWith([ROW.cardId, "forest"]);
    expect(calls.deckCreate).toHaveBeenCalledExactlyOnceWith(INPUT);
    expect(calls.deckImportCommit).toHaveBeenCalledExactlyOnceWith(42, "live", "merge", [
      { cardId: ROW.cardId, quantity: 3, finish: null, categoryName: "Ramp" },
      { cardId: ROW.cardId, quantity: 2, finish: "foil", categoryName: "Ramp" },
      { cardId: ROW.cardId, quantity: 1, finish: "etched", categoryName: "Ramp" },
      { cardId: "forest", quantity: 1, finish: null, categoryName: "Land" },
    ]);
    expect(rows).toEqual(original);
    expect(calls.deckDelete).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    ["no printing", [{ ...ROW, cardId: "" }]],
    ["unresolved printing", [{ ...ROW, choices: [{ cardId: "other" }] }]],
    ["unknown finish", [{ ...ROW, finish: "unknown" }]],
    ["invalid quantity", [{ ...ROW, quantity: 0 }]],
  ])("refuses %s before creating anything", async (_name, rows) => {
    const { result } = renderHook(() => useScannedDeck(rows as ScannerTrayRow[]), { wrapper });
    await expect(result.current.mutateAsync(INPUT)).rejects.toThrow();
    expect(calls.deckCreate).not.toHaveBeenCalled();
    expect(calls.deckImportCommit).not.toHaveBeenCalled();
  });

  it("refuses a printing missing from the local database", async () => {
    calls.cardDetail.mockResolvedValue(null);
    const { result } = renderHook(() => useScannedDeck([ROW]), { wrapper });
    await expect(result.current.mutateAsync(INPUT)).rejects.toThrow(
      "no longer in the card database",
    );
    expect(calls.deckCreate).not.toHaveBeenCalled();
  });

  it("files by type line when the taxonomy read fails", async () => {
    calls.oracleTagsForPrintings.mockRejectedValue("Database busy");
    const { result } = renderHook(() => useScannedDeck([ROW]), { wrapper });
    await result.current.mutateAsync(INPUT);
    expect(calls.deckImportCommit).toHaveBeenCalledWith(42, "live", "merge", [
      { cardId: ROW.cardId, quantity: 3, finish: null, categoryName: "Artifact" },
    ]);
  });

  it.each([false, true])(
    "rolls back a refused import and preserves its error (cleanup fails: %s)",
    async (cleanupFails) => {
      calls.deckImportCommit.mockRejectedValue("Import refused");
      if (cleanupFails) calls.deckDelete.mockRejectedValue("Delete refused");
      const { result } = renderHook(() => useScannedDeck([ROW]), { wrapper });
      await expect(result.current.mutateAsync(INPUT)).rejects.toBe("Import refused");
      expect(calls.deckDelete).toHaveBeenCalledExactlyOnceWith(42);
    },
  );

  it.each([false, true])(
    "invalidates owned surfaces after settling (refused: %s)",
    async (refused) => {
      const keys = [
        ["decks", "list"],
        ["collection", "list"],
        ["wishlist", "list"],
      ];
      for (const key of keys) client.setQueryData(key, []);
      if (refused) calls.deckImportCommit.mockRejectedValue("Import refused");
      const { result } = renderHook(() => useScannedDeck([ROW]), { wrapper });
      await result.current.mutateAsync(INPUT).catch(() => undefined);
      await waitFor(() => {
        for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      });
    },
  );
});
