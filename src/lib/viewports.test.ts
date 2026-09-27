import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json?raw";
import { DESKTOP_FLOOR_HEIGHT_PX, DESKTOP_FLOOR_PX } from "./viewports";

/**
 * The window the shipped app refuses to be smaller than, read out of the file that enforces it.
 *
 * Rust owns this number and TypeScript only quotes it, so the quote is what can rot: a window
 * floor raised in `tauri.conf.json` and not here leaves every story sized to the floor at a width
 * the app can no longer be. Nothing else in the build compares the two.
 */
const win = (JSON.parse(conf) as { app: { windows: { minWidth: number; minHeight: number }[] } })
  .app.windows[0];

describe("viewport floors", () => {
  it("quotes the shipped window's own floor", () => {
    expect(DESKTOP_FLOOR_PX).toBe(win.minWidth);
    expect(DESKTOP_FLOOR_HEIGHT_PX).toBe(win.minHeight);
  });
});
