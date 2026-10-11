import { useCallback, useId, useState } from "react";
import { ChevronRight, Copy, Download } from "lucide-react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { TRANSFER_FIELDS, type TransferSurface } from "@grimoire/ui/features/transfer/fields";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_EXTENSION,
  EXPORT_FORMAT_LABEL,
} from "@grimoire/ui/features/transfer/formats";
import { useExportModel } from "@grimoire/ui/features/transfer/export/useExportModel";
import type { TransferCard } from "@grimoire/ui/features/transfer/TransferCard";
import { copyText } from "@grimoire/ui/lib/clipboard";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { ipcError } from "@grimoire/ui/lib/ipc";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { radioKeys } from "@grimoire/ui/lib/radioGroup";
import { cn } from "@grimoire/ui/lib/utils";
import { saveText } from "@grimoire/ui/lib/core/files";
import { usePhoneTransferPrefs } from "./prefs";

/**
 * What a scope export (the collection, the wishlist) owes the sheet — `ExportDialog`'s `scope`
 * prop, the same five facts from the same `useExportScope` sweep.
 */
export interface ExportSheetScope {
  /** `scopeLabel`'s count line — "1,204 cards matching your filters". */
  label: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /**
   * The widening box — `everythingLabel`'s words, its state and its setter — or absent where the
   * sweep is already everything and a box to widen it would be a control over nothing.
   */
  widen?: { label: string; everything: boolean; onEverything: (everything: boolean) => void };
}

/** A 44px row a finger presses: a checkbox and its words. */
const CHECK_ROW = "flex min-h-11 items-center gap-3 text-sm";
const CHECKBOX = cn("size-5 shrink-0 accent-accent", FOCUS);
/** Copy and Save file — two halves of the foot, each a full 44px. */
const ACTION = cn(
  "flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md border border-border",
  "text-sm aria-disabled:opacity-50",
  PRESS_SOFT,
  FOCUS,
);

/**
 * **Export**, on the phone: a format, the fields it can say, a look at the text, then Copy or
 * Save file.
 *
 * **`Save file`, never `Download`**, because the one button is two things on two hosts and the
 * page may not ask which (`fence.test.ts`): the system's save dialog on the Android host, a
 * download in a browser. Both end in a file the reader keeps, so that is the label; what the host
 * actually did is the status line's to say, from `saveText`'s answer — `Saved <name>.` when the
 * dialog wrote one, `Downloading <name>.` when a browser was handed it, and nothing for a dialog
 * dismissed. `Download` was the label until the first phone run (2026-10-04), where it sat over a
 * save dialog.
 *
 * **Every decision is the desktop dialog's own** — `useExportModel` is the field intersection, the
 * Arena and switched-off-pile filters, `formatExport` and the three count lines, for both faces,
 * so the file written here is byte for byte the file the desktop writes from the same cards and
 * the same choices (the golden suite's writers, unchanged). **What is the phone's own** is the
 * drawing — every control 44px, the formats as a wrapping row of chips — where the choices are
 * remembered (`usePhoneTransferPrefs`, per surface, opening on the desktop's own defaults), and
 * where the text goes: the host's clipboard through `@/lib/clipboard`, as the desktop dialog's
 * Copy goes (phase 5, step 5.4), and a file through `@/lib/core/files`'s `saveText` — the system's
 * save dialog on the Android host, a download in a browser (phase 4, step 4.3).
 *
 * **A bottom sheet below 640px** — the action sheet's shape: the format, the fields and the two
 * buttons fit a thumb's reach, and the preview is a disclosure that opens shut, the desktop's
 * rule, so a 100-card list never pushes Copy off the screen.
 */
