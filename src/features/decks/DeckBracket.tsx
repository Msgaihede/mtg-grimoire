import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { FOCUS } from "@/lib/focus";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { estimateBracket } from "./validation/bracket";

/**
 * The Commander bracket, as a readout on the header's ledger and an advisory behind it.
 *
 * **It rode inside the format check's panel until 2026-08-24** and had no control of its own: a
 * reader who wanted to know what bracket their deck read as had to open a list of *findings* and
 * scroll past them. The two are different questions — the check says what is broken, this says
 * how strong the deck is, and a bracket cannot make a deck illegal — so they are two presses on
 * one line now rather than one press with the second answer stapled underneath.
 *
 * **Advisory in the copy as well as in the code.** Wizards' scale is explicitly "advisory only,
 * not hard validation" (the research doc), so the number is prefixed `~`, the panel leads with
 * the word estimate, and the disclosure names every card the number was read from — a reader who
 * disagrees with a heuristic can see which card caused it, which is the only thing that makes a
 * guess like this worth showing at all.
 *
 * **The estimate is computed on every edit now, and that is what the control costs.** It used to
 * be gated on the panel being open (`estimateBracket` greps every face of every card for four
 * phrases) — which is no longer possible, because the *button* prints the number. Memoised on
 * the rows, so it is one pass per change to the deck rather than one per render; the caller draws
 * this only for a format with a command zone, which is the whole of where a bracket means
 * anything.
 *
 * The panel is an `"inner"` Escape rung and the same piece of editor state as every dialog, so it
 * and the check can never be open at once — see `DeckEditor`'s `Layer` union, which is where that
 * is made structural.
 */
export function DeckBracket({
  cards,
  open,
  buttonRef,
  onOpen,
  onDismiss,
  onClose,
}: {
  cards: readonly DeckCard[];
  open: boolean;
  /** The button, so the editor can hand the caret back to it on the way out. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  /** Escape, and the button pressed a second time: the caret comes back to the button. */
  onDismiss: () => void;
  /** Focus left on its own. Closes and hands nothing back — the reader is already somewhere
   *  else. */
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const estimate = useMemo(() => estimateBracket([...cards]), [cards]);

  useDismissOnEscape({ layer: "inner", onDismiss, enabled: open });

  return (
    <div
      ref={rootRef}
      className="relative"
      // Clicking or tabbing away closes it, without a window listener that could fight the
      // Escape handshake. The boundary is the whole control rather than the panel, which is what
      // keeps the button a toggle: a press on it blurs the panel first, and a handler that did
      // not know the button would close the panel and let the press reopen it.
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        // The `~` is drawn and is not spoken: a screen reader says "tilde four" or nothing at
        // all, and the whole point of the glyph is the word this name spells out instead.
        aria-label={`Bracket ${estimate.bracket}, an estimate`}
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border",
          "px-2 font-mono text-[0.6875rem] tabular-nums",
          // **Accent, and it is not a state.** The bracket is the one figure on this line that is
          // a *reading* rather than a count, and the edge is what says the number came from
          // somewhere the reader can go and look. The check beside it colours a glyph instead,
          // for the reason on that control: red and green there mean broken and clean, and there
          // is no such pair here — a bracket 5 deck is not a worse deck.
          "border-accent text-accent",
          "transition-colors duration-150 hover:bg-accent/10 motion-reduce:transition-none",
          FOCUS,
        )}
      >
        Bracket ~{estimate.bracket}
      </button>

      <AnimatePresence>
        {open && (
          <Advisory key="advisory" estimate={estimate} />
        )}
      </AnimatePresence>
    </div>
  );
}

/** What the number was read from, and the sentence that keeps it a guess. */
function Advisory({ estimate }: { estimate: ReturnType<typeof estimateBracket> }) {
  const gameChangers = estimate.gameChangers;
  const panelRef = useRef<HTMLDivElement>(null);
  const [why, setWhy] = useState(false);
  /** False from the render that starts the exit, which is a state this panel has never been in
   *  before: painted, laid out, and no longer the thing the button is describing. */
  const present = useIsPresent();

  // The caret moves into the layer, as it does for every other one in this editor: the
  // disclosure below is then the next thing Tab reaches, and Escape has something to hand back.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const read: { label: string; names: string[] }[] = [
    { label: "Game changers", names: estimate.gameChangerNames },
    { label: "Mass land denial", names: estimate.massLandDenial },
    { label: "Extra turns", names: estimate.extraTurns },
  ].filter((line) => line.names.length > 0);

  return (
    <motion.div
      {...popup}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Bracket estimate"
      // On the way out it is a picture of a panel and nothing else — not clickable, and not in
      // the accessibility tree, where a second copy of the button's own reading would be. The
      // caret was handed back to the button before this render.
      aria-hidden={present ? undefined : true}
      className={cn(
        // Pinned by its right edge, because the button is the last control on the ledger and a
        // panel opening rightwards off it is a panel half outside the page — and right overflow
        // on this scroller is a horizontal scrollbar the editor must never have.
        "absolute right-0 top-9 w-72 max-w-[calc(100vw-2rem)] rounded-lg border",
        "border-border bg-bg/95 p-3 text-xs shadow-lg",
        // The scale grows from the corner the panel is pinned by — one that grew from its own
        // middle would read as unrelated to the button it hangs off.
        "origin-top-right",
        !present && "pointer-events-none",
        LAYER.popup,
        FOCUS,
      )}
    >
      {/* One text run: a headline fact split across styled spans is a sentence nothing — screen
          reader, test, or reader skimming — puts back together. Geist Mono for the counts, as
          everywhere else data is counted. */}
      <p className="font-mono font-medium tabular-nums">
        Bracket ~{estimate.bracket} · {gameChangers} game changer{gameChangers === 1 ? "" : "s"}
      </p>
      <p className="mt-1 text-dim">
        An estimate from what this app can see — a bracket is a conversation at the table, never a
        rule this deck can fail.
      </p>

      {read.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={why}
            onClick={() => setWhy((v) => !v)}
            className={cn(
              "mt-1 inline-flex items-center gap-1 rounded-md text-dim",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform duration-150 motion-reduce:transition-none",
                why && "rotate-90",
              )}
              aria-hidden="true"
            />
            What this read
          </button>
          {why && (
            <dl className="mt-1 space-y-1">
              {read.map((line) => (
                <div key={line.label}>
                  <dt className="text-dim">{line.label}</dt>
                  <dd>{line.names.join(", ")}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </motion.div>
  );
}
