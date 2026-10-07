import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { CreateDeckDialog } from "@/features/decks/CreateDeckDialog";
import { useNewDeckFormat } from "@/features/decks/useNewDeckFormat";
import { plural } from "@/lib/counts";
import type { CollectionFolder, CollectionImportItem } from "@/lib/ipc";
import { ipc, ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { invalidateOwnedWrite } from "@/lib/searchMarks";
import { Overlay } from "./Overlay";
import { TiersPanel } from "./panels/TiersPanel";
import { AddedToast, landedFrom, type LandedCard } from "./reader/AddedToast";
import { MatchStrip } from "./reader/MatchStrip";
import type { LastAdded } from "./reader/readerText";
import { ScanBar } from "./reader/ScanBar";
import { addDecision, commitPlan, setPrinting, totalCopies, trayLayoutOf } from "./reader/tray";
import { trayFinish } from "./reader/trayFinish";
import { TrayPanel } from "./reader/TrayPanel";
import { ScannerPanels } from "./ScannerPanels";
import { DEFAULT_DETAIL_WAIT_MS, DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import type { ScannerDecision, ScannerOptions, ScannerTrayRow } from "./types";
import { useCamera, useCameraDevices } from "./useCamera";
import { useScanLoop } from "./useScanLoop";
import {
  SCANNER_ELSEWHERE_KEY,
  SCANNER_ELSEWHERE_POLL_MS,
  useScannerElsewhere,
} from "./useScannerElsewhere";
import { useScannerPrefs } from "./useScannerPrefs";
import { useTray } from "./useTray";
import { useScannedDeck } from "./useScannedDeck";
import { useWindowParked } from "./useWindowParked";
import { bundleSentence, modelsSentence, SCANNER_OPEN_ELSEWHERE } from "./verdictText";

/**
 * How long a row that just landed stays marked as the one to flash.
 *
 * `TrayPanel`'s wash holds for one `slow` tier and fades over the next, so the flash itself is over
 * in about half a second; the key is cleared a while after that so a panel that remounts — a
 * Developer switch that moves the column — does not replay it.
 */
const FLASH_MS = 1200;

/**
 * Why the filters cannot be used: the scanner narrows by set and date through its labels, and a
 * bundle with no `corpus.db` beside it has none.
 */
const FILTERS_NEED_NAMES =
  "Filters need the card database. corpus.db wasn't found next to the scanner bundle.";

/** Is `id` a drawer the reader made? `null` — the root — always is. */
function isUserFolder(folders: readonly CollectionFolder[], id: number | null): boolean {
  return id === null || folders.some((folder) => folder.id === id && folder.kind === "user");
}

/**
 * The tray after a commit — or a confirmed *Clear all…* — that took `committed`, with whatever
 * changed while it was in flight left standing.
 *
 * **Not `[]`, because the camera keeps running while the write does.** The commit waits for the
 * write connection — seconds, while a sync holds it — and a card landing in that window is a row
 * the commit never saw. So a row whose key the commit did not take is new and stays; a row the
 * commit took and nothing has touched since is dropped (the reducer builds a new object for every
 * change, so "untouched" is identity); a row the commit took that was **bumped** since — the same
 * printing and finish, more copies — keeps only the copies added after the snapshot; and a row the
 * commit took that was edited some other way in that window is dropped, because the commit already
 * filed the card it was.
 */
function withoutCommitted(
  now: readonly ScannerTrayRow[],
  committed: readonly ScannerTrayRow[],
): ScannerTrayRow[] {
  const taken = new Map(committed.map((row) => [row.key, row]));
  return now.flatMap((row) => {
    const was = taken.get(row.key);
    if (was === undefined) return [row];
    if (was === row) return [];
    const samePrinting = was.cardId === row.cardId && was.finish === row.finish;
    return samePrinting && row.quantity > was.quantity
      ? [{ ...row, quantity: row.quantity - was.quantity }]
      : [];
  });
}

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
      <p className="text-dim">It will open here once that window closes or leaves the scanner.</p>
    </section>
  );
}

