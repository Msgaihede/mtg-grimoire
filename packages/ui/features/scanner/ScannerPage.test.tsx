import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CardSummary,
  CollectionFolder,
  ScanBatchSummary,
  ScannerPrefs,
  ScannerSubmitted,
  ScannerVerdict,
  SearchResponse,
  SupporterStatus,
} from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";
import { SCANNER_NOT_IN_A_BROWSER_YET, SCANNER_OPEN_ELSEWHERE } from "./verdictText";
import { DEFAULT_SCANNER_PREFS, NEEDS_A_FINISH_ROW, STATUS, TRAY_ROWS, VERDICTS } from "./fixtures";

vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  const { DEFAULT_SCANNER_PREFS: prefs } = await import("./fixtures");
  return {
    ...real,
    ipc: {
      ...real.ipc,
      scannerStatus: vi.fn(async () => STATUS.missing),
      // The lease, free: every test but the ones that say otherwise is a window with the scanner to
      // itself, which is also the only state the page had before there was more than one window.
      scannerElsewhere: vi.fn(async () => false),
      // The mounted view's heartbeat, accepted: the lease is this window's for as long as it stays.
      scannerHold: vi.fn(async () => {}),
      scannerFrame: vi.fn(),
      // `async` rather than a bare `vi.fn()`: the real command answers a promise and the page
      // now attaches a rejection handler to it, so a mock returning `undefined` is a shape the
      // app cannot produce — and one that would make every test here fail for the wrong reason.
      scannerReset: vi.fn(async () => {}),
      scannerCapture: vi.fn(async () => ({ saved: "live-7.jpg" })),
      // *Send scan…*: the inbox's answer, and the search its dialog asks for printings. Both
      // mocked so no test reaches the real core, and typed by what they answer — a bare `vi.fn()`
      // takes any shape a test hands it.
      scannerSubmit: vi.fn(async (): Promise<ScannerSubmitted> => ({ id: "unset" })),
      searchCards: vi.fn(async (): Promise<SearchResponse> => ({
        items: [],
        total: 0,
        totalIsCapped: false,
      })),
      // The membership, which *Send scan…* is drawn for and for nobody else. **A supporter's by
      // default, and the default is doing work**: every test here that asks why the press is or
      // is not there — a refused camera, a Stop, a trade — is asking about its own condition,
      // and can only ask it where the membership would have let the press be drawn. The tests
      // about the membership itself say what it answers instead.
      syncSupporterStatus: vi.fn(async (): Promise<SupporterStatus> => ({
        entitled: true,
        status: "active",
        since: 1_756_000_000,
        groupBound: true,
      })),
      // The four the reader's half reads and writes. The pump waits for the first two to have
      // answered — prefs loaded and their filters pushed — so each is a resolved promise by default.
      scannerPrefs: vi.fn(async () => prefs),
      setScannerPrefs: vi.fn(async () => {}),
      scannerSetFilters: vi.fn(async () => {}),
      scannerTray: vi.fn(async () => []),
      setScannerTray: vi.fn(async () => {}),
      scannerTrayCommit: vi.fn(async () => ({
        added: 1,
        updated: 0,
        removed: 0,
        copies: 1,
        leftInFolders: 0,
        undoId: null,
      })),
      // Archive (issue #989): the batch's id. The history's reads answer an empty history, so a
      // test that opens the dialog says what is in it.
      scannerTrayArchive: vi.fn(async (): Promise<number | null> => 12),
      scanHistoryList: vi.fn(async (): Promise<ScanBatchSummary[]> => []),
      scanHistoryGet: vi.fn(async () => null),
      scanHistoryRename: vi.fn(async () => {}),
      scanHistoryDelete: vi.fn(async () => {}),
      // Mocked so a regression back to it answers rather than reaching the real core — and so the
      // commit tests can say it is never called.
      collectionImportCommit: vi.fn(async () => ({
        added: 1,
        updated: 0,
        removed: 0,
        copies: 1,
        leftInFolders: 0,
        undoId: null,
      })),
      collectionFolderList: vi.fn(async () => []),
      deckLastFormat: vi.fn(async () => null),
      formatSpecs: vi.fn(async () => []),
      deckFolderList: vi.fn(async () => []),
    },
  };
});
/**
 * Whether the window is minimized, driven by the test — `useWindowParked`'s own suite owns the
 * minimize, the grace and the restore, so this file asks only what the page does with each answer.
 * Every test but the minimize ones is a window on screen.
 */
const parkedStore = vi.hoisted(() => {
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
vi.mock("./useWindowParked", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useWindowParked: () => useSyncExternalStore(parkedStore.subscribe, parkedStore.get),
  };
});
import { ipc } from "@/lib/ipc";
import { SCANNING_STOPPED, SHOT_READY_CLICK } from "./reader/readerText";
import { importItems } from "./reader/tray";
import { ScannerPage } from "./ScannerPage";
import { runClock } from "./submit/run";
import { SCAN_TOO_SHORT } from "./submit/submitText";
import { SCANNER_ELSEWHERE_POLL_MS } from "./useScannerElsewhere";
import type { TrayDestination } from "./useTrayDestination";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScannerPage />
    </QueryClientProvider>,
  );
}

/** The press the view waits for before it reads anything: it opens stopped (issue #1317). */
async function start() {
  fireEvent.click(await screen.findByRole("button", { name: "Start scanning" }));
}

/** The camera, answered. A refusal is the state most of these tests want the video box in. */
function mediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}
function refused() {
  mediaDevices(() => Promise.reject(new DOMException("x", "NotAllowedError")));
}

/** The stored prefs this test starts from — the crate's defaults with `over` on top. */
function storedPrefs(over: Partial<ScannerPrefs>) {
  vi.mocked(ipc.scannerPrefs).mockResolvedValue({ ...DEFAULT_SCANNER_PREFS, ...over });
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

/** Answers one frame at a time, in order, and parks every frame after the last one. */
function frames(...verdicts: ScannerVerdict[]) {
  let n = 0;
  vi.mocked(ipc.scannerFrame).mockImplementation(() => {
    const v = verdicts[n++];
    return v === undefined ? new Promise(() => {}) : Promise.resolve(v);
  });
}

/**
 * Answers every frame, each a few milliseconds later. **Never `mockResolvedValue`**: an answer
 * already settled lets the pump go round on microtasks alone, which starves every timer in the
 * file — the test's own waits included — and the run hangs rather than fails.
 */
function paced() {
  vi.mocked(ipc.scannerFrame).mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(VERDICTS.voting), 10)),
  );
}

/** The video box — the camera's picture, with the detector's strip laid over it. */
function videoBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector("video")?.parentElement;
  if (!box) throw new Error("no video box");
  return box;
}

/** The layout row: the camera's column and the tray's, side by side. */
function row(container: HTMLElement): HTMLElement {
  const found = videoBox(container).parentElement?.parentElement;
  if (!found) throw new Error("no layout row around the camera");
  return found;
}

/** The detector's own strip, inside the video box. */
function strip(container: HTMLElement): HTMLElement {
  const found = videoBox(container).querySelector<HTMLElement>("[aria-live='polite']");
  if (found === null) throw new Error("no detector strip in the video box");
  return found;
}

/** The reader's one line — the Match strip's row, above the camera. */
function statusLine(): HTMLElement {
  return screen.getByRole("status", { name: "Scanner status" });
}

function tray(): HTMLElement {
  return screen.getByRole("region", { name: "Scanned cards" });
}

const BINDER: CollectionFolder = {
  rules: [],
  id: 7,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "f7",
};
const DECK_GROUP: CollectionFolder = {
  ...BINDER,
  id: 9,
  name: "Burn",
  kind: "deck",
  deckId: 4,
  syncUid: "f9",
};

const COMMANDS = [
  ipc.scannerStatus,
  ipc.scannerElsewhere,
  ipc.scannerHold,
  ipc.scannerFrame,
  ipc.scannerReset,
  ipc.scannerCapture,
  ipc.scannerSubmit,
  ipc.searchCards,
  ipc.syncSupporterStatus,
  ipc.scannerPrefs,
  ipc.setScannerPrefs,
  ipc.scannerSetFilters,
  ipc.scannerTray,
  ipc.setScannerTray,
  ipc.scannerTrayCommit,
  ipc.scannerTrayArchive,
  ipc.scanHistoryList,
  ipc.scanHistoryGet,
  ipc.scanHistoryRename,
  ipc.scanHistoryDelete,
  ipc.collectionImportCommit,
  ipc.collectionFolderList,
];

let restoreCanvas = () => {};
beforeEach(() => {
  restoreCanvas = shimCanvas();
});
afterEach(() => {
  restoreCanvas();
  vi.restoreAllMocks();
  // `restoreAllMocks` reaches `vi.spyOn` and nothing else, so the command mocks keep whatever the
  // last test queued on them — a `mockReturnValue` outliving its own test is how a suite becomes
  // order-dependent. `mockReset` puts each back to the implementation its `vi.fn(…)` was built
  // with, which is the state every test below expects to start from.
  COMMANDS.forEach((command) => vi.mocked(command).mockReset());
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  parkedStore.set({ paused: false, released: false });
});

