import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckRow, LobbyPeer, LobbyState, PlaytestStep } from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { LOBBY_KEY } from "@/features/draft/lobby/useLobby";
import { GoldfishPage } from "./GoldfishPage";
import { keepGame, keptGame } from "./keptGame";
import { openingHand } from "./play/fixtures";
import { holdGame } from "./play/heldGame";
import { PlaytestingPage } from "./PlaytestingPage";

// Issue #1592: the ways the Playtesting page replaced a game, or closed a lobby, without asking.

const ipcMock = vi.hoisted(() => ({
  playtestSupport: vi.fn(),
  playtestStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestAct: vi.fn(),
  playtestEnd: vi.fn<(game: number) => Promise<void>>(),
  lobbyGameStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  lobbyState: vi.fn<() => Promise<LobbyState | null>>(),
  onLobbyState: vi.fn(() => () => {}),
  onPlaytestStep: vi.fn(() => () => {}),
  lobbyLeave: vi.fn<() => Promise<void>>(),
  lobbyKick: vi.fn(),
  lobbyDeck: vi.fn(),
  syncSupporterStatus: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));

const decks = vi.hoisted(() => ({ rows: [] as DeckRow[] }));
vi.mock("@/features/decks/useDecks", () => ({
  useDecks: () => ({ decks: decks.rows, query: { isPending: false } }),
}));
vi.mock("@/features/decks/useDeckFolders", () => ({
  useDeckFolders: () => ({ folders: [] }),
}));
vi.mock("@/features/decks/useDeckSort", async () => {
  const { DEFAULT_DECK_SORT } = await import("@/features/decks/deckSort");
  return { useDeckSort: () => ({ sort: DEFAULT_DECK_SORT, setSort: () => {} }) };
});
vi.mock("@/features/decks/deckWall", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/decks/deckWall")>();
  return { ...real, useDeckWallMarks: () => real.NO_WALL_MARKS };
});
vi.mock("@/features/decks/deckQuery", () => ({
  deckDetailQuery: (deckId: number) => ({
    queryKey: ["deck", deckId],
    queryFn: () => Promise.resolve({ deck: { name: "Simic Tempo" } }),
  }),
}));

function deck(id: number, name: string): DeckRow {
  return {
    id,
    name,
    gameKey: "any",
    formatKey: "modern",
    formatName: "Modern",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 60,
    updatedAt: 0,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    managedWishlist: "off",
    managedWishlistTokens: false,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    tokensOpen: false,
    tokenMode: "managed",
    tokenRailIndex: -1,
    statsOpen: true,
    curveCreatures: false,
    todosOpen: false,
    syncUid: null,
    draft: false,
    defaultCategoryId: 0,
    bracket: 0,
    tags: [],
  };
}

const guestPeer = (name: string, over: Partial<LobbyPeer> = {}): LobbyPeer => ({
  peer: `p-${name}`,
  name,
  online: true,
  deck: null,
  ...over,
});

const hosting = (over: Partial<LobbyState> = {}): LobbyState => ({
  role: "host",
  kind: "game",
  code: "K7QX2M",
  phase: "open",
  name: "Ada",
  hostName: "Ada",
  hostOnline: true,
  peers: [guestPeer("Bea", { deck: "Mono Red" })],
  label: "",
  closedReason: null,
  trade: null,
  ...over,
});

const dealt = (): PlaytestStep => ({ view: openingHand(), happened: [], frames: [] });

beforeEach(() => {
  decks.rows = [deck(1, "Simic Tempo"), deck(2, "Boros Aggro")];
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.onLobbyState.mockImplementation(() => () => {});
  ipcMock.onPlaytestStep.mockImplementation(() => () => {});
  ipcMock.playtestSupport.mockResolvedValue({ supported: 60, unsupported: [] });
  ipcMock.playtestStart.mockResolvedValue(dealt());
  ipcMock.playtestEnd.mockResolvedValue(undefined);
  ipcMock.lobbyLeave.mockResolvedValue(undefined);
  ipcMock.lobbyState.mockResolvedValue(null);
  ipcMock.syncSupporterStatus.mockResolvedValue({
    entitled: true,
    status: "active",
    groupBound: false,
  });
  keptGame()?.end();
  keepGame(null);
});

function page(lobby: LobbyState | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(LOBBY_KEY, lobby);
  ipcMock.lobbyState.mockResolvedValue(lobby);
  render(
    <QueryClientProvider client={client}>
      <ContextMenuProvider>
        <PlaytestingPage />
      </ContextMenuProvider>
    </QueryClientProvider>,
  );
  return client;
}

const tile = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const startButton = () => screen.getByRole("button", { name: "Start game" });