export function ExportSheet({
  open,
  subject,
  surface,
  cards,
  suggestedFileName,
  scope,
  onClose,
}: {
  open: boolean;
  /** What is being exported — the deck's name, "your collection". */
  subject: string;
  surface: TransferSurface;
  /** The cards. An argument, never fetched here — `ExportDialog`'s arrangement. */
  cards: readonly TransferCard[];
  /** The file's suggested name, before the format's extension. */
  suggestedFileName: string;
  scope?: ExportSheetScope;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={`Export "${subject}"`}
      closeLabel="Close export"
      size="w-full self-end rounded-t-xl border-t border-border max-h-[92dvh] sm:max-h-full sm:w-[34rem] sm:self-center"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body surface={surface} cards={cards} suggestedFileName={suggestedFileName} scope={scope} />
    </Dialog>
  );
}

function Body({
  surface,
  cards,
  suggestedFileName,
  scope,
}: {
  surface: TransferSurface;
  cards: readonly TransferCard[];
  suggestedFileName: string;
  scope: ExportSheetScope | undefined;
}) {
  const previewId = useId();
  const [showList, setShowList] = useState(false);
  /** What the last press did, in a sentence — "Copied.", "Saved Burn.txt.", "Downloading
   *  Burn.txt." — or `null`. A claim about the clipboard or the file, so a change to the text
   *  takes it down. */
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prefs = usePhoneTransferPrefs((s) => s.exportPrefs[surface]);
  const setPrefs = usePhoneTransferPrefs((s) => s.setExportPrefs);
  const forget = useCallback(() => setDone(null), []);
  const model = useExportModel({ surface, cards, prefs, setPrefs, onChange: forget });
  const { format, fields, text } = model;

  /** Still sweeping, or the sweep failed: the text is not the cards the reader asked for, and a
   *  file of it would look complete and not be — `ExportDialog`'s `notReady`. */
  const scopeError = scope?.error ?? null;
  const notReady = scope !== undefined && (scope.loading || scopeError !== null);

  const copy = () => {
    if (notReady) return;
    setError(null);
    setDone(null);
    copyText(text).then(
      () => setDone("Copied."),
      (e: unknown) => setError(`Couldn't copy that export — ${ipcError(e)}`),
    );
  };

  const save = () => {
    if (notReady) return;
    setError(null);
    const name = `${suggestedFileName}.${EXPORT_FORMAT_EXTENSION[format]}`;
    setDone(null);
    // A browser downloads (`handed`) and cannot say where the file went, so the line says only
    // that it was handed over; the Android host opens the system's save dialog and says whether
    // the reader kept a file. A cancelled dialog is nothing to report.
    saveText(name, text).then(
      (saved) => {
        if (saved === "saved") setDone(`Saved ${name}.`);
        else if (saved === "handed") setDone(`Downloading ${name}.`);
      },
      (e: unknown) => setError(`Couldn't save that export — ${ipcError(e)}`),
    );
  };

  return (
    <>
      <div className="relative min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-3">
        {scope !== undefined && (
          <div className="space-y-1">
            {scopeError === null ? (
              <p className="text-sm text-dim">{scope.label}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
                  Couldn&apos;t load the cards to export — {scopeError}
                </p>
                <button
                  type="button"
                  onClick={scope.onRetry}
                  className={cn(
                    "h-11 shrink-0 rounded-md border border-border px-4 text-sm",
                    PRESS_SOFT,
                    FOCUS,
                  )}
                >
                  Retry
                </button>
              </div>
            )}
            {scope.widen !== undefined && (
              <label className={CHECK_ROW}>
                <input
                  type="checkbox"
                  checked={scope.widen.everything}
                  onChange={(e) => scope.widen?.onEverything(e.target.checked)}
                  className={CHECKBOX}
                />
                {scope.widen.label}
              </label>
            )}
          </div>
        )}

        {/* The formats in `EXPORT_FORMATS`' own order — plain first, the desktop's deliberate
            order — as chips that wrap. One Tab stop and the arrows choose (`radioKeys`). */}
        <div role="radiogroup" aria-label="Export format" className="flex flex-wrap gap-2">
          {EXPORT_FORMATS.map((f, i) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={format === f}
              onClick={() => model.chooseFormat(f)}
              {...radioKeys(EXPORT_FORMATS, format, model.chooseFormat, i)}
              className={cn(
                "h-11 shrink-0 rounded-md border px-3.5 text-sm",
                format === f ? "border-accent text-accent" : "border-border text-dim",
                PRESS_SOFT,
                FOCUS,
              )}
            >
              {EXPORT_FORMAT_LABEL[f]}
            </button>
          ))}
        </div>

        {model.available.length > 0 && (
          <fieldset>
            <legend className="mb-1 text-xs text-dim">Fields</legend>
            <div className="grid grid-cols-2 gap-x-3">
              {model.available.map((id) => (
                <label key={id} className={CHECK_ROW}>
                  <input
                    type="checkbox"
                    checked={fields.includes(id)}
                    onChange={() => model.toggleField(id)}
                    className={CHECKBOX}
                  />
                  <span className="min-w-0">{TRANSFER_FIELDS[id].label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {format === "arena" && (
          <label className={CHECK_ROW}>
            <input
              type="checkbox"
              checked={model.arenaOnly}
              onChange={model.toggleArenaOnly}
              className={CHECKBOX}
            />
            Only cards MTG Arena has
          </label>
        )}
        {model.offersInactive && (
          <label className={CHECK_ROW}>
            <input
              type="checkbox"
              checked={model.includeInactive}
              onChange={model.toggleIncludeInactive}
              className={CHECKBOX}
            />
            Include inactive categories
          </label>
        )}

        {/* The desktop dialog's three omission lines, word for word: facts about the text under
            them, so not alerts, and on screen before Copy is pressed. */}
        {model.notInArena > 0 && (
          <p className="text-sm text-dim">
            {model.notInArena === 1
              ? "1 card isn't on MTG Arena and is"
              : `${model.notInArena} cards aren't on MTG Arena and are`}{" "}
            left out.
          </p>
        )}
        {model.heldBackInactive > 0 && (
          <p className="text-sm text-dim">
            {model.heldBackInactive === 1
              ? "1 card in an inactive category is"
              : `${model.heldBackInactive} cards in inactive categories are`}{" "}
            left out.
          </p>
        )}
        {model.omitted > 0 && (
          <p className="text-sm text-dim">
            This format can&apos;t include inactive categories, so{" "}
            {model.omitted === 1 ? "1 card is" : `${model.omitted} cards are`} left out.
          </p>
        )}

        <button
          type="button"
          aria-expanded={showList}
          aria-controls={showList ? previewId : undefined}
          onClick={() => setShowList((open) => !open)}
          className={cn("flex h-11 items-center gap-2 text-sm text-dim", FOCUS)}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 transition-transform duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              showList && "rotate-90",
            )}
          />
          {showList ? "Hide" : "Show"} decklist (
          {model.lines === 1 ? "1 line" : `${model.lines} lines`})
        </button>
        {showList && (
          <pre
            id={previewId}
            className={cn(
              "max-h-[40dvh] overflow-auto rounded-md border border-border bg-surface p-3",
              "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
            )}
          >
            {text}
          </pre>
        )}
      </div>

      <footer className="shrink-0 space-y-2 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex gap-2">
          <button
            type="button"
            aria-disabled={notReady || undefined}
            aria-busy={scope?.loading || undefined}
            onClick={copy}
            className={ACTION}
          >
            <Copy aria-hidden className="size-4 shrink-0" />
            Copy
          </button>
          <button
            type="button"
            aria-disabled={notReady || undefined}
            aria-busy={scope?.loading || undefined}
            onClick={save}
            className={ACTION}
          >
            <Download aria-hidden className="size-4 shrink-0" />
            Save file
          </button>
        </div>
        {/* Mounted always, so a sentence arriving in it is announced. */}
        <p role="status" className="min-h-4 text-xs text-dim">
          {done}
        </p>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </footer>
    </>
  );
}
