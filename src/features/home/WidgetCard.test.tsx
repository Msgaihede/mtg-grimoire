import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HomeWidget } from "@/lib/ipc";

import { makeFit } from "./fit";
import { WidgetCard, type WidgetCardProps } from "./WidgetCard";

const TITLE = "Collection value";

/** The names the card's controls answer to, spelled once so a reword is one edit here. */
const GRIP = `Move ${TITLE}`;
const FIELD = `Name for ${TITLE}`;
const TRAY = `Customize ${TITLE}`;
const SETTINGS = `Settings for ${TITLE}`;
const REMOVE = `Remove ${TITLE}`;
const RESIZE = `Resize ${TITLE}`;

function widget(over: Partial<HomeWidget> = {}): HomeWidget {
  return {
    id: "collectionValue",
    kind: "collectionValue",
    x: 0,
    y: 0,
    w: 2,
    h: 3,
    config: null,
    ...over,
  };
}

/**
 * Every prop the card cannot be drawn without, so a case states only the one it is about.
 *
 * A **fresh** set per call: `toHaveBeenCalledTimes(1)` against a shared spy passes or fails by the
 * order vitest runs the file in. The fit is built from the widget's own footprint with `makeFit`,
 * the page's function, so the card is handed the box it would be handed on a page.
 */
function props(over: Partial<WidgetCardProps> = {}): WidgetCardProps {
  const w = over.widget ?? widget();
  return {
    widget: w,
    fit: makeFit({ w: w.w, h: w.h, widthPx: 220, heightPx: 340, density: "comfortable" }),
    editing: false,
    onDragStart: vi.fn(),
    onResizeStart: vi.fn(),
    onNudge: vi.fn(),
    onGrow: vi.fn(),
    onConfig: vi.fn(),
    onRemove: vi.fn(),
    children: <button type="button">Nine thousand cards</button>,
    ...over,
  };
}

