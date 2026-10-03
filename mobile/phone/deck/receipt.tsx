import { useCallback, useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { auditSentence } from "@/features/decks/auditText";
import { useDeckUndo } from "@/features/decks/useDeckUndo";
import { FOCUS } from "@/lib/focus";
import { ipcError, type DeckAuditEntry } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * How long a receipt stays up once it has something to say. Long enough to read a sentence and
 * reach for `Undo` with a thumb; short enough that it is not still standing over the page the
 * next time the reader looks down.
 */
export const RECEIPT_MS = 8000;

/**
 * What the last write from this face did to one deck, and the way to take it back — **the
 * desktop's own undo**, not a second one.
 *
 * Every deck write the backend journals files a step on the deck's own cursor (`deck_undo`), and
 * the desktop's toolbar Undo is `useDeckUndo`: the newest step. So the receipt is that hook read at
 * the right moment. A write is *tracked* at its press — which step was newest then — and once the
 * deck's undo state answers with a **different** newest step, that step is the one this write
 * filed, and `Undo` is offered beside the line, named by the step's own sentence (`auditSentence`,
 * the history drawer's words).
 *
 * **What the line says is the press's own sentence where the caller gave one** — "Moved Lightning
 * Bolt to Sideboard" — and the step's where it did not. The press's is the better one to read:
 * it is there the moment the write lands rather than a read later, and a write the deck files no
 * step for still says what it did. **Not every write has a step, and the receipt does not pretend
 * otherwise**: a cut from an Actual list is a collection write (`deck_to_collection`, which puts the
 * copies in `Recently removed`) and the desktop's undo cannot reverse it either, so its line says
 * where the copies went and offers no `Undo`. A refusal leaves the cursor where it was and says the
 * command's own words.
 *
 * `Undo` reverses the deck's newest step, which is what the desktop's button does too. Another
 * window writing to the same deck in the same second is the one way that can differ from this
 * press, and the button's name — read off the step, not off the press — is what says which change
 * it will reverse.
 *
 * Only the undo half: the phone draws no Redo, so the session's redo stack is cleared after every
 * write as the hook's contract asks and never pressed.
 */
export interface ReceiptLine {
  /** The line to draw, or `null` when there is nothing to say. */
  text: string | null;
  /** True when {@link text} is a refusal. */
  refused: boolean;
  /**
   * What `Undo` would take back, in words — the button is named `Undo — <this>` — or `null` where
   * there is nothing this face can take back, which draws no `Undo` at all.
   */
  undoName: string | null;
  /** True while the undo itself is out. */
  busy: boolean;
  undo: () => void;
  dismiss: () => void;
}

/**
 * {@link ReceiptLine} for one deck: the line, plus the press that feeds it and the history step
 * the last write filed.
 */
export interface Receipt extends ReceiptLine {
  /**
   * Call at the press, with the write's promise and — optionally — what to say once it lands,
   * worked out from its answer (`null` to say nothing but the step's own sentence).
   */
  track: <T>(write: Promise<T>, said?: (result: T) => string | null) => void;
  /** The step the last tracked write filed, once the deck has said so — or `null`. */
  entry: DeckAuditEntry | null;
}

/** Hands each press its own number — see {@link Tracked.press}. */
let presses = 0;

interface Tracked {
  /** Which press this is — a newer press replaces the object, and a late answer must not land. */
  press: number;
  /** The deck's newest step at the press — `null` for a deck with no history yet. */
  before: number | null;
  /** The write has answered, either way. */
  done: boolean;
  said: string | null;
  error: string | null;
}

export function useReceipt(deckId: number): Receipt {
  const undo = useDeckUndo(deckId);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const newest = undo.undo;
  const { clearRedo, runUndo } = undo;

  const track = useCallback(
    <T,>(write: Promise<T>, said?: (result: T) => string | null) => {
      const before = newest?.id ?? null;
      presses += 1;
      const press = presses;
      setTracked({ press, before, done: false, said: null, error: null });
      const land = (patch: Partial<Tracked>) =>
        setTracked((now) => (now !== null && now.press === press ? { ...now, ...patch } : now));
      write.then(
        (result) => {
          clearRedo();
          land({ done: true, said: said?.(result) ?? null });
        },
        (error: unknown) => land({ done: true, error: ipcError(error) }),
      );
    },
    [newest, clearRedo],
  );

  const entry =
    tracked !== null &&
    tracked.done &&
    tracked.error === null &&
    newest !== null &&
    newest.id !== tracked.before
      ? newest
      : null;
  const refused = tracked?.error != null;
  const text =
    tracked?.error ?? tracked?.said ?? (entry !== null ? auditSentence(entry).text : null);

  // The receipt goes by itself. A timer's callback, not a write during the effect — the effect
  // only arms it, and re-arms it for each new thing there is to say.
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => setTracked(null), RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [text, entry?.id]);

  return {
    track,
    text,
    refused,
    entry,
    undoName: entry !== null ? auditSentence(entry).text : null,
    busy: undo.busy,
    undo: () => {
      runUndo();
      setTracked(null);
    },
    dismiss: () => setTracked(null),
  };
}

/**
 * The receipt, drawn: one line at the foot of whatever surface the reader is on, with `Undo` and
 * a way to put it down. **A live region that is always mounted**, because one that first appears
 * with its sentence already inside announces nothing — `src/CLAUDE.md`'s ribbon status line, for
 * the same reason. A refusal is drawn in the destructive colour and says the command's own words;
 * it offers no `Undo`, because nothing was written.
 */
export function ReceiptBar({
  receipt,
  extra,
  muted = false,
  className,
}: {
  /** A deck's receipt, or any other surface's line in the same shape (`lists/receipt.ts`). */
  receipt: ReceiptLine;
  /**
   * Say nothing for now — another surface over this one is drawing the same receipt. The live
   * region stays mounted, so it is ready to speak the moment that surface goes.
   */
  muted?: boolean;
  /** Said after the sentence — the add search's count of copies now in the list. */
  extra?: ReactNode;
  className?: string;
}) {
  const { undoName, text, refused } = receipt;
  return (
    <div role="status" aria-live="polite" className={className}>
      {!muted && text !== null && (
        <div
          className={cn(
            "flex min-h-12 items-center gap-2 border-t border-border bg-surface pl-4 pr-1",
            refused && "text-destructive",
          )}
        >
          <p className="min-w-0 flex-1 py-2 text-[0.8125rem] leading-snug">
            {text}
            {!refused && extra !== undefined && extra !== null && (
              <>
                {" "}
                <span className="text-dim">· {extra}</span>
              </>
            )}
          </p>
          {undoName !== null && !refused && (
            <button
              type="button"
              onClick={receipt.undo}
              disabled={receipt.busy}
              // What it takes back, in the name: `Undo` alone is a press about nothing.
              aria-label={`Undo — ${undoName}`}
              className={cn(
                "h-11 shrink-0 rounded-md px-3 text-sm font-medium text-accent",
                PRESS,
                FOCUS,
              )}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={receipt.dismiss}
            aria-label="Dismiss"
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
              FOCUS,
            )}
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
