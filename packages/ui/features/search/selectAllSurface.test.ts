import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nearestSurface, registerSelectAll } from "./selectAllSurface";

/**
 * A page with a wall of its own and a column docked after it — the collection with its search
 * column open, which is the shape that makes "which wall?" a question at all.
 *
 * The column's wall sits two boxes deeper than the page's on purpose: the rule under test is about
 * the nearest *shared* ancestor, and a tree where both walls hang at one depth cannot tell that
 * rule from "the wall fewest steps away", which picks the wrong one here.
 */
function page() {
  document.body.innerHTML = `
    <div id="page">
      <div id="toolbar"><button id="tool"></button><input id="box" /></div>
      <div id="main"><div id="wall"><button id="tile"></button></div></div>
      <aside id="column" data-search-dock="">
        <div id="columnHead"><button id="chip"></button></div>
        <div><div><div id="columnWall"><button id="columnTile"></button></div></div></div>
      </aside>
    </div>`;
  const at = (id: string) => document.getElementById(id)!;
  return { at };
}

describe("nearestSurface", () => {
  const surfaces = (at: (id: string) => HTMLElement) => {
    const wall = { name: "wall", element: () => at("wall") };
    const column = { name: "column", element: () => at("columnWall") };
    // The column first, so an answer of "wall" cannot be the order they were handed in.
    return { wall, column, both: [column, wall] };
  };

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("answers the wall a press was inside", () => {
    const { at } = page();
    const { wall, column, both } = surfaces(at);
    expect(nearestSurface(at("tile"), both)).toBe(wall);
    expect(nearestSurface(at("columnTile"), both)).toBe(column);
  });

  it("answers the column's wall for a press on the column's own furniture", () => {
    const { at } = page();
    const { column, both } = surfaces(at);
    expect(nearestSurface(at("chip"), both)).toBe(column);
  });

  it("answers the page's wall for a press on the page's own furniture", () => {
    const { at } = page();
    const { wall, both } = surfaces(at);
    expect(nearestSurface(at("tool"), both)).toBe(wall);
  });

  it("answers the first wall in the document for a press from nowhere", () => {
    const { at } = page();
    const { wall, both } = surfaces(at);
    expect(nearestSurface(null, both)).toBe(wall);
    const gone = at("chip");
    gone.remove();
    expect(nearestSurface(gone, both)).toBe(wall);
  });

  /**
   * The column is a tool beside the list, so a press over the list — or over a table, or a deck,
   * where the column's is the only wall there is — is not about it.
   */
  it("answers nothing for a press outside a docked column whose wall is the only one", () => {
    const { at } = page();
    const { column } = surfaces(at);
    expect(nearestSurface(at("tool"), [column])).toBeNull();
    expect(nearestSurface(at("tile"), [column])).toBeNull();
    expect(nearestSurface(null, [column])).toBeNull();
    expect(nearestSurface(at("chip"), [column])).toBe(column);
  });

  it("skips a surface that is not drawn", () => {
    const { at } = page();
    const { wall, column, both } = surfaces(at);
    const undrawn = { name: "undrawn", element: () => null };
    expect(nearestSurface(at("tile"), [undrawn, wall])).toBe(wall);
    expect(nearestSurface(at("tile"), [undrawn])).toBeNull();

    // A column railed for want of room keeps its wall mounted, under `hidden`.
    at("columnWall").parentElement!.hidden = true;
    expect(nearestSurface(at("chip"), [column])).toBeNull();
    expect(nearestSurface(at("chip"), both)).toBe(wall);
  });
});

