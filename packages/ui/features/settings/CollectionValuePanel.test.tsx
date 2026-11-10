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
const bulk = () => screen.getByRole("textbox", { name: /Bulk price/ });

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
    expect(bulk()).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("breaks the collection down under stored settings", async () => {
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0.5, bulkPrice: 0 });
    collectionSummary.mockResolvedValue({
      ...SUMMARY,
      belowMinimum: { cards: 466, value: 58.84 },
    });
    render(wrap(<CollectionValuePanel />));
    expect(await screen.findByText("Under $0.50 · 466 cards")).toBeInTheDocument();
    expect(screen.getByText("Sell at 70%")).toBeInTheDocument();
    expect(screen.getByText("−$1,856.48")).toBeInTheDocument();
    expect(screen.queryByText(/^Bulk at/)).toBeNull();
    await waitFor(() => expect(sell()).toHaveValue("70"));
    expect(minimum()).toHaveValue("0.50");
    expect(collectionSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimumValue: 0.5 }),
    );
  });

  it("stores a box when it is left, keeping the other figure", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(sell(), "70");
    await user.tab();
    await waitFor(() =>
      expect(setCollectionValue).toHaveBeenCalledWith({
        sellPercent: 70,
        minimumValue: 0,
        bulkPrice: 0,
      }),
    );
  });

  /** Issue #1477: a bulk price prices the cards under the minimum, so it waits for one. */
  it("greys the bulk price until a minimum is set, then stores it", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    expect(bulk()).toHaveAttribute("aria-disabled", "true");
    await user.type(minimum(), "1{Enter}");
    await waitFor(() => expect(bulk()).not.toHaveAttribute("aria-disabled"));
    await user.type(bulk(), "0.01{Enter}");
    await waitFor(() =>
      expect(setCollectionValue).toHaveBeenLastCalledWith({
        sellPercent: 100,
        minimumValue: 1,
        bulkPrice: 0.01,
      }),
    );
  });

  it("states the bulk price in the breakdown, after the percentage", async () => {
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0.5, bulkPrice: 0.01 });
    collectionSummary.mockResolvedValue({
      ...SUMMARY,
      belowMinimum: { cards: 466, value: 58.84 },
    });
    render(wrap(<CollectionValuePanel />));
    expect(await screen.findByText("Bulk at $0.01 · 466 cards")).toBeInTheDocument();
    expect(screen.getByText("+$4.66")).toBeInTheDocument();
    expect(screen.getAllByText("$4,336.45").length).toBeGreaterThan(0);
    await waitFor(() => expect(bulk()).toHaveValue("0.01"));
  });

  /** A row from before the bulk price reads with none — the crate's `#[serde(default)]`. */
  it("reads settings without a bulk price as none", async () => {
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 0.5 });
    render(wrap(<CollectionValuePanel />));
    await waitFor(() => expect(minimum()).toHaveValue("0.50"));
    expect(bulk()).toHaveValue("");
    expect(bulk()).not.toHaveAttribute("aria-disabled");
  });

  it("refuses a bulk price it cannot read and stores nothing", async () => {
    const user = userEvent.setup();
    collectionValue.mockResolvedValue({ sellPercent: 100, minimumValue: 1, bulkPrice: 0 });
    render(wrap(<CollectionValuePanel />));
    await waitFor(() => expect(bulk()).not.toHaveAttribute("aria-disabled"));
    await user.type(bulk(), "cheap{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Bulk price has to be a price");
    expect(setCollectionValue).not.toHaveBeenCalled();
  });

  it("refuses a percentage out of bounds in words and stores nothing", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(sell(), "120{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/above 0 and at most 100/);
    expect(setCollectionValue).not.toHaveBeenCalled();
  });

  /** Issue #1589: a refusal is the refused box's, and stays while its draft does. */
  it("keeps a refused box's sentence and draft when another box is stored", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(sell(), "150");
    await user.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(/above 0 and at most 100/);
    await user.type(minimum(), "1");
    await user.tab();
    await waitFor(() =>
      expect(setCollectionValue).toHaveBeenCalledWith({
        sellPercent: 100,
        minimumValue: 1,
        bulkPrice: 0,
      }),
    );
    expect(sell()).toHaveValue("150");
    expect(screen.getByRole("alert")).toHaveTextContent(/above 0 and at most 100/);
  });

  /** Issue #1589: the box is one node for its whole life, so Enter keeps the caret in it. */
  it("keeps focus in the box after Enter stores it", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    const before = sell();
    await user.type(before, "70{Enter}");
    await waitFor(() => expect(setCollectionValue).toHaveBeenCalled());
    expect(sell()).toBe(before);
    expect(before).toHaveFocus();
  });

  /** Issue #1589: greyed with `aria-disabled`, Bulk stays in the tab order. */
  it("tabs from the minimum to the bulk price as the minimum wakes it", async () => {
    const user = userEvent.setup();
    render(wrap(<CollectionValuePanel />));
    await screen.findByText(/only full values are shown/);
    await user.type(minimum(), "0.50");
    await user.tab();
    expect(bulk()).toHaveFocus();
    await waitFor(() => expect(bulk()).not.toHaveAttribute("aria-disabled"));
    expect(minimum()).toHaveValue("0.50");
  });

  it("puts every figure back on Reset", async () => {
    const user = userEvent.setup();
    collectionValue.mockResolvedValue({ sellPercent: 70, minimumValue: 1, bulkPrice: 0.01 });
    render(wrap(<CollectionValuePanel />));
    await user.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() => expect(setCollectionValue).toHaveBeenCalledWith(DEFAULT_COLLECTION_VALUE));
  });
});
