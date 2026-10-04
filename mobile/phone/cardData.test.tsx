import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { emitFake } from "../../.storybook/fake/event";
import type { CommandTable } from "../../.storybook/fake/scope";
import type { SearchResponse, SyncProgressEvent, SyncStatus } from "@/lib/ipc";
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
