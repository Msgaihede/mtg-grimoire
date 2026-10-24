import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

/**
 * Whether the page is out of sight, driven by the test — `useParked.test.ts` owns the hidden
 * document, the grace and the return, so this file asks only what the page does with each answer.
 */
const parked = vi.hoisted(() => {
  let value = { paused: false, released: false };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: { paused: boolean; released: boolean }) {
      value = next;
      listeners.forEach((cb) => cb());
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
});
vi.mock("@grimoire/ui/features/scanner/useParked", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("@grimoire/ui/features/scanner/useParked")>()),
    usePageParked: () => useSyncExternalStore(parked.subscribe, parked.get),
  };
});
/**
 * Every burst the page hands the confetti, render by render — the shared `TierConfetti` drawn
 * under a wrapper that writes its prop down. jsdom lays nothing out, so the component itself
 * throws nothing here; what the page owes it is the burst. Emptied after each test.
 */
const confetti = vi.hoisted(() => ({ bursts: [] as (ConfettiBurst | null)[] }));
vi.mock("@grimoire/ui/features/scanner/reader/TierConfetti", async (original) => {
  const real = await original<typeof import("@grimoire/ui/features/scanner/reader/TierConfetti")>();
  const { createElement } = await import("react");
  return {
    ...real,
    TierConfetti: (props: TierConfettiProps) => {
      confetti.bursts.push(props.burst);
      return createElement(real.TierConfetti, props);
    },
  };
});

import { FAKE_SCAN_ID, SCAN_INBOX_FULL } from "@grimoire/fake/db";
import { printing } from "@grimoire/fake/fixtures";
import type { CommandTable } from "@grimoire/fake/scope";
import { FRAMES_PER_CARD, newScanScript, scanStep } from "@grimoire/fake/scannerScript";
import {
  DEFAULT_SCANNER_PREFS,
  NEEDS_A_FINISH_ROW,
  STATUS,
  TRAY_ROWS,
  VERDICTS,
} from "@grimoire/ui/features/scanner/fixtures";
import {
  HOLD_TITLE,
  SCANNING_CHIP,
  START,
  STOP,
  STOPPED_TITLE,
} from "@grimoire/ui/features/scanner/reader/readerText";
import type {
  ConfettiBurst,
  TierConfettiProps,
} from "@grimoire/ui/features/scanner/reader/TierConfetti";
import { runClock } from "@grimoire/ui/features/scanner/submit/run";
import {
  DB_BUSY,
  SCANNER_NOT_IN_A_BROWSER_YET,
  SCANNER_OPEN_ELSEWHERE,
} from "@grimoire/ui/features/scanner/verdictText";
import type {
  CollectionImportItem,
  ScanFilters,
  ScannerPrefs,
  ScannerSubmission,
  ScannerTrayRow,
  ScannerVerdict,
  SupporterStatus,
} from "@grimoire/ui/lib/ipc";
import { useNotifications } from "@grimoire/ui/lib/notifications";
import { supporterState } from "@grimoire/ui/lib/query";
import type { FakeParams } from "@grimoire/fake/world";
import type { TrayDestination } from "@grimoire/ui/features/scanner/useTrayDestination";
import { PhoneFace } from "../PhoneApp";
import { ScannerPage } from "./ScannerPage";
import { holdOnItsSide, installLayout, renderPhone } from "../testing";

/**
 * Generous on purpose, and the file's own test timeout with it: these tests pump frames through a
 * whole page, and a wait sized for an idle machine fails on a busy one for no reason a reader of
 * the failure could act on.
 */
const SETTLE = { timeout: 12_000 };
vi.setConfig({ testTimeout: 45_000 });
/** The last of a list — `Array.prototype.at` is past this program's `lib`. */
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
/** The fixture tray's three rows that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);
/**
 * **A supporter's world.** *Send scan…* is drawn for a supporter and for nobody else, and the
 * fake's own `starter` world is not one — so every test that asks why the press is or is not
 * there for a reason of its own (no camera, a Stop, a trade) is mounted in this one, where the
 * membership would have let it be drawn. Entitled through its group, which is how a phone is.
 */
const SUPPORTER: FakeParams = { seed: "starter", fault: "patreonGroupEntitled" };

/* ------------------------------------------------------------------ the browser's half ---- */

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
 * A 2D context that answers every call `Overlay` and the pump's grab make of one — the desktop
 * suite's, and for its reason: a context carrying only `drawImage` makes the overlay's next line an
 * uncaught `TypeError` on every animation frame, outside any test's stack.
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

/**
 * The canvas, for every test: `Overlay` asks for a 2D context on every animation frame, which
 * jsdom answers with a "Not implemented" line, and `toBlob` is what the pump's grab encodes
 * through.
 */
const shimCanvas = () =>
  shim(HTMLCanvasElement.prototype, {
    getContext: { value: context2d },
    toBlob: { value: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([1, 2, 3])])) },
  });

/** A `<video>` with pixels — jsdom's has none, so the pump would never have a frame to send. */
const shimVideo = () =>
  shim(HTMLVideoElement.prototype, {
    videoWidth: { get: () => 1080 },
    videoHeight: { get: () => 1920 },
    readyState: { get: () => 4 },
    play: { value: () => Promise.resolve() },
  });

function mediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}

/** A camera that opens, and says when its track is stopped. */
function camera() {
  const stop = vi.fn();
  const getUserMedia = vi.fn(() =>
    Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
  );
  mediaDevices(getUserMedia);
  return { stop, getUserMedia };
}

/** A camera that refuses in the browser's own way. */
function noCamera(name: string) {
  const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", name)));
  mediaDevices(getUserMedia);
  return getUserMedia;
}

/* ------------------------------------------------------------------ the host's half ------- */

type Frame = (jpeg: unknown, options?: unknown) => Promise<ScannerVerdict>;

/**
 * **Every test that opens a camera answers its own frames**, and never leaves the fake's script to
 * — for the pace now, and for a hazard that was found here. The script answers a frame 110 ms
 * later. A test that ended with one on the wire had that call settle in the *next* test, where the
 * fake's `invoke` pointed the fake back at its own world on the way out — the world of a test that
 * was over — and the next test's tray writes and frames, made from timers and continuations rather
 * than from a query, were answered by it: a tray that was never stored and cards from another
 * test's pile, two runs in three. `invoke` no longer points back at a world that has gone
 * (`scope.ts`' `standing`, with `world.test.ts` staging exactly this).
 *
 * The answers below settle in 3 ms, and {@link settled} still waits them out before a test ends:
 * a test's last frame is its own to see land.
 */

/**
 * Which of a card's thirteen frames a test is answered with: nothing in frame, the frame that
 * decides, and two of the card lying there. Four frames a card rather than thirteen — every frame
 * is a render of the whole page, and on a machine with every core busy thirteen of them a card,
 * and then six, ran this file past its waits (a tray one card long after eight seconds) — and
 * still more than `DECISION_GAP_FRAMES` verdicts between two decisions, which is the one thing
 * the page's loop asks of the spacing. The frames in which the tracker weighs a card are the
 * fake's own suite's to show (`scannerScript.test.ts`).
 */
const SHOWN = [0, 7, 8, 9];

/**
 * The fake's own pile — its first `cards` cards, a few milliseconds a frame instead of a hundred
 * — and then either nothing at all (every later frame parked) or an empty desk for as long as the
 * page goes on asking (`"looking"`, for a test that counts frames rather than cards).
 *
 * **Never an answer already settled**: the pump would go round on microtasks alone and starve
 * every timer in the file, the test's own waits included.
 */
function pile(cards: number, after: "parked" | "looking" = "parked") {
  const script = newScanScript();
  // What rode beside each frame's bytes — nothing, since a frame is its JPEG alone.
  const sent: unknown[] = [];
  let asked = 0;
  const frame: Frame = (_jpeg, options) => {
    sent.push(options);
    const at = asked++;
    const card = Math.floor(at / SHOWN.length);
    if (card >= cards && after === "parked") return new Promise(() => {});
    return new Promise((answer) =>
      setTimeout(() => {
        // Past the pile the desk is empty: the first frame of a card that is never laid down.
        script.frame =
          card >= cards
            ? cards * FRAMES_PER_CARD
            : card * FRAMES_PER_CARD + SHOWN[at % SHOWN.length];
        answer(scanStep(script, false));
      }, 3),
    );
  };
  return { frame, sent };
}

/** These verdicts in order, a few milliseconds each, and every frame after the last parked. */
function frames(...verdicts: ScannerVerdict[]): Frame {
  let n = 0;
  return () => {
    const verdict = verdicts[n++];
    return verdict === undefined
      ? new Promise(() => {})
      : new Promise((answer) => setTimeout(() => answer(verdict), 3));
  };
}

/**
 * The page over the fake, with the scanner's writes watched and whatever a test wants answered
 * differently laid over them.
 */
function mount({
  fake,
  prefs,
  tray,
  over,
  destination,
}: {
  /** The page alone, filing into this — as the Trade page's sheet mounts it — and not the face. */
  destination?: TrayDestination;
  fake?: FakeParams;
  /** What `scanner_prefs` answers, over the crate's defaults. */
  prefs?: Partial<ScannerPrefs>;
  /** What `scanner_tray` answers: a tray scanned on an earlier visit. */
  tray?: ScannerTrayRow[];
  /** Handlers laid over the world's and this file's watchers, handed the world's own table. */
  over?: (own: CommandTable) => CommandTable;
} = {}) {
  const seen = {
    prefs: [] as ScannerPrefs[],
    trays: [] as ScannerTrayRow[][],
    commits: [] as {
      items: CollectionImportItem[];
      folderId: number | null;
      remaining: ScannerTrayRow[];
    }[],
    holds: 0,
    resets: 0,
  };
  const page =
    destination === undefined ? <PhoneFace /> : <ScannerPage destination={destination} />;
  const view = renderPhone(page, {
    path: "/scanner",
    fake,
    commands: (own) => {
      const call = (name: string, args?: unknown) =>
        (own[name] as (a: unknown) => unknown)(args ?? {});
      return {
        ...(prefs && { scanner_prefs: () => ({ ...DEFAULT_SCANNER_PREFS, ...prefs }) }),
        ...(tray && { scanner_tray: () => tray }),
        set_scanner_prefs: (args: { prefs: ScannerPrefs }) => {
          seen.prefs.push(args.prefs);
          return call("set_scanner_prefs", args);
        },
        set_scanner_tray: (args: { rows: ScannerTrayRow[] }) => {
          seen.trays.push(args.rows);
          return call("set_scanner_tray", args);
        },
        scanner_tray_commit: (args: (typeof seen.commits)[number]) => {
          seen.commits.push(args);
          return call("scanner_tray_commit", args);
        },
        scanner_hold: () => {
          seen.holds += 1;
          return call("scanner_hold");
        },
        scanner_reset: () => {
          seen.resets += 1;
          return call("scanner_reset");
        },
        ...over?.(own),
      };
    },
  });
  return { seen, view };
}

