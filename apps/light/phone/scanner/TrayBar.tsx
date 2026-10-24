import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, FolderPlus, LoaderCircle } from "lucide-react";
import { SCAN_HISTORY_TITLE } from "@grimoire/ui/features/scanner/history/historyWords";
import {
  addLabel,
  addRefusal,
  needsFinishCount,
  readyRows,
  totalCopies,
} from "@grimoire/ui/features/scanner/reader/tray";
import type { TrayDestinationFace } from "@grimoire/ui/features/scanner/useTrayDestination";
import {
  NEW_FOLDER_LABEL,
  newFolderRefusal,
  useTrayNewFolder,
  type TrayNewFolder,
} from "@grimoire/ui/features/scanner/useTrayNewFolder";
import { CONDITION_LABEL, type Condition } from "@grimoire/ui/lib/conditions";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { buildFolderTree, flattenFolders } from "@grimoire/ui/lib/folderTree";
import type { CollectionFolder, ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { PRESS, PRESS_STILL } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet, SheetBack, SheetChoice, SheetRow } from "../deck/sheet";
import { GOLD_BUTTON, Refusal } from "../trade/parts";

/** The collection's own word for its top level — the desktop tray's, and `CopyActions`'. */
export const ROOT_LABEL = "Collection";

/** What the destination's press reads when it files to a folder whose name is not known. */
export const UNREAD_FOLDER = "Folder name unavailable";

/** What a row of the tray's actions says while an Archive is out — the Add's `Adding to …` for
 *  it (`TrayActionsSheet`). */
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
 * What the tray is *for*, in one row at the head of the page (the scanner redesign, 2026-10-24):
 * where the cards go, and the press that files them. It was the page's footer until then.
 *
 * **One component in two places**: the page draws it at its top, and the tray sheet draws the
 * page's own copy under its header (`TraySheet`'s `bar`), so a reader looking at the whole tray
 * still has the destination and Add under their thumb.
 *
 * - **The destination** is a press naming the folder, with **the condition under it** — the two
 *   things Add reads, said where Add is. It opens the reader's own folders as a sheet —
 *   `CopyActions`' cabinet: the root, then the drawers the reader made, nested. A deck's group
 *   and `Recently removed` are not places the tray could ever land, so they are not in the list.
 *   Picking writes nothing but the choice (`prefs.folderId`); the commit is Add's. *New folder…*
 *   under the list (issue #1357) is a page of the same sheet — a name and Create — that makes the
 *   folder at the top level and picks it (`useTrayNewFolder`). The condition is set in the
 *   options sheet; here it is only said.
 * - **Add** draws `Add 8` and is *named* both halves of what it will do — `Add 8 to collection ·
 *   2 need a finish` — the whole sentence a screen reader hears. While it cannot go it stays
 *   drawn, greyed, and **the reason is its accessible description**, in words. There is no line
 *   of it under the press any more (the owner's design): the tray's gold *N need you* is what
 *   tells a sighted reader there is a question to answer first, and a finger has no hover, so the
 *   desktop's tooltip is no answer here either.
 * - **The tray's other acts** — *Archive*, *Create deck…*, *Clear all…*, *Scan history* — are not
 *   here: they are `TrayActionsSheet`, opened by the tray's own `⋯`.
 *
 * A refused commit puts the backend's own sentence above the row, as an alert; a commit that went
 * through is the page's receipt line.
 *
 * **With a `destination`** — the tray filing onto a side of a trade rather than into the
 * collection (`useTrayDestination.ts`) — the folder's press gives its place to the destination's
 * own summary, and Add takes its words: a folder and a condition are questions about the
 * collection.
 */
export function TrayBar({
  rows,
  folders,
  foldersPending,
  folderId,
  condition,
  onFolder,
  onCommit,
  committing,
  commitError,
  archiving = false,
  destination,
}: {
  rows: readonly ScannerTrayRow[];
  /** Every collection folder, every kind — the reader's own are picked out here. */
  folders: readonly CollectionFolder[];
  /** The folder list has not answered yet: a named folder has no name to draw. */
  foldersPending: boolean;
  /** Where the tray files — the effective folder, `null` for the root. */
  folderId: number | null;
  /** What Add files every card as (`prefs.condition`), said under the folder. */
  condition: Condition;
  onFolder: (id: number | null) => void;
  onCommit: () => void;
  committing: boolean;
  commitError: string | null;
  /** An Archive is in flight (`TrayActionsSheet`) — {@link committing}'s counterpart: it puts the
   *  same rows away, so it holds Add too. */
  archiving?: boolean;
  /** Where the tray files when that is not the collection. `folders`, `folderId`, `condition`
   *  and `onFolder` are then unread. */
  destination?: TrayDestinationFace;
}) {
  const [folderOpen, setFolderOpen] = useState(false);
  // Which page of the folder sheet is up: the folders, or a new one's name.
  const [folderPage, setFolderPage] = useState<"list" | "new">("list");
  const newFolder = useTrayNewFolder(onFolder);
  const reasonId = useId();
  const conditionId = useId();
  // The destination's press, which its sheet hands the caret back to.
  const folderRef = useRef<HTMLButtonElement>(null);
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

  const closeFolders = () => {
    setFolderOpen(false);
    folderRef.current?.focus();
  };

  return (
    // `relative` for the `sr-only` reason below: it is positioned, and wherever this row is drawn
    // inside a scroller it must be held by a box of its own.
    <div className="relative flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2">
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
            // Named outright: the icon, the two lines and the chevron are four elements a gap
            // apart. The condition is the press's description rather than its name — it is
            // what Add reads, not where the press goes.
            aria-label={`Folder: ${name}`}
            aria-describedby={conditionId}
            aria-haspopup="dialog"
            onClick={() => {
              setFolderPage("list");
              setFolderOpen(true);
            }}
            className={cn(
              "inline-flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-3 py-1",
              PRESS,
              FOCUS,
            )}
          >
            <Folder aria-hidden className="size-4 shrink-0 text-dim" />
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="truncate text-sm leading-snug">{name}</span>
              <span className="truncate text-xs leading-snug text-dim">
                {CONDITION_LABEL[condition]}
              </span>
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
          </button>
        ) : (
          // The folder's place, so Add stays at the right end whether or not there is a summary.
          <div className="flex min-h-11 min-w-0 flex-1 items-center">
            {destination.summary?.(rows)}
          </div>
        )}
        <button
          type="button"
          // The whole sentence, which the two words drawn begin: `Add 8` is what fits beside
          // the folder at 360px, and `Add 8 to collection · 2 need a finish` is what it does.
          // One name in both states — `aria-busy` is what says the write is under way.
          aria-label={addLabel(ready, needsFinish, destination?.name)}
          aria-disabled={refused || undefined}
          aria-busy={committing || undefined}
          // The reason is the press's description, so it is read with the press. Nothing while a
          // write is in flight: the press is held, and the spinner (an Add) or the actions'
          // rows (an Archive) say which write.
          aria-describedby={refusal !== null && !busy ? reasonId : undefined}
          onClick={() => {
            if (!refused) onCommit();
          }}
          className={cn(
            "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-4",
            "text-sm font-medium whitespace-nowrap text-accent-fg tabular-nums",
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
          Add {ready}
        </button>
      </div>
      {/* Words a screen reader is given and the page does not draw. The condition is drawn in the
          press, but the press's name replaces its contents, so its description says it whole; the
          design has no refusal line, and a description has to be an element to point at. */}
      {destination === undefined && (
        <span id={conditionId} className="sr-only">
          {`Condition: ${CONDITION_LABEL[condition]}`}
        </span>
      )}
      {refusal !== null && !busy && (
        <span id={reasonId} className="sr-only">
          {refusal}
        </span>
      )}

      <ActionSheet
        open={folderOpen}
        title="Folder for scanned cards"
        closeLabel="Close folders"
        // A press on the scrim leaves the caret where the reader put it; Escape, the ✕ and a
        // choice hand it back to the press that opened the sheet, which is always on the page.
        onClose={() => setFolderOpen(false)}
        onDismiss={closeFolders}
      >
        {folderPage === "new" ? (
          <>
            <SheetBack label={NEW_FOLDER_LABEL} onBack={() => setFolderPage("list")} />
            <NewFolderPage newFolder={newFolder} onCreated={closeFolders} />
          </>
        ) : (
          <>
            <ul aria-label="Folders">
              <SheetChoice
                label={ROOT_LABEL}
                current={folderId === null}
                onPick={() => {
                  onFolder(null);
                  closeFolders();
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
                    closeFolders();
                  }}
                />
              ))}
            </ul>
            {/* A list of its own under the destinations: this row makes a place rather than
                being one. */}
            <ul className="border-t border-border">
              <SheetRow
                label={NEW_FOLDER_LABEL}
                Icon={FolderPlus}
                opens
                onPress={() => {
                  newFolder.reset();
                  setFolderPage("new");
                }}
              />
            </ul>
          </>
        )}
      </ActionSheet>
    </div>
  );
}

