import { useEffect, useRef, useState, type JSX } from "react";
import { User } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { QuantityStepper } from "@/components/QuantityStepper";
import { cardImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";

/**
 * How long the plate waits after the last change before it tells the game.
 *
 * **`QuantityStepper` reports every keystroke**, so typing "37" into the box would otherwise be
 * two actions — life set to 3, then to 37 — and two lines in the log, the first of them a lie
 * ("The opponent took 37, down to 3"). Waiting for the reader to stop is also what makes seven
 * presses of `−` one hit rather than seven: the log reads "The opponent took 7, down to 12",
 * which is how a reader says it. Blur and Enter commit at once, so leaving the box never strands
 * a number that was not sent.
 */
const SETTLE_MS = 400;

/**
 * One player's life, the artboard's plate: a round portrait, the seat's name in small capitals
 * and a stepper — top centre for the goldfish, at the foot for the reader.
 *
 * The number shown is the reader's draft while one is in flight, and the game's otherwise: it
 * lets go of the draft only when the game's own number moves (the engine's answer arriving), so
 * a committed change does not flash back to the old life for the length of the round trip.
 */
export function LifePlate({
  seat,
  title,
  life,
  onChange,
  cardId,
  highlight = false,
  disabled = false,
  compact = false,
  label,
  className,
}: {
  seat: "you" | "opponent";
  title: string;
  life: number;
  onChange: (life: number) => void;
  /** The reader's commander, drawn as their portrait. Absent or `null`: the same silhouette the
   *  goldfish wears. */
  cardId?: string | null;
  /** The goldfish is dead: the plate's edge goes gold. */
  highlight?: boolean;
  disabled?: boolean;
  /**
   * One row, 38 px tall: a small portrait, the name beside a small stepper — the playtest
   * board's opponent, whose plate shares a thin band with their hand. Absent, the goldfish's
   * plate is drawn exactly as it was.
   */
  compact?: boolean;
  /**
   * The stepper's name for a screen reader. Absent, "Your life" or "Opponent's life" by `seat` —
   * the playtest board's four-player table names each opponent ("Opponent 2's life").
   */
  label?: string;
  /** On the plate's own box: `min-w-0` lets a narrow row shrink its title. */
  className?: string;
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [seen, setSeen] = useState(life);
  // The game answered with a new number: it is the truth now, unless the reader has already
  // started another change on top of it (`pending`), which will be sent in its turn.
  if (seen !== life) {
    setSeen(life);
    if (!pending) setDraft(null);
  }

  const timer = useRef<number | null>(null);
  const latest = useRef<number | null>(null);
  const report = useRef(onChange);
  const current = useRef(life);
  useEffect(() => {
    report.current = onChange;
    current.current = life;
  });
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const commit = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPending(false);
    const next = latest.current;
    latest.current = null;
    if (next === null) return;
    // Stepped down and back up again: nothing to tell the game, and no answer will come to
    // clear the draft, so clear it here.
    if (next === current.current) setDraft(null);
    else report.current(next);
  };

  const change = (next: number) => {
    setDraft(next);
    setPending(true);
    latest.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, SETTLE_MS);
  };

  const named = label ?? (seat === "opponent" ? "Opponent's life" : "Your life");
  const portrait = seat === "you" && cardId != null ? cardId : null;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[14px] border bg-surface py-2 pl-2",
        seat === "opponent" ? "pr-3" : "pr-4",
        highlight ? "border-accent" : "border-border",
        compact && "gap-2 rounded-full py-1 pr-1.5 pl-1",
        className,
      )}
    >
      {portrait !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-11 flex-none overflow-hidden rounded-full border border-border",
            compact && "size-7",
          )}
        >
          <CardImage
            src={cardImageUrl(portrait, 0, "art")}
            alt=""
            className="block h-full w-full object-cover"
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-11 flex-none items-center justify-center rounded-full border border-border bg-bg text-dim",
            compact && "size-7",
          )}
        >
          <User className={cn("size-[22px]", compact && "size-4")} />
        </span>
      )}
      {/* A `fieldset` because `disabled` on one reaches every control inside it, and the stepper
          has no `disabled` of its own: while a game is being dealt there is no life to change. */}
      <fieldset
        disabled={disabled}
        className={cn(
          "m-0 flex min-w-0 flex-col gap-1 border-0 p-0",
          compact && "flex-row items-center gap-2",
        )}
        onBlur={(e) => {
          // Leaving the box commits what was typed; moving between `−`, the box and `+` does
          // not, so a run of presses stays one change.
          if (e.target instanceof HTMLInputElement) commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      >
        <span
          className={cn(
            "text-[11px] tracking-[0.08em] text-dim uppercase",
            compact && "max-w-[180px] truncate",
          )}
        >
          {title}
        </span>
        <QuantityStepper
          value={draft ?? life}
          onChange={change}
          min={0}
          max={999}
          label={named}
          size={compact ? "sm" : "md"}
        />
      </fieldset>
    </div>
  );
}
