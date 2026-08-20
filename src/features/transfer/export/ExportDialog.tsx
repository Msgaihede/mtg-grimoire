/**
 * A dialog that turns a pile of cards into decklist text: a format, a live preview, Copy, and
 * Save as….
 *
 * **Two controls open it, and the difference between them is the `cards` prop and nothing else.**
 * A deck category's right-click opens it over one pile; the editor header's `Export deck` opens
 * it over every row of the variant on screen. That was the point of taking the cards as a prop
 * rather than fetching them: a whole-deck export turned out to be a *caller* rather than a
 * rewrite, and this file did not change for it. `DeckEditor`'s `exportSubject` is where the two
 * scopes are resolved, and `layerMatches` is why one layer can carry both.
 *
 * **Built on `Dialog`**, the deck surface's shared modal shell (`src/CLAUDE.md`), rather
 * than carrying its own copy of the chrome — `ImportDeckDialog`, `TheoryDiffDialog` and
 * `CreateDeckDialog` are the three still doing that, named as the ones to move onto the shell,
 * and this file must not become a fourth. The body lives in {@link Body}, one floor down, so a
 * closed dialog — `open={false}` — mounts nothing: no format state, no memoized preview text.
 *
 * **The file picker's own half is unverifiable**, for the reason `deck_set_cover_image`'s is
 * (`src/features/transfer/CLAUDE.md`'s Import section says the same of the open dialog):
 * `dialog:allow-save` opens a native window CDP cannot reach, and nothing in a test or a browser
 * can drive it either. So this file's tests cover **path → write**, not **click → path** — `save`
 * from `@tauri-apps/plugin-dialog` is mocked to answer a path directly, the same way
 * `DeckCoverPicker`'s and `ImportDeckDialog`'s tests stub `open`.
 *
 * **The preview is a disclosure and opens shut** (2026-08-18). A decklist is the tallest thing
 * this dialog draws and the least of what a reader came for — the two presses that do the work
 * are Copy and Save as…, and a whole-deck export put both of them below a screenful of text on
 * the way to them. Shut, the dialog is the format row, the toggle and the buttons. It really is
 * shut rather than hidden: the `<pre>` is unmounted, because a hidden block of text is the shape
 * that lets a test assert a line no reader can see. The reported bug that arrived with it was
 * *not* this file's, though, and the two are worth keeping apart — the panel itself grew past
 * the window and took the buttons off screen with it, which is `Dialog`'s scrim and is fixed
 * there for every dialog on the shell.
 *
 * **A cancelled save answers `null`, and that is the one bug worth naming in prose.** `save()`
 * resolves `null` on Cancel, and writing *that* string to disk — `ipc.exportWriteFile(path,
 * text)` called with `path` still `null` — is exactly the trap `deck_set_cover_image`'s callers
 * already avoid; the guard below is the whole of what stops it here. And a refused write is
 * reported rather than closing the dialog on it: the reader's text is still on screen and still
 * copyable, so the failure costs them nothing they cannot immediately retry.
 *
 * **What a format leaves out is said on screen before Copy is pressed, and it is deliberately not
 * a `role="alert"`.** Arena and MTGO have no maybeboard, so `formatExport` writes only the piles
 * the reader has switched on — and a maybeboard silently missing from an export is a file that
 * looks complete and is not. Nothing has *failed* when that happens, so the sentence is an
 * ordinary `text-dim` line beside the format that chose it rather than an alert: it is a fact
 * about the text under it, which is why it sits between the radios and the preview and not down
 * beside the two failure lines. {@link omittedCount} counts **copies** rather than rows, because
 * six basic lands on one row are six cards missing from the file.
 *
 * **The Copied status is a claim about the clipboard's contents, and it is cleared the moment
 * that claim could go stale** (2026-08-14, code review). Switching format redraws the preview
 * but does nothing to the clipboard, which still holds whatever text was on screen at the last
 * Copy — so the format radios clear `copied` on every press rather than leaving a "Copied." line
 * sitting beside text it is no longer true of. And a clipboard write can itself be refused (the
 * plugin is a real Tauri command, not a browser API guaranteed to succeed), so `handleCopy`
 * reports a rejection through the same `role="alert"` line `handleSaveAs`'s refusal uses, rather
 * than swallowing it — the "reported, not fatal" rule above is not just the save button's.
 *
 * **The field row is `availableFields(format, surface)`, and the choice is remembered per
 * `surface`** (Task 9). Two independent declarations — what the format has a channel for, what
 * the surface has a fact about — and the dialog draws only their intersection, so a wishlist's
 * row never offers `Category` and an Arena export's never offers `Condition`. `ALWAYS`
 * (`quantity`, `name`) is never drawn: a checkbox that can never move is furniture. Switching
 * format re-derives the field set from that format's own defaults rather than carrying the old
 * selection across — a set chosen for CSV means nothing to Arena — and both the format radios and
 * a field checkbox clear `copied` for the Copied-status reason above: the preview redraws on
 * either change, the clipboard does not. `useAppStore`'s `exportPrefs` is keyed by `surface`
 * rather than held as local state, which is what lets a reader who always exports the collection
 * as a condition-bearing CSV find it that way again without a deck export dragging its own
 * Moxfield habit onto it.
 */
