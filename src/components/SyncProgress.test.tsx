import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";
import { SyncProgress } from "./SyncProgress";

// No IPC mock and no listener harness: the component takes the latest event as a prop
// now. `AppShell` owns the one subscription, and `useSyncProgress.test.ts` covers it.
const onRetry = vi.fn();

beforeEach(() => {
  onRetry.mockClear();
});

type Props = Parameters<typeof SyncProgress>[0];
const show = (over: Partial<Props> = {}) =>
  render(
    <SyncProgress
      progress={null}
      cardCount={116_568}
      error={null}
      busy={false}
      onRetry={onRetry}
      {...over}
    />,
  );

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "downloading",
  done: 5,
  total: 10,
  message: null,
  ...over,
});

describe("the first-run variant", () => {
  it("takes over the screen when the database is empty", () => {
    show({
      cardCount: 0,
      busy: true,
      progress: event({ phase: "ingesting", done: 58_500, total: 117_000 }),
    });

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

  /** A finished run means the database is filling; the overlay gets out of the way. */
  it("steps aside once the run reports it is done", () => {
    const { container } = show({
      cardCount: 0,
      busy: false,
      progress: event({ phase: "done", done: 116_568, total: 116_568 }),
    });

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * `null` is "the count could not be read, ask again", not "zero cards" — taking over
   * the screen for it would hide a perfectly good 116 k-card collection.
   */
  it("does not mistake an unreadable count for an empty database", () => {
    const { container } = show({
      cardCount: null,
      busy: true,
      progress: event({ phase: "ingesting", done: 1, total: 117_000 }),
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // An unreadable count is not an empty database, so this renders nothing at all — the
    // ribbon's mana line is what reports the run.
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The recovery path the overlay used to swallow: it covers the ribbon, so the Refresh
   * button underneath is unreachable and the way out has to be *inside*.
   */
  describe("recovery", () => {
    it("offers Retry when a failure only ever reached the database", async () => {
      // No event at all: the startup sync failed before the webview registered a
      // listener, which is exactly the case `lastError` is persisted for.
      show({ cardCount: 0, busy: false, error: "rate limited by Scryfall" });

      expect(screen.getByText(/rate limited by Scryfall/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("offers Retry when the failure arrived as an event", async () => {
      // Still `busy`: the status poll is up to a second behind the event, and a failure
      // must not sit hidden behind a progress bar for that second.
      show({
        cardCount: 0,
        busy: true,
        progress: event({ phase: "error", done: 0, total: 0, message: "no internet connection" }),
      });

      expect(screen.getByText(/no internet connection/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    /**
     * A run inside the 24 h check window emits nothing and returns nothing to see. With
     * an empty database that would leave a modal over an app that never fills itself.
     */
    it("offers Retry when nothing is running and nothing has been said", () => {
      show({ cardCount: 0, busy: false });

      expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });
});
