import { describe, expect, it } from "vitest";
import {
  cacheOutcome,
  collectionOutcome,
  decksOutcome,
  fileSize,
  wishlistOutcome,
} from "./clearOutcome";

const GIGABYTE = 1_000_000_000;

describe("fileSize", () => {
  /** The unit the cache actually lands in. 329 682 302 B is the measured dev cache. */
  it("rounds a real cache to whole megabytes", () => {
    expect(fileSize(329_682_302)).toBe("330 MB");
  });

  /**
   * The one place a decimal earns its keep. `1.4 GB` carries information about how much room
   * is coming back; `1 GB` and `2 GB` would be the only two answers a library ever gives.
   */
  it("keeps one decimal above a gigabyte", () => {
    expect(fileSize(1_400_000_000)).toBe("1.4 GB");
    expect(fileSize(GIGABYTE)).toBe("1.0 GB");
  });

  it("steps down through KB and bytes rather than printing 0 MB", () => {
    expect(fileSize(948_000)).toBe("948 KB");
    expect(fileSize(512)).toBe("512 bytes");
    expect(fileSize(1)).toBe("1 byte");
  });

  /** Nothing cached is `0 bytes` and never `0 MB` — but no sentence prints it, see below. */
  it("answers zero without a unit that implies rounding", () => {
    expect(fileSize(0)).toBe("0 bytes");
  });
});

describe("collectionOutcome", () => {
  /**
   * The allocations clause is the consequence the reader did not ask for, and the reason this
   * is a sentence rather than a count.
   */
  it("names the deck reservations the cascade released", () => {
    expect(collectionOutcome({ entries: 1284, allocations: 37 })).toBe(
      "Cleared 1,284 collection entries and released 37 deck reservations.",
    );
  });

  /** A reader with no decks is not owed a sentence about decks. */
  it("drops the clause rather than printing zero reservations", () => {
    expect(collectionOutcome({ entries: 12, allocations: 0 })).toBe(
      "Cleared 12 collection entries.",
    );
  });

  it("agrees with a count of one", () => {
    expect(collectionOutcome({ entries: 1, allocations: 1 })).toBe(
      "Cleared 1 collection entry and released 1 deck reservation.",
    );
  });

  /** Pressing Clear on an empty collection is not a mistake worth a row of zeroes. */
  it("says nothing happened rather than reporting zero", () => {
    expect(collectionOutcome({ entries: 0, allocations: 0 })).toBe(
      "The collection was already empty.",
    );
  });
});

describe("wishlistOutcome", () => {
  it("counts with separators and agrees at one", () => {
    expect(wishlistOutcome(1_204)).toBe("Cleared 1,204 wishlist entries.");
    expect(wishlistOutcome(1)).toBe("Cleared 1 wishlist entry.");
  });

  it("says nothing happened when it was already empty", () => {
    expect(wishlistOutcome(0)).toBe("The wishlist was already empty.");
  });
});

describe("decksOutcome", () => {
  it("lists all three when all three happened", () => {
    expect(decksOutcome({ decks: 12, folders: 3, covers: 2 })).toBe(
      "Cleared 12 decks, 3 folders and 2 cover images.",
    );
  });

  /** Only a deck the reader gave a picture to has a cover file, so this is the common shape. */
  it("omits the covers when no deck had one", () => {
    expect(decksOutcome({ decks: 4, folders: 1, covers: 0 })).toBe("Cleared 4 decks and 1 folder.");
  });

  /**
   * The asymmetry worth pinning: an empty folder tree with no decks in it is a real state, and
   * clearing it is a real thing that happened.
   */
  it("reports folders cleared even when there were no decks", () => {
    expect(decksOutcome({ decks: 0, folders: 2, covers: 0 })).toBe("Cleared 2 folders.");
  });

  it("says nothing happened only when nothing did", () => {
    expect(decksOutcome({ decks: 0, folders: 0, covers: 0 })).toBe(
      "There were no decks or folders to clear.",
    );
  });
});

describe("cacheOutcome", () => {
  it("says what it freed, in size first and files second", () => {
    expect(cacheOutcome({ files: 5_540, bytes: 329_682_302, rows: 5_540, failed: 0 })).toBe(
      "Freed 330 MB across 5,540 files.",
    );
  });

  /**
   * A locked file is its own sentence rather than a parenthesis: the first says what happened,
   * the second says what did not. Pressing again a moment later usually takes it.
   */
  it("reports files that would not go, in a sentence of their own", () => {
    expect(cacheOutcome({ files: 20, bytes: 4_000, rows: 20, failed: 3 })).toBe(
      "Freed 4 KB across 20 files. 3 files were in use and stayed.",
    );
    expect(cacheOutcome({ files: 20, bytes: 4_000, rows: 20, failed: 1 })).toBe(
      "Freed 4 KB across 20 files. 1 file was in use and stayed.",
    );
  });

  /** `rows` is never printed — it is bookkeeping for the files in the first number. */
  it("never reports the bookkeeping rows", () => {
    expect(cacheOutcome({ files: 8, bytes: 900, rows: 8, failed: 0 })).not.toContain("row");
  });

  it("says there was nothing cached rather than freeing 0 bytes", () => {
    expect(cacheOutcome({ files: 0, bytes: 0, rows: 0, failed: 0 })).toBe(
      "There was nothing cached to clear.",
    );
  });
});
