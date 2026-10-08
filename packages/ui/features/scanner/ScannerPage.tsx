import { useMemo, useRef, useState, type JSX } from "react";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { CreateDeckDialog } from "@/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@/features/decks/useNewDeckFormat";
import { plural } from "@/lib/counts";
import { ipc, ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { Overlay } from "./Overlay";
import { TiersPanel } from "./panels/TiersPanel";
import { AddedToast } from "./reader/AddedToast";
import { MatchStrip } from "./reader/MatchStrip";
import { SCANNING_STOPPED } from "./reader/readerText";
import { ScanBar } from "./reader/ScanBar";
import { setPrinting, totalCopies, trayLayoutOf } from "./reader/tray";
import { withoutCommitted } from "./reader/trayCommit";
import { TrayPanel } from "./reader/TrayPanel";
import { ScannerAssets } from "./ScannerAssets";
import { ScannerPanels } from "./ScannerPanels";
import {
  DEFAULT_DETAIL_WAIT_MS,
  DEFAULT_SCANNER_OPTIONS,
  DEFAULT_SEND_PX,
  frameOptions as frameOptionsOf,
} from "./scannerOptions";
import type { ScannerOptions, ScannerTrayRow } from "./types";
import { useCamera, useCameraDevices } from "./useCamera";
import { useScanLoop } from "./useScanLoop";
import { useScannerElsewhere } from "./useScannerElsewhere";
import { useRefusedElsewhere, useScannerHold } from "./useScannerHold";
import { useScannerPrefs } from "./useScannerPrefs";
import { useScannerStatus } from "./useScannerStatus";
import { useTray } from "./useTray";
import { useTrayCommit, useTrayFolder } from "./useTrayCommit";
import { useTrayLanding } from "./useTrayLanding";
import { useScannedDeck } from "./useScannedDeck";
import { useWindowParked } from "./useWindowParked";
import { SCANNER_OPEN_ELSEWHERE, SCANNER_OPENS_HERE_LATER } from "./verdictText";

// What used to stand here — the flash's hold, the filters' refusal, `isUserFolder` and
// `withoutCommitted` — moved out with the logic that used it, so the light app's phone page files
// its cards by the same rules: `useTrayLanding.ts`, `useScannerStatus.ts`, `reader/trayCommit.ts`.

/**
 * The Scanner view: the reader's bar across the top, the camera and one line saying what it is
 * doing, and the review tray beside it — with today's developer panels one switch away.
 *
 * **Gated above the live view.** One window scans at a time (spec §5.3): the scanner is a lease
 * the window using it keeps renewing, and whether another holds it has to be answered *before* the
 * camera is asked for — the live view's own hooks open it as they mount. So this component asks
 * that one question with one query, and `LiveScanner` mounts only once the answer is "free", so a
 * second window never opens a camera only to be refused. A failed ask is treated as "free" — the
 * live view's heartbeat is the real gate and asks again the moment it is refused.
 *
 * **The camera and the panels are two halves on purpose.** `useCamera` and `useScanLoop` own
 * the stream and the pump; `ScanBar`, `TrayPanel` and `ScannerPanels` are pure and take what
 * they draw as props, so each is tested from fixtures and storied without a camera, and a change
 * to a panel never touches the loop.
 */
export function ScannerPage(): JSX.Element {
  const elsewhere = useScannerElsewhere();
  if (elsewhere.data === true) return <ElsewhereSentence />;
  if (elsewhere.isPending) {
    return (
      <section className="flex h-full flex-col gap-3">
        <h2 className="sr-only">Scanner</h2>
      </section>
    );
  }
  return <LiveScanner />;
}

function ElsewhereSentence() {
  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <p>{SCANNER_OPEN_ELSEWHERE}</p>
      <p className="text-dim">{SCANNER_OPENS_HERE_LATER}</p>
    </section>
  );
}

