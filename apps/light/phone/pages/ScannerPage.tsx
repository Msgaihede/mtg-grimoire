import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, Ellipsis, Play, Plus, Square } from "lucide-react";
import { useBulkUndoAction } from "@grimoire/ui/components/UndoNotice";
import { CreateDeckDialog } from "@grimoire/ui/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@grimoire/ui/features/decks/useNewDeckFormat";
import { ADD_CARD_LABEL, AddCardDialog } from "@grimoire/ui/features/scanner/reader/AddCardDialog";
import { AddedToast } from "@grimoire/ui/features/scanner/reader/AddedToast";
import {
  HeldChip,
  HoldPrompt,
  StoppedVeil,
} from "@grimoire/ui/features/scanner/reader/PictureNotes";
import { matchStrip, START, STOP } from "@grimoire/ui/features/scanner/reader/readerText";
import { ScanHud } from "@grimoire/ui/features/scanner/reader/ScanHud";
import { TierConfetti } from "@grimoire/ui/features/scanner/reader/TierConfetti";
import {
  leftOutSentence,
  putBackTitle,
} from "@grimoire/ui/features/scanner/history/historyWords";
import { putBack } from "@grimoire/ui/features/scanner/history/putBack";
import {
  needsDecision,
  needYouLabel,
  NEXT_DECISION_LABEL,
  totalCopies,
} from "@grimoire/ui/features/scanner/reader/tray";
import { withoutCommitted } from "@grimoire/ui/features/scanner/reader/trayCommit";
import { useLandedPrice } from "@grimoire/ui/features/scanner/reader/useLandedPrice";
import { useLandedTier } from "@grimoire/ui/features/scanner/reader/useLandedTier";
import { useScanSounds } from "@grimoire/ui/features/scanner/sounds/useScanSounds";
import { SubmitScanDialog } from "@grimoire/ui/features/scanner/submit/SubmitScanDialog";
import { useMaySendScans } from "@grimoire/ui/features/scanner/submit/useMaySendScans";
import { useScanSubmit } from "@grimoire/ui/features/scanner/submit/useScanSubmit";
import { useCamera, useCameraDevices } from "@grimoire/ui/features/scanner/useCamera";
import { usePageParked } from "@grimoire/ui/features/scanner/useParked";
import { usePointAndShoot } from "@grimoire/ui/features/scanner/usePointAndShoot";
import { useScanLoop } from "@grimoire/ui/features/scanner/useScanLoop";
import { useScannedDeck } from "@grimoire/ui/features/scanner/useScannedDeck";
import { useScannerElsewhere } from "@grimoire/ui/features/scanner/useScannerElsewhere";
import { useRefusedElsewhere, useScannerHold } from "@grimoire/ui/features/scanner/useScannerHold";
import { useScannerPrefs } from "@grimoire/ui/features/scanner/useScannerPrefs";
import { useScannerStatus } from "@grimoire/ui/features/scanner/useScannerStatus";
import { useTray } from "@grimoire/ui/features/scanner/useTray";
import { useTrayCommit, useTrayFolder } from "@grimoire/ui/features/scanner/useTrayCommit";
import {
  useTrayDestination,
  type TrayDestination,
} from "@grimoire/ui/features/scanner/useTrayDestination";
import { useTrayLanding } from "@grimoire/ui/features/scanner/useTrayLanding";
import {
  SCANNER_OPEN_ELSEWHERE,
  SCANNER_OPENS_HERE_LATER,
} from "@grimoire/ui/features/scanner/verdictText";
import { ConfirmDialog } from "@grimoire/ui/features/settings/ConfirmDialog";
import { plural } from "@grimoire/ui/lib/counts";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { ipcError, type ScanBatch, type ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { PRESS } from "@grimoire/ui/lib/motion";
import { notify } from "@grimoire/ui/lib/notifications";
import { cn } from "@grimoire/ui/lib/utils";
import { ReceiptBar } from "../deck/receipt";
import { useListReceipt } from "../lists/receipt";
import { navigate } from "../router";
import { CameraBox } from "../scanner/CameraBox";
import { HistorySheet } from "../scanner/HistorySheet";
import { HoldSurface } from "../scanner/HoldSurface";
import { OptionsSheet } from "../scanner/OptionsSheet";
import { ScanControls } from "../scanner/ScanControls";
import { ScannerDataSlot } from "../scanner/ScannerDataSlot";
import { Tray, type TrayWalk } from "../scanner/Tray";
import { TrayActionsSheet } from "../scanner/TrayActionsSheet";
import { destinationName, TrayBar } from "../scanner/TrayBar";
import { TrayPeek } from "../scanner/TrayPeek";
import { TraySheet } from "../scanner/TraySheet";
import { CREATE_DECK_FLOOR } from "./parts";

/**
 * The Scanner on the phone face: point the camera at a card, review what it took, file it.
 *
 * **Gated above the live page**, as the desktop's view is: one surface scans at a time, the scanner
 * is a lease the surface using it keeps renewing, and whether another holds it has to be answered
 * *before* the camera is asked for — the live page's own hooks open it as they mount. Nothing is
 * drawn, and no camera opened, until that one question has answered; a failed ask reads as "free",
 * because the live page's heartbeat is the real gate.
 *
 * **`destination` is this page filing somewhere else** — a side of a trade, from the sheet that
 * mounts it over the Trade page (`TrayDestination`). Absent, which is the Scanner tab, nothing
 * below differs from before the prop. With one, Add hands the ready rows to the destination and
 * wears its words, and the folder, *Create deck…*, *Archive* and *Scan history* are not drawn.
 * The tray is the same stored row, so cards already in it are in the list, and a line above the
 * tray says so.
 */
export function ScannerPage({ destination }: { destination?: TrayDestination }) {
  const elsewhere = useScannerElsewhere();
  if (elsewhere.data === true) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 text-sm">
        <p>{SCANNER_OPEN_ELSEWHERE}</p>
        <p className="text-dim">{SCANNER_OPENS_HERE_LATER}</p>
      </div>
    );
  }
  if (elsewhere.isPending) return <div className="min-h-0 flex-1" />;
  return <LiveScanner destination={destination} />;
}

