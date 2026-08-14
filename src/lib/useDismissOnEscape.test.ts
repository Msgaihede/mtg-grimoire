import { renderHook } from "@testing-library/react";
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

  /**
   * The one test here that fails against the hook as it was. Measured on the pre-fix hook:
   * `first` was called and `second` was not — two `"inner"` peers were ordered by registration
   * alone, and because the capture rung checks `defaultPrevented` too, the *older* layer ate
   * the press and the newest one — the thing the reader had just opened — was starved. A menu
   * over a dialog would have closed the dialog.
   */
  it("gives the press to the most recently mounted capture layer, not the first", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

    expect(pressEscape()).toBe(true);

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  /** One press each, in order, is the whole point — the layer below has to still be listening. */
  it("hands the press back down when the top layer unmounts", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
    const top = renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

    top.unmount();

    expect(pressEscape()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
  });

  /**
   * A guard, not a driver: this passes against the pre-fix hook too, because capture already
   * beats bubble whoever registered first. What it pins is that the *stack* did not break it —
   * an `"outer"` layer must stay off the capture stack entirely. Push every layer instead of
   * only the capture ones and this flips: the outer layer, mounted second, would be on top, the
   * inner one would stand down, and the pane would close under the open popup.
   */
  it("still lets an inner layer beat an outer one whatever the mount order", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: inner }));
    renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));

    expect(pressEscape()).toBe(true);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  /** Also a guard. A closed layer that still held the top of the stack would swallow every
   *  press for the layer below it — the `enabled` early return has to come before the push. */
  it("a disabled layer is not on the stack", () => {
    const enabled = vi.fn();
    const disabled = vi.fn();
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: enabled }));
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: disabled, enabled: false }));

    expect(pressEscape()).toBe(true);

    expect(enabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
  });

  /**
   * `onDismiss` is latched in a ref, so a re-render cannot re-seat a layer on the stack.
   *
   * This is the failure the ref exists to prevent, and it is one no call site can be trusted to
   * avoid: stability is transitive through props, so a layer that memoises its own closer
   * correctly is still unstable if the `onDismiss` it was handed is. While the callback was an
   * effect dependency, the re-render below popped the lower layer's token and pushed a fresh one
   * on top of the layer above it, and this press closed the wrong window.
   */
  it("keeps its place on the stack when its callback identity changes", () => {
    const below = vi.fn();
    const top = vi.fn();
    const lower = renderHook(
      ({ onDismiss }: { onDismiss: () => void }) =>
        useDismissOnEscape({ layer: "inner", onDismiss }),
      { initialProps: { onDismiss: () => below() } },
    );
    renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: top }));

    lower.rerender({ onDismiss: () => below() });

    expect(pressEscape()).toBe(true);
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  /** The other half of the latch: dropping the dependency must not pin the callback the layer
   *  mounted with, or a close handler would act on the state it was born in. */
  it("calls the callback it was last rendered with, not the one it mounted with", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const layer = renderHook(
      ({ onDismiss }: { onDismiss: () => void }) =>
        useDismissOnEscape({ layer: "inner", onDismiss }),
      { initialProps: { onDismiss: stale as () => void } },
    );

    layer.rerender({ onDismiss: fresh as () => void });

    expect(pressEscape()).toBe(true);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
