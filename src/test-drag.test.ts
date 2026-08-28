import { describe, expect, it, vi } from "vitest";
import { pointerDrag } from "@/test-drag";

/** jsdom measures everything as 0×0, so a test that needs geometry must supply it. */
function boxed(x: number, y: number, w = 100, h = 40): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width: w,
      height: h,
      top: y,
      left: x,
      right: x + w,
      bottom: y + h,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe("pointerDrag", () => {
  it("fires a pointerdown on the source and a pointerup at the target's centre", async () => {
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const down = vi.fn();
    const up = vi.fn();
    from.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);

    await pointerDrag(from, to);

    expect(down).toHaveBeenCalledTimes(1);
    const evt = up.mock.calls[0][0] as PointerEvent;
    expect(evt.clientX).toBe(50);
    expect(evt.clientY).toBe(220);
  });

  it("moves through intermediate points so a distance threshold is crossed", async () => {
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const moves: number[] = [];
    document.addEventListener("pointermove", (e) => moves.push((e as PointerEvent).clientY));

    await pointerDrag(from, to, { steps: 5 });

    expect(moves.length).toBeGreaterThanOrEqual(5);
    // Monotonic and ending at the target's centre: a library watching for a threshold or a
    // direction must see a real gesture, not a teleport.
    // `moves.at(-1)` would read better and does not type-check: this project's `lib` predates
    // `Array.prototype.at`.
    expect(moves[moves.length - 1]).toBe(220);
    expect([...moves].sort((a, b) => a - b)).toEqual(moves);
  });

  it("settles at the destination before letting go", async () => {
    // `dragOperation.position.current` lags one `pointermove` behind — the sensor batches
    // through its own scheduler — so a drag that stops the instant it arrives has never been
    // over the target as far as dnd-kit is concerned. Measured 2026-08-27; the whole reading is
    // in docs/reference/frontend-design.md.
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const moves: number[] = [];
    document.addEventListener("pointermove", (e) => moves.push((e as PointerEvent).clientY));

    await pointerDrag(from, to, { steps: 4 });

    expect(moves.filter((y) => y === 220).length).toBeGreaterThanOrEqual(2);
  });

  it("holds the primary button down for the whole gesture and releases it", async () => {
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const buttons: number[] = [];
    document.addEventListener("pointermove", (e) => buttons.push((e as PointerEvent).buttons));
    const up = vi.fn();
    document.addEventListener("pointerup", up);

    await pointerDrag(from, to, { steps: 3 });

    expect(buttons.every((b) => b === 1)).toBe(true);
    expect((up.mock.calls[0][0] as PointerEvent).buttons).toBe(0);
  });
});
