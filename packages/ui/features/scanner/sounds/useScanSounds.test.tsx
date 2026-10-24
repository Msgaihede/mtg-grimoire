import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanSounds, ScannerTrayRow } from "@/lib/ipc";

const printingPrices = vi.hoisted(() => vi.fn());
const scanSounds = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const played = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { printingPrices, scanSounds, getMarketplace, marketplaceFeedStatus },
}));
vi.mock("./player", () => ({ playScanSound: played, preloadScanSounds: vi.fn() }));

import { landedFrom, type LandedCard } from "../reader/AddedToast";
import { DEFAULT_SCAN_SOUNDS } from "./scanSounds";
import { useScanSounds } from "./useScanSounds";

const row: ScannerTrayRow = {
  key: "row-1",
  cardId: "ltr-426",
  oracleId: "oliphaunt",
  name: "Oliphaunt",
  setCode: "ltr",
  collectorNumber: "426",
  finish: "nonfoil",
  finishes: ["nonfoil", "foil"],
  quantity: 1,
  choices: [],
  addedAt: 1_000,
};

/** Oliphaunt at $15 plain and $1,500 foil. */
const PRICES = [{ cardId: "ltr-426", finishPrices: { nonfoil: 15, foil: 1500, etched: null } }];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type Props = { landed: LandedCard | null; rows: readonly ScannerTrayRow[] };

function mount(initial: Props) {
  return renderHook((props: Props) => useScanSounds(props), { wrapper, initialProps: initial });
}

describe("useScanSounds", () => {
  beforeEach(() => {
    played.mockReset();
    printingPrices.mockReset().mockResolvedValue(PRICES);
    scanSounds.mockReset().mockResolvedValue(DEFAULT_SCAN_SOUNDS);
  });

  it("plays nothing for a tray it opened on", async () => {
    mount({ landed: null, rows: [row] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(played).not.toHaveBeenCalled();
  });

  it("plays the landed card's tier, at its finish's price", async () => {
    const { rerender } = mount({ landed: null, rows: [] });
    rerender({ landed: landedFrom(row, false, false), rows: [row] });
    await waitFor(() => expect(played).toHaveBeenCalledWith("tier2"));
    expect(printingPrices).toHaveBeenCalledWith(["ltr-426"], "tcgplayer");

    const foil = { ...row, finish: "foil" as const, addedAt: 2_000 };
    rerender({ landed: landedFrom(foil, true, false), rows: [foil] });
    await waitFor(() => expect(played).toHaveBeenLastCalledWith("jackpot"));
  });

  it("plays needs-input for a pick or an unknown finish, without a price", async () => {
    const { rerender } = mount({ landed: null, rows: [] });
    const unknown = { ...row, finish: "unknown" as const };
    rerender({ landed: landedFrom(unknown, false, false), rows: [unknown] });
    expect(played).toHaveBeenCalledWith("needs-input");
    expect(printingPrices).not.toHaveBeenCalled();
  });

  it("plays the chosen card's tier when the reader settles it", async () => {
    const unknown = { ...row, finish: "unknown" as const };
    const { rerender } = mount({ landed: null, rows: [unknown] });
    rerender({ landed: null, rows: [{ ...unknown, finish: "foil" }] });
    await waitFor(() => expect(played).toHaveBeenCalledWith("jackpot"));
    expect(played).toHaveBeenCalledTimes(1);
  });

  it("plays the plain sound for an unpriced card", async () => {
    printingPrices.mockResolvedValue([]);
    const { rerender } = mount({ landed: null, rows: [] });
    rerender({ landed: landedFrom(row, false, false), rows: [row] });
    await waitFor(() => expect(played).toHaveBeenCalledWith("ok"));
  });

  it("plays nothing with the switch off", async () => {
    const off: ScanSounds = { ...DEFAULT_SCAN_SOUNDS, enabled: false };
    scanSounds.mockResolvedValue(off);
    const { result, rerender } = mount({ landed: null, rows: [] });
    // Wait for the stored setting to be read before anything lands.
    await waitFor(() => expect(scanSounds).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    rerender({ landed: landedFrom(row, false, false), rows: [row] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeUndefined();
    expect(played).not.toHaveBeenCalled();
  });
});