describe("ScannerPage", () => {
  it("opens the full deck settings dialog and keeps the tray on cancellation", async () => {
    refused();
    const rows = TRAY_ROWS.filter((row) => row.choices.length === 0);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    mount();
    await screen.findByText("Urza's Saga");
    const opener = screen.getByRole("button", { name: "Create deck…" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "New deck" });
    expect(within(dialog).getByText(/scans stay in the tray/)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New deck" })).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
    expect(screen.getByText("Urza's Saga")).toBeInTheDocument();
    expect(ipc.scannerTrayCommit).not.toHaveBeenCalled();
  });

  it("opens stopped, with the camera live, and reads nothing until Start scanning is pressed", async () => {
    const restore = shimVideo();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    paced();
    try {
      mount();
      const press = await screen.findByRole("button", { name: "Start scanning" });
      expect(screen.getByText(SCANNING_STOPPED)).toBeInTheDocument();
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ipc.scannerFrame).not.toHaveBeenCalled();
      fireEvent.click(press);
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(SCANNING_STOPPED)).toBeNull();
      expect(screen.getByRole("button", { name: "Stop scanning" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("pauses recognition with the camera and tray still available, and resumes only when asked", async () => {
    const restore = shimVideo();
    const stop = vi.fn();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    paced();
    vi.mocked(ipc.scannerTray).mockResolvedValue([...TRAY_ROWS]);
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      await user.click(screen.getByRole("button", { name: "Stop scanning" }));
      expect(stop).not.toHaveBeenCalled();
      expect(screen.getByText(SCANNING_STOPPED)).toBeInTheDocument();
      expect(tray()).toHaveTextContent(TRAY_ROWS[0].name);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      act(() => parkedStore.set({ paused: true, released: false }));
      act(() => parkedStore.set({ paused: false, released: false }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(ipc.scannerFrame).toHaveBeenCalledTimes(sent);
      await user.click(screen.getByRole("button", { name: "Start scanning" }));
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(sent),
      );
      expect(tray()).toHaveTextContent(TRAY_ROWS[0].name);
    } finally {
      restore();
    }
  });

  /**
   * *Add card…* (issue #978): the pump pauses while the search is open, the reader's printing and
   * finish land at the head of the tray, and closing the dialog resumes what was running.
   */
  it("pauses the scanner while a card is added by hand, and lands it in the tray", async () => {
    const restore = shimVideo();
    opens();
    paced();
    const bolt: CardSummary = {
      id: "bolt-2x2",
      name: "Lightning Bolt",
      setCode: "2x2",
      setName: "Double Masters 2022",
      collectorNumber: "117",
      rarity: "uncommon",
      typeLine: "Instant",
      manaCost: "{R}",
      price: null,
      layout: "normal",
      oracleId: "bolt",
      finishes: '["nonfoil","foil"]',
      promoTypes: null,
      gameChanger: false,
      releasedAt: null,
      imageUpdatedAt: null,
      ownedQuantity: 0,
      wishlisted: false,
      printings: 1,
      priceLow: null,
      priceHigh: null,
    };
    vi.mocked(ipc.searchCards).mockResolvedValue({ items: [bolt], total: 1, totalIsCapped: false });
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      const opener = within(tray()).getByRole("button", { name: "Add card…" });
      await user.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "Add a card" });
      expect(
        within(dialog).getByText("Scanning is paused while this is open."),
      ).toBeInTheDocument();

      // Paused: no frame goes out while the dialog stays open.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ipc.scannerFrame).toHaveBeenCalledTimes(sent);

      await user.type(
        within(dialog).getByRole("searchbox", { name: "Which card do you want to add?" }),
        "bolt",
      );
      await user.click(await within(dialog).findByRole("radio", { name: /Lightning Bolt/ }));
      await user.click(within(dialog).getByRole("radio", { name: "Foil" }));
      await user.click(within(dialog).getByRole("button", { name: "Add to tray" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Add a card" })).not.toBeInTheDocument(),
      );
      expect(opener).toHaveFocus();
      expect(tray()).toHaveTextContent("Lightning Bolt");
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written?.[0]).toMatchObject({
        cardId: "bolt-2x2",
        oracleId: "bolt",
        name: "Lightning Bolt",
        setCode: "2x2",
        collectorNumber: "117",
        finish: "foil",
        quantity: 1,
        choices: [],
      });
      // And resumed.
      await waitFor(() =>
        expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(sent),
      );
    } finally {
      restore();
    }
  });

  it("can stop recognition while a camera request is pending without cancelling the preview", async () => {
    const restore = shimVideo();
    let opened!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          opened = resolve;
        }),
    );
    mediaDevices(getUserMedia);
    const user = userEvent.setup();
    paced();
    try {
      mount();
      await start();
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Stop scanning" }));
      await act(async () => opened({ getTracks: () => [{ stop }] } as unknown as MediaStream));
      expect(stop).not.toHaveBeenCalled();
      expect(ipc.scannerFrame).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Start scanning" }));
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("shows the refused camera's sentence in place of the video, and the recognizer's refusal under it", async () => {
    refused();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.corrupt);
    mount();
    expect(
      await screen.findByText("MTG Grimoire needs camera access to scan a card."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("The card recognizer did not load: gallery: bad magic."),
    ).toBeInTheDocument();
    // The reader's view: the tray beside the camera, and no developer panel until asked for.
    expect(tray()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();
  });

  it("says nothing about a recognizer the build carries inside itself and loaded", async () => {
    refused();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    mount();
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    await waitFor(() => expect(ipc.scannerStatus).toHaveBeenCalled());
    expect(screen.queryByText(/card recognizer did not load/)).not.toBeInTheDocument();
  });

  it("has an sr-only heading, because the ribbon carries the visible title", async () => {
    refused();
    mount();
    await screen.findByRole("status", { name: "Scanner status" });
    expect(screen.getByRole("heading", { level: 2, name: "Scanner" })).toHaveClass("sr-only");
  });

  it("reserves the detector's strip whether or not there is a sentence in it", async () => {
    refused();
    const { container } = mount();
    await screen.findByRole("status", { name: "Scanner status" });
    expect(strip(container)).toHaveTextContent("");
    // Two lines of room, kept whether the strip is empty or full, so the video box above it
    // does not change height the moment the detector has something to say.
    expect(strip(container)).toHaveClass("min-h-[2.5em]");
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    expect(strip(container)).toHaveTextContent("");
  });

  it("names what the scanner is doing in the strip above the camera", async () => {
    refused();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    mount();
    await waitFor(() => expect(statusLine()).toHaveTextContent("Point the camera at a card"));
  });

  it("prints the frame's own refusal in that strip once the developer panels are on", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ developer: true });
    frames(VERDICTS.noCard);
    try {
      const { container } = mount();
      await start();
      await waitFor(() => expect(strip(container)).toHaveTextContent(VERDICTS.noCard.error ?? ""));
    } finally {
      restore();
    }
  });

  it("puts the tray beside the camera, the video box taking what the row leaves", async () => {
    refused();
    const { container } = mount();
    await screen.findByRole("status", { name: "Scanner status" });
    expect(row(container).classList.contains("flex-col")).toBe(false);
    expect(videoBox(container)).toHaveClass("flex-1");
    expect(videoBox(container).classList.contains("shrink-0")).toBe(false);
    expect(videoBox(container).style.aspectRatio).toBe("");
  });

  it("shows the Match panel behind the Developer switch, and hides it again", async () => {
    refused();
    const user = userEvent.setup();
    mount();
    const toggle = await screen.findByRole("switch", { name: "Developer" });
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(await screen.findByRole("region", { name: "Match" })).toBeInTheDocument();
    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenLastCalledWith({
        ...DEFAULT_SCANNER_PREFS,
        developer: true,
      }),
    );

    await user.click(screen.getByRole("switch", { name: "Developer" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument(),
    );
  });

  /** Beside the bar for every reader since #740 — not behind the Developer switch. */
  it("hands the reset press straight to the command, with the Developer panels off", async () => {
    refused();
    mount();
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Reset evidence" }));
    expect(vi.mocked(ipc.scannerReset)).toHaveBeenCalled();
  });

  /**
   * A press that fails has somewhere to say so. `void ipc.scannerReset()` discarded the
   * rejection, so a poisoned scanner state or a thread that did not come back was a button
   * that visibly did nothing — the evidence stayed on screen with no sentence anywhere.
   */
  it("puts a refused reset in the strip under the video", async () => {
    refused();
    vi.mocked(ipc.scannerReset).mockRejectedValueOnce("the scanner state is poisoned");
    const { container } = mount();
    await start();
    await userEvent.click(await screen.findByRole("button", { name: "Reset evidence" }));
    await waitFor(() =>
      expect(strip(container)).toHaveTextContent("the scanner state is poisoned"),
    );
  });

  it("files a capture under the five fields the sidecar has, read off the last verdict", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ developer: true });
    // A recognizer that loaded, so the Match panel's figures describe a named card.
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    frames(VERDICTS.decided);
    try {
      mount();
      await start();
      // The Match panel's this-frame line naming the card is the tell that the verdict has
      // landed — its head row went to the strip above the camera, which every reader sees.
      const match = await screen.findByRole("region", { name: "Match" });
      await waitFor(() => expect(match).toHaveTextContent("this frame: Storm of Saruman"));
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
        votes: "2.00",
        distance: "11",
      });
      expect(await screen.findByText("saved live-7.jpg")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  /**
   * **One row per `decision_seq`, and the number is the whole of the rule.** The decided card
   * rides every committed frame after the one that decided it, so a page that added on the
   * *decision* rather than on the number moving would fill the tray with one card nine times a
   * second.
   */
  it("adds a tray row when decision_seq moves, and not again for the same seq", async () => {
    const restore = shimVideo();
    opens();
    // Nonfoil set by hand: the decided printing has two finishes, which Detect would leave to the
    // reader (the Unknown test below), and this test is about the number, not the finish.
    storedPrefs({ finish: "nonfoil" });
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    frames(VERDICTS.voting, VERDICTS.decided, VERDICTS.decided, VERDICTS.decided);
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(5));
      const rows = within(tray()).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Storm of Saruman")).toBeInTheDocument();
      expect(
        within(tray()).getByRole("button", { name: "Add 1 to collection" }),
      ).toBeInTheDocument();
      // The strip names the card that was filed and says it was added.
      expect(statusLine()).toHaveTextContent(
        "Matched Storm of Saruman LTR 72 Added · swap in the next card",
      );
      // …and the store gets the tray once the quiet window has passed.
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written).toHaveLength(1);
      expect(written?.[0]).toMatchObject({
        cardId: "storm-of-saruman-ltr-72",
        quantity: 1,
        finish: "nonfoil",
      });
    } finally {
      restore();
    }
  });

  /**
   * **Point and shoot on the desktop face is a click**: *Scan card* runs the pump until one card
   * lands, then pauses on its own — the card stays over the camera, and nothing more is read until
   * the next press. The next press is news even for the card still lying there: a second copy.
   */
  it("reads one card per Scan card under point and shoot, then pauses by itself", async () => {
    const restore = shimVideo();
    opens();
    // Nonfoil by hand, so the second copy can bump the first: an Unknown row never does.
    storedPrefs({ pointAndShoot: true, finish: "nonfoil" });
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    // Every frame decided, paced (`paced`'s reason): each shot's first frame lands its card.
    vi.mocked(ipc.scannerFrame).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(VERDICTS.decided), 10)),
    );
    try {
      const { container } = mount();
      const press = await screen.findByRole("button", { name: "Scan card" });
      expect(screen.queryByRole("button", { name: "Start scanning" })).toBeNull();
      expect(screen.getByText(SHOT_READY_CLICK)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ipc.scannerFrame).not.toHaveBeenCalled();

      fireEvent.click(press);
      expect(await screen.findByRole("button", { name: "Cancel scan" })).toBeInTheDocument();
      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      // The shot is over once its card has landed, and the card is still said over the camera.
      expect(await screen.findByRole("button", { name: "Scan card" })).toBeInTheDocument();
      expect(screen.getByText(SHOT_READY_CLICK)).toBeInTheDocument();
      expect(videoBox(container)).toHaveTextContent("Added to scanned cards");
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ipc.scannerFrame).toHaveBeenCalledTimes(sent);

      // The next press reads again, and the same card is a second copy rather than old news.
      fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
      await waitFor(() =>
        expect(
          within(tray()).getByRole("button", { name: "Add 2 to collection" }),
        ).toBeInTheDocument(),
      );
      expect(await screen.findByRole("button", { name: "Scan card" })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("cancels a shot that found nothing on a second press", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ pointAndShoot: true });
    paced();
    try {
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Scan card" }));
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
      expect(await screen.findByText(SHOT_READY_CLICK)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(ipc.scannerFrame).toHaveBeenCalledTimes(sent);
    } finally {
      restore();
    }
  });

  it("stores point and shoot from the bar's switch, and lands stopped", async () => {
    refused();
    mount();
    const toggle = await screen.findByRole("switch", { name: "Point & shoot" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenLastCalledWith({
        ...DEFAULT_SCANNER_PREFS,
        pointAndShoot: true,
      }),
    );
    expect(await screen.findByRole("button", { name: "Scan card" })).toBeInTheDocument();
  });

  /** The card that just landed is laid over the camera, named as the tray filed it. */
  it("lays the card that just landed over the camera", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ finish: "nonfoil" });
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    frames(VERDICTS.voting, VERDICTS.decided);
    try {
      const { container } = mount();
      await start();
      await waitFor(() => expect(videoBox(container)).toHaveTextContent("Added to scanned cards"));
      expect(videoBox(container)).toHaveTextContent("Storm of Saruman");
      expect(videoBox(container)).toHaveTextContent("LTR · 72 · Nonfoil");
    } finally {
      restore();
    }
  });

  /**
   * **The stored camera, by its id, and one request for it.** The camera is held shut until the
   * prefs are in; opened on mount instead it would ask for the default and then again for the
   * stored one.
   */
  it("opens the stored camera by its id, and asks for no other first", async () => {
    const getUserMedia = vi.fn(() =>
      Promise.resolve({
        getTracks: () => [{ stop: () => {} }],
        getVideoTracks: () => [{ getSettings: () => ({ deviceId: "brio" }) }],
      } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    storedPrefs({ cameraId: "brio" });
    // The camera goes live under the shim, so the pump starts; every frame it sends is parked.
    frames();
    const restore = shimVideo();
    try {
      mount();
      await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(getUserMedia.mock.calls[0]).toMatchObject([
        { video: { deviceId: { exact: "brio" } } },
      ]);
    } finally {
      restore();
    }
  });

  it("stores the tray layout the reader picks", async () => {
    refused();
    const user = userEvent.setup();
    mount();
    const layouts = await within(
      await screen.findByRole("region", { name: "Scanned cards" }),
    ).findByRole("group", { name: "Tray layout" });
    await user.click(within(layouts).getByRole("button", { name: "List" }));
    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenLastCalledWith({
        ...DEFAULT_SCANNER_PREFS,
        trayLayout: "list",
      }),
    );
  });

  /** A new row is born in the Defaults popover's finish — the prefs', not a literal. */
  it("stamps a new row with the prefs' finish", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ finish: "foil" });
    frames(VERDICTS.voting, VERDICTS.decided);
    try {
      mount();
      await start();
      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written?.[0]?.finish).toBe("foil");
    } finally {
      restore();
    }
  });

  /**
   * **Detect is the default, and a card printed in more than one finish lands as Unknown rather
   * than as a guess.** Storm of Saruman exists in two finishes and the scanner reads no finish off
   * the card, so there is nothing to choose between them by — and the row says so instead of
   * filing the first finish on the list.
   */
  it("stamps a new row Unknown under Detect when the printing has two finishes", async () => {
    const restore = shimVideo();
    opens();
    expect(DEFAULT_SCANNER_PREFS.finish).toBe("detect");
    expect(VERDICTS.decided.decision?.finishes).toEqual(["nonfoil", "foil"]);
    frames(VERDICTS.voting, VERDICTS.decided);
    try {
      mount();
      await start();
      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      expect(
        within(tray()).getByRole("button", { name: "Add 0 to collection · 1 needs a finish" }),
      ).toHaveAttribute("aria-disabled", "true");
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written?.[0]?.finish).toBe("unknown");
    } finally {
      restore();
    }
  });

  /**
   * **Add files the rows with a finish and leaves the one without**, in the same one call: the
   * known rows are the import and the Unknown row is the whole of `remaining` — so it is still in
   * the stored tray when the commit lands, not merely still on screen.
   */
  it("commits the known-finish rows and keeps the one that needs a finish", async () => {
    refused();
    const known = TRAY_ROWS.slice(1); // 3 + 1 + 1 copies
    vi.mocked(ipc.scannerTray).mockResolvedValue([NEEDS_A_FINISH_ROW, ...known]);
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(
      await within(tray()).findByRole("button", { name: "Add 5 to collection · 1 needs a finish" }),
    );
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(ipc.scannerTrayCommit).toHaveBeenCalledWith(importItems(known, "NONE"), null, [
      NEEDS_A_FINISH_ROW,
    ]);
    await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
    expect(within(tray()).getByText("Lightning Bolt")).toBeInTheDocument();
    const add = within(tray()).getByRole("button", {
      name: "Add 0 to collection · 1 needs a finish",
    });
    expect(add).toHaveAttribute("aria-disabled", "true");
    // Refused on the press as well as drawn refused — the handler asks the same question.
    await user.click(add);
    expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1);
  });

  /**
   * **One call carries the collection's rows and the tray that is left, so neither can land
   * without the other.** The emptied tray is stored by the commit itself: a debounced write behind
   * it was what an app closed in the next 400 ms never made, and the committed rows came back.
   */
  it("commits the tray in one call, into the prefs' folder, storing the empty tray with it", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1); // the three resolved rows: 3 + 1 + 1 copies
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    vi.mocked(ipc.collectionFolderList).mockResolvedValue([BINDER]);
    storedPrefs({ folderId: BINDER.id, condition: "LP" });
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(ipc.scannerTrayCommit).toHaveBeenCalledWith(importItems(rows, "LP"), BINDER.id, []);
    expect(ipc.collectionImportCommit).not.toHaveBeenCalled();
    expect(await within(tray()).findByText("Cards you scan appear here.")).toBeInTheDocument();
    // One toast for the press, with the copies and the folder — never one per card.
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Added 5 cards to “Trade binder”",
      tone: "success",
    });
    // Nothing is written behind it: the store already holds the empty tray.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ipc.setScannerTray).not.toHaveBeenCalled();
  });

  /**
   * **The camera keeps running while the commit waits for the write connection**, which is
   * seconds while a sync holds it. A card that lands in that window is a row the commit never saw,
   * and emptying the tray on the answer would throw it away.
   */
  it("keeps a card scanned while the commit was in flight", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    let land!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockResolvedValueOnce(VERDICTS.voting)
      .mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    let answer!: () => void;
    vi.mocked(ipc.scannerTrayCommit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              added: 3,
              updated: 0,
              removed: 0,
              copies: 3,
              leftInFolders: 0,
              undoId: null,
            });
        }),
    );
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
      await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
      // What it stores is the tray without the rows it files — none left, at the moment it went out.
      expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[2]).toEqual([]);

      land(VERDICTS.decided);
      await waitFor(() =>
        expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length + 1),
      );
      answer();

      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      expect(within(tray()).getByText("Storm of Saruman")).toBeInTheDocument();
      // …and the card the commit never saw is written behind it.
      await waitFor(
        () =>
          expect(vi.mocked(ipc.setScannerTray).mock.lastCall?.[0]).toEqual([
            expect.objectContaining({ cardId: "storm-of-saruman-ltr-72" }),
          ]),
        { timeout: 2000 },
      );
    } finally {
      restore();
    }
  });

  /**
   * **The same card again while the commit is in flight is a bump, not a new row**, so the row the
   * commit is filing comes back with one more copy under the same key. The commit filed the three
   * it saw; the tray has to keep the one it did not. Keeping all four would file three of them a
   * second time on the next Add, and dropping the row would lose the copy just scanned.
   */
  it("keeps only the copies bumped onto a row while the commit was in flight", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    const saga = TRAY_ROWS[1]; // Urza's Saga, nonfoil, ×3 — the prefs' default finish
    vi.mocked(ipc.scannerTray).mockResolvedValue([saga]);
    const sagaAgain: ScannerVerdict = {
      ...VERDICTS.decided,
      decision: {
        printing: saga.cardId,
        oracle_id: saga.oracleId,
        label: {
          name: saga.name,
          set: saga.setCode,
          number: saga.collectorNumber,
          lang: "en",
          released: "2021-06-18",
        },
        outcome: "resolved",
        choices: [],
        replaces_previous: false,
        // One finish: Detect files it nonfoil, the saga row's own finish.
        finishes: ["nonfoil"],
      },
    };
    let land!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockResolvedValueOnce(VERDICTS.voting)
      .mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    let answer!: () => void;
    vi.mocked(ipc.scannerTrayCommit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              added: 1,
              updated: 0,
              removed: 0,
              copies: 1,
              leftInFolders: 0,
              undoId: null,
            });
        }),
    );
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      await user.click(await within(tray()).findByRole("button", { name: "Add 3 to collection" }));
      await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
      expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[0]).toEqual([
        { cardId: saga.cardId, quantity: 3, finish: "nonfoil", condition: "NONE" },
      ]);

      land(sagaAgain);
      // A bump, not a second row: one line, four copies, the same key.
      await waitFor(() =>
        expect(
          within(tray()).getByRole("button", { name: "Add 4 to collection" }),
        ).toBeInTheDocument(),
      );
      expect(within(tray()).getAllByRole("listitem")).toHaveLength(1);
      answer();

      await waitFor(() =>
        expect(
          within(tray()).getByRole("button", { name: "Add 1 to collection" }),
        ).toBeInTheDocument(),
      );
      expect(within(tray()).getAllByRole("listitem")).toHaveLength(1);
      await waitFor(
        () =>
          expect(vi.mocked(ipc.setScannerTray).mock.lastCall?.[0]).toEqual([
            expect.objectContaining({ key: saga.key, cardId: saga.cardId, quantity: 1 }),
          ]),
        { timeout: 2000 },
      );
    } finally {
      restore();
    }
  });

  /** One transaction, all or nothing — so a refusal leaves every row where the reader can fix it. */
  it("keeps every row and shows the sentence when the commit is refused", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    vi.mocked(ipc.scannerTrayCommit).mockRejectedValueOnce(
      "no card with the id `x` is in the card database",
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    expect(
      await within(tray()).findByText("no card with the id `x` is in the card database"),
    ).toBeInTheDocument();
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length);
    expect(ipc.setScannerTray).not.toHaveBeenCalledWith([]);
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Couldn't add the scanned cards",
      body: "no card with the id `x` is in the card database",
      tone: "error",
    });
    // Pressed again, it sends the same rows and the same empty remainder — nothing was dropped.
    await user.click(within(tray()).getByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[1]?.[0]).toEqual(importItems(rows, "NONE"));
  });

  /**
   * **A folder that is gone, or that is not the reader's own, is the root.** `collection_import_commit`
   * accepts a deck's group — the import's deck arm files there on purpose — so a stored id that
   * now names one would put scanned cards into a deck's box behind the reader's back.
   */
  /**
   * *Clear all…* (issue #738) asks before it throws a pile of scans away. Cancel keeps every row and
   * hands the caret back to the button; the dialog is drawn outside the view's `@container/scan`
   * box, because a container is the containing block for a `fixed` scrim.
   */
  it("asks before clearing the tray, and a cancel keeps every row", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1); // 3 + 1 + 1 copies
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    const clear = await within(tray()).findByRole("button", { name: "Clear all…" });
    await user.click(clear);
    const dialog = await screen.findByRole("dialog", { name: "Clear the tray" });
    expect(dialog).toHaveTextContent(
      "5 scanned copies will leave the tray without being added to your collection.",
    );
    const scope = container.querySelector(".\\@container\\/scan");
    expect(scope).not.toBeNull();
    expect(scope?.contains(dialog)).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length);
    expect(clear).toHaveFocus();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ipc.setScannerTray).not.toHaveBeenCalled();
  });

  it("empties the tray on a confirmed clear and stores it, filing nothing", async () => {
    refused();
    vi.mocked(ipc.scannerTray).mockResolvedValue(TRAY_ROWS);
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    const clear = await within(tray()).findByRole("button", { name: "Clear all…" });
    await user.click(clear);
    const dialog = await screen.findByRole("dialog", { name: "Clear the tray" });
    await user.click(within(dialog).getByRole("button", { name: "Clear tray" }));

    expect(await within(tray()).findByText("Cards you scan appear here.")).toBeInTheDocument();
    // The caret is back on the button it left, which is still drawn — refused, on an empty tray.
    expect(clear).toHaveFocus();
    expect(clear).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(vi.mocked(ipc.setScannerTray).mock.lastCall?.[0]).toEqual([]), {
      timeout: 2000,
    });
    expect(ipc.scannerTrayCommit).not.toHaveBeenCalled();
    expect(ipc.collectionImportCommit).not.toHaveBeenCalled();
    expect(useNotifications.getState().notices[0]?.title).toMatch(
      /^Cleared \d+ scanned (copy|copies) from the tray$/,
    );
  });

  /**
   * **The camera keeps running behind the question**, so a card that lands while it is open is one
   * the sentence never counted — the clear takes the rows it asked about and leaves that one.
   */
  it("keeps a card scanned while the clear was being confirmed", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    let land!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockResolvedValueOnce(VERDICTS.voting)
      .mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      await user.click(await within(tray()).findByRole("button", { name: "Clear all…" }));
      const dialog = await screen.findByRole("dialog", { name: "Clear the tray" });

      land(VERDICTS.decided);
      await waitFor(() =>
        expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length + 1),
      );
      await user.click(within(dialog).getByRole("button", { name: "Clear tray" }));

      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      expect(within(tray()).getByText("Storm of Saruman")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("files into the root, and stores the root, when the stored folder is not a user folder", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    vi.mocked(ipc.collectionFolderList).mockResolvedValue([BINDER, DECK_GROUP]);
    storedPrefs({ folderId: DECK_GROUP.id });
    const user = userEvent.setup();
    mount();

    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenCalledWith({
        ...DEFAULT_SCANNER_PREFS,
        folderId: null,
      }),
    );
    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[1]).toBeNull();
  });

  /**
   * *Archive* (issue #989): the rows an Add would take, into the scan history and **not** the
   * collection — one `scanner_tray_archive`, the tray that is left stored with it, one toast.
   */
  it("archives the known-finish rows without filing them, keeps the one that needs a finish, and says so once", async () => {
    refused();
    const known = TRAY_ROWS.slice(1); // 3 + 1 + 1 copies
    vi.mocked(ipc.scannerTray).mockResolvedValue([NEEDS_A_FINISH_ROW, ...known]);
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(await within(tray()).findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(ipc.scannerTrayArchive).toHaveBeenCalledTimes(1));
    expect(ipc.scannerTrayArchive).toHaveBeenCalledWith(importItems(known, "NONE"), [
      NEEDS_A_FINISH_ROW,
    ]);
    expect(ipc.scannerTrayCommit).not.toHaveBeenCalled();
    expect(ipc.collectionImportCommit).not.toHaveBeenCalled();
    await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Archived 5 cards to Scan history",
      tone: "success",
    });
  });

  it("keeps every row and says the sentence when the archive is refused", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    vi.mocked(ipc.scannerTrayArchive).mockRejectedValueOnce("The database is busy.");
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(await within(tray()).findByRole("button", { name: "Archive" }));
    expect(await within(tray()).findByText("The database is busy.")).toBeInTheDocument();
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length);
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Couldn't archive the scanned cards",
      body: "The database is busy.",
      tone: "error",
    });
  });

  it("stops an archive in the plan's words while a card waits on a printing, sending nothing", async () => {
    refused();
    vi.mocked(ipc.scannerTray).mockResolvedValue(TRAY_ROWS);
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    await user.click(await within(tray()).findByRole("button", { name: "Archive" }));
    expect(
      await within(tray()).findByText(/still waiting for a printing to be picked/),
    ).toBeInTheDocument();
    expect(ipc.scannerTrayArchive).not.toHaveBeenCalled();
  });

  /** The history's dialog is the page's, mounted outside `@container/scan` like *Clear all…*'s. */
  it("opens the scan history from the bar, outside the view's container, and hands the caret back", async () => {
    refused();
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByRole("region", { name: "Scanned cards" });

    const history = screen.getByRole("button", { name: "History" });
    await user.click(history);
    const dialog = await screen.findByRole("dialog", { name: "Scan history" });
    expect(container.querySelector(".\\@container\\/scan")?.contains(dialog)).toBe(false);
    expect(
      await within(dialog).findByText(
        "Scans you add to your collection or archive will appear here.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Close scan history" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(history).toHaveFocus();
  });

  /**
   * **A frame is its JPEG and nothing else.** There is one scanner, so there is no mode to send
   * with it and none to pick in the bar.
   */
  it("sends each frame as its JPEG alone, and offers no scan mode to pick", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerFrame).mockImplementation(() => new Promise(() => {}));
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(1));
      const call = vi.mocked(ipc.scannerFrame).mock.calls[0] ?? [];
      expect(call).toHaveLength(1);
      expect(call[0]).toBeInstanceOf(Uint8Array);
      expect(screen.queryByRole("group", { name: "Scan mode" })).toBeNull();
      for (const name of ["Fast", "Exact", "Neural"]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
    } finally {
      restore();
    }
  });
});

