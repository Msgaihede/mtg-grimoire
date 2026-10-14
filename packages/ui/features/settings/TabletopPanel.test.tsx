import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabletopStatus } from "@/lib/ipc";

const tabletopStatus = vi.hoisted(() => vi.fn());
const tabletopSetEnabled = vi.hoisted(() => vi.fn());
/** Change folder…, the picker and the save in one command — Rust opens it, so jsdom cannot. */
const tabletopPickFolder = vi.hoisted(() => vi.fn());
const tabletopSetLocalImages = vi.hoisted(() => vi.fn());
const tabletopRebuild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    tabletopStatus,
    tabletopSetEnabled,
    tabletopSetLocalImages,
    tabletopPickFolder,
    tabletopRebuild,
  },
}));

import { TABLETOP_KEY, TabletopPanel, savesNote, tabletopPassLine } from "./TabletopPanel";

/** The instant every "2 hours ago" below is read against. */
const NOW = Math.floor(Date.now() / 1000);

const SAVES = "C:\\Users\\me\\Documents\\My Games\\Tabletop Simulator\\Saves";
const FOLDER = `${SAVES}\\MTG Grimoire`;

/** A fresh install: **off**, Tabletop Simulator's folder where it makes it, no pass this run. */
const FRESH: TabletopStatus = {
  enabled: false,
  localImages: false,
  savesFolder: SAVES,
  savesFound: true,
  folder: FOLDER,
  lastRunAt: null,
  lastReport: null,
  lastError: null,
};

/** Switched on, with a pass behind it. */
const RAN: TabletopStatus = {
  ...FRESH,
  enabled: true,
  lastRunAt: String(NOW - 7_200),
  lastReport: { written: 12, unchanged: 30, skipped: 0, pruned: 0, failed: 0 },
};

/** Tabletop Simulator never installed, or its saves kept elsewhere. */
const NOT_FOUND: TabletopStatus = { ...FRESH, savesFound: false };

