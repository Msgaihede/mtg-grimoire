import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { emitFake } from "@grimoire/fake/event";
import type { CommandTable } from "@grimoire/fake/scope";
import type { RelayOutcome, SearchResponse, SyncProgressEvent, SyncStatus } from "@grimoire/ui/lib/ipc";
import { PhoneFace } from "./PhoneApp";
import { installLayout, renderPhone } from "./testing";

beforeAll(installLayout);

/** Long enough for a fake round trip and one status poll (a second, while a sync runs). */
const SETTLE = { timeout: 3000 };

/**
 * A first run, held where the test wants it: the wall's search answers nothing while `corpus` is
 * `false` and the fake's own page once it is true, and `sync_status` says an empty database with a
 * sync in flight while `status` is `"syncing"` — so the backend can be moved one half at a time.
 */
function firstRun() {
  const world = { corpus: false, status: "syncing" as "syncing" | "done" };
  const commands = (own: CommandTable): CommandTable => {
    const search = own.search_cards as (a: unknown) => SearchResponse;
    const status = own.sync_status as () => SyncStatus;
    return {
      search_cards: (args: unknown) =>
        world.corpus ? search(args) : { items: [], total: 0, totalIsCapped: false },
      sync_status: () =>
        world.status === "syncing" ? { ...status(), cardCount: 0, syncing: true } : status(),
    };
  };
  return { world, commands };
}

const progress = (phase: SyncProgressEvent["phase"], done = 0, total = 0) =>
  act(() => emitFake<SyncProgressEvent>("sync:progress", { phase, done, total, message: null }));

const wallTiles = () =>
  within(screen.getByRole("list", { name: "Search results" })).queryAllByRole("button");

describe("the phone face over a first card sync", () => {
  it("says the database is being set up, not that no cards match, and shows the phase", async () => {
    const { commands } = firstRun();
    renderPhone(<PhoneFace />, { path: "/search", commands });

    // Before any event: the status poll alone says a sync is running.
    expect(
      await screen.findByText("Setting up your card database", undefined, SETTLE),
    ).toBeVisible();
    expect(screen.queryByText("No cards match.")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Syncing card data");

    progress("downloading", 31_000_000, 77_000_000);

    expect(screen.getByRole("status")).toHaveTextContent("Downloading card data");
    expect(screen.getByText("31 / 77 MB")).toBeInTheDocument();
    // The frame's mana line is the bar, named for the phase and filled to its fraction.
    const bar = screen.getByRole("progressbar", { name: "Downloading card data" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
  });

  it("refills the wall when the sync's done event arrives", async () => {
    const { world, commands } = firstRun();
    renderPhone(<PhoneFace />, { path: "/search", commands });
    await screen.findByText("Setting up your card database", undefined, SETTLE);
    progress("ingesting", 50_000, 117_000);

    // The corpus lands — but the status still says syncing, so only the event can refresh.
    world.corpus = true;
    progress("done", 0, 0);

    await waitFor(() => expect(wallTiles().length).toBeGreaterThan(0), SETTLE);
    expect(screen.queryByText("Setting up your card database")).toBeNull();
  });

  it("refills the wall when the count leaves zero, for a done event that was never heard", async () => {
    const { world, commands } = firstRun();
    renderPhone(<PhoneFace />, { path: "/search", commands });
    await screen.findByText("Setting up your card database", undefined, SETTLE);

    // No event at all — the page attached after the run emitted its last one.
    world.corpus = true;
    world.status = "done";

    await waitFor(() => expect(wallTiles().length).toBeGreaterThan(0), SETTLE);
    // And the line is at rest again: nothing is running.
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says there is no card data, rather than no match, over an empty database with nothing running", async () => {
    renderPhone(<PhoneFace />, { path: "/search", fake: { seed: "empty" } });

    expect(await screen.findByText(/No card data yet/, undefined, SETTLE)).toBeVisible();
    expect(screen.queryByText("No cards match.")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

/** One round trip with the reader's other devices, as `sync:applied` carries it. */
const trip = (over: Partial<RelayOutcome>): RelayOutcome => ({
  pushed: 0,
  pulled: 0,
  unreadable: 0,
  applied: 0,
  resurrected: 0,
  cyclesBroken: 0,
  skipped: 0,
  deferred: 0,
  heldNewer: 0,
  dropped: 0,
  moot: 0,
  changed: false,
  baselineOps: 0,
  baselineHistory: 0,
  pullPages: 1,
  pullWhole: false,
  ...over,
});

const applied = (over: Partial<RelayOutcome>) =>
  act(() => emitFake<RelayOutcome>("sync:applied", trip(over)));

/**
 * **A sync that applied refreshes the phone face** — phase 6, step 6.4. The desktop's shell mounts
 * `useDeviceSyncInvalidation`; this face has no such shell, and until it mounted the listener
 * itself a change another device made sat in the database under a wall still drawing the rows as
 * they were.
 *
 * The page is the wishlist with **Settings closed**: the listener is the face's, not the Sync
 * panel's. What "another device's change" is here is the fake's own `wishlist_clear`, called on
 * the world's table and not through the page — a write this face did not make and so settles no
 * query for, which is exactly what a pulled op is.
 */
describe("the phone face over a device sync", () => {
  const solRing = () => screen.queryByRole("button", { name: "Sol Ring, any printing" });

  async function wishlistOverAWorld() {
    let table: CommandTable = {};
    renderPhone(<PhoneFace />, {
      path: "/wishlist",
      commands: (own) => {
        table = own;
        return {};
      },
    });
    await screen.findByRole("button", { name: "Sol Ring, any printing" }, SETTLE);
    return { pulled: () => (table.wishlist_clear as () => number)() };
  }

  it("refetches the list on screen when a trip changed rows here", async () => {
    const world = await wishlistOverAWorld();

    world.pulled();
    // Nothing has told the page: its answer is fresh for `query.ts`'s half minute.
    expect(solRing()).not.toBeNull();

    applied({ pulled: 13, applied: 13, changed: true });

    await waitFor(() => expect(solRing()).toBeNull(), SETTLE);
  });

  it("leaves the lists alone for a trip that only pushed", async () => {
    const world = await wishlistOverAWorld();
    world.pulled();

    applied({ pushed: 4, changed: false });
    // Long enough for a refetch to have landed, had one been asked for: the one above does
    // inside this.
    await new Promise((settled) => setTimeout(settled, 300));
    expect(solRing()).not.toBeNull();

    // And the same listener still refreshes on the trip that did change something.
    applied({ pulled: 1, applied: 1, changed: true });
    await waitFor(() => expect(solRing()).toBeNull(), SETTLE);
  });
});
