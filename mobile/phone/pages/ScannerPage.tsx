import { useMemo, useRef, useState } from "react";
import { useBulkUndoAction } from "@/components/UndoNotice";
import { CreateDeckDialog } from "@/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@/features/decks/useNewDeckFormat";
import { AddedToast } from "@/features/scanner/reader/AddedToast";
import { SCANNING_STOPPED } from "@/features/scanner/reader/readerText";
import { totalCopies } from "@/features/scanner/reader/tray";
import { withoutCommitted } from "@/features/scanner/reader/trayCommit";
import {
  DEFAULT_DETAIL_WAIT_MS,
  DEFAULT_SCANNER_OPTIONS,
  DEFAULT_SEND_PX,
  frameOptions,
} from "@/features/scanner/scannerOptions";
import { useCamera, useCameraDevices } from "@/features/scanner/useCamera";
import { usePageParked } from "@/features/scanner/useParked";
import { useScanLoop } from "@/features/scanner/useScanLoop";
import { useScannedDeck } from "@/features/scanner/useScannedDeck";
import { useScannerElsewhere } from "@/features/scanner/useScannerElsewhere";
import { useRefusedElsewhere, useScannerHold } from "@/features/scanner/useScannerHold";
import { useScannerPrefs } from "@/features/scanner/useScannerPrefs";
import { useScannerStatus } from "@/features/scanner/useScannerStatus";
import { useTray } from "@/features/scanner/useTray";
import { useTrayCommit, useTrayFolder } from "@/features/scanner/useTrayCommit";
import { useTrayLanding } from "@/features/scanner/useTrayLanding";
import {
  SCANNER_OPEN_ELSEWHERE,
  SCANNER_OPENS_HERE_LATER,
} from "@/features/scanner/verdictText";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { plural } from "@/lib/counts";
import { ipcError, type ScannerTrayRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { ReceiptBar } from "../deck/receipt";
import { useListReceipt } from "../lists/receipt";
import { navigate } from "../router";
import { CameraBox } from "../scanner/CameraBox";
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
 */
export function ScannerPage() {
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
  return <LiveScanner />;
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
function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { prefs, update, filterError, loaded, unavailable } = useScannerPrefs();
  // Session-only, the desktop's: a deliberate Stop survives the page being hidden and shown.
  const [scanning, setScanning] = useState(true);
  const parked = usePageParked();
  // `undefined` until the prefs are in, which holds the camera shut; and again once the page has
  // been hidden past its grace — its tracks are stopped, and coming back asks afresh.
  const camera = useCamera(videoRef, loaded && !parked.released ? prefs.cameraId : undefined);
  // Keyed on the camera that opened: a browser names no camera until one has been granted.
  const cameras = useCameraDevices(camera.kind === "live" ? camera.deviceId : null);
  const tray = useTray();
  const { status, hasBundle, filtersDisabled } = useScannerStatus();

  useScannerHold(parked.released);

  const { onDecision, lastAdded, landed, clearLanded, flashKey } = useTrayLanding(
    tray,
    prefs.finish,
  );

  // The crate's defaults, in the reader's mode, and never with previews.
  const options = useMemo(
    () => frameOptions(DEFAULT_SCANNER_OPTIONS, prefs.mode, false),
    [prefs.mode],
  );
  const loop = useScanLoop({
    videoRef,
    live: scanning && camera.kind === "live" && loaded && tray.loaded && !parked.paused,
    options,
    sendPx: DEFAULT_SEND_PX,
    detailWaitMs: DEFAULT_DETAIL_WAIT_MS,
    onDecision,
  });
  useRefusedElsewhere(loop.error);

  const { folderId, folderList } = useTrayFolder(prefs.folderId, loaded, update);
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

  // What the picture has to say: that recognition is stopped, or the loop's failures and a
  // refused reset — a busy database, a frame the host turned away. The detector's own refusal (no
  // card in this frame) is a developer's sentence and is not said here. Nothing on a host with no
  // session, where the box holds the engine's sentence instead.
  const cameraNote =
    unavailable !== null ? null : !scanning ? SCANNING_STOPPED : (loop.error ?? resetError);

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
              <AddedToast card={scanning ? landed : null} onDone={clearLanded} />
            </CameraBox>
            <ScannerDataSlot status={status} />
            {unavailable === null && (
              <MatchLine
                verdict={scanning ? loop.verdict : null}
                mode={prefs.mode}
                lastAdded={lastAdded}
                hasBundle={hasBundle}
                lastResolution={loop.lastResolution}
                onReset={onReset}
              />
            )}
          </div>
          <div className="px-4 pb-3 min-[720px]:min-h-0 min-[720px]:overflow-y-auto min-[720px]:border-l min-[720px]:border-border min-[720px]:pt-2">
            <Tray
              rows={tray.rows}
              onRows={(change) => tray.setRows(change(tray.latest()))}
              flashKey={flashKey}
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
            committing={committing}
            commitError={commitError}
            onCreateDeck={(opener) => {
              deckOpener.current = opener;
              scannedDeck.reset();
              setDeckRows([...tray.latest()]);
            }}
            onClearAll={(opener) => {
              clearOpener.current = opener;
              setClearing(tray.latest());
            }}
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
        will leave the tray without being added to your collection. Cards you scan while this is
        open stay.
      </ConfirmDialog>

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
