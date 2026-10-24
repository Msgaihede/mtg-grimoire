import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerTrayRow } from "@/lib/ipc";

/** The popup's price read, its marketplace and the sound ladder — `useLandedPrice.test`'s seam. */
const printingPrices = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const scanSounds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { printingPrices, getMarketplace, marketplaceFeedStatus, scanSounds },
}));

import { DEFAULT_SCAN_SOUNDS } from "../sounds/scanSounds";
import { landedFrom } from "./AddedToast";
import { useLandedTier } from "./useLandedTier";

const row: ScannerTrayRow = {
  key: "row-1",
  cardId: "ltr-426",
  oracleId: "oliphaunt",
  name: "Oliphaunt",
  setCode: "ltr",
  collectorNumber: "426",
  finish: "nonfoil",
  quantity: 1,
  choices: [],
  addedAt: 1_000,
};

const waiting: ScannerTrayRow = {
  ...row,
  key: "row-2",
  cardId: "mt-1",
  choices: [
    {
      cardId: "mt-1",
      oracleId: "minas",
      name: "Minas Tirith",
      setCode: "ltr",
      collectorNumber: "256",
    },
    {
      cardId: "mt-2",
      oracleId: "minas",
      name: "Minas Tirith",
      setCode: "ltc",
      collectorNumber: "380",
    },
  ],
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useLandedTier", () => {
  beforeEach(() => {
    printingPrices.mockReset();
    scanSounds.mockReset();
    scanSounds.mockResolvedValue(DEFAULT_SCAN_SOUNDS);
  });

  it("is the tier a $19.90 landing reaches", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "ltr-426", finishPrices: { nonfoil: 19.9, foil: null, etched: null } },
    ]);
    const { result } = renderHook(() => useLandedTier(landedFrom(row, false, false)), { wrapper });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe("tier2"));
  });

  it("is null below the first floor", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "ltr-426", finishPrices: { nonfoil: 0.5, foil: null, etched: null } },
    ]);
    const { result } = renderHook(() => useLandedTier(landedFrom(row, false, false)), { wrapper });
    await waitFor(() => expect(printingPrices).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeNull();
  });

  it("is null for a pick, however dear its candidates", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "mt-1", finishPrices: { nonfoil: 0.25, foil: null, etched: null } },
      { cardId: "mt-2", finishPrices: { nonfoil: 120, foil: null, etched: null } },
    ]);
    const { result } = renderHook(() => useLandedTier(landedFrom(waiting, false, false)), {
      wrapper,
    });
    await waitFor(() => expect(printingPrices).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeNull();
  });

  it("asks nothing without a landing", () => {
    const { result } = renderHook(() => useLandedTier(null), { wrapper });
    expect(result.current).toBeNull();
    expect(printingPrices).not.toHaveBeenCalled();
  });
});