import { useCallback, useId, useMemo, useState, type JSX } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { copyText } from "@/lib/clipboard";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";
import {
  ALWAYS,
  availableFields,
  defaultFields,
  TRANSFER_FIELDS,
  type TransferFieldId,
} from "../fields";
import type { TransferSurface } from "../fields";
import type { TransferCard } from "../TransferCard";
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_EXTENSION,
  EXPORT_FORMAT_LABEL,
  formatExport,
  omittedCount,
  type ExportFormat,
} from "./format";

export interface ExportDialogProps {
  open: boolean;
  /** What is being exported — "Removal", "Atraxa". The dialog's title reads `Export "<title>"`. */
  subject: string;
  /** Which surface this is exporting from — the deck editor, the collection, the wishlist.
   *  Narrows the field row to what that surface can say (`availableFields`) and keys the
   *  remembered format and field choice (`useAppStore`'s `exportPrefs`) so a deck export is
   *  never dragged into a collection export's own setting. */
  surface: TransferSurface;
  /** The cards. **An argument, never something this dialog fetches** — which is what lets a
   *  later deck-level export reuse it whole. */
  cards: readonly TransferCard[];
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
  surface,
  cards,
  suggestedFileName,
  onDismiss,
  onClose,
}: ExportDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title={`Export "${subject}"`}
      closeLabel="Close export"
      width="w-[40rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body surface={surface} cards={cards} suggestedFileName={suggestedFileName} />
    </Dialog>
  );
}

/** The body proper — mounted only while the dialog is open, which is what makes the chosen
 *  format and the copy/save status a session rather than something an effect has to reset. */
