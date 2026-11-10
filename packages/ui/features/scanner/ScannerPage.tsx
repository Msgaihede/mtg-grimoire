import { useEffect, useId, useRef, useState, type JSX } from "react";
import { Bug, History, Minimize2, RotateCcw, Send } from "lucide-react";
import { FILTER_CONTROL } from "@/components/FilterChips";
import { PageBar } from "@/components/PageBar";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { CreateDeckDialog } from "@/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@/features/decks/useNewDeckFormat";
import { plural } from "@/lib/counts";
import { useEdition } from "@/lib/edition";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError } from "@/lib/ipc";
import type { ScanBatch } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { notify } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { leftOutSentence, putBackTitle } from "./history/historyWords";
import { putBack } from "./history/putBack";
import { ScanHistoryDialog } from "./history/ScanHistoryDialog";
import { Overlay } from "./Overlay";
import { AddCardDialog } from "./reader/AddCardDialog";
import { AddedToast } from "./reader/AddedToast";
import {
  EXIT_PACK_OPENER,
  PACK_OPENER,
  PackDrawerTab,
  PackIndicator,
  PackOpenerButton,
  PackPress,
  packFades,
  usePackIdle,
} from "./reader/PackOpener";
import { ShotReadyPill, StoppedVeil } from "./reader/PictureNotes";
import { matchStrip } from "./reader/readerText";
import { ScanDock } from "./reader/ScanDock";
import { RESET_EVIDENCE, ScanHud } from "./reader/ScanHud";
import { TierConfetti } from "./reader/TierConfetti";
import { setPrinting, totalCopies, trayLayoutOf } from "./reader/tray";
import { withoutCommitted } from "./reader/trayCommit";
import { TrayPanel } from "./reader/TrayPanel";
import { useLandedPrice } from "./reader/useLandedPrice";
import { useLandedTier } from "./reader/useLandedTier";
import { ScannerPanels } from "./ScannerPanels";
import { useScanSounds } from "./sounds/useScanSounds";
import { SubmitScanDialog } from "./submit/SubmitScanDialog";
import { SEND_SCAN } from "./submit/submitText";
import { useMaySendScans } from "./submit/useMaySendScans";
import { useScanSubmit } from "./submit/useScanSubmit";
import type { ScannerTrayRow } from "./types";
import { cameraPress, useCamera, useCameraDevices } from "./useCamera";
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

/**
 * The pack opener's drawer: 30rem — the tray's own 24rem floor and room for its header on one
 * line — and never so wide that the window's left 3rem of picture goes. The stage's right edge
 * follows it while it is open, so the drawer sits beside the picture rather than over it: friends
 * watching the shared window keep the whole frame. Written out twice for Tailwind's scanner.
 */
const DRAWER_WIDTH = "w-[30rem] max-w-[calc(100vw-3rem)]";
const BESIDE_DRAWER = "right-[min(30rem,calc(100vw-3rem))]";

// What used to stand here — the flash's hold, the filters' refusal, `isUserFolder` and
// `withoutCommitted` — moved out with the logic that used it, so the light app's phone page files
// its cards by the same rules: `useTrayLanding.ts`, `useScannerStatus.ts`, `reader/trayCommit.ts`.

