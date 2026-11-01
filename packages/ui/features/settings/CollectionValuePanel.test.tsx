import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COLLECTION_VALUE } from "@/lib/collectionValue";

const collectionValue = vi.hoisted(() => vi.fn());
const setCollectionValue = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionValue,
    setCollectionValue,
    collectionSummary,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { CollectionValuePanel } from "./CollectionValuePanel";

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const SUMMARY = {
  totalCards: 998,
  uniqueCards: 735,
  entries: 800,
  tradelistCards: 0,
  value: 6247.11,
  unpriced: 12,
  needsReview: 0,
};

const sell = () => screen.getByRole("textbox", { name: /Sell percentage/ });
const minimum = () => screen.getByRole("textbox", { name: /Minimum card value/ });

describe("CollectionValuePanel", () => {
  beforeEach(() => {
    collectionValue.mockReset().mockResolvedValue(DEFAULT_COLLECTION_VALUE);
    setCollectionValue.mockReset().mockResolvedValue(undefined);
    collectionSummary.mockReset().mockResolvedValue(SUMMARY);
  });

  it("says nothing is set, with no reduced price and empty boxes", async () => {
    render(wrap(<CollectionValuePanel />));
    expect(screen.getByRole("region", { name: "Collection value" })).toBeInTheDocument();
    expect(await screen.findByText(/only full values are shown/)).toBeInTheDocument();
    expect(sell()).toHaveValue("");
    expect(minimum()).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("breaks the collection down under stored settings", async () => {
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0.5 });
    collectionSummary.mockResolvedValue({
      ...SUMMARY,
      belowMinimum: { cards: 466, value: 58.84 },
    });
    render(wrap(<CollectionValuePanel />));
    expect(await screen.findByText("Under $0.50 · 466 cards")).toBeInTheDocument();
    expect(screen.getByText("Sell at 70%")).toBeInTheDocument();
    expect(screen.getByText("−$1,856.48")).toBeInTheDocument();
    await waitFor(() => expect(sell()).toHaveValue("70"));
    expect(minimum()).toHaveValue("0.50");
    expect(collectionSummary).toHaveBeenLastCalledWith(expect.objectContaining({ minimumValue: 0.5 }));
  });

  it("stores a box when it is left, keeping the other figure", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(sell(), "70");
    await user.tab();
    await waitFor(() =>
      expect(setCollectionValue).toHaveBeenCalledWith({ sellPercent: 70, minimumValue: 0 }),
    );
  });

  it("refuses a percentage out of bounds in words and stores nothing", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(sell(), "120{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/above 0 and at most 100/);
    expect(setCollectionValue).not.toHaveBeenCalled();
  });

  it("puts both figures back on Reset", async () => {
    const user = userEvent.setup();
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0 });
    render(wrap(<CollectionValuePanel />));
    await user.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(setCollectionValue).toHaveBeenCalledWith(DEFAULT_COLLECTION_VALUE),
    );
  });
});
