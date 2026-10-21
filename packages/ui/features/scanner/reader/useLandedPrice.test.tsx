import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerTrayRow } from "@/lib/ipc";

/** The popup's price read and the marketplace setting it is keyed on — `TrayPanel.test`'s seam. */
const printingPrices = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { printingPrices, getMarketplace, marketplaceFeedStatus },
}));

import { landedFrom } from "./AddedToast";
import { useLandedPrice } from "./useLandedPrice";

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

describe("useLandedPrice", () => {
  beforeEach(() => {
    printingPrices.mockReset();
  });

  it("quotes the filed card at the reader's marketplace", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "ltr-426", finishPrices: { nonfoil: 1.5, foil: 4, etched: null } },
    ]);
    const { result } = renderHook(() => useLandedPrice(landedFrom(row, false, false)), { wrapper });
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe("$1.50"));
    expect(printingPrices).toHaveBeenCalledWith(["ltr-426"], "tcgplayer");
  });

  it("spans a pick's candidates", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "mt-1", finishPrices: { nonfoil: 0.25, foil: null, etched: null } },
      { cardId: "mt-2", finishPrices: { nonfoil: 12, foil: null, etched: null } },
    ]);
    const { result } = renderHook(() => useLandedPrice(landedFrom(waiting, false, false)), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBe("$0.25 – $12.00"));
    expect(printingPrices).toHaveBeenCalledWith(["mt-1", "mt-2"], "tcgplayer");
  });

  it("says unpriced with a dash once the marketplace answers nothing", async () => {
    printingPrices.mockResolvedValue([]);
    const { result } = renderHook(() => useLandedPrice(landedFrom(row, false, false)), { wrapper });
    await waitFor(() => expect(result.current).toBe("—"));
  });

  it("prices at the tray's marketplace when it names one", async () => {
    printingPrices.mockResolvedValue([
      { cardId: "ltr-426", finishPrices: { nonfoil: 2, foil: null, etched: null } },
    ]);
    const { result } = renderHook(
      () => useLandedPrice(landedFrom(row, false, false), "cardmarket"),
      { wrapper },
    );
    await waitFor(() => expect(result.current).toBe("€2.00"));
    expect(printingPrices).toHaveBeenCalledWith(["ltr-426"], "cardmarket");
  });

  it("asks nothing and draws nothing without a landing", () => {
    const { result } = renderHook(() => useLandedPrice(null), { wrapper });
    expect(result.current).toBeUndefined();
    expect(printingPrices).not.toHaveBeenCalled();
  });
});
