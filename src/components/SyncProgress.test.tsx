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
    // The app's one progress bar, on the one screen that used to have a second one. The
    // name is the phase, which is `syncActivity`'s wording rather than this file's — the
    // same fold the ribbon's line is given.
    expect(screen.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  /**
   * The app's mark, drawn once, at the one size that draws all of it.
   *
   * `GrimoireMark` picks its variant off the pixel size it is given — under 24px it drops
   * the casting circle, the runes and the diamond's gradient, because at that size they
   * fill in — so a size change here would silently ship the *simplified* mark on the one
   * screen with room for the whole thing, and nothing about the markup would look wrong.
   * The `<defs>` gradient is the tell that separates the two variants, so that is what is
   * asserted rather than the number: the small one fills the diamond flat and ships no
   * `<defs>` at all, because at title-bar size that diamond is about four pixels across —
   * no room for three stops, and a gradient there would cost a per-instance id for nothing.
   *
   * `querySelector` rather than a role query is the point of the second half — the mark is
   * `aria-hidden`, so there is nothing in the accessibility tree to query *for*, and that
   * is the assertion. It carries no `label`: the wordmark under it is already hidden, and
   * the dialog is named by `#first-run-title`, so a named mark would be this app's name
   * announced twice in a row.
   */
  it("draws the full mark above the wordmark and keeps it out of the accessibility tree", () => {
    const { container } = show({ cardCount: 0, busy: true });

    const mark = container.querySelector("svg");
    expect(mark).toBeInTheDocument();
    expect(mark?.querySelector("linearGradient")).toBeInTheDocument();
    expect(mark).toHaveAttribute("aria-hidden", "true");
    // One box, and that is the pairing: the page's `gap-6` is the distance between the
    // things on this screen, and it is too much between an emblem and its own caption — so
    // the two are nested in a column of their own. Pulling them apart restores the gap.
    expect(mark?.parentElement).toContainElement(screen.getByText("MTG Grimoire"));
    // The claim stated the way the platform states it: one name for this screen, and it is
    // the heading's. A `label` on the mark would add a second graphic beside it saying the
    // same words.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Setting up your card database");
  });

  /**
   * And it is part of the takeover rather than part of the app: every sync after the first
   * is the ribbon's mana line, and a mark left behind by a branch that only checked the
   * dialog would be a 64px emblem floating over a working collection.
   */
  it("draws no mark once there is a database behind it", () => {
    const { container } = show({
      progress: event({ phase: "ingesting", done: 58_500, total: 117_000 }),
      busy: true,
    });

    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });

  /**
   * `sync_run` refuses a second concurrent run, so a button offering one while the first
   * is downloading is a control that cannot do anything. It comes back the moment nothing
   * is running, which is the only state it is any use in.
   */
  it("keeps Retry off the screen while the download is running", () => {
    show({ cardCount: 0, busy: true, progress: event({ phase: "downloading" }) });

    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("waits for the first sync even before any event arrives", () => {
    show({ cardCount: 0, busy: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // The generic sentence, and the ribbon's own: a run this window has only heard *about*
    // has no phase to name.
    expect(screen.getByText("Syncing card data")).toBeInTheDocument();
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

    /**
     * The press has to answer for itself, and the failure it was pressed over has to go.
     *
     * A `sync:progress` error is the last thing this window heard and stays the last thing
     * until a new run says something — so without the dismissal this screen would go on
     * reporting a run the reader replaced, with the button as the only thing that moved.
     */
    it("replaces the failure it was pressed over with the run it asked for", async () => {
      show({
        cardCount: 0,
        busy: true,
        progress: event({ phase: "error", done: 0, total: 0, message: "no internet connection" }),
      });

      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/no internet connection/i)).not.toBeInTheDocument();
      // The generic sentence and a line with no denominator: a run nobody has heard from yet.
      expect(screen.getByRole("progressbar", { name: "Syncing card data" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    });

    /**
     * …and a *new* failure is never the dismissed one, so it lands. The identity of the
     * event is what carries this: holding a "retrying" flag instead would swallow the
     * second failure for as long as the flag stood.
     */
    it("reports a fresh failure after a retry", async () => {
      const { rerender } = show({
        cardCount: 0,
        busy: true,
        progress: event({ phase: "error", message: "no internet connection" }),
      });
      await userEvent.click(screen.getByRole("button", { name: /retry/i }));

      rerender(
        <SyncProgress
          cardCount={0}
          busy={false}
          progress={event({ phase: "error", message: "rate limited by Scryfall" })}
          error={null}
          onRetry={onRetry}
        />,
      );

      expect(screen.getByText(/rate limited by Scryfall/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
    });
  });
});
