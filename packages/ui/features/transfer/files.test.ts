import { beforeEach, describe, expect, it, vi } from "vitest";

const importPickFile = vi.hoisted(() => vi.fn());
const exportSaveFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { importPickFile, exportSaveFile },
}));

import { chooseDecklist, saveExport } from "./files";

beforeEach(() => {
  importPickFile.mockReset().mockResolvedValue(null);
  exportSaveFile.mockReset().mockResolvedValue(false);
});

describe("Rust opens the dialog and does the I/O", () => {
  /**
   * The contract issue #545 is about: the page asks for *a* decklist, sends nothing that names a
   * file, and hears back text. A wrapper that grew a path argument again would be the hole back.
   */
  it("asks the backend for a decklist and answers its text, sending no path", async () => {
    importPickFile.mockResolvedValue({ text: "4 Lightning Bolt\n", encoding: "utf-8" });

    expect(await chooseDecklist()).toEqual({ text: "4 Lightning Bolt\n", encoding: "utf-8" });
    expect(importPickFile).toHaveBeenCalledWith();
  });

  /** A cancelled picker is not a failure and must not become one. */
  it("answers null when the reader backs out of the picker", async () => {
    importPickFile.mockResolvedValue(null);
    expect(await chooseDecklist()).toBeNull();
  });

  /**
   * **The reading travels with the text** (issue #555). `windows-1252` is the one encoding the
   * backend guessed rather than was told, and the dialog can only say so if this hands it on —
   * a wrapper that unwrapped `.text` here would silence the notice with every test still green.
   */
  it("hands on which encoding the backend read the file in", async () => {
    importPickFile.mockResolvedValue({ text: "1 Séance\n", encoding: "windows-1252" });

    expect(await chooseDecklist()).toEqual({ text: "1 Séance\n", encoding: "windows-1252" });
  });

  it("suggests the file name and hands the text to the backend's save", async () => {
    exportSaveFile.mockResolvedValue(true);

    expect(await saveExport("burn.txt", "1 Sol Ring\n")).toBe(true);
    expect(exportSaveFile).toHaveBeenCalledWith("burn.txt", "1 Sol Ring\n");
  });

  /** A cancelled save is not a rejection either: the export is still on screen. */
  it("resolves false rather than rejecting when the save dialog is cancelled", async () => {
    exportSaveFile.mockResolvedValue(false);

    await expect(saveExport("burn.txt", "1 Sol Ring\n")).resolves.toBe(false);
  });
});
