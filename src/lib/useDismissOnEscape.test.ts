import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDismissOnEscape } from "./useDismissOnEscape";

/**
 * Fires a real Escape at `document.body` and reports whether anything consumed it.
 *
 * A real event rather than a spied listener, because the whole contract is about *phases*
 * and `defaultPrevented`, and neither of those exists on a mock.
 */
function pressEscape(): boolean {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("useDismissOnEscape", () => {
  /**
   * The reason capture is not a detail. Two `window` listeners for one event run in
   * *registration* order, and the outer layer is always the one registered first — the
   * pane has been open since before the popup inside it existed. Mounted in that order
   * here on purpose: with both in the bubble phase the pane would win, and a single press
   * would close the popup the reader opened *and* the card underneath it.
   */
  it("dismisses only the inner layer, even though the outer one registered first", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: inner }));

    expect(pressEscape()).toBe(true);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  /** With nothing open over it, the outer layer is the one that answers. */
  it("dismisses the outer layer when no inner layer consumed the press", () => {
    const outer = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));

    expect(pressEscape()).toBe(true);

    expect(outer).toHaveBeenCalledTimes(1);
  });

  /**
   * `enabled` is the layer's own "am I open" flag, and a closed popup that still answered
   * Escape would eat the press the pane behind it was waiting for.
   */
  it("ignores the key while the layer is disabled, and releases it to the layer below", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: inner, enabled: false }));

    pressEscape();

    expect(inner).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  /** Every other key belongs to whatever has the caret. */
  it("leaves other keys alone", () => {
    const onDismiss = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss }));

    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * Unmounting has to take the listener with it — in the phase it was added in. A
   * `removeEventListener` that omits the capture flag removes nothing, and the layer goes
   * on eating Escape after it is gone.
   */
  it("stops listening when the layer unmounts", () => {
    const onDismiss = vi.fn();
    const { unmount } = renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss }));

    unmount();

    expect(pressEscape()).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("gives the press to the most recently mounted capture layer, not the first", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

    fireEvent.keyDown(window, { key: "Escape" });

    // Two `"inner"` peers used to be ordered by registration alone, and this is the direction
    // that got wrong: measured on the pre-fix hook, `first` was called and `second` was not —
    // the newest layer, the one the reader had just opened, was the one starved. The stack
    // orders them.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("hands the press back down when the top layer unmounts", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
    const top = renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

    top.unmount();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(first).toHaveBeenCalledTimes(1);
  });

  it("still lets an inner layer beat an outer one whatever the mount order", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    // The outer layer mounts *second* here — the pane-then-popup order is covered above; this
    // is the reverse, which registration order alone would get wrong.
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: inner }));
    renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("a disabled layer is not on the stack", () => {
    const enabled = vi.fn();
    const disabled = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: enabled }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: disabled, enabled: false }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(enabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
  });
});
