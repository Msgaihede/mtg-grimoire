import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmersive } from "./hostImmersive";

type Bridged = Window & { grimoireImmersive?: unknown };

/** The Fullscreen API as a browser that grants it answers it — jsdom has none of it. */
function stubFullscreen({ enabled = true, refuse = false } = {}) {
  let element: Element | null = null;
  const request = vi.fn(function (this: Element) {
    if (refuse) return Promise.reject(new TypeError("Permissions check failed"));
    element = document.documentElement;
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    element = null;
    return Promise.resolve();
  });
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: request,
  });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  return { request, exit };
}

afterEach(() => {
  delete (window as Bridged).grimoireImmersive;
  for (const name of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) {
    delete (document as unknown as Record<string, unknown>)[name];
  }
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
});

describe("immersive full screen", () => {
  it("asks a host's bridge where there is one, and never the browser", () => {
    const bridge = { setImmersive: vi.fn() };
    (window as Bridged).grimoireImmersive = bridge;
    const { request, exit } = stubFullscreen();

    setImmersive(true);
    setImmersive(false);

    expect(bridge.setImmersive.mock.calls).toEqual([[true], [false]]);
    // The Android host's WebView hides a requested full screen at once; the bridge is the road.
    expect(request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("survives a bridge that throws", () => {
    (window as Bridged).grimoireImmersive = {
      setImmersive: () => {
        throw new Error("no");
      },
    };
    expect(() => setImmersive(true)).not.toThrow();
  });

  it("takes something with no setImmersive for no bridge at all", () => {
    (window as Bridged).grimoireImmersive = {};
    const { request } = stubFullscreen();
    setImmersive(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("puts the document full screen with the browser's bar hidden, and back", async () => {
    const { request, exit } = stubFullscreen();

    setImmersive(true);
    expect(request).toHaveBeenCalledWith({ navigationUI: "hide" });
    expect(request.mock.contexts[0]).toBe(document.documentElement);
    await Promise.resolve();
    expect(document.fullscreenElement).toBe(document.documentElement);

    // Already full screen: asked again, it does not ask the browser twice.
    setImmersive(true);
    expect(request).toHaveBeenCalledTimes(1);

    setImmersive(false);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("leaves a page that is not full screen alone when turned off", () => {
    const { exit } = stubFullscreen();
    setImmersive(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("asks nothing of a browser that does not allow full screen", () => {
    const { request } = stubFullscreen({ enabled: false });
    setImmersive(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("swallows a refused request — no press, or a browser that says no", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const { request } = stubFullscreen({ refuse: true });

    expect(() => setImmersive(true)).not.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("does nothing where there is neither a bridge nor a Fullscreen API", () => {
    expect(() => setImmersive(true)).not.toThrow();
    expect(() => setImmersive(false)).not.toThrow();
  });
});
