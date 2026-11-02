import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckRow, DraftSaved, DraftView, LobbyState, SupporterStatus } from "@/lib/ipc";

const ipcMock = vi.hoisted(() => ({
  draftSaved: vi.fn(),
  draftDeckList: vi.fn(),
  deckList: vi.fn(),
  lobbyState: vi.fn(),
  onLobbyState: vi.fn(),
  onDraftView: vi.fn(),
  draftView: vi.fn(),
  draftResume: vi.fn(),
  draftEnd: vi.fn(),
  syncSupporterStatus: vi.fn(),
  packsBoosterSets: vi.fn(),
  onPacksRefreshed: vi.fn(),
  lobbyCreate: vi.fn(),
  lobbyRejoin: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));
const openDraftDeck = vi.hoisted(() => vi.fn());
vi.mock("@/features/draft/navigation", () => ({ openDraftDeck }));

import { DraftPage } from "./DraftPage";
import { currentDraft } from "./pick/current";

const SAVED: DraftSaved = {
  label: "Foundations · The Hobbit",
  mode: "quick",
  status: "drafting",
  packNumber: 1,
  packCount: 3,
  pickNumber: 4,
  updatedAt: Date.now() - 17 * 60_000,
};

const VIEW: DraftView = {
  mode: "quick",
  status: "drafting",
  label: SAVED.label,
  seat: 0,
  packNumber: 1,
  packCount: 3,
  pickNumber: 4,
  packSize: 14,
  passLeft: false,
  pack: [
    {
      instanceId: "a#0.1.0",
      cardId: "a",
      name: "Gandalf",
      setCode: "hob",
      collectorNumber: "1",
      rarity: "mythic",
      colors: ["W"],
      cmc: 4,
      typeLine: "Legendary Creature — Avatar Wizard",
    },
  ],
  waiting: false,
  pool: [],
  seats: [],
  packSets: ["FDN", "HOB", "HOB"],
  minDeckSize: 40,
  podFormat: "booster",
  picksPerStep: 1,
  commanders: 0,
  stack: null,
};

const DRAFT_DECK = {
  id: 5,
  name: "Hobbit Draft",
  cardCount: 45,
  syncUid: "uid-5",
  draft: true,
} as DeckRow;

const NOT_SUPPORTER: SupporterStatus = {
  entitled: false,
  status: "none",
  since: null,
  groupBound: false,
};

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.draftSaved.mockResolvedValue(null);
  ipcMock.draftDeckList.mockResolvedValue([]);
  ipcMock.deckList.mockResolvedValue([]);
  ipcMock.lobbyState.mockResolvedValue(null);
  ipcMock.onLobbyState.mockReturnValue(() => {});
  ipcMock.onDraftView.mockReturnValue(() => {});
  ipcMock.draftView.mockResolvedValue(null);
  ipcMock.syncSupporterStatus.mockResolvedValue(NOT_SUPPORTER);
  ipcMock.packsBoosterSets.mockResolvedValue([]);
  ipcMock.lobbyRejoin.mockResolvedValue(null);
  openDraftDeck.mockReset();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftPage />
    </QueryClientProvider>,
  );
}

