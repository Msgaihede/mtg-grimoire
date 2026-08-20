import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipcError, type ImportResolveLine } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";
import type { ImportDestination } from "./destination";
import { parseDecklist } from "./parse";
import { PRIMARY } from "./shared/CommitBar";
import { useImport } from "./useImport";

/** The extensions the picker offers. A decklist is text; the other three are what the desktop
 *  clients have always written it as (`.dec` MTGO, `.dek` Arena, `.csv` a spreadsheet export). */
const DECKLIST_EXTENSIONS = ["txt", "dec", "dek", "csv"];

export interface ImportDialogProps {
  /**
   * Where the cards may go — one entry, or several to choose between.
   *
   * **Non-generic, which is the whole point of {@link ImportDestination}'s shape**: this array is
   * the reason a destination cannot carry its item and options types. A shell that does not know
   * which destination it is holding cannot name those types, and nothing widens to
   * `ImportDestination<unknown, unknown>` because parameter positions are contravariant. So each
   * destination renders its own second step and this file never learns what is in it.
   *
   * One entry draws no radio group: a choice between one thing is not a choice.
   */
  destinations: readonly ImportDestination[];
  /**
   * The line under the heading, **as a fallback** — used for whichever destination has no
   * `Subtitle` of its own.
   *
   * **Never this file's own words, because saying it needs facts the shell must not have**:
   * `Into Removal · Burn · Live` is a pile name, a deck name and a variant. And never *only* the
   * host's either: the header is drawn on both steps while the destination radios are only on
   * the first, so a host prop cannot follow the reader's choice. A destination that has
   * something specific to say says it through `ImportDestination.Subtitle`; this is what is left
   * for the ones that do not — the new deck, which has no deck to name yet.
   */
  subtitle?: ReactNode;
  /**
   * **A mount, not a class**, and it is {@link Dialog}'s guarantee rather than this file's:
   * everything with state — the pasted text, the step, the commander picked, the caret — lives
   * in {@link ImportBody}, which the shell renders only while this is true. Closing unmounts all
   * of it and reopening starts a genuinely new question rather than one somebody has to remember
   * to clear — which is the property the two-step flow rests on, since Preview crosses to step
   * two inside a `mutationFn`'s `onSuccess` and nothing here resets it.
   */
  open: boolean;
  /** Escape, the header's ✕ and the trigger pressed again: close and hand the caret back. */
  onDismiss: () => void;
  /** A press on the scrim: close without moving focus. The reader is already somewhere else. */
  onClose: () => void;
  /**
   * The import landed, in the destination's own sentence.
   *
   * The caller closes the dialog; this does not, because what to do next differs by entry point
   * (the gallery opens the new deck, the editor is already showing it). A host that needs more
   * than a sentence — *which* deck a list became — takes it from the destination it built, where
   * the fact exists; see `DeckImportInto.onImported`.
   */
  onDone: (message: string) => void;
}

/** Which half of the dialog is up. Two steps in one panel rather than two dialogs: the second
 *  is entirely about the first, and Back has to keep what was pasted. */
type Step = "source" | "preview";

/**
 * A decklist, from anywhere, into whatever the host offered.
 *
 * **Two steps and one panel.** The reader pastes or picks a file, presses Preview, and is shown
 * what the import would do *before* anything is written. Nothing is written until Import.
 *
 * **It decides nothing itself, and since Task 12 it does not even know what "it" is going into.**
 * `parseDecklist` reads the text, `import_resolve` answers which printing each name means and
 * `oracle_tags_for_printings` answers what those printings do — that is the whole of this file's
 * business, because those three are the same question whatever the cards are going into. Which
 * pile, which grain, which modes and which button belong to the {@link ImportDestination} whose
 * `Preview` this mounts on step two.
 *
 * **Both reads are one press and one mutation**, so the second step is never reached holding
 * half of what files a card — see `useImport`'s `resolve`.
 *
 * **The chrome is {@link Dialog}'s and no longer this file's** (2026-08-16). The scrim, the
 * `LAYER.overlay` rung, `aria-modal`, `trapTab`, the Escape registration on the *flag* and the
 * titled header with its ✕ were a hand-copy of that shell — a copy that had drifted to a second
 * scrim darkness over the same editor and a third `max-h`. What is left here is the two steps
 * and everything that decides them.
 *
 * **Not portalled, and `fixed` — so where it is mounted matters.** Nothing in this app is
 * portalled (the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects
 * a runtime `<style>`). A `fixed` element is positioned against the viewport *unless* an
 * ancestor carries a `transform`, `filter` or `contain`, so this belongs at its host's top
 * level rather than inside a column or a row. The shell's panel is `fixed` for the same reason
 * and inherits the same condition.
 *
 * **The Escape rung is registered on the flag**, which is the shell's own guarantee: with an
 * exit animation the panel outlives `open` by the length of its fade, so a rung that came up
 * with the *element* would still be consuming Escape while the next layer was opening.
 */
