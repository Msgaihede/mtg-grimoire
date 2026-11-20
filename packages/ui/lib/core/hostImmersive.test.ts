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

type Sentinel = EventTarget & { released: boolean; release: () => Promise<void> };

/**
 * The Screen Wake Lock API as a phone's browser answers it — jsdom has none of it. `answer` holds
 * each request's answer back until the test hands it over; `lapse` is the browser letting go by
 * itself, as it does whenever the page is hidden.
 */
function stubWakeLock({ refuse = false, held = false } = {}) {
  const sentinels: Sentinel[] = [];
  const pending: Array<() => void> = [];
  const request = vi.fn((type: string) => {
    expect(type).toBe("screen");
    if (refuse) return Promise.reject(new DOMException("Battery saver", "NotAllowedError"));
    const sentinel: Sentinel = Object.assign(new EventTarget(), {
      released: false,
      release: vi.fn(() => {
        lapse(sentinel);
        return Promise.resolve();
      }),
    });
    sentinels.push(sentinel);
    if (!held) return Promise.resolve(sentinel);
    return new Promise<Sentinel>((resolve) => pending.push(() => resolve(sentinel)));
  });
  const lapse = (sentinel: Sentinel) => {
    if (sentinel.released) return;
    sentinel.released = true;
    sentinel.dispatchEvent(new Event("release"));
  };
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  return {
    request,
    sentinels,
    holding: () => sentinels.filter((s) => !s.released),
    answer: () => pending.splice(0).forEach((resolve) => resolve()),
    lapseAll: () => sentinels.forEach(lapse),
  };
}

/** `screen.orientation` as a phone's browser answers it; jsdom's screen has no orientation. */
function stubOrientation({
  type = "portrait-primary" as OrientationType,
  refuse = false,
  held = false,
} = {}) {
  const pending: Array<() => void> = [];
  const lock = vi.fn<(to: OrientationLockType) => Promise<void>>(() => {
    if (refuse) return Promise.reject(new DOMException("Not full screen", "NotSupportedError"));
    if (!held) return Promise.resolve();
    return new Promise<void>((resolve) => pending.push(resolve));
  });
  const unlock = vi.fn();
  Object.defineProperty(screen, "orientation", {
    configurable: true,
    value: { type, lock, unlock },
  });
  return { lock, unlock, answer: () => pending.splice(0).forEach((resolve) => resolve()) };
}

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
/** The page hidden or shown, as a phone's app switcher does it. */
function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Every answer a stub has already given, and whatever it set going, landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  delete (window as Bridged).grimoireImmersive;
  // The module keeps what it holds between calls: let it all go before the stubs do.
  setImmersive(false);
  await settle();
  visibility = "visible";
  for (const name of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) {
    delete (document as unknown as Record<string, unknown>)[name];
  }
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  delete (navigator as unknown as Record<string, unknown>).wakeLock;
  delete (screen as unknown as Record<string, unknown>).orientation;
});

