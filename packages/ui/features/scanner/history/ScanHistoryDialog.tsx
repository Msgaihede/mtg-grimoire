import { useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, FolderInput, Pencil, Trash2 } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { FinishMark } from "@/components/FinishMark";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { PANEL_BUTTON } from "@/features/settings/controls";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipcError } from "@/lib/ipc";
import type { ScanBatch, ScanBatchLine, ScanBatchSummary } from "@/lib/ipc";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { notify } from "@/lib/notifications";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import {
  batchLine,
  batchStatusWords,
  deleteSentence,
  EMPTY_HISTORY,
  PICK_A_SCAN,
  PUT_BACK_HINT,
  PUT_BACK_LABEL,
  SCAN_HISTORY_TITLE,
  scanWhen,
} from "./historyWords";
import {
  scanBatchKey,
  useScanBatch,
  useScanHistoryList,
  useScanHistoryWrites,
} from "./useScanHistory";

/**
 * **The scan history** (issue #989: "Users want to go back and see what they scanned") — every pile
 * the Scanner's tray put away, newest first, and the one picked, read-only.
 *
 * **The trades page's shape, in a dialog**: the list on the left (`TradesPane`), the picked batch
 * on the right with its name and what can be done to it (`TradeView` on a closed trade — no
 * steppers, nothing to add). A batch is a record and never a draft, so the only writes are the
 * record's own: Rename, and Delete — which asks first, and says the collection is not touched,
 * because a reader deleting the record of a pile they filed is afraid of exactly that.
 *
 * **And one press that is the tray's, not the record's: *Put back in tray*** (issue #1374). It
 * hands the batch to the page (`onPutBack`), which lands its lines in the tray and closes this —
 * the way back from a pile filed by mistake and taken out again. The batch stays as it was: a
 * record of what was put away then, beside the new one the next Add or Archive writes.
 *
 * **Opened from the Scanner view's bar alone**, and mounted by the page as a sibling of its
 * `@container/scan` box rather than inside it — a container is the containing block for a `fixed`
 * scrim (`packages/ui/CLAUDE.md`'s `@container` rule). The delete question is a sibling of this
 * dialog for the same reason one floor up: the panel is a `motion.div` with a transform, which is
 * a containing block too, so a scrim mounted in the body would be the size of the panel. It sits
 * on the `stacked` rung because it is opened over this one, and two scrims at one rung are a tie
 * that document order decides (`layers.ts`).
 *
 * **Picking is this dialog's state and fresh on every open**: the body mounts only while it is
 * open, and opens on the newest batch — the pile just scanned is the usual reason to look.
 */
