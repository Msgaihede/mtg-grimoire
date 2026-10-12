import type { JSX } from "react";
import { X } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { LogLine } from "./log";

/**
 * The two panels the board's top-right buttons open: how to move cards, and the game log — the
 * artboard `Goldfish · the table, turn 9` (2026-10-12).
 *
 * **Both at {@link LAYER.header}, the artboard's own `z-index: 20`**, and that is the lowest rung
 * that works rather than a borrowed name. They have to cover everything on the table: the
 * inspect preview and a lifted card in the hand fan, which sit at {@link LAYER.raised}. At
 * `raised` too the panel would win only by coming later in the DOM — the tie `layers.ts` opens
 * with — and the board's context menus and dialogs (`popup` and up) still open over both. The
 * board itself is one stacking context (`LAYER.stage`), so nothing here competes with a real
 * table header elsewhere in the app.
 */

/** The help panel, open under the `?` button. Closed by that button, or by `onClose`. */
export function HelpPanel({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <section
      aria-label="How to move cards"
      className={cn(
        "absolute top-[60px] right-4 flex w-[330px] flex-col gap-1.5",
        "rounded-xl border border-border bg-surface px-3.5 py-3 text-[13px]",
        LAYER.header,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim">Moving cards</span>
        {/* The artboard has no close of its own on this panel, but a panel that can only be
            closed from the button that opened it is one a keyboard reader has to go looking for. */}
        <CloseButton label="Close how to move cards" onClose={onClose} />
      </div>
      <span>
        Drag any card to wherever it goes: the table, your hand, the library, graveyard, exile or
        command zone.
      </span>
      <span>Click a permanent to tap it. Shift-click taps the whole pile.</span>
      <span>Double-click a card in hand to play it.</span>
      <span>Right-click anything for the rest: counters, copies, library tricks.</span>
      <span className="text-dim">
        Point at a card and press T, G, E or H to tap it, bury it, exile it or return it to hand.
      </span>
      <span className="text-dim">Press N for the next turn.</span>
    </section>
  );
}

/**
 * The game log, a drawer down the board's right edge. Newest first, as `log.ts` keeps it; the
 * opening hand's lines carry turn 0 and are marked with a dash rather than a "T0" no reader says.
 */
export function LogPanel({
  log,
  onClose,
}: {
  log: readonly LogLine[];
  onClose: () => void;
}): JSX.Element {
  return (
    <section
      aria-label="Game log"
      className={cn(
        "absolute inset-y-0 right-0 flex w-[340px] flex-col gap-2.5",
        "border-l border-border bg-surface p-4",
        LAYER.header,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">Game log</span>
        <CloseButton label="Close the game log" onClose={onClose} />
      </div>
      {log.length === 0 ? (
        <p className="m-0 text-[13px] text-dim">Nothing has happened yet.</p>
      ) : (
        <ol className="m-0 flex min-h-0 list-none flex-col gap-2 overflow-y-auto p-0 text-[13px]">
          {log.map((line, i) => (
            // The index is the key: two lines can say the same thing ("Drew Forest" twice), and
            // the list only ever grows at the top and trims at the bottom.
            <li key={log.length - i} className="flex items-baseline gap-2.5">
              <span className="w-6 flex-none font-mono text-xs text-dim">
                {line.turn === 0 ? "—" : `T${line.turn}`}
              </span>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CloseButton({ label, onClose }: { label: string; onClose: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClose}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md border border-border",
        "bg-transparent text-text transition-colors motion-reduce:transition-none hover:border-accent",
        PRESS,
        FOCUS,
      )}
    >
      <X className="size-3.5" aria-hidden="true" />
    </button>
  );
}
