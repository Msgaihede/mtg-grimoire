import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyState, Trade, TradeLine } from "@/lib/ipc";

const ipcMock = vi.hoisted(() => ({
  lobbyState: vi.fn(),
  onLobbyState: vi.fn(),
  syncSupporterStatus: vi.fn(),
  lobbyCreate: vi.fn(),
  lobbyJoin: vi.fn(),
  lobbyLeave: vi.fn(),
  lobbyTradeOffer: vi.fn(),
  lobbyTradeAccept: vi.fn(),
  tradeCreate: vi.fn(),
  tradeDelete: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: ipcMock,
}));

import { LOBBY_KEY } from "@/features/draft/lobby/useLobby";
import { TradeLobbyBand } from "./TradeLobbyBand";
import { TradeLobbyDialog } from "./TradeLobbyDialog";
import { dealLine, readerLine, unknownLine } from "./tradeLobbyWords";
import { offerKey, tradeLobbyOf, useSendOffer, type TradeLobby } from "./useTradeLobby";

function lobby(over: Partial<LobbyState> = {}, deal: Partial<TradeLobby["trade"]["deal"]> = {}) {
  return {
    role: "host",
    kind: "trade",
    code: "K7QX2M",
    phase: "open",
    name: "Ada",
    hostName: "Ada",
    hostOnline: true,
    peers: [{ peer: "p1", name: "Bo", online: true, deck: null }],
    label: "",
    closedReason: null,
    trade: {
      tradeId: 7,
      unknown: 0,
      deal: { rev: 3, host: [], guest: [], hostAccepted: false, guestAccepted: false, ...deal },
    },
    ...over,
  } as TradeLobby;
}

function line(over: Partial<TradeLine>): TradeLine {
  return {
    id: 1,
    side: "mine",
    cardId: "bolt",
    finish: "nonfoil",
    quantity: 1,
    ...over,
  } as TradeLine;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  for (const fn of Object.values(ipcMock)) fn.mockReset();
  ipcMock.lobbyState.mockResolvedValue(null);
  ipcMock.onLobbyState.mockReturnValue(() => {});
  ipcMock.syncSupporterStatus.mockResolvedValue({
    entitled: true,
    status: "active",
    groupBound: false,
  });
  ipcMock.lobbyTradeOffer.mockResolvedValue(undefined);
  ipcMock.lobbyTradeAccept.mockResolvedValue(undefined);
  ipcMock.lobbyLeave.mockResolvedValue(undefined);
  ipcMock.tradeDelete.mockResolvedValue(undefined);
});

describe("the trade lobby's words", () => {
  it("names the other reader, or says who is missing", () => {
    expect(readerLine(lobby({ peers: [] }))).toBe(
      "Waiting for the other reader — share the code with them.",
    );
    expect(readerLine(lobby())).toBe("Trading with Bo");
    expect(readerLine(lobby({ role: "guest", hostOnline: false }))).toBe(
      "Trading with Ada, who is away",
    );
    expect(readerLine(lobby({ phase: "closed", closedReason: "The host closed the lobby." }))).toBe(
      "The lobby K7QX2M closed: The host closed the lobby.",
    );
  });

  it("says where the deal stands from this reader's seat", () => {
    expect(dealLine(lobby({}, { hostAccepted: true }))).toBe("You accepted. Waiting for Bo.");
    expect(dealLine(lobby({}, { guestAccepted: true }))).toBe(
      "Bo accepted this trade. Look it over and accept it too.",
    );
    expect(dealLine(lobby({ role: "guest" }, { hostAccepted: true }))).toBe(
      "Ada accepted this trade. Look it over and accept it too.",
    );
    expect(dealLine(lobby({ phase: "agreed" }))).toMatch(/^You have both accepted\. Finish/);
    expect(unknownLine(0)).toBeNull();
    expect(unknownLine(1)).toMatch(/^1 card they offer is not in your card data/);
    expect(unknownLine(3)).toMatch(/^3 cards they offer are/);
  });

  it("is this page's only for a trade's lobby holding a trade", () => {
    expect(tradeLobbyOf(lobby())).not.toBeNull();
    expect(tradeLobbyOf(lobby({ kind: null }))).not.toBeNull();
    expect(tradeLobbyOf(lobby({ kind: "draft" }))).toBeNull();
    expect(tradeLobbyOf(lobby({ trade: null }))).toBeNull();
    expect(tradeLobbyOf(null)).toBeNull();
  });

  it("keys an offer on the reader's side alone", () => {
    const trade = {
      lines: [
        line({ cardId: "bolt", quantity: 2 }),
        line({ side: "theirs", cardId: "goyf" }),
        line({ cardId: "charm", finish: "foil" }),
      ],
    } as Trade;
    expect(offerKey(trade)).toBe("bolt|nonfoil|2,charm|foil|1");
  });
});

