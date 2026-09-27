import { beforeEach, describe, expect, it, vi } from "vitest";

const pickNative = vi.hoisted(() => vi.fn());
const saveNative = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickNative, save: saveNative }));

const importReadFile = vi.hoisted(() => vi.fn());
const exportWriteFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { importReadFile, exportWriteFile },
}));

import { pickDecklist, readDecklist, saveExport } from "./files";

beforeEach(() => {
  pickNative.mockReset().mockResolvedValue(null);
  saveNative.mockReset().mockResolvedValue(null);
  importReadFile.mockReset().mockResolvedValue("");
  exportWriteFile.mockReset().mockResolvedValue(undefined);
});

describe("a picker answers a name and Rust does the I/O", () => {
  /**
   * The contract that makes `dialog:allow-open` sufficient and is why this app grants **no
   * `fs:` permission anywhere**: what comes back is a path, and the page never reads a byte.
   */
  it("asks the OS picker for one decklist and answers its path", async () => {
    pickNative.mockResolvedValue("C:/lists/burn.txt");

    expect(await pickDecklist()).toBe("C:/lists/burn.txt");
    expect(pickNative).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      title: "Choose a decklist",
      filters: [{ name: "Decklist", extensions: ["txt", "dec", "dek", "csv"] }],
    });
  });

  /** A cancelled picker is not a failure and must not become one. */
  it("answers null when the reader backs out of the picker", async () => {
    pickNative.mockResolvedValue(null);
    expect(await pickDecklist()).toBeNull();
  });

  it("reads a path through import_read_file and never in the page", async () => {
    importReadFile.mockResolvedValue("4 Lightning Bolt\n");

    const text = await readDecklist("C:/lists/burn.txt");

    expect(text).toBe("4 Lightning Bolt\n");
    expect(importReadFile).toHaveBeenCalledWith("C:/lists/burn.txt");
  });

  it("names the file in the save dialog and writes the text Rust was given", async () => {
    saveNative.mockResolvedValue("C:/decks/burn.txt");

    await saveExport("burn.txt", "1 Sol Ring\n");

    expect(saveNative).toHaveBeenCalledWith({ defaultPath: "burn.txt" });
    expect(exportWriteFile).toHaveBeenCalledWith("C:/decks/burn.txt", "1 Sol Ring\n");
  });

  /**
   * `save()` resolves `null` on Cancel, and writing *that* string to disk is the whole reason
   * the guard exists. A cancelled save is also not a rejection: the export is still on screen.
   */
  it("writes nothing when the save dialog is cancelled", async () => {
    saveNative.mockResolvedValue(null);

    await expect(saveExport("burn.txt", "1 Sol Ring\n")).resolves.toBeUndefined();

    expect(exportWriteFile).not.toHaveBeenCalled();
  });
});