/**
 * ***Send scan…*** (issue #776): the last couple of seconds the scanner was shown, to its maker,
 * under the printing and finish a reader says the last of them shows. The dialog's own suite
 * (`submit/SubmitScanDialog.test.tsx`) holds what it asks and refuses; what is asked here is the
 * page's half — where the press is offered, what it freezes, where the dialog is mounted, and
 * that recognition pauses while it is open (issue #977).
 */
describe("ScannerPage sending a scan", () => {
  /** The printing the decided fixture names, as the search answers it. */
  const SARUMAN: CardSummary = {
    id: "storm-of-saruman-ltr-72",
    name: "Storm of Saruman",
    setCode: "ltr",
    setName: "The Lord of the Rings: Tales of Middle-earth",
    collectorNumber: "72",
    rarity: "mythic",
    typeLine: "Enchantment",
    manaCost: "{4}{U}{U}",
    price: null,
    layout: "normal",
    oracleId: "storm-of-saruman",
    finishes: '["nonfoil","foil"]',
    promoTypes: null,
    gameChanger: false,
    releasedAt: null,
    imageUpdatedAt: null,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: null,
    priceHigh: null,
  };
  const REFERENCE = "20261011T101500Z-0123456789abcdef";

  /**
   * **The run's clock, taken off the wall** — `runClock`, the one seam the pump stamps a frame
   * through and a press reads the time through. A run reaches four seconds back from the press
   * and no further (`RUN_MAX_AGE_MS`), and this file stalls for longer than that under a full
   * parallel run: on the real clock a test that lets the pump answer and then presses would find
   * its frames too old to send, on a slow machine and on no other.
   *
   * Every reading is ten milliseconds after the one before it — a frame, the next frame, the
   * press. So the frames are in the order they were sent, each at a time of its own, and none is
   * ever old, whatever the machine was doing between them. Lifted by the file's own
   * `restoreAllMocks`.
   */
  beforeEach(() => {
    let at = 1000;
    vi.spyOn(runClock, "now").mockImplementation(() => (at += 10));
  });

  /** No live picture, no press: the box under the strip is already saying why. */
  it("does not offer the press while the camera is refused", async () => {
    refused();
    mount();
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
  });

  /**
   * A canvas whose every encode is a JPEG of its own — `ff d8 n` for the nth — where the file's
   * shim hands every frame the same three bytes: a run is several frames, and a test of one has
   * to be able to tell them apart and say what order they came in. Laid over the file's shim and
   * lifted in the test's own `finally`.
   */
  function numberedCanvas(): () => void {
    let n = 0;
    return shim(HTMLCanvasElement.prototype, {
      toBlob: {
        value: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array([0xff, 0xd8, ++n])])),
      },
    });
  }
  /** The nth frame as the text it is drawn and sent as. */
  const text = (n: number) => btoa(String.fromCharCode(0xff, 0xd8, n));

  /**
   * These verdicts, ten milliseconds apart, and then nothing: every frame after the last is
   * parked. So the run the pump holds is exactly these frames for as long as a test looks at it —
   * and none is an answer already settled, which would starve the file's timers (`paced`).
   */
  function answers(...verdicts: ScannerVerdict[]) {
    let n = 0;
    vi.mocked(ipc.scannerFrame).mockImplementation(() => {
      const verdict = verdicts[n++];
      return verdict === undefined
        ? new Promise(() => {})
        : new Promise((resolve) => setTimeout(() => resolve(verdict), 10));
    });
  }

  /** The picture of the run that is showing — by its name, since a printing's tile is one too. */
  const picture = (dialog: HTMLElement) =>
    within(dialog).getByRole("img", { name: /^Picture \d+ of \d+ that will be sent$/ });

  it("freezes the run on the press, asks which card the last picture shows, and sends every frame of it", async () => {
    const restore = shimVideo();
    const plainFrames = numberedCanvas();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    // Seven frames: three the scanner was still weighing, then four it had decided on.
    const weighing: ScannerVerdict = { ...VERDICTS.voting, decision_seq: 0 };
    answers(weighing, weighing, weighing, ...Array<ScannerVerdict>(4).fill(VERDICTS.decided));
    vi.mocked(ipc.searchCards).mockResolvedValue({
      items: [SARUMAN],
      total: 1,
      totalIsCapped: false,
    });
    vi.mocked(ipc.scannerSubmit).mockResolvedValue({ id: REFERENCE });
    const user = userEvent.setup();
    try {
      const { container } = mount();
      await start();
      // All seven answered: the eighth is on the wire, and stays there.
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(8));
      await waitFor(() => expect(statusLine()).toHaveTextContent("Storm of Saruman"));

      const opener = screen.getByRole("button", { name: "Send scan…" });
      // Beside Reset evidence, outside the live region, like it.
      expect(statusLine()).not.toContainElement(opener);
      await user.click(opener);

      const dialog = await screen.findByRole("dialog", { name: "Send this scan" });
      // A sibling of the view's container box, never inside it: a container is the containing
      // block for the dialog's `fixed` scrim.
      const scope = container.querySelector(".\\@container\\/scan");
      expect(scope).not.toBeNull();
      expect(scope?.contains(dialog)).toBe(false);

      // It rests on the last frame the pump sent — its full-resolution copy, the second of the
      // two encodes each frame is drawn into on a device that may send — as the text that is
      // drawn and sent, and says how many there are to look through.
      expect(picture(dialog)).toHaveAttribute("src", `data:image/jpeg;base64,${text(14)}`);
      expect(picture(dialog)).toHaveAttribute("alt", "Picture 7 of 7 that will be sent");
      expect(within(dialog).getByRole("slider", { name: "Picture" })).toHaveAttribute("max", "7");
      expect(dialog).toHaveTextContent("These 7 pictures — the last couple of seconds");
      // The search opens on the card the strip was naming, and nothing is chosen.
      expect(within(dialog).getByRole("searchbox")).toHaveValue("Storm of Saruman");
      const printing = await within(dialog).findByRole("radio", {
        name: "Storm of Saruman — LTR 72",
      });
      expect(printing).toHaveAttribute("aria-checked", "false");
      expect(ipc.searchCards).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Storm of Saruman", collapse: false }),
      );
      expect(ipc.scannerSubmit).not.toHaveBeenCalled();

      await user.click(printing);
      await user.click(within(dialog).getByRole("radio", { name: "Foil" }));
      await user.click(within(dialog).getByRole("button", { name: "Send scan" }));

      await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
      // One argument, and everything in it.
      const call = vi.mocked(ipc.scannerSubmit).mock.calls[0];
      expect(call).toHaveLength(1);
      const [sent] = call;
      expect(sent).toMatchObject({
        cardId: "storm-of-saruman-ltr-72",
        finish: "foil",
        // What the scanner had said, read at the press: the fixture's decision, its tracker's
        // confidence, its best candidate's distance, and the filters it was under.
        reported: "storm-of-saruman-ltr-72",
        confidence: 1,
        distance: 11,
        filters: DEFAULT_SCANNER_PREFS.filters,
      });
      expect(Object.keys(sent).sort()).toEqual(
        ["cardId", "confidence", "distance", "filters", "finish", "reported", "run"].sort(),
      );

      // **The run is the frames the pump really sent**, in the order it sent them — each kept at
      // full resolution, out of the same draw of the video as the frame the scanner was given:
      // the pump's frame is each draw's first encode and the kept copy its second. Not a
      // picture taken for the purpose after the press.
      const pumped = vi
        .mocked(ipc.scannerFrame)
        .mock.calls.slice(0, 7)
        .map(([jpeg]) => btoa(String.fromCharCode(...jpeg)));
      expect(pumped).toEqual([1, 3, 5, 7, 9, 11, 13].map(text));
      expect(sent.run.map((frame) => frame.jpeg)).toEqual([2, 4, 6, 8, 10, 12, 14].map(text));
      // Each beside what the scanner answered for it.
      const settled = "storm-of-saruman-ltr-72";
      expect(sent.run.map((frame) => frame.decided)).toEqual([
        null,
        null,
        null,
        settled,
        settled,
        settled,
        settled,
      ]);
      expect(sent.run.map((frame) => frame.confidence)).toEqual([0.625, 0.625, 0.625, 1, 1, 1, 1]);
      expect(sent.run.every((frame) => frame.ok)).toBe(true);
      // Counted back from the press: oldest first, and none after it.
      const ms = sent.run.map((frame) => frame.ms);
      expect([...ms].sort((a, b) => a - b)).toEqual(ms);
      expect(new Set(ms).size).toBe(7);
      expect(ms.every((one) => Number.isInteger(one) && one <= 0)).toBe(true);
      // Nothing was written to the developer's dataset: that is another press.
      expect(ipc.scannerCapture).not.toHaveBeenCalled();

      expect(await within(dialog).findByText("Sent — thank you.")).toBeInTheDocument();
      expect(dialog).toHaveTextContent(`Reference: ${REFERENCE}`);
      await user.click(within(dialog).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(opener).toHaveFocus();
    } finally {
      plainFrames();
      restore();
    }
  });

  /**
   * **Recognition pauses behind the dialog** (issue #977) — a card left under the lens while the
   * reader picks a printing must not land in the tray — and resumes when it closes. The run in the
   * dialog is the one frozen at the press.
   */
  it("pauses reading behind the dialog, with the run as it was at the press, and resumes on close", async () => {
    const restore = shimVideo();
    const plainFrames = numberedCanvas();
    opens();
    // A recognizer that loaded, so the strip names the card the scanner is leaning towards.
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    paced();
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));
      // Enough of a scan to send: a few frames more than the fewest.
      await waitFor(() => expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(8));
      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      const dialog = await screen.findByRole("dialog", { name: "Send this scan" });
      const shown = picture(dialog);
      const address = shown.getAttribute("src");
      const count = within(dialog).getByRole("slider", { name: "Picture" }).getAttribute("max");
      expect(Number(count)).toBeGreaterThanOrEqual(5);
      expect(within(dialog).getByRole("searchbox")).toHaveValue("Plains");

      // No frame goes out behind it: at most the one already on the wire at the press.
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeLessThanOrEqual(sent + 1);
      const paused = vi.mocked(ipc.scannerFrame).mock.calls.length;
      // The same element, on the same picture, of the same number of pictures, with the same
      // word in the box.
      expect(picture(dialog)).toBe(shown);
      expect(shown).toHaveAttribute("src", address);
      expect(within(dialog).getByRole("slider", { name: "Picture" })).toHaveAttribute("max", count);
      expect(within(dialog).getByRole("searchbox")).toHaveValue("Plains");

      // Escape hands the caret back to the press, and the scanner reads again.
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("button", { name: "Send scan…" })).toHaveFocus();
      await waitFor(() =>
        expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(paused),
      );
    } finally {
      plainFrames();
      restore();
    }
  });

  /**
   * **No press while recognition is stopped.** A scan is the frames the scanner was given, and
   * stopped it is given none — the pump lets its run go at the Stop, since a run never spans one
   * — so there is nothing to send. Not a greyed button: the stopped sentence over the picture is
   * already saying what would bring the press back.
   */
  it("draws no press while recognition is stopped, and brings it back with the scanner", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    paced();
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));
      expect(screen.getByRole("button", { name: "Send scan…" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Stop scanning" }));
      await waitFor(() => expect(statusLine()).toHaveTextContent("Looking"));
      // The camera is still live and its picture still moving; the press is gone all the same.
      expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
      expect(screen.getByText(SCANNING_STOPPED)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Start scanning" }));
      expect(await screen.findByRole("button", { name: "Send scan…" })).toBeInTheDocument();
      expect(ipc.scannerSubmit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /**
   * **A press that opened nothing is never silent.** A scan is all of a run or none of it, so a
   * press before the scanner has been shown enough — here it has answered one frame — opens no
   * dialog and falls back to no single picture: it says what to do, over the camera, where a
   * refused reset is said.
   */
  it("says so when the press comes before there is enough of a scan, and opens nothing", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    // One frame answered, and the next parked: a run of one.
    frames(VERDICTS.voting);
    const user = userEvent.setup();
    try {
      const { container } = mount();
      await start();
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));
      expect(strip(container)).toHaveTextContent("");

      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      expect(strip(container)).toHaveTextContent(SCAN_TOO_SHORT);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(ipc.scannerSubmit).not.toHaveBeenCalled();
      expect(ipc.searchCards).not.toHaveBeenCalled();

      // Stopped, the press is gone and so is its sentence: *press again* with nothing to press
      // would be an instruction nobody can follow. The line is the stopped sentence's.
      await user.click(screen.getByRole("button", { name: "Stop scanning" }));
      expect(screen.queryByText(SCAN_TOO_SHORT)).toBeNull();
      expect(screen.getByText(SCANNING_STOPPED)).toBeInTheDocument();
      // …and it does not come back unasked when the scanner does.
      await user.click(screen.getByRole("button", { name: "Start scanning" }));
      await screen.findByRole("button", { name: "Send scan…" });
      expect(screen.queryByText(SCAN_TOO_SHORT)).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * With the Developer panels on, the line over the camera is the detector's own on every frame
   * with no card in it — and a press that opened nothing still has to be heard over that.
   */
  it("says a press came too soon over the detector's own sentence, with the Developer panels on", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ developer: true });
    frames(VERDICTS.noCard);
    const user = userEvent.setup();
    try {
      const { container } = mount();
      await start();
      await waitFor(() => expect(strip(container)).toHaveTextContent(VERDICTS.noCard.error ?? ""));

      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      expect(strip(container)).toHaveTextContent(SCAN_TOO_SHORT);
      expect(strip(container)).not.toHaveTextContent("no quadrilateral");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      restore();
    }
  });

  /** The Filters popover's release date, set as a reader sets it: sent to the session at once. */
  async function narrowTo(user: ReturnType<typeof userEvent.setup>, from: string) {
    await user.click(screen.getByRole("button", { name: "Filters: Any set" }));
    // `fireEvent`, as the bar's own suite does: a date field has no text for user-event to type.
    fireEvent.change(await screen.findByLabelText("Released from"), { target: { value: from } });
    // Drawn at once, whatever the session goes on to say of it.
    const drawn = await screen.findByRole("button", { name: new RegExp(`^Filters: .*${from}`) });
    await user.click(drawn);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull());
  }

  /**
   * **A scan says the filters its frames were judged under**: the ones the session last took
   * (`useScannerPrefs`' `inForce`), never the ones the bar is drawing. A filter is drawn the
   * moment the reader changes it and sent to the session, which has not answered yet — and may
   * refuse. Pressed in that moment, a scan labelled with what the bar shows would say its frames
   * were searched under filters the session had never held.
   */
  it("sends the filters the session has taken, not ones still on their way to it", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    // The popover's set picker asks for the set list as it mounts.
    vi.spyOn(ipc, "listSets").mockResolvedValue([]);
    // The mount's push is taken at once; the reader's is on its way for as long as the test runs.
    let pushes = 0;
    vi.mocked(ipc.scannerSetFilters).mockImplementation(() =>
      ++pushes === 1 ? Promise.resolve() : new Promise<void>(() => {}),
    );
    // The pump runs throughout, so whenever the press lands there is a run of fresh frames.
    paced();
    vi.mocked(ipc.searchCards).mockResolvedValue({
      items: [SARUMAN],
      total: 1,
      totalIsCapped: false,
    });
    vi.mocked(ipc.scannerSubmit).mockResolvedValue({ id: REFERENCE });
    const user = userEvent.setup();
    try {
      mount();
      await start();
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));
      await waitFor(() => expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(8));

      await narrowTo(user, "2020-01-01");
      const pending = {
        sets: [],
        released_from: "2020-01-01",
        released_to: null,
        exclude_promos: false,
      };
      expect(ipc.scannerSetFilters).toHaveBeenCalledTimes(2);
      expect(ipc.scannerSetFilters).toHaveBeenLastCalledWith(pending);

      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      const dialog = await screen.findByRole("dialog", { name: "Send this scan" });
      await user.click(
        await within(dialog).findByRole("radio", { name: "Storm of Saruman — LTR 72" }),
      );
      await user.click(within(dialog).getByRole("radio", { name: "Foil" }));
      await user.click(within(dialog).getByRole("button", { name: "Send scan" }));

      await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
      const [sent] = vi.mocked(ipc.scannerSubmit).mock.calls[0];
      // The bar says 2020; the session never has, and neither does the scan.
      expect(screen.getByRole("button", { name: /^Filters: .*2020-01-01/ })).toBeInTheDocument();
      expect(sent.filters).toEqual(DEFAULT_SCANNER_PREFS.filters);
      expect(sent.run.length).toBeGreaterThanOrEqual(5);
    } finally {
      restore();
    }
  });

  /**
   * **A run never spans a change of filters.** The session drops its tracker to take a changed
   * set, so every frame the pump was holding was judged under the old one: sent after the
   * change, they would go out under filters they were never searched with. The page lets the run
   * go when the filters in force move (`ScanLoop.breakRun`) — and nothing on screen with it,
   * since the session reset itself and no reader asked for anything to be forgotten.
   */
  it("starts the run over when the session takes changed filters, and leaves the screen alone", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    vi.spyOn(ipc, "listSets").mockResolvedValue([]);
    // Seven frames answered and the eighth parked: the run is those seven until it is let go,
    // and nothing sent afterwards can refill it.
    answers(...Array<ScannerVerdict>(7).fill(VERDICTS.voting));
    const user = userEvent.setup();
    try {
      const { container } = mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(8));
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));

      // The premise: as things stand there is a run to send, all seven frames of it.
      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      const dialog = await screen.findByRole("dialog", { name: "Send this scan" });
      expect(within(dialog).getByRole("slider", { name: "Picture" })).toHaveAttribute("max", "7");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      // The reader narrows the scan, and the session takes it — which is when it is stored.
      const resets = vi.mocked(ipc.scannerReset).mock.calls.length;
      await narrowTo(user, "2020-01-01");
      const taken = {
        sets: [],
        released_from: "2020-01-01",
        released_to: null,
        exclude_promos: false,
      };
      await waitFor(() =>
        expect(ipc.setScannerPrefs).toHaveBeenLastCalledWith(
          expect.objectContaining({ filters: taken }),
        ),
      );

      // Not one frame has been judged under the new filters, so there is nothing to send yet.
      await user.click(screen.getByRole("button", { name: "Send scan…" }));
      expect(strip(container)).toHaveTextContent(SCAN_TOO_SHORT);
      expect(screen.queryByRole("dialog", { name: "Send this scan" })).toBeNull();
      // The strip goes on naming the card: this was the run's break, not the evidence's.
      expect(statusLine()).toHaveTextContent("Plains");
      // No reset: the pump's starts reset the session, and a change of filters is none of them.
      expect(ipc.scannerReset).toHaveBeenCalledTimes(resets);
      expect(ipc.scannerSubmit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /**
   * **Only a supporter's device draws the press** (the owner's decision; `useMaySendScans`) —
   * and a device that is not one is told nothing: no greyed press, no sentence, no name for what
   * it lacks. The light app draws this page too, in the build Google Play distributes, which may
   * not lead a reader to a membership bought somewhere else.
   *
   * Every test below has everything else the press needs — a live camera, recognition running,
   * the scanner naming a card — so the membership is the one thing that differs between them.
   */
  describe("for a supporter and for nobody else", () => {
    /** Connected and paid up; `GRACE` is the same with a card Patreon is still retrying. */
    const ACTIVE: SupporterStatus = {
      entitled: true,
      status: "active",
      since: 1_756_000_000,
      groupBound: true,
    };
    const GRACE: SupporterStatus = { ...ACTIVE, status: "grace" };
    /** Out of the box, and a membership that ended — the same three fields, told apart by one. */
    const NEVER: SupporterStatus = {
      entitled: false,
      status: "dead",
      since: null,
      groupBound: false,
    };
    const ENDED: SupporterStatus = { ...NEVER, groupBound: true };

    /** The view with a camera open and the scanner naming a card, frames going by. */
    async function running() {
      opens();
      vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
      paced();
      const view = mount();
      await start();
      await waitFor(() => expect(statusLine()).toHaveTextContent("Plains"));
      return view;
    }

    /** `count` more frames answered — each a render of the page, so anything owed is drawn. */
    async function framesGoBy(count: number) {
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      await waitFor(() =>
        expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(sent + count),
      );
    }

    /** Everything the view says: its text, and every name or description an element carries. */
    function said(container: HTMLElement): string {
      const named = Array.from(container.querySelectorAll("*")).flatMap((element) =>
        ["aria-label", "aria-description", "title", "alt", "placeholder"].map(
          (attribute) => element.getAttribute(attribute) ?? "",
        ),
      );
      return [container.textContent ?? "", ...named].join("\n");
    }
    /** A word that would name what the device lacks, or point at getting it. */
    const NAMES_A_MEMBERSHIP = /patreon|supporter|membership|\bmembers?\b|pledge|subscri|payment/i;

    it.each<[string, SupporterStatus]>([
      ["active", ACTIVE],
      ["in its grace window", GRACE],
    ])("draws the press for a membership that is %s", async (_, status) => {
      const restore = shimVideo();
      vi.mocked(ipc.syncSupporterStatus).mockResolvedValue(status);
      try {
        await running();
        const press = await screen.findByRole("button", { name: "Send scan…" });
        expect(press).toBeEnabled();
        expect(ipc.syncSupporterStatus).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it.each<[string, SupporterStatus]>([
      ["has never been a supporter's", NEVER],
      ["was a supporter's and no longer is", ENDED],
    ])("draws no press, and not a word about it, on a device that %s", async (_, status) => {
      const restore = shimVideo();
      vi.mocked(ipc.syncSupporterStatus).mockResolvedValue(status);
      try {
        const { container } = await running();
        expect(ipc.syncSupporterStatus).toHaveBeenCalledTimes(1);
        // The answer has been in for several renders: this is not a press still on its way.
        await framesGoBy(6);
        expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
        // Not a greyed one either, under any name; the strip's other press is untouched.
        expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
        expect(screen.getByRole("button", { name: "Reset evidence" })).toBeEnabled();
        // …and nothing on the view names what is missing, in text or in a label.
        expect(said(container)).not.toMatch(NAMES_A_MEMBERSHIP);
        expect(strip(container)).toHaveTextContent("");
      } finally {
        restore();
      }
    });

    /**
     * `unknown` is the read in flight, and it draws nothing: a press drawn before the answer
     * would flash at the one reader the answer then takes it from.
     */
    it("draws no press while the membership is being read, and draws it when a supporter's answer lands", async () => {
      const restore = shimVideo();
      let answer!: (status: SupporterStatus) => void;
      vi.mocked(ipc.syncSupporterStatus).mockReturnValue(
        new Promise<SupporterStatus>((resolve) => (answer = resolve)),
      );
      try {
        const { container } = await running();
        expect(ipc.syncSupporterStatus).toHaveBeenCalledTimes(1);
        // Asked and unanswered, with the scanner well under way.
        await framesGoBy(6);
        expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
        expect(said(container)).not.toMatch(NAMES_A_MEMBERSHIP);

        await act(async () => answer(ACTIVE));
        expect(await screen.findByRole("button", { name: "Send scan…" })).toBeEnabled();
      } finally {
        restore();
      }
    });

    it("draws no press when that answer is that the device is not a supporter's", async () => {
      const restore = shimVideo();
      let answer!: (status: SupporterStatus) => void;
      vi.mocked(ipc.syncSupporterStatus).mockReturnValue(
        new Promise<SupporterStatus>((resolve) => (answer = resolve)),
      );
      try {
        await running();
        await act(async () => answer(NEVER));
        await framesGoBy(6);
        expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
      } finally {
        restore();
      }
    });

    /** A read that was refused is `unknown` too — a busy database is not a membership. */
    it("draws no press where the membership could not be read", async () => {
      const restore = shimVideo();
      vi.mocked(ipc.syncSupporterStatus).mockRejectedValue(
        "The card database is busy finishing a sync. Try that again in a moment.",
      );
      try {
        const { container } = await running();
        expect(ipc.syncSupporterStatus).toHaveBeenCalledTimes(1);
        await framesGoBy(6);
        expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
        // The refusal is not drawn anywhere either: it is not this view's to explain.
        expect(strip(container)).toHaveTextContent("");
      } finally {
        restore();
      }
    });
  });
});

/**
 * **A mounted view holds the scanner, whatever its camera is doing.** The lease used to be renewed
 * by frames alone, and a view whose camera was refused, failing or slow to start sent none — so it
 * lapsed in two seconds and a second window got through the gate with this one's tray still on
 * screen. Every test here uses the refused camera for exactly that reason: no frame is ever sent.
 */
describe("ScannerPage holding the scanner", () => {
  it("holds it from the first render and once a poll after, with no frame ever sent", async () => {
    refused();
    mount();
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalledTimes(2), {
      timeout: SCANNER_ELSEWHERE_POLL_MS * 2,
    });
    expect(ipc.scannerFrame).not.toHaveBeenCalled();
  });

  it("stops holding it once the view has gone", async () => {
    refused();
    const { unmount } = mount();
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalled());
    unmount();
    const held = vi.mocked(ipc.scannerHold).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, SCANNER_ELSEWHERE_POLL_MS * 1.5));
    expect(ipc.scannerHold).toHaveBeenCalledTimes(held);
  });

  /**
   * **Every refused beat asks the gate again, not only the first.** A re-ask that fired once per
   * run of refusals — the frame loop's, which keys on its error string not changing — could be
   * spent on an answer that was still "free" a moment before the other window took the lease, and
   * then never be asked again while the view went on being refused.
   */
  it("asks the gate again on every refused beat", async () => {
    refused();
    vi.mocked(ipc.scannerHold).mockRejectedValue(SCANNER_OPEN_ELSEWHERE);
    mount();
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalledTimes(2), {
      timeout: SCANNER_ELSEWHERE_POLL_MS * 2,
    });
    // The first ask, then one for each refused beat — the gate still says "free" here, so the
    // view stays, and each refusal has to be asked about on its own.
    await waitFor(() =>
      expect(vi.mocked(ipc.scannerElsewhere).mock.calls.length).toBeGreaterThanOrEqual(3),
    );
  });

  /** A refusal that is not the lease's is not a question for the gate. */
  it("does not ask the gate about a beat refused for another reason", async () => {
    refused();
    vi.mocked(ipc.scannerHold).mockRejectedValue("the scanner state is poisoned");
    mount();
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalledTimes(2), {
      timeout: SCANNER_ELSEWHERE_POLL_MS * 2,
    });
    expect(ipc.scannerElsewhere).toHaveBeenCalledTimes(1);
  });
});

