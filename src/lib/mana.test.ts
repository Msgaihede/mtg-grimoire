import { describe, expect, it } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";
import { MANA_KEYS, MANA_LINE_GRADIENT, manaLineSync, manaSymbolClass } from "@/lib/mana";

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "ingesting",
  done: 0,
  total: 0,
  message: null,
  ...over,
});

describe("manaSymbolClass", () => {
  /** `mana-font` keys its glyphs on lowercase letters; the app spells colours WUBRG. */
  it("names the mana-font glyph for every chip, colourless included", () => {
    expect(manaSymbolClass("W")).toBe("ms ms-w");
    expect(manaSymbolClass("C")).toBe("ms ms-c");
    expect(MANA_KEYS).toHaveLength(6);
  });
});

describe("MANA_LINE_GRADIENT", () => {
  /** The signature element. Five colours, in WUBRG order, and no colourless — the line is
   *  the colour pie, not the filter row. */
  it("runs W→U→B→R→G in order", () => {
    const order = [
      "--color-mana-w",
      "--color-mana-u",
      "--color-mana-b",
      "--color-mana-r",
      "--color-mana-g",
    ];
    const positions = order.map((token) => MANA_LINE_GRADIENT.indexOf(token));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(MANA_LINE_GRADIENT).not.toContain("--color-mana-c");
  });
});

describe("manaLineSync", () => {
  it("is null when nothing is running — the line is then just the line", () => {
    expect(manaLineSync(null, false)).toBeNull();
    expect(manaLineSync(event({ phase: "ingesting", done: 5, total: 10 }), false)).toBeNull();
  });

  it("reports a fraction when the phase has a denominator", () => {
    const sync = manaLineSync(event({ phase: "downloading", done: 5, total: 10 }), true);

    expect(sync?.value).toBe(0.5);
    expect(sync?.label).toMatch(/downloading/i);
  });

  /**
   * `checking` and `sets` carry no total, and a run throttled by the 24 h window emits no
   * event at all while `sync_run` is still in flight. Both are "busy, length unknown" —
   * a `value` of 0 would claim no progress had been made.
   */
  it("is indeterminate when the phase has no denominator, and while no event has arrived", () => {
    expect(manaLineSync(event({ phase: "checking" }), true)?.value).toBeNull();
    expect(manaLineSync(null, true)?.value).toBeNull();
  });

  it("treats a finished or failed run as not running", () => {
    expect(manaLineSync(event({ phase: "done", done: 9, total: 9 }), true)?.value).toBeNull();
    expect(manaLineSync(event({ phase: "error" }), true)?.value).toBeNull();
  });

  it("never runs past the end", () => {
    expect(manaLineSync(event({ phase: "ingesting", done: 130_000, total: 117_000 }), true)?.value).toBe(
      1,
    );
  });
});