/**
 * The Scanner view: the page's header, the camera column — the picture, with how close the
 * scanner is to a card drawn on it, and the dock of controls under it — and the review tray beside
 * it, with today's developer panels one switch away.
 *
 * **Gated above the live view.** One window scans at a time (spec §5.3): the scanner is a lease
 * the window using it keeps renewing, and whether another holds it has to be answered *before* the
 * camera is asked for — the live view's own hooks open it as they mount. So this component asks
 * that one question with one query, and `LiveScanner` mounts only once the answer is "free", so a
 * second window never opens a camera only to be refused. A failed ask is treated as "free" — the
 * live view's heartbeat is the real gate and asks again the moment it is refused.
 *
 * **The camera and the panels are two halves on purpose.** `useCamera` and `useScanLoop` own
 * the stream and the pump; `ScanDock`, `ScanHud`, `TrayPanel` and `ScannerPanels` are pure and
 * take what they draw as props, so each is tested from fixtures and storied without a camera, and
 * a change to a panel never touches the loop.
 *
 * **`destination` is the same view filing somewhere else** — a side of a trade, from the dialog
 * that mounts this over the Trade page (`TrayDestination`). Absent, which is the Scanner view,
 * nothing below is any different from before the prop. With one: Add hands the ready rows to the
 * destination and wears its words, the folder and *Create deck…* are not drawn, and neither is
 * the page's header nor the developer panels. The dialog is already titled, and the header's
 * *History* and Developer switch are the Scanner view's: a dialog opened from inside another
 * dialog is a stack the reader did not ask for, and a stored switch flipped from inside a dialog
 * would be found on by a reader who never saw a panel. Everything else is the scanner as it
 * stands, **the tray included**: it is one stored row, so cards already in it are in this list
 * too, and the tray says so.
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
  const { prefs, update, inForce, filterError, loaded, unavailable } = useScannerPrefs();
  /**
   * **The pack opener** (issue #1504): the camera column as the whole window below the caption —
   * the picture uncropped, the dock a one-row bar floating over its foot, the tray a drawer pulled
   * out from the right — for a reader sharing the window with friends while they open packs.
   *
   * **The same elements, laid out again — never a second tree.** The `<video>` is the one
   * `useCamera` handed its stream to; a second one mounted for the mode would be a black box, and
   * reopening the camera for it a flicker and perhaps a second permission prompt. So entering and
   * leaving change classes alone, and the scanner, its run, the tray and every hook above go on
   * exactly as they were — a scan running when the button is pressed is still running on the
   * stage. Session-only, as Start is: a new visit opens in the column.
   *
   * The Scanner view's alone: over a trade the page is already a dialog.
   */
  const [packOpener, setPackOpener] = useState(false);
  const pack = destination === undefined && packOpener;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { idle, wake } = usePackIdle(pack);
  const edition = useEdition();
  const drawerId = useId();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const packOpenerRef = useRef<HTMLElement | null>(null);
  const leavePack = () => {
    setPackOpener(false);
    packOpenerRef.current?.focus();
  };
  // The caret onto the stage as it opens, so the keyboard is where the reader now is — the header
  // press that opened it is under the stage.
  useEffect(() => {
    if (pack) stageRef.current?.focus();
  }, [pack]);
  // **Escape puts the drawer away first, then leaves the stage** — one layer a press. Anything
  // open over either (a dock panel, a dialog) is a capture-phase layer and takes the press before.
  useDismissOnEscape({
    layer: "outer",
    onDismiss: () => setDrawerOpen(false),
    enabled: pack && drawerOpen,
  });
  useDismissOnEscape({ layer: "navigation", onDismiss: leavePack, enabled: pack });
  // The developer panels are the Scanner view's own; a destination's host draws none of them, and
  // neither does the pack opener — a window shared with friends is no place for the debug column.
  const developer = destination === undefined && prefs.developer && !pack;
  // **Stopped until the reader presses Start** (issue #1317): opening the view turns the
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
  // Bumped to reopen the stored camera when the default is open in its place (`cameraPress`).
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const camera = useCamera(
    videoRef,
    loaded && !parked.released ? prefs.cameraId : undefined,
    cameraAttempt,
  );
  const openCamera = camera.kind === "live" ? camera.deviceId : prefs.cameraId;
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
  // Asked once a session — `useScannerStatus` says why nothing else asks.
  const { status: statusData, filtersDisabled, assetNotes } = useScannerStatus();

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

  /**
   * Whether the reader is scanning at all — continuous scanning running, or point and shoot on,
   * whose shot ends on the card it read. Above the landing, which lays a card over the camera only
   * while it is on (issue #1555).
   */
  const armed = prefs.pointAndShoot || scanning;

  // One card, into the tray — once per `decision_seq`, built on `tray.latest()`, in the finish
  // the dock's Finish menu holds as the card lands (`useTrayLanding`). `shown` is the card over
  // the camera — the popup's, and so the confetti's: nothing lands over a picture whose reader is
  // not scanning, and a Stop puts it away.
  const { onDecision, onPicked, lastAdded, landed, shown, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
    armed,
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
   * **Point and shoot** (`usePointAndShoot`): with the pref on, the dock's *Scan card* runs the
   * pump until one card lands, and Start/Stop is not drawn. Over anything that pauses the pump the
   * shot is over, so a dialog closing never resumes one. `reading` is whichever of the two is
   * running — what the overlay, the progress bar and the notes over the picture follow; `armed`
   * (above) is whether the reader is scanning at all, so a card that ended its own shot still
   * lands over the camera.
   */
  const pointAndShoot = prefs.pointAndShoot;
  const shot = usePointAndShoot({
    on: pointAndShoot,
    interrupted: parked.paused || sending || picking,
  });
  const reading = pointAndShoot ? shot.shooting : scanning;

  const loop = useScanLoop({
    videoRef,
    // **Held until the prefs and the tray are in.** The first frame must go out under the stored
    // filters, and a decision must land on the stored tray rather than
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
    keepFullFrames: maySend,
    // A shot's run outlives the shot, for *Send scan…* between two of them (below).
    holdRun: pointAndShoot,
    onDecision: (decision) => {
      onDecision(decision);
      shot.landed();
    },
  });

  // What the card over the camera costs — at the tray's marketplace, so it is its row's figure —
  // and the rung of the sound ladder that reaches, which colours the figure and throws the
  // confetti.
  const landedPrice = useLandedPrice(shown, destination?.marketplace);
  const landedTier = useLandedTier(shown, destination?.marketplace);
  // **A sound for each card that lands, and for each row the reader settles** — `needs-input`
  // while a card asks something, otherwise the jingle its price reaches on the reader's ladder
  // (Settings → Scanner). Not gated on `armed`: a card that ends its own shot still landed.
  useScanSounds({ landed, rows: tray.rows, at: destination?.marketplace });

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
   * note chip at the picture's top-left (`ScanHud`), behind the loop's own error: the same
   * failure that stops a reset stops every frame, and the frame's line names it better. Cleared
   * on the next press rather than on a timer, so a reader who tries again sees the second answer,
   * not the first.
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
   * send and no press is drawn: the stopped veil over the picture already says what would bring
   * one back. **Under point and shoot, between two shots too**: a shot ends the moment its card
   * lands, which is the moment a reader sees whether the scanner got it right, so the loop keeps
   * the shot's run (`holdRun`) and the press stays on it until the next shot — drawn only while
   * the shot ran, it was gone before anyone could reach it.
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
   * **The filters it says are the ones in force** (`inForce`), not the ones the dock is drawing:
   * `prefs.filters` moves the moment the reader changes it, before the session has taken the
   * change, and is put back if the session refuses it.
   */
  const sendable =
    destination === undefined && maySend && camera.kind === "live" && (reading || pointAndShoot);
  const submit = useScanSubmit({
    recent: loop.recent,
    verdict: loop.verdict,
    filters: inForce,
    ready: sendable,
    // Between two shots the run on offer is the last shot's, held by the loop.
    held: pointAndShoot && !reading,
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
  /** The scan history's dialog, and the header's *History* that opened it, for the caret. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);
  /**
   * *Put back in tray* (issue #1374): a past scan's lines into the tray, built on `tray.latest()`,
   * and the history closed so the reader sees them land. **One toast** — the cards are in the
   * tray, not the collection, so it says where they went and that the tray's Add files them; a
   * pile short of printings that have left the card database says so in its body.
   */
  const onPutBack = (batch: ScanBatch) => {
    const outcome = putBack(tray, batch);
    if (!outcome.ok) {
      notify.error(`Couldn't put “${batch.summary.name}” back in the tray`, {
        body: outcome.sentence,
      });
      return;
    }
    setHistoryOpen(false);
    historyOpener.current?.focus();
    notify.success(putBackTitle(batch.summary, outcome.copies), {
      body: leftOutSentence(outcome.left),
    });
  };

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

  // What the HUD's note chip says. The loop's failures are said only while recognition runs;
  // **a refused reset is said stopped too**, because Reset is a press the reader can make over a
  // stopped picture and a press that opened nothing is never silent — and so is a *Send scan…*
  // pressed too soon between two shots, where that press is drawn too (the hook drops its
  // sentence wherever the press goes). The scanner's own refusal of a frame (no card found in it)
  // is the detector's sentence, not the reader's: the Developer panels carry it, and in the chip
  // it would blink frame by frame in an assertive alert.
  const hudNote =
    (reading ? (loop.error ?? resetError ?? submit.error) : (resetError ?? submit.error)) || null;
  // **The HUD's presses stand over a live picture alone** — the phone page's rule: not over the
  // camera's own refusal, nor over a host with no session, each of which is a sentence where the
  // picture would be, and a Reset there would ask a session that has no picture to weigh. Unlike
  // the phone's, *Reset evidence* stays drawn stopped and between shots, as the spec's corner
  // has it — the note above says why a reset refused there is still said.
  const pictureLive = camera.kind === "live" && unavailable === null;

  return (
    // **`@container/scan` because the split answers this view's own width, never the window's** —
    // there is no viewport branch in this app. **The camera column gives way first, in steps**
    // (the owner's choice, 2026-10-24 — the canvas was drawn without the app's 208px rail, which
    // left the tray too narrow at 1280–1440 for its header and footer on one line): 40rem until the
    // tray is down to 36rem, then down to 31rem holding the tray at 36rem, then the tray gives way
    // down to 24rem, then the camera again to its 23rem floor — each step `clamp`'s, over the
    // container's width (`100cqw`) less the tray's step and the 1.25rem gap. 52.5rem from a
    // 140rem container (a 2560px window less the rail and padding). With
    // the developer panels on, below 88rem they stack under the tray in one scroller, and from
    // 88rem they get a column of their own beside it. A container is the containing block for
    // anything `fixed` inside it, so nothing that must cover the window may mount in here — and
    // nothing does: the dropdowns measure the block they land in, the all-printings dialog is
    // drawn at the app root, and the page's five dialogs — *Clear all…*, *Create deck…*, *Send
    // scan…*, *Add card…* and *History* — are this fragment's other children, siblings of the box
    // and not inside it.
    //
    // **The pack opener drops the container**, and that is what lets its stage and drawer be
    // `fixed` to the window from in here: they are this section's own column and tray, and moving
    // them anywhere else would remount the video (the mode's doc says why it must not).
    <>
      <section className={cn("flex h-full flex-col gap-3", !pack && "@container/scan")}>
        {/* Not shown: the page bar's title below draws the view's name, and this heading names
            it for assistive tech, as the other views' do — so that title is a `div`. It is here
            over a trade too, where no header is drawn. */}
        <h2 className="sr-only">Scanner</h2>

        {/* **The page's header** ("Page & Section Headings", 2026-10-21): the title, then the
            scan history and the way back to the developer panels against the right edge, and the
            rule under it. Not over a trade: the dialog is already titled, and both presses are
            the Scanner view's own (the component's doc says why). */}
        {destination === undefined && (
          <PageBar
            title="Scanner"
            titleAs="div"
            actions={
              <>
                <PackOpenerButton
                  onOpen={(opener) => {
                    packOpenerRef.current = opener;
                    setPackOpener(true);
                  }}
                />
                <HistoryButton
                  onOpen={(opener) => {
                    historyOpener.current = opener;
                    setHistoryOpen(true);
                  }}
                />
                <DeveloperSwitch on={developer} onChange={(on) => update({ developer: on })} />
              </>
            }
          />
        )}

        <div className="flex min-h-0 flex-1 gap-5">
          {/* The camera's column: the picture, with everything the scanner says drawn on it, and
              the dock of controls under it. **In the pack opener it is the stage**: the window
              below the caption at `LAYER.stage`, as the game board is — over the rail and the
              page, under every popup and dialog — its right edge beside the drawer while that is
              out. Every pointer move and key over it wakes the bar (`usePackIdle`), and idle the
              pointer goes too, so a shared window shows the cards and not an arrow. */}
          <div
            ref={stageRef}
            role={pack ? "region" : undefined}
            aria-label={pack ? PACK_OPENER : undefined}
            tabIndex={pack ? -1 : undefined}
            onPointerMove={pack ? wake : undefined}
            onPointerDown={pack ? wake : undefined}
            onKeyDown={pack ? wake : undefined}
            className={
              pack
                ? cn(
                    "fixed bottom-0 left-0 flex flex-col bg-black outline-none",
                    edition.caption ? BELOW_CAPTION : "top-0",
                    drawerOpen ? BESIDE_DRAWER : "right-0",
                    LAYER.stage,
                    idle && "cursor-none",
                  )
                : "flex min-w-[23rem] flex-[0_1_clamp(23rem,100cqw_-_25.25rem,clamp(31rem,100cqw_-_37.25rem,40rem))] flex-col gap-3 @min-[140rem]/scan:basis-[52.5rem]"
            }
          >
            {/* The column is the height, and the video box takes what the notes and the dock
                under it leave. **Cropped rather than letterboxed** (`object-cover`, and
                `Overlay`'s canvas with it): a column this shape is nearer square than 16:9, and a
                letterboxed feed there is a strip with black above and below. **The pack opener
                letterboxes instead** (`object-contain`): the window is the picture there, and the
                whole frame the camera sends is what friends are watching — a crop would cut the
                card at the frame's edge off their screen. */}
            <div
              className={cn(
                "relative min-h-0 flex-1 overflow-hidden bg-black",
                !pack && "rounded-lg",
              )}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                className={cn("h-full w-full", pack ? "object-contain" : "object-cover")}
              />
              <Overlay
                videoRef={videoRef}
                verdict={reading ? loop.verdict : null}
                orientation={developer}
                fit={pack ? "contain" : "cover"}
              />
              {/* **Stopped, the picture dims behind the press that begins it** — continuous only,
                  and only over a picture: a refused camera or a host with no session puts its own
                  sentence where the picture would be, and a veil laid over that would be two
                  centred sentences on top of each other. **Not in the pack opener**: a dimmed
                  picture is not what friends came to watch, and the recording light in its corner
                  already says it is stopped. */}
              {!pack &&
                !pointAndShoot &&
                !scanning &&
                camera.kind !== "error" &&
                unavailable === null && <StoppedVeil />}
              {/* Before the popup, so the pieces leave from behind the card; thrown only for a
                  landing the popup is showing, at a price tier. A `null` burst throws nothing and
                  stops nothing, so a jackpot still in the air when the popup goes finishes. */}
              <TierConfetti
                burst={
                  shown !== null && landedTier !== null
                    ? { stamp: shown.stamp, tier: landedTier }
                    : null
                }
              />
              <AddedToast card={shown} price={landedPrice} tier={landedTier} raised={pack} />
              {camera.kind === "error" && (
                <p
                  role="alert"
                  className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim"
                >
                  {camera.message}
                </p>
              )}
              {/* **A host with no scanner session** (`scannerUnavailable`) — a browser that
                  cannot run the scanner's module. The host's own
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
              {/* **How close the scanner is to a card, drawn on the picture** (`ScanHud`): the bar
                  along the top edge, *Reset evidence* and *Send scan…* in the top-right corner, the
                  one error it has to say under the bar, and the visually hidden live region that
                  announces what the old Match strip said. Last, and on its own layer, so its
                  presses stay above everything else in the box. **Not drawn on a host with no
                  session**, as on the phone: its status would say *Point the camera at a card*
                  under a sentence saying there is no scanner. */}
              {unavailable === null && (
                <ScanHud
                  strip={matchStrip(reading ? loop.verdict : null, lastAdded)}
                  // No bar over the camera's own refusal: nothing is being matched there.
                  live={reading && camera.kind === "live"}
                  variant="labelled"
                  // In the pack opener both presses are the bar's, with every other control.
                  onReset={pictureLive && !pack ? onReset : undefined}
                  // Offered only where `sendable` says: a run to send (a running scanner's, or
                  // the last shot's), the Scanner view itself, and a supporter's device. Without
                  // a live camera, or stopped, the picture is already saying why not; of the
                  // membership nothing is said at all.
                  onSend={sendable && !pack ? submit.open : undefined}
                  note={hudNote}
                  // Point and shoot between two shots: what the next one is taken with — in the
                  // HUD's own flow, under *Reset evidence*, which it would otherwise run under in
                  // a column narrower than 584px.
                  notice={
                    !pack && pointAndShoot && !shot.shooting && camera.kind !== "error" ? (
                      <ShotReadyPill />
                    ) : null
                  }
                  // The pack opener's recording light, in the corner where the chip starts — it
                  // stands for the stopped veil and the shot-ready pill, which it does not draw.
                  lead={
                    pack ? <PackIndicator reading={reading} pointAndShoot={pointAndShoot} /> : null
                  }
                />
              )}
            </div>
            {/* Whatever the status still has to say — the recogniser's files, there and not
                loaded. */}
            {assetNotes.length > 0 && (
              <div className="space-y-1 text-xs text-dim">
                {assetNotes.map((note) => (
                  // An error may carry a path, which is one unbreakable word.
                  <p key={note} className="break-words">
                    {note}
                  </p>
                ))}
              </div>
            )}

            <ScanDock
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
              filters={prefs.filters}
              onFilters={(filters) => update({ filters })}
              filterError={filterError}
              // A host with no session has nothing to narrow, and a filter changed there would be
              // drawn, never taken and never stored.
              filtersDisabled={unavailable ?? filtersDisabled}
              finish={prefs.finish}
              onFinish={(finish) => update({ finish })}
              cameras={cameras}
              // The camera that opened; while a switch is starting, the one asked for — so the
              // trigger does not read `Default` for the moment between two cameras.
              cameraId={openCamera}
              // A press on the ticked camera changes nothing; on the stored one while the fallback
              // is open, it reopens it (issue #1554). See `cameraPress`.
              onCamera={(cameraId) => {
                const press = cameraPress(cameraId, openCamera, prefs.cameraId);
                if (press === "store") update({ cameraId });
                else if (press === "reopen") setCameraAttempt((n) => n + 1);
              }}
              // **The pack opener's bar**: the same dock in one row over the picture's foot, with
              // the HUD's two presses and the way out at its end, gone while idle and back with
              // the pointer (`packFades`). Above the HUD's layer, so its panels open over it.
              variant={pack ? "bar" : "dock"}
              className={
                pack
                  ? cn(
                      "absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[calc(100%-2rem)]",
                      LAYER.raised,
                      packFades(idle),
                    )
                  : undefined
              }
              extra={
                pack ? (
                  <>
                    {pictureLive && (
                      <PackPress
                        words={RESET_EVIDENCE}
                        glyph={<RotateCcw className="size-4" aria-hidden="true" />}
                        onClick={onReset}
                      />
                    )}
                    {sendable && (
                      <PackPress
                        words={SEND_SCAN}
                        glyph={<Send className="size-4" aria-hidden="true" />}
                        opensDialog
                        onClick={(e) => submit.open(e.currentTarget)}
                      />
                    )}
                    <PackPress
                      words={EXIT_PACK_OPENER}
                      glyph={<Minimize2 className="size-4" aria-hidden="true" />}
                      onClick={leavePack}
                    />
                  </>
                ) : undefined
              }
            />
          </div>

          {/* **The tray's side: the rest of the width, and never under 24rem.** With the
              developer panels off it is the tray alone, and the tray is the column's height — its
              cards scroll and its Add button stays put. With them on, below 88rem the side scrolls
              by itself, so opening a panel never moves the video, and the tray is capped rather
              than shrunk: a `min-h-0` item in a scroller hands its height to the panels beside it.
              **From 88rem it is a row instead**, the panels scrolling in a column of their own
              beside the tray — its floor then the tray's 24rem, the gap and the panels' 21.25rem.
              **In the pack opener it is the drawer**: the window's right edge below the caption,
              slid off it until the pull tab brings it out, and inert while it is away so the
              keyboard never walks into a tray nobody can see. */}
          <div
            onPointerMove={pack ? wake : undefined}
            className={
              pack
                ? cn(
                    "fixed right-0 bottom-0 flex flex-col bg-bg p-3 shadow-xl",
                    "transition-transform duration-300 motion-reduce:transition-none",
                    DRAWER_WIDTH,
                    edition.caption ? BELOW_CAPTION : "top-0",
                    LAYER.stage,
                    !drawerOpen && "translate-x-full",
                  )
                : developer
                  ? "relative flex min-w-[24rem] flex-1 flex-col gap-4 overflow-auto @min-[88rem]/scan:min-w-[46.25rem] @min-[88rem]/scan:flex-row @min-[88rem]/scan:overflow-visible"
                  : "flex min-w-[24rem] flex-1 flex-col"
            }
          >
            {/* First in the DOM so it is the first stop into the drawer, and outside the inert
                tray so it can always be reached. It fades with the bar, save while the drawer is
                out — then it is the drawer's edge. */}
            {pack && (
              <PackDrawerTab
                open={drawerOpen}
                onToggle={() => setDrawerOpen((open) => !open)}
                copies={totalCopies(tray.rows)}
                controls={drawerId}
                className={packFades(idle && !drawerOpen)}
              />
            )}
            <div
              id={pack ? drawerId : undefined}
              inert={pack && !drawerOpen}
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
                condition={prefs.condition}
                onCondition={(condition) => update({ condition })}
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
                  roundTripMs={loop.roundTripMs}
                  rate={loop.rate}
                  onCapture={onCapture}
                />
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
        onPutBack={onPutBack}
        onDismiss={() => {
          setHistoryOpen(false);
          historyOpener.current?.focus();
        }}
        onClose={() => setHistoryOpen(false)}
      />
      {/* A card into the staging tray, not the collection: no toast, as for a scan — the row's
          flash and the popup over the camera say it landed, and the tray's Add is the write that
          toasts. */}
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

/**
 * *History* in the page's header — the scan history's dialog (issue #989), which the page mounts
 * outside its `@container/scan` box for the `@container` rule. `opener` is the button, for the
 * caret to come back to. Drawn only in the Scanner view itself: over a trade the page is already a
 * dialog, and a dialog opened from inside another is a stack the reader did not ask for.
 */
function HistoryButton({ onOpen }: { onOpen: (opener: HTMLElement) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      aria-haspopup="dialog"
      className={cn(
        FILTER_CONTROL,
        "inline-flex items-center gap-1.5 px-2.5",
        "border-border text-dim hover:border-accent hover:text-accent",
        FOCUS,
      )}
    >
      <History className="size-3.5 shrink-0" aria-hidden="true" />
      History
    </button>
  );
}

/**
 * The way back to today's panels, at the header's far end.
 *
 * `role="switch"` named by its own word, so the state is `aria-checked` and the name never moves
 * under a reader's finger. Accent when on and quiet until hovered when off — the Settings page's
 * switch tone, drawn in the header's 36px box rather than imported from that page's recipe, which
 * is `Panel.tsx`'s argument about a class string crossing a feature boundary.
 *
 * Not drawn over a trade: a host that never draws the developer panels has nothing for it to bring
 * back, and the switch is a stored pref the Scanner view would then open with.
 */
function DeveloperSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        FILTER_CONTROL,
        "inline-flex items-center gap-1.5 px-2.5",
        FOCUS,
        on
          ? "border-accent text-accent"
          : "border-border text-dim hover:border-accent hover:text-accent",
      )}
    >
      {/* `Bug` and not `Wrench`: the wrench is Deck settings' glyph, and one picture for two
          unrelated controls is a vocabulary a reader has to unlearn. */}
      <Bug className="size-3.5 shrink-0" aria-hidden="true" />
      Developer
    </button>
  );
}
