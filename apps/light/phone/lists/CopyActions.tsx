import { useMemo, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { FolderInput, Gauge, Layers, Sparkles, Trash2 } from "lucide-react";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { cardPrintingsKey } from "@/features/card/cardKeys";
import { copyOption, finishRefusal } from "@/features/card/copyEdit";
import { countEditableIn, quantityRefusal } from "@/features/collection/entryFences";
import { useCollectionEntryWrites } from "@/features/collection/useCollectionEntryWrites";
import { useSetCollectionFolder } from "@/features/collection/useCollectionFolders";
import { useCopyFinish, useCopyPrinting, useCopyUpdate } from "@/features/collection/useCopyWrites";
import { useBulkUndoAction } from "@/components/UndoNotice";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, finishLabel, isFinish, parseFinishes, type Finish } from "@/lib/finish";
import { buildFolderTree, flattenFolders, lockedFolderIds } from "@/lib/folderTree";
import { ipc, ipcError, type CollectionFolder, type CollectionRow, type EntryChange } from "@/lib/ipc";
import { tileKeyOf } from "@/lib/tileKey";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { PRINTING_ROW, PrintingFace, printingCode } from "../card/Printings";
import { ReceiptBar } from "../deck/receipt";
import { ActionSheet, SheetBack, SheetChoice, SheetRow, SheetStepper } from "../deck/sheet";
import type { ListReceipt } from "./receipt";

/** What the collection's root is called — the desktop breadcrumb's word, and `EditCopy`'s. */
const ROOT = "Collection";

/**
 * What the sheet is open on: the tile pressed, and — once one is chosen — the one
 * `collection_entries` row every write addresses, with that row as it was last seen.
 */
export interface CopyActing {
  /** `tileKeyOf(card, finish, folder)` — the tile's own key, which is the item's. */
  tileKey: string;
  /** The row the sheet edits, or `null` while the reader is choosing which. */
  entryId: number | null;
  /** Drawn while the list's re-read has not answered with the row at its new id. */
  seen: CollectionRow | null;
}

type Page = "copies" | "main" | "condition" | "finish" | "printing" | "folder";

/** A copy's grade as the app spells it, or the stored word where it is not one of the six. */
function gradeOf(raw: string): string {
  for (const c of CONDITIONS) if (c === raw) return CONDITION_LABEL[c];
  return raw;
}

