import { describe, expect, it } from "vitest";
import { PANEL_GAP, VIEWPORT_GUTTER, placeDropdown } from "./place";

/** A 1280x800 window with a 120px-wide trigger at (100, 200). */
const base = {
  trigger: { left: 100, top: 200, right: 220, bottom: 236 },
  panel: { width: 200, height: 300 },
  viewport: { width: 1280, height: 800 },
  align: "start" as const,
};

describe("placeDropdown", () => {
  it("opens below and left-aligned when there is room for both", () => {
    expect(placeDropdown(base)).toEqual({
      left: 100,
      top: 236 + PANEL_GAP,
      flipX: false,
      flipY: false,
    });
  });

  it("right-aligns when the panel would run past the right edge", () => {
    // Trigger near the right edge: 1200 + 200 = 1400 > 1280 - 8.
    const at = { ...base, trigger: { left: 1200, top: 200, right: 1260, bottom: 236 } };
    const out = placeDropdown(at);
    expect(out.flipX).toBe(true);
    // Pinned by the trigger's RIGHT edge, which is the corner it then grows from.
    expect(out.left).toBe(1260 - 200);
  });

  it("honours align=end as the first guess even with room on both sides", () => {
    const out = placeDropdown({ ...base, align: "end" });
    expect(out.flipX).toBe(true);
    expect(out.left).toBe(220 - 200);
  });

  it("opens above when there is no room below", () => {
    // bottom 700 + gap + 300 = 1004 > 800 - 8, and 700 has more room above than below.
    const at = { ...base, trigger: { left: 100, top: 664, right: 220, bottom: 700 } };
    const out = placeDropdown(at);
    expect(out.flipY).toBe(true);
    expect(out.top).toBe(664 - PANEL_GAP - 300);
  });

  it("stays below when neither side fits and below has more room", () => {
    // A 700px panel in an 800px window: 100px above the trigger, 564px below.
    const at = { ...base, panel: { width: 200, height: 700 } };
    const out = placeDropdown(at);
    expect(out.flipY).toBe(false);
    expect(out.top).toBe(236 + PANEL_GAP);
  });

  it("never places the panel past the left gutter", () => {
    // A trigger at the very left with align=end would pin the panel at a negative left.
    const at = {
      ...base,
      trigger: { left: 4, top: 200, right: 60, bottom: 236 },
      align: "end" as const,
    };
    expect(placeDropdown(at).left).toBe(VIEWPORT_GUTTER);
  });

  it("never places the panel past the top gutter", () => {
    const at = { ...base, trigger: { left: 100, top: 10, right: 220, bottom: 46 } };
    const tall = { ...at, panel: { width: 200, height: 790 } };
    expect(placeDropdown(tall).top).toBeGreaterThanOrEqual(VIEWPORT_GUTTER);
  });

  it("clamps to the top gutter when the flipped-up panel is taller than the room above", () => {
    // Bottom-anchored trigger, so flipY is genuinely true: roomAbove 700 beats roomBelow 64.
    // The panel is then taller than the room it flipped into — `above` computes to -24 — and the
    // clamp is the only thing between that and a panel drawn off the top of the window.
    const at = {
      ...base,
      trigger: { left: 100, top: 700, right: 220, bottom: 736 },
      panel: { width: 200, height: 720 },
    };
    const out = placeDropdown(at);
    expect(out.flipY).toBe(true);
    expect(out.top).toBe(VIEWPORT_GUTTER);
  });

  it("clamps a panel wider than the window to the left gutter", () => {
    // Neither edge fits, so neither flip helps: the panel has no correct edge and takes the one a
    // reader's eye starts at. Without the upper bound this would sit at the trigger's own left.
    const at = { ...base, panel: { width: 1400, height: 300 } };
    expect(placeDropdown(at).left).toBe(VIEWPORT_GUTTER);
  });
});
