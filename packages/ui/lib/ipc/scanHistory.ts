/**
 * Scan history: every pile the Scanner's tray filed into the collection or archived, kept so a
 * reader can go back and see what they scanned (issue #989).
 *
 * **One domain of `../ipc.ts`.** Nothing outside `packages/ui/lib/ipc*` imports this file: every
 * page, hook, story and test goes through `@/lib/ipc`, which re-exports these types and spreads
 * `scanHistoryCommands` into `ipc`. ESLint refuses the import, and `ipc.test.ts` reads this file
 * with its siblings, so the struct-parity and argument-name fences cover it.
 *
 * Every shape here mirrors `crates/grimoire-core/src/scan_history.rs`. **A batch is written by
 * the tray's two presses** — {@link ipc.scannerTrayCommit} and {@link ipc.scannerTrayArchive},
 * in `./scanner.ts` — never by a command here.
 */
import { invoke } from "./invoke";
import type { Finish } from "../finish";

/** Which press put a batch away: `filed` by Add to collection, or `archived`, kept in the
 *  history and filed nowhere. */
export type ScanBatchStatus = "filed" | "archived";

/** One line of a batch: a printing in a finish, and how many were put away. */
export interface ScanBatchLine {
  id: number;
  cardId: string;
  /** `null` when the printing has left the card database. */
  oracleId: string | null;
  /** As the card database has it, or as the line remembered it when the printing has gone — and
   *  the same for `setCode` and `collectorNumber`. */
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  layout: string | null;
  finish: Finish;
  quantity: number;
}

/** One batch in the history list. */
export interface ScanBatchSummary {
  id: number;
  /** `Scan N` until the reader renames it. */
  name: string;
  status: ScanBatchStatus;
  /** Where an Add filed it — `null` for the collection's root, and always for an archive. */
  folderId: number | null;
  /** That folder's name when the batch was written, so a deleted folder still says where the
   *  cards went. `null` for the root and for an archive. */
  folderName: string | null;
  /** The one condition the press filed at, as the import's lines carried it. */
  condition: string | null;
  /** Printings in a finish. */
  lineCount: number;
  /** Every line's quantity, added. */
  copies: number;
  /** The first line's printing, for a picture beside the row. */
  coverCardId: string | null;
  /** Unix seconds. */
  createdAt: number;
}

/** A whole batch: its list row, and its lines in the order the tray held them. */
export interface ScanBatch {
  summary: ScanBatchSummary;
  lines: ScanBatchLine[];
}

export const scanHistoryCommands = {
  /** Every batch, newest first. */
  scanHistoryList: () => invoke<ScanBatchSummary[]>("scan_history_list"),
  /** One batch with its lines, or `null` when it is gone. */
  scanHistoryGet: (id: number) => invoke<ScanBatch | null>("scan_history_get", { id }),
  /** A blank name is the default back, `Scan N`. Rejects for a batch that is gone. */
  scanHistoryRename: (id: number, name: string) =>
    invoke<void>("scan_history_rename", { id, name }),
  /** The batch and its lines. **The collection is not touched.** A batch already gone is a
   *  success. */
  scanHistoryDelete: (id: number) => invoke<void>("scan_history_delete", { id }),
};
