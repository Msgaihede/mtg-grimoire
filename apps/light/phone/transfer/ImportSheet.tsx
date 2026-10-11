import { useId, useRef, useState, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import type { ImportDestination } from "@grimoire/ui/features/transfer/import/destination";
import { LEGACY_ENCODING_NOTICE } from "@grimoire/ui/features/transfer/import/ImportDialog";
import { CsvNotes } from "@grimoire/ui/features/transfer/import/shared/CsvNotes";
import { useImportSource } from "@grimoire/ui/features/transfer/import/useImportSource";
import { plural } from "@grimoire/ui/lib/counts";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { DECKLIST_ACCEPT, readDecklistFile } from "@grimoire/ui/lib/core/browserFiles";
import { ipcError } from "@grimoire/ui/lib/ipc";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * **The touch floor for the desktop's second step**, set from the container rather than on each
 * control — the filters sheet's `TOUCH_FLOOR`, for its reason: the destination's preview is the
 * desktop's own component (its radios, its commander picks, its dropdowns, Back and Import) and
 * takes no class for a size. `min-h` rather than `h`, so it holds against every `h-9` it meets; a
 * `<label>` round a radio or a checkbox is the row a finger presses, so it is floored too — its
 * height only, never its alignment, because the preview's labels are laid out two ways (a mode's
 * word over its hint, a radio beside its sentence) and one alignment would break the other; and
 * every text box is 16px so focusing one does not zoom the page.
 */
const TOUCH_FLOOR =
  "[&_button]:min-h-11 [&_label]:min-h-11 [&_input]:text-base [&_textarea]:text-base";

/** The one gold control on the sheet — `CommitBar`'s `PRIMARY` at the phone's height. */
const PRIMARY = cn(
  "flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium",
  "text-accent-fg aria-disabled:opacity-40",
  PRESS_SOFT,
  FOCUS,
);

/**
 * **Import a decklist**, on the phone: paste a list or pick a file, see what it would do, then
 * write it — the desktop's two steps, over the desktop's own machinery.
 *
 * **What is the phone's own is the first step's drawing and the file.** The box is 16px, so
 * focusing it does not zoom the page, and fills the sheet's width; the file arrives through a
 * browser `<input type="file">`, read by `@/lib/core/browserFiles` — on every host alike, since
 * Android's WebView answers one with the system picker — where the desktop face asks its host
 * for a file (`import_pick_file`: a native dialog, or in a browser that same read).
 * **Everything else is shared**: `useImportSource` holds the text, the parse, the one resolve
 * press and the step machine for both shells, and the second step is the destination's own
 * `Preview` — the desktop component, store-free, under a touch floor — so a list previews, files
 * and commits exactly as it does on the desktop.
 *
 * **The whole window below 640px**, the add search's shape: a pasted list and a preview are both
 * taller than a bottom sheet leaves room for. A sheet over the page, not a place.
 */
export function ImportSheet({
  open,
  destination,
  subtitle,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Where the cards are going. One, so the sheet draws no destination radios. */
  destination: ImportDestination;
  /** The line under the heading where the destination has no `Subtitle` of its own. */
  subtitle?: ReactNode;
  onClose: () => void;
  /** The import landed, in the destination's own sentence. The host closes the sheet. */
  onDone: (message: string) => void;
}) {
  return (
    <Dialog
      open={open}
      title="Import a decklist"
      subtitle={destination.Subtitle === undefined ? subtitle : <destination.Subtitle />}
      closeLabel="Close import"
      size="h-full w-[42rem] pt-[env(safe-area-inset-top)] sm:pt-0"
      onDismiss={onClose}
      onClose={onClose}
    >
      <Body destination={destination} onDone={onDone} />
    </Dialog>
  );
}

