import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanSounds } from "@/lib/ipc";

const scanSounds = vi.hoisted(() => vi.fn());
const setScanSounds = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const played = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { scanSounds, setScanSounds, getMarketplace, marketplaceFeedStatus },
}));
vi.mock("@/features/scanner/sounds/player", () => ({ playScanSound: played }));

import { DEFAULT_SCAN_SOUNDS, TIERS_MUST_CLIMB } from "@/features/scanner/sounds/scanSounds";
import { ScanSoundsPanel } from "./ScanSoundsPanel";

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const box = (name: string) => screen.getByRole("textbox", { name: `${name} starts at` });

describe("ScanSoundsPanel", () => {
  beforeEach(() => {
    played.mockReset();
    scanSounds.mockReset().mockResolvedValue(DEFAULT_SCAN_SOUNDS);
    setScanSounds.mockReset().mockResolvedValue(undefined);
  });

  it("draws the stored ladder and says which prices it is judged at", async () => {
    render(wrap(<ScanSoundsPanel />));
    expect(screen.getByRole("region", { name: "Scan sounds" })).toBeInTheDocument();
    await waitFor(() => expect(box("Jackpot")).toHaveValue("1000"));
    expect(box("Tier 1")).toHaveValue("1");
    expect(screen.getByText(/TCGplayer \(USD\)/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Play a sound/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("turns the sounds off, keeping the ladder", async () => {
    render(wrap(<ScanSoundsPanel />));
    await waitFor(() => expect(scanSounds).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("switch", { name: /Play a sound/ }));
    expect(setScanSounds).toHaveBeenCalledWith({ ...DEFAULT_SCAN_SOUNDS, enabled: false });
  });

  it("stores a tier when its box is left, and only a ladder that climbs", async () => {
    render(wrap(<ScanSoundsPanel />));
    await waitFor(() => expect(box("Tier 2")).toHaveValue("10"));

    await userEvent.clear(box("Tier 2"));
    await userEvent.type(box("Tier 2"), "$5{Enter}");
    const next: ScanSounds = { ...DEFAULT_SCAN_SOUNDS, tier2: 5 };
    expect(setScanSounds).toHaveBeenCalledWith(next);

    setScanSounds.mockClear();
    await userEvent.clear(box("Tier 3"));
    await userEvent.type(box("Tier 3"), "2{Enter}");
    expect(setScanSounds).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(TIERS_MUST_CLIMB);
  });

  /** Issue #1589: the ladder raised in list order — the drafts are checked and stored together. */
  it("stores a refused box's draft once the next box makes the ladder climb", async () => {
    const user = userEvent.setup();
    render(wrap(<ScanSoundsPanel />));
    await waitFor(() => expect(box("Tier 1")).toHaveValue("1"));

    await user.clear(box("Tier 1"));
    await user.type(box("Tier 1"), "20");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent(TIERS_MUST_CLIMB);
    expect(setScanSounds).not.toHaveBeenCalled();

    await user.clear(box("Tier 2"));
    await user.type(box("Tier 2"), "50");
    await user.tab();
    expect(setScanSounds).toHaveBeenCalledWith({ ...DEFAULT_SCAN_SOUNDS, tier1: 20, tier2: 50 });
    expect(box("Tier 1")).toHaveValue("20");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the refusal while a refused draft is still on screen", async () => {
    const user = userEvent.setup();
    render(wrap(<ScanSoundsPanel />));
    await waitFor(() => expect(box("Tier 1")).toHaveValue("1"));
    await user.clear(box("Tier 1"));
    await user.type(box("Tier 1"), "20");
    await user.tab();
    // Tier 2 at 15 still leaves Tier 1's 20 above it: nothing is stored, the sentence stays.
    await user.clear(box("Tier 2"));
    await user.type(box("Tier 2"), "15");
    await user.tab();
    expect(setScanSounds).not.toHaveBeenCalled();
    expect(box("Tier 1")).toHaveValue("20");
    expect(screen.getByRole("alert")).toHaveTextContent(TIERS_MUST_CLIMB);
  });

  /** Issue #1589: the box is one node for its whole life, so Enter keeps the caret in it. */
  it("keeps focus in the box after Enter stores it", async () => {
    const user = userEvent.setup();
    render(wrap(<ScanSoundsPanel />));
    await waitFor(() => expect(box("Tier 2")).toHaveValue("10"));
    const before = box("Tier 2");
    await user.clear(before);
    await user.type(before, "5{Enter}");
    await waitFor(() => expect(setScanSounds).toHaveBeenCalled());
    expect(box("Tier 2")).toBe(before);
    expect(before).toHaveFocus();
  });

  it("plays each sound from its row", async () => {
    render(wrap(<ScanSoundsPanel />));
    await userEvent.click(screen.getByRole("button", { name: "Play the Jackpot sound" }));
    expect(played).toHaveBeenCalledWith("jackpot");
    await userEvent.click(screen.getByRole("button", { name: "Play the Needs a choice sound" }));
    expect(played).toHaveBeenLastCalledWith("needs-input");
  });
});
