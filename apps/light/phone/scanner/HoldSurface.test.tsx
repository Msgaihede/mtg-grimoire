import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HoldSurface } from "./HoldSurface";

/** The surface alone, its two callbacks watched. */
function surface(shooting = false) {
  const props = { shooting, onHold: vi.fn(), onTap: vi.fn() };
  const view = render(<HoldSurface {...props} />);
  return { ...props, view, press: screen.getByRole("button", { name: "Hold to scan" }) };
}

describe("the picture, held", () => {
  it("is a named press over the whole picture, saying whether a hold is running", () => {
    const { press, view } = surface();
    expect(press).toHaveAttribute("aria-pressed", "false");
    // Over the whole box, and nothing a platform's long press can start under the finger.
    expect(press).toHaveClass("absolute", "inset-0", "touch-none", "select-none");
    // The box clips, so the keyboard's outline is drawn inside the edge.
    expect(press).toHaveClass("focus-visible:-outline-offset-2");
    view.rerender(<HoldSurface shooting onHold={vi.fn()} onTap={vi.fn()} />);
    expect(press).toHaveAttribute("aria-pressed", "true");
  });

  it("reads while a finger is down, and stops as it lifts, is cancelled or loses its capture", () => {
    const { press, onHold, onTap } = surface();
    fireEvent.pointerDown(press, { pointerId: 1 });
    expect(onHold).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(press, { pointerId: 1 });
    expect(onHold).toHaveBeenLastCalledWith(false);
    // A finger taken away by the system ends the hold too.
    fireEvent.pointerDown(press, { pointerId: 2 });
    fireEvent.pointerCancel(press, { pointerId: 2 });
    expect(onHold).toHaveBeenLastCalledWith(false);
    // So does the capture going: the browser took the pointer somewhere else.
    fireEvent.pointerDown(press, { pointerId: 3 });
    fireEvent.lostPointerCapture(press, { pointerId: 3 });
    expect(onHold).toHaveBeenLastCalledWith(false);
    // The pointer's own click after a hold is not a second press.
    fireEvent.click(press, { detail: 1 });
    expect(onTap).not.toHaveBeenCalled();
  });

  it("ends a hold when the caret leaves it — a sheet opening over the page", () => {
    const { press, onHold } = surface();
    press.focus();
    fireEvent.pointerDown(press, { pointerId: 1 });
    expect(onHold).toHaveBeenLastCalledWith(true);
    fireEvent.blur(press);
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  it("takes no hold from a press of any button but the first", () => {
    const { press, onHold } = surface();
    fireEvent.pointerDown(press, { pointerId: 1, button: 2 });
    expect(onHold).not.toHaveBeenCalled();
  });

  it("holds on Space, and takes a press with no finger behind it as one card's tap", () => {
    const { press, onHold, onTap } = surface();
    fireEvent.keyDown(press, { key: " " });
    expect(onHold).toHaveBeenLastCalledWith(true);
    // A key held down repeats; the hold is one.
    fireEvent.keyDown(press, { key: " ", repeat: true });
    expect(onHold).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(press, { key: " " });
    expect(onHold).toHaveBeenLastCalledWith(false);
    // Space's own click on release is the hold's, not a tap.
    fireEvent.click(press, { detail: 0 });
    expect(onTap).not.toHaveBeenCalled();
    // Assistive tech's activation (and Enter): no pointer, so one card's shot.
    fireEvent.click(press, { detail: 0 });
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("keeps the platform's context menu off the picture", () => {
    const { press } = surface();
    // `fireEvent` answers `false` when a handler took the event's default.
    expect(fireEvent.contextMenu(press)).toBe(false);
  });
});
