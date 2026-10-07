import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import type { Condition } from "@/lib/conditions";
import type { CollectionImportItem, ImportCommitOutcome, ScannerTrayRow } from "@/lib/ipc";
import { ipcError } from "@/lib/ipc";
import { invalidateOwnedWrite } from "@/lib/searchMarks";
import { commitPlan, importItems, totalCopies } from "./reader/tray";
import { isUserFolder, withoutCommitted } from "./reader/trayCommit";
import type { TrayState } from "./useTray";

/** The collection's folder list as a Scanner surface reads it — `useCollectionFolderList`'s. */
type FolderList = ReturnType<typeof useCollectionFolderList>;

/**
 * Where the tray files: the stored folder, **or the root when that folder is gone or is not the
 * reader's own.**
 *
 * The id is stored and the folder is not, so another surface can delete it — and
 * `collection_import_commit` accepts a deck's group, because the import's deck arm files there on
 * purpose, so a stored id that now names one would put scanned cards in a deck's box behind the
 * reader's back. Decided only once the list has answered; until then the stored id stands, and the
 * commit asks again. A stale id is written back as the root once the prefs have loaded, through
 * `onStale` — the page's `useScannerPrefs().update`.
 *
 * `stored` is `prefs.folderId`; `loaded` is the prefs'.
 */
export function useTrayFolder(
  stored: number | null,
  loaded: boolean,
  onStale: (patch: { folderId: null }) => void,
): { folderId: number | null; folderList: FolderList } {
  const folderList = useCollectionFolderList();
  const staleFolder = folderList.query.isSuccess && !isUserFolder(folderList.folders, stored);
  useEffect(() => {
    if (loaded && staleFolder) onStale({ folderId: null });
  }, [loaded, staleFolder, onStale]);
  return { folderId: staleFolder ? null : stored, folderList };
}

/** What one Add filed, for a surface that says so afterwards. */
export interface TrayCommitted {
  /** `scanner_tray_commit`'s answer — the import's own outcome. Its `undoId` is `null` today
   *  (issue #555): the filed lines left the stored tray in the same write. */
  outcome: ImportCommitOutcome;
  /** The copies the press took out of the tray — the import's lines, summed. */
  copies: number;
  /** Where they were filed: the folder the commit went out with, `null` for the root. */
  folderId: number | null;
}

export interface TrayCommit {
  /**
   * File the tray. **Never rejects**: a refusal is {@link TrayCommit.error}'s sentence and a
   * `null` answer, and a press while one is already in flight is `null` and nothing else.
   */
  commit: () => Promise<TrayCommitted | null>;
  committing: boolean;
  /** The last refusal, in the backend's own words — or the plan's. Cleared by the next press. */
  error: string | null;
}

/**
 * The tray into the collection, in one `scanner_tray_commit` — the collection import and the
 * tray that is left after it, in one transaction, so all or nothing: a refusal keeps every row
 * and hands back the sentence, and the backend's own words are the sentence, because they
 * already name what is wrong.
 *
 * **Every row with a known finish, and none without one.** `commitPlan` splits the tray: the
 * rows it takes are the import's lines *and* the snapshot `withoutCommitted` subtracts, so
 * a row of unknown finish is never "taken", and it is still in `remaining` when the commit goes
 * out and still in the tray when it answers — marked, where the reader left it.
 *
 * **The stored tray moves with the collection, not behind it.** This used to commit and then let
 * the tray's debounced write catch up; an app closed in that window — or that write refused, or
 * an older one landing after the commit — restored the committed rows at the next launch, and the
 * next Add filed them twice. `tray.commit` queues behind any tray write already on the wire and
 * computes what is left (`withoutCommitted`) against the rows as they are when it goes out.
 *
 * **What is filed is the pressed rows that are still in the tray when the write goes out**, by
 * identity. `committing` below is one mount's state, and the commit queues behind whatever is on
 * the wire — so a view that unmounted while its commit waited on a sync, and came back (a tab
 * away and back on the phone, a resize across the two faces), could be pressed again over the very
 * rows the first press took, and the same cards were filed twice. The second commit now builds
 * its lines when it goes out: the first has landed by then and its rows are gone, so there is
 * nothing to send and it answers `null`. A row the reader edited between the press and the send
 * is left in the tray rather than filed as it was.
 *
 * The folder is asked about again here rather than trusted from the render: the list may not
 * have answered yet, and this press is the one moment a wrong answer would write.
 *
 * It invalidates `invalidateOwnedWrite`'s set — the import's own, for the import's reason: these
 * are copies the collection did not hold a moment ago, and every surface that reads "what is
 * owned" moves with them.
 *
 * `condition` and `folderId` are the stored prefs' (`prefs.condition`, `prefs.folderId` — the
 * stored id, not {@link useTrayFolder}'s answer, because this asks the list itself).
 */
export function useTrayCommit({
  tray,
  condition,
  folderId,
  folderList,
}: {
  tray: Pick<TrayState, "latest" | "commit">;
  condition: Condition;
  folderId: number | null;
  folderList: FolderList;
}): TrayCommit {
  const queryClient = useQueryClient();
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (): Promise<TrayCommitted | null> => {
    if (committing) return null;
    let snapshot: ScannerTrayRow[];
    try {
      // The plan is asked for its refusals and for which rows the press takes; the lines
      // themselves are built when the write goes out.
      ({ taken: snapshot } = commitPlan(tray.latest(), condition));
    } catch (e) {
      setError(ipcError(e));
      return null;
    }
    const chosen = folderId;
    setCommitting(true);
    setError(null);
    try {
      const folders = folderList.query.data ?? (await folderList.query.refetch()).data;
      // A list that would not load leaves the id to the backend, which refuses a folder that is
      // gone in words; a list that did load has already said whether the id is the reader's.
      const target = folders === undefined || isUserFolder(folders, chosen) ? chosen : null;
      // The pressed rows still there as the write goes out — the rest were filed by a commit
      // ahead of this one, or changed under it.
      let taken = snapshot;
      const lines = (sent: ScannerTrayRow[]): CollectionImportItem[] => {
        taken = snapshot.filter((row) => sent.includes(row));
        return importItems(taken, condition);
      };
      const outcome = await tray.commit(lines, target, (latest) =>
        withoutCommitted(latest, taken),
      );
      if (outcome === null) return null;
      invalidateOwnedWrite(queryClient);
      return { outcome, copies: totalCopies(taken), folderId: target };
    } catch (e) {
      setError(ipcError(e));
      return null;
    } finally {
      setCommitting(false);
    }
  };

  return { commit, committing, error };
}
