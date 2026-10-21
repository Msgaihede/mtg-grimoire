import { useEffect, useMemo, useRef, useState } from "react";
import { useBulkUndoAction } from "@grimoire/ui/components/UndoNotice";
import { CreateDeckDialog } from "@grimoire/ui/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@grimoire/ui/features/decks/useNewDeckFormat";
import { AddCardDialog } from "@grimoire/ui/features/scanner/reader/AddCardDialog";
import { AddedToast } from "@grimoire/ui/features/scanner/reader/AddedToast";
import { SCANNING_STOPPED } from "@grimoire/ui/features/scanner/reader/readerText";
import { totalCopies } from "@grimoire/ui/features/scanner/reader/tray";
import { withoutCommitted } from "@grimoire/ui/features/scanner/reader/trayCommit";
import { useLandedPrice } from "@grimoire/ui/features/scanner/reader/useLandedPrice";
import {
  DEFAULT_DETAIL_WAIT_MS,
  DEFAULT_SCANNER_OPTIONS,
  DEFAULT_SEND_PX,
  frameOptions,
} from "@grimoire/ui/features/scanner/scannerOptions";
import { SubmitScanDialog } from "@grimoire/ui/features/scanner/submit/SubmitScanDialog";
import { useMaySendScans } from "@grimoire/ui/features/scanner/submit/useMaySendScans";
import { useScanSubmit } from "@grimoire/ui/features/scanner/submit/useScanSubmit";
import { useCamera, useCameraDevices } from "@grimoire/ui/features/scanner/useCamera";
import { usePageParked } from "@grimoire/ui/features/scanner/useParked";
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
import { ipcError, type ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { notify } from "@grimoire/ui/lib/notifications";
import { cn } from "@grimoire/ui/lib/utils";
import { ReceiptBar } from "../deck/receipt";
import { useListReceipt } from "../lists/receipt";
import { navigate } from "../router";
import { CameraBox } from "../scanner/CameraBox";
import { HistorySheet } from "../scanner/HistorySheet";
import { MatchLine } from "../scanner/MatchLine";
import { OptionsSheet } from "../scanner/OptionsSheet";
import { ScanControls } from "../scanner/ScanControls";
import { ScannerDataSlot } from "../scanner/ScannerDataSlot";
import { Tray } from "../scanner/Tray";
import { destinationName, TrayFooter } from "../scanner/TrayFooter";
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

/**
 * **The desktop reader's parts, in the phone's own idioms.**
 *
 * Everything that decides anything is the desktop feature's, imported: the camera
 * (`useCamera`), the frame pump and its one-add-per-card edge (`useScanLoop`), the tray and the
 * prefs (`useTray`, `useScannerPrefs` — the same two rows the desktop face of this install reads),
 * the lease (`useScannerHold`), how a card lands (`useTrayLanding`), where it files and the commit
 * (`useTrayFolder`, `useTrayCommit`), the sentences (`readerText`, `verdictText`), and the two
 * things laid over the picture (`Overlay`, `AddedToast`). The desktop *page* cannot be drawn here —
 * it reads the app store and the window, and lays a 25rem tray beside the camera — so what is the
 * phone's is the arrangement, in `../scanner/`: a bar with one `Options` press in place of four
 * popovers, the camera shaped by its stream, the status line folded onto two lines, the tray as
 * rows a thumb can work, and a footer that stays put.
 *
 * **Top to bottom, in one scroller**: the bar, the camera, the status line, the tray. **The footer
 * is outside it** — the destination and Add are what the tray is for, and a reader forty cards
 * down still has them. **From 720px wide** (a phone on its side, a tablet) the camera's column and
 * the tray's stand side by side, each scrolling by itself, with the footer under the tray; the
 * scroller is then no box at all, so its two children are laid out by the page's grid. The tray's
 * column is 22rem, a little over the 328px its rows were measured in at 360, and the camera takes
 * the rest. **Not from 600**, where the frame's rail begins: tried there, the page between the
 * rail and the edge is 520px, which left the tray a 288px column — its printing press 43px wide —
 * beside a camera 200px across. Between 600 and 720 it is the phone's one column, wider.
 *
 * **The rules the desktop page holds, held here**:
 *
 * - **The camera stays shut until the prefs have loaded** (the stored camera is one of them), and
 *   the loop stays off until the prefs *and* the tray have — the first frame goes out in the stored
 *   mode under the stored filters, and a decision lands on the stored tray.
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
 * **Nothing here asks the engine for previews**: the developer panels that draw them are the
 * desktop's. The stored Developer switch is the desktop face's and is neither read nor written.
 *
 * **On a host with no scanner session** — a web page, until the light app's web step
 * (`useScannerPrefs`' `unavailable`) — the prefs never count as loaded, so both gates below stay
 * shut: no camera is asked for and no frame is sent. The engine's sentence is drawn where the
 * picture would be, the status line and its Reset are not drawn (one would say *Point the camera
 * at a card* and the other would ask a session that is not there), and the filters are refused
 * with the sentence, since one changed there would be drawn and never taken. The tray still
 * reads, edits and files: those are rows, and a page has the rows.
 */
function LiveScanner({ destination }: { destination: TrayDestination | undefined }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { prefs, update, inForce, filterError, loaded, unavailable, resync } = useScannerPrefs();
  // The desktop's: stopped until Start scanning is pressed (issue #1317), and session-only — a
  // Start or Stop survives the page being hidden and shown.
  const [scanning, setScanning] = useState(false);
  const parked = usePageParked();
  // `undefined` until the prefs are in, which holds the camera shut; and again once the page has
  // been hidden past its grace — its tracks are stopped, and coming back asks afresh.
  const camera = useCamera(videoRef, loaded && !parked.released ? prefs.cameraId : undefined);
  // Keyed on the camera that opened: a browser names no camera until one has been granted.
  const cameras = useCameraDevices(camera.kind === "live" ? camera.deviceId : null);
  const tray = useTray();
  const { status, hasBundle, filtersDisabled } = useScannerStatus();

  useScannerHold(parked.released);

  const { onDecision, onPicked, lastAdded, landed, clearLanded, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
  );
  // What the card over the camera costs — at the tray's marketplace, so it is its row's figure.
  const landedPrice = useLandedPrice(scanning ? landed : null, destination?.marketplace);

  // The crate's defaults, in the reader's mode, and never with previews.
  // *Add card…* (issue #978) — the desktop page's: the scanner pauses while the search is open,
  // and closing it resumes whatever was running before.
  const [picking, setPicking] = useState(false);
  const pickOpener = useRef<HTMLElement | null>(null);

  const options = useMemo(
    () => frameOptions(DEFAULT_SCANNER_OPTIONS, prefs.mode, false),
    [prefs.mode],
  );
  // *Send scan…*'s dialog is open, so recognition pauses (issue #977) — the desktop page's
  // `sending`, synced below `useScanSubmit` for its reason.
  const [sending, setSending] = useState(false);
  const loop = useScanLoop({
    videoRef,
    live:
      scanning &&
      camera.kind === "live" &&
      loaded &&
      tray.loaded &&
      !parked.paused &&
      !sending &&
      !picking,
    options,
    sendPx: DEFAULT_SEND_PX,
    detailWaitMs: DEFAULT_DETAIL_WAIT_MS,
    onDecision,
  });
  useRefusedElsewhere(loop.error);

  const { folderId, folderList } = useTrayFolder(prefs.folderId, loaded, update);
  // Archive (issue #989) is the commit's plan into the scan history instead, and shares its
  // in-flight state and its one refusal slot — the footer's alert says either press's refusal.
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
   * What the last Add did, as the phone's other writes report: one line at the foot of the page.
   * The commit never rejects — a refusal is `commitError`'s, drawn in the footer above the press —
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
   * nothing to take back, and the toast already says it. A refusal is the footer's alert, as an
   * Add's is.
   */
  const onArchive = () => {
    void archive().then((kept) => {
      if (kept === null) return;
      notify.success(`Archived ${plural(kept.copies, "card")} to Scan history`);
    });
  };
  // The scan history's sheet, and the press that opened it, for the caret.
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyOpener = useRef<HTMLElement | null>(null);

  // A refusal to reset has somewhere to go: the line over the picture, cleared by the next press.
  const [resetError, setResetError] = useState<string | null>(null);
  const onReset = () => {
    setResetError(null);
    // The pump clears locally first, then drains the old frame before resetting the session.
    loop.reset().catch((e: unknown) => setResetError(ipcError(e)));
  };

  // *Clear all…*: the rows the reader was asked about, and the press that asked, for the caret.
  const [clearing, setClearing] = useState<ScannerTrayRow[] | null>(null);
  const clearOpener = useRef<HTMLElement | null>(null);

  // *Create deck…*: the tray as it stood when the dialog opened.
  const [deckRows, setDeckRows] = useState<ScannerTrayRow[] | null>(null);
  const deckOpener = useRef<HTMLElement | null>(null);
  const scannedDeck = useScannedDeck(deckRows ?? []);
  const newDeckFormat = useNewDeckFormat();

  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsOpener = useRef<HTMLElement | null>(null);

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
  const maySend = useMaySendScans();
  const sendable = destination === undefined && maySend && camera.kind === "live" && scanning;
  const submit = useScanSubmit({
    recent: loop.recent,
    verdict: loop.verdict,
    mode: prefs.mode,
    status,
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

  // What the picture has to say: that recognition is stopped, or the loop's failures, a refused
  // reset and a Send scan pressed too soon — a busy database, a frame the host turned away, a
  // camera that has only just started. The detector's own refusal (no card in this frame) is a
  // developer's sentence and is not said here. Nothing on a host with no session, where the box
  // holds the engine's sentence instead.
  //
  // **A Send scan that opened nothing is never silent** — one that said nothing is a button that
  // looks broken. Stopped, the line is the stopped sentence's alone: the press is not drawn
  // there, and the hook drops its sentence with the press.
  const cameraNote =
    unavailable !== null
      ? null
      : !scanning
        ? SCANNING_STOPPED
        : (loop.error ?? resetError ?? submit.error);

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col min-[720px]:grid",
          "min-[720px]:grid-cols-[minmax(0,1fr)_22rem]",
          "min-[720px]:grid-rows-[minmax(0,1fr)_auto]",
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain min-[720px]:contents">
          <div className="flex flex-col gap-3 px-4 pt-3 pb-3 min-[720px]:row-span-2 min-[720px]:min-h-0 min-[720px]:overflow-y-auto">
            <ScanControls
              scanning={scanning}
              onScanning={setScanning}
              mode={prefs.mode}
              onMode={(mode) => update({ mode })}
              onOptions={(opener) => {
                optionsOpener.current = opener;
                setOptionsOpen(true);
              }}
            />
            <CameraBox
              videoRef={videoRef}
              camera={camera}
              verdict={scanning ? loop.verdict : null}
              note={cameraNote}
              unavailable={unavailable}
            >
              <AddedToast
                card={scanning ? landed : null}
                onDone={clearLanded}
                price={landedPrice}
              />
            </CameraBox>
            {/* The scanner's files, where this install owes them. When a download lands the
                engine's session is a new one: it is given the reader's filters again, and what
                the last one said is dropped, so the next verdict starts a stream of its own. */}
            <ScannerDataSlot
              status={status}
              onLoaded={() => {
                resync();
                loop.clearReads();
              }}
            />
            {unavailable === null && (
              <MatchLine
                verdict={scanning ? loop.verdict : null}
                mode={prefs.mode}
                lastAdded={lastAdded}
                hasBundle={hasBundle}
                lastResolution={loop.lastResolution}
                onReset={onReset}
                // Offered only where `sendable` says, as on the desktop: a run to send, the
                // Scanner tab itself, and a supporter's device. With no camera live, or stopped,
                // the box above is saying why not; of the membership nothing is said at all.
                onSend={sendable ? submit.open : undefined}
              />
            )}
          </div>
          <div className="px-4 pb-3 min-[720px]:min-h-0 min-[720px]:overflow-y-auto min-[720px]:border-l min-[720px]:border-border min-[720px]:pt-2">
            {/* A destination's warning that the tray was not empty when this opened — above the
                rows it is about. A note, not an alert: nothing has gone wrong, and it is there
                from the first paint. */}
            {handOff.notice !== null && (
              <p
                role="note"
                className="mb-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-snug"
              >
                {handOff.notice}
              </p>
            )}
            <Tray
              rows={tray.rows}
              onRows={(change) => tray.setRows(change(tray.latest()))}
              flashKey={flashKey}
              title={destination?.title}
              marketplace={destination?.marketplace}
              onAddCard={(opener) => {
                pickOpener.current = opener;
                setPicking(true);
              }}
            />
          </div>
        </div>

        <div className="shrink-0 min-[720px]:col-start-2 min-[720px]:border-l min-[720px]:border-border">
          <ReceiptBar receipt={receipt} />
          <TrayFooter
            rows={tray.rows}
            folders={folderList.folders}
            foldersPending={folderList.query.isPending}
            folderId={folderId}
            onFolder={(id) => {
              // A press on the folder already chosen writes nothing.
              if (id !== prefs.folderId) update({ folderId: id });
            }}
            onCommit={onCommit}
            committing={destination === undefined ? committing : handOff.committing}
            commitError={destination === undefined ? commitError : handOff.error}
            destination={destination}
            onCreateDeck={(opener) => {
              deckOpener.current = opener;
              scannedDeck.reset();
              setDeckRows([...tray.latest()]);
            }}
            onClearAll={(opener) => {
              clearOpener.current = opener;
              setClearing(tray.latest());
            }}
            // The archive and its history are the Scanner tab's own record: over a trade the page
            // is already a sheet, and files somewhere else (the footer hides both for one too).
            onArchive={destination === undefined ? onArchive : undefined}
            archiving={destination === undefined && archiving}
            onHistory={
              destination === undefined
                ? (opener) => {
                    historyOpener.current = opener;
                    setHistoryOpen(true);
                  }
                : undefined
            }
          />
        </div>
      </div>

      <OptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onDismiss={() => {
          setOptionsOpen(false);
          optionsOpener.current?.focus();
        }}
        mode={prefs.mode}
        onMode={(mode) => update({ mode })}
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
