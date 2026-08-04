import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncOutcome, SyncStatus } from "@/lib/ipc";

const syncStatus = vi.hoisted(() => vi.fn());
const syncRun = vi.hoisted(() => vi.fn());
const onSyncProgress = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { syncStatus, syncRun, onSyncProgress, searchCards: vi.fn() },
}));

import { AppShell } from "./AppShell";
import { useAppStore } from "@/lib/store";

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  cardCount: 116_568,
  lastCheckAt: "1800000000",
  bulkUpdatedAt: "2026-08-03T21:16:27.869+00:00",
  lastError: null,
  lastIngestSkipped: 0,
  dataDir: "D:\\app\\data",
  syncing: false,
  ...over,
});

/** A promise this test settles by hand, standing in for a sync that takes minutes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing else awaits these, and an unsettled rejection would be an unhandled one.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

beforeEach(() => {
  useAppStore.setState({ activeView: "search" });
  syncStatus.mockReset().mockResolvedValue(status());
  syncRun.mockReset().mockResolvedValue({ updated: false, cardCount: 116_568, updatedAt: null });
  onSyncProgress.mockReset().mockResolvedValue(() => {});
});

it("renders nav and refresh button", async () => {
  render(
    <AppShell>
      <div>content</div>
    </AppShell>,
  );

  expect(screen.getByText("Search")).toBeInTheDocument();
  expect(screen.getByText("Collection")).toBeInTheDocument();
  expect(screen.getByText("Wishlist")).toBeInTheDocument();
  expect(screen.getByText("Decks")).toBeInTheDocument();
  expect(screen.getByText("Settings")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: /refresh/i })).toBeInTheDocument();
  expect(screen.getByText("content")).toBeInTheDocument();
});

describe("the status line", () => {
  it("counts the cards and dates the data", async () => {
    render(<AppShell>{null}</AppShell>);

    expect(await screen.findByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
  });

  it("says the database is empty rather than showing a zero", async () => {
    syncStatus.mockResolvedValue(status({ cardCount: 0, bulkUpdatedAt: null }));

    render(<AppShell>{null}</AppShell>);

    expect(await screen.findByText("No card data yet")).toBeInTheDocument();
  });

  /**
   * The data directory is chosen at startup and can silently be the AppData fallback
   * rather than the folder beside the exe; spec §3 wants that visible. Nothing else in
   * the window ever names a path.
   */
  it("names the live data directory as a tooltip", async () => {
    syncStatus.mockResolvedValue(status({ dataDir: "C:\\Users\\x\\AppData\\Roaming\\mtg\\data" }));

    render(<AppShell>{null}</AppShell>);

    expect(await screen.findByText(/116,568 cards/)).toHaveAttribute(
      "title",
      "C:\\Users\\x\\AppData\\Roaming\\mtg\\data",
    );
  });
});

