import { describe, expect, it } from "vitest";
import type { OracleTagStatus } from "@/lib/ipc";
import {
  emptyTagsSentence,
  ORACLE_TAGS_NEVER_FETCHED,
  ORACLE_TAGS_UNTAGGED,
  slugsFor,
} from "./oracleTags";

const status = (ingestedAt: number | null): OracleTagStatus => ({
  updatedAt: null,
  ingestedAt,
  checkedAt: ingestedAt,
  tagCount: null,
  taggingCount: null,
  stale: false,
  refreshing: false,
});

describe("slugsFor", () => {
  it("matches the card's row by oracle id, wherever it sits in the answer", () => {
    // Catches: `rows[0]`, which is right until the first caller sends two ids.
    const rows = [
      { oracleId: "o2", slugs: ["ramp"] },
      { oracleId: "o1", slugs: ["burn", "removal"] },
    ];
    expect(slugsFor(rows, "o1")).toEqual(["burn", "removal"]);
  });

  it("answers nothing for no oracle card, no answer and no row", () => {
    expect(slugsFor([{ oracleId: "o1", slugs: ["burn"] }], null)).toEqual([]);
    expect(slugsFor(undefined, "o1")).toEqual([]);
    expect(slugsFor([], "o1")).toEqual([]);
  });
});

describe("emptyTagsSentence", () => {
  it("says the file is not here yet rather than that the card is untagged", () => {
    expect(emptyTagsSentence(status(null))).toBe(ORACLE_TAGS_NEVER_FETCHED);
    // An unanswered status is the never-fetched claim, which stays true of a database nobody
    // can read the status of.
    expect(emptyTagsSentence(undefined)).toBe(ORACLE_TAGS_NEVER_FETCHED);
  });

  it("says the card is untagged once the taxonomy is here", () => {
    expect(emptyTagsSentence(status(1_800_000_000))).toBe(ORACLE_TAGS_UNTAGGED);
  });

  it("never says the same sentence for the two", () => {
    expect(ORACLE_TAGS_NEVER_FETCHED).not.toBe(ORACLE_TAGS_UNTAGGED);
  });
});