export function ImportDialog({
  destinations,
  subtitle,
  open,
  onDismiss,
  onClose,
  onDone,
}: ImportDialogProps): JSX.Element {
  /**
   * Which of {@link ImportDialogProps.destinations} the cards are going into. An **index** rather
   * than a key, because the array is the host's and this file has no opinion about what is in it.
   *
   * **The one answer that lives out here rather than in {@link ImportBody}**, and it is placed
   * deliberately: the header band is `Dialog`'s and is drawn from this component, so a subtitle
   * that follows the reader's choice has to be chosen where the choice is held. The consequence
   * is that the destination — unlike the paste, the step and everything a preview owns — outlives
   * a close, which is the right half of the trade: reopening on the surface you last imported
   * into is a preference, not a stale answer to this question. With one destination it is always
   * `0` and nothing about either deck entry point changes.
   */
  const [chosen, setChosen] = useState(0);
  // Annotated rather than inferred: `noUncheckedIndexedAccess` is off, so a host that shortened
  // its array between opens would type as a destination and render as a crash.
  const destination: ImportDestination | undefined = destinations[chosen] ?? destinations[0];

  return (
    <Dialog
      open={open}
      title="Import a decklist"
      subtitle={destination?.Subtitle === undefined ? subtitle : <destination.Subtitle />}
      closeLabel="Close"
      // `max-w-2xl` written as the width it is (42rem), because the shell already carries
      // `max-w-full` and two `max-width` utilities on one element is whichever Tailwind emitted
      // last winning silently. `w-[42rem] max-w-full` computes to what `w-full max-w-2xl` did.
      width="w-[42rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <ImportBody
        destinations={destinations}
        destination={destination}
        chosen={chosen}
        onChoose={setChosen}
        onDone={onDone}
      />
    </Dialog>
  );
}

/**
 * The two steps and everything that decides them — mounted only while the dialog is open, which
 * is {@link Dialog}'s guarantee and what makes the step, the pasted text and the destination's
 * own answers a session rather than something an effect has to clear.
 *
 * It is the shell's `children` and a flex item of the panel, so the `<form>` it returns brings
 * its own `min-h-0 flex-1` and owns the scroller and the footer inside it — and so does every
 * destination's `Preview`, which is the other half of that arrangement.
 */
