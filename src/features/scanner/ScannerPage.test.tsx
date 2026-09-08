import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_SENTENCE } from "./verdictText";
import { STATUS, VERDICTS } from "./fixtures";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      scannerStatus: vi.fn(async () => STATUS.missing),
      scannerFrame: vi.fn(),
      scannerReset: vi.fn(),
      scannerCapture: vi.fn(async () => ({ saved: "live-7.jpg" })),
    },
  };
});
import { isWebTarget } from "@/pwa/target";
import { ipc } from "@/lib/ipc";
import { ScannerPage } from "./ScannerPage";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScannerPage />
    </QueryClientProvider>,
  );
}

/** The camera, answered. A refusal is the state most of these tests want the video box in. */
function mediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}
function refused() {
  mediaDevices(() => Promise.reject(new DOMException("x", "NotAllowedError")));
}

/**
 * A 2D context that answers every call `Overlay` and `defaultGrabFrame` make of one.
 *
 * jsdom has no canvas at all, so `Overlay`'s `requestAnimationFrame` loop normally stops at its
 * `ctx === null` guard. Handing it a context restarts that loop — and a context carrying only
 * `drawImage` makes the *first* line it reaches (`clearRect`) an uncaught `TypeError` on every
 * frame, outside any test's stack. So the fake is the whole of what both callers use.
 */
function context2d() {
  return {
    clearRect: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    setLineDash: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    stroke: () => {},
    fill: () => {},
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
  };
}

/** Install `props` on `target`, and hand back the function that puts what was there back. */
function shim(target: object, props: Record<string, PropertyDescriptor>): () => void {
  const saved = Object.keys(props).map(
    (key) => [key, Object.getOwnPropertyDescriptor(target, key)] as const,
  );
  Object.entries(props).forEach(([key, descriptor]) =>
    Object.defineProperty(target, key, { configurable: true, ...descriptor }),
  );
  return () =>
    saved.forEach(([key, descriptor]) => {
      if (descriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, descriptor);
    });
}

/**
 * The canvas half, for every test in this file — `Overlay` mounts on all of them and asks for a
 * 2D context on every animation frame, which jsdom answers with a "Not implemented" line on its
 * virtual console. The fake keeps the run's output clean and costs the overlay nothing: with no
 * video shim the canvas is still 0×0 and `draw` returns before it paints anything.
 */
function shimCanvas(): () => void {
  return shim(HTMLCanvasElement.prototype, {
    getContext: { value: context2d },
    toBlob: { value: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([1, 2, 3])])) },
  });
}

/**
 * The video half — jsdom's `<video>` has no pixels, so the page's own element answers 0×0 and
 * `grab` returns `null` in every test that does not call this. These are the four properties the
 * loop and the camera read; `readyState` at `HAVE_ENOUGH_DATA` is what lets the pump send.
 */
function shimVideo(): () => void {
  return shim(HTMLVideoElement.prototype, {
    videoWidth: { get: () => 1280 },
    videoHeight: { get: () => 720 },
    readyState: { get: () => 4 },
    play: { value: () => Promise.resolve() },
  });
}

