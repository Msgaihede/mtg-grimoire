import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftView } from "@/lib/ipc";

/**
 * Issue #1588: a new deal starts the Deck/Sideboard split over. A Sealed pool's first view holds
 * the whole pool, and its instance ids (seat 0, rounds 0–5) are the last Sealed pool's again — so
 * the empty-pool rule alone would let an old sideboard claim cards of the new one.
 */
const ipcMock = vi.hoisted(() => ({
  draftSaved: vi.fn(),
  draftDeckList: vi.fn(),
  lobbyState: vi.fn(),
  onLobbyState: vi.fn(),
  onDraftView: vi.fn(),
  draftView: vi.fn(),
  syncSupporterStatus: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));

const SEALED = (cardId: string, index: number) => ({
  instanceId: `${cardId}#0.0.${index}`,
  cardId,
  name: `Card ${cardId}`,
  setCode: "tst",
  collectorNumber: "1",
  rarity: "common",
  colors: [],
  cmc: 1,
  typeLine: "Instant",
  manaCost: "{R}",
});

const VIEW: DraftView = {
  mode: "sealed",
  status: "deckbuilding",
  label: "Sealed",
  seat: 0,
  packNumber: 5,
  packCount: 6,
  pickNumber: 0,
  packSize: 14,
  passLeft: false,
  pack: [],
  waiting: false,
  pool: [SEALED("a", 0), SEALED("b", 1)],
  seats: [],
  packSets: ["TST"],
  minDeckSize: 40,
  podFormat: "booster",
  picksPerStep: 1,
  commanders: 0,
  stack: null,
};

// The setup's own deal is SetupScreen's suite's; here it is one press that hands back a pool.
vi.mock("./setup/SetupScreen", () => ({
  SetupScreen: ({ onStarted }: { onStarted: (draft: number, view: DraftView) => void }) => (
    <button type="button" onClick={() => onStarted(9, VIEW)}>
      Deal
    </button>
  ),
}));

import { DraftPage } from "./DraftPage";
import { keepSideboard, recallSideboard } from "./pick/split";

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.draftSaved.mockResolvedValue(null);
  ipcMock.draftDeckList.mockResolvedValue([]);
  ipcMock.lobbyState.mockResolvedValue(null);
  ipcMock.onLobbyState.mockReturnValue(() => {});
  ipcMock.onDraftView.mockReturnValue(() => {});
  ipcMock.draftView.mockResolvedValue(null);
});

describe("DraftPage's new deal", () => {
  it("starts every card of a new Sealed pool in Deck", async () => {
    // The last Sealed pool's sideboard, by ids this pool repeats.
    keepSideboard(["a#0.0.0"]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DraftPage />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Sealed/ }));
    await userEvent.click(screen.getByRole("button", { name: "Deal" }));
    expect(recallSideboard()).toEqual([]);
  });
});