describe("the band", () => {
  function band(state: TradeLobby, onFinish = vi.fn()) {
    render(
      <QueryClientProvider client={client()}>
        <TradeLobbyBand
          lobby={state}
          showing
          onShow={vi.fn()}
          onFinish={onFinish}
          sendFailure={null}
        />
      </QueryClientProvider>,
    );
    return { onFinish };
  }

  it("accepts the revision on screen, and takes an acceptance back", async () => {
    band(lobby());
    expect(screen.getByText("Trading with Bo")).toBeInTheDocument();
    expect(screen.getByText("K7QX2M")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept trade" }));
    expect(ipcMock.lobbyTradeAccept).toHaveBeenCalledWith(3, true);
  });

  it("offers the take-back once this reader has accepted", async () => {
    band(lobby({}, { hostAccepted: true }));
    await userEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(ipcMock.lobbyTradeAccept).toHaveBeenCalledWith(3, false);
  });

  it("cannot accept before anybody has joined", async () => {
    band(lobby({ peers: [] }));
    const accept = screen.getByRole("button", { name: "Accept trade" });
    expect(accept).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(accept);
    expect(ipcMock.lobbyTradeAccept).not.toHaveBeenCalled();
  });

  it("offers Finish trade once both have accepted", async () => {
    const { onFinish } = band(
      lobby({ phase: "agreed" }, { hostAccepted: true, guestAccepted: true }),
    );
    expect(screen.queryByRole("button", { name: "Accept trade" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Finish trade" }));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("closes a host's lobby, and leaves a guest's", async () => {
    band(lobby());
    await userEvent.click(screen.getByRole("button", { name: "Close lobby" }));
    expect(ipcMock.lobbyLeave).toHaveBeenCalledOnce();
  });
});

describe("the dialog", () => {
  function dialog() {
    const onOpened = vi.fn();
    const c = client();
    render(
      <QueryClientProvider client={c}>
        <TradeLobbyDialog open onOpened={onOpened} onDismiss={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    return { onOpened, c };
  }

  it("makes the reader's copy of the trade, then opens the lobby with it", async () => {
    ipcMock.tradeCreate.mockResolvedValue(12);
    const hosted = lobby({ trade: { tradeId: 12, unknown: 0, deal: lobby().trade.deal } });
    ipcMock.lobbyCreate.mockResolvedValue(hosted);
    const { onOpened, c } = dialog();
    await userEvent.type(screen.getByLabelText("Your name in the lobby"), "Ada");
    await userEvent.click(await screen.findByRole("button", { name: /Create lobby/ }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(12));
    expect(ipcMock.lobbyCreate).toHaveBeenCalledWith("Ada", "trade", 12);
    expect(c.getQueryData(LOBBY_KEY)).toEqual(hosted);
  });

  it("joins by code with a new copy, and takes the copy back when the lobby refuses", async () => {
    ipcMock.tradeCreate.mockResolvedValue(13);
    ipcMock.lobbyJoin.mockRejectedValue("That lobby code is not open.");
    const { onOpened } = dialog();
    await userEvent.type(screen.getByLabelText("Your name in the lobby"), "Bo");
    await userEvent.type(screen.getByLabelText("Join with a code"), "k7qx 2m");
    await userEvent.click(screen.getByRole("button", { name: /Join/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That lobby code is not open.");
    expect(ipcMock.lobbyJoin).toHaveBeenCalledWith("K7QX2M", "Bo", 13);
    await waitFor(() => expect(ipcMock.tradeDelete).toHaveBeenCalledWith(13));
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("tells a reader who is not a supporter that anybody can join", async () => {
    ipcMock.syncSupporterStatus.mockResolvedValue({ entitled: false, status: null });
    dialog();
    expect(
      await screen.findByText(/Starting a trade online is for supporters; anybody can join/),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your name in the lobby"), "Ada");
    await userEvent.click(screen.getByRole("button", { name: /Create lobby/ }));
    expect(ipcMock.tradeCreate).not.toHaveBeenCalled();
  });
});

describe("sending the offer", () => {
  function Probe({ state, trade }: { state: TradeLobby | null; trade: Trade | null }) {
    const failure = useSendOffer(state, trade);
    return <p>{failure ?? "fine"}</p>;
  }

  const trade = (lines: TradeLine[]) => ({ id: 7, status: "open", lines }) as Trade;

  it("sends when the reader's side moves, and not when the other side does", async () => {
    const first = trade([line({ quantity: 1 })]);
    const { rerender } = render(<Probe state={lobby()} trade={first} />);
    await waitFor(() => expect(ipcMock.lobbyTradeOffer).toHaveBeenCalledTimes(1));
    rerender(<Probe state={lobby()} trade={trade([...first.lines, line({ side: "theirs" })])} />);
    rerender(<Probe state={lobby()} trade={trade([line({ quantity: 2 })])} />);
    await waitFor(() => expect(ipcMock.lobbyTradeOffer).toHaveBeenCalledTimes(2));
  });

  it("waits for a guest's host, and sends nothing for another trade or an agreed deal", async () => {
    const mine = trade([line({})]);
    const { rerender } = render(
      <Probe state={lobby({ role: "guest", hostOnline: false })} trade={mine} />,
    );
    rerender(<Probe state={lobby()} trade={{ ...mine, id: 8 }} />);
    rerender(<Probe state={lobby({ phase: "agreed" })} trade={mine} />);
    await act(async () => {});
    expect(ipcMock.lobbyTradeOffer).not.toHaveBeenCalled();
    rerender(<Probe state={lobby({ role: "guest", hostOnline: true })} trade={mine} />);
    await waitFor(() => expect(ipcMock.lobbyTradeOffer).toHaveBeenCalledTimes(1));
  });

  it("says why an offer was refused", async () => {
    ipcMock.lobbyTradeOffer.mockRejectedValue("There is no lobby open.");
    render(<Probe state={lobby()} trade={trade([line({})])} />);
    expect(await screen.findByText("There is no lobby open.")).toBeInTheDocument();
  });
});