function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { prefs, update, filterError, loaded, unavailable, resync } = useScannerPrefs();
  // Session-only: a deliberate Stop survives minimize/restore, but a new visit starts as before.
  const [scanning, setScanning] = useState(true);
  // **A minimized window stands down** (issue #556): the pump pauses at once, and the camera and
  // the heartbeat go after a grace, so the light goes out and the lease lapses for another window.
  // WebView2 reports a minimized page as visible, so the page could not see this on its own.
  const parked = useWindowParked();
  // **`undefined` until the prefs are in, which holds the camera shut.** The stored choice is one
  // of them, and opening the default on mount only to reopen the stored camera a moment later is
  // two `getUserMedia` calls, a flicker, and on some platforms a second permission prompt. A
  // released window is `undefined` too — its tracks are stopped, and a restore asks again.
  const camera = useCamera(videoRef, loaded && !parked.released ? prefs.cameraId : undefined);
  // Keyed on the camera that opened, because a browser names no camera until one has been
  // granted: the list read before that is `Camera 1`, `Camera 2`, and the one read after it has
  // the real names.
  const cameras = useCameraDevices(camera.kind === "live" ? camera.deviceId : null);
  const tray = useTray();
  const [deckRows, setDeckRows] = useState<ScannerTrayRow[] | null>(null);
  const deckOpener = useRef<HTMLElement | null>(null);
  const scannedDeck = useScannedDeck(deckRows ?? []);
  const newDeckFormat = useNewDeckFormat();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  // The developer sliders. `mode` rides the same header but is the reader's, so it is taken from
  // the prefs on the way out rather than from here.
  const [options, setOptions] = useState<ScannerOptions>(DEFAULT_SCANNER_OPTIONS);
  const [sendPx, setSendPx] = useState(DEFAULT_SEND_PX);
  const [detailWaitMs, setDetailWaitMs] = useState(DEFAULT_DETAIL_WAIT_MS);
  // `previews` is the Developer switch's too: the rectified preview and its hash cost a JPEG
  // encode a frame, and nothing but the developer panels draws them.
  const frameOptions = useMemo(
    () => frameOptionsOf(options, prefs.mode, prefs.developer),
    [options, prefs.mode, prefs.developer],
  );
  // Asked once a session, and again when a download of the scanner's files lands —
  // `useScannerStatus` says why nothing else asks, and `ScannerAssets`, below, is that download.
  const { status: statusData, hasBundle, filtersDisabled } = useScannerStatus();

  // **The heartbeat: this view holds the scanner from its first render, whatever its camera is
  // doing** — `useScannerHold`, stopped while the window is released (minimized past the grace).
  useScannerHold(parked.released);

  /**
   * Every tray write goes through here, and every writer builds on `tray.latest()` rather than
   * `tray.rows`: a decision from the pump, a printing handed back by the all-printings dialog, an
   * edit in the tray panel and a commit's answer can each land after more cards were scanned than
   * the render that built its closure knew about. `latest()` is the cache, written synchronously
   * by the write before it, so two writers in one tick cannot each start from the rows before the
   * other.
   */
  const writeRows = (rows: ScannerTrayRow[]) => tray.setRows(rows);

  // One card, into the tray — once per `decision_seq`, built on `tray.latest()`, in the finish
  // the Defaults popover holds as the card lands (`useTrayLanding`).
  const { onDecision, lastAdded, landed, clearLanded, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
  );

  const loop = useScanLoop({
    videoRef,
    // **Held until the prefs and the tray are in.** The first frame must go out in the stored
    // mode and under the stored filters, and a decision must land on the stored tray rather than
    // on an empty one the load then overwrites. And paused the moment the window is minimized.
    live: scanning && camera.kind === "live" && loaded && tray.loaded && !parked.paused,
    options: frameOptions,
    sendPx,
    detailWaitMs,
    onDecision,
  });

  // **A refused frame is the lease saying another window has the scanner** — asking the gate again
  // flips it to the sentence, which unmounts this view and stops the camera.
  useRefusedElsewhere(loop.error);

  // **A folder that is gone, or that is not the reader's own, is the root** — `useTrayFolder`.
  const { folderId, folderList } = useTrayFolder(prefs.folderId, loaded, update);

  /**
   * A refusal to reset has somewhere to go, which `void ipc.scannerReset()` did not give it.
   *
   * The command can fail — a poisoned mutex, a scanner thread that did not come back — and a
   * discarded rejection is a press that visibly did nothing and said nothing. It goes in the
   * strip under the video, behind the detector's own sentence: the same failure that stops a
   * reset stops every frame, and the frame's line names it better. Cleared on the next press
   * rather than on a timer, so a reader who tries again sees the second answer, not the first.
   */
  const [resetError, setResetError] = useState<string | null>(null);

  const onReset = () => {
    setResetError(null);
    // The pump clears locally first, then drains the old frame before resetting the crate.
    // Calling the command directly can let an outstanding frame restore discarded evidence.
    loop.reset().catch((e: unknown) => setResetError(ipcError(e)));
  };

  /**
   * This frame into the dataset, under the name a person read off the cardboard.
   *
   * `Infinity` is the long edge, so the file is the sensor's own resolution rather than the
   * downscale the pump sends — the point of a capture is to keep a frame the detector got
   * wrong at the size a later re-run would want it. The four figures beside `expected` are
   * what the tracker had to say at the moment of the press, each stringified here because
   * `ScannerSidecar` is a note for a person and an absent figure there is `""`.
   */
  const onCapture = async (expected: string) => {
    const bytes = await loop.grab(Infinity, 0.92);
    if (bytes === null) throw new Error("no video yet");
    const tracked = loop.verdict?.tracked ?? null;
    const lead = tracked?.standings[0];
    const saved = await ipc.scannerCapture(bytes, {
      expected,
      reported: lead?.label?.name ?? "",
      confidence: tracked ? tracked.confidence.toFixed(3) : "",
      votes: lead ? lead.evidence.toFixed(2) : "",
      distance: loop.verdict?.match?.candidates[0]?.distance.toString() ?? "",
    });
    return saved.saved;
  };

  // The tray into the collection, in one `scanner_tray_commit` — all or nothing, the rows with a
  // known finish, the folder asked about again at the press (`useTrayCommit`).
  const {
    commit,
    committing,
    error: commitError,
  } = useTrayCommit({
    tray,
    condition: prefs.condition,
    folderId: prefs.folderId,
    folderList,
  });
  const onCommit = () => void commit();

  /**
   * *Clear all…*: the rows the reader was asked about, while the question is up, and the button
   * that asked, for the caret.
   *
   * **The snapshot, not "whatever is in the tray when Confirm is pressed".** The camera keeps
   * running behind the dialog, and a card that lands while it is open is one the sentence never
   * counted — so the clear is {@link withoutCommitted} against what was asked about, the commit's
   * own subtraction: a new row stays, a bumped one keeps the copies added since, and the rest go.
   * Nothing is written to the collection, so there is no command here — the emptied tray is stored
   * by the same debounced write as every other edit.
   */
  const [clearing, setClearing] = useState<ScannerTrayRow[] | null>(null);
  const clearOpener = useRef<HTMLElement | null>(null);
  const onClearAll = (opener: HTMLElement) => {
    clearOpener.current = opener;
    setClearing(tray.latest());
  };
  const clearCopies = clearing === null ? 0 : totalCopies(clearing);

  /**
   * *More printings…*: the app's all-printings wall, asked to hand the pressed printing back.
   *
   * The hand-back reads `tray.latest()` rather than the rows this press saw, because the camera
   * keeps running while the dialog is open and a card scanned meanwhile must not be written away by
   * it.
   */
  const onMorePrintings = (row: ScannerTrayRow) => {
    if (row.oracleId === null) return;
    openAllPrintings({
      cardId: row.cardId,
      oracleId: row.oracleId,
      name: row.name,
      deck: null,
      wish: null,
      pick: (p) => writeRows(setPrinting(tray.latest(), row.key, p)),
    });
  };

  // The detector's own refusal is a developer's sentence — contours examined, a quad rejected —
  // and the reader has the status line for what it means to them. The loop's failures and a
  // refused reset are not the detector's, and every reader gets those.
  const detectorSentence =
    prefs.developer && loop.verdict?.ok === false
      ? (loop.verdict.error ?? "")
      : (loop.error ?? resetError ?? "");

  return (
    // **`@container/scan` because the split answers this view's own width, never the window's** —
    // there is no viewport branch in this app. Below 88rem the tray is a 400px column and the
    // developer panels stack under it in one scroller; from 88rem the camera takes two thirds of
    // what the developer column leaves, the tray the other third, and the panels get a column of
    // their own. A container is the containing block for anything `fixed` inside it, so nothing
    // that must cover the window may mount in here — and nothing does: the dropdowns measure the
    // block they land in, the all-printings dialog is drawn at the app root, and the tray's
    // *Clear all…* question is this fragment's second child, a sibling of the box and not inside it.
    <>
      <section className="@container/scan flex h-full flex-col gap-3">
        {/* Not shown: the ribbon already says `Scanner`, and every pixel of this view's height is
            the camera's. It is here to name the view for assistive tech, as the other views' do. */}
        <h2 className="sr-only">Scanner</h2>

        <ScanBar
          scanning={scanning}
          onScanning={setScanning}
          mode={prefs.mode}
          onMode={(mode) => update({ mode })}
          filters={prefs.filters}
          onFilters={(filters) => update({ filters })}
          filterError={filterError}
          // A host with no session has nothing to narrow, and a filter changed there would be
          // drawn, never taken and never stored.
          filtersDisabled={unavailable ?? filtersDisabled}
          finish={prefs.finish}
          onFinish={(finish) => update({ finish })}
          condition={prefs.condition}
          onCondition={(condition) => update({ condition })}
          developer={prefs.developer}
          onDeveloper={(developer) => update({ developer })}
          cameras={cameras}
          // The camera that opened; while a switch is starting, the one asked for — so the trigger
          // does not read `Default` for the moment between two cameras.
          cameraId={camera.kind === "live" ? camera.deviceId : prefs.cameraId}
          // A press on the camera already chosen changes nothing, and must not restart the stream.
          onCamera={(cameraId) => {
            if (cameraId !== prefs.cameraId) update({ cameraId });
          }}
        />

        <div className="flex min-h-0 flex-1 gap-4">
          {/* The camera's column: how close the scanner is to a card, then the picture. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 @min-[88rem]/scan:flex-[2_1_0%]">
            {/* **The reader's one line, above the picture rather than under it**, with the card the
                scanner is leaning towards and how close it is: a reader holding a card watches the
                bar fill, and a line under a tall camera is a line below where they are looking. */}
            <MatchStrip
              verdict={scanning ? loop.verdict : null}
              mode={prefs.mode}
              lastAdded={lastAdded}
              hasBundle={hasBundle}
              lastResolution={loop.lastResolution}
              onReset={onReset}
            />
            {/* The column is the height, and the video box takes what the strip above it and the
                asset notes under it leave. **Cropped rather than letterboxed** (`object-cover`, and
                `Overlay`'s canvas with it): at two thirds of a wide view the box is nearer square
                than 16:9, and a letterboxed feed there is a strip with black above and below. */}
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
              <Overlay videoRef={videoRef} verdict={scanning ? loop.verdict : null} />
              <AddedToast card={scanning ? landed : null} onDone={clearLanded} />
              {!scanning && (
                <p role="status" className="absolute left-3 top-2 p-2 text-xs text-dim">
                  {SCANNING_STOPPED}
                </p>
              )}
              {camera.kind === "error" && (
                <p
                  role="alert"
                  className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim"
                >
                  {camera.message}
                </p>
              )}
              {/* **A host with no scanner session** (`scannerUnavailable`) — a browser that
                  cannot run the scanner's module, a build made without its files. The host's own
                  sentence where the picture would be: `loaded` never goes true there, so no
                  camera was asked for and nothing else will ever fill this box. The tray beside
                  it still reads, edits and files. */}
              {unavailable !== null && (
                <p
                  role="alert"
                  className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim"
                >
                  {unavailable}
                </p>
              )}
              {/* The detector's own sentence, in a strip that is *emptied* rather than removed: a
                  frame that fails is the ordinary case at nine answers a second, and a box that
                  grew and shrank with each one would be the loudest thing on the screen. Two lines
                  of room, held whether or not there is anything to put in it. At the top of the
                  picture, because the bottom is where a landed card is laid. */}
              <p
                className="absolute left-3 top-2 min-h-[2.5em] text-xs text-dim"
                aria-live="polite"
              >
                {scanning ? detectorSentence : ""}
              </p>
            </div>
            {/* The scanner's files: the offer to download them where the host says it owes
                them, and otherwise whatever the status still has to say. When a download lands
                the engine's session is a new one — it is given the filters again, and what the
                last one said is dropped, so the next verdict starts a stream of its own. */}
            <ScannerAssets
              status={statusData}
              onLoaded={() => {
                resync();
                loop.clearReads();
              }}
            />
          </div>

          {/* **The tray's side, and below 88rem it is one fixed column.** With the developer panels
              off it is the tray alone, and the tray is the column's height — its cards scroll and
              its Add button stays put. With them on the column scrolls by itself, so opening a panel
              never moves the video, and the tray is capped rather than shrunk: a `min-h-0` item in a
              scroller hands its height to the panels beside it.
              **From 88rem it is a row instead**, grown from a basis of the developer column plus the
              gap (22.25rem, or nothing with the panels off) against the camera's 2 — so the camera
              gets two thirds of what the panels leave and the tray the third, and the panels scroll
              in a column of their own beside it. */}
          <div
            className={
              prefs.developer
                ? "relative flex w-[25rem] shrink-0 flex-col gap-4 overflow-auto @min-[88rem]/scan:w-auto @min-[88rem]/scan:flex-[1_1_22.25rem] @min-[88rem]/scan:flex-row @min-[88rem]/scan:overflow-visible"
                : "flex w-[25rem] shrink-0 flex-col @min-[88rem]/scan:w-auto @min-[88rem]/scan:flex-[1_1_0%]"
            }
          >
            <div
              className={
                prefs.developer
                  ? "flex max-h-[70vh] shrink-0 flex-col @min-[88rem]/scan:max-h-none @min-[88rem]/scan:min-h-0 @min-[88rem]/scan:min-w-0 @min-[88rem]/scan:flex-1"
                  : "flex min-h-0 flex-1 flex-col"
              }
            >
              <TrayPanel
                rows={tray.rows}
                onRows={(update) => writeRows(update(tray.latest()))}
                folderId={folderId}
                onFolder={(id) => update({ folderId: id })}
                onCommit={onCommit}
                onCreateDeck={(opener) => {
                  deckOpener.current = opener;
                  scannedDeck.reset();
                  setDeckRows([...tray.latest()]);
                }}
                committing={committing}
                commitError={commitError}
                onMorePrintings={onMorePrintings}
                flashKey={flashKey}
                layout={trayLayoutOf(prefs.trayLayout)}
                onLayout={(trayLayout) => update({ trayLayout })}
                onClearAll={onClearAll}
              />
            </div>
            {prefs.developer && (
              <div className="flex flex-col gap-4 @min-[88rem]/scan:min-h-0 @min-[88rem]/scan:w-[21.25rem] @min-[88rem]/scan:shrink-0 @min-[88rem]/scan:overflow-y-auto">
                <ScannerPanels
                  status={statusData}
                  verdict={loop.verdict}
                  lastOcr={loop.lastOcr}
                  lastCollector={loop.lastCollector}
                  roundTripMs={loop.roundTripMs}
                  rate={loop.rate}
                  options={options}
                  sendPx={sendPx}
                  detailWaitMs={detailWaitMs}
                  onOptions={setOptions}
                  onSendPx={setSendPx}
                  onDetailWaitMs={setDetailWaitMs}
                  onCapture={onCapture}
                />
                <TiersPanel resolution={loop.lastResolution} />
              </div>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={clearing !== null}
        title="Clear the tray"
        confirmLabel="Clear tray"
        // Nothing typed: these are scans waiting for review, not copies the collection holds, and a
        // typed word on a question this size teaches readers to type it without reading.
        typeToConfirm={false}
        pending={false}
        onConfirm={() => {
          if (clearing === null) return;
          writeRows(withoutCommitted(tray.latest(), clearing));
        }}
        onDismiss={() => {
          setClearing(null);
          clearOpener.current?.focus();
        }}
        onClose={() => setClearing(null)}
      >
        {plural(clearCopies, "scanned copy", "scanned copies")} will leave the tray without being
        added to your collection. Cards you scan while this is open stay.
      </ConfirmDialog>
      <CreateDeckDialog
        open={deckRows !== null}
        create={scannedDeck}
        defaultFormatKey={newDeckFormat}
        intro={`${totalCopies(deckRows ?? [])} scanned copies will be filed into automatic categories. The scans stay in the tray so you can also add them to your collection.`}
        onCreated={(deck) => {
          setDeckRows(null);
          useAppStore.getState().setActiveView("decks");
          useAppStore.getState().setOpenDeckId(deck.id);
        }}
        onDismiss={() => {
          if (scannedDeck.isPending) return;
          setDeckRows(null);
          deckOpener.current?.focus();
        }}
        onClose={() => {
          if (!scannedDeck.isPending) setDeckRows(null);
        }}
      />
    </>
  );
}
