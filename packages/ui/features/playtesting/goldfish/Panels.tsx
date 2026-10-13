import type { JSX, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  Bot,
  Copy,
  Dot,
  Flag,
  Hand,
  Heart,
  Mountain,
  Plus,
  RotateCw,
  Shuffle,
  Sparkles,
  Sunrise,
  Swords,
  X,
  type LucideIcon,
} from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { byTurn, type LogKind, type LogLine } from "./log";

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

/**
 * The help panel, open under the `?` button. Closed by that button, or by `onClose`.
 *
 * `children` replaces the goldfish's lines with a board's own — the playtest board's, where a
 * click on a creature can be a pick rather than a tap — under its own `heading`.
 */
export function HelpPanel({
  onClose,
  heading = "Moving cards",
  children,
}: {
  onClose: () => void;
  heading?: string;
  children?: ReactNode;
}): JSX.Element {
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
        <span className="text-xs text-dim">{heading}</span>
        {/* The artboard has no close of its own on this panel, but a panel that can only be
            closed from the button that opened it is one a keyboard reader has to go looking for. */}
        <CloseButton label="Close how to move cards" onClose={onClose} />
      </div>
      {children ?? <GoldfishHelp />}
    </section>
  );
}

/** The goldfish board's own help: every card is the reader's to move. */
function GoldfishHelp(): JSX.Element {
  return (
    <>
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
      <span className="text-dim">Press Space for the next turn.</span>
    </>
  );
}

/** Each kind of line's glyph, and the few that carry a colour: what was played and drawn. */
const GLYPH: Record<LogKind, { icon: LucideIcon; tone?: string }> = {
  deal: { icon: Hand },
  draw: { icon: ArrowDownToLine, tone: "text-mana-u" },
  land: { icon: Mountain, tone: "text-mana-g" },
  cast: { icon: Sparkles, tone: "text-accent" },
  move: { icon: ArrowRightLeft },
  tap: { icon: RotateCw },
  counter: { icon: Plus },
  token: { icon: Copy },
  shuffle: { icon: Shuffle },
  life: { icon: Heart, tone: "text-mana-r" },
  turn: { icon: Sunrise },
  engine: { icon: Bot },
  combat: { icon: Swords, tone: "text-mana-r" },
  end: { icon: Flag, tone: "text-accent" },
};

/** A turn's heading: "Turn 3", and the opening hand's lines under a name rather than "Turn 0". */
function turnTitle(turn: number): string {
  return turn === 0 ? "Opening hand" : `Turn ${turn}`;
}

/**
 * The game log, a drawer down the board's right edge. Newest first, as `log.ts` keeps it, and
 * cut into turns: each turn under a heading with a rule across, the turn being played in the
 * accent. A line's glyph says what kind of thing it was at a glance (`LogKind`); the turn's own
 * "untapped · turn begins" line is dimmed, since the heading above it already says so.
 */
export function LogPanel({
  log,
  onClose,
}: {
  log: readonly LogLine[];
  onClose: () => void;
}): JSX.Element {
  const turns = byTurn(log);
  return (
    <section
      aria-label="Game log"
      className={cn(
        "absolute inset-y-0 right-0 flex w-[340px] flex-col",
        "border-l border-border bg-surface shadow-lg",
        LAYER.header,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">Game log</span>
          {log.length > 0 && (
            <span className="text-xs text-dim">
              {log.length} {log.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </div>
        <CloseButton label="Close the game log" onClose={onClose} />
      </div>
      {log.length === 0 ? (
        <p className="m-0 p-4 text-[13px] text-dim">Nothing has happened yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
          {turns.map((group, g) => (
            <section key={`turn-${group.turn}`} aria-label={turnTitle(group.turn)}>
              <h3
                className={cn(
                  "sticky top-0 m-0 flex items-center gap-2.5 bg-surface px-1 pt-3 pb-1.5",
                  "text-[11px] font-semibold tracking-wider uppercase",
                  g === 0 ? "text-accent" : "text-dim",
                )}
              >
                <span>{turnTitle(group.turn)}</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </h3>
              <ol className="m-0 flex list-none flex-col p-0 text-[13px]">
                {group.lines.map((line, j) => {
                  const { icon: Icon, tone } = line.kind === undefined ? DOT : GLYPH[line.kind];
                  // The line's place in the whole log is its key: two lines can say the same
                  // thing ("Drew Forest" twice), and the log only grows at the top.
                  const key = log.length - (group.from + j);
                  return (
                    <li
                      key={key}
                      className="flex items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-bg/60"
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn("mt-[3px] size-3.5 flex-none", tone ?? "text-dim")}
                      />
                      <span className={cn(line.kind === "turn" && "text-dim")}>{line.text}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/** A line written without a kind — a story's, or one from before kinds — gets a plain glyph. */
const DOT: { icon: LucideIcon; tone?: string } = { icon: Dot };

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
