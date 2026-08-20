import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  TooltipProvider,
  TOOLTIP_BRIDGE_MS,
  TOOLTIP_OPEN_MS,
  TOOLTIP_PANEL_ID,
  TOOLTIP_WARM_MS,
} from "./TooltipProvider";
import { TooltipPanel } from "./TooltipPanel";
import { useTooltip, type TooltipOptions } from "./useTooltip";

/**
 * Captured before any test's `vi.useFakeTimers()` ever runs, while `setTimeout` and `Date.now`
 * are still real.
 *
 * `motion`'s frame scheduler (`motion-dom`'s `createRenderBatcher`) closes over
 * `requestAnimationFrame` once, at module load — which happens when this file's imports resolve,
 * before the first `beforeEach`. `vi.advanceTimersByTime` can never reach that closed-over
 * reference, so an `AnimatePresence` exit's `onExitComplete` — which is what actually removes the
 * panel from the document — never fires on the fake clock alone, even with
 * `MotionGlobalConfig.skipAnimations` (verified with a two-line `AnimatePresence` reproduction
 * with no tooltip code involved: the exiting node lands on its exit target's styles and then just
 * sits there). One real wait, using the references captured here rather than the ones
 * `vi.useFakeTimers()` later replaces, gives that stale closure the actual clock tick it is
 * waiting on — without moving the *fake* `Date.now()` the warm-period logic reads.
 */
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

/**
 * Polls for the exiting panel's real removal rather than sleeping a fixed span. A single fixed
 * wait is exactly the shape of flake this repo's own history warns about — a wait sized for an
 * idle machine is a wait that is too short under `npm run verify`'s load — so this checks every
 * 20ms and returns as soon as the node is gone, spending the full ~400ms budget only when it
 * never disappears (a real failure, which the assertion after this call is what catches it).
 * Wrapped in `act()`: the removal is a React commit driven by `motion`'s real callback, which
 * lands outside any `act` scope of this test's own otherwise.
 */
const flushExit = () =>
  act(async () => {
    const deadline = realNow() + 400;
    while (document.getElementById(TOOLTIP_PANEL_ID) !== null && realNow() < deadline) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 20));
    }
  });

