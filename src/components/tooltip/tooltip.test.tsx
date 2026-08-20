import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider, TOOLTIP_BRIDGE_MS, TOOLTIP_OPEN_MS, TOOLTIP_WARM_MS } from "./TooltipProvider";
import { useTooltip, type TooltipOptions } from "./useTooltip";

/**
 * Captured before any test's `vi.useFakeTimers()` ever runs, while `setTimeout` is still real.
 *
 * `motion`'s frame scheduler (`motion-dom`'s `createRenderBatcher`) closes over
 * `requestAnimationFrame` once, at module load — which happens when this file's imports resolve,
 * before the first `beforeEach`. `vi.advanceTimersByTime` can never reach that closed-over
 * reference, so an `AnimatePresence` exit's `onExitComplete` — which is what actually removes the
 * panel from the document — never fires on the fake clock alone, even with
 * `MotionGlobalConfig.skipAnimations` (verified with a two-line `AnimatePresence` reproduction
 * with no tooltip code involved: the exiting node lands on its exit target's styles and then just
 * sits there). One real wait, using the reference captured here rather than the one
 * `vi.useFakeTimers()` later replaces, gives that stale closure the actual clock tick it is
 * waiting on — without moving the *fake* `Date.now()` the warm-period logic reads.
 */
const realSetTimeout = globalThis.setTimeout;
const flushExit = () => new Promise<void>((resolve) => realSetTimeout(resolve, 50));

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

  it("closes when the page scrolls under it", async () => {
    mount(<Trigger words="Newest first" />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    advance(TOOLTIP_OPEN_MS);
    act(() => void window.dispatchEvent(new Event("scroll")));
    await flushExit();
    expect(tooltip()).toBeNull();
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
