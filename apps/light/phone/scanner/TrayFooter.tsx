import { useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronRight,
  Ellipsis,
  Folder,
  History,
  Layers,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { SCAN_HISTORY_TITLE } from "@grimoire/ui/features/scanner/history/historyWords";
import {
  addLabel,
  addRefusal,
  deckRefusal,
  EMPTY_REASON,
  needsFinishCount,
  readyRows,
  totalCopies,
} from "@grimoire/ui/features/scanner/reader/tray";
import type { TrayDestinationFace } from "@grimoire/ui/features/scanner/useTrayDestination";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { buildFolderTree, flattenFolders } from "@grimoire/ui/lib/folderTree";
import type { CollectionFolder, ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet, SheetChoice, SheetRow } from "../deck/sheet";

/** The collection's own word for its top level — the desktop tray's, and `CopyActions`'. */
export const ROOT_LABEL = "Collection";

/** What the destination's press reads when it files to a folder whose name is not known. */
export const UNREAD_FOLDER = "Folder name unavailable";

/** What a row of the `⋯` sheet says while an Archive is out — the Add's `Adding to …` for it. */
export const ARCHIVING = `Archiving to ${SCAN_HISTORY_TITLE}…`;

/**
 * What a destination is called: the root's word, the folder's own name — or `null` for a folder
 * the list does not hold.
 *
 * **`null`, never the root's word.** A stored folder the list *answered* without is read as the
 * root before it ever reaches here (`useTrayFolder`), and the commit files to the root. But a
 * list that would not load leaves the stored id standing, and the commit sends it for the backend
 * to judge — so calling that destination `Collection` printed a place the cards were not sent to.
 * A surface that gets `null` says it does not know.
 */
export function destinationName(
  folders: readonly CollectionFolder[],
  folderId: number | null,
): string | null {
  if (folderId === null) return ROOT_LABEL;
  return folders.find((folder) => folder.id === folderId)?.name ?? null;
}

/**
 * What the tray is *for*, at the foot of the page where it stays put: where the cards go, and the
 * press that files them.
 *
 * **Outside the page's scroller**, the desktop tray's own rule one face over — a reader with forty
 * cards scanned still has the destination and Add under their thumb.
 *
 * - **The destination** is a press naming it (`Folder: Collection`) that opens the reader's own
 *   folders as a sheet — `CopyActions`' cabinet: the root, then the drawers the reader made, nested.
 *   A deck's group and `Recently removed` are not places the tray could ever land, so they are not
 *   in the list. Picking writes nothing but the choice (`prefs.folderId`); the commit is Add's.
 * - **Add** says both halves of what it will do — `Add 8 to collection · 2 need a finish` — and
 *   while it cannot go it stays drawn, greyed, **with the reason in words under it**. The desktop
 *   says that reason in a tooltip, which a finger never opens.
 * - **`⋯`** opens the tray's other acts — *Archive*, *Create deck…*, *Clear all…* and *Scan
 *   history* — as sheet rows, each saying why it is refused where it is (`SheetRow`'s second line),
 *   again in place of a tooltip.
 * - **Archive** (issue #989) puts away the rows Add would take, into the scan history and not
 *   the collection — the desktop tray's Archive, refused on *Clear all…*'s terms (an empty tray,
 *   or either press in flight). A row waiting on a printing is said by the press, in the plan's
 *   sentence in the alert above, as it would be for an Add. **Either press in flight holds the
 *   other**: they put the same rows away.
 * - **Scan history** opens the history's sheet — a request; the page owns it.
 *
 * A refused commit puts the backend's own sentence above the two rows, as an alert; a commit that
 * went through is the page's receipt line.
 *
 * **With a `destination`** — the tray filing onto a side of a trade rather than into the
 * collection (`useTrayDestination.ts`) — the folder's press gives its place to the destination's
 * own summary, Add and the two pending lines take its words, and `⋯` holds *Clear all…* alone: a
 * folder and a deck are both questions about the collection, and the archive and its history are
 * the Scanner tab's own record. Absent, the footer is the Scanner page's, as it was.
 */
export function TrayFooter({
  rows,
  folders,
  foldersPending,
  folderId,
  onFolder,
  onCommit,
  committing,
  commitError,
  onCreateDeck,
  onClearAll,
  onArchive,
  archiving = false,
  onHistory,
  destination,
}: {
  rows: readonly ScannerTrayRow[];
  /** Every collection folder, every kind — the reader's own are picked out here. */
  folders: readonly CollectionFolder[];
  /** The folder list has not answered yet: a named folder has no name to draw. */
  foldersPending: boolean;
  /** Where the tray files — the effective folder, `null` for the root. */
  folderId: number | null;
  onFolder: (id: number | null) => void;
  onCommit: () => void;
  committing: boolean;
  commitError: string | null;
  /** *Create deck…* — a request; the page owns the dialog. Handed the `⋯`, for the caret. */
  onCreateDeck: (opener: HTMLElement) => void;
  /** *Clear all…* — a request, never the clear itself: the page asks first. */
  onClearAll: (opener: HTMLElement) => void;
  /** *Archive* — the tray into the scan history. Absent draws no row, and so does a
   *  {@link destination}. */
  onArchive?: () => void;
  /** The archive is in flight — {@link committing}'s counterpart; it greys the same presses. */
  archiving?: boolean;
  /** *Scan history* — a request; the page owns the sheet. Handed the `⋯`, for the caret. Absent
   *  draws no row, and so does a {@link destination}. */
  onHistory?: (opener: HTMLElement) => void;
  /** Where the tray files when that is not the collection. `folders`, `folderId`, `onFolder` and
   *  `onCreateDeck` are then unread. */
  destination?: TrayDestinationFace;
}) {
  const [sheet, setSheet] = useState<"folder" | "more" | null>(null);
  const reasonId = useId();
  // The destination's press, which its sheet hands the caret back to.
  const folderRef = useRef<HTMLButtonElement>(null);
  // The `⋯`, which both of its rows hand to the page: the caret comes back to it.
  const moreRef = useRef<HTMLButtonElement>(null);
  const mine = useMemo(() => folders.filter((folder) => folder.kind === "user"), [folders]);
  const nodes = useMemo(() => flattenFolders(buildFolderTree(mine, [])), [mine]);

  const ready = totalCopies(readyRows(rows));
  const needsFinish = needsFinishCount(rows);
  const refusal = addRefusal(rows);
  // Add and Archive put the same rows away, so either one in flight holds both.
  const busy = committing || archiving;
  const refused = refusal !== null || busy;
  // While the list is still loading a named folder has no name yet, and one the list never
  // answered for has none at all: the collection's word would be a wrong answer either way.
  const name = destinationName(mine, folderId) ?? (foldersPending ? "…" : UNREAD_FOLDER);
  // What a row of the `⋯` sheet says while the press is out.
  const adding = archiving ? ARCHIVING : `Adding to ${destination?.name ?? "your collection"}…`;
  const archiveShown = onArchive !== undefined && destination === undefined;
  const historyShown = onHistory !== undefined && destination === undefined;

  return (
    <footer className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface px-4 py-2">
      {commitError !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {commitError}
        </p>
      )}

      <div className="flex items-center gap-2">
        {destination === undefined ? (
          <button
            ref={folderRef}
            type="button"
            // Named outright: the icon, the name and the chevron are three elements a gap apart.
            aria-label={`Folder: ${name}`}
            aria-haspopup="dialog"
            onClick={() => setSheet("folder")}
            className={cn(
              "inline-flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-3 text-sm",
              PRESS,
              FOCUS,
            )}
          >
            <Folder aria-hidden className="size-4 shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
          </button>
        ) : (
          // The folder's place, so `⋯` stays at the right end whether or not there is a summary.
          <div className="flex min-h-11 min-w-0 flex-1 items-center">
            {destination.summary?.(rows)}
          </div>
        )}
        <button
          type="button"
          ref={moreRef}
          aria-label="Tray actions"
          aria-haspopup="dialog"
          onClick={() => setSheet("more")}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-dim",
            PRESS,
            FOCUS,
          )}
        >
          <Ellipsis aria-hidden className="size-5" />
        </button>
      </div>

      <button
        type="button"
        aria-disabled={refused || undefined}
        aria-busy={committing || undefined}
        // The reason is the press's description, so it is read with the press and not only by a
        // reader who goes looking under it.
        aria-describedby={refusal !== null && !busy ? reasonId : undefined}
        onClick={() => {
          if (!refused) onCommit();
        }}
        className={cn(
          "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-accent px-4 py-2",
          "text-sm font-medium text-accent",
          PRESS,
          "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:active:scale-100",
          FOCUS,
        )}
      >
        {committing && (
          <LoaderCircle
            aria-hidden
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
          />
        )}
        {/* One label in both states: the name a reader pressed is the name the pending control
            keeps, and `aria-busy` is what says the write is under way. */}
        {addLabel(ready, needsFinish, destination?.name)}
      </button>
      {/* The reason while there is one; nothing while a write is in flight — the press is held,
          and the spinner (an Add) or the `⋯` sheet's rows (an Archive) say which write. */}
      {refusal !== null && !busy && (
        <p id={reasonId} className="text-center text-xs leading-snug text-dim">
          {refusal}
        </p>
      )}

      <ActionSheet
        open={sheet === "folder"}
        title="Folder for scanned cards"
        closeLabel="Close folders"
        // A press on the scrim leaves the caret where the reader put it; Escape, the ✕ and a
        // choice hand it back to the press that opened the sheet, which is always on the page.
        onClose={() => setSheet(null)}
        onDismiss={() => {
          setSheet(null);
          folderRef.current?.focus();
        }}
      >
        <ul aria-label="Folders">
          <SheetChoice
            label={ROOT_LABEL}
            current={folderId === null}
            onPick={() => {
              onFolder(null);
              setSheet(null);
              folderRef.current?.focus();
            }}
          />
          {nodes.map(({ folder, depth }) => (
            <SheetChoice
              key={folder.id}
              label={folder.name}
              current={folder.id === folderId}
              indent={depth}
              note={folder.locked ? "set aside" : undefined}
              onPick={() => {
                onFolder(folder.id);
                setSheet(null);
                folderRef.current?.focus();
              }}
            />
          ))}
        </ul>
      </ActionSheet>

      <ActionSheet
        open={sheet === "more"}
        title="Scanned cards"
        closeLabel="Close tray actions"
        onClose={() => setSheet(null)}
        onDismiss={() => {
          setSheet(null);
          moreRef.current?.focus();
        }}
      >
        <ul>
          {archiveShown && (
            <SheetRow
              label="Archive"
              Icon={Archive}
              // Clear all's terms: what a commit is about to file, or nothing at all, cannot be
              // archived. Said in words on the row, where the desktop has a tooltip.
              reason={busy ? adding : rows.length === 0 ? EMPTY_REASON : null}
              onPress={() => {
                setSheet(null);
                moreRef.current?.focus();
                onArchive();
              }}
            />
          )}
          {destination === undefined && (
            <SheetRow
              label="Create deck…"
              Icon={Layers}
              reason={busy ? adding : deckRefusal(rows)}
              onPress={() => {
                setSheet(null);
                if (moreRef.current !== null) onCreateDeck(moreRef.current);
              }}
            />
          )}
          <SheetRow
            label="Clear all…"
            Icon={Trash2}
            destructive
            // Nothing to clear, or a commit about to file these very rows — a card waiting on a
            // printing or a finish can still be thrown away.
            reason={busy ? adding : rows.length === 0 ? EMPTY_REASON : null}
            onPress={() => {
              setSheet(null);
              if (moreRef.current !== null) onClearAll(moreRef.current);
            }}
          />
          {/* Last, and never refused: the history is there whatever the tray holds — an empty
              tray is the usual moment to look back at what was put away. */}
          {historyShown && (
            <SheetRow
              label={SCAN_HISTORY_TITLE}
              Icon={History}
              opens
              onPress={() => {
                setSheet(null);
                if (moreRef.current !== null) onHistory(moreRef.current);
              }}
            />
          )}
        </ul>
      </ActionSheet>
    </footer>
  );
}