/**
 * Fake timers throughout: everything this component decides is a schedule — a delay, a warm
 * period, a bridge across a gap — and a real-clock test of any of them is a flake waiting for a
 * loaded machine. Vitest's fake timers mock `Date.now()` too, which the warm period reads.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Trigger({
  words,
  options,
  label = "Sort by name",
}: {
  words: React.ReactNode;
  options?: TooltipOptions;
  label?: string;
}) {
  const tip = useTooltip();
  return (
    <button type="button" {...tip(words, options)}>
      {label}
    </button>
  );
}

const mount = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);
const tooltip = () => screen.queryByRole("tooltip");
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("the tooltip", () => {
  it("waits out the delay before it opens", () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));

    advance(TOOLTIP_OPEN_MS - 1);
    expect(tooltip()).toBeNull();

    advance(1);
    expect(tooltip()).toHaveTextContent("Newest first");
  });

  it("does not open at all when the pointer only passes over", () => {
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS - 100);
    fireEvent.pointerLeave(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("does not treat a delayed open on a vanished anchor as a tooltip that just closed", () => {
    // `TooltipPanel`'s own guard (below) is a backstop that would also keep this hidden, so it
    // cannot tell the two apart — both leave `tooltip()` null. What only *this* guard prevents is
    // `show()` running at all: without it, the vanished anchor's open-then-immediately-closed
    // trip through the store still stamps `lastHiddenAt`, and the *next* control hovered inside
    // `TOOLTIP_WARM_MS` reads as "reading along a row" and opens with no delay of its own — a
    // warm period nothing actually closed. Unmounted through React (a `rerender`), not a raw
    // `.remove()` — React still believes it owns that node, and pulling it out from under the
    // reconciler throws on the next commit.
    const { rerender } = mount(
      <>
        <Trigger words="Duplicate" label="one" />
        <Trigger words="Archive" label="two" />
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    rerender(
      <TooltipProvider>
        <Trigger words="Archive" label="two" />
      </TooltipProvider>,
    );
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();

    fireEvent.pointerEnter(screen.getByRole("button", { name: "two" }));
    expect(tooltip()).toBeNull();
    advance(TOOLTIP_OPEN_MS - 1);
    expect(tooltip()).toBeNull();
    advance(1);
    expect(tooltip()).toHaveTextContent("Archive");
  });

  it("closes instead of measuring a panel whose anchor is not in the document", () => {
    // `TooltipPanel` in isolation: the store can write `show()` for a still-connected anchor and
    // have it leave the DOM before this panel's own layout effect runs — a race the delayed-open
    // guard above cannot see, since it has already handed off to the store by then. `onAnchorGone`
    // is what the panel calls instead of computing a placement from a zeroed rect.
    const anchor = document.createElement("button");
    // Deliberately never appended to `document` — `isConnected` is `false` either way.
    const onAnchorGone = vi.fn();
    render(
      <TooltipPanel
        open={{
          openId: 1,
          anchor,
          content: "Newest first",
          side: "top",
          interactive: false,
          describes: true,
        }}
        panelRef={{ current: null }}
        onPointerEnter={() => {}}
        onPointerLeave={() => {}}
        onAnchorGone={onAnchorGone}
      />,
    );
    expect(onAnchorGone).toHaveBeenCalledTimes(1);
  });

  it("closes when the pointer leaves", async () => {
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerLeave(button);
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("opens with no delay while it is still warm", () => {
    // Reading along a row of icon buttons should not cost the full delay per icon.
    mount(
      <>
        <Trigger words="Duplicate" label="one" />
        <Trigger words="Archive" label="two" />
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "one" }));
    advance(TOOLTIP_OPEN_MS);
    fireEvent.pointerLeave(screen.getByRole("button", { name: "one" }));

    advance(TOOLTIP_WARM_MS - 50);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "two" }));
    expect(tooltip()).toHaveTextContent("Archive");
  });

  it("waits again once the warm period has passed", async () => {
    mount(<Trigger words="Duplicate" label="one" />);
    const button = screen.getByRole("button", { name: "one" });
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    fireEvent.pointerLeave(button);
    await flushExit();

    advance(TOOLTIP_WARM_MS + 1);
    fireEvent.pointerEnter(button);
    expect(tooltip()).toBeNull();
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).not.toBeNull();
  });

  it("ignores a leave that arrives after a different control has already taken over", () => {
    // Two controls a pixel apart in a table row produce `enter(B)` before `leave(A)` — the
    // pointer has already moved on by the time A's own leave arrives, and it must not take B's
    // tooltip away the instant it appeared. `enter` closes A itself (by anchor identity) the
    // moment B is entered, so this is `leave`'s own guard — `tooltipStore` used to carry a second,
    // anchor-guarded `hide` for the same rule; it was dead code, since `leave` already checks
    // before it ever calls down to the store's unconditional `hideAny`.
    mount(
      <>
        <Trigger words="Newest first" label="one" />
        <Trigger words="Duplicate" label="two" />
      </>,
    );
    const one = screen.getByRole("button", { name: "one" });
    const two = screen.getByRole("button", { name: "two" });
    fireEvent.pointerEnter(one);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toHaveTextContent("Newest first");

    fireEvent.pointerEnter(two);
    expect(tooltip()).toHaveTextContent("Duplicate");

    fireEvent.pointerLeave(one);
    expect(tooltip()).toHaveTextContent("Duplicate");
  });

  it("survives the pointer crossing the gap into an interactive panel", async () => {
    mount(<Trigger words="Check the printing and re-add it" options={{ interactive: true }} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    const panel = screen.getByRole("tooltip");

    fireEvent.pointerLeave(button);
    // Still on screen while the pointer is between the two.
    advance(TOOLTIP_BRIDGE_MS - 20);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerEnter(panel);
    advance(TOOLTIP_BRIDGE_MS * 4);
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerLeave(panel);
    advance(TOOLTIP_BRIDGE_MS);
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("does not strand an interactive tooltip when the pointer crosses straight to another control", async () => {
    // Regression: `enter` used to only ever clear the close timer, never re-arm anything. The
    // interactive tooltip on "one" would have its bridge-close cancelled by entering "two", but
    // the store still named "one" as open — so leaving "two" (never the open anchor) hit the
    // guard in `leave` and returned, and "one"'s panel was left on screen with no timer pending
    // at all, dismissible only by a scroll, a resize, a press or Escape.
    mount(
      <>
        <Trigger words="Check the printing and re-add it" options={{ interactive: true }} label="one" />
        <Trigger words="Archive" label="two" />
      </>,
    );
    const one = screen.getByRole("button", { name: "one" });
    const two = screen.getByRole("button", { name: "two" });

    fireEvent.pointerEnter(one);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toHaveTextContent("Check the printing and re-add it");

    fireEvent.pointerLeave(one);
    // Still inside the bridge window "one" armed for itself — but the pointer went straight to a
    // different control, not into the panel.
    advance(TOOLTIP_BRIDGE_MS - 20);
    fireEvent.pointerEnter(two);
    expect(tooltip()).toHaveTextContent("Archive");

    fireEvent.pointerLeave(two);
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("takes the pointer's events only when it is interactive", () => {
    mount(<Trigger words="Game changer" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(screen.getByRole("tooltip")).toHaveClass("pointer-events-none");
  });

  it("closes on Escape and does not consume the press", async () => {
    // **The press is not consumed on purpose.** A hint that appeared because a pointer drifted is
    // not a layer the reader navigated into, and one that called `preventDefault()` would swallow
    // the Escape meant for the dialog underneath it. That this leaves the dialog's own rung free
    // to act is a *ladder* claim and a synthetic `dispatchEvent` cannot prove it — it collapses
    // capture into registration order. The ladder is Task 8's live pass; this is the local half.
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);

    const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(press));
    await flushExit();

    expect(tooltip()).toBeNull();
    expect(press.defaultPrevented).toBe(false);
  });

  it("closes when a nested scroller scrolls under it", async () => {
    // A native `scroll` event does not bubble, so only a **capture**-phase listener on `window`
    // ever sees one dispatched on a descendant scroller — a bubble-phase listener would not
    // receive it at all, since propagation stops at the target with nothing left to bubble
    // through. Dispatching directly on `window` (as this test used to) cannot tell the two apart:
    // window is the target either way, capture or bubble.
    mount(
      <div data-testid="scroller">
        <Trigger words="Newest first" />
      </div>,
    );
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    act(() => void screen.getByTestId("scroller").dispatchEvent(new Event("scroll")));
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("closes when the window resizes", async () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    act(() => void window.dispatchEvent(new Event("resize")));
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("closes when a drag starts", async () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    act(() => void window.dispatchEvent(new Event("dragstart")));
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("closes on blur", async () => {
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).not.toBeNull();

    fireEvent.blur(button);
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("closes on a pointer press outside it", async () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    fireEvent.pointerDown(document.body);
    await flushExit();
    expect(tooltip()).toBeNull();
  });

  it("does not close on a pointer press inside an interactive panel", () => {
    // The carve-out that makes `interactive` a place a reader can actually select text from: a
    // press *inside* the panel is the start of a selection, not a dismissal — the one path that
    // treats the panel's own subtree differently from everywhere else a press can land.
    //
    // Checked through `aria-describedby` rather than the panel's own presence: `hideAny` and the
    // effect that clears that attribute both run synchronously off the store, while the panel's
    // DOM node lingers through its exit animation regardless of whether a close actually fired —
    // so a `tooltip()`/`queryByRole` check here would read "still there" for an *incorrectly*
    // dismissed panel too, in the instant right after the press, and prove nothing. Confirmed
    // against a deliberately broken build with the carve-out removed: that failed here and passed
    // a `queryByRole` version of this same assertion.
    mount(<Trigger words="Check the printing and re-add it" options={{ interactive: true }} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    const panel = screen.getByRole("tooltip");
    expect(button).toHaveAttribute("aria-describedby", panel.id);

    fireEvent.pointerDown(panel);
    expect(button).toHaveAttribute("aria-describedby", panel.id);
  });

  it("says nothing when the text it would show is not actually cut off", () => {
    mount(<Trigger words="Modern Horizons 3" options={{ whenClipped: true }} />);
    const button = screen.getByRole("button");
    // jsdom lays nothing out, so both are 0 and the text is by definition not clipped.
    expect(button.scrollWidth).toBe(button.clientWidth);
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("says it when the text is cut off", () => {
    mount(<Trigger words="Modern Horizons 3" options={{ whenClipped: true }} />);
    const button = screen.getByRole("button");
    Object.defineProperty(button, "scrollWidth", { value: 200, configurable: true });
    Object.defineProperty(button, "clientWidth", { value: 100, configurable: true });
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    // `whenClipped` implies `describes: false` (the DOM already carries the whole set name), so
    // the panel that opens here carries no `role` — the same shape the `describes: false` case
    // below proves directly. `queryByRole("tooltip")` is therefore the wrong query for *this*
    // panel; find it by its own words instead, the way that case does.
    expect(screen.getByText("Modern Horizons 3", { selector: "div" })).toHaveAttribute("aria-hidden", "true");
  });

  it("describes the control while it is open, and leaves it as it found it", () => {
    mount(<Trigger words="The cards a format's size rule counts" />);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("aria-describedby");

    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);

    fireEvent.pointerLeave(button);
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("restores a describedby the anchor already carried, rather than deleting it", () => {
    // "Leaves it as it found it" covers the absent case above; a control can already point at
    // some other description (a form field's own error text, say), and closing the tooltip must
    // hand that back rather than erasing it.
    mount(<Trigger words="The cards a format's size rule counts" />);
    const button = screen.getByRole("button");
    button.setAttribute("aria-describedby", "existing-hint");

    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(button.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);

    fireEvent.pointerLeave(button);
    expect(button).toHaveAttribute("aria-describedby", "existing-hint");
  });

  it("does not describe a control whose words are already its name", () => {
    mount(<Trigger words="Duplicate" options={{ describes: false }} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    advance(TOOLTIP_OPEN_MS);
    expect(button).not.toHaveAttribute("aria-describedby");
    // Nor is it in the accessibility tree twice.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByText("Duplicate", { selector: "div" })).toHaveAttribute("aria-hidden", "true");
  });

  it("binds nothing at all when there are no words", () => {
    mount(<Trigger words={null} />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("binds nothing for a bare 0, the same as the other falsy shapes", () => {
    // `cond && "words"` is the documented shape a call site uses to skip a tooltip, and a
    // numeric `cond` of `0` reaching here almost always means the call site meant `cond > 0` —
    // a tooltip that reads the single digit "0" is a bug, not an intent.
    mount(<Trigger words={0} />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });

  it("opens on focus with no delay", () => {
    // jsdom answers `true` to `:focus-visible` for a focused element only once the environment's
    // own last-interaction modality is "keyboard" — a real Tab keydown sets that, the way a
    // reader's own Tab would; every earlier test in this file fires pointer events against the
    // same jsdom `window`, which leaves it on "pointer" and would otherwise make this prove
    // nothing. This proves the focus path opens and *not* that a mouse press is excluded from
    // it. That half is Task 8's.
    mount(<Trigger words="Newest first" />);
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button").focus());
    expect(tooltip()).not.toBeNull();
  });

  it("does not open on a mouse press", () => {
    // jsdom 30's `:focus-visible` modality turns on a `mousedown` too, not only a `pointerenter`
    // — so unlike the pointer-hover tests elsewhere in this file (which jsdom cannot discriminate
    // by input device, per the brief), this one *can* prove the guard directly rather than
    // deferring it to Task 8's live pass.
    mount(<Trigger words="Newest first" />);
    const button = screen.getByRole("button");
    fireEvent.mouseDown(button);
    act(() => button.focus());
    expect(tooltip()).toBeNull();
  });

  it("is a no-op with no provider above it, rather than a crash", () => {
    // Every surface that binds a tooltip is also a story and a test that renders it alone; a
    // throw here would be `src/stories.test.tsx` red for everybody. `NO_MENU` in
    // `menu/useContextMenu.ts` made the same trade for the same reason.
    render(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    expect(tooltip()).toBeNull();
  });
});
