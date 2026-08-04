import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";

const onSyncProgress = vi.hoisted(() => vi.fn());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { onSyncProgress, syncStatus: vi.fn(), syncRun: vi.fn(), searchCards: vi.fn() },
}));

import { SyncProgress } from "./SyncProgress";

/** Pushes one `sync:progress` event through the listener the component registered. */
let emit: (e: SyncProgressEvent) => void;

beforeEach(() => {
  unlisten.mockClear();
  onSyncProgress.mockReset();
  onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return Promise.resolve(unlisten);
  });
});

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "downloading",
  done: 5,
  total: 10,
  message: null,
  ...over,
});

describe("the slim variant", () => {
  it("shows nothing until an event arrives", () => {
    const { container } = render(<SyncProgress cardCount={116_568} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("names the phase and reports how far along it is", async () => {
    render(<SyncProgress cardCount={116_568} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "downloading", done: 5, total: 10 }));

    expect(screen.getByText(/downloading card data/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  });

  it("goes away once the run is done", async () => {
    render(<SyncProgress cardCount={116_568} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "ingesting", done: 1000, total: 117_000 }));
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    emit(event({ phase: "done", done: 116_568, total: 116_568 }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /** The header's error banner owns failures; a second copy in the bar would duplicate it. */
  it("leaves errors to the header", async () => {
    render(<SyncProgress cardCount={116_568} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "error", done: 0, total: 0, message: "rate limited by Scryfall" }));

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/rate limited/i)).not.toBeInTheDocument();
  });
});

describe("the first-run variant", () => {
  it("takes over the screen when the database is empty", async () => {
    render(<SyncProgress cardCount={0} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "ingesting", done: 58_500, total: 117_000 }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/setting up your card database/i)).toBeInTheDocument();
    expect(screen.getByText(/importing cards/i)).toBeInTheDocument();
  });

  it("waits for the first sync even before any event arrives", () => {
    render(<SyncProgress cardCount={0} />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  /**
   * `null` is "the database was busy, ask again", not "zero cards" — taking over the
   * screen for it would hide a perfectly good 116 k-card collection during every sync.
   */
  it("does not mistake an unreadable count for an empty database", async () => {
    render(<SyncProgress cardCount={null} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "ingesting", done: 1, total: 117_000 }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("reports a failed first run instead of spinning forever", async () => {
    render(<SyncProgress cardCount={0} />);
    await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

    emit(event({ phase: "error", done: 0, total: 0, message: "no internet connection" }));

    expect(screen.getByText(/no internet connection/i)).toBeInTheDocument();
  });
});

it("stops listening when it unmounts", async () => {
  const view = render(<SyncProgress cardCount={116_568} />);
  await vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

  view.unmount();

  expect(unlisten).toHaveBeenCalled();
});
