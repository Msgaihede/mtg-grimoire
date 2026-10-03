import type { ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The phone face's **action sheet**: a panel at the foot of the window, over a scrim, with the
 * rows a reader's thumb reaches for — the desktop's right-click menu, drawn for a finger.
 *
 * **`Dialog`, not a sheet of its own**, so it is the app's one modal shell: the scrim, the trap,
 * the Escape rung, the ✕ and the presence tween are all `Dialog.tsx`'s. What makes it a *bottom*
 * sheet is the panel's own size string — `self-end` against the scrim's `place-items-center`, the
 * top corners rounded where the shell rounds none below 640px — and from 640 up it is the
 * centred panel every other dialog is.
 *
 * **Not a place.** A row's actions are the page's own state, like the filters sheet: nothing about
 * them is worth sending to somebody, so opening one pushes no history entry.
 */
export function ActionSheet({
  open,
  title,
  subtitle,
  closeLabel,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  /** Under the scrolling body and outside it — the sheet's receipt line. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      subtitle={subtitle}
      closeLabel={closeLabel}
      size="w-full self-end rounded-t-xl border-t border-border max-h-[85dvh] sm:max-h-full sm:w-[26rem] sm:self-center"
      onDismiss={onClose}
      onClose={onClose}
    >
      {/* `relative` because this box carries the overflow — `src/CLAUDE.md`'s rule for an
          `sr-only` caption inside a scroller. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
        {children}
      </div>
      {footer}
      {/* The home indicator's inset, on the panel's last line rather than on every row. */}
      <div aria-hidden className="h-[env(safe-area-inset-bottom)] shrink-0" />
    </Dialog>
  );
}

/** The 48px row every choice in a sheet is drawn as — the touch floor and a little air. */
const ROW = "flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm";

/**
 * One row of a sheet: a press, its words, what it is set to now, and — where it opens a list of
 * its own — a chevron. **Refused rows stay drawn and say why in words**, which is the one place the
 * phone departs from the desktop menu's silent greying: a menu row is sized by its widest content
 * and a sentence widens every row, while a sheet row is the width of the window and has a second
 * line to spare. `aria-disabled`, never `disabled`, so the row keeps its place in the tab order and
 * is still announced.
 */
export function SheetRow({
  label,
  value,
  reason,
  opens = false,
  destructive = false,
  Icon,
  onPress,
}: {
  label: string;
  /** What the row is set to now, dim at the far end — `Ramp`, `Foil`, `None`. */
  value?: string;
  /** Why the press is refused, or absent where it may be pressed. */
  reason?: string | null;
  /** The row opens a list rather than writing. */
  opens?: boolean;
  destructive?: boolean;
  Icon?: (props: { className?: string; "aria-hidden"?: boolean }) => ReactNode;
  onPress: () => void;
}) {
  const refused = reason !== undefined && reason !== null;
  return (
    <li>
      <button
        type="button"
        aria-disabled={refused || undefined}
        aria-haspopup={opens && !refused ? "true" : undefined}
        onClick={() => {
          if (!refused) onPress();
        }}
        className={cn(
          ROW,
          "active:bg-surface",
          refused && "cursor-default text-dim active:bg-transparent",
          destructive && !refused && "text-destructive",
          FOCUS_INSET,
        )}
      >
        {Icon !== undefined && <Icon aria-hidden className="size-4 shrink-0 text-dim" />}
        <span className="flex min-w-0 flex-1 flex-col py-1.5">
          <span className="truncate">{label}</span>
          {refused && <span className="text-[0.6875rem] leading-snug text-dim">{reason}</span>}
        </span>
        {value !== undefined && (
          <span className="max-w-[45%] shrink-0 truncate text-xs text-dim">{value}</span>
        )}
        {/* No way in where the row is refused: a chevron is a promise of a list to open. */}
        {opens && !refused && <ChevronRight aria-hidden className="size-4 shrink-0 text-dim" />}
      </button>
    </li>
  );
}

/**
 * One choice in a sheet's list — a pile, a label, a finish. **The current one is marked and is not
 * a press**: it carries a tick, `aria-current`, and the word for why nothing would happen, so a
 * reader who presses it learns the card is already there rather than watching nothing move.
 */
export function SheetChoice({
  label,
  current,
  note,
  indent = 0,
  onPick,
  children,
}: {
  label: string;
  current: boolean;
  /** How deep in a tree the choice sits — a nested folder — 16px a level past the row's own. */
  indent?: number;
  /** A dim second line — `(off)` on a switched-off pile, what it costs. */
  note?: string;
  onPick: () => void;
  /** Drawn in place of the label where a choice is more than a word — a printing's row. */
  children?: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        aria-disabled={current || undefined}
        aria-label={children !== undefined ? label : undefined}
        style={indent > 0 ? { paddingLeft: 16 + indent * 16 } : undefined}
        onClick={() => {
          if (!current) onPick();
        }}
        className={cn(
          ROW,
          "active:bg-surface",
          current && "cursor-default active:bg-transparent",
          FOCUS_INSET,
        )}
      >
        <Check
          aria-hidden
          className={cn("size-4 shrink-0", current ? "text-accent" : "invisible")}
        />
        {children ?? (
          <span className="flex min-w-0 flex-1 flex-col py-1.5">
            <span className="truncate">{label}</span>
            {note !== undefined && (
              <span className="text-[0.6875rem] leading-snug text-dim">{note}</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

/** The way back from a list to the sheet's first page. A row like the rest, at the list's head. */
export function SheetBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className={cn(ROW, "border-b border-border text-dim active:bg-surface", FOCUS_INSET)}
    >
      <ChevronLeft aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/**
 * The copies, as a stepper a thumb can work: `−`, the number, `+`, each 44px. **`−` at one copy is
 * the removal**, and says so in its name — the same write as the sheet's `Remove …` row below it,
 * and the receipt offers it back where the desktop can. A deck row's sheet and a collection copy's
 * and a wish's draw it alike.
 */
export function SheetStepper({
  quantity,
  name,
  onSet,
}: {
  quantity: number;
  name: string;
  onSet: (quantity: number) => void;
}) {
  const button = cn(
    "flex size-11 shrink-0 items-center justify-center rounded-md border border-border",
    PRESS,
    FOCUS,
  );
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 pb-3 pt-2">
      <span className="min-w-0 flex-1 text-sm text-dim">Copies</span>
      <button
        type="button"
        aria-label={quantity <= 1 ? `Remove ${name}` : `One fewer ${name}`}
        onClick={() => onSet(Math.max(0, quantity - 1))}
        className={cn(button, quantity <= 1 && "text-destructive")}
      >
        {quantity <= 1 ? (
          <Trash2 aria-hidden className="size-4" />
        ) : (
          <Minus aria-hidden className="size-4" />
        )}
      </button>
      <output aria-label="Copies" className="w-8 text-center font-mono text-base tabular-nums">
        {quantity}
      </output>
      <button
        type="button"
        aria-label={`One more ${name}`}
        onClick={() => onSet(quantity + 1)}
        className={button}
      >
        <Plus aria-hidden className="size-4" />
      </button>
    </div>
  );
}
