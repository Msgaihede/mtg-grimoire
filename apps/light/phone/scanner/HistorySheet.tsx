import { useEffect, useId, useState } from "react";
import { Archive, ArchiveRestore, ChevronRight, FolderInput, Pencil, Trash2 } from "lucide-react";
import { FinishMark } from "@grimoire/ui/components/FinishMark";
import {
  batchLine,
  batchStatusWords,
  deleteSentence,
  EMPTY_HISTORY,
  PUT_BACK_LABEL,
  SCAN_HISTORY_TITLE,
  scanWhen,
} from "@grimoire/ui/features/scanner/history/historyWords";
import {
  useScanBatch,
  useScanHistoryList,
  useScanHistoryWrites,
} from "@grimoire/ui/features/scanner/history/useScanHistory";
import { plural } from "@grimoire/ui/lib/counts";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { ipcError } from "@grimoire/ui/lib/ipc";
import type { ScanBatch, ScanBatchLine, ScanBatchSummary } from "@grimoire/ui/lib/ipc";
import { PRESS_STILL } from "@grimoire/ui/lib/motion";
import { notify } from "@grimoire/ui/lib/notifications";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet, SheetBack, SheetRow } from "../deck/sheet";
import { GOLD_BUTTON, PLAIN_BUTTON, Refusal, Thumb } from "../trade/parts";

/** Where in the sheet the reader is: the list, one batch, or one of that batch's two writes. */
type Page =
  | { kind: "list" }
  | { kind: "batch"; id: number }
  | { kind: "rename"; id: number }
  | { kind: "delete"; id: number };

const LIST: Page = { kind: "list" };

/**
 * **The scan history on the phone** (issue #989) — the desktop's *Scan history* dialog
 * (`ScanHistoryDialog`) in a sheet: every pile the tray put away, newest first, and one of them,
 * read-only, with its two writes.
 *
 * **Its reads, writes and sentences are the shared feature's** (`useScanHistory`,
 * `historyWords`) — the phone draws, it decides nothing. The desktop's two columns are the
 * sheet's pages, `OptionsSheet`'s grammar: the list, a batch drilled into (a `SheetBack` to the
 * list at its head), and that batch's *Rename* and *Delete…* as pages of their own, `MoreSheet`'s
 * rename for a trade. **The delete question is a page, not a second dialog** — one sheet is one
 * Back step (`sheetHistory.ts`), and a question stacked over it would need a rung of its own.
 *
 * **And *Put back in tray*** (issue #1374), a row above the record's two writes: it hands the batch
 * to the page (`onPutBack`), which lands its lines in the tray and closes the sheet — the desktop
 * dialog's press, for a pile filed by mistake and taken out again.
 *
 * **Not a place**: the history is a record to glance at between piles, and nothing in it is worth
 * a link, so the URL does not change. Back closes the sheet, as it closes every sheet; either way
 * out starts it on the list next time.
 *
 * **A batch that goes while it is drawn** — deleted here, or by the desktop face of this install —
 * answers `null` to its read, and the sheet goes back to the list rather than drawing a record of
 * nothing.
 */
export function HistorySheet({
  open,
  onClose,
  onDismiss,
  onPutBack,
}: {
  open: boolean;
  /** *Put back in tray*: the page lands the batch's lines in its tray, says so, and closes this —
   *  answering whether they landed. */
  onPutBack: (batch: ScanBatch) => boolean;
  /** A press on the scrim. */
  onClose: () => void;
  /** Escape and the ✕: the page hands the caret back to the press that opened the sheet. */
  onDismiss: () => void;
}) {
  const [page, setPage] = useState<Page>(LIST);
  const leave = (how: () => void) => () => {
    setPage(LIST);
    how();
  };
  return (
    <ActionSheet
      open={open}
      title={SCAN_HISTORY_TITLE}
      closeLabel="Close scan history"
      onClose={leave(onClose)}
      onDismiss={leave(onDismiss)}
    >
      {/* Mounted only while the sheet is open, so its reads are asked for afresh on every open
          (`useScanHistory`'s `staleTime: 0`) and a half-typed name never outlives a close. */}
      {open &&
        (page.kind === "list" ? (
          <BatchList onPick={(id) => setPage({ kind: "batch", id })} />
        ) : (
          <BatchPages
            page={page}
            onPage={setPage}
            onPutBack={(batch) => {
              // Landed, the sheet has closed: the next open starts on the list, `leave`'s rule. A
              // refusal is a toast, and the reader is left on the batch they pressed.
              if (onPutBack(batch)) setPage(LIST);
            }}
          />
        ))}
    </ActionSheet>
  );
}

