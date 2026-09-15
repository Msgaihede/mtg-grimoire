import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionFolder, ScannerPrefs, ScannerVerdict } from "@/lib/ipc";
import { WEB_SENTENCE } from "./verdictText";
import { DEFAULT_SCANNER_PREFS, STATUS, TRAY_ROWS, VERDICTS } from "./fixtures";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  const { DEFAULT_SCANNER_PREFS: prefs } = await import("./fixtures");
  return {
    ...real,
    ipc: {
      ...real.ipc,
      scannerStatus: vi.fn(async () => STATUS.missing),
      scannerFrame: vi.fn(),
      // `async` rather than a bare `vi.fn()`: the real command answers a promise and the page
      // now attaches a rejection handler to it, so a mock returning `undefined` is a shape the
      // app cannot produce — and one that would make every test here fail for the wrong reason.
      scannerReset: vi.fn(async () => {}),
      scannerCapture: vi.fn(async () => ({ saved: "live-7.jpg" })),
      // The four the reader's half reads and writes. The pump waits for the first two to have
      // answered — prefs loaded and their filters pushed — so each is a resolved promise by default.
      scannerPrefs: vi.fn(async () => prefs),
      setScannerPrefs: vi.fn(async () => {}),
      scannerSetFilters: vi.fn(async () => {}),
      scannerTray: vi.fn(async () => []),
      setScannerTray: vi.fn(async () => {}),
      scannerTrayCommit: vi.fn(async () => ({ added: 1, updated: 0, removed: 0 })),
      // Mocked so a regression back to it answers rather than reaching the real core — and so the
      // commit tests can say it is never called.
      collectionImportCommit: vi.fn(async () => ({ added: 1, updated: 0, removed: 0 })),
      collectionFolderList: vi.fn(async () => []),
    },
  };
});
import { isWebTarget } from "@/pwa/target";
import { ipc } from "@/lib/ipc";
import { importItems } from "./reader/tray";
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

/** The video box — the one the two layout arms size differently. */
function videoBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector("video")?.parentElement;
  if (!box) throw new Error("no video box");
  return box;
}

/** The layout row: the camera's column and the tray's, side by side or stacked. */
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

/** The reader's one line under the camera. */
function statusLine(): HTMLElement {
  return screen.getByRole("status", { name: "Scanner status" });
}

function tray(): HTMLElement {
  return screen.getByRole("region", { name: "Scanned cards" });
}

const BINDER: CollectionFolder = {
  id: 7,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: "f7",
};
const DECK_GROUP: CollectionFolder = { ...BINDER, id: 9, name: "Burn", kind: "deck", deckId: 4, syncUid: "f9" };

