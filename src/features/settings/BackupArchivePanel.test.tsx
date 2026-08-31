import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupZip } from "@/lib/ipc";

const mirrorBackupZip = vi.hoisted(() => vi.fn());
const mirrorBackupSave = vi.hoisted(() => vi.fn());
const mirrorStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { mirrorBackupZip, mirrorBackupSave, mirrorStatus },
}));

/** The OS save dialog. `save()` reaches Tauri's `invoke`, which jsdom has nothing behind —
 *  the same reason `BackupPanel.test.tsx` mocks the folder picker. */
const pickSaveFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: pickSaveFile }));

/** Both platform probes, because the panel is chosen by them and neither is a thing a test can
 *  arrange any other way: `isWebTarget` reads `__CORE__`, a build-time constant vitest fixes at
 *  `"tauri"`, and `isAndroid` reads a user agent jsdom will never carry. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
vi.mock("@/lib/platform", () => ({ isAndroid: vi.fn(() => false) }));

import { ipc } from "@/lib/ipc";
import { isAndroid } from "@/lib/platform";
import { isWebTarget } from "@/pwa/target";
import { archiveSummary, BackupPanel, madeLine } from "./BackupPanel";

/** What a healthy archive answers. 142 files is the spec's own example, and the byte count is a
 *  real one: a 100-file mirror measured ~10 MB of text, which deflates to about this. */
const ZIP: BackupZip = {
  fileName: "mtg-grimoire-backup-2026-08-31.zip",
  files: 142,
  failed: 0,
  byteLength: 1_437_000,
  base64: "UEsDBA==",
};

/** The answer `mirror_backup_save` gives: Rust wrote the file, so the page never sees bytes. */
const SAVED: BackupZip = { ...ZIP, base64: null };

function Harness({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const clicks: string[] = [];

beforeEach(() => {
  clicks.length = 0;
  vi.mocked(isWebTarget).mockReturnValue(false);
  vi.mocked(isAndroid).mockReturnValue(false);
  mirrorBackupZip.mockReset().mockResolvedValue(ZIP);
  mirrorBackupSave.mockReset().mockResolvedValue(SAVED);
  mirrorStatus.mockReset().mockResolvedValue({
    enabled: true,
    root: "D:\\app\\data\\export",
    lastRunAt: null,
    lastReport: null,
    lastError: null,
  });
  pickSaveFile.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:stub"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which backup a platform gets", () => {
  /** **The whole of the platform decision, and the assertion is the absence.** The folder's
   *  four commands are desktop-only, so a web build that so much as *polled* `mirror_status`
   *  would be calling a name `web::route` does not answer — an `unknown command` in the console
   *  on a page that otherwise looks fine. */
  it("gives the web target the archive and never asks about the folder", async () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    render(<BackupPanel />, { wrapper: Harness });

    expect(await screen.findByRole("button", { name: /Download backup/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change folder/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rebuild now/ })).toBeNull();
    expect(ipc.mirrorStatus).not.toHaveBeenCalled();
  });

  /** Android is the Tauri build, so nothing at compile time tells it from the desktop — the
   *  probe is the user agent, and it is what decides the panel and the button's word. */
  it("gives Android the archive, through the save dialog rather than a download", async () => {
    vi.mocked(isAndroid).mockReturnValue(true);
    render(<BackupPanel />, { wrapper: Harness });

    expect(await screen.findByRole("button", { name: /Save backup/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change folder/ })).toBeNull();
    expect(ipc.mirrorStatus).not.toHaveBeenCalled();
  });

  /** The desktop keeps the folder it has always had. This is the arm that would break if the
   *  dispatch ever inverted, and neither of the two above could catch it. */
  it("leaves the desktop on the folder", async () => {
    render(<BackupPanel />, { wrapper: Harness });
    expect(await screen.findByRole("button", { name: /Change folder/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download backup/ })).toBeNull();
  });
});

describe("the browser's door", () => {
  beforeEach(() => vi.mocked(isWebTarget).mockReturnValue(true));

  it("builds the archive and hands it to the browser under the name Rust chose", async () => {
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Download backup/ }));

    await waitFor(() => expect(ipc.mirrorBackupZip).toHaveBeenCalledTimes(1));
    expect(clicks).toEqual(["mtg-grimoire-backup-2026-08-31.zip"]);
    expect(
      await screen.findByText(/Downloaded mtg-grimoire-backup-2026-08-31\.zip/),
    ).toBeInTheDocument();
  });

  /** **A backend answering the wrong shape must not read as a button that does nothing.**
   *  `base64` is `null` only when Rust wrote the file itself, which this door never asks it to;
   *  handing `atob` a null is a `TypeError` inside a promise, which is exactly the silence this
   *  guard converts into a sentence. */
  it("says so rather than clicking an empty anchor when the bytes are missing", async () => {
    mirrorBackupZip.mockResolvedValue({ ...ZIP, base64: null });
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Download backup/ }));

    expect(await screen.findByText(/came back without its contents/)).toBeInTheDocument();
    expect(clicks).toEqual([]);
  });

  it("reports a refused build rather than swallowing it", async () => {
    mirrorBackupZip.mockRejectedValue("the backup archive could not be built");
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Download backup/ }));

    expect(await screen.findByText(/could not be built/)).toBeInTheDocument();
  });
});