/**
 * **A minimized window stands down** (issue #556). WebView2 reports a minimized page as visible,
 * so before this the camera light stayed on, the detector ran at 5–9 fps and the lease never
 * lapsed for as long as the window sat on the taskbar.
 */
describe("ScannerPage in a minimized window", () => {
  it("pauses the pump on the minimize, keeping the camera and the lease through the grace", async () => {
    const restore = shimVideo();
    const stop = vi.fn();
    mediaDevices(() => Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    paced();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      act(() => parkedStore.set({ paused: true, released: false }));
      // One frame may already have been on the wire; nothing goes out after it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      const held = vi.mocked(ipc.scannerHold).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, SCANNER_ELSEWHERE_POLL_MS * 1.2));
      expect(ipc.scannerFrame).toHaveBeenCalledTimes(sent);
      expect(stop).not.toHaveBeenCalled();
      expect(vi.mocked(ipc.scannerHold).mock.calls.length).toBeGreaterThan(held);
    } finally {
      restore();
    }
  });

  it("closes the camera and lets the lease go once released, and takes both back on restore", async () => {
    const restore = shimVideo();
    const stop = vi.fn();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    paced();
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalled());
      act(() => parkedStore.set({ paused: true, released: true }));
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      const held = vi.mocked(ipc.scannerHold).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, SCANNER_ELSEWHERE_POLL_MS * 1.5));
      expect(ipc.scannerHold).toHaveBeenCalledTimes(held);

      const sent = vi.mocked(ipc.scannerFrame).mock.calls.length;
      act(() => parkedStore.set({ paused: false, released: false }));
      // The restore beats at once, reopens the camera and starts the pump again.
      await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalledTimes(held + 1));
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(vi.mocked(ipc.scannerFrame).mock.calls.length).toBeGreaterThan(sent),
      );
    } finally {
      restore();
    }
  });
});

