import { describe, expect, it } from "vitest";
import { ago, daysSince } from "./relativeTime";

/** A round number of seconds, so a test reads as "N ago" rather than as arithmetic. */
const AT = 1_800_000_000;
const NOW = AT * 1000; // ms

const at = (secondsAgo: number) => ago(AT - secondsAgo, NOW);

describe("ago", () => {
  it("counts up through minutes, hours and days", () => {
    expect(at(0)).toBe("just now");
    expect(at(59)).toBe("just now");
    expect(at(60)).toBe("1 minute ago");
    expect(at(120)).toBe("2 minutes ago");
    expect(at(3_599)).toBe("59 minutes ago");
    expect(at(3_600)).toBe("1 hour ago");
    expect(at(86_399)).toBe("23 hours ago");
    expect(at(86_400)).toBe("1 day ago");
    expect(at(172_800)).toBe("2 days ago");
  });

  /**
   * The whole reason this file exists. Two of the three formatters that now delegate here
   * rounded, so ninety minutes read `2 hours ago` on the same Settings page an hour and a
   * half of errors was reported as `1 hour ago`. Floor is "the coarsest unit that is still
   * true", which is `MarketplacePanel`'s argument applied to all three.
   */
  it("floors at every rung — ninety minutes is one hour, not two", () => {
    expect(at(90 * 60)).toBe("1 hour ago");
    expect(at(45)).toBe("just now");
    expect(at(59 * 60 + 59)).toBe("59 minutes ago");
    expect(at(36 * 3_600)).toBe("1 day ago");
    expect(at(7 * 86_400 + 43_200)).toBe("7 days ago");
  });

  /** A clock that moved backwards, or a stamp from the future. Never "in -3 minutes". */
  it("does not count backwards", () => {
    expect(at(-500)).toBe("just now");
    expect(at(-90_000)).toBe("just now");
  });
});

describe("daysSince", () => {
  /** The same floored count `ago`'s day arm prints, so a cut-off and the sentence it gates
   *  cannot disagree about which side of a week something is on. */
  it("is the count ago would have printed", () => {
    expect(daysSince(AT - 86_399, NOW)).toBe(0);
    expect(daysSince(AT - 86_400, NOW)).toBe(1);
    expect(daysSince(AT - 7 * 86_400 - 43_200, NOW)).toBe(7);
    expect(daysSince(AT - 8 * 86_400, NOW)).toBe(8);
  });
});
