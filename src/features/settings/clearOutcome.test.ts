import { describe, expect, it } from "vitest";
import type { ComboStatus } from "@/lib/ipc";
import {
  cacheOutcome,
  collectionOutcome,
  combosOutcome,
  decksOutcome,
  fileSize,
  wishlistOutcome,
} from "./clearOutcome";

const GIGABYTE = 1_000_000_000;

/** A settled combo table, with only the two figures the sentence reads spelled per case. */
const status = (over: Partial<ComboStatus> = {}): ComboStatus => ({
  combos: 105_478,
  cards: 7_310,
  stamp: "2026-08-27T03:12:44Z",
  fetchedAt: 1_756_000_000,
  checkedAt: 1_756_000_000,
  stale: false,
  ...over,
});

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
   * The measured library on this machine is five figures, which is why `counted` reaches for
   * `count` rather than `plural` — so the separator is the assertion here, not the noun.
   */
  it("counts the entries with thousands separators", () => {
    expect(collectionOutcome({ entries: 1284 })).toBe("Cleared 1,284 collection entries.");
  });

  it("agrees with a count of one", () => {
    expect(collectionOutcome({ entries: 1 })).toBe("Cleared 1 collection entry.");
  });

  /** Pressing Clear on an empty collection is not a mistake worth a row of zeroes. */
  it("says nothing happened rather than reporting zero", () => {
    expect(collectionOutcome({ entries: 0 })).toBe("The collection was already empty.");
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
  /**
   * **Two numbers, and it listed three until 2026-08-31.** The third was `cover image` — files
   * beside the database rather than rows, and only on a deck the reader had given a picture to.
   * Custom covers are deleted and `DecksCleared` lost the field with them, so this is now the
   * whole sentence rather than its common shape.
   */
  it("lists both when both happened", () => {
    expect(decksOutcome({ decks: 12, folders: 3 })).toBe("Cleared 12 decks and 3 folders.");
  });

  /** The plural is per number, not per sentence. */
  it("counts each number in its own words", () => {
    expect(decksOutcome({ decks: 4, folders: 1 })).toBe("Cleared 4 decks and 1 folder.");
  });

  /**
   * The asymmetry worth pinning: an empty folder tree with no decks in it is a real state, and
   * clearing it is a real thing that happened.
   */
  it("reports folders cleared even when there were no decks", () => {
    expect(decksOutcome({ decks: 0, folders: 2 })).toBe("Cleared 2 folders.");
  });

  it("says nothing happened only when nothing did", () => {
    expect(decksOutcome({ decks: 0, folders: 0 })).toBe(
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

describe("combosOutcome", () => {
  /**
   * **The figures are the table's after the download, not before it**, which is the one way this
   * sentence differs from the other four: the press refills what it emptied, and a reader who
   * cleared because a bracket readout looked wrong has come for the new numbers. Spellbook's
   * published file is five figures on the first and four on the second, which is why `counted`
   * reaches for `count` — the separators are half of what is being pinned here.
   */
  it("reports the table that came back, with separators on both figures", () => {
    expect(combosOutcome(status())).toBe(
      "Cleared and downloaded again: 105,478 combos, naming 7,310 cards between them.",
    );
  });

  /** The plural is per number, and both of them can be one. */
  it("agrees with a count of one on either figure", () => {
    expect(combosOutcome(status({ combos: 1, cards: 2 }))).toBe(
      "Cleared and downloaded again: 1 combo, naming 2 cards between them.",
    );
    expect(combosOutcome(status({ combos: 3, cards: 1 }))).toBe(
      "Cleared and downloaded again: 3 combos, naming 1 card between them.",
    );
  });

  /**
   * The arm this function exists for. A refusal never reaches here — it goes through
   * `writeFailure` and turns the banner red — but a refresh that *resolves* over an empty table
   * does, and "downloaded again: 0 combos" would report a successful download of nothing.
   */
  it("never prints a zero as though it were an answer", () => {
    const said = combosOutcome(status({ combos: 0, cards: 0, fetchedAt: null, stale: true }));

    expect(said).not.toContain("0 combos");
    expect(said).toBe(
      "The combos were cleared and the download brought none back, so the table is empty. " +
        "Errors, further down this page, has the reason.",
    );
  });
});