/** The one question this page asks of the viewport besides the face's own width (`useFace`). */
const LANDSCAPE = "(orientation: landscape)";

function subscribeLandscape(onChange: () => void): () => void {
  const query = window.matchMedia(LANDSCAPE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isLandscape(): boolean {
  return window.matchMedia(LANDSCAPE).matches;
}

/**
 * **The phone is on its side** — the `landscape:` variant's own media query, asked from script for
 * the one thing a class cannot say: which shape of a component to draw (the Added popup's one
 * line, the hold prompt's short form). The arrangement itself is the classes', so the two always
 * agree. `useSyncExternalStore` and a fresh `matchMedia` per read, for `CardDetailModal`'s
 * `useFlankRoom`'s two reasons: no `setState` inside an effect, and no query built at import time,
 * before a test has said what the viewport is.
 */
function useLandscape(): boolean {
  return useSyncExternalStore(subscribeLandscape, isLandscape, () => false);
}

/**
 * **The desktop reader's parts, in the phone's own idioms.**
 *
 * Everything that decides anything is the desktop feature's, imported: the camera
 * (`useCamera`), the frame pump and its one-add-per-card edge (`useScanLoop`), the tray and the
 * prefs (`useTray`, `useScannerPrefs` — the same two rows the desktop face of this install reads),
 * the lease (`useScannerHold`), how a card lands (`useTrayLanding`), where it files and the commit
 * (`useTrayFolder`, `useTrayCommit`), the sentences (`readerText`, `verdictText`), and everything
 * laid over the picture (`ScanHud`, `PictureNotes`, `TierConfetti`, `AddedToast`). The desktop
 * *page* cannot be drawn here — it reads the app store and the window — so what is the phone's is
 * the arrangement, in `../scanner/`.
 *
 * **Upright, the page fits the screen and nothing scrolls** (the scanner redesign, 2026-10-24),
 * top to bottom: the tray's bar — the folder and Add, with the receipt line under it — then the
 * controls (`ScanControls`), **the picture, filling what is left** (`CameraBox`), the gold
 * Start/Stop (continuous only), and the tray's peek (`TrayPeek`), which opens the whole tray as a
 * sheet (`TraySheet`). Everything over the picture is the camera box's children: the HUD — the
 * progress bar, *Reset evidence* and *Send scan…* while continuous scanning runs, the chip for an
 * error — the stopped veil, point and shoot's prompt or held chip and its hold (`HoldSurface`),
 * the confetti and the Added popup.
 *
 * **On its side** (the `landscape:` variant, at any phone width) the same elements are laid out
 * by a grid: the controls, the picture and Start/Stop on the left; on the right, 22rem wide, the
 * tray's bar, its header (the count, the gold *N need you* that walks the questions, *Add card…*
 * and the `⋯`) and the whole list, scrolling by itself. No peek — the list it opens is there —
 * and the Added popup on one line. **Asked of the viewport, not a container**: the page's sheets
 * are mounted inside it, and a container is the containing block for a `fixed` scrim. The
 * list's column is in the page either way and only drawn on its side, so a turn of the phone
 * keeps the bar, the tray's place and every open sheet as they were.
 *
 * **Point and shoot is a hold of the picture itself** (`usePointAndShoot`, `HoldSurface`): it
 * reads while a finger is on it and pauses the moment it lifts. Under it there is no Start/Stop,
 * and no *Reset evidence* or *Send scan…* either — lifting the finger already ends the read.
 *
 * **The rules the desktop page holds, held here**:
 *
 * - **The camera stays shut until the prefs have loaded** (the stored camera is one of them), and
 *   the loop stays off until the prefs *and* the tray have — the first frame goes out under the
 *   stored filters, and a decision lands on the stored tray.
 * - **Every tray writer builds on `tray.latest()`**, never on the rows a render drew: the pump
 *   writes between two renders.
 * - **A commit and a clear subtract a snapshot**, because the camera keeps running behind the
 *   question: a card that landed meanwhile stays.
 * - **Stop pauses recognition and keeps the picture** (issue #774), session-only.
 *
 * **What a phone adds: the page parks itself.** With the document hidden — the app switched away
 * from, the screen locked — the pump stops at once, and after a grace the camera is closed and the
 * heartbeat with it, so no light stays on in a pocket and the lease lapses (`usePageParked`).
 * Leaving the page unmounts it, which stops every track.
 *
 * A page that *mounts* hidden opens no camera at all.
 *
 * **No developer panels**: they are the desktop's. The stored Developer switch is the desktop
 * face's and is neither read nor written.
 *
 * **On a host with no scanner session** — a web page, until the light app's web step
 * (`useScannerPrefs`' `unavailable`) — the prefs never count as loaded, so both gates below stay
 * shut: no camera is asked for and no frame is sent. The engine's sentence is drawn where the
 * picture would be, the HUD is not drawn (its status would say *Point the camera at a card* and
 * its Reset would ask a session that is not there), and the filters are refused with the
 * sentence, since one changed there would be drawn and never taken. The tray still reads, edits
 * and files: those are rows, and a page has the rows.
 */
function LiveScanner({ destination }: { destination: TrayDestination | undefined }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { prefs, update, inForce, filterError, loaded, unavailable } = useScannerPrefs();
  // The desktop's: stopped until Start is pressed (issue #1317), and session-only — a Start or
  // Stop survives the page being hidden and shown.
  const [scanning, setScanning] = useState(false);
  const parked = usePageParked();
  const landscape = useLandscape();
  // `undefined` until the prefs are in, which holds the camera shut; and again once the page has
  // been hidden past its grace — its tracks are stopped, and coming back asks afresh.
  const camera = useCamera(videoRef, loaded && !parked.released ? prefs.cameraId : undefined);
  // Keyed on the camera that opened: a browser names no camera until one has been granted.
  const cameras = useCameraDevices(camera.kind === "live" ? camera.deviceId : null);
  const tray = useTray();
  const { status, filtersDisabled } = useScannerStatus();

  useScannerHold(parked.released);

  const { onDecision, onPicked, lastAdded, landed, clearLanded, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
  );
  // *Add card…* (issue #978) — the desktop page's: the scanner pauses while the search is open,
  // and closing it resumes whatever was running before.
  const [picking, setPicking] = useState(false);
  const pickOpener = useRef<HTMLElement | null>(null);

  // *Send scan…*'s dialog is open, so recognition pauses (issue #977) — the desktop page's
  // `sending`, synced below `useScanSubmit` for its reason.
  const [sending, setSending] = useState(false);
  // Read above the loop, as on the desktop: a device that may send scans keeps its run's frames
  // at full resolution.
  const maySend = useMaySendScans();

  // The tray's whole list as a sheet over the upright page, and the peek that opened it.
  const [traySheetOpen, setTraySheetOpen] = useState(false);
  const traySheetOpener = useRef<HTMLElement | null>(null);
  // The options sheet, the page it opens on (the controls' Filters opens it on its filters page),
  // and the press that opened it.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsStart, setOptionsStart] = useState<"filters" | undefined>(undefined);
  const optionsOpener = useRef<HTMLElement | null>(null);
  // The tray's actions (`⋯`), and the press that opened them — the tray sheet's header, or the
  // list's on a phone on its side: *Create deck…*, *Clear all…* and *Scan history* hand the caret
  // back to it when their own dialog or sheet shuts.
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsOpener = useRef<HTMLElement | null>(null);
  // The scan history's sheet, and the press that opened it, for the caret.
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);
  // *Clear all…*: the rows the reader was asked about, and the press that asked, for the caret.
  const [clearing, setClearing] = useState<ScannerTrayRow[] | null>(null);
  const clearOpener = useRef<HTMLElement | null>(null);
  // *Create deck…*: the tray as it stood when the dialog opened.
  const [deckRows, setDeckRows] = useState<ScannerTrayRow[] | null>(null);
  const deckOpener = useRef<HTMLElement | null>(null);
  // Any of the page's own sheets or dialogs over the picture.
  const overlaid =
    traySheetOpen ||
    optionsOpen ||
    actionsOpen ||
    historyOpen ||
    clearing !== null ||
    deckRows !== null;

  // **Point and shoot** — the desktop page's, with this face's press: the picture itself, held,
  // reads, and pauses the moment it is let go (`usePointAndShoot`, `HoldSurface`). Anything that
  // pauses the pump ends the hold, and so does a sheet or dialog of the page's opening over the
  // picture, so a release lost behind a sheet or another app never leaves the scanner reading —
  // the surface's own blur says the same where a browser moved the caret, and this says it where
  // one did not. `reading` and `armed` are the desktop page's two words.
  const pointAndShoot = prefs.pointAndShoot;
  const shot = usePointAndShoot({
    on: pointAndShoot,
    interrupted: parked.paused || sending || picking || overlaid,
  });
  const reading = pointAndShoot ? shot.shooting : scanning;
  const armed = pointAndShoot || scanning;
  // The landing the popup is showing, if any — the confetti is thrown for that one and no other.
  const shownLanding = armed ? landed : null;
  // What the card over the camera costs — at the tray's marketplace, so it is its row's figure —
  // and the rung of the sound ladder it reaches, which colours the figure and sizes the confetti.
  const landedPrice = useLandedPrice(shownLanding, destination?.marketplace);
  const landedTier = useLandedTier(shownLanding, destination?.marketplace);
  // A sound for each card that lands and each row the reader settles — the desktop page's.
  useScanSounds({ landed, rows: tray.rows, at: destination?.marketplace });

  const loop = useScanLoop({
    videoRef,
    live:
      reading &&
      camera.kind === "live" &&
      loaded &&
      tray.loaded &&
      !parked.paused &&
      !sending &&
      !picking,
    keepFullFrames: maySend,
    onDecision: (decision) => {
      onDecision(decision);
      shot.landed();
    },
  });
  useRefusedElsewhere(loop.error);

  const { folderId, folderList } = useTrayFolder(prefs.folderId, loaded, update);
  // Archive (issue #989) is the commit's plan into the scan history instead, and shares its
  // in-flight state and its one refusal slot — the bar's alert says either press's refusal.
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
  });
  // The same press for a destination that is not the collection: its own write first, then the
  // tray's subtraction (`useTrayDestination`). Both hooks are called; one of them acts.
  const handOff = useTrayDestination({ tray, destination });

  /**
   * What the last Add did, as the phone's other writes report: one line under the tray's bar.
   * The commit never rejects — a refusal is `commitError`'s, drawn in the bar above the press —
   * so the line speaks only for a commit that went through. `Undo` is offered only where the
   * backend handed back a ticket, which for a tray commit it does not today (issue #555: the
   * filed lines left the stored tray in the same write).
   */
  const receipt = useListReceipt();
  const bulk = useBulkUndoAction("collection");
  const onCommit = () => {
    if (destination !== undefined) {
      // No `Undo`: the destination is its host's to edit, and the cards are on it to take off.
      receipt.track(handOff.commit(), (copies) =>
        copies === null ? null : `Added ${plural(copies, "card")} to ${destination.name}.`,
      );
      return;
    }
    receipt.track(
      commit(),
      (filed) => {
        if (filed === null) return null;
        // The folder's name where the list can say it; where it cannot — the list would not load,
        // and the stored id went to the backend as it stood — the line says no more than the
        // answer proves, which is that the copies are in the collection.
        const where = destinationName(folderList.folders, filed.folderId) ?? "your collection";
        return `Added ${plural(filed.copies, "copy", "copies")} to ${where}.`;
      },
      (filed) => {
        const ticket = filed?.outcome.undoId ?? null;
        return ticket === null
          ? null
          : { name: "take the scanned cards back out", run: () => bulk.take(ticket) };
      },
    );
  };

  /**
   * *Archive*: the rows an Add would take, kept in the scan history and filed nowhere. **One
   * toast, in the desktop's words** — the tray empties under the reader and the cards are not in
   * the collection, so the toast is what says where to find them again. No receipt line: there is
   * nothing to take back, and the toast already says it. A refusal is the bar's alert, as an
   * Add's is.
   */
  const onArchive = () => {
    void archive().then((kept) => {
      if (kept === null) return;
      notify.success(`Archived ${plural(kept.copies, "card")} to Scan history`);
    });
  };
  /**
   * *Put back in tray* (issue #1374): a past scan's lines into the tray, built on `tray.latest()`,
   * and the history closed so the reader sees them land. **One toast** — the cards are in the
   * tray, not the collection, so it says where they went and that the tray's Add files them; a
   * pile short of printings that have left the card database says so in its body.
   */
  const onPutBack = (batch: ScanBatch): boolean => {
    const outcome = putBack(tray, batch);
    if (!outcome.ok) {
      notify.error(`Couldn't put “${batch.summary.name}” back in the tray`, {
        body: outcome.sentence,
      });
      return false;
    }
    setHistoryOpen(false);
    historyOpener.current?.focus();
    notify.success(putBackTitle(batch.summary, outcome.copies), {
      body: leftOutSentence(outcome.left),
    });
    return true;
  };

  // A refusal to reset has somewhere to go: the chip over the picture, cleared by the next press.
  const [resetError, setResetError] = useState<string | null>(null);
  const onReset = () => {
    setResetError(null);
    // The pump clears locally first, then drains the old frame before resetting the session.
    loop.reset().catch((e: unknown) => setResetError(ipcError(e)));
  };

  const scannedDeck = useScannedDeck(deckRows ?? []);
  const newDeckFormat = useNewDeckFormat();

  // *Send scan…*: the last couple of seconds the scanner was shown, to its maker, under the card
  // a reader says the last of them shows — the desktop page's hook and its dialog, both shared.
  // **A run, never one picture**: the frames are the pump's own (`loop.recent`), so the press
  // grabs nothing. **Offered only while there can be one** — a camera live and recognition
  // running: stopped, the pump has let its frames go and is sending none, and no press is drawn.
  // **And only on the Scanner tab itself — never over a trade** (the owner's decision,
  // 2026-10-11): with a `destination` this page is already a sheet, and its reader is in the
  // middle of something else.
  // **And only for a supporter** (the owner's decision; the shared `useMaySendScans`) — the
  // third condition, and the one with no sentence anywhere: a device that is not a supporter's,
  // or whose membership has not been read yet, sees no press and not a word about why. This is
  // the face the Play build draws, which may not lead a reader to a membership bought elsewhere,
  // so nothing here hints at one. A lapse while the dialog is open is the engine's to refuse.
  // **The filters it says are the ones in force** (`inForce`), not the ones the sheet is drawing:
  // `prefs.filters` moves before the session has taken a change, and goes back if it is refused.
  const sendable = destination === undefined && maySend && camera.kind === "live" && reading;
  const submit = useScanSubmit({
    recent: loop.recent,
    verdict: loop.verdict,
    filters: inForce,
    ready: sendable,
  });
  // **Recognition pauses while the dialog is open** (issue #977), as on the desktop: a card left
  // under the lens must not land in the tray while the reader picks a printing.
  if (sending !== (submit.run !== null)) setSending(submit.run !== null);
  // **A run never spans a change of filters**, as on the desktop: the session drops its tracker
  // to take a changed set, which the pump cannot see, so when the filters in force move the
  // frames kept so far are let go (`ScanLoop.breakRun`). The one extra run at mount empties a
  // ring nothing has reached yet.
  const { breakRun } = loop;
  useEffect(() => {
    breakRun();
  }, [inForce, breakRun]);

  // **The HUD's two presses are continuous scanning's alone** — while it runs, never under point
  // and shoot, where lifting the finger already ends the read. *Send scan…* by `sendable` besides.
  const hudPresses = !pointAndShoot && scanning;
  // What the chip over the picture has to say while recognition runs: the loop's failures, a
  // refused reset and a Send scan pressed too soon — a busy database, a frame the host turned
  // away, a camera that has only just started. The detector's own refusal (no card in this
  // frame) is a developer's sentence and is not said here. **Not running, the picture's own note
  // is the whole of what is said** (`StoppedVeil`, `HoldPrompt`): the press is not drawn there,
  // and the hook drops its sentence with the press. **A Send scan that opened nothing is never
  // silent** — one that said nothing is a button that looks broken.
  const hudNote = reading ? (loop.error ?? resetError ?? submit.error) : null;
  // The picture's notes and its hold stand only over a picture: not over the camera's own
  // refusal, nor a host with no session, each of which is said where the picture would be.
  const pictureUp = unavailable === null && camera.kind !== "error";
  // The confetti for the landing the popup is showing, at the tier its price reaches — none below
  // the first rung, unpriced, or for a landing that asks the reader something.
  const burst =
    shownLanding !== null && landedTier !== null
      ? { stamp: shownLanding.stamp, tier: landedTier }
      : null;

  const openActions = (opener: HTMLElement) => {
    actionsOpener.current = opener;
    setActionsOpen(true);
  };
  const openAddCard = (opener: HTMLElement) => {
    pickOpener.current = opener;
    setPicking(true);
  };
  // The tray's walk through its open questions, for the list's header on a phone on its side.
  const walk = useRef<TrayWalk>(null);

  /**
   * The tray's bar — one drawing for the page and one for the tray sheet (`TraySheet`'s `bar`),
   * each with its own folder sheet over the same pref and the same commit. `quiet` keeps the
   * page's own copy from saying a refusal while the sheet's copy over it is saying the same one.
   */
  const trayBar = (quiet: boolean) => (
    <TrayBar
      rows={tray.rows}
      folders={folderList.folders}
      foldersPending={folderList.query.isPending}
      folderId={folderId}
      condition={prefs.condition}
      onFolder={(id) => {
        // A press on the folder already chosen writes nothing.
        if (id !== prefs.folderId) update({ folderId: id });
      }}
      onCommit={onCommit}
      committing={destination === undefined ? committing : handOff.committing}
      commitError={quiet ? null : destination === undefined ? commitError : handOff.error}
      archiving={destination === undefined && archiving}
      destination={destination}
    />
  );

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          "landscape:grid landscape:grid-cols-[minmax(0,1fr)_22rem]",
          "landscape:grid-rows-[auto_auto_minmax(0,1fr)]",
        )}
      >
        {/* The folder and Add, and what the last Add did — the page's head upright, the tray
            column's head on its side. */}
        <div
          data-scanner-bar=""
          className="shrink-0 landscape:col-start-2 landscape:row-start-1 landscape:border-l landscape:border-border"
        >
          {trayBar(traySheetOpen)}
          {/* Muted while the tray sheet is open: its own copy, under its bar, says the line. */}
          <ReceiptBar receipt={receipt} muted={traySheetOpen} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3 landscape:col-start-1 landscape:row-span-3 landscape:row-start-1">
          <ScanControls
            pointAndShoot={pointAndShoot}
            onPointAndShoot={(on) => {
              // Either way the page lands stopped, as on the desktop: a hold ends with the pref,
              // and Start is pressed afresh.
              setScanning(false);
              update({ pointAndShoot: on });
            }}
            onFilters={(opener) => {
              optionsOpener.current = opener;
              setOptionsStart("filters");
              setOptionsOpen(true);
            }}
            onOptions={(opener) => {
              optionsOpener.current = opener;
              setOptionsStart(undefined);
              setOptionsOpen(true);
            }}
          />
          <CameraBox
            videoRef={videoRef}
            camera={camera}
            verdict={reading ? loop.verdict : null}
            unavailable={unavailable}
          >
            {pictureUp &&
              (pointAndShoot ? (
                shot.shooting ? (
                  <HeldChip />
                ) : (
                  <HoldPrompt compact={landscape} />
                )
              ) : (
                !scanning && <StoppedVeil />
              ))}
            {pictureUp && pointAndShoot && (
              <HoldSurface
                shooting={shot.shooting}
                onHold={(held) => (held ? shot.start(loop.clearReads, "release") : shot.stop())}
                onTap={() => (shot.shooting ? shot.stop() : shot.start(loop.clearReads, "card"))}
              />
            )}
            {/* Before the popup, so the pieces fly from behind it. */}
            <TierConfetti burst={burst} originBottom={landscape ? 36 : undefined} />
            <AddedToast
              card={shownLanding}
              onDone={clearLanded}
              price={landedPrice}
              tier={landedTier}
              compact={landscape}
            />
            {unavailable === null && (
              <ScanHud
                strip={matchStrip(reading ? loop.verdict : null, lastAdded)}
                live={reading && camera.kind === "live"}
                variant="icon"
                onReset={hudPresses ? onReset : undefined}
                // Offered only where `sendable` says, as on the desktop: a run to send, the
                // Scanner tab itself, and a supporter's device. With no camera live the box is
                // saying why not; of the membership nothing is said at all.
                onSend={hudPresses && sendable ? submit.open : undefined}
                note={hudNote}
              />
            )}
          </CameraBox>
          {/* What the status still has to say of the scanner's own files. */}
          <ScannerDataSlot status={status} />
          {/* Continuous only: under point and shoot the picture itself is the press. */}
          {!pointAndShoot && (
            <button
              type="button"
              onClick={() => setScanning(!scanning)}
              className={cn(
                "inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-accent",
                "text-sm font-semibold text-accent-fg",
                PRESS,
                FOCUS,
              )}
            >
              {scanning ? (
                <Square aria-hidden className="size-3.5" />
              ) : (
                <Play aria-hidden className="size-3.5" />
              )}
              {scanning ? STOP : START}
            </button>
          )}
        </div>

        {/* A destination's warning that the tray was not empty when this opened — over the
            peek upright, over the list on its side. A note, not an alert: nothing has gone
            wrong, and it is there from the first paint. */}
        {handOff.notice !== null && (
          <div className="shrink-0 px-4 pb-2 landscape:col-start-2 landscape:row-start-2 landscape:border-l landscape:border-border landscape:pt-2">
            <p
              role="note"
              className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-snug"
            >
              {handOff.notice}
            </p>
          </div>
        )}

        {/* Upright: the newest cards, a press away from the whole tray. */}
        <div data-tray-peek-slot="" className="shrink-0 landscape:hidden">
          <TrayPeek
            rows={tray.rows}
            flashKey={flashKey}
            title={destination?.title}
            onOpen={(opener) => {
              traySheetOpener.current = opener;
              setTraySheetOpen(true);
            }}
          />
        </div>

        {/* On its side: the whole tray, its header over the one scroller. In the page upright
            too, undrawn, so a turn of the phone keeps the list's place. */}
        <div
          data-tray-column=""
          className="hidden min-h-0 flex-col landscape:col-start-2 landscape:row-start-3 landscape:flex landscape:border-l landscape:border-border"
        >
          <TrayHeader
            title={destination?.title ?? "Scanned cards"}
            rows={tray.rows}
            onNext={() => walk.current?.next()}
            onAddCard={openAddCard}
            onActions={openActions}
          />
          {/* `relative` because a row's `sr-only` words are positioned, and the box carrying the
              overflow has to hold them. */}
          <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
            <Tray
              ref={walk}
              header={false}
              rows={tray.rows}
              onRows={(change) => tray.setRows(change(tray.latest()))}
              flashKey={flashKey}
              title={destination?.title}
              marketplace={destination?.marketplace}
            />
          </div>
        </div>
      </div>

      {/* **First of the page's sheets and dialogs**: they all paint at the one overlay rung, so
          document order is their stacking, and every one below can open over this one — the one
          Escape and Back close first has to be the one drawn on top. */}
      <TraySheet
        open={traySheetOpen}
        onClose={() => setTraySheetOpen(false)}
        onDismiss={() => {
          setTraySheetOpen(false);
          traySheetOpener.current?.focus();
        }}
        title={destination?.title}
        rows={tray.rows}
        onRows={(change) => tray.setRows(change(tray.latest()))}
        flashKey={flashKey}
        marketplace={destination?.marketplace}
        onAddCard={openAddCard}
        onActions={openActions}
        bar={
          <>
            {trayBar(false)}
            <ReceiptBar receipt={receipt} />
          </>
        }
      />

      <TrayActionsSheet
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
        onDismiss={() => {
          setActionsOpen(false);
          actionsOpener.current?.focus();
        }}
        rows={tray.rows}
        committing={destination === undefined ? committing : handOff.committing}
        archiving={destination === undefined && archiving}
        destination={destination}
        onCreateDeck={() => {
          deckOpener.current = actionsOpener.current;
          scannedDeck.reset();
          setDeckRows([...tray.latest()]);
        }}
        onClearAll={() => {
          clearOpener.current = actionsOpener.current;
          setClearing(tray.latest());
        }}
        // The archive and its history are the Scanner tab's own record: over a trade the page is
        // already a sheet, and files somewhere else (the sheet hides both for one too).
        onArchive={destination === undefined ? onArchive : undefined}
        onHistory={
          destination === undefined
            ? () => {
                historyOpener.current = actionsOpener.current;
                setHistoryOpen(true);
              }
            : undefined
        }
      />

      <OptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onDismiss={() => {
          setOptionsOpen(false);
          optionsOpener.current?.focus();
        }}
        startPage={optionsStart}
        filters={prefs.filters}
        onFilters={(filters) => update({ filters })}
        filterError={filterError}
        // A host with no session has nothing to narrow: a filter changed there would be drawn,
        // never taken and never stored.
        filtersDisabled={unavailable ?? filtersDisabled}
        finish={prefs.finish}
        onFinish={(finish) => update({ finish })}
        condition={prefs.condition}
        onCondition={(condition) => update({ condition })}
        cameras={cameras}
        // The camera that opened; while a switch is starting, the one asked for.
        cameraId={camera.kind === "live" ? camera.deviceId : prefs.cameraId}
        // A press on the camera already chosen changes nothing, and must not restart the stream.
        onCamera={(cameraId) => {
          if (cameraId !== prefs.cameraId) update({ cameraId });
        }}
      />

      <ConfirmDialog
        open={clearing !== null}
        title="Clear the tray"
        confirmLabel="Clear tray"
        // Nothing typed: these are scans waiting for review, not copies the collection holds.
        typeToConfirm={false}
        pending={false}
        onConfirm={() => {
          if (clearing === null) return;
          // The rows that were asked about, not the tray at the moment of Confirm: the camera
          // keeps running behind the question, and a card that landed meanwhile stays.
          tray.setRows(withoutCommitted(tray.latest(), clearing));
        }}
        onDismiss={() => {
          setClearing(null);
          clearOpener.current?.focus();
        }}
        onClose={() => setClearing(null)}
      >
        {plural(clearing === null ? 0 : totalCopies(clearing), "scanned copy", "scanned copies")}{" "}
        will leave the tray without being added to {destination?.name ?? "your collection"}. Cards
        you scan while this is open stay.
      </ConfirmDialog>

      <HistorySheet
        open={historyOpen}
        onPutBack={onPutBack}
        onClose={() => setHistoryOpen(false)}
        onDismiss={() => {
          setHistoryOpen(false);
          historyOpener.current?.focus();
        }}
      />

      {/* The shared dialog, mounted bare: its controls take a finger's size from the shared
          recipes, so it needs no floor reached in from here as the desktop's New deck does. */}
      <SubmitScanDialog run={submit.run} onDismiss={submit.onDismiss} onClose={submit.onClose} />

      {/* Into the staging tray, so no toast — a scan's rule; the tray's Add is the write. */}
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

      <div className={CREATE_DECK_FLOOR}>
        <CreateDeckDialog
          open={deckRows !== null}
          create={scannedDeck}
          defaultFormatKey={newDeckFormat}
          intro={`${totalCopies(deckRows ?? [])} scanned copies will be filed into automatic categories. The scans stay in the tray so you can also add them to your collection.`}
          onCreated={(deck) => {
            setDeckRows(null);
            // The new deck's own page, a push — Back is the scanner it was made from.
            navigate({ view: "decks", deckId: deck.id, cardId: null });
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
      </div>
    </>
  );
}