describe("DraftPage", () => {
  it("offers the seven ways to start, and nothing in progress when there is none", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "Draft & Packs" })).toBeInTheDocument();
    const start = screen.getByRole("region", { name: "Start new" });
    const modes = [
      "Quick Draft",
      "Sealed",
      "Cube Draft",
      "Pod Draft",
      "Commander Draft",
      "Winston Draft",
      "Open Packs",
    ];
    const cards = within(start).getAllByRole("button");
    expect(cards.map((c) => modes.find((m) => c.textContent?.startsWith(m)))).toEqual(modes);
    await vi.waitFor(() => expect(ipcMock.draftSaved).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Draft in progress" })).not.toBeInTheDocument();
  });

  it("lists the saved draft and resumes it on the pick screen", async () => {
    ipcMock.draftSaved.mockResolvedValue(SAVED);
    ipcMock.draftResume.mockResolvedValue(VIEW);
    setup();
    const progress = await screen.findByRole("region", { name: "Draft in progress" });
    expect(within(progress).getByText(SAVED.label)).toBeInTheDocument();
    expect(within(progress).getByText("Drafting")).toBeInTheDocument();
    expect(
      within(progress).getByText("Quick Draft · Pack 2 of 3 · Pick 5 · 17 minutes ago"),
    ).toBeInTheDocument();
    await userEvent.click(within(progress).getByRole("button", { name: "Resume" }));
    expect(ipcMock.draftResume).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", { name: "Pack 2 · Pick 5" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gandalf" })).toBeInTheDocument();
  });

  it("lists an unsaved draft deck and continues building it in the editor", async () => {
    ipcMock.draftDeckList.mockResolvedValue([DRAFT_DECK]);
    setup();
    const progress = await screen.findByRole("region", { name: "Draft in progress" });
    expect(within(progress).getByText("Hobbit Draft")).toBeInTheDocument();
    expect(within(progress).getByText("45 cards · not saved yet")).toBeInTheDocument();
    await userEvent.click(within(progress).getByRole("button", { name: "Continue building" }));
    expect(openDraftDeck).toHaveBeenCalledWith(5);
  });

  it("lists draft_deck_list's rows and never reads the reader's decks for them", async () => {
    // `deck_list` never answers a draft deck, so the hub has nothing of the gallery's to filter.
    ipcMock.deckList.mockResolvedValue([{ ...DRAFT_DECK, name: "My Elves", draft: false }]);
    setup();
    await waitFor(() => expect(ipcMock.draftDeckList).toHaveBeenCalled());
    expect(await screen.findByRole("region", { name: "Start new" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Draft in progress" })).not.toBeInTheDocument();
    expect(screen.queryByText("My Elves")).not.toBeInTheDocument();
    expect(ipcMock.deckList).not.toHaveBeenCalled();
  });

  it("opens a mode's setup, and comes back by the trail", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^Sealed/ }));
    expect(screen.getByRole("button", { name: /Open sealed pool/ })).toBeInTheDocument();
    expect(screen.getByText("0 packs chosen — up to 6")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to Draft & Packs" }));
    expect(screen.getByRole("region", { name: "Start new" })).toBeInTheDocument();
  });

  it("opens a Commander draft's and a Winston draft's setup from the hub", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^Commander Draft/ }));
    expect(screen.getByRole("button", { name: "Commander" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to Draft & Packs" }));
    await userEvent.click(screen.getByRole("button", { name: /^Winston Draft/ }));
    expect(screen.getByRole("button", { name: "Winston" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Create lobby from a reader who is not a supporter", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /^Pod Draft/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Your name at the table" }), "Ada");
    expect(await screen.findByText("Hosting a pod is for supporters.")).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create lobby" });
    expect(create).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(create);
    expect(ipcMock.lobbyCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Join" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByRole("textbox", { name: "Lobby code" }), "k7 qx-2m0");
    expect(screen.getByRole("textbox", { name: "Lobby code" })).toHaveValue("K7QX2M");
    expect(screen.getByRole("button", { name: "Join" })).toHaveAttribute("aria-disabled", "false");
  });

  it("returns to a live lobby", async () => {
    const lobby: LobbyState = {
      role: "guest",
      kind: "draft",
      code: "K7QX2M",
      phase: "open",
      name: "Bea",
      hostName: "Ada",
      hostOnline: true,
      peers: [{ peer: "p1", name: "Bea", online: true, deck: null }],
      label: "The Hobbit",
      closedReason: null,
      trade: null,
    };
    ipcMock.lobbyState.mockResolvedValue(lobby);
    setup();
    const progress = await screen.findByRole("region", { name: "Draft in progress" });
    await userEvent.click(within(progress).getByRole("button", { name: "Return" }));
    expect(screen.getByText("Waiting for Ada to start the draft.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave lobby" })).toBeInTheDocument();
  });

  describe("a drafting pod (issue #1468)", () => {
    const POD: LobbyState = {
      role: "host",
      kind: "draft",
      code: "K7QX2M",
      phase: "drafting",
      name: "Ada",
      hostName: "Ada",
      hostOnline: true,
      peers: [{ peer: "p1", name: "Bea", online: true, deck: null }],
      label: "The Hobbit",
      closedReason: null,
      trade: null,
    };

    it("is a draft in progress, and Rejoin takes a seat the window lost again", async () => {
      ipcMock.lobbyState.mockResolvedValue(POD);
      ipcMock.lobbyRejoin.mockResolvedValue(7);
      ipcMock.draftView.mockResolvedValue({ ...VIEW, mode: "pod", pickNumber: 4 });
      setup();
      const progress = await screen.findByRole("region", { name: "Draft in progress" });
      expect(within(progress).getByText("Drafting")).toBeInTheDocument();
      expect(within(progress).getByText("Pod Draft · code K7QX2M · 2 people")).toBeInTheDocument();
      await userEvent.click(within(progress).getByRole("button", { name: "Rejoin" }));
      expect(await screen.findByRole("heading", { name: "Pack 2 · Pick 5" })).toBeInTheDocument();
      expect(ipcMock.lobbyRejoin).toHaveBeenCalledOnce();
      expect(ipcMock.draftView).toHaveBeenCalledWith(7);
    });

    it("says where a guest's kept seat was, and Rejoin opens it", async () => {
      currentDraft.keep({
        draft: null,
        role: "guest",
        view: { ...VIEW, mode: "pod", packNumber: 1, pickNumber: 2 },
      });
      ipcMock.lobbyState.mockResolvedValue({ ...POD, role: "guest", name: "Bea" });
      setup();
      // A seat the window kept opens on its pick, not the hub.
      expect(await screen.findByRole("heading", { name: "Pack 2 · Pick 3" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Back to Draft & Packs" }));
      const progress = await screen.findByRole("region", { name: "Draft in progress" });
      expect(
        within(progress).getByText(
          "Pod Draft · Pack 2 of 3 · Pick 3 · code K7QX2M · 2 people · hosted by Ada",
        ),
      ).toBeInTheDocument();
      await userEvent.click(within(progress).getByRole("button", { name: "Rejoin" }));
      expect(await screen.findByRole("heading", { name: "Pack 2 · Pick 3" })).toBeInTheDocument();
      expect(ipcMock.lobbyRejoin).toHaveBeenCalled();
    });
  });
});
