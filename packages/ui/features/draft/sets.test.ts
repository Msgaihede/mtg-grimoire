import { describe, expect, it } from "vitest";
import type { BoosterSetSummary } from "@/lib/ipc";
import { boosterSets } from "./sets";

const set = (code: string, releaseDate: string | null = "2026-01-01"): BoosterSetSummary => ({
  code,
  name: code.toUpperCase(),
  releaseDate,
});

describe("boosterSets", () => {
  const now = new Date("2026-10-29T12:00:00Z");

  it("keeps MTGJSON's booster sets out now or within a week, newest first", () => {
    const kept = boosterSets(
      [
        set("old", "2020-01-01"),
        set("new", "2026-10-20"),
        set("soon", "2026-11-05"),
        set("later", "2026-11-06"),
        set("mst", "2025-01-01"),
      ],
      now,
    );
    expect(kept.map((s) => s.code)).toEqual(["soon", "new", "mst", "old"]);
  });

  it("leaves out a set with no date, and breaks a tie by name", () => {
    const kept = boosterSets([set("und", null), set("zzz"), set("aaa")], now);
    expect(kept.map((s) => s.code)).toEqual(["aaa", "zzz"]);
  });
});
