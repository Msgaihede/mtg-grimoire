import { describe, expect, it } from "vitest";
import type { ScannerTrayRow } from "@/lib/ipc";
import scansoundsRs from "../../../../../crates/grimoire-core/src/scansounds.rs?raw";
import { landedFrom } from "../reader/AddedToast";
import {
  DEFAULT_SCAN_SOUNDS,
  ladderRefusal,
  landingNeedsInput,
  settledRows,
  soundForPrice,
  TIERS_MUST_CLIMB,
} from "./scanSounds";

const row: ScannerTrayRow = {
  key: "a",
  cardId: "ltr-426",
  oracleId: "oliphaunt",
  name: "Oliphaunt",
  setCode: "ltr",
  collectorNumber: "426",
  finish: "nonfoil",
  finishes: ["nonfoil", "foil"],
  quantity: 1,
  choices: [],
  addedAt: 1_000,
};

const choice = {
  cardId: "mt-1",
  oracleId: "minas",
  name: "Minas Tirith",
  setCode: "ltr",
  collectorNumber: "256",
};

describe("soundForPrice", () => {
  it("plays the highest floor a price reaches, each floor inclusive", () => {
    const at = (price: number | null) => soundForPrice(price, DEFAULT_SCAN_SOUNDS);
    expect(at(null)).toBe("ok");
    expect(at(0.99)).toBe("ok");
    expect(at(1)).toBe("tier1");
    expect(at(9.99)).toBe("tier1");
    expect(at(10)).toBe("tier2");
    expect(at(150)).toBe("tier3");
    expect(at(1000)).toBe("jackpot");
    expect(at(25_000)).toBe("jackpot");
  });

  it("follows the reader's own ladder", () => {
    const ladder = { enabled: true, tier1: 0.5, tier2: 2, tier3: 20, jackpot: 50 };
    expect(soundForPrice(0.6, ladder)).toBe("tier1");
    expect(soundForPrice(60, ladder)).toBe("jackpot");
  });
});

describe("landingNeedsInput", () => {
  it("asks for a pick and for an unknown finish, and nothing else", () => {
    expect(landingNeedsInput(landedFrom(row, false, false))).toBe(false);
    expect(landingNeedsInput(landedFrom({ ...row, finish: "unknown" }, false, false))).toBe(true);
    expect(landingNeedsInput(landedFrom({ ...row, choices: [choice] }, false, false))).toBe(true);
  });
});

describe("settledRows", () => {
  it("finds a row whose finish the reader named", () => {
    const before = [{ ...row, finish: "unknown" as const }];
    expect(settledRows(before, [row])).toEqual([row]);
  });

  it("finds a row whose printing the reader picked", () => {
    const before = [{ ...row, choices: [choice] }];
    expect(settledRows(before, [row])).toEqual([row]);
  });

  it("is not a landing, a row still asking, or a row that never asked", () => {
    // A second opinion that settled it is a landing: the stamp moved.
    expect(settledRows([{ ...row, finish: "unknown" }], [{ ...row, addedAt: 2_000 }])).toEqual([]);
    // A printing picked with the finish still to name asks something still.
    expect(
      settledRows(
        [{ ...row, finish: "unknown", choices: [choice] }],
        [{ ...row, finish: "unknown" }],
      ),
    ).toEqual([]);
    expect(settledRows([row], [{ ...row, quantity: 2 }])).toEqual([]);
    // A new row landed; it settled nothing.
    expect(settledRows([], [row])).toEqual([]);
  });
});

describe("the ladder", () => {
  it("refuses one that does not climb, in the crate's words", () => {
    expect(ladderRefusal(DEFAULT_SCAN_SOUNDS)).toBeNull();
    expect(ladderRefusal({ ...DEFAULT_SCAN_SOUNDS, tier2: 1 })).toBe(TIERS_MUST_CLIMB);
    expect(ladderRefusal({ ...DEFAULT_SCAN_SOUNDS, jackpot: 99 })).toBe(TIERS_MUST_CLIMB);
    expect(ladderRefusal({ ...DEFAULT_SCAN_SOUNDS, tier1: 0 })).toBe(TIERS_MUST_CLIMB);
    expect(ladderRefusal({ ...DEFAULT_SCAN_SOUNDS, tier3: Number.NaN })).toBe(TIERS_MUST_CLIMB);
  });

  /** The page and the crate say one sentence and start from one ladder. */
  it("agrees with scansounds.rs", () => {
    expect(scansoundsRs.length, "scansounds.rs was not read").toBeGreaterThan(1_000);
    expect(scansoundsRs.replace(/\s+/g, " ")).toContain(`"${TIERS_MUST_CLIMB}"`);
    const defaults = /fn default\(\) -> ScanSounds \{([\s\S]*?)\n {4}\}/.exec(scansoundsRs)?.[1];
    expect(defaults, "ScanSounds::default() was not found").toBeDefined();
    expect(defaults).toContain(`enabled: ${String(DEFAULT_SCAN_SOUNDS.enabled)},`);
    for (const tier of ["tier1", "tier2", "tier3", "jackpot"] as const) {
      expect(defaults).toContain(`${tier}: ${DEFAULT_SCAN_SOUNDS[tier].toFixed(1)},`);
    }
  });
});