function ImportBody({
  destinations,
  destination,
  chosen,
  onChoose,
  onDone,
}: Pick<ImportDialogProps, "destinations" | "onDone"> & {
  /** The chosen one, resolved by the wrapper because the header needs it too. */
  destination: ImportDestination | undefined;
  chosen: number;
  onChoose: (index: number) => void;
}) {
  const id = useId();
  const listRef = useRef<HTMLTextAreaElement>(null);

  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>("source");
  /** The picker itself could not be opened, which is a different failure from a file the
   *  backend could not read — and it belongs beside the button rather than in the footer. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const { resolve, readFile } = useImport();

  const parsed = useMemo(() => parseDecklist(text), [text]);

  // The caret starts in the box the reader has to fill, which is `CreateDeckDialog`'s rule and
  // this dialog's whole first step. A stray Enter in a textarea is a newline, not a submit.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  /** Back to the box, and the resolved rows go with it. They are addressed by **index** into
   *  `parsed.lines`, so rows kept across an edit of the text would file the whole list by line
   *  numbers that have moved. The destination's own mutation state goes with them, because its
   *  `Preview` unmounts — which is why nothing here has to reset it. */
  const toSource = () => {
    resolve.reset();
    setStep("source");
  };

  const preview = () => {
    const lines: ImportResolveLine[] = parsed.lines.map((line) => ({
      name: line.name,
      setCode: line.setCode,
      collectorNumber: line.collectorNumber,
    }));
    resolve.mutate(lines, { onSuccess: () => setStep("preview") });
  };

  const choose = async () => {
    setPickerFailure(null);
    readFile.reset();
    setPicking(true);
    try {
      // `dialog:allow-open` is the one dialog permission this app grants. The picker answers a
      // **path**; `import_read_file` opens the file in Rust, which is why no `fs:`
      // permission is needed here either.
      const path = await pickFile({
        multiple: false,
        directory: false,
        title: "Choose a decklist",
        filters: [{ name: "Decklist", extensions: DECKLIST_EXTENSIONS }],
      });
      // A cancelled picker is not a failure — it is the most ordinary way to use a file dialog
      // after changing your mind.
      if (path !== null) {
        readFile.mutate(path, { onSuccess: (contents) => setText(contents) });
      }
    } catch (e) {
      setPickerFailure(ipcError(e));
    } finally {
      setPicking(false);
    }
  };

  const fileFailure =
    pickerFailure !== null
      ? `Could not open the file picker — ${pickerFailure}`
      : readFile.isError
        ? `Could not read that file — ${ipcError(readFile.error)}`
        : null;

  const resolved = resolve.data ?? null;

  if (step === "preview" && resolved !== null && destination !== undefined) {
    return (
      <destination.Preview
        list={parsed}
        resolved={resolved.rows}
        tags={resolved.tags}
        onDone={onDone}
        onBack={toSource}
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.lines.length > 0) preview();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div>
          <div className="mb-1 flex items-baseline gap-3">
            <label htmlFor={`${id}-list`} className="flex-1 text-xs text-dim">
              Decklist
            </label>
            <button
              type="button"
              onClick={() => void choose()}
              // Both halves of the round trip — the picker being up and the file being
              // read — because a second press does nothing useful in either. The label
              // does not change: an action keeps its name through the whole flow.
              disabled={picking || readFile.isPending}
              className={cn(
                "rounded-md border border-border px-2 py-0.5 text-[0.6875rem] text-dim",
                "transition-colors duration-[var(--duration-fast)] ease-standard",
                "hover:border-accent hover:text-accent",
                "disabled:opacity-50 disabled:hover:border-border disabled:hover:text-dim",
                "motion-reduce:transition-none",
                FOCUS,
              )}
            >
              Choose file…
            </button>
          </div>
          <textarea
            id={`${id}-list`}
            ref={listRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            spellCheck={false}
            className={cn(
              "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5",
              "font-mono text-xs leading-relaxed",
              "focus:border-accent focus:outline-none",
            )}
          />
          <p className="mt-1 text-[0.6875rem] text-dim">
            One card a line, count first — <span className="font-mono">4 Lightning Bolt</span>.
            Arena, Moxfield and MTGO exports read as they come, headings and all.
          </p>
          {/* The counts as they are typed, so the box says what it has read before the
              reader commits to a preview. */}
          {text.trim() !== "" && (
            <p className="mt-1 font-mono text-[0.6875rem] tabular-nums text-dim">
              {plural(parsed.lines.length, "line")} · {plural(parsed.totalCards, "card")}
              {parsed.issues.length > 0 && ` · ${plural(parsed.issues.length, "unreadable line")}`}
            </p>
          )}
          <AnimatePresence initial={false}>
            {fileFailure !== null && (
              <motion.p
                {...statusLine}
                role="alert"
                className="overflow-hidden text-[0.6875rem] text-destructive"
              >
                {fileFailure}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Asked here rather than on the preview, because it is a question about the *list*
            and every answer to it draws a different second step. One destination draws
            nothing at all: a choice between one thing is not a choice, which is what keeps
            both deck entry points byte-for-byte what they were. */}
        {destinations.length > 1 && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs text-dim">Where these cards go</legend>
            {destinations.map((option, index) => (
              <label key={option.key} className="flex items-baseline gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-destination`}
                  value={option.key}
                  checked={index === chosen}
                  onChange={() => onChoose(index)}
                  className="accent-accent"
                />
                Import into {option.label}
              </label>
            ))}
          </fieldset>
        )}

        <AnimatePresence initial={false}>
          {resolve.isError && (
            <motion.p
              {...statusLine}
              role="alert"
              className="overflow-hidden text-xs text-destructive"
            >
              Could not look those cards up — {ipcError(resolve.error)}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3.5">
        <button
          type="submit"
          disabled={parsed.lines.length === 0 || resolve.isPending}
          className={cn(PRIMARY, FOCUS)}
        >
          {resolve.isPending ? "Reading…" : "Preview"}
        </button>
      </footer>
    </form>
  );
}