describe("immersive full screen", () => {
  it("asks a host's bridge where there is one, and never the browser", async () => {
    const bridge = { setImmersive: vi.fn() };
    (window as Bridged).grimoireImmersive = bridge;
    const { request, exit } = stubFullscreen();
    const wake = stubWakeLock();
    const rotation = stubOrientation();

    setImmersive(true);
    await settle();
    setImmersive(false);

    expect(bridge.setImmersive.mock.calls).toEqual([[true], [false]]);
    // The Android host's WebView hides a requested full screen at once; the bridge is the road,
    // and it holds the rotation and keeps the screen on itself.
    expect(request).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(wake.request).not.toHaveBeenCalled();
    expect(rotation.lock).not.toHaveBeenCalled();
    expect(rotation.unlock).not.toHaveBeenCalled();
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

  it("does nothing where there is neither a bridge nor any of the browser's APIs", () => {
    expect(() => setImmersive(true)).not.toThrow();
    expect(() => setImmersive(false)).not.toThrow();
  });
});

describe("the screen kept on (issue #1716)", () => {
  it("holds a wake lock while immersive, and lets it go", async () => {
    const wake = stubWakeLock();

    setImmersive(true);
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);
    expect(wake.holding()).toHaveLength(1);

    setImmersive(false);
    expect(wake.sentinels[0]?.release).toHaveBeenCalledTimes(1);
    expect(wake.holding()).toEqual([]);
  });

  it("takes it again when the page comes back, since the browser let go while it was hidden", async () => {
    const wake = stubWakeLock();
    setImmersive(true);
    await settle();

    // The app switcher: the browser releases the lock itself, and a hidden page is not asked.
    show("hidden");
    wake.lapseAll();
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);

    show("visible");
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(2);
    expect(wake.holding()).toHaveLength(1);

    // Shown again while it still holds one: no second lock beside it.
    show("visible");
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(2);

    setImmersive(false);
    expect(wake.holding()).toEqual([]);
    // And once off, a return to the page asks for nothing.
    show("hidden");
    show("visible");
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(2);
  });

  it("asks a page that mounts hidden only once it is shown", async () => {
    const wake = stubWakeLock();
    visibility = "hidden";
    setImmersive(true);
    await settle();
    expect(wake.request).not.toHaveBeenCalled();

    show("visible");
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);
  });

  it("never asks twice while an answer is on its way", async () => {
    const wake = stubWakeLock({ held: true });
    setImmersive(true);
    setImmersive(true);
    show("visible");
    expect(wake.request).toHaveBeenCalledTimes(1);
    wake.answer();
    await settle();
    expect(wake.holding()).toHaveLength(1);
  });

  it("lets go at once of a lock that is handed over after the board has gone", async () => {
    const wake = stubWakeLock({ held: true });
    setImmersive(true);
    setImmersive(false);

    wake.answer();
    await settle();
    expect(wake.sentinels[0]?.release).toHaveBeenCalledTimes(1);
    expect(wake.holding()).toEqual([]);
  });

  it("swallows a refusal — a battery saver, a policy", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const wake = stubWakeLock({ refuse: true });

    expect(() => setImmersive(true)).not.toThrow();
    await settle();
    expect(wake.request).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});

describe("the rotation held (issue #1716)", () => {
  it("locks the exact rotation the screen is in once full screen is granted, and lets it go", async () => {
    const fullscreen = stubFullscreen();
    // Upside down on its side: the lock is that rotation, not just "landscape", so a phone flat
    // on the table never flips.
    const rotation = stubOrientation({ type: "landscape-secondary" });

    setImmersive(true);
    // Chrome holds a rotation only for a page that is full screen: the lock waits for the answer.
    expect(rotation.lock).not.toHaveBeenCalled();
    await settle();
    expect(rotation.lock.mock.calls).toEqual([["landscape-secondary"]]);

    setImmersive(false);
    expect(rotation.unlock).toHaveBeenCalledTimes(1);
    expect(fullscreen.exit).toHaveBeenCalledTimes(1);
  });

  it("still asks when full screen is refused — an installed app may hold one without it", async () => {
    stubFullscreen({ refuse: true });
    const rotation = stubOrientation();
    setImmersive(true);
    await settle();
    expect(rotation.lock).toHaveBeenCalledTimes(1);
  });

  it("asks at once where there is no Fullscreen API, or the page is already full screen", async () => {
    const rotation = stubOrientation();
    setImmersive(true);
    expect(rotation.lock).toHaveBeenCalledTimes(1);
    setImmersive(false);

    const fullscreen = stubFullscreen();
    await document.documentElement.requestFullscreen();
    fullscreen.request.mockClear();
    setImmersive(true);
    expect(fullscreen.request).not.toHaveBeenCalled();
    expect(rotation.lock).toHaveBeenCalledTimes(2);
  });

  it("asks for nothing when the board has gone before full screen answered", async () => {
    stubFullscreen();
    const rotation = stubOrientation();
    setImmersive(true);
    setImmersive(false);
    await settle();
    expect(rotation.lock).not.toHaveBeenCalled();
  });

  it("lets a rotation granted after the board has gone go again", async () => {
    const rotation = stubOrientation({ held: true });
    setImmersive(true);
    setImmersive(false);
    expect(rotation.unlock).toHaveBeenCalledTimes(1);

    rotation.answer();
    await settle();
    expect(rotation.unlock).toHaveBeenCalledTimes(2);
  });

  it("swallows a refusal — a page not full screen, a desktop browser", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    const rotation = stubOrientation({ refuse: true });

    expect(() => setImmersive(true)).not.toThrow();
    await settle();
    expect(rotation.lock).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
