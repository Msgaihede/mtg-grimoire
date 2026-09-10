import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WidgetCard, WIDGET_CARD_BOX, WIDGET_CARD_WIDE, type WidgetCardProps } from "./WidgetCard";

const HEADING = "Collection value";

/** The four names the edit tray answers to, spelled once so a reword is one edit here. */
const GRIP = `Move ${HEADING}`;
const WIDTH = `Full width, ${HEADING}`;
const SETTINGS = `Settings for ${HEADING}`;
const REMOVE = `Remove ${HEADING}`;

/**
 * Every prop the card cannot be drawn without, so a case states only the one it is about.
 *
 * A **fresh** set per call rather than one object at module scope: `toHaveBeenCalledTimes(1)`
 * against a shared spy passes or fails by the order vitest happens to run the file in, which is
 * a green suite that means nothing. `NewFolderCard.test.tsx`'s `stubs()` is the precedent.
 */
function props(over: Partial<WidgetCardProps> = {}): WidgetCardProps {
  return {
    heading: HEADING,
    editing: false,
    span: 1,
    onRemove: vi.fn(),
    onSpan: vi.fn(),
    dragHandleRef: vi.fn(),
    onNudge: vi.fn(),
    children: <p>Nine thousand cards</p>,
    ...over,
  };
}

