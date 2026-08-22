import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchoredPopup } from "./AnchoredPopup";

/**
 * The shell two controls share — the search wall's quick-add and the wishlist's edit — and the
 * one thing about it that is neither the caller's contents nor the two ways it closes: **when
 * the panel is scrolled to.**
 *
 * `EditWish.test.tsx` and `AddToCollection.test.tsx` drive the shell through their own bodies and
 * cover the dismissal ladder between them. What is here is the ordering those two cannot see,
 * because it is the same on every caller and it is about a frame rather than about a control.
 *
 * **The geometry is not testable here and the suite must not pretend otherwise.** jsdom
 * implements neither scrolling nor layout — `scrollIntoView` is simply absent, which is why the
 * component calls it optionally and why this file has to install one to watch. What can be pinned
 * is the *shape* of the fix: the caret moves on the first render and the browser is told not to
 * scroll for it, and the scroll happens on its own once the entry tween has finished. Where the
 * panel actually lands stays a live pass's to settle.
 */
const scrollIntoView = vi.fn();

/** A minimal caller: the shell's props, and one focusable thing inside for Tab to reach. */
function popup() {
  return render(
    <AnchoredPopup
      label="Edit Lightning Bolt"
      panelLabel="Edit Lightning Bolt on your wishlist"
      icon={<span aria-hidden="true">✎</span>}
    >
      <button type="button">Remove</button>
    </AnchoredPopup>,
  );
}

const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Edit Lightning Bolt" }));
  return screen.findByRole("dialog", { name: "Edit Lightning Bolt on your wishlist" });
};

beforeEach(() => {
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  // Back to jsdom's own answer, which is that there is no such method — the state every other
  // suite in this repo runs in, and the reason the call site is optional.
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

describe("AnchoredPopup", () => {
  /**
   * **The caret moves on the render that mounts the panel, and the browser is told not to scroll
   * for it.** Both halves matter and they pull opposite ways: a focus deferred to the end of the
   * tween would send a reader's immediate Tab into the list behind, and a focus that scrolls
   * computes that scroll against a box `popup` still has at `scale: 0.96` with a top origin —
   * 4% short, all of it at the bottom, and nothing scrolls again once the tween ends.
   */
  it("focuses the panel at once and keeps the browser from scrolling to it", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    popup();

    const panel = await open();

    expect(panel).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  /**
   * And the scroll happens on its own, once the panel is at full scale.
   *
   * **This is what replaced a `scroll-mb-4`, and the replacement is not a bigger version of it.**
   * A scroll margin asks the browser to scroll *further*; what was wrong was the maximum it
   * clamps to, which the scaled panel itself caps — measured in the shipped window, raising the
   * margin from 16px to 400px moved the landing `scrollTop` by nothing at all. So the fix is to
   * not scroll while the panel is short, rather than to ask for more scroll.
   */
  it("scrolls the panel into view once the entry animation has settled", async () => {
    popup();
    await open();

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  });

  /**
   * **Nothing scrolls on the way out.** `onAnimationComplete` fires for the exit too, and a panel
   * leaving has already handed the caret back to its trigger — scrolling to it then would drag
   * the list under whatever the reader has moved on to. `useIsPresent` is the guard.
   */
  it("does not scroll to a panel that is closing", async () => {
    popup();
    await open();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit Lightning Bolt on your wishlist" }),
      ).not.toBeInTheDocument(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
