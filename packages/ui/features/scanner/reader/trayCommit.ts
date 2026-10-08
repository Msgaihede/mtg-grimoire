/**
 * What a commit — or a confirmed *Clear all…* — leaves in the tray, and where a commit may file.
 *
 * Pure, and beside `tray.ts` rather than in it: that module "knows nothing about a folder", and
 * these two are the questions a surface asks around the commit rather than a reduction of the rows.
 * Both of the app's Scanner surfaces — the desktop view and the light app's phone page — ask them
 * through `useTrayCommit.ts`.
 */
import type { CollectionFolder, ScannerTrayRow } from "@/lib/ipc";

/** Is `id` a drawer the reader made? `null` — the root — always is. */
export function isUserFolder(folders: readonly CollectionFolder[], id: number | null): boolean {
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
export function withoutCommitted(
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
