import { useMemo, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { FolderInput, Layers, Trash2 } from "lucide-react";
import { cardPrintingsKey } from "@grimoire/ui/features/card/cardKeys";
import { MANAGED_REFUSAL, userWishFolders } from "@grimoire/ui/features/wishlist/managed";
import { useWishEntryWrites } from "@grimoire/ui/features/wishlist/useWishEntryWrites";
import { FINISH_LABEL, isFinish } from "@grimoire/ui/lib/finish";
import { buildFolderTree, flattenFolders } from "@grimoire/ui/lib/folderTree";
import { ipc, ipcError, type EntryChange, type WishlistFolder, type WishRow } from "@grimoire/ui/lib/ipc";
import { useMarketplace } from "@grimoire/ui/lib/useMarketplace";
import { cn } from "@grimoire/ui/lib/utils";
import { PRINTING_ROW, PrintingFace, printingCode } from "../card/Printings";
import { ReceiptBar } from "../deck/receipt";
import { ActionSheet, SheetBack, SheetChoice, SheetRow, SheetStepper } from "../deck/sheet";
import type { ListReceipt } from "./receipt";

/** What the wishlist's root is called — the desktop breadcrumb's word. */
const ROOT = "Wishlist";

/** What the sheet is open on: the wish's id, and the wish as it was last seen. */
export interface WishActing {
  wishId: number;
  seen: WishRow;
}

type Page = "main" | "printing" | "folder";

/**
 * What a wish offers **without leaving the page** — the desktop's `EditWish` panel for one wish, as
 * a sheet at the foot of the window: how many, which printing (or any), which folder, and the
 * removal. Every write is `useWishEntryWrites`', the desktop page's own mutations moved out of it
 * store-free, so the same commands land with the same `settleWhole`.
 *
 * - **Copies** — the stepper; **`−` at one copy is the removal**, the same write as `Remove from
 *   wishlist`. **No undo is offered**: the desktop's wish removal takes none either.
 * - **Printing** — `Any printing` first (the desktop's own write, withheld from a wish that is
 *   already for any printing, as `EditWish` withholds it), then every printing of the card: a press
 *   **pins** the wish to it, the write the All printings modal makes from a wish. A wish whose card
 *   has left the card database has no printings to offer, and says so.
 * - **Move to** — the root and the reader's own folders, never a deck's managed list: the backend
 *   refuses a hand write into one in `MANAGED_REFUSAL`'s words, and a destination whose only
 *   outcome is that sentence is a control that teaches nothing (`WishlistPage`'s `userNodes`).
 *
 * **What a wish asks for in its finish is part of the wish** and no write changes it on either face
 * — `wishlist_entries` has no update command, so the preferred finish is drawn in the subtitle and
 * nowhere offered. Neither is a wish's note.
 *
 * **A wish a deck manages is never opened here** — its tile has no `⋯` — and if one is, the sheet
 * says why in the desktop's words and offers nothing.
 */
export function WishActions({
  acting,
  rows,
  folders,
  receipt,
  onActing,
  onClose,
}: {
  acting: WishActing | null;
  rows: readonly WishRow[];
  folders: readonly WishlistFolder[];
  receipt: ListReceipt;
  onActing: (next: WishActing) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page>("main");
  const close = () => {
    setPage("main");
    onClose();
  };
  const wish = acting === null ? null : (rows.find((r) => r.id === acting.wishId) ?? acting.seen);
  const preferred = wish?.preferredFinish ?? null;
  const finish = preferred !== null && isFinish(preferred) ? preferred : null;
  const folderName =
    wish?.folderId == null
      ? ROOT
      : (folders.find((f) => f.id === wish.folderId)?.name ?? ROOT);

  return (
    <ActionSheet
      open={acting !== null}
      title={wish?.name ?? "Wish"}
      subtitle={
        wish === null
          ? undefined
          : [
              `${wish.quantity} wanted`,
              finish !== null ? FINISH_LABEL[finish] : null,
              folderName,
            ]
              .filter((part) => part !== null)
              .join(" · ")
      }
      closeLabel="Close wish actions"
      onClose={close}
      footer={<ReceiptBar receipt={receipt} />}
    >
      {wish !== null && (
        <WishPages
          key={wish.id}
          page={page}
          setPage={setPage}
          wish={wish}
          folders={folders}
          receipt={receipt}
          follow={(change, patch) =>
            onActing({ wishId: change.id, seen: { ...wish, ...patch, id: change.id } })
          }
          onGone={close}
        />
      )}
    </ActionSheet>
  );
}

function WishPages({
  page,
  setPage,
  wish,
  folders,
  receipt,
  follow,
  onGone,
}: {
  page: Page;
  setPage: (page: Page) => void;
  wish: WishRow;
  folders: readonly WishlistFolder[];
  receipt: ListReceipt;
  follow: (change: EntryChange, patch: Partial<WishRow>) => void;
  onGone: () => void;
}) {
  const writes = useWishEntryWrites();
  const back = () => setPage("main");
  const managed =
    wish.folderId !== null &&
    folders.some((f) => f.id === wish.folderId && f.managedDeckId !== null);

  if (managed) {
    return <p className="px-4 py-3 text-sm text-dim">{MANAGED_REFUSAL}</p>;
  }

  const removeWish = () => {
    receipt.track(
      writes.remove.mutateAsync(wish),
      () => `Removed ${wish.name} from your wishlist.`,
    );
    onGone();
  };

  if (page === "printing") {
    return (
      <PrintingPage
        wish={wish}
        onBack={back}
        onAny={() => {
          receipt.track(
            writes.anyPrinting.mutateAsync(wish).then((change) =>
              follow(change, { cardId: null, setCode: null, collectorNumber: null }),
            ),
            () => `${wish.name} is now a wish for any printing.`,
          );
          back();
        }}
        onPick={(cardId, setCode, collectorNumber) => {
          receipt.track(
            writes.setPrinting
              .mutateAsync({ row: wish, cardId })
              .then((change) => follow(change, { cardId, setCode, collectorNumber })),
            () => `${wish.name} is now a wish for ${setCode.toUpperCase()} ${collectorNumber}.`,
          );
          back();
        }}
      />
    );
  }
  if (page === "folder") {
    return (
      <FolderPage
        wish={wish}
        folders={folders}
        onBack={back}
        onPick={(folderId, name) => {
          receipt.track(
            writes.setFolder
              .mutateAsync({ id: wish.id, folderId })
              .then((change) => follow(change, { folderId })),
            () => `Moved ${wish.name} to ${name}.`,
          );
          back();
        }}
      />
    );
  }

  const pinned = wish.setCode !== null && wish.collectorNumber !== null;
  return (
    <>
      <SheetStepper
        quantity={wish.quantity}
        name={wish.name}
        onSet={(quantity) => {
          if (quantity === 0) {
            removeWish();
            return;
          }
          receipt.track(writes.setQuantity.mutateAsync({ row: wish, quantity }), () => null);
        }}
      />
      <ul>
        <SheetRow
          label="Printing"
          value={
            pinned
              ? `${(wish.setCode as string).toUpperCase()} · ${wish.collectorNumber as string}`
              : "Any printing"
          }
          Icon={Layers}
          opens
          reason={wish.oracleId === null ? "this card has left the card database" : null}
          onPress={() => setPage("printing")}
        />
        {userWishFolders(folders).length > 0 && (
          <SheetRow
            label="Move to"
            value={
              wish.folderId === null
                ? ROOT
                : (folders.find((f) => f.id === wish.folderId)?.name ?? ROOT)
            }
            Icon={FolderInput}
            opens
            onPress={() => setPage("folder")}
          />
        )}
        <SheetRow
          label="Remove from wishlist"
          Icon={Trash2}
          destructive
          onPress={removeWish}
        />
      </ul>
    </>
  );
}

/**
 * `Any printing`, then every printing of the card — the card sheet's list under its own key, each
 * a press that pins the wish to it.
 */
function PrintingPage({
  wish,
  onBack,
  onAny,
  onPick,
}: {
  wish: WishRow;
  onBack: () => void;
  onAny: () => void;
  onPick: (cardId: string, setCode: string, collectorNumber: string) => void;
}) {
  const { marketplace, currency } = useMarketplace();
  const oracleId = wish.oracleId;
  const printings = useQuery({
    queryKey: cardPrintingsKey(oracleId, marketplace.id),
    queryFn: oracleId !== null ? () => ipc.cardPrintings(oracleId, marketplace.id) : skipToken,
  });
  const anyNow = wish.cardId === null;
  const items = printings.data?.items ?? [];
  return (
    <>
      <SheetBack label="Printing" onBack={onBack} />
      <ul aria-label="Printings" className="px-2">
        <SheetChoice
          label="Any printing"
          current={anyNow}
          note={anyNow ? "already a wish for any printing" : undefined}
          onPick={onAny}
        />
        {printings.isPending ? (
          <li className="px-2 py-3 text-sm text-dim">Loading printings…</li>
        ) : printings.isError ? (
          <li role="alert" className="px-2 py-3 text-sm text-destructive">
            {`Couldn't load the printings — ${ipcError(printings.error)}`}
          </li>
        ) : (
          items.map((printing) => {
            const current = printing.id === wish.cardId;
            return (
              <SheetChoice
                key={printing.id}
                label={`${current ? "" : "Wish for "}${printing.setName ?? printing.setCode.toUpperCase()}, ${printingCode(printing)}`}
                current={current}
                onPick={() => onPick(printing.id, printing.setCode, printing.collectorNumber)}
              >
                <span className={cn(PRINTING_ROW, "min-w-0 flex-1 px-0")}>
                  <PrintingFace printing={printing} currency={currency} />
                </span>
              </SheetChoice>
            );
          })
        )}
      </ul>
    </>
  );
}

/** The root and the reader's own folders, nested — never a deck's managed list. */
function FolderPage({
  wish,
  folders,
  onBack,
  onPick,
}: {
  wish: WishRow;
  folders: readonly WishlistFolder[];
  onBack: () => void;
  onPick: (folderId: number | null, name: string) => void;
}) {
  const nodes = useMemo(
    () => flattenFolders(buildFolderTree(userWishFolders(folders), [])),
    [folders],
  );
  return (
    <>
      <SheetBack label="Move to" onBack={onBack} />
      <ul aria-label="Folders">
        <SheetChoice
          label={ROOT}
          current={wish.folderId === null}
          note={wish.folderId === null ? "already here" : undefined}
          onPick={() => onPick(null, ROOT)}
        />
        {nodes.map(({ folder, depth }) => (
          <SheetChoice
            key={folder.id}
            label={folder.name}
            current={folder.id === wish.folderId}
            indent={depth}
            note={folder.id === wish.folderId ? "already here" : undefined}
            onPick={() => onPick(folder.id, folder.name)}
          />
        ))}
      </ul>
    </>
  );
}