describe("PlaytestingPage under its board", () => {
  it("leaves the setup inert and moves focus onto the board, so Enter deals nothing new", async () => {
    page();
    await userEvent.click(tile("Simic Tempo"));
    await userEvent.click(tile("Boros Aggro"));
    startButton().focus();
    await userEvent.keyboard("{Enter}");
    const board = await screen.findByRole("region", { name: "Playtest" });
    await waitFor(() => expect(ipcMock.playtestStart).toHaveBeenCalledTimes(1));

    expect(document.activeElement).toBe(board);
    expect(startButton().closest("section")).toHaveAttribute("inert");
    await userEvent.keyboard("{Enter}");
    expect(ipcMock.playtestStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("PlaytestingPage as a lobby's host", () => {
  async function seatAndStart() {
    await userEvent.click(tile("Simic Tempo"));
    fireEvent.click(startButton());
  }

  it("shows the board only once the deal answers, and says it is dealing meanwhile", async () => {
    let answer: (step: PlaytestStep) => void = () => {};
    ipcMock.lobbyGameStart.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    page(hosting());
    await seatAndStart();
    await waitFor(() => expect(ipcMock.lobbyGameStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Playtest" })).toBeNull();
    expect(screen.getByText("Dealing the game…")).toBeInTheDocument();
    expect(startButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(startButton());
    expect(ipcMock.lobbyGameStart).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(dealt());
      await Promise.resolve();
    });
    expect(await screen.findByRole("region", { name: "Playtest" })).toBeInTheDocument();
  });

  it("says a refused deal in the lobby panel, and keeps the lobby open", async () => {
    ipcMock.lobbyGameStart.mockRejectedValue(
      "Bea's deck has a printing this app's card data lacks. Update the card data in Settings, then start again.",
    );
    page(hosting());
    await seatAndStart();
    const panel = screen.getByRole("complementary", { name: "Game lobby" });
    expect(await within(panel).findByText(/Update the card data in Settings/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Playtest" })).toBeNull();
    expect(startButton().closest("section")).not.toHaveAttribute("inert");
    expect(ipcMock.lobbyLeave).not.toHaveBeenCalled();
    expect(keptGame()?.state().view ?? null).toBeNull();

    // Fixed, and started again: the board comes up for that deal.
    ipcMock.lobbyGameStart.mockResolvedValue(dealt());
    fireEvent.click(startButton());
    expect(await screen.findByRole("region", { name: "Playtest" })).toBeInTheDocument();
    expect(screen.queryByText(/Update the card data in Settings/)).toBeNull();
  });

  it("closes the lobby when the board's way back ends a dealt game", async () => {
    ipcMock.lobbyGameStart.mockResolvedValue(dealt());
    page(hosting());
    await seatAndStart();
    await screen.findByRole("region", { name: "Playtest" });
    await screen.findByRole("button", { name: /keep/i });
    await userEvent.click(screen.getByRole("button", { name: "Back to the playtest setup" }));
    await userEvent.click(await screen.findByRole("button", { name: "End game" }));
    await waitFor(() => expect(ipcMock.lobbyLeave).toHaveBeenCalledTimes(1));
  });
});

describe("GoldfishPage over a kept lobby game", () => {
  function goldfish() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(LOBBY_KEY, hosting({ phase: "playing" }));
    render(
      <QueryClientProvider client={client}>
        <ContextMenuProvider>
          <GoldfishPage deckId={1} variant="live" />
        </ContextMenuProvider>
      </QueryClientProvider>,
    );
    return client;
  }

  async function hostGame() {
    ipcMock.lobbyGameStart.mockResolvedValue(dealt());
    const game = holdGame({
      deckId: 1,
      variant: "live",
      opponents: [],
      lobby: { seats: [{ peer: "p-Bea", deckId: null, variant: null }], names: ["Bea"] },
    });
    game.start();
    keepGame(game);
    await waitFor(() => expect(game.state().view).not.toBeNull());
    return game;
  }

  it("says the game has people in it, and closes the lobby when it is ended", async () => {
    const game = await hostGame();
    const client = goldfish();
    const dialog = await screen.findByRole("dialog", { name: "Close your lobby game?" });
    expect(dialog).toHaveTextContent("ends that game for everyone, and the lobby closes");
    await userEvent.click(screen.getByRole("button", { name: "Close it and goldfish" }));
    await waitFor(() => expect(ipcMock.lobbyLeave).toHaveBeenCalledTimes(1));
    expect(game.live()).toBe(false);
    await waitFor(() => expect(client.getQueryData(LOBBY_KEY)).toBeNull());
  });

  it("leaves the lobby be when Keep it is pressed", async () => {
    const game = await hostGame();
    goldfish();
    await userEvent.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(ipcMock.lobbyLeave).not.toHaveBeenCalled();
    expect(game.live()).toBe(true);
  });
});