/**
 * **The desktop face in a browser**, until the light app's web step: the engine refuses the
 * session's commands in one sentence (`scanner::NOT_IN_A_BROWSER_YET`) and answers the lease, the
 * prefs and the tray. Before the page knew that sentence, a refused filter push counted as an
 * answer — the camera opened and every frame was sent to be refused.
 */
describe("ScannerPage on a host with no scanner session", () => {
  function noSession() {
    for (const command of [
      ipc.scannerStatus,
      ipc.scannerSetFilters,
      ipc.scannerReset,
      ipc.scannerCapture,
    ]) {
      vi.mocked(command).mockRejectedValue(SCANNER_NOT_IN_A_BROWSER_YET);
    }
    // **A few milliseconds late, never already settled** — `paced`'s reason, and here it is what
    // makes a regression a failure: were the pump to start, a frame refused on a settled promise
    // sends the next on microtasks alone, starves this file's timers, and the run hangs for as
    // long as it is left (seen: ten minutes and no result) instead of going red.
    vi.mocked(ipc.scannerFrame).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(SCANNER_NOT_IN_A_BROWSER_YET), 10)),
    );
  }

  it("says so where the picture would be, opens no camera and sends no frame", async () => {
    const restore = shimVideo();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    noSession();
    try {
      const { container } = mount();
      const said = await screen.findByText(SCANNER_NOT_IN_A_BROWSER_YET);
      expect(said).toHaveAttribute("role", "alert");
      expect(videoBox(container)).toContainElement(said);
      // Long enough for a pump to have gone round many times, had one started.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(ipc.scannerFrame).not.toHaveBeenCalled();
      // One push, refused, and never sent again.
      expect(ipc.scannerSetFilters).toHaveBeenCalledTimes(1);
      // No asset notes: a host with no session has no recogniser to say anything about.
      expect(screen.queryByText(/card recognizer did not load/)).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  /** The same host with its prefs read failing as well — once a way to "loaded" with nothing asked. */
  it("opens no camera and sends no frame when the prefs read fails too", async () => {
    const restore = shimVideo();
    const getUserMedia = vi.fn(() =>
      Promise.resolve({ getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream),
    );
    mediaDevices(getUserMedia);
    noSession();
    vi.mocked(ipc.scannerPrefs).mockRejectedValue("the prefs could not be read");
    try {
      mount();
      expect(await screen.findByText(SCANNER_NOT_IN_A_BROWSER_YET)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(ipc.scannerFrame).not.toHaveBeenCalled();
      expect(ipc.scannerSetFilters).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("still draws the stored tray, which is a row a page has too", async () => {
    refused();
    noSession();
    vi.mocked(ipc.scannerTray).mockResolvedValue(TRAY_ROWS);
    mount();
    expect(await screen.findByText(SCANNER_NOT_IN_A_BROWSER_YET)).toBeInTheDocument();
    expect(await within(tray()).findAllByText(TRAY_ROWS[0].name)).not.toHaveLength(0);
  });
});

describe("ScannerPage with another window holding the scanner", () => {
  it("says so, and asks for no camera, no prefs and no lease", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotAllowedError")));
    mediaDevices(getUserMedia);
    vi.mocked(ipc.scannerElsewhere).mockResolvedValueOnce(true);
    mount();
    expect(await screen.findByText(SCANNER_OPEN_ELSEWHERE)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(ipc.scannerPrefs).not.toHaveBeenCalled();
    expect(ipc.scannerHold).not.toHaveBeenCalled();
  });

  /**
   * **The gate's recovery poll** — asked each second while the answer is "elsewhere", so the view
   * opens on its own once the other window lets go, and only then starts holding the scanner.
   */
  it("opens the live view on its own once the other window lets go", async () => {
    refused();
    vi.mocked(ipc.scannerElsewhere).mockResolvedValueOnce(true);
    mount();
    expect(await screen.findByText(SCANNER_OPEN_ELSEWHERE)).toBeInTheDocument();
    expect(
      await screen.findByText(
        "MTG Grimoire needs camera access to scan a card.",
        {},
        { timeout: SCANNER_ELSEWHERE_POLL_MS * 2 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(SCANNER_OPEN_ELSEWHERE)).not.toBeInTheDocument();
    await waitFor(() => expect(ipc.scannerHold).toHaveBeenCalled());
  });

  /** The lease can change hands between the ask and the first session command. */
  it("asks again when a session command is refused as elsewhere", async () => {
    refused();
    vi.mocked(ipc.scannerSetFilters).mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE);
    mount();
    await waitFor(() => expect(ipc.scannerElsewhere).toHaveBeenCalledTimes(2));
  });

  /** The same, from the other half: the filters were taken and the first frame was not. */
  it("asks again when a frame is refused as elsewhere", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerFrame)
      .mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE)
      .mockImplementation(() => new Promise(() => {}));
    try {
      mount();
      await start();
      await waitFor(() => expect(ipc.scannerElsewhere).toHaveBeenCalledTimes(2));
    } finally {
      restore();
    }
  });

  /**
   * **A second visit asks afresh rather than opening on the first visit's answer.** Another window
   * can take the scanner while this one is on another view, and an answer still in the cache would
   * mount the camera before the refetch said so — one client across both visits, as in the app.
   */
  it("asks again on a second visit before it opens the camera", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const visit = () =>
      render(
        <QueryClientProvider client={qc}>
          <ScannerPage />
        </QueryClientProvider>,
      );
    refused();
    const first = visit();
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    first.unmount();
    // A view switch and back is never the same tick; one macrotask is the shortest there is.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotAllowedError")));
    mediaDevices(getUserMedia);
    vi.mocked(ipc.scannerElsewhere).mockResolvedValueOnce(true);
    visit();
    expect(await screen.findByText(SCANNER_OPEN_ELSEWHERE)).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

/**
 * **The same view, filing somewhere that is not the collection** — what the trade's scanner dialog
 * mounts. The hook's own suite (`useTrayDestination.test.ts`) holds the subtraction's cases and
 * the dialog's holds the trade's write; this is the page between them.
 */
describe("ScannerPage with a destination", () => {
  /** A destination whose write the test settles itself. */
  function destinationOf() {
    const settle: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
    const commit = vi.fn<TrayDestination["commit"]>(
      () => new Promise<void>((resolve, reject) => settle.push({ resolve, reject })),
    );
    const onCommitted = vi.fn();
    const destination: TrayDestination = {
      title: "Scanned for their side",
      name: "their side",
      commit,
      onCommitted,
    };
    return { destination, commit, onCommitted, settle };
  }

  function mountOver(destination: TrayDestination) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ScannerPage destination={destination} />
      </QueryClientProvider>,
    );
  }

  const theirTray = () => screen.getByRole("region", { name: "Scanned for their side" });

  it("hands the ready rows to the destination on its own press, then takes exactly those out, keeping a card scanned meanwhile", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    const rows = TRAY_ROWS.slice(1); // 3 + 1 + 1 copies
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    let land!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockResolvedValueOnce(VERDICTS.voting)
      .mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    const { destination, commit, onCommitted, settle } = destinationOf();
    const user = userEvent.setup();
    try {
      mountOver(destination);
      await start();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      // A live camera, a running scanner and a supporter's device (the file's default answer,
      // asked and in) — where the Scanner view draws *Send scan…*. Over a trade it is not
      // offered, to a supporter or to anyone: this page is already inside a dialog, and that
      // press opens one.
      expect(await screen.findByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
      expect(ipc.syncSupporterStatus).toHaveBeenCalled();
      await expect(vi.mocked(ipc.syncSupporterStatus).mock.results[0].value).resolves.toMatchObject(
        {
          entitled: true,
          status: "active",
        },
      );
      expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
      await user.click(
        await within(theirTray()).findByRole("button", { name: "Add 5 to their side" }),
      );
      await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
      expect(commit.mock.calls[0][0]).toEqual(rows);
      // The collection's commit is not this press's, in either spelling.
      expect(ipc.scannerTrayCommit).not.toHaveBeenCalled();
      expect(ipc.collectionImportCommit).not.toHaveBeenCalled();
      // The destination first: every row is still in the tray while its write is out.
      expect(within(theirTray()).getAllByRole("listitem")).toHaveLength(rows.length);

      land(VERDICTS.decided);
      await waitFor(() =>
        expect(within(theirTray()).getAllByRole("listitem")).toHaveLength(rows.length + 1),
      );
      settle[0].resolve();

      await waitFor(() => expect(within(theirTray()).getAllByRole("listitem")).toHaveLength(1));
      expect(within(theirTray()).getByText("Storm of Saruman")).toBeInTheDocument();
      expect(onCommitted).toHaveBeenCalledWith(1);
      // What is stored is the tray without the rows that went — the card the press never saw.
      await waitFor(
        () =>
          expect(vi.mocked(ipc.setScannerTray).mock.lastCall?.[0]).toEqual([
            expect.objectContaining({ cardId: "storm-of-saruman-ltr-72" }),
          ]),
        { timeout: 2000 },
      );
    } finally {
      restore();
    }
  });

  it("leaves the row that needs a finish, and says how many on the press", async () => {
    refused();
    const known = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue([NEEDS_A_FINISH_ROW, ...known]);
    const { destination, commit, settle } = destinationOf();
    const user = userEvent.setup();
    mountOver(destination);
    await user.click(
      await screen.findByRole("button", { name: "Add 5 to their side · 1 needs a finish" }),
    );
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commit.mock.calls[0][0]).toEqual(known);
    settle[0].resolve();
    await waitFor(() => expect(within(theirTray()).getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => expect(ipc.setScannerTray).toHaveBeenLastCalledWith([NEEDS_A_FINISH_ROW]), {
      timeout: 2000,
    });
  });

  it("keeps every row and shows the sentence when the destination refuses", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    const { destination, commit, onCommitted, settle } = destinationOf();
    const user = userEvent.setup();
    mountOver(destination);
    const add = await screen.findByRole("button", { name: "Add 5 to their side" });
    await user.click(add);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(add).toHaveAttribute("aria-busy", "true");
    settle[0].reject("This trade is finished. Reopen it to change it.");

    expect(await within(theirTray()).findByRole("alert")).toHaveTextContent(
      "This trade is finished. Reopen it to change it.",
    );
    expect(within(theirTray()).getAllByRole("listitem")).toHaveLength(rows.length);
    expect(add).not.toHaveAttribute("aria-busy");
    expect(onCommitted).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ipc.setScannerTray).not.toHaveBeenCalled();
  });

  it("draws no folder, no deck press and no Developer switch — and none of the developer panels a stored switch would bring", async () => {
    refused();
    storedPrefs({ developer: true });
    vi.mocked(ipc.scannerTray).mockResolvedValue(TRAY_ROWS.slice(1));
    const { destination } = destinationOf();
    mountOver(destination);
    await within(await screen.findByRole("region", { name: "Scanned for their side" })).findByText(
      "Urza's Saga",
    );
    expect(screen.queryByRole("button", { name: /^Folder:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create deck…" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Developer" })).toBeNull();
    // The scan history is the Scanner view's own: no way into it, and no way to add to it.
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Match" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Frame budget" })).toBeNull();
    // The rest of the bar is the scanner's own.
    expect(screen.getByRole("button", { name: "Filters: Any set" })).toBeInTheDocument();
  });

  it("says what the tray already held, and words the clear for the destination", async () => {
    refused();
    vi.mocked(ipc.scannerTray).mockResolvedValue(TRAY_ROWS.slice(1));
    const { destination } = destinationOf();
    const user = userEvent.setup();
    mountOver(destination);
    const region = await screen.findByRole("region", { name: "Scanned for their side" });
    expect(await within(region).findByRole("note")).toHaveTextContent(
      /^5 cards were already in the scanner's tray\./,
    );
    await user.click(within(region).getByRole("button", { name: "Clear all…" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear the tray" });
    expect(dialog).toHaveTextContent(
      "5 scanned copies will leave the tray without being added to their side.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Clear tray" }));
    // The rows it warned about have gone, and the warning with them.
    await waitFor(() => expect(within(region).queryByRole("note")).toBeNull());
    expect(within(region).getByText("Cards you scan appear here.")).toBeInTheDocument();
  });
});