/**
 * A new folder's name — the folder sheet's second page, `HistorySheet`'s rename page in shape: a
 * labelled 16px box, the refusal under it in the backend's words, and the press. Create makes the
 * folder at the top level and picks it; the sheet then closes, as a choice in the list does.
 *
 * **The caret goes into the box as the page mounts**: the reader pressed *New folder…* to type a
 * name, and a page that waited for a second press on the box would be one step longer for nothing.
 */
function NewFolderPage({
  newFolder,
  onCreated,
}: {
  newFolder: TrayNewFolder;
  onCreated: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = name.trim();
  const held = typed === "" || newFolder.pending;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      aria-label="New folder"
      className="flex flex-col gap-3 px-4 pt-3 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (held) return;
        void newFolder.create(typed).then((made) => {
          if (made) onCreated();
        });
      }}
    >
      <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
        Name
      </label>
      <input
        ref={inputRef}
        id={`${id}-name`}
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        // 16px: below it a phone zooms the page when the box takes the caret.
        className={cn(
          "h-11 w-full min-w-0 rounded-md border border-border bg-bg px-3 text-base text-text",
          "select-text focus:border-accent focus:outline-none",
          PRESS_STILL,
        )}
      />
      <Refusal>{newFolder.error === null ? null : newFolderRefusal(newFolder.error)}</Refusal>
      <button
        type="submit"
        aria-disabled={held || undefined}
        aria-busy={newFolder.pending || undefined}
        className={cn(GOLD_BUTTON, "self-end px-6")}
      >
        {/* Not a bare `New folder…`: the way back at the head of this page is named that. */}
        Create folder
      </button>
    </form>
  );
}