/**
 * **The page opens stopped** (issue #1317): the camera comes on, and nothing is read until Start
 * is pressed — pressed here as a reader would, so the pump runs.
 */
async function start() {
  await userEvent.click(await screen.findByRole("button", { name: START }, SETTLE));
}

/** Long enough for an answer already on its 3 ms timer to land. */
const settled = () => new Promise<void>((done) => setTimeout(done, 20));

const statusLine = () => screen.getByRole("status", { name: "Scanner status" });
/** The camera's box — the picture, and everything laid over it. */
const cameraBox = () => document.querySelector<HTMLElement>("[data-camera-box]") as HTMLElement;
/** The tray's bar: the folder, Add, and the alert a refused Add or Archive says over them. */
const trayBar = () => document.querySelector<HTMLElement>("[data-scanner-bar]") as HTMLElement;
/**
 * The alert that has something to say. The HUD's chip is an alert too, mounted empty so it is
 * watched before it speaks — so "the alert" on this page is the one with words in it.
 */
async function sayingAlert(): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = screen.getAllByRole("alert").find((alert) => alert.textContent !== "");
    expect(found).toBeDefined();
  }, SETTLE);
  return found as HTMLElement;
}
/**
 * The list's rows, name and quantity — the column beside the picture, **which the page mounts
 * only on its side**: upright the list is the tray sheet's, opened from the peek. A test that
 * reads or works the rows themselves holds the phone on its side first (`holdOnItsSide`), where
 * they are on the page with no sheet over the picture.
 */
const trayRows = () =>
  within(screen.getByRole("region", { name: "Scanned cards" }))
    .queryAllByRole("listitem")
    .map((li) => [
      li.querySelector("span.text-sm")?.textContent,
      li.querySelector("output")?.textContent ?? "?",
    ]);
const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name });

let restoreCanvas = () => {};
let restoreVideo = () => {};
/** A test's own canvas, laid over the file's (the Send scan tests number their frames). */
let restoreFrames = () => {};
/** The run's clock put back on the wall (the Send scan tests take it off — see their describe). */
let restoreClock = () => {};
beforeEach(() => {
  installLayout();
  restoreCanvas = shimCanvas();
});
afterEach(async () => {
  // The page unmounted now rather than by the setup file's cleanup after this hook, and then a
  // moment for a frame still on the wire to settle inside this test — see the note above
  // `SHOWN`. A parked frame never settles and needs no waiting for.
  cleanup();
  await settled();
  // After the page has gone, so no frame of this test is stamped by two clocks.
  restoreClock();
  restoreClock = () => {};
  // Lifted before the file's own: it was laid over that one, and puts that one back.
  restoreFrames();
  restoreFrames = () => {};
  restoreCanvas();
  restoreVideo();
  restoreVideo = () => {};
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  parked.set({ paused: false, released: false });
  confetti.bursts.length = 0;
});

