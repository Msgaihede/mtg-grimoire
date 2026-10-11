import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinchZoom, ZOOM_TAP } from "./PinchZoom";

const at = (x: number, y = 0) => ({ clientX: x, clientY: y });

function picture() {
  render(
    <PinchZoom>
      <p>Picture</p>
    </PinchZoom>,
  );
  const layer = screen.getByText("Picture").parentElement as HTMLElement;
  const frame = layer.parentElement as HTMLElement;
  return { layer, frame };
}

function tap(frame: HTMLElement, t: number) {
  fireEvent.touchStart(frame, { touches: [at(10)] });
  fireEvent.touchEnd(frame, { touches: [], timeStamp: t });
}

describe("a pinch on the card sheet's picture", () => {
  it("zooms the picture by the spread of two fingers", () => {
    const { layer, frame } = picture();
    fireEvent.touchStart(frame, { touches: [at(0), at(50)] });
    fireEvent.touchMove(frame, { touches: [at(0), at(100)] });
    expect(layer.style.transform).toContain("scale(2)");
  });

  it("zooms in on a double tap and back out on the next", () => {
    const { layer, frame } = picture();
    tap(frame, 1000);
    tap(frame, 1100);
    expect(layer.style.transform).toContain(`scale(${ZOOM_TAP})`);
    tap(frame, 2000);
    tap(frame, 2100);
    expect(layer.style.transform).toBe("");
  });

  it("never draws the picture smaller than its frame", () => {
    const { layer, frame } = picture();
    fireEvent.touchStart(frame, { touches: [at(0), at(100)] });
    fireEvent.touchMove(frame, { touches: [at(0), at(20)] });
    expect(layer.style.transform).toBe("");
  });

  it("leaves one finger on a picture at rest to the sheet's scroll", () => {
    const { layer, frame } = picture();
    fireEvent.touchStart(frame, { touches: [at(0)] });
    const move = fireEvent.touchMove(frame, { touches: [at(0, 80)] });
    expect(move).toBe(true);
    expect(layer.style.transform).toBe("");
  });
});
