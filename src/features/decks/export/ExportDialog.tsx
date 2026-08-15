/**
 * A dialog that turns a pile of cards into decklist text: a format, a live preview, Copy, and
 * Save as….
 *
 * **This app has had no export feature of any kind before this one.** It is opened from a deck
 * category's right-click menu (Task 12 wires that), so `cards` arrives as a prop rather than
 * something this dialog fetches — that is deliberately what lets a later *deck-level* export
 * reuse it whole, over the deck's full card list instead of one category's.
 *
 * **Built on `DeckDialog`**, the deck surface's shared modal shell (`src/CLAUDE.md`), rather
 * than carrying its own copy of the chrome — `ImportDeckDialog`, `TheoryDiffDialog` and
 * `CreateDeckDialog` are the three still doing that, named as the ones to move onto the shell,
 * and this file must not become a fourth. The body lives in {@link Body}, one floor down, so a
 * closed dialog — `open={false}` — mounts nothing: no format state, no memoized preview text.
 *
 * **The file picker's own half is unverifiable**, for the reason `deck_set_cover_image`'s is
 * (`src/features/decks/CLAUDE.md`'s Import section says the same of the open dialog):
 * `dialog:allow-save` opens a native window CDP cannot reach, and nothing in a test or a browser
 * can drive it either. So this file's tests cover **path → write**, not **click → path** — `save`
 * from `@tauri-apps/plugin-dialog` is mocked to answer a path directly, the same way
 * `DeckCoverPicker`'s and `ImportDeckDialog`'s tests stub `open`.
 *
 * **A cancelled save answers `null`, and that is the one bug worth naming in prose.** `save()`
 * resolves `null` on Cancel, and writing *that* string to disk — `ipc.exportWriteFile(path,
 * text)` called with `path` still `null` — is exactly the trap `deck_set_cover_image`'s callers
 * already avoid; the guard below is the whole of what stops it here. And a refused write is
 * reported rather than closing the dialog on it: the reader's text is still on screen and still
 * copyable, so the failure costs them nothing they cannot immediately retry.
 *
 * **The Copied status is a claim about the clipboard's contents, and it is cleared the moment
 * that claim could go stale** (2026-08-14, code review). Switching format redraws the preview
 * but does nothing to the clipboard, which still holds whatever text was on screen at the last
 * Copy — so the format radios clear `copied` on every press rather than leaving a "Copied." line
 * sitting beside text it is no longer true of. And a clipboard write can itself be refused (the
 * plugin is a real Tauri command, not a browser API guaranteed to succeed), so `handleCopy`
 * reports a rejection through the same `role="alert"` line `handleSaveAs`'s refusal uses, rather
 * than swallowing it — the "reported, not fatal" rule above is not just the save button's.
 */
import { useCallback, useMemo, useState, type JSX } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import { copyText } from "@/lib/clipboard";
import { ipc, ipcError } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { FOCUS } from "../cardControl";
import { DeckDialog } from "../DeckDialog";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_EXTENSION,
  EXPORT_FORMAT_LABEL,
  formatExport,
  type ExportCard,
  type ExportFormat,
} from "./format";