const COMMANDS = [
  ipc.scannerStatus,
  ipc.scannerFrame,
  ipc.scannerReset,
  ipc.scannerCapture,
  ipc.scannerPrefs,
  ipc.setScannerPrefs,
  ipc.scannerSetFilters,
  ipc.scannerTray,
  ipc.setScannerTray,
  ipc.scannerTrayCommit,
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

  it("shows the refused camera's sentence in place of the video, and the missing bundle under it", async () => {
    refused();
    mount();
    expect(
      await screen.findByText("MTG Grimoire needs camera access to scan a card."),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
    // The reader's view: the tray beside the camera, and no developer panel until asked for.
    expect(tray()).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();
  });

  it("says nothing about assets a release build carries inside itself", async () => {
    refused();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.embedded);
    mount();
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    await waitFor(() => expect(ipc.scannerStatus).toHaveBeenCalled());
    expect(screen.queryByText(/No reference bundle/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No OCR models/)).not.toBeInTheDocument();
  });

  it("has an sr-only heading, because the ribbon carries the visible title", () => {
    refused();
    mount();
    expect(screen.getByRole("heading", { level: 2, name: "Scanner" })).toHaveClass("sr-only");
  });

  it("reserves the detector's strip whether or not there is a sentence in it", async () => {
    refused();
    const { container } = mount();
    expect(strip(container)).toHaveTextContent("");
    // Two lines of room, kept whether the strip is empty or full, so the video box above it
    // does not change height the moment the detector has something to say.
    expect(strip(container)).toHaveClass("min-h-[2.5em]");
    await screen.findByText("MTG Grimoire needs camera access to scan a card.");
    expect(strip(container)).toHaveTextContent("");
  });

  it("names what the scanner is doing in one line under the camera", async () => {
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
      await waitFor(() => expect(strip(container)).toHaveTextContent(VERDICTS.noCard.error ?? ""));
    } finally {
      restore();
    }
  });

  it("stacks the camera above the tray on a phone and puts it beside the camera otherwise", () => {
    refused();
    windowIsNarrow(true);
    const narrow = mount();
    expect(row(narrow.container)).toHaveClass("flex-col");
    // The video box is sized by its own aspect ratio here rather than by what is left over. A
    // zero-basis `flex-1` under this scrolling column yields its free space to the `shrink-0`
    // tray beside it, so `flex-1` on a phone is a camera that collapses to nothing the moment
    // the tray grows — which is why the class must be absent and not merely outranked.
    expect(videoBox(narrow.container)).toHaveClass("shrink-0");
    expect(videoBox(narrow.container).classList.contains("flex-1")).toBe(false);
    expect(videoBox(narrow.container).style.aspectRatio).not.toBe("");
    narrow.unmount();

    windowIsNarrow(false);
    const wide = mount();
    expect(row(wide.container).classList.contains("flex-col")).toBe(false);
    expect(videoBox(wide.container)).toHaveClass("flex-1");
    expect(videoBox(wide.container).classList.contains("shrink-0")).toBe(false);
    expect(videoBox(wide.container).style.aspectRatio).toBe("");
  });

  it("gives the phone's video box the camera's own shape once the stream reports one", async () => {
    const restore = shimVideo();
    opens();
    windowIsNarrow(true);
    vi.mocked(ipc.scannerFrame).mockReturnValue(new Promise(() => {}));
    try {
      const { container } = mount();
      // 4:3 is the placeholder a starting or refused camera gets; 1280×720 is `shimVideo`'s.
      await waitFor(() => expect(videoBox(container).style.aspectRatio).toBe("1280 / 720"));
    } finally {
      restore();
    }
  });

  it("shows the Match panel behind the Developer switch, and hides it again", async () => {
    refused();
    const user = userEvent.setup();
    mount();
    const toggle = await screen.findByRole("switch", { name: "Developer" });
    expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(await screen.findByRole("region", { name: "Match" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tiers" })).toBeInTheDocument();
    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_PREFS, developer: true }),
    );

    await user.click(screen.getByRole("switch", { name: "Developer" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Match" })).not.toBeInTheDocument(),
    );
  });

  it("hands the reset press straight to the command", async () => {
    refused();
    storedPrefs({ developer: true });
    mount();
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
    storedPrefs({ developer: true });
    vi.mocked(ipc.scannerReset).mockRejectedValueOnce("the scanner state is poisoned");
    const { container } = mount();
    await userEvent.click(await screen.findByRole("button", { name: "Reset evidence" }));
    await waitFor(() => expect(strip(container)).toHaveTextContent("the scanner state is poisoned"));
  });

  it("files a capture under the five fields the sidecar has, read off the last verdict", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ developer: true });
    // A bundle that loaded, so the panel names the card rather than standing the placement
    // sentence where the name would be.
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    frames(VERDICTS.decided);
    try {
      mount();
      // The Match panel's head row, which is the tell that the verdict has landed.
      const match = await screen.findByRole("region", { name: "Match" });
      expect(await within(match).findByText("Storm of Saruman — LTR 72")).toBeInTheDocument();
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

  /**
   * **One row per `decision_seq`, and the number is the whole of the rule.** The decided card
   * rides every committed frame after the one that decided it, so a page that added on the
   * *decision* rather than on the number moving would fill the tray with one card nine times a
   * second.
   */
  it("adds a tray row when decision_seq moves, and not again for the same seq", async () => {
    const restore = shimVideo();
    opens();
    vi.mocked(ipc.scannerStatus).mockResolvedValue(STATUS.present);
    frames(VERDICTS.voting, VERDICTS.decided, VERDICTS.decided, VERDICTS.decided);
    try {
      mount();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(5));
      const rows = within(tray()).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByText("Storm of Saruman")).toBeInTheDocument();
      expect(within(tray()).getByRole("button", { name: "Add 1 to collection" })).toBeInTheDocument();
      expect(statusLine()).toHaveTextContent("Added Storm of Saruman — LTR 72");
      // …and the store gets the tray once the quiet window has passed.
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written).toHaveLength(1);
      expect(written?.[0]).toMatchObject({ cardId: "storm-of-saruman-ltr-72", quantity: 1, finish: "nonfoil" });
    } finally {
      restore();
    }
  });

  /** A new row is born in the Defaults popover's finish — the prefs', not a literal. */
  it("stamps a new row with the prefs' finish", async () => {
    const restore = shimVideo();
    opens();
    storedPrefs({ finish: "foil" });
    frames(VERDICTS.voting, VERDICTS.decided);
    try {
      mount();
      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(1));
      await waitFor(() => expect(ipc.setScannerTray).toHaveBeenCalled(), { timeout: 2000 });
      const [written] = vi.mocked(ipc.setScannerTray).mock.lastCall ?? [];
      expect(written?.[0]?.finish).toBe("foil");
    } finally {
      restore();
    }
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

    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(ipc.scannerTrayCommit).toHaveBeenCalledWith(importItems(rows, "LP"), BINDER.id, []);
    expect(ipc.collectionImportCommit).not.toHaveBeenCalled();
    expect(await within(tray()).findByText("Cards you scan appear here.")).toBeInTheDocument();
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
      () => new Promise((resolve) => (answer = () => resolve({ added: 3, updated: 0, removed: 0 }))),
    );
    const user = userEvent.setup();
    try {
      mount();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
      await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
      // What it stores is the tray without the rows it files — none left, at the moment it went out.
      expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[2]).toEqual([]);

      land(VERDICTS.decided);
      await waitFor(() => expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length + 1));
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
        label: { name: saga.name, set: saga.setCode, number: saga.collectorNumber, lang: "en", released: "2021-06-18" },
        outcome: "resolved",
        choices: [],
        replaces_previous: false,
      },
    };
    let land!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockResolvedValueOnce(VERDICTS.voting)
      .mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    let answer!: () => void;
    vi.mocked(ipc.scannerTrayCommit).mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ added: 1, updated: 0, removed: 0 }))),
    );
    const user = userEvent.setup();
    try {
      mount();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      await user.click(await within(tray()).findByRole("button", { name: "Add 3 to collection" }));
      await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
      expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[0]).toEqual([
        { cardId: saga.cardId, quantity: 3, finish: "nonfoil", condition: "NONE" },
      ]);

      land(sagaAgain);
      // A bump, not a second row: one line, four copies, the same key.
      await waitFor(() =>
        expect(within(tray()).getByRole("button", { name: "Add 4 to collection" })).toBeInTheDocument(),
      );
      expect(within(tray()).getAllByRole("listitem")).toHaveLength(1);
      answer();

      await waitFor(() =>
        expect(within(tray()).getByRole("button", { name: "Add 1 to collection" })).toBeInTheDocument(),
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

    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    expect(
      await within(tray()).findByText("no card with the id `x` is in the card database"),
    ).toBeInTheDocument();
    expect(within(tray()).getAllByRole("listitem")).toHaveLength(rows.length);
    expect(ipc.setScannerTray).not.toHaveBeenCalledWith([]);
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
  it("files into the root, and stores the root, when the stored folder is not a user folder", async () => {
    refused();
    const rows = TRAY_ROWS.slice(1);
    vi.mocked(ipc.scannerTray).mockResolvedValue(rows);
    vi.mocked(ipc.collectionFolderList).mockResolvedValue([BINDER, DECK_GROUP]);
    storedPrefs({ folderId: DECK_GROUP.id });
    const user = userEvent.setup();
    mount();

    await waitFor(() =>
      expect(ipc.setScannerPrefs).toHaveBeenCalledWith({ ...DEFAULT_SCANNER_PREFS, folderId: null }),
    );
    await user.click(await within(tray()).findByRole("button", { name: "Add 5 to collection" }));
    await waitFor(() => expect(ipc.scannerTrayCommit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.scannerTrayCommit).mock.calls[0]?.[1]).toBeNull();
  });

  it("sends mode: exact on the next frame once Exact is pressed", async () => {
    const restore = shimVideo();
    opens();
    let answer!: (v: ScannerVerdict) => void;
    vi.mocked(ipc.scannerFrame)
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    try {
      mount();
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(1));
      expect(vi.mocked(ipc.scannerFrame).mock.calls[0]?.[1].mode).toBe("fast");

      const exact = screen.getByRole("button", { name: "Exact" });
      await user.click(exact);
      await waitFor(() => expect(exact).toHaveAttribute("aria-pressed", "true"));
      answer(VERDICTS.voting);
      await waitFor(() => expect(ipc.scannerFrame).toHaveBeenCalledTimes(2));
      expect(vi.mocked(ipc.scannerFrame).mock.calls[1]?.[1].mode).toBe("exact");
    } finally {
      restore();
    }
  });
});
