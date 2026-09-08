import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

/**
 * The splitter both docked columns are pulled by — `CardSearchPanel`'s left edge and the deck
 * gallery's folder tree on the opposite one.
 *
 * **It was the search panel's own until 2026-09-08, and this file is what makes the extraction
 * safe to have made.** `CardSearchPanel.test.tsx`'s splitter cases go on proving the panel still
 * behaves as it did; what they cannot prove is the half that only exists because there are two
 * callers now — `side`, which turns the drag arithmetic, the arrow keys and the strip's own edge
 * over, and `min`, which stopped being a constant this component could read for itself. Every
 * case below that names a side names **both**, because a sign error is invisible in the direction
 * it was written for.
 *
 * **Every number here is a literal computed by hand**, never {@link RESIZE_STEP_PX} re-imported
 * and added: an assertion that reads its own constant passes for whatever value that constant
 * takes, the wrong one included. The step is 24, so a press from 300 lands on 324 and it is
 * written 324.
 *
 * **jsdom lays nothing out and implements no pointer capture** — `test-setup.ts` stubs
 * `setPointerCapture`/`releasePointerCapture` to no-ops for exactly this control — so nothing
 * below measures a box. What is under test is the arithmetic, the guards and the two attributes
 * the drawing is decided by.
 */

/**
 * The handle with the width held for it, which is what every real caller does.
 *
 * `onResize` both records and commits, so a second move inside one drag is measured against the
 * width the *drag* started at rather than the one the last move produced — the difference between
 * a handle that follows the pointer and one that accelerates away from it. Nothing here clamps:
 * the clamp is the caller's, deliberately (`CardSearchPanel` holds one, `DecksPage` holds the
 * other), so a component that quietly clamped for them would be invisible in both.
 */
function harness({
  side = "right",
  width = 300,
  min = 200,
  max = 600,
}: {
  side?: "left" | "right";
  width?: number;
  min?: number;
  max?: number;
} = {}) {
  const onResize = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(width);
    return (
      <div>
        <div id="panel" />
        <ResizeHandle
          controls="panel"
          label="folders"
          width={current}
          min={min}
          max={max}
          side={side}
          onResize={(next) => {
            onResize(next);
            setCurrent(next);
          }}
        />
      </div>
    );
  }
  render(<Harness />);
  return onResize;
}

const handle = () => screen.getByRole("separator", { name: "Resize folders" });

/**
 * One pointer event with a real `clientX` on it.
 *
 * Built as a `MouseEvent` rather than through `fireEvent.pointerDown`, for the reason
 * `src/test-drag.ts` and `CardSearchPanel.test.tsx` each build their own: **jsdom ships no
 * `PointerEvent`**, so Testing Library's pointer helpers fall back to a plain `Event` and the
 * coordinate never arrives — the resize then reads `undefined` and every assertion below would be
 * about `NaN`. React dispatches on the event's **type**, not on its class.
 */
function pointer(type: string, clientX: number, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(handle(), event);
}

/** A whole drag: press at `from`, move to `to`, let go. */
function drag(from: number, to: number) {
  pointer("pointerdown", from);
  pointer("pointermove", to);
  pointer("pointerup", to);
}

