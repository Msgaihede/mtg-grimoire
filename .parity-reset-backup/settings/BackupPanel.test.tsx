import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MirrorStatus } from "@/lib/ipc";

const mirrorStatus = vi.hoisted(() => vi.fn());
const mirrorSetEnabled = vi.hoisted(() => vi.fn());
const mirrorSetRoot = vi.hoisted(() => vi.fn());
const mirrorRebuild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { mirrorStatus, mirrorSetEnabled, mirrorSetRoot, mirrorRebuild },
}));

/** The one control here the operating system owns. `open()` reaches Tauri's `invoke`, which
 *  jsdom has nothing behind — so the module is mocked, exactly as the four other suites that
 *  touch a picker do it (`DeckCoverPicker`, `CreateDeckDialog`, `DeckSettingsDialog`,
 *  `ImportDialog`). */
const pickFolder = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickFolder }));

import { BackupPanel, MIRROR_KEY, lastPassLine, passSummary } from "./BackupPanel";

/** A fixed instant every "2 hours ago" below is read against, so the sentence is a fact rather
 *  than a race against the clock. */
const NOW = Math.floor(Date.now() / 1000);

/** The default root — `data/export`, beside the database, which is where the mirror writes
 *  until somebody moves it. Backslashes because this app only ships on Windows. */
const ROOT = "D:\\app\\data\\export";

/** A mirror that has run: the numbers the spec's own example quotes. */
const RAN: MirrorStatus = {
  enabled: true,
  root: ROOT,
  lastRunAt: String(NOW - 7_200),
  lastReport: { written: 142, unchanged: 208, skipped: 0, pruned: 0, failed: 0 },
  lastError: null,
};

/** A fresh app. `lastRunAt` is `null` and `lastReport` with it — the state the panel must not
 *  draw as "0 files written", which would claim a pass happened and wrote nothing. */
const NO_PASS_YET: MirrorStatus = {
  enabled: true,
  root: ROOT,
  lastRunAt: null,
  lastReport: null,
  lastError: null,
};

/** The stick that was unplugged. The pass records the reason and blocks nothing: the database
 *  is still being written, and the next pass tries again. */
const UNWRITABLE: MirrorStatus = {
  enabled: true,
  root: "E:\\Backups\\MTG",
  lastRunAt: String(NOW - 300),
  lastReport: { written: 0, unchanged: 0, skipped: 0, pruned: 0, failed: 350 },
  lastError: 'The folder "E:\\Backups\\MTG" is not there.',
};

/**
 * One world, as a wrapper.
 *
 * The status is **seeded into the client** rather than stubbed onto the mock, which is what
 * lets three worlds stand side by side in one file: a mock is one function and every test in
 * the file shares it, where a client belongs to the tree it was rendered in. `staleTime:
 * Infinity` is what stops the seeded answer being refetched out from under the first assertion.
 *
 * What that costs is that none of the three proves the panel ever *asks* — so {@link LiveWorld}
 * below hands it an empty cache, and "reads the mirror's state from the backend" is where that
 * wiring is checked.
 */