/** A row named for a sentence: the card, and its printing for an orphan whose name is gone. */
const nameOf = (row: CollectionRow): string =>
  row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`;

/**
 * What a collection tile offers **without leaving the page** — the desktop's edits to one copy, as a
 * sheet at the foot of the window: how many, what grade, which finish, which printing, which
 * drawer, and the removal.
 *
 * # Which row
 *
 * **A tile is one printing in one finish in one folder, and can stand for several rows** — two
 * grades, two languages (`collectionWall.ts`' fold). Every write here addresses **one** row, the
 * desktop's own rule from both of its ends: the card modal's `Edit` becomes `Edit which copy` over
 * a printing in more than one row, and the wall's `Move to` asks `PickCopies` which copies rather
 * than moving all of them. So a tile behind more than one row opens on **its copies, listed** —
 * each in the modal's own words (`copyOption`: `2× Near mint · Etched`, the drawer under it) — and
 * a press on one opens that copy's actions; a tile of one row opens on its actions at once. Nothing
 * here ever writes to a row the reader did not name.
 *
 * # The writes
 *
 * Each is the desktop's own mutation through a store-free module, so a write here and one on the
 * desktop are the same command with the same invalidations:
 *
 * - **Copies** — `useCollectionEntryWrites`' stepper, fenced by `entryFences`' `quantityRefusal`
 *   and said in its words where it refuses (a deck's group). **`−` at one copy is the removal**,
 *   the same press as `Remove from collection` below it: the menu's `collection_remove_many`,
 *   whose ticket the receipt offers back through the desktop's `bulk_undo`.
 * - **Condition** — `EditCopy`'s save (`useCopyUpdate`), the grade alone. **Purchase price** is
 *   the other half of that dialog and is not offered here yet.
 * - **Finish** and **Printing** — the card modal's `Edit` (`useCopyFinish`, `useCopyPrinting`),
 *   refused before the write where a printing was never made in the copy's finish
 *   (`finishRefusal`, the modal's sentence).
 * - **Move to** — `useSetCollectionFolder`, the menu's `Move to`: the root and the reader's own
 *   drawers, a drawer set aside marked and offered as the menu offers it. A copy in a deck's group
 *   is refused by the backend in its own words, as on the desktop.
 *
 * **A write that folds the row follows it**: the grade, the finish, the printing and the drawer
 * are all grain columns, so each can land on a row already there and answer its id — the sheet
 * re-points at that id and keeps the row last seen, carrying what the write changed, until the
 * re-read arrives. A removal has nothing to follow and closes the sheet.
 */
export function CopyActions({
  acting,
  rows,
  folders,
  receipt,
  onActing,
  onClose,
}: {
  acting: CopyActing | null;
  /** The rows the page has loaded — what the tile and its copies are looked up in. */
  rows: readonly CollectionRow[];
  /** The whole cabinet, every kind — the fences and the drawers both read it. */
  folders: readonly CollectionFolder[];
  receipt: ListReceipt;
  onActing: (next: CopyActing) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page>("main");
  const close = () => {
    setPage("main");
    onClose();
  };
  const tileRows = useMemo(
    () => (acting === null ? [] : rows.filter((row) => tileKeyMatches(row, acting.tileKey))),
    [rows, acting],
  );
  const row =
    acting === null || acting.entryId === null
      ? null
      : (rows.find((r) => r.id === acting.entryId) ?? acting.seen);
  // Several rows and none chosen: the copies are the first page, whatever was last open.
  const shown: Page = row === null ? "copies" : page;
  const first = row ?? tileRows[0] ?? acting?.seen ?? null;

  /** Re-point the sheet at the row a write answered with, carrying what it is known to have
   *  changed onto the row last seen. */
  const follow = (from: CollectionRow, change: EntryChange, patch: Partial<CollectionRow>) => {
    const seen = { ...from, ...patch, id: change.id };
    onActing({ tileKey: tileKeyOfRow(seen), entryId: change.id, seen });
  };

  return (
    <ActionSheet
      open={acting !== null}
      title={first === null ? "Copies" : nameOf(first)}
      subtitle={
        row === null
          ? tileRows.length > 1
            ? `${tileRows.length} copies on this tile — which one?`
            : undefined
          : `${copyOption(row).label} · ${row.folderName ?? ROOT}`
      }
      closeLabel="Close copy actions"
      onClose={close}
      footer={<ReceiptBar receipt={receipt} />}
    >
      {acting !== null &&
        (shown === "copies" || row === null ? (
          <CopiesPage
            rows={tileRows}
            onPick={(picked) => {
              setPage("main");
              onActing({ ...acting, entryId: picked.id, seen: picked });
            }}
          />
        ) : (
          <RowPages
            // A different row is a fresh set of pages, not the last row's open list.
            key={row.id}
            page={shown}
            setPage={setPage}
            row={row}
            several={tileRows.length > 1}
            folders={folders}
            receipt={receipt}
            follow={follow}
            onBackToCopies={() => onActing({ ...acting, entryId: null, seen: null })}
            onGone={close}
          />
        ))}
    </ActionSheet>
  );
}

/** `tileKeyOf` read back off a row — the wall's own key, spelled once in `@/lib/tileKey`. */
const tileKeyOfRow = (row: CollectionRow): string => tileKeyOf(row.cardId, row.finish, row.folderId);
const tileKeyMatches = (row: CollectionRow, key: string): boolean => tileKeyOfRow(row) === key;

/** The rows behind one tile, each a press that opens it — the modal's `Edit which copy`. */
function CopiesPage({
  rows,
  onPick,
}: {
  rows: readonly CollectionRow[];
  onPick: (row: CollectionRow) => void;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-sm text-dim">These copies are not in your collection any more.</p>;
  }
  return (
    <ul aria-label="Copies on this tile">
      {rows.map((row) => {
        const { label, hint } = copyOption(row);
        return (
          <SheetRow
            key={row.id}
            label={`${label} · ${row.lang.toUpperCase()}`}
            value={hint}
            opens
            onPress={() => onPick(row)}
          />
        );
      })}
    </ul>
  );
}

function RowPages({
  page,
  setPage,
  row,
  several,
  folders,
  receipt,
  follow,
  onBackToCopies,
  onGone,
}: {
  page: Page;
  setPage: (page: Page) => void;
  row: CollectionRow;
  several: boolean;
  folders: readonly CollectionFolder[];
  receipt: ListReceipt;
  follow: (from: CollectionRow, change: EntryChange, patch: Partial<CollectionRow>) => void;
  onBackToCopies: () => void;
  onGone: () => void;
}) {
  const { setQuantity, removeMany } = useCollectionEntryWrites();
  const update = useCopyUpdate();
  const finishWrite = useCopyFinish();
  const printingWrite = useCopyPrinting();
  const move = useSetCollectionFolder();
  const bulk = useBulkUndoAction("collection");
  const name = nameOf(row);
  const finish = isFinish(row.finish) ? row.finish : null;
  const back = () => setPage("main");

  /** `Remove from collection` — the menu's one write, and its ticket offered back. */
  const removeRow = () => {
    receipt.track(
      removeMany.mutateAsync({ entryIds: [row.id], name: row.name }),
      () => `Removed ${row.quantity} × ${name} from your collection.`,
      (outcome) => {
        const ticket = outcome.undoId;
        return ticket === null
          ? null
          : { name: `put back ${name}`, run: () => bulk.take(ticket) };
      },
    );
    onGone();
  };

  if (page === "condition") {
    return (
      <>
        <SheetBack label="Condition" onBack={back} />
        <ul aria-label="Conditions">
          {CONDITIONS.map((c: Condition) => (
            <SheetChoice
              key={c}
              label={CONDITION_LABEL[c]}
              current={c === row.condition}
              onPick={() => {
                receipt.track(
                  update
                    .mutateAsync({ id: row.id, patch: { condition: c } })
                    .then((change) => follow(row, change, { condition: c })),
                  () => `${name} is now ${CONDITION_LABEL[c].toLowerCase()}.`,
                );
                back();
              }}
            />
          ))}
        </ul>
      </>
    );
  }
  if (page === "finish") {
    return (
      <FinishPage
        row={row}
        onBack={back}
        onPick={(to) => {
          receipt.track(
            finishWrite
              .mutateAsync({ id: row.id, cardId: row.cardId, finish: to })
              .then((change) => follow(row, change, { finish: to })),
            () => `${name} is now ${FINISH_LABEL[to].toLowerCase()}.`,
          );
          back();
        }}
      />
    );
  }
  if (page === "printing") {
    return (
      <PrintingPage
        row={row}
        onBack={back}
        onRefused={(sentence) =>
          // Said before any write, the modal's order: nothing was sent.
          receipt.track(Promise.reject(new Error(sentence)), () => null)
        }
        onPick={(cardId, words, setCode, collectorNumber) => {
          receipt.track(
            printingWrite
              .mutateAsync({ id: row.id, cardId, finish })
              .then((change) => follow(row, change, { cardId, setCode, collectorNumber })),
            () => `${name} is now ${words}.`,
          );
          back();
        }}
      />
    );
  }
  if (page === "folder") {
    return (
      <FolderPage
        row={row}
        folders={folders}
        onBack={back}
        onPick={(folderId, folderName) => {
          receipt.track(
            move
              .mutateAsync({ entryId: row.id, folderId })
              .then((change) =>
                follow(row, change, { folderId, folderName: folderId === null ? null : folderName }),
              ),
            () => `Moved ${name} to ${folderName}.`,
          );
          back();
        }}
      />
    );
  }

  const countRefusal = quantityRefusal(folders, row);
  const hasFolders = folders.some((f) => f.kind === "user");
  return (
    <>
      {several && <SheetBack label="All copies on this tile" onBack={onBackToCopies} />}
      {countRefusal === null ? (
        <SheetStepper
          quantity={row.quantity}
          name={name}
          onSet={(quantity) => {
            if (quantity === 0) {
              removeRow();
              return;
            }
            // A step is said by the stepper's own number; only a refusal reaches the line.
            receipt.track(setQuantity.mutateAsync({ row, quantity }), () => null);
          }}
        />
      ) : (
        <p className="border-b border-border px-4 pt-2 pb-3 text-sm text-dim">
          <span className="text-text">{`${row.quantity} ${row.quantity === 1 ? "copy" : "copies"}`}</span>
          {` — ${countRefusal}`}
        </p>
      )}
      <ul>
        <SheetRow
          label="Condition"
          value={gradeOf(row.condition)}
          Icon={Gauge}
          opens
          onPress={() => setPage("condition")}
        />
        <SheetRow
          label="Finish"
          value={finish === null ? finishLabel(row.finish) : FINISH_LABEL[finish]}
          Icon={Sparkles}
          opens
          reason={finish === null ? "this build cannot name the copy's finish" : null}
          onPress={() => setPage("finish")}
        />
        <SheetRow
          label="Printing"
          value={`${row.setCode.toUpperCase()} · ${row.collectorNumber}`}
          Icon={Layers}
          opens
          reason={row.oracleId === null ? "this printing has left the card database" : null}
          onPress={() => setPage("printing")}
        />
        {/* The menu's `Move to` is drawn only once the reader has a drawer of their own: with no
            cabinet the only destination is the root, where every unfiled copy already is. */}
        {hasFolders && (
          <SheetRow
            label="Move to"
            value={row.folderName ?? ROOT}
            Icon={FolderInput}
            opens
            onPress={() => setPage("folder")}
          />
        )}
        <SheetRow
          label="Remove from collection"
          Icon={Trash2}
          destructive
          reason={countEditableIn(folders, row.folderId) ? null : countRefusal}
          onPress={removeRow}
        />
      </ul>
    </>
  );
}

/**
 * The finishes this printing is sold in, in Scryfall's order — read through the card modal's own
 * query, so a card already opened answers from the cache.
 */
function FinishPage({
  row,
  onBack,
  onPick,
}: {
  row: CollectionRow;
  onBack: () => void;
  onPick: (finish: Finish) => void;
}) {
  const { marketplace } = useMarketplace();
  const detail = useQuery({
    queryKey: cardDetailKey(row.cardId, marketplace.id),
    queryFn: () => ipc.cardDetail(row.cardId, marketplace.id),
  });
  const offered = parseFinishes(detail.data?.finishes ?? null);
  return (
    <>
      <SheetBack label="Finish" onBack={onBack} />
      {detail.isPending ? (
        <p className="px-4 py-3 text-sm text-dim">Loading the printing…</p>
      ) : detail.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {`Couldn't read the printing — ${ipcError(detail.error)}`}
        </p>
      ) : offered.length <= 1 ? (
        <p className="px-4 py-3 text-sm text-dim">This printing is sold in one finish.</p>
      ) : (
        <ul aria-label="Finishes">
          {offered.map((f) => (
            <SheetChoice
              key={f}
              label={FINISH_LABEL[f]}
              current={f === row.finish}
              onPick={() => onPick(f)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Every printing of the card, as the card sheet lists them — the same read under the same key —
 * each a press that moves this copy onto it. A printing never made in the copy's finish says so
 * before anything is written (`finishRefusal`, the card modal's rule and words).
 */
function PrintingPage({
  row,
  onBack,
  onRefused,
  onPick,
}: {
  row: CollectionRow;
  onBack: () => void;
  onRefused: (sentence: string) => void;
  onPick: (cardId: string, words: string, setCode: string, collectorNumber: string) => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const oracleId = row.oracleId;
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, marketplace.id),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, marketplace.id) : skipToken,
  });
  const finish = isFinish(row.finish) ? row.finish : null;
  const items = printings.data?.items ?? [];
  return (
    <>
      <SheetBack label="Printing" onBack={onBack} />
      {printings.isPending ? (
        <p className="px-4 py-3 text-sm text-dim">Loading printings…</p>
      ) : printings.isError ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {`Couldn't load the printings — ${ipcError(printings.error)}`}
        </p>
      ) : (
        <ul aria-label="Printings" className="px-2">
          {items.map((printing) => {
            const current = printing.id === row.cardId;
            const refusal = finish === null ? null : finishRefusal(finish, printing);
            return (
              <SheetChoice
                key={printing.id}
                label={`${current ? "" : "Move to "}${printing.setName ?? printing.setCode.toUpperCase()}, ${printingCode(printing)}`}
                current={current}
                onPick={() =>
                  refusal !== null
                    ? onRefused(refusal)
                    : onPick(
                        printing.id,
                        `${printing.setCode.toUpperCase()} ${printing.collectorNumber}`,
                        printing.setCode,
                        printing.collectorNumber,
                      )
                }
              >
                <span className={cn(PRINTING_ROW, "min-w-0 flex-1 px-0", refusal !== null && "opacity-60")}>
                  <PrintingFace printing={printing} currency={currency} />
                </span>
              </SheetChoice>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * Where a copy can go — the menu's `Move to` cabinet: the root, then the reader's own drawers,
 * nested as the tree is. **The app's own drawers are not destinations** (a deck's group is reached
 * through the deck, `Recently removed` through a removal), and a drawer set aside is offered as
 * the menu offers it, marked so a reader knows where the copy will be.
 */
function FolderPage({
  row,
  folders,
  onBack,
  onPick,
}: {
  row: CollectionRow;
  folders: readonly CollectionFolder[];
  onBack: () => void;
  onPick: (folderId: number | null, name: string) => void;
}) {
  const nodes = useMemo(
    () => flattenFolders(buildFolderTree(folders.filter((f) => f.kind === "user"), [])),
    [folders],
  );
  const locked = useMemo(() => lockedFolderIds(folders), [folders]);
  return (
    <>
      <SheetBack label="Move to" onBack={onBack} />
      <ul aria-label="Folders">
        <SheetChoice
          label={ROOT}
          current={row.folderId === null}
          note={row.folderId === null ? "already here" : undefined}
          onPick={() => onPick(null, ROOT)}
        />
        {nodes.map(({ folder, depth }) => (
          <SheetChoice
            key={folder.id}
            label={folder.name}
            current={folder.id === row.folderId}
            indent={depth}
            note={
              folder.id === row.folderId
                ? "already here"
                : locked.has(folder.id)
                  ? "set aside"
                  : undefined
            }
            onPick={() => onPick(folder.id, folder.name)}
          />
        ))}
      </ul>
    </>
  );
}