/** Every batch, newest first — or why there are none. */
function BatchList({ onPick }: { onPick: (id: number) => void }) {
  const list = useScanHistoryList();
  if (list.isPending) {
    return <p className="px-4 py-4 text-sm text-dim">Loading your scans…</p>;
  }
  if (list.isError) {
    return (
      <div className="px-4 py-3">
        <Refusal>{ipcError(list.error)}</Refusal>
      </div>
    );
  }
  if (list.data.length === 0) {
    return <p className="px-6 py-8 text-center text-sm text-dim">{EMPTY_HISTORY}</p>;
  }
  return (
    <ul aria-label="Scans">
      {list.data.map((batch) => (
        <li key={batch.id}>
          <Entry batch={batch} onPick={() => onPick(batch.id)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One batch in the list: its cover, its name, when and how many, and where it went — a press the
 * width of the sheet that drills into it. The chevron is the promise of a page to open.
 */
function Entry({ batch, onPick }: { batch: ScanBatchSummary; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface",
        FOCUS_INSET,
      )}
    >
      {batch.coverCardId === null ? (
        <span aria-hidden className="w-9 shrink-0" />
      ) : (
        <Thumb cardId={batch.coverCardId} className="w-9" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{batch.name}</span>
        <span className="truncate text-xs text-dim">{batchLine(batch)}</span>
        <StatusWords batch={batch} />
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />
    </button>
  );
}

/**
 * Where a batch went, in words with its mark: gold for a pile filed into the collection, dim for
 * one only archived — the desktop chip's split, as a line a 360px row has room for.
 */
function StatusWords({ batch }: { batch: Pick<ScanBatchSummary, "status" | "folderName"> }) {
  const archived = batch.status === "archived";
  const Icon = archived ? Archive : FolderInput;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs",
        archived ? "text-dim" : "text-accent",
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{batchStatusWords(batch)}</span>
    </span>
  );
}

/**
 * The pages about one batch. Its read is asked here, once for all three, so a rename's page and
 * the delete question draw the name the batch has now.
 */
function BatchPages({
  page,
  onPage,
  onPutBack,
}: {
  page: Exclude<Page, { kind: "list" }>;
  onPage: (page: Page) => void;
  onPutBack: (batch: ScanBatch) => void;
}) {
  const batch = useScanBatch(page.id);
  const gone = batch.data === null;
  // A batch that is gone — deleted on the desktop face meanwhile — is a record of nothing: the
  // sheet goes back to the list, which has already dropped it or is about to.
  useEffect(() => {
    if (gone) onPage(LIST);
  }, [gone, onPage]);

  const back = <SheetBack label={SCAN_HISTORY_TITLE} onBack={() => onPage(LIST)} />;
  if (batch.isError) {
    return (
      <>
        {back}
        <div className="px-4 py-3">
          <Refusal>{ipcError(batch.error)}</Refusal>
        </div>
      </>
    );
  }
  if (batch.data === undefined || batch.data === null) return back;

  const { summary } = batch.data;
  const toBatch = () => onPage({ kind: "batch", id: summary.id });
  switch (page.kind) {
    case "rename":
      return (
        <>
          <SheetBack label="Rename" onBack={toBatch} />
          <RenamePage summary={summary} onDone={toBatch} />
        </>
      );
    case "delete":
      return (
        <>
          <SheetBack label="Delete" onBack={toBatch} />
          <DeletePage summary={summary} onCancel={toBatch} onDeleted={() => onPage(LIST)} />
        </>
      );
    case "batch":
      return (
        <>
          {back}
          <BatchView
            batch={batch.data}
            onPutBack={onPutBack}
            onRename={() => onPage({ kind: "rename", id: summary.id })}
            onDelete={() => onPage({ kind: "delete", id: summary.id })}
          />
        </>
      );
  }
}

/** One batch, read-only: its name, when and where it went, its two writes, and its lines. */
function BatchView({
  batch,
  onPutBack,
  onRename,
  onDelete,
}: {
  batch: ScanBatch;
  onPutBack: (batch: ScanBatch) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { summary, lines } = batch;
  return (
    <section aria-label={summary.name}>
      <header className="flex flex-col gap-1 px-4 pt-3 pb-2">
        <h3 className="font-heading text-lg leading-tight font-semibold break-words">
          {summary.name}
        </h3>
        <p className="text-xs text-dim">{scanWhen(summary.createdAt)}</p>
        <StatusWords batch={summary} />
      </header>
      <ul className="border-y border-border">
        <SheetRow label={PUT_BACK_LABEL} Icon={ArchiveRestore} onPress={() => onPutBack(batch)} />
        <SheetRow label="Rename" Icon={Pencil} opens onPress={onRename} />
        <SheetRow label="Delete…" Icon={Trash2} destructive onPress={onDelete} />
      </ul>
      {/* One string, so the name a reader hears is the sentence drawn; the printings only where
          they differ from the copies — the desktop dialog's count line. */}
      <h4 className="px-4 pt-3 pb-1 text-xs font-normal text-dim">
        {plural(summary.copies, "card")}
        {lines.length !== summary.copies ? ` · ${plural(lines.length, "printing")}` : ""}
      </h4>
      <ul aria-label={`Cards in ${summary.name}`} className="px-2 pb-2">
        {lines.map((line) => (
          <LineRow key={line.id} line={line} />
        ))}
      </ul>
    </section>
  );
}

/** One printing in one finish, and how many — the tray's row with its controls taken out. */
function LineRow({ line }: { line: ScanBatchLine }) {
  const printing = [line.setCode.toUpperCase(), line.collectorNumber]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <li className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5">
      <Thumb cardId={line.cardId} className="w-9" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{line.name}</span>
        <span className="flex items-center gap-1.5">
          {printing !== "" && <span className="font-mono text-xs text-dim">{printing}</span>}
          <FinishMark finish={line.finish} className="shrink-0" />
        </span>
      </span>
      {/* Beside the card, not on it, so it keeps its `×` (`packages/ui/CLAUDE.md`'s count rule). */}
      <span className="shrink-0 font-mono text-sm tabular-nums">×{line.quantity}</span>
    </li>
  );
}

/**
 * The batch's name, being changed — `MoreSheet`'s rename, with the desktop field's one
 * difference: **a blank name is a write, not a refusal.** The backend takes `""` as the default
 * back and names the batch `Scan N` again, the only undo a rename has; the placeholder says what
 * the reader will get. A refusal is said under the box, where the reader is looking.
 */
function RenamePage({ summary, onDone }: { summary: ScanBatchSummary; onDone: () => void }) {
  const id = useId();
  const writes = useScanHistoryWrites();
  const [name, setName] = useState(summary.name);
  const [renaming, setRenaming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const typed = name.trim();

  const rename = () => {
    if (renaming) return;
    // A name left as it was is no write at all.
    if (typed === summary.name) {
      onDone();
      return;
    }
    setRenaming(true);
    setFailure(null);
    writes
      .rename(summary.id, typed)
      .then(onDone, (e: unknown) => setFailure(`Couldn't rename the scan — ${ipcError(e)}`))
      .finally(() => setRenaming(false));
  };

  return (
    <form
      className="flex flex-col gap-3 px-4 pt-3 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        rename();
      }}
    >
      <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
        Name
      </label>
      <input
        id={`${id}-name`}
        type="text"
        value={name}
        placeholder={`Scan ${summary.id}`}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        // 16px: below it a phone zooms the page when the box takes the caret.
        className={cn(
          "h-11 w-full min-w-0 rounded-md border border-border bg-bg px-3 text-base text-text",
          "select-text focus:border-accent focus:outline-none",
          PRESS_STILL,
        )}
      />
      <p className="text-xs leading-snug text-dim">
        Leave it blank to go back to “Scan {summary.id}”.
      </p>
      <Refusal>{failure}</Refusal>
      <button
        type="submit"
        aria-disabled={renaming || undefined}
        aria-busy={renaming || undefined}
        className={cn(GOLD_BUTTON, "self-end px-6")}
      >
        {/* Not a bare `Rename`: the way back at the head of this page is named that. */}
        Rename scan
      </button>
    </form>
  );
}

/**
 * The delete question — the desktop's sentence (`deleteSentence`, which says the collection is not
 * touched) and its two presses. **Leave first, then delete**, the desktop's order: the sheet goes
 * back to the list at once, and the outcome is a toast in the desktop's words.
 */
function DeletePage({
  summary,
  onCancel,
  onDeleted,
}: {
  summary: ScanBatchSummary;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const writes = useScanHistoryWrites();
  return (
    <div className="flex flex-col gap-4 px-4 pt-3 pb-4 text-sm">
      <p className="leading-relaxed text-dim">{deleteSentence(summary)}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={cn(PLAIN_BUTTON, "px-5")}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onDeleted();
            writes.remove(summary.id).then(
              () =>
                notify.success(
                  `Deleted “${summary.name}” from ${SCAN_HISTORY_TITLE.toLowerCase()}`,
                ),
              (e: unknown) =>
                notify.error(`Couldn't delete “${summary.name}”`, { body: ipcError(e) }),
            );
          }}
          className={cn(PLAIN_BUTTON, "border-destructive px-5 text-destructive")}
        >
          Delete scan
        </button>
      </div>
    </div>
  );
}
