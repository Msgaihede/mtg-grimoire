import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one seam these tests exist for. `isWebTarget()` reads `__CORE__`, a **build-time**
 * constant vitest fixes at `"tauri"` — so the web branch is unreachable unless this module is
 * mocked, and mocking it is the only way in. `src/pwa/target.ts`'s own comment says so, and
 * five other suites already do exactly this.
 */
const isWebTarget = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/pwa/target", () => ({ isWebTarget }));

const pickNative = vi.hoisted(() => vi.fn());
const saveNative = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: pickNative, save: saveNative }));

const importReadFile = vi.hoisted(() => vi.fn());
const exportWriteFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { importReadFile, exportWriteFile },
}));

import { DECKLIST_ACCEPT, MAX_IMPORT_BYTES, pickDecklist, readDecklist, saveExport } from "./files";

/**
 * A `FileList` for an input jsdom will not fill in itself.
 *
 * jsdom implements `input.files` as a read-only empty `FileList` and has no `DataTransfer` to
 * build a real one with, so the property is redefined. Both access shapes are provided
 * deliberately — this is a *shim*, not an assertion, and it must not decide which of `[0]` and
 * `.item(0)` the implementation is allowed to use.
 */
function attach(input: HTMLInputElement, file: File): void {
  const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) };
  Object.defineProperty(input, "files", { configurable: true, value: list });
}

/** The one file input `pickDecklist` puts in the document, or a failure naming its absence. */
function pickerInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>("input[type=file]");
  if (input === null) throw new Error("no file input was attached to the document");
  return input;
}

/** One macrotask, which is where the object URL is revoked. */
const nextTask = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  isWebTarget.mockReturnValue(false);
  pickNative.mockReset().mockResolvedValue(null);
  saveNative.mockReset().mockResolvedValue(null);
  importReadFile.mockReset().mockResolvedValue("");
  exportWriteFile.mockReset().mockResolvedValue(undefined);
  document.body.replaceChildren();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the native branch — a picker answers a name and Rust does the I/O", () => {
  /**
   * The contract that makes `dialog:allow-open` sufficient and is why this app grants **no
   * `fs:` permission anywhere**: what comes back is a path, and the page never reads a byte.
   */
  it("asks the OS picker for one decklist and answers its path", async () => {
    pickNative.mockResolvedValue("C:/lists/burn.txt");

    expect(await pickDecklist()).toEqual({ kind: "path", path: "C:/lists/burn.txt" });
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

    const text = await readDecklist({ kind: "path", path: "C:/lists/burn.txt" });

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

describe("the web branch — the page holds the file and there is no path at all", () => {
  beforeEach(() => {
    isWebTarget.mockReturnValue(true);
  });

  it("offers the same four extensions to the browser's own picker", async () => {
    const promise = pickDecklist();
    const input = pickerInput();

    expect(input.accept).toBe(".txt,.dec,.dek,.csv");
    expect(DECKLIST_ACCEPT).toBe(".txt,.dec,.dek,.csv");
    // Off screen through the content attribute rather than an inline `style`, and attached
    // rather than detached — engines have differed about whether a detached input opens a
    // picker at all.
    expect(input.hidden).toBe(true);
    expect(input.isConnected).toBe(true);

    input.dispatchEvent(new Event("cancel"));
    await promise;
  });

  it("answers the file the reader chose, and takes its input back out of the document", async () => {
    const file = new File(["4 Lightning Bolt\n"], "burn.txt", { type: "text/plain" });
    const promise = pickDecklist();
    const input = pickerInput();

    attach(input, file);
    input.dispatchEvent(new Event("change"));

    expect(await promise).toEqual({ kind: "file", file });
    expect(document.body.querySelector("input[type=file]")).toBeNull();
  });

  /**
   * **`cancel` is the only thing that closes the promise when the reader backs out.** A file
   * input reports nothing at all when its dialog is dismissed, so without this listener the
   * `Choose file…` button would stay disabled for the life of the dialog.
   */
  it("answers null on the picker's cancel event and cleans up after itself", async () => {
    const promise = pickDecklist();
    const input = pickerInput();

    input.dispatchEvent(new Event("cancel"));

    expect(await promise).toBeNull();
    expect(document.body.querySelector("input[type=file]")).toBeNull();
  });

  /** The Tauri dialog plugin is not merely unused here — it would throw in a browser. */
  it("never reaches the Tauri dialog plugin", async () => {
    const promise = pickDecklist();
    pickerInput().dispatchEvent(new Event("cancel"));
    await promise;

    expect(pickNative).not.toHaveBeenCalled();
  });

  it("reads the file in the page and never through import_read_file", async () => {
    const file = new File(["4 Lightning Bolt\n2 Shock\n"], "burn.txt");

    expect(await readDecklist({ kind: "file", file })).toBe("4 Lightning Bolt\n2 Shock\n");
    expect(importReadFile).not.toHaveBeenCalled();
  });

  /**
   * The cap is `import.rs`'s to the byte, and the sentence is spelled out here rather than read
   * off the module's own constant — an assertion that quotes the thing it is checking cannot
   * fail when that thing is wrong.
   */
  it("refuses a file over the cap in the same words the Rust half refuses with", async () => {
    const file = new File(["x"], "huge.txt");
    Object.defineProperty(file, "size", { value: 1024 * 1024 + 1 });

    await expect(readDecklist({ kind: "file", file })).rejects.toThrow(
      "That file is over 1 MB. A decklist is text; this reads at most 1 MB.",
    );
  });

  /** The cap is a ceiling, not a fence one byte below it. `read_bounded` refuses on `>` too. */
  it("reads a file that is exactly at the cap", async () => {
    const file = new File(["ok"], "big.txt");
    Object.defineProperty(file, "size", { value: MAX_IMPORT_BYTES });

    await expect(readDecklist({ kind: "file", file })).resolves.toBe("ok");
  });

  it("hands the export to the browser as a named download and revokes the blob after", async () => {
    const urls: Blob[] = [];
    const revoked: string[] = [];
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      urls.push(blob as Blob);
      return "blob:grimoire/1";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revoked.push(url));
    // Spied rather than allowed through: jsdom answers a real anchor click with "Not
    // implemented: navigation to another Document", and the element is what is being asserted
    // about anyway.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    await saveExport("burn.plain.txt", "1 Sol Ring\n");

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("burn.plain.txt");
    expect(clicked[0].getAttribute("href")).toBe("blob:grimoire/1");
    expect(await urls[0].text()).toBe("1 Sol Ring\n");
    // Not on the next line: revoking synchronously after `click()` races the user agent's own
    // fetch of the blob, and the download that loses that race fails silently.
    expect(revoked).toEqual([]);
    await nextTask();
    expect(revoked).toEqual(["blob:grimoire/1"]);
    // Nothing of the mechanism is left behind in the document.
    expect(document.body.querySelector("a")).toBeNull();
  });

  it("never reaches the save dialog or export_write_file", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:grimoire/2");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await saveExport("burn.plain.txt", "1 Sol Ring\n");

    expect(saveNative).not.toHaveBeenCalled();
    expect(exportWriteFile).not.toHaveBeenCalled();
    await nextTask();
  });
});