function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const queryClient = useQueryClient();
  const { prefs, update, filterError, loaded, unavailable } = useScannerPrefs();
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
  const folderList = useCollectionFolderList();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  // The developer sliders. `mode` rides the same header but is the reader's, so it is taken from
  // the prefs on the way out rather than from here.
  const [options, setOptions] = useState<ScannerOptions>(DEFAULT_SCANNER_OPTIONS);
  const [sendPx, setSendPx] = useState(DEFAULT_SEND_PX);
  const [detailWaitMs, setDetailWaitMs] = useState(DEFAULT_DETAIL_WAIT_MS);
  // `previews` is the Developer switch's too: the rectified preview and its hash cost a JPEG
  // encode a frame, and nothing but the developer panels draws them.
  const frameOptions = useMemo(
    () => ({ ...options, mode: prefs.mode, previews: prefs.developer }),
    [options, prefs.mode, prefs.developer],
  );
  // `staleTime: Infinity` and no button to invalidate it: `scanner_status` loads the bundle and
  // the models on its first call and answers out of what it loaded thereafter, so asking again
  // in the same session cannot report a file that has since appeared. A `Reload assets` press
  // would redraw the same three sentences and read as a repair that had happened; restarting
  // the app is the honest instruction, and it is what the sentences already name a path for.
  const status = useQuery({
    queryKey: ["scanner", "status"],
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });

  /**
   * **The heartbeat: this view holds the scanner from its first render, whatever its camera is
   * doing.** `scanner_hold` on mount and once a poll while mounted, cleared on unmount — so the lease
   * is renewed by the view being here rather than by frames, which a camera still starting, refused
   * or failed never sends. Without it a view with no frames let its lease lapse in two seconds, a
   * second window got through the gate, and both had the tray on screen; and the first push of the
   * filters took the lease before the camera was live, so a slow camera could hand the scanner back
   * and forth between two windows on the Scanner view.
   *
   * **Every refusal asks the gate again, not only the first** — which flips it to the sentence and
   * unmounts this view. Keyed on nothing but the refusal itself, so a run of them is a run of asks:
   * the frame loop's re-ask below fires once per run of refused frames, and a run that began while
   * the gate still said "free" could leave a mounted view sending refused frames at full rate. Any
   * other failure says nothing about the lease and is left to the frame loop's own line.
   *
   * **Stopped while the window is released** (minimized past the grace): a window sitting on the
   * taskbar held the scanner for good before, and nothing else could take it. The restore starts it
   * again with an immediate beat, whose refusal is the first thing to say another window has it.
   */
  const released = parked.released;
  useEffect(() => {
    if (released) return;
    const hold = () => {
      ipc.scannerHold().catch((e: unknown) => {
        if (ipcError(e) === SCANNER_OPEN_ELSEWHERE) {
          void queryClient.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
        }
      });
    };
    hold();
    const beat = setInterval(hold, SCANNER_ELSEWHERE_POLL_MS);
    return () => clearInterval(beat);
  }, [queryClient, released]);

  /**
   * Every tray write goes through here, and every writer builds on `tray.latest()` rather than
   * `tray.rows`: a decision from the pump, a printing handed back by the all-printings dialog, an
   * edit in the tray panel and a commit's answer can each land after more cards were scanned than
   * the render that built its closure knew about. `latest()` is the cache, written synchronously
   * by the write before it, so two writers in one tick cannot each start from the rows before the
   * other.
   */
  const writeRows = (rows: ScannerTrayRow[]) => tray.setRows(rows);

  const [lastAdded, setLastAdded] = useState<LastAdded>(null);
  /**
   * The card laid over the camera for the length of its hold — what just landed, drawn from the
   * tray's head row rather than from the decision, because the row is what was filed: a bump,
   * a re-read and a row waiting for a pick all say something different to a reader holding the
   * card. Cleared by the overlay itself once its hold runs out.
   */
  const [landed, setLanded] = useState<LandedCard | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /**
   * One card, into the tray — once per `decision_seq`, which the loop is what guarantees.
   *
   * The reducer decides whether it is a new row, a second copy of the newest, or a second opinion
   * that rewrites the newest row's printing (`replaces_previous` — a switch to Exact on the card
   * Fast named); this files the answer, marks the row for the flash, and remembers what to say
   * about it. The finish is the
   * Defaults popover's at the moment the card landed, which is why a change there moves only the
   * next card — and under **Detect**, the popover's default, it is `trayFinish`'s reading of this
   * decision's own facts: the printing's finishes and the separator the collector line showed, or
   * `unknown` for the reader to settle.
   */
  const onDecision = (decision: ScannerDecision) => {
    const { rows, bumped, replaced } = addDecision(
      tray.latest(),
      decision,
      { finish: trayFinish(prefs.finish, decision) },
      Date.now(),
      crypto.randomUUID(),
    );
    writeRows(rows);
    const head = rows[0];
    setLastAdded({
      name: head.name,
      setCode: head.setCode,
      collectorNumber: head.collectorNumber,
      bumpedTo: bumped ? head.quantity : null,
      replaced,
    });
    setLanded(landedFrom(head, bumped, replaced));
    setFlashKey(head.key);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlashKey(null);
    }, FLASH_MS);
  };

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

  // **A refused frame is the lease saying another window has the scanner** — it took it in the
  // moment between this window's ask and this frame. Asking again flips the gate to the sentence,
  // which unmounts this view and stops the camera. This is the fast path and not the guarantee: it
  // fires once per run of refused frames, and the heartbeat above is what asks on every refusal. A
  // refused *filter push* asks the same question from inside `useScannerPrefs`, which is where that
  // refusal has to be told apart from a real one — so `filterError` never carries this sentence and
  // is not read here.
  const refusedElsewhere = loop.error === SCANNER_OPEN_ELSEWHERE;
  useEffect(() => {
    if (refusedElsewhere) void queryClient.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
  }, [refusedElsewhere, queryClient]);

  /**
   * **A folder that is gone, or that is not the reader's own, is the root.** The id is stored and
   * the folder is not, so another surface can delete it — and `collection_import_commit` accepts a
   * deck's group, because the import's deck arm files there on purpose, so a stored id that now
   * names one would put scanned cards in a deck's box behind the reader's back. Decided only once
   * the list has answered; until then the stored id stands, and the commit asks again.
   */
  const staleFolder =
    folderList.query.isSuccess && !isUserFolder(folderList.folders, prefs.folderId);
  const folderId = staleFolder ? null : prefs.folderId;
  useEffect(() => {
    if (loaded && staleFolder) update({ folderId: null });
  }, [loaded, staleFolder, update]);

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

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  /**
   * The tray into the collection, in one `scanner_tray_commit` — the collection import and the
   * tray that is left after it, in one transaction, so all or nothing: a refusal keeps every row
   * and puts the sentence above them, and the backend's own words are the sentence, because they
   * already name what is wrong.
   *
   * **Every row with a known finish, and none without one.** `commitPlan` splits the tray: the
   * rows it takes are the import's lines *and* the snapshot {@link withoutCommitted} subtracts, so
   * a row of unknown finish is never "taken", and it is still in `remaining` when the commit goes
   * out and still in the tray when it answers — marked, where the reader left it.
   *
   * **The stored tray moves with the collection, not behind it.** This used to commit and then let
   * the tray's debounced write catch up; an app closed in that window — or that write refused, or
   * an older one landing after the commit — restored the committed rows at the next launch, and the
   * next Add filed them twice. `tray.commit` queues behind any tray write already on the wire and
   * computes what is left ({@link withoutCommitted}) against the rows as they are when it goes out.
   *
   * The folder is asked about again here rather than trusted from the render: the list may not
   * have answered yet, and this press is the one moment a wrong answer would write.
   */
  const onCommit = () => {
    if (committing) return;
    let items: CollectionImportItem[];
    let snapshot: ScannerTrayRow[];
    try {
      ({ items, taken: snapshot } = commitPlan(tray.latest(), prefs.condition));
    } catch (e) {
      setCommitError(ipcError(e));
      return;
    }
    const chosen = prefs.folderId;
    setCommitting(true);
    setCommitError(null);
    void (async () => {
      try {
        const folders = folderList.query.data ?? (await folderList.query.refetch()).data;
        // A list that would not load leaves the id to the backend, which refuses a folder that is
        // gone in words; a list that did load has already said whether the id is the reader's.
        const target = folders === undefined || isUserFolder(folders, chosen) ? chosen : null;
        await tray.commit(items, target, (latest) => withoutCommitted(latest, snapshot));
        // The import's own set, for the import's reason: these are copies the collection did not
        // hold a moment ago, and every surface that reads "what is owned" moves with them.
        invalidateOwnedWrite(queryClient);
      } catch (e) {
        setCommitError(ipcError(e));
      } finally {
        setCommitting(false);
      }
    })();
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

  const statusData = status.data ?? null;
  // Unknown is not "absent": `scanner_status` loads the bundle on its first call, which is most of
  // a second, and a line saying the scanner has no hashes for that second is a false alarm on
  // every first open. The line waits for the answer instead.
  const hasBundle = statusData === null || statusData.bundle.loaded;
  const filtersDisabled =
    statusData !== null && statusData.labels === 0 ? FILTERS_NEED_NAMES : null;
  const assetNotes = [bundleSentence(statusData), modelsSentence(statusData)].filter(
    (sentence): sentence is string => sentence !== null,
  );
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
              <AddedToast card={scanning ? landed : null} onDone={() => setLanded(null)} />
              {!scanning && (
                <p role="status" className="absolute left-3 top-2 p-2 text-xs text-dim">
                  Scanning stopped. Press Start scanning to resume.
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
              {/* **A host with no scanner session** — a web page, until the light app's web step
                  (`SCANNER_NOT_IN_A_BROWSER_YET`). The engine's sentence where the picture would
                  be: `loaded` never goes true there, so no camera was asked for and nothing else
                  will ever fill this box. The tray beside it still reads, edits and files. */}
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
            {assetNotes.length > 0 && (
              <div className="space-y-1 text-xs text-dim">
                {assetNotes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            )}
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
