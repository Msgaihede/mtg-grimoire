import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const syncStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncStatus,
    syncRun: vi.fn(),
    onSyncProgress: vi.fn().mockResolvedValue(() => {}),
    // The search view is live now, so opening on it fires a real query; an unresolved
    // mock would surface here as a query error rather than as the routing this file tests.
    searchCards: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  },
}));

import App from "./App";
import { useAppStore } from "@/lib/store";

beforeEach(() => {
  useAppStore.setState({ activeView: "search" });
  syncStatus.mockReset().mockResolvedValue({
    cardCount: 116_568,
    lastCheckAt: "1800000000",
    bulkUpdatedAt: "2026-08-03T21:16:27.869+00:00",
    lastError: null,
    dataDir: "D:\\app\\data",
    syncing: false,
  });
});

it("opens on the search view", async () => {
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Card search", level: 2 })).toBeInTheDocument();
});

it("swaps the main pane when a sidebar entry is picked", async () => {
  render(<App />);

  await userEvent.click(screen.getByRole("button", { name: "Wishlist" }));

  expect(screen.getByRole("heading", { name: "Wishlist", level: 2 })).toBeInTheDocument();
  expect(screen.getByText(/coming in a later plan/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Card search" })).not.toBeInTheDocument();
});