describe("the phone's Scanner page", () => {
  it("mounts quietly where there is no camera to ask, with its tray and its bar drawn", async () => {
    // jsdom: `navigator.mediaDevices` is not there at all. Every other suite that walks through
    // this tab meets it like this.
    const { seen } = mount();
    // The peek's, and only the peek's: upright the page mounts no list beside it.
    expect(await screen.findAllByText("Cards you scan appear here.", {}, SETTLE)).toHaveLength(1);
    expect(document.querySelector("[data-tray-column]")).toBeNull();
    expect(await sayingAlert()).toHaveTextContent(/^Camera error: /);
    expect(screen.getByRole("heading", { level: 1, name: "Scanner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Watched before it has anything to say: nothing is being matched with no picture.
    expect(statusLine()).toBeEmptyDOMElement();
    // The picture's notes stand over a picture, never over the camera's own refusal.
    expect(screen.queryByText(STOPPED_TITLE)).toBeNull();
    // Nothing was written by merely arriving.
    expect(seen.prefs).toEqual([]);
    expect(seen.trays).toEqual([]);
  });

  it("holds the camera shut until the stored prefs have loaded, then asks for the rear one", async () => {
    const { getUserMedia } = camera();
    // The stream it opens at the end is played into a `<video>`, which jsdom cannot.
    restoreVideo = shimVideo();
    let answer: (prefs: ScannerPrefs) => void = () => {};
    mount({
      over: () => ({
        scanner_prefs: () => new Promise<ScannerPrefs>((r) => (answer = r)),
        scanner_frame: pile(0).frame,
      }),
    });
    await screen.findByRole("button", { name: START }, SETTLE);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => answer(DEFAULT_SCANNER_PREFS));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1), SETTLE);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  });

  it("opens stopped: the camera live, the stopped sentence over it, and no frame sent until Start", async () => {
    const { getUserMedia } = camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ over: () => ({ scanner_frame: cards.frame }) });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1), SETTLE);
    expect(await screen.findByText(STOPPED_TITLE, {}, SETTLE)).toBeInTheDocument();
    expect(screen.getByText("Press Start to begin. The camera stays on.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: START })).toBeInTheDocument();
    // Stopped, the HUD has no presses: Reset and Send are continuous scanning's while it runs.
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    // Long enough for a frame to have gone, had the page started on its own.
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(cards.sent).toEqual([]);

    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(0), SETTLE);
    expect(screen.getByRole("button", { name: STOP })).toBeInTheDocument();
    expect(screen.queryByText(STOPPED_TITLE)).toBeNull();
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
  });

  it("sends no frame until the stored tray has loaded, so a card never lands on an empty one", async () => {
    holdOnItsSide();
    const { getUserMedia } = camera();
    restoreVideo = shimVideo();
    const cards = pile(1);
    let answer: (rows: ScannerTrayRow[]) => void = () => {};
    mount({
      over: () => ({
        scanner_tray: () => new Promise<ScannerTrayRow[]>((r) => (answer = r)),
        scanner_frame: cards.frame,
      }),
    });
    await start();
    // The camera is open and its picture is there to be sent: the prefs are in.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1), SETTLE);
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(cards.sent).toEqual([]);

    // A tray scanned on an earlier visit: the card lands on it, not instead of it.
    await act(async () => answer([TRAY_ROWS[2]]));
    await waitFor(
      () =>
        expect(trayRows()).toEqual([
          ["Urza's Saga", "1"],
          ["Ancient Tomb", "1"],
        ]),
      SETTLE,
    );
  });

  it("lands each card the scanner decides once, newest first, and stores the tray", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    const cards = pile(3);
    // Nonfoil by hand: Urza's Saga is printed nonfoil and foil, so Detect would land each copy as
    // Unknown — and an Unknown row takes no second copy.
    const { seen } = mount({
      prefs: { finish: "nonfoil" },
      over: () => ({ scanner_frame: cards.frame }),
    });
    await start();

    // Three cards laid down; the second is a second copy of the first, counted onto its row.
    await waitFor(
      () =>
        expect(trayRows()).toEqual([
          ["Ancient Tomb", "1"],
          ["Urza's Saga", "2"],
        ]),
      SETTLE,
    );
    expect(screen.getByRole("heading", { name: "Scanned cards, 3 copies" })).toBeInTheDocument();
    await waitFor(
      () => expect(statusLine()).toHaveTextContent("Matched Ancient Tomb TMP 315"),
      SETTLE,
    );
    expect(screen.getByRole("button", { name: "Add 3 to collection" })).toBeInTheDocument();
    // Written behind the reader, whole.
    await waitFor(
      () =>
        expect(last(seen.trays)?.map((row) => [row.name, row.quantity])).toEqual([
          ["Ancient Tomb", 1],
          ["Urza's Saga", 2],
        ]),
      SETTLE,
    );
    // Every frame its bytes alone: no options, no header.
    expect(cards.sent.length).toBeGreaterThanOrEqual(SHOWN.length * 3);
    expect(cards.sent.every((sent) => sent === undefined)).toBe(true);
  });

  /**
   * **Upright, the picture is the page's middle and nothing scrolls** (the scanner redesign):
   * the tray's bar, the controls, the picture, the gold Start/Stop, then the peek.
   */
  it("draws the bar, the controls, the picture, Start and the peek in that order, Start below the picture", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({ over: () => ({ scanner_frame: pile(0).frame }) });
    const startPress = await screen.findByRole("button", { name: START }, SETTLE);
    const after = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const order = [
      trayBar(),
      screen.getByRole("group", { name: "How scanning runs" }),
      cameraBox(),
      startPress,
      screen.getByRole("button", { name: /^Scanned cards, 0 copies/ }),
    ];
    for (let n = 1; n < order.length; n++) expect(after(order[n - 1], order[n])).toBe(true);
    // Gold, the width of the column, its glyph kept.
    expect(startPress).toHaveClass("w-full", "bg-accent");
    expect(startPress.querySelector("svg")).not.toBeNull();
    // The picture fills what the rest leaves it.
    expect(cameraBox()).toHaveClass("flex-1", "min-h-0");
    await userEvent.click(startPress);
    expect(screen.getByRole("button", { name: STOP })).toBe(startPress);
  });

  it("leaves the stored Developer switch alone, carrying it on through a write of another field", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    const cards = pile(1);
    const { seen } = mount({
      prefs: { developer: true },
      over: () => ({ scanner_frame: cards.frame }),
    });
    await start();
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);

    // A write of another field carries the switch on as it was stored: it is the desktop face's.
    await userEvent.click(screen.getByRole("button", { name: "Point & shoot" }));
    await waitFor(
      () => expect(last(seen.prefs)).toMatchObject({ pointAndShoot: true, developer: true }),
      SETTLE,
    );
    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    expect(within(sheet).queryByRole("switch")).toBeNull();
  });

  it("stops recognition and keeps the camera, and starts again on the same stream", async () => {
    holdOnItsSide();
    const { stop, getUserMedia } = camera();
    restoreVideo = shimVideo();
    const cards = pile(1, "looking");
    mount({ over: () => ({ scanner_frame: cards.frame }) });
    await start();
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);

    await userEvent.click(screen.getByRole("button", { name: STOP }));
    expect(await screen.findByText(STOPPED_TITLE)).toBeInTheDocument();
    // One frame may have been on the wire as the press landed; nothing after it.
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const stopped = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(stopped);
    expect(stop).not.toHaveBeenCalled();
    // The status goes quiet rather than freezing on the last card: nothing is being matched.
    expect(statusLine()).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: START }));
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(stopped), SETTLE);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  /**
   * **Point and shoot on the phone is a hold of the picture itself**: it reads while a finger is
   * on it, and the scanner pauses the moment it lifts — the card it read stays over the camera.
   * No Start or Stop, and no Reset or Send: lifting the finger already ends the read.
   */
  it("reads while the picture is held under point and shoot, and pauses the moment it is let go", async () => {
    holdOnItsSide();
    const { stop } = camera();
    restoreVideo = shimVideo();
    const cards = pile(1, "looking");
    mount({ prefs: { pointAndShoot: true }, over: () => ({ scanner_frame: cards.frame }) });
    const hold = await screen.findByRole("button", { name: "Hold to scan" }, SETTLE);
    expect(hold.closest("[data-camera-box]")).toBe(cameraBox());
    expect(screen.queryByRole("button", { name: START })).toBeNull();
    expect(screen.getByRole("button", { name: "Point & shoot" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Before a hold, the picture says how it is pressed.
    expect(await within(cameraBox()).findByText(HOLD_TITLE, {}, SETTLE)).toBeInTheDocument();
    expect(
      within(cameraBox()).getByText("Scanning pauses the moment you let go."),
    ).toBeInTheDocument();
    expect(within(cameraBox()).queryByText(SCANNING_CHIP)).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(cards.sent).toEqual([]);

    fireEvent.pointerDown(hold, { pointerId: 1 });
    // While held: the gold chip, and the surface pressed — the chip is drawn, the press says it.
    expect(within(cameraBox()).getByText(SCANNING_CHIP)).toBeInTheDocument();
    expect(within(cameraBox()).queryByText(HOLD_TITLE)).toBeNull();
    expect(hold).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);
    // Held past its card, it goes on looking — a hold ends only when it is let go.
    const atLanding = cards.sent.length;
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(atLanding), SETTLE);
    // Reading, and still no Reset or Send.
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();

    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(within(cameraBox()).queryByText(SCANNING_CHIP)).toBeNull();
    expect(hold).toHaveAttribute("aria-pressed", "false");
    // One frame may have been on the wire as the finger lifted; nothing after it.
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const released = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(released);
    expect(stop).not.toHaveBeenCalled();
    // The prompt is back once the card the hold landed has been put away.
    expect(await within(cameraBox()).findByText(HOLD_TITLE, {}, SETTLE)).toBeInTheDocument();
  });

  /**
   * **Losing the hold stops the shot**: a sheet of the page's opening over the picture, or the
   * page going out of sight — where no blur came to say the finger went somewhere else.
   */
  it("ends a hold when a sheet opens over the picture, and when the page is hidden", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({
      prefs: { pointAndShoot: true },
      over: () => ({ scanner_frame: pile(0, "looking").frame }),
    });
    const hold = await screen.findByRole("button", { name: "Hold to scan" }, SETTLE);
    fireEvent.pointerDown(hold, { pointerId: 1 });
    expect(hold).toHaveAttribute("aria-pressed", "true");
    // A second finger on Options: the caret never left the picture, and the hold still ends.
    fireEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    await screen.findByRole("dialog", { name: "Scanner options" }, SETTLE);
    expect(hold).toHaveAttribute("aria-pressed", "false");
    // And a hold refused while the sheet is up.
    fireEvent.pointerDown(hold, { pointerId: 2 });
    expect(hold).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);

    // The tray bar's own folder sheet counts as one of the page's sheets.
    fireEvent.pointerDown(hold, { pointerId: 3 });
    expect(hold).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Folder: Collection" }));
    await screen.findByRole("dialog", { name: "Folder for scanned cards" }, SETTLE);
    expect(hold).toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);

    fireEvent.pointerDown(hold, { pointerId: 4 });
    expect(hold).toHaveAttribute("aria-pressed", "true");
    act(() => parked.set({ paused: true, released: false }));
    expect(hold).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * **The hold prompt waits for the Added popup**: both stand at the foot of the picture, and
   * under point and shoot the card stays up after the finger lifts.
   */
  it("draws no hold prompt while the card a hold landed is up, and draws it again after", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({
      prefs: { pointAndShoot: true, finish: "nonfoil" },
      over: () => ({ scanner_frame: pile(1).frame }),
    });
    const hold = await screen.findByRole("button", { name: "Hold to scan" }, SETTLE);
    expect(await within(cameraBox()).findByText(HOLD_TITLE, {}, SETTLE)).toBeInTheDocument();
    fireEvent.pointerDown(hold, { pointerId: 1 });
    await waitFor(() => expect(cameraBox().querySelector("[data-landed]")).not.toBeNull(), SETTLE);
    fireEvent.pointerUp(hold, { pointerId: 1 });
    expect(hold).toHaveAttribute("aria-pressed", "false");
    // Let go, the card is still up — and the prompt is not under it.
    expect(cameraBox().querySelector("[data-landed]")).not.toBeNull();
    expect(within(cameraBox()).queryByText(HOLD_TITLE)).toBeNull();
    // The popup puts itself away after its hold, and the prompt comes back.
    await waitFor(() => expect(cameraBox().querySelector("[data-landed]")).toBeNull(), SETTLE);
    expect(within(cameraBox()).getByText(HOLD_TITLE)).toBeInTheDocument();
  });

  /**
   * **The held chip gives way to the HUD's chip** (both at the top of the picture): the surface's
   * `aria-pressed` and the progress bar go on saying the hold is reading.
   */
  it("draws no held chip while the HUD has something to say over the picture", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({
      prefs: { pointAndShoot: true },
      over: () => ({
        scanner_frame: () =>
          new Promise((_, refuse) => setTimeout(() => refuse(new Error(DB_BUSY)), 5)),
      }),
    });
    const hold = await screen.findByRole("button", { name: "Hold to scan" }, SETTLE);
    fireEvent.pointerDown(hold, { pointerId: 1 });
    expect(within(cameraBox()).getByText(SCANNING_CHIP)).toBeInTheDocument();
    expect(await within(cameraBox()).findByText(DB_BUSY, {}, SETTLE)).toBeInTheDocument();
    expect(within(cameraBox()).queryByText(SCANNING_CHIP)).toBeNull();
    expect(hold).toHaveAttribute("aria-pressed", "true");
    expect(
      within(cameraBox()).getByRole("progressbar", { name: "Match progress" }),
    ).toBeInTheDocument();
  });

  it("switches how scanning runs from the controls, storing it, and lands stopped either way", async () => {
    camera();
    restoreVideo = shimVideo();
    const { seen } = mount({ over: () => ({ scanner_frame: pile(0, "looking").frame }) });
    await start();
    expect(screen.getByRole("button", { name: STOP })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Point & shoot" }));
    await waitFor(() => expect(last(seen.prefs)?.pointAndShoot).toBe(true), SETTLE);
    expect(await screen.findByRole("button", { name: "Hold to scan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STOP })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Continuous" }));
    await waitFor(() => expect(last(seen.prefs)?.pointAndShoot).toBe(false), SETTLE);
    // Back where it came from, and stopped: Start is pressed afresh.
    expect(await screen.findByRole("button", { name: START })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hold to scan" })).toBeNull();
  });

  /** The printings a picture stands for ride the decision, and a card it cannot pin is a question. */
  it("lands a card the picture cannot pin to one printing as a question", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    mount({
      over: () => ({
        scanner_frame: frames(VERDICTS.voting, { ...VERDICTS.ambiguous, decision_seq: 1 }),
      }),
    });
    await start();
    const question = await screen.findByRole(
      "group",
      { name: "Printings of Lightning Bolt" },
      SETTLE,
    );
    expect(within(question).getAllByRole("button")).toHaveLength(3);
    await waitFor(
      () => expect(statusLine()).toHaveTextContent("3 printings Lightning Bolt"),
      SETTLE,
    );
  });

  it("lands an ambiguous card as a question, and a press on a candidate answers it", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    const { seen } = mount({
      // The first number is a baseline; the second, on a frame carrying a decision, is the card.
      over: () => ({
        scanner_frame: frames(VERDICTS.voting, { ...VERDICTS.ambiguous, decision_seq: 1 }),
      }),
    });
    await start();
    const question = await screen.findByRole(
      "group",
      { name: "Printings of Lightning Bolt" },
      SETTLE,
    );
    expect(within(question).getAllByRole("button")).toHaveLength(3);
    // The list's header walks the question, and says how many there are.
    expect(
      screen.getByRole("button", { name: "1 needs you: Next card needing a decision" }),
    ).toBeInTheDocument();
    // Add is refused, and says why on the page.
    expect(screen.getByText("Pick a printing for every card first")).toBeInTheDocument();

    await userEvent.click(
      within(question).getByRole("button", { name: "Lightning Bolt — STA 105" }),
    );
    expect(
      await screen.findByRole("button", { name: /^More printings of Lightning Bolt — STA 105/ }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(last(seen.trays)?.[0]).toMatchObject({
          setCode: "sta",
          collectorNumber: "105",
          choices: [],
        }),
      SETTLE,
    );
  });

  it("writes a row's edits to the stored tray — a quantity, a finish, a removal", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [...RESOLVED] });
    await screen.findByText("Urza's Saga", {}, SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "One more Urza's Saga — MH2 259" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Finish of Black Lotus — LEA 232: Nonfoil" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Black Lotus" })).getByRole("button", {
        name: "Foil",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Ancient Tomb — TMP 315" }));

    await waitFor(
      () =>
        expect(last(seen.trays)?.map((row) => [row.name, row.quantity, row.finish])).toEqual([
          ["Urza's Saga", 4, "nonfoil"],
          ["Black Lotus", 1, "foil"],
        ]),
      SETTLE,
    );
    expect(screen.getByRole("heading", { name: "Scanned cards, 5 copies" })).toBeInTheDocument();
  });

  it("hands the caret back to the options press when its sheet is dismissed", async () => {
    noCamera("NotAllowedError");
    mount();
    const opener = await screen.findByRole("button", { name: "Scanner options" }, SETTLE);
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    // On its first page, with no way to run the scanner in it: that is on the page now.
    expect(within(sheet).getByRole("button", { name: /^Finish/ })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /^Scanning/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    expect(opener).toHaveFocus();
  });

  it("opens the options sheet on its filters page from Filters, and hands the caret back to it", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount();
    const opener = await screen.findByRole("button", { name: "Filters" }, SETTLE);
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    await userEvent.click(within(sheet).getByRole("switch", { name: "Skip promos" }));
    await waitFor(() => expect(last(seen.prefs)?.filters.exclude_promos).toBe(true), SETTLE);
    // The way back is to the sheet's first page.
    await userEvent.click(within(sheet).getByRole("button", { name: "Filters" }));
    expect(within(sheet).getByRole("button", { name: /^Finish/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    expect(opener).toHaveFocus();
  });

  it("says no more than it knows about where the cards went when the folder list would not load", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({
      tray: [...RESOLVED],
      prefs: { folderId: 1 },
      over: () => ({
        collection_folder_list: () => {
          throw new Error("database is locked");
        },
      }),
    });
    // Not the Collection: the stored id is what the commit will send.
    expect(
      await screen.findByRole("button", { name: "Folder: Folder name unavailable" }, SETTLE),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
    expect(seen.commits[0].folderId).toBe(1);
    expect(
      await screen.findByText("Added 5 copies to your collection.", {}, SETTLE),
    ).toBeInTheDocument();
    expect(screen.queryByText(/to Collection\./)).toBeNull();
  });

  it("stores the folder a reader chooses, and names it on the bar", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [...RESOLVED] });
    await userEvent.click(
      await screen.findByRole("button", { name: "Folder: Collection" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    const folders = within(within(sheet).getByRole("list", { name: "Folders" })).getAllByRole(
      "button",
    );
    expect(folders[0]).toHaveTextContent("Collection");
    expect(folders[0]).toHaveAttribute("aria-current", "true");
    // The name alone: a drawer set aside says so on a second line.
    const chosen = folders[1].querySelector("span.truncate")?.textContent ?? "";
    expect(chosen).toBe("Binder");
    await userEvent.click(folders[1]);

    expect(await screen.findByRole("button", { name: `Folder: ${chosen}` })).toBeInTheDocument();
    await waitFor(() => expect(last(seen.prefs)?.folderId).toBe(1), SETTLE);
  });

  it("reads a stored folder that has gone as the Collection, and stores it so", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ prefs: { folderId: 987_654 } });
    expect(
      await screen.findByRole("button", { name: "Folder: Collection" }, SETTLE),
    ).toBeInTheDocument();
    await waitFor(() => expect(last(seen.prefs)).toMatchObject({ folderId: null }), SETTLE);
  });

  it("files the tray in one commit, leaves what it did not take, and says what it filed", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [NEEDS_A_FINISH_ROW, ...RESOLVED], prefs: { condition: "NM" } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Add 5 to collection · 1 needs a finish" }, SETTLE),
    );

    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
    const [commit] = seen.commits;
    expect(commit.folderId).toBeNull();
    expect(commit.items).toEqual(
      RESOLVED.map((row) => ({
        cardId: row.cardId,
        quantity: row.quantity,
        finish: row.finish,
        condition: "NM",
      })),
    );
    // The row of unknown finish was never taken: it is what the store is left holding.
    expect(commit.remaining.map((row) => row.key)).toEqual([NEEDS_A_FINISH_ROW.key]);
    await waitFor(() => expect(trayRows()).toEqual([["Lightning Bolt", "1"]]), SETTLE);

    const receipt = await screen.findByText("Added 5 copies to Collection.", {}, SETTLE);
    expect(receipt).toBeInTheDocument();
    // No ticket came back, so nothing is offered to take.
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(screen.getByText("Pick a finish for at least one card first")).toBeInTheDocument();
  });

  it("keeps the copies a reader adds while the commit is in flight", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { seen } = mount({
      tray: [...RESOLVED],
      over: (own) => ({
        scanner_tray_commit: async (args: { remaining: ScannerTrayRow[] }) => {
          seen.commits.push(args as (typeof seen.commits)[number]);
          await gate;
          return (own.scanner_tray_commit as (a: unknown) => unknown)(args);
        },
      }),
    });
    const add = await screen.findByRole("button", { name: "Add 5 to collection" }, SETTLE);
    await userEvent.click(add);
    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
    expect(add).toHaveAttribute("aria-busy", "true");

    // The camera keeps running while the write waits; so does a thumb. Two more copies of a card
    // the commit has already taken three of.
    const more = screen.getByRole("button", { name: "One more Urza's Saga — MH2 259" });
    await userEvent.click(more);
    await userEvent.click(more);
    await act(async () => release());

    // A snapshot was subtracted, not the tray emptied: the two copies added since are still here.
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "2"]]), SETTLE);
    expect(
      await screen.findByText("Added 5 copies to Collection.", {}, SETTLE),
    ).toBeInTheDocument();
  });

  it("keeps every row and says the backend's sentence when the commit is refused", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    mount({
      tray: [...RESOLVED],
      over: () => ({
        scanner_tray_commit: () => {
          throw new Error(DB_BUSY);
        },
      }),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Add 5 to collection" }, SETTLE),
    );
    await waitFor(
      () => expect(within(trayBar()).getByRole("alert")).toHaveTextContent(DB_BUSY),
      SETTLE,
    );
    expect(trayRows()).toHaveLength(3);
    expect(screen.queryByText(/^Added /)).toBeNull();
  });

  it("makes a deck of the scans and opens it, leaving the tray as it was", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    const made: unknown[] = [];
    const { seen } = mount({
      tray: [...RESOLVED],
      over: (own) => ({
        deck_import_commit: (args: unknown) => {
          made.push(args);
          return (own.deck_import_commit as (a: unknown) => unknown)(args);
        },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Tray actions" }, SETTLE));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Create deck…",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New deck" }, SETTLE);
    expect(within(dialog).getByText(/5 scanned copies will be filed/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Scanned pile");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create deck" }));

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/decks\/\d+$/), SETTLE);
    expect(
      await screen.findByRole("heading", { level: 2, name: "Scanned pile" }, SETTLE),
    ).toBeInTheDocument();
    expect(made).toHaveLength(1);
    expect(
      (made[0] as { items: { quantity: number }[] }).items.map((item) => item.quantity),
    ).toEqual([3, 1, 1]);
    // Nothing was filed into the collection, and nothing left the tray.
    expect(seen.commits).toEqual([]);
    expect(seen.trays.every((rows) => rows.length === 3)).toBe(true);
  });

  it("clears the tray only after a question that says how many copies will go", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [...RESOLVED] });
    const more = await screen.findByRole("button", { name: "Tray actions" }, SETTLE);
    await userEvent.click(more);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Clear all…",
      }),
    );
    const question = await screen.findByRole("dialog", { name: "Clear the tray" }, SETTLE);
    expect(question).toHaveTextContent("5 scanned copies will leave the tray");
    // Nothing has gone yet.
    expect(trayRows()).toHaveLength(3);

    await userEvent.click(within(question).getByRole("button", { name: "Clear tray" }));
    await waitFor(() => expect(trayRows()).toEqual([]), SETTLE);
    await waitFor(() => expect(last(seen.trays)).toEqual([]), SETTLE);
    expect(seen.commits).toEqual([]);
    expect(more).toHaveFocus();
  });

  /**
   * *Archive* (issue #989): the rows an Add would take, into the scan history and **not** the
   * collection — one `scanner_tray_archive` over the fake's own, and one toast in the desktop's
   * words.
   */
  it("archives the tray into the scan history, filing nothing, and says so in one toast", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    const archived: { items: CollectionImportItem[]; remaining: ScannerTrayRow[] }[] = [];
    const { seen } = mount({
      tray: [NEEDS_A_FINISH_ROW, ...RESOLVED],
      over: (own) => ({
        scanner_tray_archive: (args: (typeof archived)[number]) => {
          archived.push(args);
          return (own.scanner_tray_archive as (a: unknown) => unknown)(args);
        },
      }),
    });
    const more = await screen.findByRole("button", { name: "Tray actions" }, SETTLE);
    await userEvent.click(more);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Archive",
      }),
    );

    await waitFor(() => expect(archived).toHaveLength(1), SETTLE);
    expect(archived[0].items.map((item) => item.cardId)).toEqual(RESOLVED.map((row) => row.cardId));
    // The row of unknown finish stays, as it would for an Add; nothing went to the collection.
    expect(archived[0].remaining.map((row) => row.key)).toEqual([NEEDS_A_FINISH_ROW.key]);
    expect(seen.commits).toEqual([]);
    await waitFor(() => expect(trayRows()).toEqual([["Lightning Bolt", "1"]]), SETTLE);
    await waitFor(
      () =>
        expect(useNotifications.getState().notices[0]).toMatchObject({
          title: "Archived 5 cards to Scan history",
          tone: "success",
        }),
      SETTLE,
    );
    expect(more).toHaveFocus();
  });

  it("keeps every row and says the backend's sentence over the bar when the archive is refused", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    mount({
      tray: [...RESOLVED],
      over: () => ({
        scanner_tray_archive: () => {
          throw new Error(DB_BUSY);
        },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Tray actions" }, SETTLE));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Archive",
      }),
    );
    await waitFor(
      () => expect(within(trayBar()).getByRole("alert")).toHaveTextContent(DB_BUSY),
      SETTLE,
    );
    expect(trayRows()).toHaveLength(3);
  });

  it("opens the scan history from the tray's sheet, and hands the caret back to the ⋯", async () => {
    noCamera("NotAllowedError");
    mount({ fake: { seed: "scanHistory" } });
    // Upright, the tray's `⋯` is the sheet's, which the peek opens.
    await userEvent.click(await screen.findByRole("button", { name: /^Scanned cards, / }, SETTLE));
    const tray = await screen.findByRole("dialog", { name: /^Scanned cards, \d+ cop/ }, SETTLE);
    const more = within(tray).getByRole("button", { name: "Tray actions" });
    await userEvent.click(more);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Scan history",
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Scan history" }, SETTLE);
    expect(
      await within(sheet).findByRole("button", { name: /^Bob's binder/ }, SETTLE),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Scan history" })).toBeNull(),
      SETTLE,
    );
    expect(more).toHaveFocus();
  });

  /**
   * *Put back in tray* (issue #1374): a batch's lines land in the tray, the sheet closes with the
   * caret back on the ⋯, one toast says so, and nothing is filed until the tray's own Add.
   */
  it("puts a past scan back in the tray from the history sheet, and says so once", async () => {
    holdOnItsSide();
    noCamera("NotAllowedError");
    mount({ fake: { seed: "scanHistory" } });
    const more = await screen.findByRole("button", { name: "Tray actions" }, SETTLE);
    await userEvent.click(more);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Scan history",
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Scan history" }, SETTLE);
    await userEvent.click(await within(sheet).findByRole("button", { name: /^Scan 1/ }, SETTLE));
    const batch = await within(sheet).findByRole("region", { name: "Scan 1" }, SETTLE);
    await userEvent.click(within(batch).getByRole("button", { name: "Put back in tray" }));

    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Scan history" })).toBeNull(),
      SETTLE,
    );
    expect(more).toHaveFocus();
    await waitFor(
      () =>
        expect(trayRows()).toEqual([
          ["Urza's Saga", "4"],
          ["Lightning Bolt", "1"],
        ]),
      SETTLE,
    );
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Put 5 cards from “Scan 1” back in the tray",
      tone: "success",
    });
  });

  /**
   * **The tray, upright, is a peek and a sheet** (the scanner redesign): the peek's line opens the
   * whole list over the page, with the bar under its header, and the `⋯` in its header opens the
   * tray's actions over it. Escape takes the caret back to the peek.
   */
  it("opens the whole tray from the peek, with its bar and its actions, and hands the caret back", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    const peek = await screen.findByRole(
      "button",
      { name: "Scanned cards, 6 copies, 1 needs you" },
      SETTLE,
    );
    expect(peek.closest("[data-tray-peek-slot]")).not.toBeNull();
    await userEvent.click(peek);
    const sheet = await screen.findByRole("dialog", { name: "Scanned cards, 6 copies" }, SETTLE);
    // The list in scan order, each question on its own row.
    const list = within(sheet).getByRole("region", { name: "Scanned cards" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(sheet).getByText("1 card needs you")).toBeInTheDocument();
    // The page's bar, drawn again under the sheet's header: one commit, wherever it is pressed.
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add 5 to collection · 1 needs a finish" }),
    );
    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
    expect(
      await within(sheet).findByText("Added 5 copies to Collection.", {}, SETTLE),
    ).toBeInTheDocument();
    // The tray's actions open over the sheet, from its own `⋯`.
    await userEvent.click(within(sheet).getByRole("button", { name: "Tray actions" }));
    const actions = await screen.findByRole("dialog", { name: "Scanned cards" }, SETTLE);
    expect(within(actions).getByRole("button", { name: /^Clear all…/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Scanned cards" })).toBeNull(),
      SETTLE,
    );
    expect(within(sheet).getByRole("button", { name: "Tray actions" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    expect(peek).toHaveFocus();
  });

  /**
   * **On its side the tray is a column beside the picture** (the `landscape:` variant): the list
   * and its header, no peek. The column is mounted only there — what script decides, asked of
   * the same query — and the rest is the classes', so this asks the classes, and what a class
   * cannot say: the Added popup's one line.
   */
  it("lays the list beside the picture on its side, with no peek, and the Added popup on one line", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    mount({ prefs: { finish: "nonfoil" }, over: () => ({ scanner_frame: pile(1).frame }) });
    const column = (
      await screen.findByRole("heading", { name: "Scanned cards, 0 copies" }, SETTLE)
    ).closest("[data-tray-column]") as HTMLElement;
    // Mounted on its side, and drawn by the classes alone: the grid's right column, scrolling by
    // itself under the tray's own header (`Tray`'s, with the `⋯` handed in).
    expect(column).toHaveClass("hidden", "landscape:block", "landscape:col-start-2");
    expect(column).toHaveClass("overflow-y-auto");
    expect(within(column).getByRole("button", { name: "Tray actions" })).toBeInTheDocument();
    expect(within(column).getByRole("region", { name: "Scanned cards" })).toBeInTheDocument();
    // The peek is undrawn on its side; the bar heads the right column.
    expect(document.querySelector("[data-tray-peek-slot]")).toHaveClass("landscape:hidden");
    expect(trayBar()).toHaveClass("landscape:col-start-2", "landscape:row-start-1");
    // Two columns, the list's 22rem giving way to 14.5rem before the scanner's goes under the
    // 22rem its controls need whole.
    const page = trayBar().parentElement as HTMLElement;
    expect(page).toHaveClass(
      "landscape:grid",
      "landscape:grid-cols-[minmax(0,1fr)_clamp(14.5rem,100%_-_22rem,22rem)]",
    );

    await start();
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
    const landedCard = await waitFor(() => {
      const card = cameraBox().querySelector<HTMLElement>("[data-landed]");
      expect(card).not.toBeNull();
      return card as HTMLElement;
    }, SETTLE);
    // One line: the name and the printing, and no label line over them.
    expect(landedCard).toHaveTextContent("Urza's Saga");
    expect(landedCard).not.toHaveTextContent("Added to scanned cards");
    // The confetti's canvas is laid before the popup, so it flies from behind it.
    const confetti = cameraBox().querySelector("canvas.size-full") as HTMLElement;
    expect(
      confetti.compareDocumentPosition(landedCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("draws the Added popup whole upright", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({ prefs: { finish: "nonfoil" }, over: () => ({ scanner_frame: pile(1).frame }) });
    await start();
    const landedCard = await waitFor(() => {
      const card = cameraBox().querySelector<HTMLElement>("[data-landed]");
      expect(card).not.toBeNull();
      return card as HTMLElement;
    }, SETTLE);
    expect(landedCard).toHaveTextContent("Added to scanned cards");
  });

  /**
   * **The landing's price reaches the popup and the confetti by the sound's own ladder** — the
   * desktop page's wiring, shared (`useLandedPrice`, `useLandedTier`, `TierConfetti`) over the
   * fake's `scan_sounds`, a fresh install's $1, $10, $100, $1000: a card priced past a rung wears
   * its figure bold gold and throws a burst at that rung.
   */
  it("throws confetti at the tier a landed card's price reaches, its figure gold", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({
      prefs: { finish: "nonfoil" },
      over: () => ({
        scanner_frame: pile(1).frame,
        printing_prices: (args: { cardIds: string[] }) =>
          args.cardIds.map((cardId) => ({
            cardId,
            finishPrices: { nonfoil: 150, foil: null, etched: null },
          })),
      }),
    });
    await start();
    const figure = () => cameraBox().querySelector<HTMLElement>("[data-landed-price]");
    await waitFor(() => expect(figure()).toHaveTextContent(/150\.00/), SETTLE);
    expect(figure()).toHaveClass("font-semibold", "text-accent");
    await waitFor(() => expect(last(confetti.bursts)).toMatchObject({ tier: "tier3" }), SETTLE);
  });

  /**
   * A card that lands asking for a printing is quoted as its candidates' figure, plain, and throws
   * nothing — a price for a card the reader has not said they hold is no tier, however high.
   */
  it("quotes a card that lands asking for a printing plainly, and throws no confetti for it", async () => {
    camera();
    restoreVideo = shimVideo();
    mount({
      prefs: { finish: "nonfoil" },
      over: () => ({
        scanner_frame: frames(VERDICTS.voting, { ...VERDICTS.ambiguous, decision_seq: 1 }),
        printing_prices: (args: { cardIds: string[] }) =>
          args.cardIds.map((cardId) => ({
            cardId,
            finishPrices: { nonfoil: 250, foil: null, etched: null },
          })),
      }),
    });
    await start();
    const figure = () => cameraBox().querySelector<HTMLElement>("[data-landed-price]");
    await waitFor(() => expect(figure()).toHaveTextContent(/250\.00/), SETTLE);
    expect(cameraBox().querySelector("[data-landed]")).toHaveAttribute("data-landed", "pick");
    expect(figure()).toHaveClass("text-text");
    expect(figure()).not.toHaveClass("text-accent");
    expect(confetti.bursts.every((burst) => burst === null)).toBe(true);
  });

  it("throws the scanner's evidence away on Reset evidence", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    // An empty desk after the card, not a parked frame: a reset drains the frame on the wire
    // before it asks the session, and a frame that never answers would hold it for ever.
    const { seen } = mount({ over: () => ({ scanner_frame: pile(1, "looking").frame }) });
    await start();
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);
    // The pump's start reset the session once already (issue #1318); the press is one more.
    const started = seen.resets;
    await userEvent.click(screen.getByRole("button", { name: "Reset evidence" }));
    await waitFor(() => expect(seen.resets).toBe(started + 1), SETTLE);
    // The card it had already taken stays in the tray.
    expect(trayRows()).toEqual([["Urza's Saga", "1"]]);
  });
});

/**
 * ***Send scan…*** on the phone: the desktop page's hook and its dialog, opened from the status
 * line's second press, over the fake world's own `search_cards` and `scanner_submit`. **A scan is
 * a run of the frames the pump sent, never one picture**, so every test here that opens the
 * dialog first lets the scanner be shown enough to have one.
 */
describe("sending a scan from the Scanner page", () => {
  /**
   * **The run's clock, taken off the wall** — `runClock`, the one seam the pump stamps a frame
   * through and a press reads the time through. A run reaches four seconds back from the press
   * and no further, and this file is the one that has run past eight-second waits on a busy
   * machine: on the real clock a press there would find a ring of good frames too old to send.
   *
   * Every reading is ten milliseconds after the one before it — a frame, the next frame, the
   * press — so the frames are in the order they were sent, each at a time of its own, and none
   * is ever old, however long the machine took between them.
   */
  beforeEach(() => {
    let at = 1000;
    const clock = vi.spyOn(runClock, "now").mockImplementation(() => (at += 10));
    restoreClock = () => clock.mockRestore();
  });

  /**
   * The dialog, opened from the press once the scanner has answered a run's worth of frames,
   * with the search asked for Lightning Bolt's printings.
   */
  async function opened(cards: { sent: unknown[] }) {
    // Well past the fewest frames that are a scan, whatever was on the wire at the press.
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(10), SETTLE);
    const opener = await screen.findByRole("button", { name: "Send scan…" }, SETTLE);
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Send this scan" }, SETTLE);
    const box = within(dialog).getByRole("searchbox");
    // Whatever the scanner had been naming: this test's card is one the corpus has four of.
    await userEvent.clear(box);
    await userEvent.type(box, "Lightning Bolt");
    return { opener, dialog };
  }

  /**
   * A canvas whose every encode is a JPEG of its own — `ff d8` and then the encode's number in
   * two bytes — where the file's shim hands every frame the same three: a run is several frames,
   * and a test of one has to be able to tell them apart and say what order they came in. Two
   * bytes, because a pump answered every three milliseconds is past 255 frames within a second.
   */
  function numberedCanvas(): () => void {
    let n = 0;
    return shim(HTMLCanvasElement.prototype, {
      toBlob: {
        value: (cb: (blob: Blob) => void) => {
          n += 1;
          cb(new Blob([new Uint8Array([0xff, 0xd8, n >> 8, n & 0xff])]));
        },
      },
    });
  }
  /** Which encode a frame of a run was, read back out of the text it was sent as. */
  function numberOf(jpeg: string): number {
    const bytes = atob(jpeg);
    return (bytes.charCodeAt(2) << 8) | bytes.charCodeAt(3);
  }

  /** The picture of the run that is showing — by its name, since a printing's tile is one too. */
  const picture = (dialog: HTMLElement) =>
    within(dialog).getByRole("img", { name: /^Picture \d+ of \d+ that will be sent$/ });

  /**
   * The world's own answer about the membership, with each one kept: a test that says a press is
   * or is not there *because of* the membership can then say what the membership was — in
   * `supporterState`'s one word, the reading the page itself takes.
   */
  function membership(own: CommandTable, answers: SupporterStatus[]): CommandTable {
    return {
      sync_supporter_status: () => {
        const answer = (own.sync_supporter_status as () => SupporterStatus)();
        answers.push(answer);
        return answer;
      },
    };
  }

  /** `count` more frames answered — each a render of the page, so anything owed is drawn. */
  async function framesGoBy(cards: { sent: unknown[] }, count: number) {
    const sent = cards.sent.length;
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(sent + count), SETTLE);
  }

  it("offers no Send scan… without a live picture", async () => {
    noCamera("NotAllowedError");
    mount({ fake: SUPPORTER });
    expect(await sayingAlert()).toHaveTextContent(
      "MTG Grimoire needs camera access to scan a card.",
    );
    // Started, and still neither corner press: both stand over a live picture, never over the
    // camera's own refusal.
    await start();
    expect(screen.getByRole("button", { name: STOP })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
  });

  it("sends the run under the printing and finish the reader chooses, and shows the reference", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    restoreFrames = numberedCanvas();
    const cards = pile(1, "looking");
    const sent: { submission: ScannerSubmission }[] = [];
    const { seen } = mount({
      fake: SUPPORTER,
      over: (own) => ({
        scanner_frame: cards.frame,
        scanner_submit: (args: { submission: ScannerSubmission }) => {
          sent.push(args);
          return (own.scanner_submit as (a: unknown) => unknown)(args);
        },
      }),
    });
    await start();
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);

    const { opener, dialog } = await opened(cards);
    // It rests on the last frame of the run, drawn out of the text that will be sent, and says
    // how many there are: every one of them is the reader's to look through.
    const slider = within(dialog).getByRole("slider", { name: "Picture" });
    const pictures = Number(slider.getAttribute("max"));
    expect(pictures).toBeGreaterThanOrEqual(5);
    expect(pictures).toBeLessThanOrEqual(20);
    expect(picture(dialog)).toHaveAttribute(
      "alt",
      `Picture ${pictures} of ${pictures} that will be sent`,
    );
    const shown = picture(dialog).getAttribute("src") ?? "";
    expect(shown).toMatch(/^data:image\/jpeg;base64,/);
    expect(dialog).toHaveTextContent(`These ${pictures} pictures — the last couple of seconds`);

    const send = within(dialog).getByRole("button", { name: "Send scan" });
    expect(send).toHaveAttribute("aria-disabled", "true");
    expect(send).toHaveAccessibleDescription("Choose the card in the last picture.");

    // Three finishes, so the printing alone is not an answer.
    await userEvent.click(
      await within(dialog).findByRole("radio", { name: "Lightning Bolt — STA 105" }, SETTLE),
    );
    expect(send).toHaveAccessibleDescription("Choose its finish.");
    await userEvent.click(send);
    expect(sent).toEqual([]);

    await userEvent.click(within(dialog).getByRole("radio", { name: "Etched" }));
    // A finger's size, from the shared recipes: the phone reaches no floor into this dialog.
    expect(send.classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
    await userEvent.click(send);

    expect(await within(dialog).findByText("Sent — thank you.", {}, SETTLE)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(`Reference: ${FAKE_SCAN_ID}`);
    // One call, of one argument: the submission, with the whole run inside it.
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0])).toEqual(["submission"]);
    const { submission } = sent[0];
    expect(submission).toMatchObject({
      cardId: printing("sta", "105").id,
      finish: "etched",
      filters: DEFAULT_SCANNER_PREFS.filters,
    });
    // Every key the engine's struct has, each present even where it is `null`.
    expect(Object.keys(submission).sort()).toEqual(
      ["cardId", "confidence", "distance", "filters", "finish", "reported", "run"].sort(),
    );

    // **The run is frames the pump really sent**: as many as the dialog counted, each kept at
    // full resolution — the second of the two encodes every draw of the camera's picture makes
    // on a device that may send, the first being the frame the scanner was given — in the order
    // they were made, the last of them the one the dialog rested on, and each counted back from
    // the press, none after it.
    expect(submission.run).toHaveLength(pictures);
    const encodes = submission.run.map((frame) => numberOf(frame.jpeg));
    expect(encodes).toEqual(Array.from({ length: pictures }, (_, n) => encodes[0] + 2 * n));
    expect(encodes.every((n) => n % 2 === 0)).toBe(true);
    expect(`data:image/jpeg;base64,${submission.run[pictures - 1].jpeg}`).toBe(shown);
    const ms = submission.run.map((frame) => frame.ms);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
    expect(ms.every((one) => Number.isInteger(one) && one <= 0)).toBe(true);
    for (const frame of submission.run) {
      expect(Object.keys(frame).sort()).toEqual(
        ["confidence", "decided", "distance", "jpeg", "ms", "ok"].sort(),
      );
    }

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    expect(opener).toHaveFocus();
    // The tray was no part of it: the card scanned before the press is still there, unfiled.
    expect(trayRows()).toEqual([["Urza's Saga", "1"]]);
    expect(seen.commits).toEqual([]);
  });

  it("says the inbox's own sentence when it is full, and keeps the dialog and the answers", async () => {
    camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({
      // A full inbox is something only a supporter can meet, so this fault's world is one's.
      fake: { seed: "starter", fault: "scanInboxFull" },
      over: () => ({ scanner_frame: cards.frame }),
    });
    await start();

    const { dialog } = await opened(cards);
    // Alpha's Bolt was printed one way, so its finish is chosen for the reader.
    const lea = await within(dialog).findByRole(
      "radio",
      { name: "Lightning Bolt — LEA 161" },
      SETTLE,
    );
    await userEvent.click(lea);
    expect(within(dialog).getByRole("radio", { name: "Nonfoil" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send scan" }));

    await waitFor(
      () => expect(within(dialog).getByRole("alert")).toHaveTextContent(SCAN_INBOX_FULL),
      SETTLE,
    );
    expect(within(dialog).queryByText("Sent — thank you.")).toBeNull();
    expect(lea).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("button", { name: "Send scan" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("hands the caret back to the press when the dialog is dismissed", async () => {
    camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ fake: SUPPORTER, over: () => ({ scanner_frame: cards.frame }) });
    await start();
    const { opener } = await opened(cards);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    expect(opener).toHaveFocus();
  });

  /** Issue #977: no card may land in the tray while the reader picks a printing. */
  it("pauses recognition while the dialog is open, and resumes when it closes", async () => {
    const { stop } = camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ fake: SUPPORTER, over: () => ({ scanner_frame: cards.frame }) });
    await start();
    await opened(cards);
    // One frame may have been on the wire as the press landed; nothing after it.
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const paused = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(paused);
    expect(stop).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    await framesGoBy(cards, 0);
  });

  /**
   * The reader is asked to look through every picture, so every one is a place the slider stops
   * — at a finger's size, from the shared floor.
   */
  it("walks every picture of the run on the dialog's slider", async () => {
    camera();
    restoreVideo = shimVideo();
    restoreFrames = numberedCanvas();
    const cards = pile(0, "looking");
    mount({ fake: SUPPORTER, over: () => ({ scanner_frame: cards.frame }) });
    await start();
    const { dialog } = await opened(cards);

    const slider = within(dialog).getByRole("slider", { name: "Picture" });
    expect(slider.classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
    const pictures = Number(slider.getAttribute("max"));
    expect(pictures).toBeGreaterThanOrEqual(5);
    const drawn = new Set<string>();
    for (let n = 1; n <= pictures; n++) {
      fireEvent.change(slider, { target: { value: String(n) } });
      expect(picture(dialog)).toHaveAttribute(
        "alt",
        `Picture ${n} of ${pictures} that will be sent`,
      );
      drawn.add(picture(dialog).getAttribute("src") ?? "");
    }
    // As many pictures as stops: each one drew a frame of its own.
    expect(drawn.size).toBe(pictures);
  });

  /**
   * **No press over a trade** (the owner's decision, 2026-10-11): the Trade page mounts this page
   * in a sheet of its own, filing into one side of a trade, and *Send scan…* is the Scanner tab's.
   * A live camera, a running scanner and a supporter's device — everything the tab needs to draw
   * the press — and none.
   */
  it("draws no Send scan… where the page is mounted over a trade", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    const answers: SupporterStatus[] = [];
    mount({
      fake: SUPPORTER,
      over: (own) => ({ scanner_frame: cards.frame, ...membership(own, answers) }),
      destination: {
        title: "Scanned for their side",
        name: "their side",
        commit: () => Promise.resolve(),
      },
    });
    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(2), SETTLE);
    expect(
      await screen.findByRole("button", { name: "Reset evidence" }, SETTLE),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: STOP })).toBeInTheDocument();
    // The membership was asked and is a supporter's, several frames ago: it is the trade, and
    // nothing else, that keeps the press away.
    expect(answers.map(supporterState)).toContain("active");
    await framesGoBy(cards, 6);
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
    // Nor an archive or the history: both are the Scanner tab's own record.
    await userEvent.click(screen.getByRole("button", { name: "Tray actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanned cards" }, SETTLE);
    expect(within(sheet).queryByRole("button", { name: /Archive/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Scan history/ })).toBeNull();
  });

  /**
   * **No press while recognition is stopped**: a scan is the frames the scanner was given, and
   * stopped it is given none. The stopped veil over the picture is the whole of what is said —
   * the HUD's two presses are continuous scanning's while it runs, so Reset goes too.
   */
  it("draws no Send scan… while recognition is stopped, and brings it back with the scanner", async () => {
    camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ fake: SUPPORTER, over: () => ({ scanner_frame: cards.frame }) });
    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(2), SETTLE);
    const send = await screen.findByRole("button", { name: "Send scan…" }, SETTLE);
    // A 44px round glyph at the picture's corner, named by its words.
    expect(send.closest("[data-camera-box]")).toBe(cameraBox());
    expect(send).toHaveClass("size-11", "rounded-full");

    await userEvent.click(screen.getByRole("button", { name: STOP }));
    expect(await screen.findByText(STOPPED_TITLE)).toBeInTheDocument();
    // The camera is still live; both presses are gone all the same.
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: START }));
    expect(await screen.findByRole("button", { name: "Send scan…" }, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
  });

  /**
   * **All of a run or none of it.** A press before the scanner has been shown enough — here it
   * has answered one frame — opens no dialog and sends no single picture in its place: it says
   * what to do, over the camera, in words.
   */
  it("says so over the picture when there is not enough of a scan yet, and opens nothing", async () => {
    camera();
    restoreVideo = shimVideo();
    const sent: unknown[] = [];
    const { view } = mount({
      fake: SUPPORTER,
      over: () => ({
        // One frame answered, and every one after it parked: a run of one.
        scanner_frame: frames(VERDICTS.voting),
        scanner_submit: (args: unknown) => {
          sent.push(args);
          return { id: FAKE_SCAN_ID };
        },
      }),
    });
    await start();
    await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"), SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Send scan…" }));
    const box = view.container.querySelector<HTMLElement>("[data-camera-box]");
    expect(within(box as HTMLElement).getByRole("alert")).toHaveTextContent(
      "Not enough of the scan yet. Hold the card under the camera a moment and press again.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent).toEqual([]);

    // Stopped, the press is gone and its sentence with it: the picture says it is stopped.
    await userEvent.click(screen.getByRole("button", { name: STOP }));
    expect(within(box as HTMLElement).getByText(STOPPED_TITLE)).toBeInTheDocument();
    expect(within(box as HTMLElement).getByRole("alert")).toBeEmptyDOMElement();
    expect(screen.queryByText(/Not enough of the scan yet/)).toBeNull();
  });

  /**
   * The options sheet's release date, set as a reader sets it — from the controls' Filters, which
   * opens the sheet on that page, sent to the session as it is made — and the sheet shut again.
   */
  async function narrowTo(from: string) {
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" }, SETTLE);
    // `fireEvent`: a date field has no text for user-event to type into.
    fireEvent.change(await within(sheet).findByLabelText("Released from", {}, SETTLE), {
      target: { value: from },
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Scanner options" })).toBeNull(),
      SETTLE,
    );
  }

  /**
   * **A scan says the filters its frames were judged under**: the ones the session last took
   * (`useScannerPrefs`' `inForce`), never the ones the sheet is drawing. A filter is drawn the
   * moment the reader changes it and sent to the session, which has not answered yet and may
   * refuse — and a press in that moment must not say the session held it.
   */
  it("sends the filters the session has taken, not ones still on their way to it", async () => {
    camera();
    restoreVideo = shimVideo();
    // The pump runs throughout, so whenever the press lands there is a run of fresh frames.
    const cards = pile(0, "looking");
    const pushed: ScanFilters[] = [];
    const sent: { submission: ScannerSubmission }[] = [];
    mount({
      fake: SUPPORTER,
      over: (own) => ({
        scanner_frame: cards.frame,
        // The mount's push is the world's to answer; the reader's is on its way for as long as
        // the test runs.
        scanner_set_filters: (args: { filters: ScanFilters }) => {
          pushed.push(args.filters);
          return pushed.length === 1
            ? (own.scanner_set_filters as (a: unknown) => unknown)(args)
            : new Promise<void>(() => {});
        },
        scanner_submit: (args: { submission: ScannerSubmission }) => {
          sent.push(args);
          return (own.scanner_submit as (a: unknown) => unknown)(args);
        },
      }),
    });
    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(10), SETTLE);

    await narrowTo("2020-01-01");
    expect(pushed).toEqual([
      DEFAULT_SCANNER_PREFS.filters,
      { sets: [], released_from: "2020-01-01", released_to: null, exclude_promos: false },
    ]);

    const { dialog } = await opened(cards);
    await userEvent.click(
      await within(dialog).findByRole("radio", { name: "Lightning Bolt — LEA 161" }, SETTLE),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Send scan" }));
    await waitFor(() => expect(sent).toHaveLength(1), SETTLE);
    // The sheet says 2020; the session never has, and neither does the scan.
    expect(sent[0].submission.filters).toEqual(DEFAULT_SCANNER_PREFS.filters);
    expect(sent[0].submission.run.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * **A run never spans a change of filters.** The session drops its tracker to take a changed
   * set, so every frame the pump was holding was judged under the old one. The page lets the run
   * go when the filters in force move — and nothing on screen with it: the session reset itself,
   * and no reader asked for anything to be forgotten.
   */
  it("starts the run over when the session takes changed filters, and leaves the status line alone", async () => {
    camera();
    restoreVideo = shimVideo();
    // Eight frames answered and the ninth parked: the run is those eight until it is let go, and
    // nothing sent afterwards can refill it.
    const answered = frames(...Array<ScannerVerdict>(8).fill(VERDICTS.voting));
    let asked = 0;
    const { seen, view } = mount({
      fake: SUPPORTER,
      over: () => ({
        scanner_frame: (...args: Parameters<Frame>) => {
          asked += 1;
          return answered(...args);
        },
      }),
    });
    await start();
    await waitFor(() => expect(asked).toBe(9), SETTLE);
    await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"), SETTLE);

    // The premise: as things stand there is a run to send, all eight frames of it. (On the
    // describe's clock, so it is here however long the machine took to get to this line.)
    await userEvent.click(screen.getByRole("button", { name: "Send scan…" }));
    const dialog = await screen.findByRole("dialog", { name: "Send this scan" }, SETTLE);
    expect(within(dialog).getByRole("slider", { name: "Picture" })).toHaveAttribute("max", "8");
    await userEvent.keyboard("{Escape}");
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Send this scan" })).toBeNull(),
      SETTLE,
    );

    // The reader narrows the scan, and the session takes it — which is when it is stored.
    const resets = seen.resets;
    await narrowTo("2020-01-01");
    await waitFor(
      () =>
        expect(last(seen.prefs)?.filters).toEqual({
          sets: [],
          released_from: "2020-01-01",
          released_to: null,
          exclude_promos: false,
        }),
      SETTLE,
    );

    // Not one frame has been judged under the new filters, so there is nothing to send yet.
    await userEvent.click(screen.getByRole("button", { name: "Send scan…" }));
    const box = view.container.querySelector<HTMLElement>("[data-camera-box]");
    expect(within(box as HTMLElement).getByRole("alert")).toHaveTextContent(
      "Not enough of the scan yet. Hold the card under the camera a moment and press again.",
    );
    expect(screen.queryByRole("dialog", { name: "Send this scan" })).toBeNull();
    // The line goes on naming the card: this was the run's break, not the evidence's.
    expect(statusLine()).toHaveTextContent("Plains");
    // No reset: the pump's starts reset the session, and a change of filters is none of them.
    expect(seen.resets).toBe(resets);
  });

  /**
   * **Only a supporter's device draws the press** (the owner's decision; the shared
   * `useMaySendScans`) — and a device that is not one is told nothing: no greyed press, no
   * sentence, no name for what it lacks. This is the face the build Google Play distributes
   * draws, and that build may not lead a reader to a membership bought somewhere else.
   *
   * Every test below has everything else the press needs — a live camera and recognition running
   * — so the membership is the one thing that differs between them, and each says what the world
   * answered for it.
   */
  describe("for a supporter and for nobody else", () => {
    /** The tab with a camera open and the scanner answering, the membership's answers kept. */
    async function running(
      fake: FakeParams | undefined,
      supporter?: (own: CommandTable) => CommandTable,
    ) {
      camera();
      restoreVideo = shimVideo();
      const cards = pile(0, "looking");
      const answers: SupporterStatus[] = [];
      const { view } = mount({
        fake,
        over: (own) => ({
          scanner_frame: cards.frame,
          ...(supporter?.(own) ?? membership(own, answers)),
        }),
      });
      await start();
      await waitFor(() => expect(cards.sent.length).toBeGreaterThan(2), SETTLE);
      expect(
        await screen.findByRole("button", { name: "Reset evidence" }, SETTLE),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: STOP })).toBeInTheDocument();
      return { cards, answers, view };
    }

    /** Everything the page says: its text, and every name or description an element carries. */
    function said(): string {
      const named = Array.from(document.body.querySelectorAll("*")).flatMap((element) =>
        ["aria-label", "aria-description", "title", "alt", "placeholder"].map(
          (attribute) => element.getAttribute(attribute) ?? "",
        ),
      );
      return [document.body.textContent ?? "", ...named].join("\n");
    }
    /** A word that would name what the device lacks, or point at getting it. */
    const NAMES_A_MEMBERSHIP = /patreon|supporter|membership|\bmembers?\b|pledge|subscri|payment/i;

    it.each<[string, FakeParams, string]>([
      ["entitled through its group", SUPPORTER, "active"],
      ["in its grace window", { seed: "starter", fault: "patreonDeclined" }, "grace"],
    ])("draws the press for a membership that is %s", async (_, fake, reading) => {
      const { answers } = await running(fake);
      const press = await screen.findByRole("button", { name: "Send scan…" }, SETTLE);
      expect(press).toBeEnabled();
      expect(answers.map(supporterState)).toContain(reading);
    });

    it.each<[string, FakeParams | undefined, string]>([
      ["has never been a supporter's", undefined, "never"],
      ["was a supporter's and no longer is", { seed: "starter", fault: "patreonLapsed" }, "ended"],
    ])("draws no press, and not a word about it, on a device that %s", async (_, fake, reading) => {
      const { cards, answers } = await running(fake);
      await waitFor(() => expect(answers.map(supporterState)).toContain(reading), SETTLE);
      // The answer has been in for several renders: this is not a press still on its way.
      await framesGoBy(cards, 6);
      expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
      // Not a greyed one either, under any name; the line's other press is untouched.
      expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
      expect(screen.getByRole("button", { name: "Reset evidence" })).toBeEnabled();
      // …and nothing on the page names what is missing, in text or in a label.
      expect(said()).not.toMatch(NAMES_A_MEMBERSHIP);
    });

    /**
     * `unknown` is the read in flight, and it draws nothing: a press drawn before the answer
     * would flash at the one reader the answer then takes it from.
     */
    it("draws no press while the membership is being read, and draws it when a supporter's answer lands", async () => {
      let answer!: () => void;
      const { cards } = await running(SUPPORTER, (own) => ({
        sync_supporter_status: () =>
          new Promise<unknown>((resolve) => {
            answer = () => resolve((own.sync_supporter_status as () => unknown)());
          }),
      }));
      // Asked and unanswered, with the scanner well under way.
      await waitFor(() => expect(answer).toBeTypeOf("function"), SETTLE);
      await framesGoBy(cards, 6);
      expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
      expect(said()).not.toMatch(NAMES_A_MEMBERSHIP);

      await act(async () => answer());
      expect(await screen.findByRole("button", { name: "Send scan…" }, SETTLE)).toBeEnabled();
    });
  });
});

