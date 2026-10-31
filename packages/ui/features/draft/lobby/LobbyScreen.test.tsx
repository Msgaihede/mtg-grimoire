import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SET } from "@/features/draft/booster/fixture";
import type { BoosterSetSummary, DraftSetup, DraftView, LobbyState } from "@/lib/ipc";

const ipcMock = vi.hoisted(() => ({
  lobbyState: vi.fn(),
  onLobbyState: vi.fn(),
  onDraftView: vi.fn(),
  syncSupporterStatus: vi.fn(),
  packsBoosterSets: vi.fn(),
  onPacksRefreshed: vi.fn(),
  packsBoosterSet: vi.fn(),
  lobbyStart: vi.fn(),
  lobbyKick: vi.fn(),
  lobbyLeave: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));

import { LobbyScreen } from "./LobbyScreen";

const TEST_SET: BoosterSetSummary = {
  code: "tst",
  name: "Test Set",
  releaseDate: "2026-01-01",
};

const HOSTING: LobbyState = {
  role: "host",
  kind: "draft",
  code: "K7QX2M",
  phase: "open",
  name: "Ada",
  hostName: "Ada",
  hostOnline: true,
  peers: [
    { peer: "p1", name: "Bea", online: true, deck: null },
    { peer: "p2", name: "Cy", online: false, deck: null },
  ],
  label: "",
  closedReason: null,
  trade: null,
};

const VIEW = { status: "drafting" } as DraftView;

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.lobbyState.mockResolvedValue(HOSTING);
  ipcMock.onLobbyState.mockReturnValue(() => {});
  ipcMock.onDraftView.mockReturnValue(() => {});
  ipcMock.packsBoosterSets.mockResolvedValue([TEST_SET]);
  ipcMock.packsBoosterSet.mockResolvedValue(SET);
  ipcMock.lobbyStart.mockResolvedValue(VIEW);
});

function setup() {
  const onDraft = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LobbyScreen onBack={vi.fn()} onDraft={onDraft} />
    </QueryClientProvider>,
  );
  return { onDraft };
}

async function threePacks() {
  const wall = await screen.findByRole("list", { name: "Sets" });
  await userEvent.click(within(wall).getByRole("button", { name: /Test Set/ }));
  await userEvent.click(screen.getByRole("button", { name: "Test Set for the rest" }));
}

const seatButtons = () =>
  within(screen.getByRole("group", { name: "Seats" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("the host's room", () => {
  it("starts a booster pod at eight seats: the host, the guests online, and bots", async () => {
    const { onDraft } = setup();
    await threePacks();
    await userEvent.click(screen.getByRole("button", { name: /Start draft/ }));
    await waitFor(() => expect(ipcMock.lobbyStart).toHaveBeenCalledOnce());
    const [setupArg, draft] = ipcMock.lobbyStart.mock.calls[0] as [DraftSetup, number];
    expect(setupArg).toMatchObject({ mode: "pod", podFormat: "booster", minDeckSize: 40 });
    expect(setupArg.seats.map((s) => s.name)).toEqual([
      "Ada",
      "Bea",
      "Bot 1",
      "Bot 2",
      "Bot 3",
      "Bot 4",
      "Bot 5",
      "Bot 6",
    ]);
    expect(setupArg.packs).toHaveLength(8);
    expect(onDraft).toHaveBeenCalledWith(draft, VIEW, "host");
  });

  it("starts a Commander pod at the seats the host picks, for a 60-card deck", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Commander" }));
    expect(seatButtons()).toEqual(["3", "4", "5", "6", "7", "8"]);
    await userEvent.click(within(screen.getByRole("group", { name: "Seats" })).getByText("5"));
    await threePacks();
    await userEvent.click(screen.getByRole("button", { name: /Start draft/ }));
    await waitFor(() => expect(ipcMock.lobbyStart).toHaveBeenCalledOnce());
    const setupArg = ipcMock.lobbyStart.mock.calls[0][0] as DraftSetup;
    expect(setupArg).toMatchObject({ mode: "pod", podFormat: "commander", minDeckSize: 60 });
    expect(setupArg.seats).toHaveLength(5);
    expect(setupArg.packs).toHaveLength(5);
  });

  it("offers a Winston pod two to four seats, and starts it at two", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Winston" }));
    expect(seatButtons()).toEqual(["2", "3", "4"]);
    await threePacks();
    await userEvent.click(screen.getByRole("button", { name: /Start draft/ }));
    await waitFor(() => expect(ipcMock.lobbyStart).toHaveBeenCalledOnce());
    const setupArg = ipcMock.lobbyStart.mock.calls[0][0] as DraftSetup;
    expect(setupArg).toMatchObject({ podFormat: "winston", minDeckSize: 40 });
    expect(setupArg.seats.map((s) => s.name)).toEqual(["Ada", "Bea"]);
  });

  it("keeps a Winston pod from starting with more people than it seats", async () => {
    ipcMock.lobbyState.mockResolvedValue({
      ...HOSTING,
      peers: ["Bea", "Cy", "Dee", "Eve"].map((name, i) => ({
        peer: `p${i}`,
        name,
        online: true,
        deck: null,
      })),
    });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Winston" }));
    await threePacks();
    expect(screen.getByText("5 people are in; Winston seats 4 at most.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start draft/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