describe("Android's door", () => {
  beforeEach(() => vi.mocked(isAndroid).mockReturnValue(true));

  it("writes at the destination the reader named and never renders bytes into the page", async () => {
    pickSaveFile.mockResolvedValue("content://downloads/42");
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Save backup/ }));

    await waitFor(() => expect(ipc.mirrorBackupSave).toHaveBeenCalledWith("content://downloads/42"));
    expect(ipc.mirrorBackupZip).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
    // The reader typed the name, so quoting Rust's suggestion back at them would name a file
    // that may not exist.
    expect(await screen.findByText(/^Saved — 142 files, 1\.4 MB\.$/)).toBeInTheDocument();
  });

  /** `save()` answers `null` on Cancel, and building — let alone writing — at *that* is the bug
   *  the guard exists for. Backing out of the picker must cost nothing at all. */
  it("does nothing at all when the reader cancels the picker", async () => {
    pickSaveFile.mockResolvedValue(null);
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Save backup/ }));

    await waitFor(() => expect(pickSaveFile).toHaveBeenCalledTimes(1));
    expect(ipc.mirrorBackupSave).not.toHaveBeenCalled();
    expect(screen.queryByText(/Saved/)).toBeNull();
  });
});

describe("what the panel says about one archive", () => {
  /** **The number that could not be left off.** A reader looking at a folder sees the missing
   *  deck; a reader who has already mailed the zip to themselves does not. */
  it("names the lists that went missing, and only when some did", () => {
    expect(archiveSummary(ZIP)).toBe("142 files, 1.4 MB");
    expect(archiveSummary({ ...ZIP, failed: 3 })).toBe("142 files, 1.4 MB, 3 could not be read");
  });

  it("says one file rather than 1 files", () => {
    expect(archiveSummary({ ...ZIP, files: 1, byteLength: 512 })).toBe("1 file, 512 bytes");
  });

  it("names the file only on the door that named it", () => {
    expect(madeLine(ZIP, false)).toContain("mtg-grimoire-backup-2026-08-31.zip");
    expect(madeLine(SAVED, true)).not.toContain("mtg-grimoire-backup");
  });

  /** An archive that could not read every list is a problem rather than an outcome, so it is
   *  drawn in the destructive tone its neighbours use for a refusal. */
  it("draws a partial archive in the problem tone", async () => {
    vi.mocked(isWebTarget).mockReturnValue(true);
    mirrorBackupZip.mockResolvedValue({ ...ZIP, failed: 3 });
    render(<BackupPanel />, { wrapper: Harness });
    await userEvent.click(await screen.findByRole("button", { name: /Download backup/ }));

    const line = await screen.findByText(/3 could not be read/);
    expect(line.className).toContain("text-destructive");
  });
});