function harness(status: MirrorStatus) {
  return function Harness({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const c = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      c.setQueryData(MIRROR_KEY, status);
      return c;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const wrapper = harness(RAN);
const wrapperWithNoPassYet = harness(NO_PASS_YET);
const wrapperWithMirrorError = harness(UNWRITABLE);

/** A world whose read is genuinely in flight — no seed, so the panel asks the backend. */
function LiveWorld({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const panel = () => screen.getByRole("region", { name: "Backup" });

beforeEach(() => {
  mirrorStatus.mockReset().mockResolvedValue(RAN);
  mirrorSetEnabled.mockReset().mockResolvedValue(undefined);
  mirrorSetRoot.mockReset().mockResolvedValue(undefined);
  mirrorRebuild.mockReset().mockResolvedValue({
    written: 350,
    unchanged: 0,
    skipped: 0,
    pruned: 2,
    failed: 0,
  });
  pickFolder.mockReset().mockResolvedValue(null);
});

describe("BackupPanel", () => {
  it("says where the mirror writes, and offers to move it", async () => {
    render(<BackupPanel />, { wrapper });

    expect(await screen.findByText(/D:[\\/]app[\\/]data[\\/]export/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change folder/i })).toBeEnabled();
  });

  it("shows the last pass rather than claiming one happened", async () => {
    // A fresh app has run no pass; the panel must not print "0 files written" as if it had.
    render(<BackupPanel />, { wrapper: wrapperWithNoPassYet });

    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument();
  });

  /**
   * **The backend's own sentence, under the panel's framing, in the panel's error channel.**
   *
   * This asserted `/could not/i` against the whole region until 2026-08-25, and that could not
   * fail: `passSummary` emits "350 could not be written" for any ordinary pass that dropped
   * files, so the match was satisfied by the status line and the whole `lastError` arm could be
   * deleted with the test still green. The guard below is the other half — a report with
   * failures and *no* `lastError` must draw no alert at all.
   */
  it("shows the sentence when the last pass could not write", async () => {
    render(<BackupPanel />, { wrapper: wrapperWithMirrorError });

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      'The last backup could not be written. The folder "E:\\Backups\\MTG" is not there.',
    );
  });

  /** The guard on the test above, and the reason it is not a substring match any more: a pass
   *  that ran and dropped files is **not** a pass that could not run, and only the second is
   *  news this panel raises. */
  it("does not mistake a pass that dropped files for a pass that could not run", async () => {
    render(<BackupPanel />, { wrapper: harness({ ...UNWRITABLE, lastError: null }) });

    // The failures are still reported — in the status line, where they belong.
    expect(await screen.findByText(/350 could not be written/)).toBeInTheDocument();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * **A successful rebuild must not silence the panel.**
   *
   * A TanStack mutation stays `isSuccess` for the life of the component, so a note ranked above
   * the backend's own state would be drawn from the first press until the reader navigated away
   * — the panel showing "Rebuilt — 350 files written" while the mirror quietly stopped working.
   * That shipped for one review round and is what `errorOutranks` exists for.
   *
   * Driven through {@link LiveWorld} rather than a seeded client, because the point is a
   * *second* status arriving: the first read answers a healthy mirror, and every read after the
   * rebuild answers a background pass that failed **later** than it.
   */
  it("still reports a background failure after a rebuild has succeeded", async () => {
    const user = userEvent.setup();
    const failedLater = { ...UNWRITABLE, lastRunAt: String(NOW + 600) };
    mirrorStatus.mockReset().mockResolvedValueOnce(RAN).mockResolvedValue(failedLater);
    render(<BackupPanel />, { wrapper: LiveWorld });

    await user.click(await screen.findByRole("button", { name: /rebuild now/i }));
    expect(mirrorRebuild).toHaveBeenCalledOnce();

    await waitFor(() =>
      expect(within(panel()).getByRole("alert")).toHaveTextContent(
        'The last backup could not be written. The folder "E:\\Backups\\MTG" is not there.',
      ),
    );
  });

  /**
   * The other half of that precedence, and what makes it a decision rather than "the error
   * always wins": a reader who plugged the stick back in and pressed Rebuild has *answered* the
   * recorded failure, and telling them it is still broken would be telling them their repair
   * did not take.
   */
  it("lets a successful rebuild answer an older failure", async () => {
    const user = userEvent.setup();
    const failedEarlier = { ...UNWRITABLE, lastRunAt: String(NOW - 7_200) };
    mirrorStatus.mockReset().mockResolvedValue(failedEarlier);
    render(<BackupPanel />, { wrapper: LiveWorld });

    // The failure is on screen before the press — this is not a panel that never draws one.
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(/is not there/);

    await user.click(screen.getByRole("button", { name: /rebuild now/i }));

    await waitFor(() =>
      expect(within(panel()).getByRole("alert")).toHaveTextContent(
        "Rebuilt — 350 files written, 0 unchanged, 2 removed.",
      ),
    );
  });

  it("switching it off calls through and does not ask again on its own", async () => {
    const user = userEvent.setup();
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("switch", { name: /back up/i }));

    expect(mirrorSetEnabled).toHaveBeenCalledWith(false);
    // "Does not ask again on its own": there is nothing to confirm. Switching the mirror off
    // destroys nothing — the files that are there stay there — so a dialog would be a fence
    // around a decision that costs nothing to reverse.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  /**
   * The wiring the three seeded wrappers above deliberately bypass.
   *
   * They hand the panel a client that already holds an answer, which is what lets three worlds
   * sit in one file — and it means none of them proves the panel ever *asks*. This one starts
   * with an empty cache, so the only way anything reaches the screen is `ipc.mirrorStatus`.
   */
  /**
   * **The one panel here describing a *background* thread is the one that has to poll.** Its
   * five neighbours read state only this window changes, so invalidating after each write is the
   * whole story; a mirror pass runs on a thread nothing in the page can hear from, and a panel
   * opened during the ~3 s startup pass said "Not run yet" until the query happened to remount.
   *
   * Fake timers rather than a six-second wait, and `shouldAdvanceTime` so that the promises the
   * refetch produces still settle. No `userEvent` in here: that library takes its own delay from
   * the timer implementation and hangs the whole file under a fake one.
   */
  it("keeps asking, so a pass nobody pressed for reaches the panel on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mirrorStatus.mockResolvedValue(NO_PASS_YET);
      render(<BackupPanel />, { wrapper: LiveWorld });
      expect(await screen.findByText(/Not run yet/)).toBeInTheDocument();

      mirrorStatus.mockResolvedValue(RAN);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await screen.findByText(/142 files written/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the mirror's state from the backend", async () => {
    mirrorStatus.mockResolvedValue({ ...RAN, root: "E:\\Backups\\MTG" });
    render(<BackupPanel />, { wrapper: LiveWorld });

    expect(await screen.findByText("E:\\Backups\\MTG")).toBeInTheDocument();
    expect(mirrorStatus).toHaveBeenCalled();
  });

  /**
   * **Both numbers, and `unchanged` is the one that carries the argument.** A pass that wrote
   * nothing because nothing had changed and a pass that wrote nothing because it could not are
   * the same sentence with `written` alone.
   */
  it("says what the last pass did, in files", async () => {
    render(<BackupPanel />, { wrapper });

    expect(await screen.findByText(/142 files written, 208 unchanged/)).toBeInTheDocument();
  });

  /**
   * The switch says which way it is set, to a reader who cannot see the gold border.
   *
   * `aria-checked` and not a class, for `MarketplacePanel`'s reason one control over: "which
   * way is this set" is the only question a switch answers, so it has to reach somebody who is
   * not looking at it.
   */
  it("marks the switch with the setting, both ways", async () => {
    render(<BackupPanel />, { wrapper });
    expect(await screen.findByRole("switch", { name: /back up/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // And the word beside it, because the mark alone is not what a sighted reader reads.
    expect(screen.getByRole("switch", { name: /back up/i })).toHaveTextContent("On");
  });

  it("draws the switch off when the mirror is off", async () => {
    render(<BackupPanel />, { wrapper: harness({ ...RAN, enabled: false }) });

    const off = await screen.findByRole("switch", { name: /back up/i });
    expect(off).toHaveAttribute("aria-checked", "false");
    expect(off).toHaveTextContent("Off");
  });

  it("switching it back on calls through with true", async () => {
    const user = userEvent.setup();
    render(<BackupPanel />, { wrapper: harness({ ...RAN, enabled: false }) });

    await user.click(await screen.findByRole("switch", { name: /back up/i }));

    expect(mirrorSetEnabled).toHaveBeenCalledWith(true);
  });

  it("rebuilds on demand and says what the pass did", async () => {
    const user = userEvent.setup();
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /rebuild now/i }));

    expect(mirrorRebuild).toHaveBeenCalledOnce();
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Rebuilt — 350 files written, 0 unchanged, 2 removed.",
    );
  });

  it("moves the mirror to the folder the picker answered", async () => {
    const user = userEvent.setup();
    pickFolder.mockResolvedValue("F:\\Cards");
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    await waitFor(() => expect(mirrorSetRoot).toHaveBeenCalledWith("F:\\Cards"));
    // Where it opened is half the control: a reader moving a backup is nearly always moving it
    // to somewhere beside where it already is.
    expect(pickFolder).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: ROOT }),
    );
  });

  /**
   * **A cancelled picker is not a failure.** `open` answers `null` when the reader closed it
   * without choosing, which is the most ordinary way to use a file dialog after changing your
   * mind — so nothing is written and nothing is said.
   */
  it("writes nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    pickFolder.mockResolvedValue(null);
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(mirrorSetRoot).not.toHaveBeenCalled();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * The picker itself is the operating system's, and it can refuse to open at all.
   *
   * The sentence is **framed** rather than passed through: what a dialog that would not open
   * hands back is plumbing, and the half that says *which* control failed is the panel's to
   * write. `DeckCoverPicker` does the same one picker over.
   */
  it("says so when the folder picker cannot be opened", async () => {
    const user = userEvent.setup();
    pickFolder.mockRejectedValue("window.__TAURI_INTERNALS__ is undefined");
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Could not open the folder picker — window.__TAURI_INTERNALS__ is undefined",
    );
    expect(mirrorSetRoot).not.toHaveBeenCalled();
  });

  /** A relative path is the one refusal `mirror_set_root` makes about the string itself, and
   *  it has to reach the reader — a root that silently read back as `data/export` would leave
   *  them watching a folder nothing is ever written to. */
  it("reports a refused folder", async () => {
    const user = userEvent.setup();
    pickFolder.mockResolvedValue("export");
    mirrorSetRoot.mockRejectedValue('"export" is not an absolute path.');
    render(<BackupPanel />, { wrapper });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(/not an absolute path/);
  });

  /** A read that would not answer leaves no controls to press, so the panel says that instead
   *  of drawing a switch with no value behind it. */
  it("draws no controls while it has no answer", async () => {
    mirrorStatus.mockRejectedValue("The card database is busy.");
    render(<BackupPanel />, { wrapper: LiveWorld });

    expect(await within(panel()).findByRole("alert")).toHaveTextContent("busy");
    expect(within(panel()).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("passSummary", () => {
  it("names both halves of an ordinary pass", () => {
    expect(passSummary({ written: 142, unchanged: 208, skipped: 0, pruned: 0, failed: 0 })).toBe(
      "142 files written, 208 unchanged",
    );
  });

  /** Zero is not said. A line ending "0 removed, 0 could not be written" every day trains a
   *  reader to stop reading the line on the day it matters. */
  it("says skipped, pruned and failed only when there are any", () => {
    expect(passSummary({ written: 1, unchanged: 0, skipped: 0, pruned: 3, failed: 2 })).toBe(
      "1 file written, 0 unchanged, 3 removed, 2 could not be written",
    );
  });

  /** The reader's own `README.txt`, which the pass will not overwrite. It is said in words
   *  because a bare number could not distinguish it from a file that failed. */
  it("names a file it left alone as theirs", () => {
    expect(passSummary({ written: 349, unchanged: 0, skipped: 1, pruned: 0, failed: 0 })).toBe(
      "349 files written, 0 unchanged, 1 left alone (yours)",
    );
  });

  /** A pass over fifty decks and a folder tree reaches four figures routinely. */
  it("separates thousands", () => {
    expect(passSummary({ written: 2_450, unchanged: 0, skipped: 0, pruned: 0, failed: 0 })).toBe(
      "2,450 files written, 0 unchanged",
    );
  });
});

describe("lastPassLine", () => {
  const NOW_MS = NOW * 1000;

  it("dates the last pass and summarises it", () => {
    expect(lastPassLine(RAN, NOW_MS)).toBe(
      "Last written 2 hours ago — 142 files written, 208 unchanged.",
    );
  });

  /** The claim this line exists to not make. `0 files written` would be indistinguishable, on
   *  the face of it, from a mirror that is already complete. */
  it("says a pass has not run rather than reporting an empty one", () => {
    expect(lastPassLine(NO_PASS_YET, NOW_MS)).toBe(
      "Not run yet — press Rebuild now to write one.",
    );
    expect(lastPassLine(NO_PASS_YET, NOW_MS)).not.toMatch(/0 files/);
  });

  /**
   * A stamp this build cannot read takes the same arm — the settings module's own rule,
   * arriving on this side. `Number("")` is `0`, which is 1970 and would print
   * "Last written 20512 days ago".
   */
  it("treats an unreadable stamp as no pass at all", () => {
    for (const junk of ["", "  ", "yesterday", "NaN"]) {
      expect(lastPassLine({ ...RAN, lastRunAt: junk }, NOW_MS)).toMatch(/not run yet/i);
    }
  });

  /** A pass with no report is a state the crate can be in — the two fields are separate — and
   *  the date on its own is still worth saying. */
  it("dates a pass that kept no report", () => {
    expect(lastPassLine({ ...RAN, lastReport: null }, NOW_MS)).toBe("Last written 2 hours ago.");
  });
});