describe("what the Scanner page says when it cannot scan", () => {
  it("says the camera was refused, and still draws the controls, the tray and its bar", async () => {
    noCamera("NotAllowedError");
    mount({ tray: [...RESOLVED] });
    expect(await sayingAlert()).toHaveTextContent(
      "MTG Grimoire needs camera access to scan a card.",
    );
    expect(screen.getByRole("button", { name: "Scanner options" })).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Add 5 to collection" }, SETTLE),
    ).toBeInTheDocument();
  });

  it("says a device has no camera", async () => {
    noCamera("NotFoundError");
    mount();
    expect(await sayingAlert()).toHaveTextContent("No camera on this device.");
  });

  /**
   * **A build with nothing to scan with** — no recogniser and no card names. There is nothing to
   * download and no file to put anywhere, so the slot under the camera says nothing; the line says
   * the card cannot be identified, and the filters are refused in words.
   */
  it("says it cannot identify with no recogniser, offers nothing to fetch, and refuses the filters in words", async () => {
    camera();
    restoreVideo = shimVideo();
    // The fault's own frame — every one fails in the crate's sentence — answered here, at this
    // file's pace (`pile`'s reason).
    const { view } = mount({
      fake: { seed: "starter", fault: "scannerMissing" },
      over: () => ({ scanner_frame: frames(scanStep(newScanScript(), true)) }),
    });
    await start();
    await waitFor(() => expect(statusLine()).toHaveTextContent("Can't identify"), SETTLE);
    expect(view.container.querySelector("[data-scanner-data-slot]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Scanner files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    // A greyed row's name includes its reason.
    expect(
      within(sheet).getByRole("button", { name: /^Filters\s*Filters need the card database/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  /** A recogniser that is there and did not load says so under the camera, in the load's words. */
  it("says the recogniser's own refusal in the slot under the camera", async () => {
    noCamera("NotAllowedError");
    const { view } = mount({ over: () => ({ scanner_status: () => STATUS.corrupt }) });
    const slot = () => view.container.querySelector("[data-scanner-data-slot]");
    await waitFor(
      () =>
        expect(slot()).toHaveTextContent("The card recognizer did not load: gallery: bad magic."),
      SETTLE,
    );
    expect(within(slot() as HTMLElement).queryByRole("button")).toBeNull();
  });

  /**
   * A host with no scanner session — a web page, until the light app's web step. The engine
   * refuses the status, a frame, a reset and a filter push in one sentence there, and answers the
   * prefs, the tray and the lease.
   */
  it("stays quiet on a host with no scanner session: no camera, no frame, the sentence where the picture would be", async () => {
    holdOnItsSide();
    const { getUserMedia } = camera();
    restoreVideo = shimVideo();
    const refuse = () => {
      throw new Error(SCANNER_NOT_IN_A_BROWSER_YET);
    };
    const sentFrames = vi.fn(refuse);
    const { seen, view } = mount({
      tray: [...RESOLVED],
      over: () => ({
        scanner_status: refuse,
        scanner_set_filters: refuse,
        scanner_reset: refuse,
        scanner_frame: sentFrames,
      }),
    });

    const box = () => view.container.querySelector<HTMLElement>("[data-camera-box]");
    await waitFor(
      () =>
        expect(within(box() as HTMLElement).getByRole("alert")).toHaveTextContent(
          SCANNER_NOT_IN_A_BROWSER_YET,
        ),
      SETTLE,
    );
    // Long enough for a camera to have opened and a frame to have gone, had either been asked for.
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sentFrames).not.toHaveBeenCalled();

    // Nothing tells the reader to point a camera that is not open, or offers to reset a session
    // that is not there.
    expect(screen.queryByRole("status", { name: "Scanner status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset evidence" })).toBeNull();
    expect(screen.queryByText(/Point the camera at a card/)).toBeNull();
    expect(seen.resets).toBe(0);

    // A filter is not offered that would never be taken.
    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    const filters = within(sheet).getByRole("button", { name: /^Filters/ });
    expect(filters).toHaveAttribute("aria-disabled", "true");
    expect(filters).toHaveTextContent(SCANNER_NOT_IN_A_BROWSER_YET);
    await userEvent.keyboard("{Escape}");

    // The tray is rows, and a page has the rows: it still reads, and still files.
    expect(trayRows()).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
  });

  it("opens no camera while another window has the scanner, and says so", async () => {
    const { getUserMedia } = camera();
    const { seen } = mount({ fake: { seed: "starter", fault: "scannerElsewhere" } });
    expect(await screen.findByText(SCANNER_OPEN_ELSEWHERE, {}, SETTLE)).toBeInTheDocument();
    expect(screen.getByText(/It will open here once that window closes/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Scanned cards" })).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(seen.holds).toBe(0);
  });

  it("says a busy database over the picture, and goes on asking", async () => {
    camera();
    restoreVideo = shimVideo();
    let asked = 0;
    mount({
      over: () => ({
        scanner_frame: () => {
          asked += 1;
          return new Promise((_, refuse) => setTimeout(() => refuse(new Error(DB_BUSY)), 5));
        },
      }),
    });
    await start();
    expect(await screen.findByText(DB_BUSY, {}, SETTLE)).toBeInTheDocument();
    // The loop does not stop on a failure: a sync ends, and the scanner recovers by itself.
    const then = asked;
    await waitFor(() => expect(asked).toBeGreaterThan(then), SETTLE);
  });

  it("gives the camera up the moment a frame is refused because another window took the scanner", async () => {
    const { stop } = camera();
    restoreVideo = shimVideo();
    let taken = false;
    mount({
      over: () => ({
        scanner_elsewhere: () => taken,
        scanner_frame: () => {
          taken = true;
          return new Promise((_, refuse) =>
            setTimeout(() => refuse(new Error(SCANNER_OPEN_ELSEWHERE)), 5),
          );
        },
      }),
    });
    await start();
    expect(
      await screen.findByText(/It will open here once that window closes/, {}, SETTLE),
    ).toBeInTheDocument();
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Scanned cards" })).toBeNull();
  });
});

describe("a Scanner page nobody is looking at", () => {
  it("stops sending frames at once, and keeps the camera for the grace", async () => {
    const { stop } = camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ over: () => ({ scanner_frame: cards.frame }) });
    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(2), SETTLE);

    act(() => parked.set({ paused: true, released: false }));
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const paused = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(paused);
    expect(stop).not.toHaveBeenCalled();

    // Back inside the grace: the same stream, reading again.
    act(() => parked.set({ paused: false, released: false }));
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(paused), SETTLE);
    expect(stop).not.toHaveBeenCalled();
  });

  it("closes the camera and lets the lease lapse past the grace, and asks again on the way back", async () => {
    const { stop, getUserMedia } = camera();
    restoreVideo = shimVideo();
    const { seen } = mount({ over: () => ({ scanner_frame: pile(0, "looking").frame }) });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1), SETTLE);
    await waitFor(() => expect(seen.holds).toBeGreaterThan(0), SETTLE);

    act(() => parked.set({ paused: true, released: true }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), SETTLE);
    // No heartbeat from a page that let go: another window can take the scanner.
    const held = seen.holds;
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    expect(seen.holds).toBe(held);

    act(() => parked.set({ paused: false, released: false }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2), SETTLE);
    await waitFor(() => expect(seen.holds).toBeGreaterThan(held), SETTLE);
  });

  it("stops the camera's track when the reader leaves by the tab bar", async () => {
    const { stop, getUserMedia } = camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    mount({ over: () => ({ scanner_frame: cards.frame }) });
    await start();
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(2), SETTLE);

    await userEvent.click(tab("Wishlist"));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1), SETTLE);
    expect(screen.queryByRole("region", { name: "Scanned cards" })).toBeNull();
    // And nothing more is sent from a page that has gone.
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const left = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(left);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps what was scanned for the next visit", async () => {
    holdOnItsSide();
    camera();
    restoreVideo = shimVideo();
    mount({ over: () => ({ scanner_frame: pile(1).frame }) });
    await start();
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
    await userEvent.click(tab("Wishlist"));
    await waitFor(
      () => expect(screen.queryByRole("region", { name: "Scanned cards" })).toBeNull(),
      SETTLE,
    );
    await userEvent.click(tab("Scanner"));
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
  });
});
