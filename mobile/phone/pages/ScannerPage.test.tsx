import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

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
vi.mock("@/features/scanner/useParked", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("@/features/scanner/useParked")>()),
    usePageParked: () => useSyncExternalStore(parked.subscribe, parked.get),
  };
});

import type { CommandTable } from "../../../.storybook/fake/scope";
import { FRAMES_PER_CARD, newScanScript, scanStep } from "../../../.storybook/fake/scannerScript";
import {
  DEFAULT_SCANNER_PREFS,
  NEEDS_A_FINISH_ROW,
  TRAY_ROWS,
  VERDICTS,
} from "@/features/scanner/fixtures";
import {
  DB_BUSY,
  SCANNER_NOT_IN_A_BROWSER_YET,
  SCANNER_OPEN_ELSEWHERE,
} from "@/features/scanner/verdictText";
import type {
  CollectionImportItem,
  ScannerOptions,
  ScannerPrefs,
  ScannerTrayRow,
  ScannerVerdict,
} from "@/lib/ipc";
import type { FakeParams } from "../../../.storybook/fake/world";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

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

type Frame = (jpeg: unknown, options?: { headers?: Record<string, string> }) => Promise<ScannerVerdict>;

const sentWith = (options: { headers?: Record<string, string> } | undefined): ScannerOptions =>
  JSON.parse(options?.headers?.["x-scanner-options"] ?? "{}") as ScannerOptions;

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
  const sent: ScannerOptions[] = [];
  let asked = 0;
  const frame: Frame = (_jpeg, options) => {
    const under = sentWith(options);
    sent.push(under);
    const at = asked++;
    const card = Math.floor(at / SHOWN.length);
    if (card >= cards && after === "parked") return new Promise(() => {});
    return new Promise((answer) =>
      setTimeout(() => {
        // Past the pile the desk is empty: the first frame of a card that is never laid down.
        script.frame = card >= cards ? cards * FRAMES_PER_CARD : card * FRAMES_PER_CARD + SHOWN[at % SHOWN.length];
        answer(scanStep(script, under.mode, under.previews, false));
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
}: {
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
    commits: [] as { items: CollectionImportItem[]; folderId: number | null; remaining: ScannerTrayRow[] }[],
    holds: 0,
    resets: 0,
  };
  const view = renderPhone(<PhoneFace />, {
    path: "/scanner",
    fake,
    commands: (own) => {
      const call = (name: string, args?: unknown) => (own[name] as (a: unknown) => unknown)(args ?? {});
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

/** Long enough for an answer already on its 3 ms timer to land. */
const settled = () => new Promise<void>((done) => setTimeout(done, 20));

const statusLine = () => screen.getByRole("status", { name: "Scanner status" });
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
  restoreCanvas();
  restoreVideo();
  restoreVideo = () => {};
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  parked.set({ paused: false, released: false });
});

describe("the phone's Scanner page", () => {
  it("mounts quietly where there is no camera to ask, with its tray and its footer drawn", async () => {
    // jsdom: `navigator.mediaDevices` is not there at all. Every other suite that walks through
    // this tab meets it like this.
    const { seen } = mount();
    expect(await screen.findByText("Cards you scan appear here.", {}, SETTLE)).toBeInTheDocument();
    expect(await screen.findByRole("alert", {}, SETTLE)).toHaveTextContent(/^Camera error: /);
    expect(screen.getByRole("heading", { level: 1, name: "Scanner" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(statusLine()).toHaveTextContent("Looking Point the camera at a card");
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
    await screen.findByRole("button", { name: "Stop scanning" }, SETTLE);
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

  it("sends no frame until the stored tray has loaded, so a card never lands on an empty one", async () => {
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
    camera();
    restoreVideo = shimVideo();
    const cards = pile(3);
    const { seen } = mount({ over: () => ({ scanner_frame: cards.frame }) });

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
    await waitFor(() => expect(statusLine()).toHaveTextContent("Matched Ancient Tomb TMP 315"), SETTLE);
    expect(screen.getByRole("button", { name: "Add 3 to collection" })).toBeInTheDocument();
    // Written behind the reader, whole.
    await waitFor(
      () => expect(last(seen.trays)?.map((row) => [row.name, row.quantity])).toEqual([
        ["Ancient Tomb", 1],
        ["Urza's Saga", 2],
      ]),
      SETTLE,
    );
    // Every frame in the stored mode, and none asking for previews.
    expect(cards.sent.length).toBeGreaterThanOrEqual(SHOWN.length * 3);
    expect(cards.sent.every((sent) => sent.mode === "fast" && sent.previews === false)).toBe(true);
  });

  it("shapes the camera's box by the stream it opened", async () => {
    camera();
    restoreVideo = shimVideo();
    const { view } = mount({ over: () => ({ scanner_frame: pile(0).frame }) });
    const box = () => view.container.querySelector<HTMLElement>("[data-camera-box]");
    // A phone held upright: a portrait stream, capped by the box's own class rather than drawn whole.
    await waitFor(() => expect(parseFloat(box()?.style.aspectRatio ?? "")).toBe(1080 / 1920), SETTLE);
  });

  it("never asks for previews whatever the stored Developer switch says, and leaves the switch alone", async () => {
    camera();
    restoreVideo = shimVideo();
    const cards = pile(1);
    const { seen } = mount({ prefs: { developer: true }, over: () => ({ scanner_frame: cards.frame }) });
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
    expect(cards.sent.every((sent) => sent.previews === false)).toBe(true);

    // A write of another field carries the switch on as it was stored: it is the desktop face's.
    await userEvent.click(screen.getByRole("button", { name: "Exact" }));
    await waitFor(() => expect(last(seen.prefs)).toMatchObject({ mode: "exact", developer: true }), SETTLE);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("stops recognition and keeps the camera, and starts again on the same stream", async () => {
    const { stop, getUserMedia } = camera();
    restoreVideo = shimVideo();
    const cards = pile(1, "looking");
    mount({ over: () => ({ scanner_frame: cards.frame }) });
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    expect(await screen.findByText("Scanning stopped. Press Start scanning to resume.")).toBeInTheDocument();
    // One frame may have been on the wire as the press landed; nothing after it.
    await act(() => new Promise((r) => setTimeout(r, 60)));
    const stopped = cards.sent.length;
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(cards.sent.length).toBe(stopped);
    expect(stop).not.toHaveBeenCalled();
    // The status line goes back to nothing in frame rather than freezing on the last card.
    expect(statusLine()).toHaveTextContent("Looking");

    await userEvent.click(screen.getByRole("button", { name: "Start scanning" }));
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(stopped), SETTLE);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stores a change of mode and sends the next frame in it", async () => {
    camera();
    restoreVideo = shimVideo();
    const cards = pile(0, "looking");
    const { seen } = mount({ over: () => ({ scanner_frame: cards.frame }) });
    await waitFor(() => expect(cards.sent.length).toBeGreaterThan(0), SETTLE);
    expect(screen.getByRole("button", { name: "Fast" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Exact" }));
    expect(screen.getByRole("button", { name: "Exact" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(last(seen.prefs)?.mode).toBe("exact"), SETTLE);
    await waitFor(() => expect(last(cards.sent)?.mode).toBe("exact"), SETTLE);
  });

  it("lands a card Exact cannot pin as a question, and a press on a candidate answers it", async () => {
    camera();
    restoreVideo = shimVideo();
    const { seen } = mount({
      prefs: { mode: "exact" },
      // The first number is a baseline; the second, on a frame carrying a decision, is the card.
      over: () => ({ scanner_frame: frames(VERDICTS.voting, { ...VERDICTS.exactAmbiguous, decision_seq: 1 }) }),
    });
    const question = await screen.findByRole("group", { name: "Printings of Lightning Bolt" }, SETTLE);
    expect(within(question).getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText("1 card to pick")).toBeInTheDocument();
    // Add is refused, and says why on the page.
    expect(screen.getByText("Pick a printing for every card first")).toBeInTheDocument();

    await userEvent.click(within(question).getByRole("button", { name: "Lightning Bolt — STA 105" }));
    expect(
      await screen.findByRole("button", { name: /^More printings of Lightning Bolt — STA 105/ }),
    ).toBeInTheDocument();
    await waitFor(
      () => expect(last(seen.trays)?.[0]).toMatchObject({ setCode: "sta", collectorNumber: "105", choices: [] }),
      SETTLE,
    );
  });

  it("writes a row's edits to the stored tray — a quantity, a finish, a removal", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [...RESOLVED] });
    await screen.findByText("Urza's Saga", {}, SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "One more Urza's Saga — MH2 259" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish of Black Lotus — LEA 232: Nonfoil" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Black Lotus" })).getByRole("button", { name: "Foil" }));
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
    await screen.findByRole("dialog", { name: "Scanner options" });
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
    expect(await screen.findByText("Added 5 copies to your collection.", {}, SETTLE)).toBeInTheDocument();
    expect(screen.queryByText(/to Collection\./)).toBeNull();
  });

  it("stores the folder a reader chooses, and names it on the footer", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [...RESOLVED] });
    await userEvent.click(await screen.findByRole("button", { name: "Folder: Collection" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    const folders = within(within(sheet).getByRole("list", { name: "Folders" })).getAllByRole("button");
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
    expect(await screen.findByRole("button", { name: "Folder: Collection" }, SETTLE)).toBeInTheDocument();
    await waitFor(() => expect(last(seen.prefs)).toMatchObject({ folderId: null }), SETTLE);
  });

  it("files the tray in one commit, leaves what it did not take, and says what it filed", async () => {
    noCamera("NotAllowedError");
    const { seen } = mount({ tray: [NEEDS_A_FINISH_ROW, ...RESOLVED], prefs: { condition: "NM" } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Add 5 to collection · 1 needs a finish" }, SETTLE),
    );

    await waitFor(() => expect(seen.commits).toHaveLength(1), SETTLE);
    const [commit] = seen.commits;
    expect(commit.folderId).toBeNull();
    expect(commit.items).toEqual(
      RESOLVED.map((row) => ({ cardId: row.cardId, quantity: row.quantity, finish: row.finish, condition: "NM" })),
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
    expect(await screen.findByText("Added 5 copies to Collection.", {}, SETTLE)).toBeInTheDocument();
  });

  it("keeps every row and says the backend's sentence when the commit is refused", async () => {
    noCamera("NotAllowedError");
    mount({
      tray: [...RESOLVED],
      over: () => ({
        scanner_tray_commit: () => {
          throw new Error(DB_BUSY);
        },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Add 5 to collection" }, SETTLE));
    const footer = screen.getByRole("button", { name: "Add 5 to collection" }).closest("footer");
    await waitFor(() => expect(within(footer as HTMLElement).getByRole("alert")).toHaveTextContent(DB_BUSY), SETTLE);
    expect(trayRows()).toHaveLength(3);
    expect(screen.queryByText(/^Added /)).toBeNull();
  });

  it("makes a deck of the scans and opens it, leaving the tray as it was", async () => {
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
    expect(await screen.findByRole("heading", { level: 2, name: "Scanned pile" }, SETTLE)).toBeInTheDocument();
    expect(made).toHaveLength(1);
    expect((made[0] as { items: { quantity: number }[] }).items.map((item) => item.quantity)).toEqual([3, 1, 1]);
    // Nothing was filed into the collection, and nothing left the tray.
    expect(seen.commits).toEqual([]);
    expect(seen.trays.every((rows) => rows.length === 3)).toBe(true);
  });

  it("clears the tray only after a question that says how many copies will go", async () => {
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

  it("throws the scanner's evidence away on Reset evidence", async () => {
    camera();
    restoreVideo = shimVideo();
    // An empty desk after the card, not a parked frame: a reset drains the frame on the wire
    // before it asks the session, and a frame that never answers would hold it for ever.
    const { seen } = mount({ over: () => ({ scanner_frame: pile(1, "looking").frame }) });
    await waitFor(() => expect(trayRows()).toHaveLength(1), SETTLE);
    await userEvent.click(screen.getByRole("button", { name: "Reset evidence" }));
    await waitFor(() => expect(seen.resets).toBe(1), SETTLE);
    // The card it had already taken stays in the tray.
    expect(trayRows()).toEqual([["Urza's Saga", "1"]]);
  });
});

describe("what the Scanner page says when it cannot scan", () => {
  it("says the camera was refused, and still draws the bar, the tray and the footer", async () => {
    noCamera("NotAllowedError");
    mount({ tray: [...RESOLVED] });
    expect(await screen.findByRole("alert", {}, SETTLE)).toHaveTextContent(
      "MTG Grimoire needs camera access to scan a card.",
    );
    expect(screen.getByRole("group", { name: "Scan mode" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Add 5 to collection" }, SETTLE)).toBeInTheDocument();
  });

  it("says a device has no camera", async () => {
    noCamera("NotFoundError");
    mount();
    expect(await screen.findByRole("alert", {}, SETTLE)).toHaveTextContent("No camera on this device.");
  });

  it("offers the missing data in its slot, says it cannot identify, and refuses the filters in words", async () => {
    noCamera("NotAllowedError");
    const { view } = mount({ fake: { seed: "starter", fault: "scannerMissing" } });
    const slot = () => view.container.querySelector("[data-scanner-data-slot]");
    await waitFor(
      () => expect(slot()).toHaveTextContent("The scanner needs its card data — about 19 MB."),
      SETTLE,
    );
    // The offer, and not an instruction to put a file where nobody holding this page can reach.
    expect(within(slot() as HTMLElement).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(slot()).not.toHaveTextContent("No reference bundle.");
    expect(slot()).not.toHaveTextContent("Restart the app");
    await waitFor(() => expect(statusLine()).toHaveTextContent("Can't identify"), SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    // A greyed row's name includes its reason.
    expect(within(sheet).getByRole("button", { name: /^Filters\s*Filters need the card database/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * **The download, from the press to a scanner that has its data.** The host owes the three
   * files; the reader presses once; the bar stands where the button was; and when the files have
   * landed the offer is gone with no restart — the status is read again and says the bundle
   * loaded, the line stops saying it cannot identify, the filters can be opened, and the new
   * session is given the reader's stored filters, which the one with no card names had refused.
   */
  it("fetches the scanner's data on a press, and afterwards has it: the offer gone, the status read again, the filters pushed", async () => {
    noCamera("NotAllowedError");
    const hob = { sets: ["hob"], released_from: null, released_to: null };
    const asked = { status: 0, fetches: 0, filters: [] as unknown[] };
    const { view } = mount({
      fake: { seed: "starter", fault: "scannerMissing" },
      prefs: { filters: hob },
      over: (own) => ({
        scanner_status: () => {
          asked.status += 1;
          return (own.scanner_status as () => unknown)();
        },
        scanner_assets_fetch: () => {
          asked.fetches += 1;
          return (own.scanner_assets_fetch as () => unknown)();
        },
        scanner_set_filters: (args: { filters: unknown }) => {
          asked.filters.push(args.filters);
          return (own.scanner_set_filters as (a: unknown) => unknown)(args);
        },
      }),
    });
    const slot = () => view.container.querySelector("[data-scanner-data-slot]");
    await waitFor(() => expect(slot()).toHaveTextContent("about 19 MB"), SETTLE);
    await waitFor(() => expect(statusLine()).toHaveTextContent("Can't identify"), SETTLE);
    // Nothing is fetched until the press; and the stored filters were pushed once, to a session
    // with no card names to filter by.
    expect(asked.fetches).toBe(0);
    expect(asked.status).toBe(1);
    expect(asked.filters).toEqual([hob]);

    const download = within(slot() as HTMLElement).getByRole("button", { name: "Download" });
    // A finger's size under a coarse pointer.
    expect(download.classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
    await userEvent.click(download);
    expect(
      await within(slot() as HTMLElement).findByRole("progressbar", {
        name: "Downloading the scanner's files",
      }),
    ).toBeInTheDocument();
    expect(within(slot() as HTMLElement).queryByRole("button")).not.toBeInTheDocument();

    // Landed: no element left in the slot, and the page reads a scanner that has its data.
    await waitFor(() => expect(slot()).toBeNull(), SETTLE);
    expect(asked.fetches).toBe(1);
    expect(asked.status).toBe(2);
    await waitFor(() => expect(statusLine()).not.toHaveTextContent("Can't identify"), SETTLE);
    await waitFor(() => expect(asked.filters).toEqual([hob, hob]), SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanner options" });
    expect(within(sheet).getByRole("button", { name: /^Filters/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * A host with no scanner session — a web page, until the light app's web step. The engine
   * refuses the status, a frame, a reset and a filter push in one sentence there, and answers the
   * prefs, the tray and the lease.
   */
  it("stays quiet on a host with no scanner session: no camera, no frame, the sentence where the picture would be", async () => {
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
      () => expect(within(box() as HTMLElement).getByRole("alert")).toHaveTextContent(SCANNER_NOT_IN_A_BROWSER_YET),
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
          return new Promise((_, refuse) => setTimeout(() => refuse(new Error(SCANNER_OPEN_ELSEWHERE)), 5));
        },
      }),
    });
    expect(await screen.findByText(/It will open here once that window closes/, {}, SETTLE)).toBeInTheDocument();
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
    camera();
    restoreVideo = shimVideo();
    mount({ over: () => ({ scanner_frame: pile(1).frame }) });
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
    await userEvent.click(tab("Wishlist"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Scanned cards" })).toBeNull(), SETTLE);
    await userEvent.click(tab("Scanner"));
    await waitFor(() => expect(trayRows()).toEqual([["Urza's Saga", "1"]]), SETTLE);
  });
});