export interface ExportDialogProps {
  open: boolean;
  /** What is being exported — "Removal", "Atraxa". The dialog's title reads `Export "<title>"`. */
  subject: string;
  /** The cards. **An argument, never something this dialog fetches** — which is what lets a
   *  later deck-level export reuse it whole. */
  cards: readonly ExportCard[];
  /** Seeds the save dialog's file name. */
  suggestedFileName: string;
  /**
   * Escape, and the close control: hand focus back to whatever opened the dialog, then close.
   *
   * **Forwarded unchanged rather than wrapped**, which costs nothing and keeps the identity the
   * host chose. It used to say the prop had to be stable because `useDismissOnEscape` took it as
   * a dependency; that hook latches it in a ref now and depends only on `enabled` and `layer`, so
   * an unstable one costs a re-render and nothing else. The ref is a correctness fence rather
   * than a saved registration — while it *was* a dependency, a re-render moved this layer to the
   * top of the hook's stack and the next Escape closed the wrong window.
   */
  onDismiss: () => void;
  /** A press on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
}

export function ExportDialog({
  open,
  subject,
  cards,
  suggestedFileName,
  onDismiss,
  onClose,
}: ExportDialogProps): JSX.Element {
  return (
    <DeckDialog
      open={open}
      title={`Export "${subject}"`}
      closeLabel="Close export"
      width="w-[40rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body cards={cards} suggestedFileName={suggestedFileName} />
    </DeckDialog>
  );
}

/** The body proper — mounted only while the dialog is open, which is what makes the chosen
 *  format and the copy/save status a session rather than something an effect has to reset. */
function Body({
  cards,
  suggestedFileName,
}: {
  cards: readonly ExportCard[];
  suggestedFileName: string;
}) {
  const [format, setFormat] = useState<ExportFormat>("plain");
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  /** One line for both failures a press here can produce — a refused clipboard write and a
   *  refused save — each stores its own full sentence at the point it happened, since which
   *  control failed decides the wording. */
  const [error, setError] = useState<string | null>(null);

  const text = useMemo(() => formatExport(cards, format), [cards, format]);

  const handleCopy = useCallback(() => {
    setError(null);
    setCopied(false);
    copyText(text).then(
      () => setCopied(true),
      // A real rejection path, not a hypothetical: the clipboard goes through a Tauri plugin
      // command, so an ACL or platform failure surfaces as a rejected promise — reported the
      // same way a refused save is, rather than swallowed.
      (e: unknown) => setError(`Could not copy that export — ${ipcError(e)}`),
    );
  }, [text]);

  const handleSaveAs = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      // `save()` answers `null` on Cancel, and writing that string to disk is the bug this
      // guard exists to prevent — nothing is written when the reader backs out of the picker.
      const path = await save({
        defaultPath: `${suggestedFileName}.${EXPORT_FORMAT_EXTENSION[format]}`,
      });
      if (path === null) return;
      await ipc.exportWriteFile(path, text);
    } catch (e) {
      // Reported, not fatal to the dialog: the reader's text is still on screen and still
      // copyable, so a refused write must not throw either away.
      setError(`Could not save that export — ${ipcError(e)}`);
    } finally {
      setSaving(false);
    }
  }, [format, suggestedFileName, text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      {/* A radio group over the four named formats, in the order `EXPORT_FORMATS` declares —
          **not** through `sortOptions`: plain first is the one most readers want, the same kind
          of deliberate order `lib/options.ts` exempts a grade scale for. */}
      <div role="radiogroup" aria-label="Export format" className="flex flex-wrap gap-2">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={format === f}
            onClick={() => {
              setFormat(f);
              // The preview redraws for the new format; the clipboard does not. Left standing,
              // "Copied." would sit beside text it is no longer an honest claim about.
              setCopied(false);
            }}
            className={cn(
              "h-8 shrink-0 rounded-md border px-3 text-sm",
              "transition-colors duration-150 motion-reduce:transition-none",
              format === f
                ? "border-accent text-accent"
                : "border-border text-dim hover:border-accent hover:text-accent",
              FOCUS,
            )}
          >
            {EXPORT_FORMAT_LABEL[f]}
          </button>
        ))}
      </div>

      <pre
        className={cn(
          "min-h-0 flex-1 overflow-auto rounded-md border border-border bg-surface p-3",
          "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
        )}
      >
        {text}
      </pre>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "h-9 rounded-md border border-border px-3 text-sm hover:bg-surface",
            FOCUS,
          )}
        >
          Copy
        </button>
        <button
          type="button"
          aria-disabled={saving ? true : undefined}
          onClick={() => {
            if (!saving) void handleSaveAs();
          }}
          aria-busy={saving || undefined}
          className={cn(
            "h-9 rounded-md border border-border px-3 text-sm hover:bg-surface",
            FOCUS,
          )}
        >
          Save as…
        </button>

        {/* Grown into place rather than shoving anything below it — there is nothing below it,
            but a status line that snaps to full size on arrival reads as a jump all the same.
            `overflow-hidden` is owed here: `statusLine` animates `height`, and without the class
            the sentence draws fully formed at zero height for the first frame. */}
        <AnimatePresence initial={false}>
          {copied && (
            <motion.p {...statusLine} role="status" className="overflow-hidden text-sm text-dim">
              Copied.
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {error !== null && (
          <motion.p
            {...statusLine}
            role="alert"
            className="overflow-hidden text-sm text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
