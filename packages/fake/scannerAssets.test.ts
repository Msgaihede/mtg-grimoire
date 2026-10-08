/**
 * The fake's two commands for the scanner's files — `scannerAssetHandlers` in `db.ts`, the
 * workbench's stand-in for `crates/grimoire-core/src/scanner_assets.rs`.
 *
 * A file of its own rather than a block in `db.test.ts`, for the reason the handlers are a block
 * of their own: they are not the session's commands. What is held here is what a story leans on —
 * which worlds owe the files, that the download takes long enough to be seen and says where it
 * has got to in the engine's words, and that landing it is what ends the fault.
 */
import { describe, expect, it } from "vitest";
import { allHandlers, makeDb, scannerAssetHandlers, scannerHandlers } from "./db";
import { listen } from "./event";
import { installWorld } from "./world";
import type { ScannerAssetsProgress } from "@grimoire/ui/lib/ipc";
import scannerAssetsRs from "../../crates/grimoire-core/src/scanner_assets.rs?raw";

/**
 * Everything said on `scanner:assets` while `run` was going, heard as a story hears it: a world
 * of its own, so the subscriber is this call's and leaves with the next one.
 */
async function hearing<T>(run: () => Promise<T>): Promise<{ said: ScannerAssetsProgress[]; out: T }> {
  installWorld({ seed: "empty" });
  const said: ScannerAssetsProgress[] = [];
  const stop = await listen<ScannerAssetsProgress>("scanner:assets", (e) => said.push(e.payload));
  try {
    return { said, out: await run() };
  } finally {
    stop();
  }
}

describe("the fake's scanner files", () => {
  /** A story is a desktop release build by default: its binary carries the files. */
  it("owes nothing in a world with no fault", async () => {
    const handlers = scannerAssetHandlers(makeDb());
    expect(handlers.scanner_assets()).toEqual({ owed: [], bytes: 0, fetching: false });
    // And a fetch with nothing owed fetches nothing and says nothing.
    const { said, out } = await hearing(() => handlers.scanner_assets_fetch());
    expect(out).toEqual({ owed: [], bytes: 0, fetching: false });
    expect(said).toEqual([]);
  });

  /**
   * The three files, in the engine's keys, labels and sizes — read out of the crate, so a
   * resized model or a renamed key is red here rather than a story drawing last year's offer.
   */
  it("owes the engine's three files, at the engine's sizes, under scannerMissing", () => {
    expect(scannerAssetsRs.length, "scanner_assets.rs was not read").toBeGreaterThan(1_000);
    const db = makeDb();
    db.fault = "scannerMissing";
    const owed = scannerAssetHandlers(db).scanner_assets();
    expect(owed.owed.map((file) => file.key)).toEqual([
      "bundle",
      "detectionModel",
      "recognitionModel",
    ]);
    expect(owed.bytes).toBe(18_101_604);
    expect(owed.fetching).toBe(false);
    const constant = (name: string) =>
      Number(
        new RegExp(`pub const ${name}: u64 = ([0-9_]+);`).exec(scannerAssetsRs)?.[1].replace(/_/g, ""),
      );
    expect(owed.owed.map((file) => file.bytes)).toEqual([
      constant("BUNDLE_BYTES"),
      constant("DETECTION_BYTES"),
      constant("RECOGNITION_BYTES"),
    ]);
    for (const file of owed.owed) {
      expect(scannerAssetsRs, file.key).toContain(`=> "${file.key}",`);
      expect(scannerAssetsRs, file.label).toContain(`=> "${file.label}",`);
    }
  });

  /**
   * **The download, as a story sees it**: it takes time, a second press while it runs is refused
   * in the engine's words, the bar's numbers only go up and end on the whole of it — and when it
   * lands the fault is over, so the status the page reads next is a scanner with its files.
   */
  it("takes a moment, says how far it has got, and ends the fault when it lands", async () => {
    const db = makeDb();
    db.fault = "scannerMissing";
    const handlers = { ...scannerHandlers(db), ...scannerAssetHandlers(db) };
    expect(handlers.scanner_status().bundle.loaded).toBe(false);

    const { said, out } = await hearing(async () => {
      const going = handlers.scanner_assets_fetch();
      expect(handlers.scanner_assets().fetching).toBe(true);
      await expect(handlers.scanner_assets_fetch()).rejects.toThrow(
        "The scanner's files are already downloading.",
      );
      return going;
    });
    expect(scannerAssetsRs).toContain(
      `pub const ALREADY_FETCHING: &str = "The scanner's files are already downloading.";`,
    );

    expect(out).toEqual({ owed: [], bytes: 0, fetching: false });
    expect(handlers.scanner_assets()).toEqual({ owed: [], bytes: 0, fetching: false });
    expect(db.fault).toBeNull();
    expect(handlers.scanner_status().bundle.loaded).toBe(true);

    expect(said.map((e) => e.phase)).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "checking",
      "done",
    ]);
    expect(said.every((e) => e.total === 18_101_604)).toBe(true);
    expect(said.map((e) => e.done)).toEqual([...said.map((e) => e.done)].sort((a, b) => a - b));
    expect(said[said.length - 1]).toEqual({
      phase: "done",
      file: null,
      done: 18_101_604,
      total: 18_101_604,
      message: null,
    });
  });

  /** The refused download: the engine's sentence, as the rejection and as the event's last word. */
  it("starts, says so and is refused under scannerFetchFails, and still owes the files", async () => {
    const db = makeDb();
    db.fault = "scannerFetchFails";
    const handlers = scannerAssetHandlers(db);
    const sentence = "card-hashes.bin is not published for this version of the app (HTTP 404).";
    const { said } = await hearing(async () => {
      await expect(handlers.scanner_assets_fetch()).rejects.toThrow(sentence);
    });
    expect(said.map((e) => e.phase)).toEqual(["downloading", "error"]);
    expect(said[1].message).toBe(sentence);
    expect(handlers.scanner_assets().owed).toHaveLength(3);
    expect(handlers.scanner_assets().fetching).toBe(false);
    expect(db.fault).toBe("scannerFetchFails");
    // The sentence is the engine's own shape for a file the release does not have.
    expect(scannerAssetsRs).toContain(
      '"{name} is not published for this version of the app (HTTP 404)."',
    );
  });

  it("is part of the table a story registers", () => {
    const table = allHandlers(makeDb());
    expect(Object.keys(table)).toEqual(
      expect.arrayContaining(["scanner_assets", "scanner_assets_fetch"]),
    );
  });
});