export function ScanHistoryDialog({
  open,
  onDismiss,
  onClose,
  onPutBack,
}: {
  open: boolean;
  /** *Put back in tray*: the page lands the batch's lines in its tray, says so, and closes this. */
  onPutBack: (batch: ScanBatch) => void;
  /** Escape and the ✕: hand the caret back to the bar's *History*, then close. */
  onDismiss: () => void;
  /** A press on the scrim. The reader is already somewhere else. */
  onClose: () => void;
}): JSX.Element {
  const writes = useScanHistoryWrites();
  const [deleting, setDeleting] = useState<ScanBatchSummary | null>(null);
  const deleteOpener = useRef<HTMLElement | null>(null);

  const remove = (batch: ScanBatchSummary) => {
    writes.remove(batch.id).then(
      () => notify.success(`Deleted “${batch.name}” from ${SCAN_HISTORY_TITLE.toLowerCase()}`),
      (e: unknown) => notify.error(`Couldn't delete “${batch.name}”`, { body: ipcError(e) }),
    );
  };

  return (
    <>
      <Dialog
        open={open}
        title={SCAN_HISTORY_TITLE}
        closeLabel="Close scan history"
        size="w-[60rem] h-[40rem]"
        // The question over it hands the caret back to Delete, which the delete then unmounts —
        // the shell's settle takes the caret back to the panel from `<body>`.
        stackedOver={deleting !== null}
        onDismiss={onDismiss}
        onClose={onClose}
      >
        <HistoryBody
          onPutBack={onPutBack}
          onDelete={(batch, opener) => {
            deleteOpener.current = opener;
            setDeleting(batch);
          }}
        />
      </Dialog>
      <DeleteScanDialog
        batch={deleting}
        onConfirm={(batch) => {
          setDeleting(null);
          deleteOpener.current?.focus();
          remove(batch);
        }}
        onDismiss={() => {
          setDeleting(null);
          deleteOpener.current?.focus();
        }}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

/**
 * The list and the picked batch — mounted only while the dialog is, so the pick and a rename half
 * typed are a session and never outlive a close.
 */
function HistoryBody({
  onPutBack,
  onDelete,
}: {
  onPutBack: (batch: ScanBatch) => void;
  onDelete: (batch: ScanBatchSummary, opener: HTMLElement) => void;
}) {
  const list = useScanHistoryList();
  const batches = list.data ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const client = useQueryClient();
  // **The picked batch while it is still there, and otherwise the newest.** A batch deleted here
  // or in another window leaves the list first (`useScanHistory`'s `remove`), and **a batch whose
  // read answers `null` is gone** before the list has caught up — so a pick of either is dropped,
  // and the column moves on to one that is there rather than drawing a record of nothing. Read
  // from the cache rather than kept in state: the read of the picked batch is what re-renders
  // this when it answers `null`, and the next render simply stops choosing it.
  const pickedHere =
    picked !== null &&
    batches.some((batch) => batch.id === picked) &&
    client.getQueryData(scanBatchKey(picked)) !== null;
  const shownId = pickedHere ? picked : (batches[0]?.id ?? null);
  const batch = useScanBatch(shownId);

  if (list.isPending) {
    return <p className="px-5 py-4 text-sm text-dim">Loading your scans…</p>;
  }
  if (list.isError) {
    return (
      <p role="alert" className="px-5 py-4 text-sm text-destructive">
        {ipcError(list.error)}
      </p>
    );
  }
  if (batches.length === 0) {
    return (
      <p className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center text-sm text-dim">
        {EMPTY_HISTORY}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 border-t border-border">
      <nav
        aria-label="Scans"
        className="flex w-[17rem] shrink-0 flex-col overflow-y-auto border-r border-border p-2"
      >
        <ul className="flex flex-col gap-1">
          {batches.map((entry) => (
            <li key={entry.id}>
              <Entry
                batch={entry}
                selected={entry.id === shownId}
                onSelect={() => setPicked(entry.id)}
              />
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {batch.data ? (
          // Keyed by the batch, so a rename half typed on one is not carried onto the next.
          <BatchView
            key={batch.data.summary.id}
            batch={batch.data}
            onPutBack={onPutBack}
            onDelete={onDelete}
          />
        ) : batch.isError ? (
          <p role="alert" className="px-5 py-4 text-sm text-destructive">
            {ipcError(batch.error)}
          </p>
        ) : (
          <p className="px-5 py-4 text-sm text-dim">{batch.isFetching ? "" : PICK_A_SCAN}</p>
        )}
      </div>
    </div>
  );
}

/**
 * A 5:7 slot with the whole card in it — decoration beside a name set in type, so `aria-hidden`
 * with an empty alt. **`CardImage` and not `CardArt`**, the tray row's argument: `CardArt`'s
 * no-picture fallback prints the name and a status line, which cannot be read at this width and
 * would repeat the name beside it. `thumb`, the smallest variant that is a whole card, and
 * `object-contain` so not a pixel of the frame — the artist credit least of all — is cropped.
 */
function CardThumb({ cardId, className }: { cardId: string | null; className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 overflow-hidden rounded-[3px] bg-surface", className)}
      style={{ aspectRatio: CARD_ASPECT }}
    >
      {cardId !== null && (
        <CardImage
          src={cardImageUrl(cardId, 0, "thumb")}
          alt=""
          draggable={false}
          loading="lazy"
          className="size-full object-contain"
        />
      )}
    </span>
  );
}

/**
 * Where a batch went, as a chip: gold for a pile filed into the collection, quiet for one that
 * was only archived — the trades list's split, where the archived entry is the dim one.
 */
function StatusChip({ batch }: { batch: Pick<ScanBatchSummary, "status" | "folderName"> }) {
  const archived = batch.status === "archived";
  const Icon = archived ? Archive : FolderInput;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem]",
        archived ? "border-border text-dim" : "border-accent/60 text-accent",
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{batchStatusWords(batch)}</span>
    </span>
  );
}

/** One batch in the list: a button, `aria-current` on the one drawn — `TradesPane`'s entry. */
function Entry({
  batch,
  selected,
  onSelect,
}: {
  batch: ScanBatchSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left",
        selected ? "border-border bg-surface" : "border-transparent hover:bg-surface",
        PRESS_SOFT,
        FOCUS,
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute inset-y-2 -left-px w-0.5 rounded-[2px] bg-accent"
        />
      )}
      <CardThumb cardId={batch.coverCardId} className="w-8" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            selected ? "text-accent" : "text-text",
          )}
        >
          {batch.name}
        </span>
        <span className="text-xs text-dim">{batchLine(batch)}</span>
        <span className="mt-0.5 flex min-w-0">
          <StatusChip batch={batch} />
        </span>
      </span>
    </button>
  );
}

