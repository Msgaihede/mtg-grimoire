import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CameraBox } from "./CameraBox";

describe("the camera's box", () => {
  const ref = { current: null as HTMLVideoElement | null };
  // The overlay asks its canvas for a 2D context on every animation frame, which jsdom answers
  // with a "Not implemented" line; no context stops its loop at its own guard, quietly.
  const real = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  beforeAll(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
  });
  afterAll(() => {
    if (real !== undefined) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", real);
  });

  it("fills what the page leaves it, and crops the picture and the overlay alike", () => {
    const { container } = render(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "live", width: 1080, height: 1920, deviceId: null }}
        verdict={null}
      />,
    );
    const box = container.querySelector<HTMLElement>("[data-camera-box]");
    // A zero-basis grow in a column the page's height: the page no longer scrolls.
    expect(box).toHaveClass("relative", "flex-1", "min-h-0");
    // Not shaped by the stream any more, and not capped by the screen.
    expect(box?.style.aspectRatio).toBe("");
    expect(box?.className).not.toMatch(/max-h-/);
    // The one class the video and the canvas over it have to agree on.
    expect(container.querySelector("video")?.classList.contains("object-cover")).toBe(true);
    expect(container.querySelector("canvas")?.classList.contains("object-cover")).toBe(true);
  });

  it("lays the caller's children over the picture, and says nothing of its own over a live one", () => {
    const { container } = render(
      <CameraBox videoRef={ref} camera={{ kind: "starting" }} verdict={null}>
        <p data-testid="laid-over">Over the picture</p>
      </CameraBox>,
    );
    const box = container.querySelector("[data-camera-box]");
    expect(screen.getByTestId("laid-over").parentElement).toBe(box);
    // The note chip went to the HUD (`ScanHud`): no region of the box's own.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the camera's own sentence where the picture would be", () => {
    render(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "error", name: "NotFoundError", message: "No camera on this device." }}
        verdict={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("No camera on this device.");
  });

  it("says a host has no scanner session where the picture would be", () => {
    render(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "starting" }}
        verdict={null}
        unavailable="The scanner does not run in a browser yet."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The scanner does not run in a browser yet.",
    );
  });
});