describe("WidgetCard", () => {
  /**
   * The heading is the card's accessible name, so a test, a live pass and a screen reader all
   * address a widget by what it says rather than by its place in a wrapping row — which is the
   * one thing about a widget's position a reader is allowed to change.
   *
   * A `<section>` with a name is a `region`, which is what `getByRole` is asking for here.
   */
  it("is named by its heading", () => {
    render(<WidgetCard {...props()} />);

    const card = screen.getByRole("region", { name: HEADING });
    expect(card).toHaveTextContent("Nine thousand cards");
  });

  /**
   * At rest a widget is a readout. Every affordance for *rearranging* the page belongs to
   * Customize, and a card that carried them all the time would put four controls nobody asked
   * for on a page whose whole job is to be read.
   */
  it("draws no edit controls at rest", () => {
    render(<WidgetCard {...props({ settings: <p>Dimension</p> })} />);

    expect(screen.queryByRole("button", { name: GRIP })).toBeNull();
    expect(screen.queryByRole("button", { name: WIDTH })).toBeNull();
    expect(screen.queryByRole("button", { name: SETTINGS })).toBeNull();
    expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
  });

  it("draws the grip, the width toggle, the settings popover and the remove control in edit mode", () => {
    render(<WidgetCard {...props({ editing: true, settings: <p>Dimension</p> })} />);

    expect(screen.getByRole("button", { name: GRIP })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: WIDTH })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SETTINGS })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: REMOVE })).toBeInTheDocument();
  });

  /**
   * A widget that has nothing to configure draws no settings control at all — greyed would be a
   * control that reads as broken, and an empty popover is a question with no answers in it.
   */
  it("draws no settings control for a widget that has none", () => {
    render(<WidgetCard {...props({ editing: true })} />);

    expect(screen.queryByRole("button", { name: SETTINGS })).toBeNull();
    expect(screen.getByRole("button", { name: REMOVE })).toBeInTheDocument();
  });

  /** The widget's own control is not an edit affordance and is drawn in both modes. */
  it("keeps the widget's own actions in both modes", () => {
    const view = render(
      <WidgetCard {...props({ actions: <button type="button">By rarity</button> })} />,
    );
    expect(screen.getByRole("button", { name: "By rarity" })).toBeInTheDocument();

    view.rerender(
      <WidgetCard
        {...props({ editing: true, actions: <button type="button">By rarity</button> })}
      />,
    );
    expect(screen.getByRole("button", { name: "By rarity" })).toBeInTheDocument();
  });

  /**
   * **The grip's arrow keys are the whole keyboard reorder**, because `dndManager` ships no
   * `KeyboardSensor` — a drag-only rearrange is one half the readers do not have.
   * `categoryDrag.ts`'s grip is the precedent; the axis is left/right because the row is a
   * wrapping flex line rather than a list.
   *
   * Driven from a caret the *reader* can produce — Tab, never `element.focus()` — because a
   * programmatically focused control tests a caret nobody has.
   */
  it("writes the move from the grip's arrow keys", async () => {
    const user = userEvent.setup();
    const onNudge = vi.fn();
    render(<WidgetCard {...props({ editing: true, onNudge })} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: GRIP }));

    await user.keyboard("{ArrowLeft}");
    expect(onNudge).toHaveBeenCalledWith(-1);

    await user.keyboard("{ArrowRight}");
    expect(onNudge).toHaveBeenCalledWith(1);
    expect(onNudge).toHaveBeenCalledTimes(2);
  });

  /**
   * The press is consumed, so the browser's own horizontal scroll — and any walk a host binds
   * over the row — never sees a key the grip has already answered. `defaultPrevented` is what
   * every handshake in this app reads, `useDismissOnEscape`'s two stacks included.
   */
  it("consumes the arrow keys it answers, and leaves the rest alone", () => {
    render(<WidgetCard {...props({ editing: true })} />);
    const grip = screen.getByRole("button", { name: GRIP });

    const left = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    grip.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);

    // A key it does not answer falls through untouched — the grip is not a keyboard trap.
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    grip.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);
  });

  /** The grip is what the host registers as the drag handle, and it hands the element back. */
  it("hands the grip back through dragHandleRef, and hands back null when edit mode ends", () => {
    const dragHandleRef = vi.fn();
    const view = render(<WidgetCard {...props({ editing: true, dragHandleRef })} />);

    expect(dragHandleRef).toHaveBeenCalledWith(screen.getByRole("button", { name: GRIP }));

    view.rerender(<WidgetCard {...props({ editing: false, dragHandleRef })} />);
    expect(dragHandleRef).toHaveBeenLastCalledWith(null);
  });

  /**
   * The width toggle is a toggle rather than two buttons, so its name never moves and
   * `aria-pressed` is the whole of what says which state it is in.
   */
  it("toggles the width, and says which state it is in", async () => {
    const user = userEvent.setup();
    const onSpan = vi.fn();
    const view = render(<WidgetCard {...props({ editing: true, onSpan })} />);

    const narrow = screen.getByRole("button", { name: WIDTH });
    expect(narrow).toHaveAttribute("aria-pressed", "false");
    await user.click(narrow);
    expect(onSpan).toHaveBeenCalledWith(2);

    view.rerender(<WidgetCard {...props({ editing: true, span: 2, onSpan })} />);
    const wide = screen.getByRole("button", { name: WIDTH });
    expect(wide).toHaveAttribute("aria-pressed", "true");
    await user.click(wide);
    expect(onSpan).toHaveBeenLastCalledWith(1);
  });

  it("removes the widget", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<WidgetCard {...props({ editing: true, onRemove })} />);

    await user.click(screen.getByRole("button", { name: REMOVE }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  /**
   * **`classList.contains`, never a string match on `className`** — a `hover:` variant makes a
   * substring assertion vacuous, since `hover:flex-1` contains `flex-1`.
   *
   * The two are exclusive: a full-width card must not also carry the narrow card's floor, or a
   * `min-w-[22rem]` would be a floor under a box that is meant to be the whole line.
   */
  it("picks the wide box at span 2 and the narrow one at span 1", () => {
    const view = render(<WidgetCard {...props()} />);

    const narrow = screen.getByRole("region", { name: HEADING });
    for (const token of WIDGET_CARD_BOX.split(" ")) {
      expect(narrow.classList.contains(token)).toBe(true);
    }
    expect(narrow.classList.contains(WIDGET_CARD_WIDE)).toBe(false);

    view.rerender(<WidgetCard {...props({ span: 2 })} />);
    const wide = screen.getByRole("region", { name: HEADING });
    expect(wide.classList.contains(WIDGET_CARD_WIDE)).toBe(true);
    for (const token of WIDGET_CARD_BOX.split(" ")) {
      expect(wide.classList.contains(token)).toBe(false);
    }
  });

  /**
   * **`aria-disabled`, never the attribute.** Nothing in the tray greys today, and this is what
   * keeps it that way by the honest route: a control given the attribute leaves the tab order,
   * so a reader sweeping the row would find the card's own affordances gone rather than out of
   * reach.
   */
  it("greys nothing with the disabled attribute", () => {
    render(<WidgetCard {...props({ editing: true, settings: <p>Dimension</p> })} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAttribute("disabled");
    }
  });

  /**
   * Every control is reachable by keyboard, in the order it is drawn — the widget's own control
   * first, then the tray. A drag grip a caret cannot reach is a reorder half the readers do not
   * have, and a settings popover behind one is a configuration only a mouse can change.
   *
   * No assertion about a focus **ring**: this app redefines `focus-visible` as
   * `&:is(html[data-kbd] *):focus-visible`, so the mark is a fact about modality rather than
   * about the control, and jsdom applies no stylesheet either way.
   */
  it("puts every control on the tab path", async () => {
    const user = userEvent.setup();
    render(
      <WidgetCard
        {...props({
          editing: true,
          settings: <p>Dimension</p>,
          actions: <button type="button">By rarity</button>,
        })}
      />,
    );

    const order = [
      screen.getByRole("button", { name: "By rarity" }),
      screen.getByRole("button", { name: GRIP }),
      screen.getByRole("button", { name: WIDTH }),
      screen.getByRole("button", { name: SETTINGS }),
      screen.getByRole("button", { name: REMOVE }),
    ];
    for (const control of order) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
  });
});