/**
 * The picked batch, read-only: its name and its two writes, where it went, and its lines in the
 * order the tray held them.
 *
 * **A rename's refusal is said under the name**, `TradeView`'s rule for a header write — the
 * reader is looking there. Delete's is a toast, because the question has closed over it and a
 * delete that lands takes this view with it.
 */
function BatchView({
  batch,
  onPutBack,
  onDelete,
}: {
  batch: ScanBatch;
  onPutBack: (batch: ScanBatch) => void;
  onDelete: (batch: ScanBatchSummary, opener: HTMLElement) => void;
}) {
  const tip = useTooltip();
  const writes = useScanHistoryWrites();
  const { summary, lines } = batch;
  const [renaming, setRenaming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const renameRef = useRef<HTMLButtonElement>(null);

  // The pencil is not drawn while the field is, so the caret goes back to it once it exists again.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) renameRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  const rename = (name: string) => {
    setRenaming(false);
    if (name === summary.name) return;
    setFailure(null);
    writes
      .rename(summary.id, name)
      .catch((e: unknown) => setFailure(`Couldn't rename the scan — ${ipcError(e)}`));
  };

  return (
    <section aria-label={summary.name} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField
              initial={summary.name}
              placeholder={`Scan ${summary.id}`}
              onSubmit={rename}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <div className="flex items-center gap-2">
              <h3
                className="min-w-0 truncate font-heading text-xl leading-tight font-semibold"
                {...tip(summary.name, { whenClipped: true, describes: false })}
              >
                {summary.name}
              </h3>
              <button
                ref={renameRef}
                type="button"
                aria-label="Rename scan"
                onClick={() => setRenaming(true)}
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-md text-dim hover:text-text",
                  PRESS,
                  FOCUS,
                )}
                {...tip("Rename", { describes: false })}
              >
                <Pencil className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-dim">
            <span>{scanWhen(summary.createdAt)}</span>
            <StatusChip batch={summary} />
          </p>
          {failure !== null && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {failure}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onPutBack(batch)}
          className={cn(
            PANEL_BUTTON,
            "inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs hover:text-accent",
          )}
          {...tip(PUT_BACK_HINT)}
        >
          <ArchiveRestore className="size-3.5" aria-hidden="true" />
          {PUT_BACK_LABEL}
        </button>
        <button
          type="button"
          onClick={(e) => onDelete(summary, e.currentTarget)}
          className={cn(
            PANEL_BUTTON,
            "inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs hover:text-destructive",
          )}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Delete…
        </button>
      </header>

      {/* One string, never two elements, so the name a reader hears is the sentence drawn. The
          printings are said only when they differ from the copies — a pile of singles is one
          number, not the same number twice. */}
      <h4 className="px-5 pb-1.5 text-xs font-normal text-dim">
        {plural(summary.copies, "card")}
        {lines.length !== summary.copies ? ` · ${plural(lines.length, "printing")}` : ""}
      </h4>
      <ul
        aria-label={`Cards in ${summary.name}`}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {lines.map((line) => (
          <LineRow key={line.id} line={line} />
        ))}
      </ul>
    </section>
  );
}