describe("WidgetCard", () => {
  /**
   * The title is the card's accessible name, so a test, a live pass and a screen reader address a
   * widget by what it says rather than by where it sits — which is the one thing a reader is free
   * to change.
   */
  it("is named by its title — the reader's own, or the kind's", () => {
    const view = render(<WidgetCard {...props()} />);
    const card = screen.getByRole("region", { name: TITLE });
    expect(card).toHaveTextContent("Nine thousand cards");
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(TITLE);

    view.rerender(
      <WidgetCard {...props({ widget: widget({ config: { title: "The binder" } }) })} />,
    );
    expect(screen.getByRole("region", { name: "The binder" })).toBeInTheDocument();
  });

  /** At rest a widget is a readout: nothing for rearranging the page is drawn. */
  it("draws no Customize controls at rest", () => {
    render(<WidgetCard {...props()} />);

    expect(screen.queryByRole("button", { name: GRIP })).toBeNull();
    expect(screen.queryByRole("textbox", { name: FIELD })).toBeNull();
    expect(screen.queryByRole("group", { name: TRAY })).toBeNull();
    expect(screen.queryByRole("button", { name: SETTINGS })).toBeNull();
    expect(screen.queryByRole("button", { name: REMOVE })).toBeNull();
    expect(screen.queryByRole("button", { name: RESIZE })).toBeNull();
  });

  it("draws the grip, the title field, the tray and the resize corner while customizing", () => {
    render(<WidgetCard {...props({ editing: true })} />);

    expect(screen.getByRole("button", { name: GRIP })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: FIELD })).toHaveValue(TITLE);
    const tray = within(screen.getByRole("group", { name: TRAY }));
    expect(tray.getByRole("button", { name: SETTINGS })).toBeInTheDocument();
    expect(tray.getByRole("button", { name: REMOVE })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RESIZE })).toBeInTheDocument();
  });

  /** A stacked page has no grid to drop on: no grip, no corner — but the card is still renamed,
   *  configured and removed from its own line. */
  it("draws no grip and no corner where the page cannot be arranged by pointer", () => {
    render(<WidgetCard {...props({ editing: true, arrangeable: false })} />);

    expect(screen.queryByRole("button", { name: GRIP })).toBeNull();
    expect(screen.queryByRole("button", { name: RESIZE })).toBeNull();
    expect(screen.getByRole("textbox", { name: FIELD })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: TRAY })).toBeInTheDocument();
  });

  /** A catalogue preview is a picture of a card: no tray even on a page being customised. */
  it("draws none of Customize's controls on a still preview", () => {
    render(<WidgetCard {...props({ editing: true, still: true })} />);

    expect(screen.queryByRole("group", { name: TRAY })).toBeNull();
    expect(screen.queryByRole("button", { name: GRIP })).toBeNull();
    expect(screen.queryByRole("button", { name: RESIZE })).toBeNull();
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(TITLE);
  });

  describe("the title field", () => {
    /** A draft, written once when the reader is finished with it — never a write per letter. */
    it("commits a rename on blur, and not before", async () => {
      const user = userEvent.setup();
      const onConfig = vi.fn();
      render(<WidgetCard {...props({ editing: true, onConfig })} />);

      const field = screen.getByRole("textbox", { name: FIELD });
      await user.clear(field);
      await user.type(field, "  The binder ");
      expect(onConfig).not.toHaveBeenCalled();
      // The card keeps its stored name while the draft is being typed.
      expect(screen.getByRole("region", { name: TITLE })).toBeInTheDocument();

      await user.tab();
      expect(onConfig).toHaveBeenCalledTimes(1);
      expect(onConfig).toHaveBeenCalledWith({ title: "The binder" });
    });

    it("commits on Enter", async () => {
      const user = userEvent.setup();
      const onConfig = vi.fn();
      render(<WidgetCard {...props({ editing: true, onConfig })} />);

      const field = screen.getByRole("textbox", { name: FIELD });
      await user.clear(field);
      await user.type(field, "Worth{Enter}");
      expect(onConfig).toHaveBeenCalledWith({ title: "Worth" });
    });

    /** A blank, or the kind's own name typed back in, stores nothing and the kind's name returns. */
    it("stores no title for a blank or for the kind's own name", async () => {
      const user = userEvent.setup();
      const onConfig = vi.fn();
      render(
        <WidgetCard
          {...props({ editing: true, onConfig, widget: widget({ config: { title: "Mine" } }) })}
        />,
      );

      const field = screen.getByRole("textbox", { name: FIELD });
      expect(field).toHaveValue("Mine");
      await user.clear(field);
      await user.keyboard("{Enter}");
      expect(onConfig).toHaveBeenLastCalledWith({ title: undefined });
      onConfig.mockClear();

      // The mock wrote nothing back, so the field shows `Mine` again.
      await user.clear(field);
      await user.type(field, `${TITLE}{Enter}`);
      expect(onConfig).toHaveBeenCalledTimes(1);
      expect(onConfig).toHaveBeenLastCalledWith({ title: undefined });
    });

    /** A field left as it was writes nothing — a blur is not a rename. */
    it("writes nothing when the name did not change", async () => {
      const user = userEvent.setup();
      const onConfig = vi.fn();
      render(<WidgetCard {...props({ editing: true, onConfig })} />);

      await user.click(screen.getByRole("textbox", { name: FIELD }));
      await user.tab();
      await user.type(screen.getByRole("textbox", { name: FIELD }), "{Backspace}e{Enter}");
      expect(onConfig).not.toHaveBeenCalled();
    });

    /**
     * Escape reverts a draft and consumes the press, so it closes nothing else — and with no draft
     * it leaves the press alone for whatever layer is underneath.
     */
    it("reverts a draft on Escape, consuming only a press that had something to undo", async () => {
      const user = userEvent.setup();
      const onConfig = vi.fn();
      render(<WidgetCard {...props({ editing: true, onConfig })} />);

      const field = screen.getByRole("textbox", { name: FIELD });
      await user.type(field, " draft");
      expect(field).toHaveValue(`${TITLE} draft`);

      const revert = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      fireEvent(field, revert);
      expect(revert.defaultPrevented).toBe(true);
      expect(field).toHaveValue(TITLE);

      const nothing = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      fireEvent(field, nothing);
      expect(nothing.defaultPrevented).toBe(false);

      await user.tab();
      expect(onConfig).not.toHaveBeenCalled();
    });
  });

  /**
   * **The grip's arrow keys are the keyboard's whole move**, because `dndManager` ships no
   * `KeyboardSensor`. Driven from a caret the reader can produce — Tab — never `element.focus()`.
   */
  it("moves the card a cell per arrow key from the grip", async () => {
    const user = userEvent.setup();
    const onNudge = vi.fn();
    render(<WidgetCard {...props({ editing: true, onNudge })} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: GRIP }));

    await user.keyboard("{ArrowLeft}{ArrowDown}{ArrowRight}{ArrowUp}");
    expect(onNudge.mock.calls).toEqual([
      [-1, 0],
      [0, 1],
      [1, 0],
      [0, -1],
    ]);
  });

  it("consumes the arrow keys the grip answers, and leaves the rest alone", () => {
    render(<WidgetCard {...props({ editing: true })} />);
    const grip = screen.getByRole("button", { name: GRIP });

    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    fireEvent(grip, up);
    expect(up.defaultPrevented).toBe(true);

    const tab = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
    fireEvent(grip, tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  /** The corner is the resize: a press hands the gesture to the page, and never also a move. */
  it("starts a resize from the corner, and grows by a cell per arrow key", async () => {
    const user = userEvent.setup();
    const onResizeStart = vi.fn();
    const onDragStart = vi.fn();
    const onGrow = vi.fn();
    render(<WidgetCard {...props({ editing: true, onResizeStart, onDragStart, onGrow })} />);

    const corner = screen.getByRole("button", { name: RESIZE });
    fireEvent.pointerDown(corner);
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onDragStart).not.toHaveBeenCalled();

    corner.focus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(onGrow.mock.calls).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  describe("picking the card up", () => {
    it("starts a drag from a press anywhere on the card while customizing", () => {
      const onDragStart = vi.fn();
      render(<WidgetCard {...props({ editing: true, onDragStart })} />);

      fireEvent.pointerDown(screen.getByRole("region", { name: TITLE }));
      expect(onDragStart).toHaveBeenCalledTimes(1);

      // The grip is where the drag is advertised, so a press on it is a press on the card.
      fireEvent.pointerDown(screen.getByRole("button", { name: GRIP }));
      expect(onDragStart).toHaveBeenCalledTimes(2);
    });

    /** Everything that is a control of its own carries `data-no-drag`, and a press there is a
     *  press. */
    it("ignores a press on anything marked data-no-drag", () => {
      const onDragStart = vi.fn();
      render(<WidgetCard {...props({ editing: true, onDragStart })} />);

      fireEvent.pointerDown(screen.getByRole("textbox", { name: FIELD }));
      fireEvent.pointerDown(screen.getByRole("group", { name: TRAY }));
      fireEvent.pointerDown(screen.getByRole("button", { name: SETTINGS }));
      fireEvent.pointerDown(screen.getByRole("button", { name: RESIZE }));
      expect(onDragStart).not.toHaveBeenCalled();
    });

    it("starts nothing at rest, on a stacked page, or from a secondary press", () => {
      const onDragStart = vi.fn();
      const view = render(<WidgetCard {...props({ onDragStart })} />);
      fireEvent.pointerDown(screen.getByRole("region", { name: TITLE }));

      view.rerender(<WidgetCard {...props({ editing: true, arrangeable: false, onDragStart })} />);
      fireEvent.pointerDown(screen.getByRole("region", { name: TITLE }));

      view.rerender(<WidgetCard {...props({ editing: true, onDragStart })} />);
      fireEvent.pointerDown(screen.getByRole("region", { name: TITLE }), { button: 2 });

      expect(onDragStart).not.toHaveBeenCalled();
    });
  });

  /**
   * **The body is inert while customizing**, so a press on a deck tile falls through to the card
   * and nothing in the body takes the caret. It is inert on the contents rather than on the
   * scroller, so a body taller than its card still scrolls.
   */
  it("makes the body inert while customizing, and live at rest", () => {
    const view = render(<WidgetCard {...props()} />);
    const body = () => screen.getByRole("button", { name: "Nine thousand cards" }).parentElement!;
    expect(body()).not.toHaveAttribute("inert");

    view.rerender(<WidgetCard {...props({ editing: true })} />);
    expect(body()).toHaveAttribute("inert");
    // The scroller itself is not, which is what keeps the wheel working.
    expect(body().parentElement).not.toHaveAttribute("inert");
    expect(body().parentElement!.classList.contains("overflow-y-auto")).toBe(true);
  });

  /** A still preview clips where a live card scrolls, and its body is inert too. */
  it("clips a still preview's body rather than scrolling it", () => {
    render(<WidgetCard {...props({ still: true })} />);
    const body = screen.getByRole("button", { name: "Nine thousand cards" }).parentElement!;
    expect(body).toHaveAttribute("inert");
    expect(body.parentElement!.classList.contains("overflow-y-hidden")).toBe(true);
    expect(body.parentElement!.classList.contains("overflow-y-auto")).toBe(false);
  });

  /**
   * **The card does not clip** — its popovers open past its edge. `classList.contains`, never a
   * string match: a `hover:` variant makes a substring assertion vacuous.
   */
  it("never clips the card itself", () => {
    render(<WidgetCard {...props({ editing: true })} />);
    const card = screen.getByRole("region", { name: TITLE });
    expect(card.classList.contains("overflow-hidden")).toBe(false);
  });

  /** The chip is a band's and a row's, never a tile's: at two cells the title needs the room. */
  it("draws the chip only on a card at least four cells wide", () => {
    const wide = widget({ w: 4, config: { dimension: "set" } });
    const view = render(
      <WidgetCard
        {...props({
          widget: wide,
          fit: makeFit({ w: 4, h: 3, widthPx: 460, heightPx: 340, density: "comfortable" }),
        })}
      />,
    );
    expect(within(screen.getByRole("region", { name: TITLE })).getByText("Set")).toBeInTheDocument();

    const narrow = widget({ w: 3, config: { dimension: "set" } });
    view.rerender(
      <WidgetCard
        {...props({
          widget: narrow,
          fit: makeFit({ w: 3, h: 3, widthPx: 340, heightPx: 340, density: "comfortable" }),
        })}
      />,
    );
    expect(within(screen.getByRole("region", { name: TITLE })).queryByText("Set")).toBeNull();
  });

  describe("the settings popover", () => {
    it("opens the kind's settings, wired to the page's handlers", async () => {
      const user = userEvent.setup();
      const onGrow = vi.fn();
      const onConfig = vi.fn();
      render(
        <WidgetCard
          {...props({
            editing: true,
            onGrow,
            onConfig,
            widget: widget({ w: 3 }),
            canGrow: () => true,
            extraSettings: <p>Pinned decks</p>,
          })}
        />,
      );

      await user.click(screen.getByRole("button", { name: SETTINGS }));
      const panel = within(await screen.findByRole("dialog", { name: `${TITLE} settings` }));

      await user.click(panel.getByRole("button", { name: `Wider, ${TITLE}` }));
      expect(onGrow).toHaveBeenCalledWith(1, 0);
      await user.click(panel.getByRole("button", { name: "Finish" }));
      expect(onConfig).toHaveBeenCalledWith({ dimension: "finish" });
      expect(panel.getByText("Pinned decks")).toBeInTheDocument();
    });

    it("closes from its own ✕ and hands the caret back to the trigger", async () => {
      const user = userEvent.setup();
      render(<WidgetCard {...props({ editing: true })} />);

      const trigger = screen.getByRole("button", { name: SETTINGS });
      await user.click(trigger);
      const panel = await screen.findByRole("dialog", { name: `${TITLE} settings` });
      await user.click(within(panel).getByRole("button", { name: "Close settings" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: `${TITLE} settings` })).toBeNull(),
      );
      expect(trigger).toHaveFocus();
    });
  });

  describe("removing the card", () => {
    /** The card asks before it goes — its settings go with it, which is not a thing to lose to a
     *  stray press on a page being rearranged. */
    it("asks first, and Keep takes nothing off the page", async () => {
      const user = userEvent.setup();
      const onRemove = vi.fn();
      render(<WidgetCard {...props({ editing: true, onRemove })} />);

      const trigger = screen.getByRole("button", { name: REMOVE });
      await user.click(trigger);
      expect(onRemove).not.toHaveBeenCalled();

      const question = await screen.findByRole("dialog", { name: `Remove ${TITLE}?` });
      expect(question).toHaveTextContent(`Take ${TITLE} off the page?`);
      expect(question).toHaveTextContent(
        "Its settings go with it. You can add it again from the catalogue.",
      );

      await user.click(within(question).getByRole("button", { name: "Keep" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: `Remove ${TITLE}?` })).toBeNull(),
      );
      expect(trigger).toHaveFocus();
      expect(onRemove).not.toHaveBeenCalled();
    });

    it("removes the card on Remove", async () => {
      const user = userEvent.setup();
      const onRemove = vi.fn();
      render(<WidgetCard {...props({ editing: true, onRemove })} />);

      await user.click(screen.getByRole("button", { name: REMOVE }));
      const question = await screen.findByRole("dialog", { name: `Remove ${TITLE}?` });
      await user.click(within(question).getByRole("button", { name: "Remove" }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * **`aria-disabled`, never the attribute.** A control given the attribute leaves the tab order,
   * so a reader sweeping the card would find its affordances gone rather than out of reach.
   */
  it("greys nothing with the disabled attribute", () => {
    render(<WidgetCard {...props({ editing: true })} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAttribute("disabled");
    }
  });

  /**
   * Every control is on the tab path, in the order it is drawn.
   *
   * The body is given nothing focusable here, and that is jsdom's limit rather than a gap in the
   * claim: user-event's Tab walk does not read `inert`, so a button in an inert body would be
   * reached in the suite and skipped in the window. The inert attribute is pinned above instead.
   */
  it("puts every control on the tab path, in the order it is drawn", async () => {
    const user = userEvent.setup();
    render(<WidgetCard {...props({ editing: true, children: <p>Nine thousand cards</p> })} />);

    const order = [
      screen.getByRole("button", { name: GRIP }),
      screen.getByRole("textbox", { name: FIELD }),
      screen.getByRole("button", { name: SETTINGS }),
      screen.getByRole("button", { name: REMOVE }),
      screen.getByRole("button", { name: RESIZE }),
    ];
    for (const control of order) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
  });
});