describe("the Refresh button", () => {
  it("forces a sync and re-reads the status when the call finishes", async () => {
    const run = deferred<SyncOutcome>();
    syncRun.mockReturnValue(run.promise);
    render(<AppShell>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });
    await waitFor(() => expect(syncStatus).toHaveBeenCalled());
    const pollsBefore = syncStatus.mock.calls.length;

    await userEvent.click(button);

    expect(syncRun).toHaveBeenCalledWith(true);
    // Driven by the invoke promise, not by `sync:progress`: a run throttled by the 24 h
    // window returns without emitting a single event, and a spinner waiting for one
    // would never stop.
    expect(button).toBeDisabled();

    await act(async () => {
      run.resolve({ updated: true, cardCount: 116_600, updatedAt: null });
    });

    await waitFor(() => expect(button).toBeEnabled());
    await waitFor(() => expect(syncStatus.mock.calls.length).toBeGreaterThan(pollsBefore));
  });

  /**
   * The 304 outcome, which is what most Refreshes get: nothing downloads, nothing
   * ingests, and without a word from the UI the button simply spins and stops. Spec §4.5
   * asks for "already up to date" — the one case where saying nothing is indistinguishable
   * from failing.
   */
  it("says so when a Refresh finds nothing new", async () => {
    syncRun.mockResolvedValue({ updated: false, cardCount: 116_568, updatedAt: null });
    render(<AppShell>{null}</AppShell>);

    await userEvent.click(await screen.findByRole("button", { name: /refresh/i }));

    expect(await screen.findByText(/already up to date/i)).toBeInTheDocument();
  });

  it("stays quiet when the Refresh actually ingested something", async () => {
    syncRun.mockResolvedValue({ updated: true, cardCount: 116_600, updatedAt: null });
    render(<AppShell>{null}</AppShell>);

    await userEvent.click(await screen.findByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(syncRun).toHaveBeenCalled());
    expect(screen.queryByText(/already up to date/i)).not.toBeInTheDocument();
  });

  it("stays disabled while a sync started elsewhere is running", async () => {
    syncStatus.mockResolvedValue(status({ syncing: true }));

    render(<AppShell>{null}</AppShell>);

    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled());
    expect(syncRun).not.toHaveBeenCalled();
  });

  it("surfaces a rejected sync_run", async () => {
    syncRun.mockRejectedValue("sync already running");
    // Which is what "already running" means: the run it collided with is still going.
    syncStatus.mockResolvedValueOnce(status()).mockResolvedValue(status({ syncing: true }));
    render(<AppShell>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });

    await userEvent.click(button);

    expect(await screen.findByRole("alert")).toHaveTextContent("sync already running");
  });

  /**
   * A rejection is this session's account of one click. Once a poll reports that nothing
   * is running, that account is stale — and leaving it up would shadow whatever the
   * backend has since recorded in `lastError` for the rest of the session.
   */
  it("drops a stale rejection once nothing is running any more", async () => {
    syncRun.mockRejectedValue("sync already running");
    render(<AppShell>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });

    await userEvent.click(button);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("the error banner", () => {
  it("shows the failure the last run persisted", async () => {
    syncStatus.mockResolvedValue(status({ lastError: "rate limited by Scryfall" }));

    render(<AppShell>{null}</AppShell>);

    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited by Scryfall");
  });

  /**
   * A poll that could not read the database at all answers `null` for every
   * database-derived field, `lastError` included. Reading that as "the error is gone"
   * would clear a banner the user has not acknowledged, and blank the card count with it.
   * (An ingest no longer produces this — `sync::status` reads through `db_read` — but an
   * unusable read connection still can.)
   */
  it("survives a poll that could read nothing", async () => {
    syncStatus.mockResolvedValueOnce(status({ lastError: "rate limited by Scryfall" }));
    syncStatus.mockResolvedValue({
      cardCount: null,
      lastCheckAt: null,
      bulkUpdatedAt: null,
      lastError: null,
      lastIngestSkipped: null,
      dataDir: "D:\\app\\data",
      syncing: true,
    });
    render(<AppShell>{null}</AppShell>);
    const button = await screen.findByRole("button", { name: /refresh/i });
    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited by Scryfall");

    // Forces the second, blind poll to land.
    await userEvent.click(button);

    await waitFor(() => expect(syncStatus.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByRole("alert")).toHaveTextContent("rate limited by Scryfall");
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toBeInTheDocument();
  });
});

/**
 * The overlay covers the header, so its Retry is the only control the user can reach on
 * a first run that failed. It has to reach the same forced sync the header's button does.
 */
it("retries the first run from inside the overlay", async () => {
  syncStatus.mockResolvedValue(
    status({ cardCount: 0, bulkUpdatedAt: null, lastError: "rate limited by Scryfall" }),
  );
  render(<AppShell>{null}</AppShell>);

  await userEvent.click(await screen.findByRole("button", { name: /retry/i }));

  expect(syncRun).toHaveBeenCalledWith(true);
});

it("switches the active view", async () => {
  render(<AppShell>{null}</AppShell>);

  await userEvent.click(screen.getByRole("button", { name: "Decks" }));

  expect(useAppStore.getState().activeView).toBe("decks");
  expect(screen.getByRole("button", { name: "Decks" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-current");
});