/** One printing in one finish, and how many — read-only, the tray row with its controls taken out. */
function LineRow({ line }: { line: ScanBatchLine }) {
  const printing = [line.setCode.toUpperCase(), line.collectorNumber]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <li className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
      <CardThumb cardId={line.cardId} className="w-9" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm">{line.name}</span>
        {printing !== "" && <span className="shrink-0 font-mono text-xs text-dim">{printing}</span>}
        <FinishMark finish={line.finish} className="shrink-0 self-center" />
      </span>
      {/* Beside the card, not on it, so it keeps its `×` (`packages/ui/CLAUDE.md`'s count rule). */}
      <span className="shrink-0 font-mono text-sm tabular-nums">×{line.quantity}</span>
    </li>
  );
}

/**
 * The batch's name, being changed — `TradeView`'s `RenameField`, with one difference: **a blank
 * name is a write, not a cancel.** The backend takes `""` as "the default back" and names the
 * batch `Scan N` again, and that is the only way a reader has to undo a rename; the placeholder
 * says what they will get. Enter writes; Escape and leaving the field give up.
 */
function RenameField({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // `"inner"`, and mounted after the dialog's own rung: with the field up, Escape is this
  // field's, and must not close the dialog behind it.
  useDismissOnEscape({ layer: "inner", onDismiss: onCancel, enabled: true });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name.trim());
      }}
    >
      <input
        ref={inputRef}
        aria-label="Scan name"
        value={name}
        placeholder={placeholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={onCancel}
        autoComplete="off"
        className={cn(
          "w-full max-w-md rounded-md border border-accent bg-bg px-2",
          "font-heading text-xl leading-tight font-semibold text-text outline-none",
        )}
      />
    </form>
  );
}

/**
 * The delete question — `ConfirmDialog`'s shape and words, on the `stacked` rung, because it is
 * opened over the history and `ConfirmDialog` sits on `overlay` with no way to say otherwise.
 * Nothing typed: a batch is a record about cards, and deleting it moves none of them.
 *
 * **Dismiss first, then run it**, `ConfirmDialog`'s order and reason: the delete has nothing to
 * show while it works, and its outcome is a toast.
 */
function DeleteScanDialog({
  batch,
  onConfirm,
  onDismiss,
  onClose,
}: {
  batch: ScanBatchSummary | null;
  onConfirm: (batch: ScanBatchSummary) => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={batch !== null}
      title="Delete this scan?"
      closeLabel="Close"
      size="w-[26rem]"
      layer="stacked"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <div className="space-y-4 p-4 pt-0 text-sm">
        <p className="leading-relaxed text-dim">{batch === null ? "" : deleteSentence(batch)}</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDismiss} className={PANEL_BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (batch !== null) onConfirm(batch);
            }}
            className={cn(
              PANEL_BUTTON,
              "border-destructive text-destructive",
              "transition-colors duration-150 hover:bg-destructive hover:text-bg",
              "motion-reduce:transition-none",
            )}
          >
            Delete scan
          </button>
        </div>
      </div>
    </Dialog>
  );
}