describe("Ctrl+A", () => {
  let at: (id: string) => HTMLElement;
  let wall: ReturnType<typeof vi.fn<() => void>>;
  let column: ReturnType<typeof vi.fn<() => void>>;
  let leave: (() => void)[] = [];

  /** The chord, pressed with the caret on `target`. `false` when something refused the default. */
  const press = (target: Element, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key: "a", ctrlKey: true, ...init });

  beforeEach(() => {
    ({ at } = page());
    wall = vi.fn();
    column = vi.fn();
    leave = [
      registerSelectAll({ element: () => at("columnWall"), selectAll: column }),
      registerSelectAll({ element: () => at("wall"), selectAll: wall }),
    ];
  });

  afterEach(() => {
    for (const off of leave) off();
    document.body.innerHTML = "";
  });

  it("picks the wall the caret is in, and keeps the browser's own select-all out", () => {
    expect(press(at("columnTile"))).toBe(false);
    expect(column).toHaveBeenCalledTimes(1);
    expect(wall).not.toHaveBeenCalled();
  });

  it("goes by what was last pressed once the caret is on the body", () => {
    fireEvent.pointerDown(at("chip"));
    press(document.body);
    expect(column).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(at("tool"));
    press(document.body);
    expect(wall).toHaveBeenCalledTimes(1);
  });

  it("goes by where the caret last was, too", () => {
    fireEvent.focusIn(at("chip"));
    press(document.body);
    expect(column).toHaveBeenCalledTimes(1);
  });

  /**
   * Pressing something unfocusable hands the caret to a focusable *ancestor* — the deck editor's
   * root is one — and that caret is outside the column the press was in.
   */
  it("goes by the press, not by the landing pad the press left the caret on", () => {
    fireEvent.pointerDown(at("chip"));
    fireEvent.focusIn(at("page"));

    press(at("page"));

    expect(column).toHaveBeenCalledTimes(1);
    expect(wall).not.toHaveBeenCalled();
  });

  it("goes by a caret that has moved somewhere else since the press", () => {
    fireEvent.pointerDown(at("chip"));
    fireEvent.focusIn(at("tile"));

    press(at("tile"));

    expect(wall).toHaveBeenCalledTimes(1);
    expect(column).not.toHaveBeenCalled();
  });

  /**
   * The walls are virtualised: the tile a reader Ctrl-clicked is unmounted by the next scroll, and
   * a detached element shares an ancestor with nothing.
   */
  it("remembers which wall a press was about after the pressed element has gone", () => {
    fireEvent.pointerDown(at("columnTile"));
    at("columnTile").remove();

    press(document.body);

    expect(column).toHaveBeenCalledTimes(1);
    expect(wall).not.toHaveBeenCalled();
  });

  it("leaves the chord alone outside a docked column when the column's is the only wall", () => {
    leave[1]();

    expect(press(at("tool"))).toBe(true);
    expect(press(document.body)).toBe(true);
    expect(column).not.toHaveBeenCalled();
  });

  it("picks the page's wall when nothing has been touched", () => {
    press(document.body);
    expect(wall).toHaveBeenCalledTimes(1);
    expect(column).not.toHaveBeenCalled();
  });

  // A search box is on every one of these pages, and Ctrl+A there means its text.
  it("leaves the chord to a text field", () => {
    expect(press(at("box"))).toBe(true);
    expect(wall).not.toHaveBeenCalled();
    expect(column).not.toHaveBeenCalled();
  });

  it("does nothing behind a modal", () => {
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);

    expect(press(at("tile"))).toBe(true);
    expect(wall).not.toHaveBeenCalled();
  });

  it("does nothing for a press something nearer already took", () => {
    at("tile").addEventListener("keydown", (e) => e.preventDefault());
    press(at("tile"));
    expect(wall).not.toHaveBeenCalled();
  });

  it("is Ctrl+A exactly", () => {
    press(at("tile"), { shiftKey: true });
    press(at("tile"), { altKey: true });
    press(at("tile"), { ctrlKey: false });
    expect(wall).not.toHaveBeenCalled();
  });

  it("picks once for a held key, and still swallows every repeat", () => {
    press(at("tile"));
    expect(press(at("tile"), { repeat: true })).toBe(false);
    expect(wall).toHaveBeenCalledTimes(1);
  });

  it("gives the chord back to the browser once no wall is registered", () => {
    for (const off of leave) off();
    leave = [];
    expect(press(at("tile"))).toBe(true);
    expect(wall).not.toHaveBeenCalled();
  });
});
