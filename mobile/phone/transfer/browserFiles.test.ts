import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyToClipboard,
  decodeDecklist,
  MAX_DECKLIST_BYTES,
  readDecklistFile,
} from "./browserFiles";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * The decode is `import.rs`'s order, read by the browser's own decoders — so each case here is one
 * of that function's four steps, with the reading it must report. The Rust half has the same cases
 * (`import::tests`); neither carries the other's bytes.
 */
describe("decodeDecklist", () => {
  it("reads valid UTF-8 as UTF-8", () => {
    const file = decodeDecklist(new TextEncoder().encode("4 Æther Vial\n"));
    expect(file).toEqual({ text: "4 Æther Vial\n", encoding: "utf-8" });
  });

  it("strips a UTF-8 byte-order mark, so a CSV header still opens on its first column", () => {
    const file = decodeDecklist(bytes(0xef, 0xbb, 0xbf, ...ascii("Quantity,Name")));
    expect(file).toEqual({ text: "Quantity,Name", encoding: "utf-8" });
  });

  it("reads a UTF-16 file in the order its mark names", () => {
    const le = decodeDecklist(bytes(0xff, 0xfe, 0x34, 0x00, 0x20, 0x00, 0xc6, 0x00));
    expect(le).toEqual({ text: "4 Æ", encoding: "utf-16le" });
    const be = decodeDecklist(bytes(0xfe, 0xff, 0x00, 0x34, 0x00, 0x20, 0x00, 0xc6));
    expect(be).toEqual({ text: "4 Æ", encoding: "utf-16be" });
  });

  it("reads anything else as Windows-1252, losslessly, and says so", () => {
    // `4 Æther` and a curly apostrophe, as Excel writes them on a Western European Windows:
    // 0xC6 is Æ (Latin-1) and 0x92 is ’ (one of the 32 bytes where 1252 is not Latin-1).
    const file = decodeDecklist(bytes(...ascii("4 "), 0xc6, ...ascii("ther Vial"), 0x92));
    expect(file).toEqual({ text: "4 Æther Vial’", encoding: "windows-1252" });
  });
});

describe("readDecklistFile", () => {
  it("reads a picked file", async () => {
    const file = new File(["4 Lightning Bolt\n"], "burn.txt", { type: "text/plain" });
    await expect(readDecklistFile(file)).resolves.toEqual({
      text: "4 Lightning Bolt\n",
      encoding: "utf-8",
    });
  });

  it("refuses a file over the megabyte in import.rs's own words, without reading it", async () => {
    const file = new File(["x".repeat(MAX_DECKLIST_BYTES + 1)], "huge.txt");
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(readDecklistFile(file)).rejects.toThrow(
      "That file is over 1 MB. A decklist is text; this reads at most 1 MB.",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("reads a file of exactly the megabyte", async () => {
    const file = new File(["x".repeat(MAX_DECKLIST_BYTES)], "edge.txt");
    await expect(readDecklistFile(file)).resolves.toMatchObject({ encoding: "utf-8" });
  });
});

describe("copyToClipboard", () => {
  const was = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const clipboard = (value: unknown) =>
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
  afterEach(() => {
    if (was === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", was);
  });

  it("writes through navigator.clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    clipboard({ writeText });
    await copyToClipboard("1 Sol Ring\n");
    expect(writeText).toHaveBeenCalledWith("1 Sol Ring\n");
  });

  it("rejects where the browser offers no clipboard, rather than pretending it copied", async () => {
    clipboard(undefined);
    await expect(copyToClipboard("1 Sol Ring\n")).rejects.toThrow(/no clipboard/);
  });
});
