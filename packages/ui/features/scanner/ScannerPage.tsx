import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { PageRule, PageTitle } from "@/components/PageBar";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { CreateDeckDialog } from "@/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@/features/decks/useNewDeckFormat";
import { plural } from "@/lib/counts";
import { ipc, ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import { ScanHistoryDialog } from "./history/ScanHistoryDialog";
import { Overlay } from "./Overlay";
import { TiersPanel } from "./panels/TiersPanel";
import { AddCardDialog } from "./reader/AddCardDialog";
import { AddedToast } from "./reader/AddedToast";
import { MatchStrip } from "./reader/MatchStrip";
import { SCANNING_STOPPED, SHOT_READY_CLICK } from "./reader/readerText";
import { ScanBar } from "./reader/ScanBar";
import { setPrinting, totalCopies, trayLayoutOf } from "./reader/tray";
import { withoutCommitted } from "./reader/trayCommit";
import { TrayPanel } from "./reader/TrayPanel";
import { useLandedPrice } from "./reader/useLandedPrice";
import { ScannerAssets } from "./ScannerAssets";
import { ScannerPanels } from "./ScannerPanels";
import {
  DEFAULT_DETAIL_WAIT_MS,
  DEFAULT_SCANNER_OPTIONS,
  DEFAULT_SEND_PX,
  frameOptions as frameOptionsOf,
} from "./scannerOptions";
import { SubmitScanDialog } from "./submit/SubmitScanDialog";
import { useMaySendScans } from "./submit/useMaySendScans";
import { useScanSubmit } from "./submit/useScanSubmit";
import type { ScannerOptions, ScannerTrayRow } from "./types";
import { useCamera, useCameraDevices } from "./useCamera";
import { usePointAndShoot } from "./usePointAndShoot";
import { useScanLoop } from "./useScanLoop";
import { useScannerElsewhere } from "./useScannerElsewhere";
import { useRefusedElsewhere, useScannerHold } from "./useScannerHold";
import { useScannerPrefs } from "./useScannerPrefs";
import { useScannerStatus } from "./useScannerStatus";
import { useTray } from "./useTray";
import { useTrayCommit, useTrayFolder } from "./useTrayCommit";
import { useTrayDestination, type TrayDestination } from "./useTrayDestination";
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
 *
 * **`destination` is the same view filing somewhere else** — a side of a trade, from the dialog
 * that mounts this over the Trade page (`TrayDestination`). Absent, which is the Scanner view,
 * nothing below is any different from before the prop. With one: Add hands the ready rows to the
 * destination and wears its words, the folder and *Create deck…* are not drawn, and neither are
 * the developer panels or their switch — they are the Scanner view's, and a stored switch flipped
 * from inside a dialog would be found on by a reader who never saw a panel. Everything else is
 * the scanner as it stands, **the tray included**: it is one stored row, so cards already in it
 * are in this list too, and the tray says so.
 */
export function ScannerPage({ destination }: { destination?: TrayDestination }): JSX.Element {
  const elsewhere = useScannerElsewhere();
  if (elsewhere.data === true) return <ElsewhereSentence />;
  if (elsewhere.isPending) {
    return (
      <section className="flex h-full flex-col gap-3">
        <h2 className="sr-only">Scanner</h2>
      </section>
    );
  }
  return <LiveScanner destination={destination} />;
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

function LiveScanner({ destination }: { destination: TrayDestination | undefined }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { prefs, update, inForce, filterError, loaded, unavailable, resync } = useScannerPrefs();
  // The developer panels are the Scanner view's own; a destination's host draws none of them, and
  // asks the engine for none of the previews they alone show.
  const developer = destination === undefined && prefs.developer;
  // **Stopped until the reader presses Start scanning** (issue #1317): opening the view turns the
  // camera on, not recognition. Session-only: a Start or Stop survives minimize/restore, and a new
  // visit starts stopped again.
  const [scanning, setScanning] = useState(false);
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
    () => frameOptionsOf(options, prefs.mode, developer),
    [options, prefs.mode, developer],
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
  const { onDecision, onPicked, lastAdded, landed, clearLanded, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
  );

  /**
   * *Send scan…*'s dialog is open (issue #977). Mirrors `submit.run !== null`, which the pump
   * cannot read directly: `useScanSubmit` is built on the loop, so it comes after it. Synced in
   * render, below the hook, so the pump stops in the same commit the dialog opens in.
   */
  const [sending, setSending] = useState(false);

  /**
   * *Add card…* (issue #978): a card the camera will not read, searched for and put in the tray by
   * hand. **The scanner pauses while the dialog is open** — the reader has turned to the keyboard,
   * and a card read behind the scrim would land in a tray they cannot see. Not the Stop button's
   * `scanning`: closing the dialog resumes exactly what was running before it opened.
   */
  const [picking, setPicking] = useState(false);
  const pickOpener = useRef<HTMLElement | null>(null);

  // Read above the loop: a device that may send scans keeps each frame of its run at full
  // resolution (`keepFullFrames`), and one that may not pays nothing for it.
  const maySend = useMaySendScans();

  /**
   * **Point and shoot** (`usePointAndShoot`): with the pref on, the bar's *Scan card* runs the pump
   * until one card lands, and Start/Stop is not drawn. Over anything that pauses the pump the shot
   * is over, so a dialog closing never resumes one. `reading` is whichever of the two is running
   * — what the overlay, the strip and the sentences over the picture follow; `armed` is whether
   * the reader is scanning at all, so a card that ended its own shot still lands over the camera.
   */
  const pointAndShoot = prefs.pointAndShoot;
  const shot = usePointAndShoot({
    on: pointAndShoot,
    interrupted: parked.paused || sending || picking,
  });
  const reading = pointAndShoot ? shot.shooting : scanning;
  const armed = pointAndShoot || scanning;

  const loop = useScanLoop({
    videoRef,
    // **Held until the prefs and the tray are in.** The first frame must go out in the stored
    // mode and under the stored filters, and a decision must land on the stored tray rather than
    // on an empty one the load then overwrites. And paused the moment the window is minimized,
    // for as long as *Send scan…*'s dialog is open (`sending`, below), and while a card is being
    // added by hand (`picking`).
    live:
      reading &&
      camera.kind === "live" &&
      loaded &&
      tray.loaded &&
      !parked.paused &&
      !sending &&
      !picking,
    options: frameOptions,
    sendPx,
    detailWaitMs,
    keepFullFrames: maySend,
    onDecision: (decision) => {
      onDecision(decision);
      shot.landed();
    },
  });

  // What the card over the camera costs — at the tray's marketplace, so it is its row's figure.
  const landedPrice = useLandedPrice(armed ? landed : null, destination?.marketplace);

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

  /**
   * *Send scan…* (issue #776): the last couple of seconds the scanner was shown, to its maker,
   * under the printing and finish a reader says the last of them shows — `useScanSubmit`, shared
   * with the phone's page.
   *
   * **A run, never one picture**: the frames are the pump's own (`loop.recent`), the ones the
   * scanner was really given, so the press grabs nothing and there is no single-picture way to
   * send.
   *
   * **Not the capture above, and neither replaces the other.** That one is the Developer
   * column's: a file written beside the app, named by whoever is running it. This one leaves the
   * device, and so asks first — its dialog shows the pictures and says where they go.
   *
   * **Three conditions, and the press is drawn only where all three hold.**
   *
   * **While there can be a run** — a camera live *and* recognition running. Stopped, the pump
   * has let its frames go (a run never spans a Stop) and is sending none, so there is nothing to
   * send and no press is drawn: the stopped sentence over the picture already says what would
   * bring one back.
   *
   * **Only in the Scanner view itself — never over a trade** (the owner's decision,
   * 2026-10-11). Mounted with a `destination` this page is already inside a dialog, and its
   * reader is in the middle of something else; *Create deck…* is not drawn there for the same
   * reason.
   *
   * **And only for a supporter** (the owner's decision; `useMaySendScans`). Unlike the other
   * two, this one has **no sentence anywhere**: a device that is not a supporter's — or whose
   * membership has not been read yet — sees no press, no greyed one, and no word about why. The
   * hook says why that silence is a rule and not an omission. A lapse while the dialog is open
   * is not this page's either: the engine refuses the send, and the dialog draws the refusal.
   *
   * **The filters it says are the ones in force** (`inForce`), not the ones the bar is drawing:
   * `prefs.filters` moves the moment the reader changes it, before the session has taken the
   * change, and is put back if the session refuses it.
   */
  // Under point and shoot a run lives only as long as its shot, so the press is drawn during one.
  const sendable = destination === undefined && maySend && camera.kind === "live" && reading;
  const submit = useScanSubmit({
    recent: loop.recent,
    verdict: loop.verdict,
    mode: prefs.mode,
    status: statusData,
    filters: inForce,
    ready: sendable,
  });
  // **Recognition pauses while the dialog is open** (issue #977): a card left under the lens
  // while the reader picks a printing would otherwise land in the tray behind their back. React's
  // "adjusting state when a prop changes", as `useScanLoop` empties its latches — re-rendered
  // before anything commits. The run is already frozen in the dialog, so stopping the pump (which
  // lets its ring go) costs it nothing; closing starts a fresh run.
  if (sending !== (submit.run !== null)) setSending(submit.run !== null);
  // **A run never spans a change of filters.** The session drops its tracker to take a changed
  // set, and the pump cannot see that — a filter is a call of its own, not a frame's — so the
  // page says it: when the filters in force move, the frames kept so far are let go
  // (`ScanLoop.breakRun`). An effect, since it writes the loop's refs; the one extra run at mount
  // empties a ring nothing has reached yet.
  const { breakRun } = loop;
  useEffect(() => {
    breakRun();
  }, [inForce, breakRun]);

  // The tray into the collection, in one `scanner_tray_commit` — all or nothing, the rows with a
  // known finish, the folder asked about again at the press (`useTrayCommit`).
  // Archive is the same plan into the scan history instead (issue #989), and shares the commit's
  // in-flight state and its one refusal slot.
  const {
    commit,
    committing,
    archive,
    archiving,
    error: commitError,
  } = useTrayCommit({
    tray,
    condition: prefs.condition,
    folderId: prefs.folderId,
    folderList,
    onRefused: (sentence) => notify.error("Couldn't add the scanned cards", { body: sentence }),
    onArchiveRefused: (sentence) =>
      notify.error("Couldn't archive the scanned cards", { body: sentence }),
  });
  // The same press for a destination that is not the collection: its own write first, then the
  // tray's subtraction (`useTrayDestination`). Both hooks are called; one of them acts.
  const handOff = useTrayDestination({
    tray,
    destination,
    onRefused: (sentence) =>
      notify.error(`Couldn't add the scanned cards to ${destination?.name ?? "the list"}`, {
        body: sentence,
      }),
  });
  /**
   * **One toast per Add, never one per card** — the owner's rule for a collection write, and its
   * batch half. Each card already says it landed in the tray, over the camera (`AddedToast`), and
   * the tray is a staging list rather than the collection: a toast per scan would stack four
   * deep over a reader feeding cards at the camera, about cards that are not filed yet. The press
   * that files them is the write, and it is said once, with the count and where they went. A
   * refusal is the hooks' `onRefused`, above.
   */
  const onCommit = () => {
    if (destination !== undefined) {
      void handOff.commit().then((copies) => {
        if (copies !== null) {
          notify.success(`Added ${plural(copies, "card")} to ${destination.name}`);
        }
      });
      return;
    }
    void commit().then((filed) => {
      if (filed === null) return;
      notify.success(`Added ${plural(filed.copies, "card")} to ${filedInto(filed.folderId)}`);
    });
  };
  /**
   * *Archive* (issue #989): the rows an Add would take, kept in the scan history and filed
   * nowhere. **One toast, with the count and where they went** — the Add's sentence with the
   * archive's verb, because the tray empties under the reader and the cards are not in the
   * collection, so the toast is the one place that says where to find them again.
   */
  const onArchive = () => {
    void archive().then((kept) => {
      if (kept === null) return;
      notify.success(`Archived ${plural(kept.copies, "card")} to Scan history`);
    });
  };
  /** The scan history's dialog, and the bar's *History* that opened it, for the caret. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);

  /** Where a commit filed, as the toast names it: a folder's name, or the collection's. A folder
   *  the list does not hold (it would not load, and the stored id went to the backend as it
   *  stood) is called the collection too — the answer proves no more than that. */
  const filedInto = (id: number | null): string => {
    const folder = id === null ? undefined : folderList.folders.find((f) => f.id === id);
    return folder === undefined ? "your collection" : `“${folder.name}”`;
  };

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
  // and the reader has the status line for what it means to them. The loop's failures, a refused
  // reset and a *Send scan…* pressed too soon are not the detector's, and every reader gets
  // those. **A press that opened nothing is never silent**: it takes this line over from the
  // detector's own sentence, which a Developer reader is otherwise shown on every frame with no
  // card in it. It is not said while recognition is stopped, where the line is the stopped
  // sentence's: the press is not drawn there, and the hook drops its sentence with the press.
  const detectorSentence =
    developer && loop.verdict?.ok === false && submit.error === null
      ? (loop.verdict.error ?? "")
      : (loop.error ?? resetError ?? submit.error ?? "");

  return (
    // **`@container/scan` because the split answers this view's own width, never the window's** —
    // there is no viewport branch in this app. Below 88rem the tray is a 400px column and the
    // developer panels stack under it in one scroller; from 88rem the camera takes two thirds of
    // what the developer column leaves, the tray the other third, and the panels get a column of
    // their own. A container is the containing block for anything `fixed` inside it, so nothing
    // that must cover the window may mount in here — and nothing does: the dropdowns measure the
    // block they land in, the all-printings dialog is drawn at the app root, and the page's five
    // dialogs — *Clear all…*, *Create deck…*, *Send scan…*, *Add card…* and *History* — are this
    // fragment's other children, siblings of the box and not inside it.
    <>
      <section className="@container/scan flex h-full flex-col gap-3">
        {/* Not shown: the page title at the start of the bar below draws the view's name, and
            this heading names it for assistive tech, as the other views' do — so that title is a
            `div`. */}
        <h2 className="sr-only">Scanner</h2>

        <ScanBar
          scanning={scanning}
          onScanning={setScanning}
          pointAndShoot={pointAndShoot}
          onPointAndShoot={(on) => {
            // Either way the switch lands stopped: a shot ends with the pref, and Start is
            // pressed afresh — the view's own rule, a visit starts stopped (issue #1317).
            setScanning(false);
            update({ pointAndShoot: on });
          }}
          shooting={shot.shooting}
          onShoot={(on) => (on ? shot.start(loop.clearReads, "card") : shot.stop())}
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
          developer={developer}
          onDeveloper={(on) => update({ developer: on })}
          developerSwitch={destination === undefined}
          cameras={cameras}
          // The camera that opened; while a switch is starting, the one asked for — so the trigger
          // does not read `Default` for the moment between two cameras.
          cameraId={camera.kind === "live" ? camera.deviceId : prefs.cameraId}
          // A press on the camera already chosen changes nothing, and must not restart the stream.
          onCamera={(cameraId) => {
            if (cameraId !== prefs.cameraId) update({ cameraId });
          }}
          // The history is the Scanner view's: over a trade the page is already a dialog.
          onHistory={
            destination === undefined
              ? (opener) => {
                  historyOpener.current = opener;
                  setHistoryOpen(true);
                }
              : undefined
          }
          // **The page bar, drawn by the scan bar** ("Page & Section Headings", 2026-10-21): the
          // title as its first item and the rule under it, so naming the view costs the
          // camera no height. Not over a trade, whose dialog is already titled.
          lead={destination === undefined ? <PageTitle title="Scanner" titleAs="div" /> : undefined}
        />
        {destination === undefined && <PageRule />}

        <div className="flex min-h-0 flex-1 gap-4">
          {/* The camera's column: how close the scanner is to a card, then the picture. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 @min-[88rem]/scan:flex-[2_1_0%]">
            {/* **The reader's one line, above the picture rather than under it**, with the card the
                scanner is leaning towards and how close it is: a reader holding a card watches the
                bar fill, and a line under a tall camera is a line below where they are looking. */}
            <MatchStrip
              verdict={reading ? loop.verdict : null}
              mode={prefs.mode}
              lastAdded={lastAdded}
              hasBundle={hasBundle}
              lastResolution={loop.lastResolution}
              onReset={onReset}
              // Offered only where `sendable` says: a run to send, the Scanner view itself, and
              // a supporter's device. Without a live camera, or stopped, the box under the strip
              // is already saying why not; of the membership nothing is said at all.
              onSend={sendable ? submit.open : undefined}
            />
            {/* The column is the height, and the video box takes what the strip above it and the
                asset notes under it leave. **Cropped rather than letterboxed** (`object-cover`, and
                `Overlay`'s canvas with it): at two thirds of a wide view the box is nearer square
                than 16:9, and a letterboxed feed there is a strip with black above and below. */}
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
              <Overlay videoRef={videoRef} verdict={reading ? loop.verdict : null} />
              <AddedToast
                card={armed ? landed : null}
                onDone={clearLanded}
                price={landedPrice}
              />
              {!reading && (
                <p role="status" className="absolute left-3 top-2 p-2 text-xs text-dim">
                  {pointAndShoot ? SHOT_READY_CLICK : SCANNING_STOPPED}
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
                {reading ? detectorSentence : ""}
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
              developer
                ? "relative flex w-[25rem] shrink-0 flex-col gap-4 overflow-auto @min-[88rem]/scan:w-auto @min-[88rem]/scan:flex-[1_1_22.25rem] @min-[88rem]/scan:flex-row @min-[88rem]/scan:overflow-visible"
                : "flex w-[25rem] shrink-0 flex-col @min-[88rem]/scan:w-auto @min-[88rem]/scan:flex-[1_1_0%]"
            }
          >
            <div
              className={
                developer
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
                // A deck is made from the collection's side of the scanner; a destination's
                // host is in the middle of something else.
                onCreateDeck={
                  destination === undefined
                    ? (opener) => {
                        deckOpener.current = opener;
                        scannedDeck.reset();
                        setDeckRows([...tray.latest()]);
                      }
                    : undefined
                }
                committing={destination === undefined ? committing : handOff.committing}
                commitError={destination === undefined ? commitError : handOff.error}
                destination={destination}
                notice={handOff.notice}
                onMorePrintings={onMorePrintings}
                flashKey={flashKey}
                layout={trayLayoutOf(prefs.trayLayout)}
                onLayout={(trayLayout) => update({ trayLayout })}
                onClearAll={onClearAll}
                // Archive is a record in the Scanner view's own history; a destination's host
                // files somewhere else and draws none (`TrayPanel` also hides it for one).
                onArchive={destination === undefined ? onArchive : undefined}
                archiving={destination === undefined && archiving}
                onAddCard={(opener) => {
                  pickOpener.current = opener;
                  setPicking(true);
                }}
              />
            </div>
            {developer && (
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
          // A clear is a bulk removal, and gets a receipt with its count even though the tray
          // visibly empties: the dialog has closed over it, and the scans are not coming back.
          const copies = plural(totalCopies(clearing), "scanned copy", "scanned copies");
          notify.success(`Cleared ${copies} from the tray`);
        }}
        onDismiss={() => {
          setClearing(null);
          clearOpener.current?.focus();
        }}
        onClose={() => setClearing(null)}
      >
        {plural(clearCopies, "scanned copy", "scanned copies")} will leave the tray without being
        added to {destination?.name ?? "your collection"}. Cards you scan while this is open stay.
      </ConfirmDialog>
      <CreateDeckDialog
        open={deckRows !== null}
        create={scannedDeck}
        defaultFormatKey={newDeckFormat}
        intro={`${totalCopies(deckRows ?? [])} scanned copies will be filed into automatic categories. The scans stay in the tray so you can also add them to your collection.`}
        // A deck made out of the tray is a deck write, and the owner's rule says it out loud,
        // once, with the count — through the dialog's own receipt, so the create is one toast
        // rather than the dialog's `Deck “X” created` and this beside it.
        receipt={(deck) =>
          `Created “${deck.name}” with ${plural(totalCopies(deckRows ?? []), "card")}`
        }
        onCreated={(deck) => {
          // The page then leaves for the deck; the scans stay in the tray.
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
      <SubmitScanDialog run={submit.run} onDismiss={submit.onDismiss} onClose={submit.onClose} />
      <ScanHistoryDialog
        open={historyOpen}
        onDismiss={() => {
          setHistoryOpen(false);
          historyOpener.current?.focus();
        }}
        onClose={() => setHistoryOpen(false)}
      />
      {/* A card into the staging tray, not the collection: no toast, as for a scan — the row's
          flash and the strip's line say it landed, and the tray's Add is the write that toasts. */}
      <AddCardDialog
        open={picking}
        finishPref={prefs.finish}
        onAdd={(picked, finish) => {
          onPicked(picked, finish);
          setPicking(false);
          pickOpener.current?.focus();
        }}
        onDismiss={() => {
          setPicking(false);
          pickOpener.current?.focus();
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}
