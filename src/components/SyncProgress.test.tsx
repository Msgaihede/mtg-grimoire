import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const onRetry = vi.fn();

beforeEach(() => {
  unlisten.mockClear();
  onRetry.mockClear();
  onSyncProgress.mockReset();
  onSyncProgress.mockImplementation((cb: (e: SyncProgressEvent) => void) => {
    emit = (e) => act(() => cb(e));
    return Promise.resolve(unlisten);
  });
});

type Props = Parameters<typeof SyncProgress>[0];
const show = (over: Partial<Props> = {}) =>
  render(
    <SyncProgress cardCount={116_568} error={null} busy={false} onRetry={onRetry} {...over} />,
  );

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "downloading",
  done: 5,
  total: 10,
  message: null,
  ...over,
});

/** The listener is registered asynchronously; nothing can be emitted before it lands. */
const listening = () => vi.waitFor(() => expect(onSyncProgress).toHaveBeenCalled());

describe("the first-run variant", () => {
  it("takes over the screen when the database is empty", async () => {
    show({ cardCount: 0, busy: true });
    await listening();

    emit(event({ phase: "ingesting", done: 58_500, total: 117_000 }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/setting up your card database/i)).toBeInTheDocument();
    expect(screen.getByText(/importing cards/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDisabled();
  });

  it("waits for the first sync even before any event arrives", () => {
    show({ cardCount: 0, busy: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/starting/i)).toBeInTheDocument();
  });

  /**
   * `null` is "the count could not be read, ask again", not "zero cards" — taking over
   * the screen for it would hide a perfectly good 116 k-card collection.
   */
  it("does not mistake an unreadable count for an empty database", async () => {
    const { container } = show({ cardCount: null, busy: true });
    await listening();

    emit(event({ phase: "ingesting", done: 1, total: 117_000 }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // An unreadable count is not an empty database, so this renders nothing at all — the
    // ribbon's mana line is what reports the run.
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The recovery path the overlay used to swallow: it covers the header, so the Refresh
   * button underneath is unreachable and the way out has to be *inside*.
   */
  describe("recovery", () => {
    it("offers Retry when a failure only ever reached the database", async () => {
      // No event at all: the startup sync failed before the webview registered a
      // listener, which is exactly the case `lastError` is persisted for.
      show({ cardCount: 0, busy: false, error: "rate limited by Scryfall" });
      await listening();

      expect(screen.getByText(/rate limited by Scryfall/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("offers Retry when the failure arrived as an event", async () => {
      show({ cardCount: 0, busy: true });
      await listening();

      // Still `busy`: the status poll is up to a second behind the event, and a failure
      // must not sit hidden behind a progress bar for that second.
      emit(event({ phase: "error", done: 0, total: 0, message: "no internet connection" }));

      expect(screen.getByText(/no internet connection/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    /**
     * A run inside the 24 h check window emits nothing and returns nothing to see. With
     * an empty database that would leave a modal over an app that never fills itself.
     */
    it("offers Retry when nothing is running and nothing has been said", async () => {
      show({ cardCount: 0, busy: false });
      await listening();

      expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });
});

it("stops listening when it unmounts", async () => {
  const view = show();
  await listening();

  view.unmount();

  expect(unlisten).toHaveBeenCalled();
});