function Body({
  destination,
  onDone,
}: {
  destination: ImportDestination;
  onDone: (message: string) => void;
}) {
  const id = useId();
  const source = useImportSource();
  const { text, readAs, parsed, step, resolve, resolved } = source;
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  /** Why the last file could not be read, already framed — or `null`. */
  const [fileFailure, setFileFailure] = useState<string | null>(null);

  /**
   * A file the reader picked. **A failed read leaves the box as it was**, the desktop's rule: the
   * text there, and how it was read, still describe each other. The input is emptied after every
   * pick, so choosing the same file again — after fixing it — is a change the browser reports.
   */
  const pick = (file: File | undefined) => {
    if (file === undefined) return;
    setFileFailure(null);
    setReading(true);
    readDecklistFile(file)
      .then(source.takeFile, (error: unknown) =>
        // The desktop dialog's frame, true of an oversized file and an unreadable one alike.
        setFileFailure(`Couldn't read a decklist from a file — ${ipcError(error)}`),
      )
      .finally(() => {
        setReading(false);
        if (fileRef.current !== null) fileRef.current.value = "";
      });
  };

  if (step === "preview" && resolved !== null) {
    return (
      <>
        {/* What reading a spreadsheet cost, above the destination — the desktop shell's strip,
            for its reason: a fact about the list, said once. Capped so it cannot take the
            destination's footer off a short window. */}
        <div className="relative max-h-24 shrink-0 overflow-y-auto border-b border-border px-4 py-2.5 empty:hidden">
          <CsvNotes list={parsed} />
        </div>
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]",
            TOUCH_FLOOR,
          )}
        >
          <destination.Preview
            list={parsed}
            resolved={resolved.rows}
            tags={resolved.tags}
            onDone={onDone}
            onBack={source.toSource}
          />
        </div>
      </>
    );
  }

  const empty = parsed.lines.length === 0;
  const refused = empty || resolve.isPending;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!refused) source.preview();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        <label htmlFor={`${id}-list`} className="block text-xs text-dim">
          Paste a decklist
        </label>
        <textarea
          id={`${id}-list`}
          value={text}
          onChange={(e) => source.type(e.target.value)}
          rows={10}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={"4 Lightning Bolt\n1 Sol Ring (C21) 263"}
          aria-describedby={`${id}-hint${readAs === "windows-1252" ? ` ${id}-encoding` : ""}`}
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface px-3 py-2",
            "font-mono text-base leading-relaxed",
            "focus:border-accent focus:outline-none",
          )}
        />
        {readAs === "windows-1252" && (
          <p id={`${id}-encoding`} className="text-xs leading-relaxed text-dim">
            {LEGACY_ENCODING_NOTICE}
          </p>
        )}
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-dim">
          One card per line, quantity first. Arena, Moxfield and MTGO exports and CSV files are read
          as they are.
        </p>
        {text.trim() !== "" && (
          <p className="font-mono text-xs tabular-nums text-dim">
            {plural(parsed.lines.length, "line")} · {plural(parsed.totalCards, "card")}
            {parsed.issues.length > 0 && ` · ${plural(parsed.issues.length, "unreadable line")}`}
          </p>
        )}

        {/* The file, as the browser hands one over. A real button that presses the input rather
            than a `<label>` round it, so the focus ring is the button's own and the control is
            announced as what it does. The input is out of the tab order and out of sight. */}
        <input
          ref={fileRef}
          type="file"
          accept={DECKLIST_ACCEPT}
          aria-label="Decklist file"
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-disabled={reading || undefined}
          className={cn(
            "flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border",
            "text-sm text-dim aria-disabled:opacity-50",
            PRESS_SOFT,
            FOCUS,
          )}
        >
          <FileUp aria-hidden className="size-4 shrink-0" />
          {reading ? "Reading the file…" : "Choose a file…"}
        </button>
        {fileFailure !== null && (
          <p role="alert" className="text-xs text-destructive">
            {fileFailure}
          </p>
        )}
        {resolve.isError && (
          <p role="alert" className="text-xs text-destructive">
            Couldn&apos;t find those cards — {ipcError(resolve.error)}
          </p>
        )}
      </div>

      <footer className="shrink-0 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {/* `aria-disabled`, never `disabled`: it greys as the reader types, and the form's own
            submit refuses the same states (`packages/ui/CLAUDE.md`). */}
        <button type="submit" aria-disabled={refused || undefined} className={PRIMARY}>
          {resolve.isPending ? "Reading…" : "Preview"}
        </button>
      </footer>
    </form>
  );
}