/** A 44px press in the list's header: *Add card…* and the `⋯`. */
const HEADER_PRESS = cn(
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border",
  PRESS,
  FOCUS,
);

/**
 * The tray's header over the list on a phone on its side — the desktop tray's header in the
 * phone's sizes (the scanner redesign, 2026-10-24): the title and the copy count, a gold
 * **_N need you_** while any card waits on a printing or a finish, which walks to the next one
 * (`Tray`'s own walk, through `TrayWalk`), then *Add card…* and the `⋯` that opens the tray's
 * actions. It wraps rather than truncating the presses: the column is 22rem, and the walk, while
 * it is drawn, takes the room *Add card…* needed.
 *
 * Upright the same four things are the peek's line and the tray sheet's header.
 */
function TrayHeader({
  title,
  rows,
  onNext,
  onAddCard,
  onActions,
}: {
  title: string;
  rows: readonly ScannerTrayRow[];
  /** Walk to the next card waiting on the reader. */
  onNext: () => void;
  /** *Add card…* — handed the press, for the caret. */
  onAddCard: (opener: HTMLElement) => void;
  /** The `⋯` — handed the press, for the caret. */
  onActions: (opener: HTMLElement) => void;
}) {
  const copies = totalCopies(rows);
  const waiting = rows.filter(needsDecision).length;
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5">
      {/* The name is spelled, not computed: the title and its count are two elements a gap apart,
          which the name algorithm fuses into `Scanned cards3`. */}
      <h2
        aria-label={`${title}, ${plural(copies, "copy", "copies")}`}
        className="flex min-w-0 items-baseline gap-2 font-heading text-lg leading-none"
      >
        <span className="truncate">{title}</span>
        <span aria-hidden="true" className="font-mono text-sm tabular-nums text-dim">
          {copies}
        </span>
      </h2>
      {/* Hidden rather than greyed when nothing is waiting: a control that can do nothing is one
          a reader keeps trying. Its name is both halves — how many, and what the press does. */}
      {waiting > 0 && (
        <button
          type="button"
          aria-label={`${needYouLabel(waiting)}: ${NEXT_DECISION_LABEL}`}
          onClick={onNext}
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 px-3",
            "text-xs font-medium text-accent",
            PRESS,
            FOCUS,
          )}
        >
          <ArrowDown aria-hidden className="size-3.5" />
          {needYouLabel(waiting)}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={(e) => onAddCard(e.currentTarget)}
          className={cn(HEADER_PRESS, "px-3 text-xs text-text")}
        >
          <Plus aria-hidden className="size-3.5" />
          {ADD_CARD_LABEL}
        </button>
        <button
          type="button"
          aria-label="Tray actions"
          aria-haspopup="dialog"
          onClick={(e) => onActions(e.currentTarget)}
          className={cn(HEADER_PRESS, "w-11 text-dim")}
        >
          <Ellipsis aria-hidden className="size-5" />
        </button>
      </div>
    </header>
  );
}
