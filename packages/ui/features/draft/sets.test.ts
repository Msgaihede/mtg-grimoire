import { describe, expect, it } from "vitest";
import type { SetSummary } from "@/lib/ipc";
import { boosterSets } from "./sets";

const set = (code: string, over: Partial<SetSummary> = {}): SetSummary => ({
  code,
  name: code.toUpperCase(),
  setType: "expansion",
  releasedAt: "2026-01-01",
  cardCount: 100,
  ...over,
});

describe("boosterSets", () => {
  const now = new Date("2026-10-29T12:00:00Z");

  it("keeps booster set types, out now or within a week, newest first", () => {
    const kept = boosterSets(
      [
        set("old", { releasedAt: "2020-01-01" }),
        set("new", { releasedAt: "2026-10-20" }),
        set("soon", { releasedAt: "2026-11-05" }),
        set("later", { releasedAt: "2026-11-06" }),
        set("mst", { setType: "masters", releasedAt: "2025-01-01" }),
        set("unknown", { setType: null, releasedAt: "2024-01-01" }),
      ],
      now,
    );
    expect(kept.map((s) => s.code)).toEqual(["soon", "new", "mst", "unknown", "old"]);
  });

  it("leaves out sets with no boosters, no printings or no date", () => {
    const kept = boosterSets(
      [
        set("alc", { setType: "alchemy" }),
        set("tok", { setType: "token" }),
        set("prm", { setType: "promo" }),
        set("emp", { cardCount: 0 }),
        set("und", { releasedAt: null }),
        set("ok"),
      ],
      now,
    );
    expect(kept.map((s) => s.code)).toEqual(["ok"]);
  });
});