describe("ResizeHandle", () => {
  /**
   * The ARIA window-splitter contract. `aria-valuenow` is the width in px — the unit the reader
   * is actually choosing — so a screen reader announcing "300" announces the number the panel is
   * drawn at, and `aria-controls` is what ties the two together.
   */
  it("reports the width in px, the range, and what it resizes", () => {
    harness();

    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuenow", "300");
    expect(handle()).toHaveAttribute("aria-valuemin", "200");
    expect(handle()).toHaveAttribute("aria-valuemax", "600");
    expect(handle()).toHaveAttribute("aria-controls", "panel");
  });

  /** A caret can reach it, which is the half a pointer-only splitter loses outright: there is no
   *  other control anywhere in the app that sets either of these widths. */
  it("is a tab stop", async () => {
    harness();

    await userEvent.tab();

    expect(handle()).toHaveFocus();
  });

  /**
   * **The pointer, on both edges.** The arithmetic turns over with `side` and nothing else does —
   * so each case drives the same gesture against both dockings and asserts the two answers are
   * mirror images. A copy-paste extraction that kept the search column's sign would pass every
   * `side: "right"` case in this file and fail its twin.
   */
  describe("the drag", () => {
    it("widens a right-docked panel as its edge is pulled left, and narrows it going right", () => {
      const onResize = harness({ side: "right" });

      drag(900, 800);
      expect(onResize).toHaveBeenLastCalledWith(400);

      drag(800, 900);
      expect(onResize).toHaveBeenLastCalledWith(300);
    });

    it("widens a left-docked panel as its edge is pulled right, and narrows it going left", () => {
      const onResize = harness({ side: "left" });

      drag(300, 400);
      expect(onResize).toHaveBeenLastCalledWith(400);

      drag(400, 300);
      expect(onResize).toHaveBeenLastCalledWith(300);
    });

    /**
     * **Measured from where the press landed, never from the last move.** A handle that added
     * each move's delta to the width it had just written would double every gesture and run away
     * from the pointer — and it would pass a one-move test, which is why this one moves twice
     * inside a single press.
     */
    it("measures the whole drag from where the press landed", () => {
      const onResize = harness({ side: "left" });

      pointer("pointerdown", 300);
      pointer("pointermove", 400);
      pointer("pointermove", 350);
      pointer("pointerup", 350);

      expect(onResize).toHaveBeenNthCalledWith(1, 400);
      expect(onResize).toHaveBeenNthCalledWith(2, 350);
    });

    /**
     * The primary button only. A right-press opening a context menu mid-drag would leave the
     * capture on and the panel following a pointer with nothing held down — so the press is
     * refused at the door rather than undone afterwards.
     */
    it("ignores a press that is not the primary button", () => {
      const onResize = harness();

      pointer("pointerdown", 900, 2);
      pointer("pointermove", 800);

      expect(onResize).not.toHaveBeenCalled();
    });

    /** An idle handle is not a handle that has forgotten a drag: a bare move over it, with
     *  nothing ever pressed, resizes nothing. */
    it("ignores a move with no press behind it", () => {
      const onResize = harness();

      pointer("pointermove", 800);

      expect(onResize).not.toHaveBeenCalled();
    });

    it("stops following the pointer once it has been let go", () => {
      const onResize = harness();

      drag(900, 800);
      expect(onResize).toHaveBeenCalledTimes(1);

      pointer("pointermove", 700);

      expect(onResize).toHaveBeenCalledTimes(1);
    });

    /**
     * **A cancelled pointer is an ended drag, not a dropped one.** The OS takes the gesture, or a
     * touch turns into a scroll, and no `pointerup` ever arrives — so without this the handle
     * stays armed and the *next* ordinary move over it, with nothing held down at all, drags the
     * panel. That is the failure this case is for, and it is only visible one gesture later.
     */
    it("disarms on a cancelled pointer, so the next plain move over it does nothing", () => {
      const onResize = harness();

      pointer("pointerdown", 900);
      fireEvent(handle(), new MouseEvent("pointercancel", { bubbles: true, cancelable: true }));
      onResize.mockClear();

      pointer("pointermove", 700);

      expect(onResize).not.toHaveBeenCalled();
    });
  });

  /**
   * The keyboard half, which is not an extra: a caret cannot perform a drag, and a resize only a
   * pointer can reach is a layout choice taken away from anyone who does not use one.
   */
  describe("the keys", () => {
    /**
     * **Docked right, Left widens.** The key moves the *separator* — which is what the role says
     * this is — rather than moving a value that happens to be a width, so it matches the pointer
     * on whichever edge the panel is against.
     */
    it("steps a right-docked panel wider with Left and narrower with Right", async () => {
      const onResize = harness({ side: "right" });
      handle().focus();

      await userEvent.keyboard("{ArrowLeft}");
      expect(onResize).toHaveBeenLastCalledWith(324);

      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      expect(onResize).toHaveBeenLastCalledWith(276);
    });

    /**
     * **And docked left it is the other way round**, which is the one thing about this component
     * that has no witness on the search column at all: every arrow assertion that existed before
     * the extraction was written against a panel on the right, so a `side` that did not reach the
     * key handler would pass all of them and send the folder tree the wrong way.
     */
    it("steps a left-docked panel wider with Right and narrower with Left", async () => {
      const onResize = harness({ side: "left" });
      handle().focus();

      await userEvent.keyboard("{ArrowRight}");
      expect(onResize).toHaveBeenLastCalledWith(324);

      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(onResize).toHaveBeenLastCalledWith(276);
    });

    /** The two ends of the range. They are the props rather than anything this component knows:
     *  `min` stopped being a constant in here the moment a second panel measured its floor from
     *  something other than one card's width. */
    it("jumps to either end of the range with Home and End", async () => {
      const onResize = harness({ side: "right", min: 200, max: 600 });
      handle().focus();

      await userEvent.keyboard("{Home}");
      expect(onResize).toHaveBeenLastCalledWith(200);

      await userEvent.keyboard("{End}");
      expect(onResize).toHaveBeenLastCalledWith(600);
    });

    /**
     * **And they do not turn over with the side**, which is the asymmetry worth pinning: Home is
     * the narrowest a panel may be on either edge, a fact about the range rather than about which
     * way the reader is pushing. A `side` threaded through the whole key handler by mistake would
     * make End the floor here.
     */
    it("keeps Home at the floor and End at the ceiling on a left-docked panel", async () => {
      const onResize = harness({ side: "left", min: 150, max: 500 });
      handle().focus();

      await userEvent.keyboard("{Home}");
      expect(onResize).toHaveBeenLastCalledWith(150);

      await userEvent.keyboard("{End}");
      expect(onResize).toHaveBeenLastCalledWith(500);
    });

    /**
     * **Every key it acts on is a key the page must not also act on.** The arrows scroll a
     * scroller otherwise, and Home and End take it to its ends — so the reader's caret would
     * resize the panel *and* throw the list behind it to the bottom. `fireEvent` answers `false`
     * for a cancelled event, which is the only way to see a `preventDefault` from out here.
     */
    it("takes the four keys it acts on away from the page", () => {
      harness();

      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
        expect(fireEvent.keyDown(handle(), { key })).toBe(false);
      }
    });

    /** And leaves every other key alone — a Tab out of the splitter, or a Space the page has its
     *  own use for, is not this control's to swallow. */
    it("leaves a key it does not act on to the page", () => {
      const onResize = harness();

      expect(fireEvent.keyDown(handle(), { key: "ArrowUp" })).toBe(true);
      expect(fireEvent.keyDown(handle(), { key: "PageDown" })).toBe(true);
      expect(onResize).not.toHaveBeenCalled();
    });
  });

  /**
   * Which edge the strip is drawn over — the third and last thing `side` decides.
   *
   * A class assertion, which is honest here for the reason `FolderTree.test.tsx`'s root trunk is:
   * jsdom applies no stylesheet, so the *effect* is unreachable and the choice is all there is to
   * pin. `classList.contains` rather than `toHaveClass` on a string built from the side, so the
   * assertion cannot pass by matching a class the element merely also has.
   */
  describe("which edge it straddles", () => {
    it("sits over a right-docked panel's left hairline", () => {
      harness({ side: "right" });

      expect(handle().classList.contains("-left-1")).toBe(true);
      expect(handle().classList.contains("-right-1")).toBe(false);
    });

    it("sits over a left-docked panel's right hairline", () => {
      harness({ side: "left" });

      expect(handle().classList.contains("-right-1")).toBe(true);
      expect(handle().classList.contains("-left-1")).toBe(false);
    });
  });
});
