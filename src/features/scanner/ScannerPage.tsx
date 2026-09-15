import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import type { CollectionFolder, CollectionImportItem } from "@/lib/ipc";
import { ipc, ipcError } from "@/lib/ipc";
import { OWNED_WRITE_KEYS } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { useNarrowWindow } from "@/lib/useNarrowWindow";
import { isWebTarget } from "@/pwa/target";
import { Overlay } from "./Overlay";
import { TiersPanel } from "./panels/TiersPanel";
import { statusLine, type LastAdded } from "./reader/readerText";
import { ScanBar } from "./reader/ScanBar";
import { addDecision, importItems, setPrinting } from "./reader/tray";
import { TrayPanel } from "./reader/TrayPanel";
import { ScannerPanels } from "./ScannerPanels";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import type { ScannerDecision, ScannerOptions, ScannerTrayRow } from "./types";
import { useCamera } from "./useCamera";
import { useScanLoop } from "./useScanLoop";
import { useScannerPrefs } from "./useScannerPrefs";
import { useTray } from "./useTray";
import { bundleSentence, modelsSentence, WEB_SENTENCE } from "./verdictText";

/**
 * How long a row that just landed stays marked as the one to flash.
 *
 * `TrayPanel`'s wash holds for one `slow` tier and fades over the next, so the flash itself is over
 * in about half a second; the key is cleared a while after that so a panel that remounts — a
 * Developer switch that moves the column, a phone rotating — does not replay it.
 */
const FLASH_MS = 1200;

/**
 * Why the filters cannot be used: the scanner narrows by set and date through its labels, and a
 * bundle with no `corpus.db` beside it has none.
 */
const FILTERS_NEED_NAMES = "Filters need card names — the scanner has no corpus.db beside its bundle.";

/** Is `id` a drawer the reader made? `null` — the root — always is. */
function isUserFolder(folders: readonly CollectionFolder[], id: number | null): boolean {
  return id === null || folders.some((folder) => folder.id === id && folder.kind === "user");
}

/**
 * The tray after a commit that took `committed`, with whatever changed while it was in flight left
 * standing.
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
 * **Dispatched above the hooks.** On the web target there is no detector, so the whole view is
 * one sentence and nothing below this line runs: no camera is asked for, no command is called,
 * and no `useQuery` is conditional — `BackupPanel`'s shape, for `BackupPanel`'s reason.
 *
 * **The camera and the panels are two halves on purpose.** `useCamera` and `useScanLoop` own
 * the stream and the pump; `ScanBar`, `TrayPanel` and `ScannerPanels` are pure and take what
 * they draw as props, so each is tested from fixtures and storied without a camera, and a change
 * to a panel never touches the loop.
 *
 * **A reader of `useNarrowWindow`, not a second viewport branch.** A phone holds the camera above
 * the tray rather than beside it, and what that asks is whether the app is in its phone shape —
 * an answer the shell has already decided. `viewports.ts` demands a reason at the site of any
 * branch on width; the reason here is that there is no new branch, and the hook's own doc names
 * this view.
 */
export function ScannerPage(): JSX.Element {
  return isWebTarget() ? <WebSentence /> : <LiveScanner />;
}

function WebSentence() {
  return (
    <section className="flex h-full flex-col gap-3">
      <h2 className="sr-only">Scanner</h2>
      <p className="text-dim">{WEB_SENTENCE}</p>
    </section>
  );
}

function LiveScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useCamera(videoRef);
  const queryClient = useQueryClient();
  const { prefs, update, filterError, loaded } = useScannerPrefs();
  const tray = useTray();
  const folderList = useCollectionFolderList();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  // The developer sliders. `mode` rides the same header but is the reader's, so it is taken from
  // the prefs on the way out rather than from here.
  const [options, setOptions] = useState<ScannerOptions>(DEFAULT_SCANNER_OPTIONS);
  const [sendPx, setSendPx] = useState(DEFAULT_SEND_PX);
  const frameOptions = useMemo(() => ({ ...options, mode: prefs.mode }), [options, prefs.mode]);
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
  const narrow = useNarrowWindow();

  /**
   * The tray as the last write left it, for the three writers that run outside a render: a
   * decision from the pump, a printing handed back by the all-printings dialog, and a commit's
   * answer. Each of those can land after more cards were scanned than the render that built its
   * closure knew about, so each reads this rather than `tray.rows`. Written by {@link writeRows}
   * at the moment of the write, and caught up after every render for a load or a remount.
   */
  const rowsRef = useRef(tray.rows);
  useLayoutEffect(() => {
    rowsRef.current = tray.rows;
  });
  const writeRows = (rows: ScannerTrayRow[]) => {
    rowsRef.current = rows;
    tray.setRows(rows);
  };

  const [lastAdded, setLastAdded] = useState<LastAdded>(null);
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
   * The reducer decides whether it is a new row or a second copy of the newest; this files the
   * answer, marks the row for the flash, and remembers what to say about it. The finish is the
   * Defaults popover's at the moment the card landed, which is why a change there moves only the
   * next card.
   */
  const onDecision = (decision: ScannerDecision) => {
    const { rows, bumped } = addDecision(
      rowsRef.current,
      decision,
      { finish: prefs.finish },
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
    });
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
    // on an empty one the load then overwrites.
    live: camera.kind === "live" && loaded && tray.loaded,
    options: frameOptions,
    sendPx,
    onDecision,
  });

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
    // The two halves of Reset: the crate drops the tracker's evidence, and the page drops the
    // reads it is holding on top of it. Local first — it cannot fail and must not wait.
    loop.clearReads();
    ipc.scannerReset().catch((e: unknown) => setResetError(ipcError(e)));
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
   * The whole tray into the collection, in one `collection_import_commit` — one transaction, so all
   * or nothing: a refusal keeps every row and puts the sentence above them, and the backend's own
   * words are the sentence, because they already name what is wrong.
   *
   * The folder is asked about again here rather than trusted from the render: the list may not
   * have answered yet, and this press is the one moment a wrong answer would write.
   */
  const onCommit = () => {
    if (committing) return;
    const snapshot = rowsRef.current;
    let items: CollectionImportItem[];
    try {
      items = importItems(snapshot, prefs.condition);
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
        await ipc.collectionImportCommit(items, "add", target);
        writeRows(withoutCommitted(rowsRef.current, snapshot));
        // The import's own set, for the import's reason: these are copies the collection did not
        // hold a moment ago, and every surface that reads "what is owned" moves with them.
        for (const queryKey of OWNED_WRITE_KEYS) void queryClient.invalidateQueries({ queryKey });
      } catch (e) {
        setCommitError(ipcError(e));
      } finally {
        setCommitting(false);
      }
    })();
  };

  /**
   * *More printings…*: the app's all-printings wall, asked to hand the pressed printing back.
   *
   * The hand-back reads `rowsRef` rather than the rows this press saw, because the camera keeps
   * running while the dialog is open and a card scanned meanwhile must not be written away by it.
   */
  const onMorePrintings = (row: ScannerTrayRow) => {
    if (row.oracleId === null) return;
    openAllPrintings({
      cardId: row.cardId,
      oracleId: row.oracleId,
      name: row.name,
      deck: null,
      wish: null,
      pick: (p) => writeRows(setPrinting(rowsRef.current, row.key, p)),
    });
  };

  const statusData = status.data ?? null;
  // Unknown is not "absent": `scanner_status` loads the bundle on its first call, which is most of
  // a second, and a line saying the scanner has no hashes for that second is a false alarm on
  // every first open. The line waits for the answer instead.
  const hasBundle = statusData === null || statusData.bundle.loaded;
  const filtersDisabled = statusData !== null && statusData.labels === 0 ? FILTERS_NEED_NAMES : null;
  const assetNotes = [bundleSentence(statusData), modelsSentence(statusData)].filter(
    (sentence): sentence is string => sentence !== null,
  );
  const line = statusLine(loop.verdict, prefs.mode, lastAdded, hasBundle, loop.lastResolution);
  // The detector's own refusal is a developer's sentence — contours examined, a quad rejected —
  // and the reader has the status line for what it means to them. The loop's failures and a
  // refused reset are not the detector's, and every reader gets those.
  const detectorSentence =
    prefs.developer && loop.verdict?.ok === false
      ? (loop.verdict.error ?? "")
      : (loop.error ?? resetError ?? "");

  return (
    <section className="flex h-full flex-col gap-3">
      {/* Not shown: the ribbon already says `Scanner`, and every pixel of this view's height is
          the camera's. It is here to name the view for assistive tech, as the other views' do. */}
      <h2 className="sr-only">Scanner</h2>

      <ScanBar
        mode={prefs.mode}
        onMode={(mode) => update({ mode })}
        filters={prefs.filters}
        onFilters={(filters) => update({ filters })}
        filterError={filterError}
        filtersDisabled={filtersDisabled}
        finish={prefs.finish}
        onFinish={(finish) => update({ finish })}
        condition={prefs.condition}
        onCondition={(condition) => update({ condition })}
        developer={prefs.developer}
        onDeveloper={(developer) => update({ developer })}
      />

      <div
        className={
          narrow
            ? "relative flex min-h-0 flex-1 flex-col gap-4 overflow-auto"
            : "flex min-h-0 flex-1 gap-4"
        }
      >
        {/* The camera's column: the picture, then the one line that says what it is doing. */}
        <div className={narrow ? "flex w-full shrink-0 flex-col gap-2" : "flex min-w-0 flex-1 flex-col gap-2"}>
          {/* **The two arms size the video box by opposite mechanisms, and the narrow one has to.**
              Wide, the row is the height and the box takes what the `w-80` column and the status
              line leave. Narrow, the row is a *scrolling column*: a zero-basis `flex-1` under a
              scrolling parent yields all of its free space to a `shrink-0` sibling, so a tray or
              an opened developer panel whose intrinsic height reached the container's would
              collapse the camera to ~0px. So on a phone the box is `w-full shrink-0` at the
              camera's own aspect ratio — the picture's real shape, at full width — and the tray
              follows it down the page. */}
          <div
            className={
              narrow
                ? "relative w-full shrink-0 overflow-hidden rounded-lg bg-black"
                : "relative min-h-0 flex-1 overflow-hidden rounded-lg bg-black"
            }
            style={
              narrow
                ? {
                    // 4:3 until the stream reports its own size: a starting or refused camera has
                    // no shape to honour, and an unset ratio here is the collapse again.
                    aspectRatio:
                      camera.kind === "live" ? `${camera.width} / ${camera.height}` : "4 / 3",
                  }
                : undefined
            }
          >
            <video ref={videoRef} muted playsInline className="h-full w-full object-contain" />
            <Overlay videoRef={videoRef} verdict={loop.verdict} />
            {camera.kind === "error" && (
              <p
                role="alert"
                className="absolute inset-0 flex items-center justify-center p-6 text-center text-dim"
              >
                {camera.message}
              </p>
            )}
            {/* The detector's own sentence, in a strip that is *emptied* rather than removed: a
                frame that fails is the ordinary case at nine answers a second, and a box that
                grew and shrank under the video with each one would be the loudest thing on the
                screen. Two lines of room, held whether or not there is anything to put in it. */}
            <p className="absolute bottom-2 left-3 min-h-[2.5em] text-xs text-dim" aria-live="polite">
              {detectorSentence}
            </p>
          </div>

          {/* **The reader's one line**, where the old headline pill sat over the picture. Under it
              rather than on it, because it is a sentence to read rather than a label on a card, and
              a sentence over live video is a sentence over whatever colour the table is. Always
              mounted, so a screen reader is watching it before the first card lands; one line of
              room held, so the camera above does not jump when the sentence wraps or changes. */}
          <p
            role="status"
            aria-live="polite"
            aria-label="Scanner status"
            className="min-h-[1.5rem] text-base leading-snug text-text"
          >
            {line}
          </p>
          {assetNotes.length > 0 && (
            <div className="space-y-1 text-xs text-dim">
              {assetNotes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
        </div>

        {/* Narrow: the tray follows the camera down the page and the whole column scrolls as one,
            which is why the scroller above is on the row rather than here. Wide: a fixed column.
            With the developer panels off it is the tray alone, and the tray is the column's
            height — its rows scroll and its Add button stays put. With them on the column scrolls
            by itself, so opening a panel never moves the video, and the tray is capped rather than
            shrunk: a `min-h-0` item in a scroller hands its height to the panels beside it. */}
        <div
          className={
            narrow
              ? "flex shrink-0 flex-col gap-4"
              : prefs.developer
                ? "relative flex w-80 shrink-0 flex-col gap-4 overflow-auto"
                : "flex w-80 shrink-0 flex-col"
          }
        >
          <div
            className={
              !narrow && !prefs.developer
                ? "flex min-h-0 flex-col"
                : "flex max-h-[70vh] shrink-0 flex-col"
            }
          >
            <TrayPanel
              rows={tray.rows}
              onRows={writeRows}
              folderId={folderId}
              onFolder={(id) => update({ folderId: id })}
              onCommit={onCommit}
              committing={committing}
              commitError={commitError}
              onMorePrintings={onMorePrintings}
              flashKey={flashKey}
            />
          </div>
          {prefs.developer && (
            <>
              <ScannerPanels
                status={statusData}
                verdict={loop.verdict}
                lastOcr={loop.lastOcr}
                lastCollector={loop.lastCollector}
                roundTripMs={loop.roundTripMs}
                rate={loop.rate}
                options={options}
                sendPx={sendPx}
                onOptions={setOptions}
                onSendPx={setSendPx}
                onReset={onReset}
                onCapture={onCapture}
              />
              <TiersPanel resolution={loop.lastResolution} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
