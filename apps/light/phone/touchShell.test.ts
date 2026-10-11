import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LOCKED_VIEWPORT, TOUCH_SHELL_CLASS, useTouchShell } from "./touchShell";

const FOUND = "width=device-width, initial-scale=1.0, viewport-fit=cover";

afterEach(() => document.head.querySelector('meta[name="viewport"]')?.remove());

describe("the phone face's touch shell", () => {
  it("stops the page zooming while the face is up, and gives the tag back as it found it", () => {
    const tag = document.createElement("meta");
    tag.name = "viewport";
    tag.content = FOUND;
    document.head.append(tag);

    const { unmount } = renderHook(() => useTouchShell());
    expect(tag.content).toBe(LOCKED_VIEWPORT);
    expect(document.documentElement).toHaveClass(TOUCH_SHELL_CLASS);

    unmount();
    expect(tag.content).toBe(FOUND);
    expect(document.documentElement).not.toHaveClass(TOUCH_SHELL_CLASS);
  });

  it("keeps `index.html`'s own terms, so the locked tag still reaches under a cutout", () => {
    for (const term of FOUND.split(", ")) expect(LOCKED_VIEWPORT).toContain(term);
    expect(LOCKED_VIEWPORT).toContain("user-scalable=no");
  });
});