/** One seeded world, `BackupPanel.test.tsx`'s `harness`: `staleTime: Infinity` keeps the seed. */
function harness(status: TabletopStatus) {
  return function Harness({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const c = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      c.setQueryData(TABLETOP_KEY, status);
      return c;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** A world whose read is in flight — no seed, so the panel asks the backend. */
function LiveWorld({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const panel = () => screen.getByRole("region", { name: "Tabletop Simulator" });
const toggle = () => screen.findByRole("switch", { name: /tabletop simulator/i });

beforeEach(() => {
  tabletopStatus.mockReset().mockResolvedValue(RAN);
  tabletopSetEnabled.mockReset().mockResolvedValue(undefined);
  tabletopSetLocalImages.mockReset().mockResolvedValue(undefined);
  tabletopPickFolder.mockReset().mockResolvedValue(false);
  tabletopRebuild.mockReset().mockResolvedValue({
    written: 42,
    unchanged: 0,
    skipped: 0,
    pruned: 1,
    failed: 0,
  });
});

describe("TabletopPanel", () => {
  it("reads the integration's state from the backend", async () => {
    render(<TabletopPanel />, { wrapper: LiveWorld });

    expect(await screen.findByText(FOLDER)).toBeInTheDocument();
    expect(tabletopStatus).toHaveBeenCalled();
  });

  /** Off by default (issue #1038): it writes into another program's folder. */
  it("draws a fresh install off, with no pass claimed", async () => {
    render(<TabletopPanel />, { wrapper: harness(FRESH) });

    const off = await toggle();
    expect(off).toHaveAttribute("aria-checked", "false");
    expect(off).toHaveTextContent("Off");
    expect(screen.getByText("Not run yet.")).toBeInTheDocument();
    expect(screen.queryByText(/0 files written/)).not.toBeInTheDocument();
  });

  it("switching it on calls through with true, and asks nothing more", async () => {
    const user = userEvent.setup();
    render(<TabletopPanel />, { wrapper: harness(FRESH) });

    await user.click(await toggle());

    expect(tabletopSetEnabled).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switching it off calls through with false", async () => {
    const user = userEvent.setup();
    render(<TabletopPanel />, { wrapper: harness(RAN) });

    const on = await toggle();
    expect(on).toHaveAttribute("aria-checked", "true");
    await user.click(on);

    expect(tabletopSetEnabled).toHaveBeenCalledWith(false);
  });

  it("names the MTG Grimoire folder and says what the last pass did", async () => {
    render(<TabletopPanel />, { wrapper: harness(RAN) });

    expect(await screen.findByText(FOLDER)).toBeInTheDocument();
    expect(
      screen.getByText(/Last updated 2 hours ago — 12 files written, 30 unchanged/),
    ).toBeInTheDocument();
    // Found, so nothing is said about the saves folder.
    expect(screen.queryByText(/wasn't found/)).not.toBeInTheDocument();
  });

  /** Not found is not an alarm: no alert, the plain note, and every control still there. */
  it("says the saves folder was not found and points at Change folder…", async () => {
    render(<TabletopPanel />, { wrapper: harness(NOT_FOUND) });

    expect(
      await screen.findByText(
        `Tabletop Simulator's saves folder wasn't found at ${SAVES}. If your saves are somewhere else, choose that folder with Change folder…`,
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change folder/i })).toBeEnabled();
    expect(await toggle()).toBeEnabled();
  });

  it("asks the backend to move the saves folder, and shows where it moved to", async () => {
    const user = userEvent.setup();
    tabletopStatus.mockResolvedValue(RAN);
    tabletopPickFolder.mockImplementation(() => {
      tabletopStatus.mockResolvedValue({ ...RAN, folder: "E:\\TTS\\Saves\\MTG Grimoire" });
      return Promise.resolve(true);
    });
    render(<TabletopPanel />, { wrapper: LiveWorld });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    expect(tabletopPickFolder).toHaveBeenCalledWith();
    expect(await screen.findByText("E:\\TTS\\Saves\\MTG Grimoire")).toBeInTheDocument();
  });

  it("says nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    render(<TabletopPanel />, { wrapper: harness(RAN) });

    await user.click(await screen.findByRole("button", { name: /change folder/i }));

    await waitFor(() => expect(tabletopPickFolder).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /change folder/i })).toBeEnabled(),
    );
    expect(tabletopStatus).not.toHaveBeenCalled();
    expect(within(panel()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a refused write in the backend's words", async () => {
    const user = userEvent.setup();
    const busy = "The card database is busy finishing a sync. Try that again in a moment.";
    tabletopSetEnabled.mockRejectedValue(busy);
    render(<TabletopPanel />, { wrapper: harness(FRESH) });

    await user.click(await toggle());

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(busy);
  });

  it("rebuilds on demand and says what the pass did", async () => {
    const user = userEvent.setup();
    render(<TabletopPanel />, { wrapper: harness(RAN) });

    await user.click(await screen.findByRole("button", { name: /rebuild now/i }));

    expect(tabletopRebuild).toHaveBeenCalledOnce();
    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Rebuilt — 42 files written, 0 unchanged, 1 removed.",
    );
  });

  it("shows the sentence when the last pass could not write", async () => {
    render(<TabletopPanel />, {
      wrapper: harness({ ...RAN, lastError: "the folder E:\\TTS could not be created" }),
    });

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(
      "Couldn't write the Tabletop Simulator saves. the folder E:\\TTS could not be created",
    );
  });

  /** `BackupPanel`'s precedence, through the same `errorOutranks`: a failure *after* the rebuild
   *  this window watched is still news. */
  it("still reports a background failure after a rebuild has succeeded", async () => {
    const user = userEvent.setup();
    const failedLater = { ...RAN, lastRunAt: String(NOW + 600), lastError: "it went wrong" };
    tabletopStatus.mockReset().mockResolvedValueOnce(RAN).mockResolvedValue(failedLater);
    render(<TabletopPanel />, { wrapper: LiveWorld });

    await user.click(await screen.findByRole("button", { name: /rebuild now/i }));

    await waitFor(() =>
      expect(within(panel()).getByRole("alert")).toHaveTextContent(/it went wrong/),
    );
  });

  /** The Rebuild that refuses — the pass's own sentence for a saves folder that is not there. */
  it("reports a rebuild that could not run", async () => {
    const user = userEvent.setup();
    const sentence = `Tabletop Simulator's saves folder was not found at ${SAVES}.`;
    tabletopRebuild.mockRejectedValue(sentence);
    render(<TabletopPanel />, { wrapper: harness(NOT_FOUND) });

    await user.click(await screen.findByRole("button", { name: /rebuild now/i }));

    expect(await within(panel()).findByRole("alert")).toHaveTextContent(sentence);
  });

  it("keeps asking, so a pass nobody pressed for reaches the panel on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      tabletopStatus.mockResolvedValue({ ...RAN, lastRunAt: null, lastReport: null });
      render(<TabletopPanel />, { wrapper: LiveWorld });
      expect(await screen.findByText("Not run yet.")).toBeInTheDocument();

      tabletopStatus.mockResolvedValue(RAN);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await screen.findByText(/12 files written/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides its controls while its read has no answer", async () => {
    tabletopStatus.mockRejectedValue("The card database is busy.");
    render(<TabletopPanel />, { wrapper: LiveWorld });

    expect(await within(panel()).findByRole("alert")).toHaveTextContent("busy");
    expect(within(panel()).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the local card images switch", () => {
  const images = () => screen.findByRole("switch", { name: /store card images/i });

  it("is off by default, and drawn but disabled while the integration is off", async () => {
    render(<TabletopPanel />, { wrapper: harness(FRESH) });

    const off = await images();
    expect(off).toHaveAttribute("aria-checked", "false");
    expect(off).toBeDisabled();
  });

  it("switching it on calls through with true", async () => {
    const user = userEvent.setup();
    render(<TabletopPanel />, { wrapper: harness(RAN) });

    const control = await images();
    expect(control).toBeEnabled();
    await user.click(control);

    expect(tabletopSetLocalImages).toHaveBeenCalledWith(true);
    expect(tabletopSetEnabled).not.toHaveBeenCalled();
  });

  it("draws it on when the backend says so", async () => {
    render(<TabletopPanel />, { wrapper: harness({ ...RAN, localImages: true }) });
    expect(await images()).toHaveAttribute("aria-checked", "true");
  });
});

describe("tabletopPassLine", () => {
  const nowMs = NOW * 1000;

  it("says a pass has not run rather than reporting an empty one", () => {
    expect(tabletopPassLine(FRESH, nowMs)).toBe("Not run yet.");
  });

  it("dates the last pass and summarises it", () => {
    expect(tabletopPassLine(RAN, nowMs)).toBe(
      "Last updated 2 hours ago — 12 files written, 30 unchanged.",
    );
  });

  it("dates a pass that kept no report", () => {
    expect(tabletopPassLine({ ...RAN, lastReport: null }, nowMs)).toBe("Last updated 2 hours ago.");
  });
});

describe("savesNote", () => {
  it("says nothing when Tabletop Simulator's folder is there", () => {
    expect(savesNote(FRESH)).toBeNull();
  });

  it("names the folder it looked in, or says there was none to look in", () => {
    expect(savesNote(NOT_FOUND)).toContain(SAVES);
    expect(savesNote({ ...NOT_FOUND, savesFolder: null, folder: null })).toBe(
      "Tabletop Simulator's saves folder couldn't be found. Choose it with Change folder…",
    );
  });
});