function Body({
  surface,
  cards,
  suggestedFileName,
}: {
  surface: TransferSurface;
  cards: readonly TransferCard[];
  suggestedFileName: string;
}) {
  /**
   * The preview's disclosure, **shut on every open**.
   *
   * A decklist is the tallest thing this dialog can draw and the least of what a reader came for
   * — the two presses that do the work are Copy and Save as…, and a 100-card deck put both of
   * them a screenful below the text on the way to them. Shut, the whole dialog is the format row,
   * the toggle and the two buttons; the count in the toggle's own label is what a shut preview
   * still owes the reader, so "nothing is showing" is never mistaken for "nothing is there".
   *
   * State rather than a `<details>` element: the preview is **unmounted** while it is shut, and
   * `<details>` keeps its contents in the DOM. A hidden `<pre>` full of text is exactly the shape
   * that lets a test assert a line no reader can see.
   */
  const [showList, setShowList] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  /** One line for both failures a press here can produce — a refused clipboard write and a
   *  refused save — each stores its own full sentence at the point it happened, since which
   *  control failed decides the wording. */
  const [error, setError] = useState<string | null>(null);

  /** The format and field set this surface was last exported with — `useAppStore`'s
   *  `exportPrefs`, keyed by `surface` so a deck export is never dragged into the collection's. */
  const prefs = useAppStore((s) => s.exportPrefs[surface]);
  const setPrefs = useAppStore((s) => s.setExportPrefs);
  const { format, fields } = prefs;
  /** The fields this format and this surface share — the whole of what decides which checkboxes
   *  draw, `ALWAYS` excluded (see the row below). */
  const available = useMemo(() => availableFields(format, surface), [format, surface]);

  /** Switching format re-derives the field set from that format's defaults rather than carrying
   *  the old selection across: a set chosen for CSV means nothing to Arena, and the intersection
   *  would silently drop most of it anyway. */
  const chooseFormat = useCallback(
    (next: ExportFormat) => {
      setPrefs(surface, { format: next, fields: defaultFields(next, surface) });
      // The preview redraws for the new format; the clipboard does not. Left standing,
      // "Copied." would sit beside text it is no longer an honest claim about.
      setCopied(false);
    },
    [setPrefs, surface],
  );

  const toggleField = useCallback(
    (id: TransferFieldId) => {
      const on = fields.includes(id);
      setPrefs(surface, { format, fields: on ? fields.filter((f) => f !== id) : [...fields, id] });
      // The preview redraws; the clipboard does not — same claim, same reason as the format row.
      setCopied(false);
    },
    [fields, format, setPrefs, surface],
  );

  const text = useMemo(() => formatExport(cards, format, fields), [cards, format, fields]);
  /** Copies this format will not write — see `omittedCount`. Recomputed with the format, because
   *  it is a claim about the text on screen and goes stale the moment that changes. */
  const omitted = useMemo(() => omittedCount(cards, format), [cards, format]);
  /**
   * Lines of the **file**, which is what the toggle names while the preview is shut.
   *
   * Rows of the text rather than cards in the pile, and the two really do differ: a sectioned
   * format writes headings and blank lines between them, and CSV opens on a header. The number
   * is a fact about the text under the toggle, so it is measured on that text — and it moves with
   * the format for the same reason the omission line does. `trimEnd` takes off the single
   * trailing newline every non-empty export ends with, which would otherwise count as a line
   * nobody wrote; an empty export is 0 rather than 1.
   */
  const lines = useMemo(() => (text === "" ? 0 : text.trimEnd().split("\n").length), [text]);
  /** Names the preview for the toggle's `aria-controls` — see the button. */
  const previewId = useId();

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
      {/* A radio group over every format `EXPORT_FORMATS` names, and the map is what keeps this
          row from being a list to remember to grow. In that array's own order and
          **not** through `sortOptions`: plain first is the one most readers want, the same kind
          of deliberate order `lib/options.ts` exempts a grade scale for. */}
      <div role="radiogroup" aria-label="Export format" className="flex flex-wrap gap-2">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={format === f}
            onClick={() => chooseFormat(f)}
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

      {/* Only the fields this format and this surface share — `availableFields` is the whole of
          the rule, so nothing here is a list to remember to grow. `ALWAYS` is not drawn: a line
          with no count and no name is not a card, and a disabled checkbox that can never move is
          furniture rather than a control. */}
      {available.filter((id) => !ALWAYS.includes(id)).length > 0 && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="mb-1 text-sm text-dim">Fields</legend>
          {available
            .filter((id) => !ALWAYS.includes(id))
            .map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fields.includes(id)}
                  onChange={() => toggleField(id)}
                  className={cn("size-4 accent-accent", FOCUS)}
                />
                {TRANSFER_FIELDS[id].label}
              </label>
            ))}
        </fieldset>
      )}

      {/* Not a `role="alert"`: nothing failed. It is a fact about the format the reader just
          chose, and it has to be on screen before they press Copy rather than after — a
          maybeboard silently missing from an Arena export is the failure this line prevents. */}
      {omitted > 0 && (
        <p className="text-sm text-dim">
          {omitted === 1
            ? "1 card in a switched-off pile is"
            : `${omitted} cards in switched-off piles are`}{" "}
          not written in this format.
        </p>
      )}

      {/* The disclosure. **`aria-controls` only while there is something to control**: the
          preview is unmounted when this is shut, and an `aria-controls` pointing at an id no
          element carries is a promise to assistive technology that nothing keeps. `aria-expanded`
          is on the button in both states, which is what actually announces the pair. */}
      <button
        type="button"
        aria-expanded={showList}
        aria-controls={showList ? previewId : undefined}
        onClick={() => setShowList((open) => !open)}
        className={cn(
          "flex h-8 w-fit shrink-0 items-center gap-2 rounded-md px-2 text-sm text-dim",
          "transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        {/* Rotated rather than swapped for a second glyph, so the reduced-motion arm is the only
            thing that has to know there are two states. */}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 transition-transform duration-[var(--duration-fast)] ease-standard",
            "motion-reduce:transition-none",
            showList && "rotate-90",
          )}
        />
        {showList ? "Hide" : "Show"} decklist ({lines === 1 ? "1 line" : `${lines} lines`})
      </button>

      {/* `flex-1` and its own scroller, which is the whole of what keeps a 100-card export inside
          the panel: the shell clamps the panel to the window, this takes what is left over after
          the row above and the buttons below, and the text scrolls *inside* it rather than
          pushing them out of reach. */}
      {showList && (
        <pre
          id={previewId}
          className={cn(
            "min-h-0 flex-1 overflow-auto rounded-md border border-border bg-surface p-3",
            "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
          )}
        >
          {text}
        </pre>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleCopy}
          className={cn("h-9 rounded-md border border-border px-3 text-sm hover:bg-surface", FOCUS)}
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
          className={cn("h-9 rounded-md border border-border px-3 text-sm hover:bg-surface", FOCUS)}
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
