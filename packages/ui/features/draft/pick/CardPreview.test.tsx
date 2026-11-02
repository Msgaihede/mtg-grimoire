import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSPECT_DELAY, INSPECT_WIDTH } from "@/features/playtesting/table/Inspect";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import {
  besideTile,
  CardPreview,
  previewHeight,
  previewWidth,
  useCardPreview,
  type PreviewCard,
} from "./CardPreview";

describe("previewWidth", () => {
  const view = { width: 1440, height: 900 };

  it("is the playtest board's inspect width for a pack-sized tile", () => {
    expect(previewWidth(190, view)).toBe(INSPECT_WIDTH);
  });

  it("is half again a tile the zoom has already drawn past that width", () => {
    expect(previewWidth(300, view)).toBe(450);
  });

  it("never leaves the window, however big the tile", () => {
    const width = previewWidth(600, { width: 1024, height: 600 });
    expect(previewHeight(width)).toBeLessThanOrEqual(600 - 16);
    expect(previewWidth(190, { width: 200, height: 900 })).toBe(184);
  });
});

describe("besideTile", () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 320, height: 445 };

  it("opens right of the tile, top-aligned with it", () => {
    expect(besideTile({ top: 200, left: 100, right: 290, width: 190 }, size, view)).toEqual({
      left: 302,
      top: 200,
    });
  });

  it("flips left of the tile at the window's right edge, and stays inside the bottom", () => {
    const at = besideTile({ top: 800, left: 1200, right: 1390, width: 190 }, size, view);
    expect(at.left).toBe(1200 - 12 - 320);
    expect(at.top + size.height).toBeLessThanOrEqual(view.height - 8);
  });
});

const shock: PreviewCard = { cardId: "id-shock", name: "Shock" };
const opt: PreviewCard = { cardId: "id-opt", name: "Opt" };

function Wall() {
  const preview = useCardPreview();
  return (
    <>
      {[shock, opt].map((c) => (
        <button key={c.cardId} type="button" {...preview.tileProps(c)}>
          {c.name}
        </button>
      ))}
      <CardPreview shown={preview.shown} />
    </>
  );
}

const preview = () => screen.queryByTestId("draft-card-preview");
const rest = () => act(() => vi.advanceTimersByTime(INSPECT_DELAY));

describe("useCardPreview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute(KEYBOARD_MODALITY_ATTR);
  });

  it("opens the rested card's display image after the board's delay, and closes on leaving", () => {
    render(<Wall />);
    const tile = screen.getByRole("button", { name: "Shock" });
    fireEvent.pointerEnter(tile, { clientX: 40, clientY: 40 });
    act(() => vi.advanceTimersByTime(INSPECT_DELAY - 1));
    expect(preview()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(preview()).toHaveAttribute("aria-hidden", "true");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toContain("id-shock");
    expect(preview()?.querySelector("img")?.getAttribute("src")).toContain("display");

    fireEvent.pointerLeave(tile);
    expect(preview()).toBeNull();
  });

  it("never opens for a pointer sweeping across the wall", () => {
    render(<Wall />);
    const [a, b] = screen.getAllByRole("button");
    fireEvent.pointerEnter(a!);
    act(() => vi.advanceTimersByTime(INSPECT_DELAY / 2));
    fireEvent.pointerLeave(a!);
    fireEvent.pointerEnter(b!);
    act(() => vi.advanceTimersByTime(INSPECT_DELAY / 2));
    expect(preview()).toBeNull();
    act(() => vi.advanceTimersByTime(INSPECT_DELAY / 2));
    expect(preview()?.querySelector("img")?.getAttribute("src")).toContain("id-opt");
  });

  it("goes down on a press and rests anew on its release over the tile", () => {
    render(<Wall />);
    const tile = screen.getByRole("button", { name: "Shock" });
    fireEvent.pointerEnter(tile);
    rest();
    fireEvent.pointerDown(tile);
    expect(preview()).toBeNull();
    fireEvent.pointerUp(tile);
    expect(preview()).toBeNull();
    rest();
    expect(preview()).not.toBeNull();
  });

  it("goes down on Escape and on a scroll", () => {
    render(<Wall />);
    const tile = screen.getByRole("button", { name: "Shock" });
    fireEvent.pointerEnter(tile);
    rest();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(preview()).toBeNull();

    fireEvent.pointerLeave(tile);
    fireEvent.pointerEnter(tile);
    rest();
    fireEvent.scroll(document.body);
    expect(preview()).toBeNull();
  });

  it("does not open while a popup is open", () => {
    render(
      <>
        <button type="button" aria-haspopup="listbox" aria-expanded="true">
          Sort
        </button>
        <Wall />
      </>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Shock" }));
    rest();
    expect(preview()).toBeNull();
  });

  it("opens for a tile the keyboard moved to, and not for one a click focused", () => {
    render(<Wall />);
    const tile = screen.getByRole("button", { name: "Shock" });
    act(() => tile.focus());
    rest();
    expect(preview()).toBeNull();
    act(() => tile.blur());

    document.documentElement.setAttribute(KEYBOARD_MODALITY_ATTR, "");
    act(() => tile.focus());
    rest();
    expect(preview()).not.toBeNull();
    act(() => tile.blur());
    expect(preview()).toBeNull();
  });
});