/** A camera that opens, so the pump runs. The stream is the one call `useCamera` makes of it. */
function opens() {
  mediaDevices(() =>
    Promise.resolve({ getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream),
  );
}

/** `useNarrowWindow`'s answer, at read time — the hook keeps no `MediaQueryList`. */
function windowIsNarrow(narrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches: narrow,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

/** The layout row: the one element between the `sr-only` heading and the two columns. */
function row(container: HTMLElement): HTMLElement {
  const found = container.querySelector("h2 + div");
  if (found === null) throw new Error("no layout row under the heading");
  return found as HTMLElement;
}

let restoreCanvas = () => {};
beforeEach(() => {
  restoreCanvas = shimCanvas();
});
afterEach(() => {
  restoreCanvas();
  vi.restoreAllMocks();
  // `restoreAllMocks` reaches `vi.spyOn` and nothing else, so the four command mocks keep
  // whatever the last test queued on them — a `mockReturnValue` outliving its own test is how a
  // suite becomes order-dependent. `mockReset` puts each back to the implementation its
  // `vi.fn(…)` was built with, which is the state every test below expects to start from.
  [ipc.scannerStatus, ipc.scannerFrame, ipc.scannerReset, ipc.scannerCapture].forEach((command) =>
    vi.mocked(command).mockReset(),
  );
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("ScannerPage", () => {
  it("says the web build has no detector and asks for no camera", () => {
    vi.mocked(isWebTarget).mockReturnValueOnce(true);
    const getUserMedia = vi.fn();
    mediaDevices(getUserMedia);
    mount();
    expect(screen.getByText(WEB_SENTENCE)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();
    expect(vi.mocked(ipc.scannerStatus)).not.toHaveBeenCalled();
  });

  it("shows the refused camera's sentence in place of the video, and the panels beside it", async () => {
    refused();
    mount();
    expect(
      await screen.findByText("MTG Grimoire needs camera access to scan a card."),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Match" })).toBeInTheDocument();
    expect(await screen.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
  });

  it("has an sr-only heading, because the ribbon carries the visible title", () => {
    refused();
    mount();
    expect(screen.getByRole("heading", { level: 2, name: "Scanner" })).toHaveClass("sr-only");
  });

  it("reserves the detector's strip whether or not there is a sentence in it", async () => {
    refused();
    const { container } = mount();
    const strip = container.querySelector("[aria-live='polite']");
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent("");
    // Two lines of room, kept whether the strip is empty or full, so the video box above it
    // does not change height the moment the detector has something to say.
    expect(strip).toHaveClass("min-h-[2.5em]");
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    expect(container.querySelector("[aria-live='polite']")).toHaveTextContent("");
  });

  it("prints the frame's own refusal in that strip", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerFrame).mockResolvedValueOnce(VERDICTS.noCard);
    vi.mocked(ipc.scannerFrame).mockReturnValue(new Promise(() => {}));
    try {
      const { container } = mount();
      expect(await screen.findByText(VERDICTS.noCard.error ?? "")).toBeInTheDocument();
      expect(container.querySelector("[aria-live='polite']")).toHaveTextContent(
        VERDICTS.noCard.error ?? "",
      );
    } finally {
      restore();
    }
  });

  it("stacks the camera above the panels on a phone and puts them beside it otherwise", () => {
    refused();
    windowIsNarrow(true);
    const narrow = mount();
    expect(row(narrow.container)).toHaveClass("flex-col");
    narrow.unmount();

    windowIsNarrow(false);
    const wide = mount();
    expect(row(wide.container).classList.contains("flex-col")).toBe(false);
  });

  it("hands the reset press straight to the command", async () => {
    refused();
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Reset evidence" }));
    expect(vi.mocked(ipc.scannerReset)).toHaveBeenCalled();
  });

  it("files a capture under the five fields the sidecar has, read off the last verdict", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerFrame).mockResolvedValueOnce(VERDICTS.decided);
    vi.mocked(ipc.scannerFrame).mockReturnValue(new Promise(() => {}));
    try {
      mount();
      // The headline over the video, which is the tell that the verdict has landed.
      expect(await screen.findByText("Storm of Saruman")).toBeInTheDocument();
      await userEvent.type(
        screen.getByRole("textbox", { name: "What it actually is" }),
        "Storm of Saruman",
      );
      await userEvent.click(screen.getByRole("button", { name: "Add frame to dataset" }));
      await waitFor(() => expect(vi.mocked(ipc.scannerCapture)).toHaveBeenCalled());
      const [bytes, sidecar] = vi.mocked(ipc.scannerCapture).mock.calls[0] ?? [];
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(sidecar).toEqual({
        expected: "Storm of Saruman",
        reported: "Storm of Saruman",
        confidence: "1.000",
        votes: "8.00",
        distance: "30",
      });
      expect(await screen.findByText("saved live-7.jpg")).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});
