import { useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { CardImage } from "@grimoire/ui/components/CardImage";
import { balanceHeading, type Balance } from "@grimoire/ui/features/trade/trade";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { CARD_ASPECT, cardImageUrl } from "@grimoire/ui/lib/images";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { money } from "./text";

/**
 * What the trade's page and its sheets draw alike: the two presses, a card's small picture, the
 * balance, and the line a refusal is said on.
 */

/** The canvas's button: 44px for a thumb, a hairline, 14px medium. Greyed by `aria-disabled`. */
const BUTTON = cn(
  "inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border px-3.5",
  "text-sm font-medium whitespace-nowrap",
  PRESS,
  "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:active:scale-100",
  FOCUS,
);

/** The press a surface is *for* — New trade, Finish trade, Done. One to a surface. */
export const GOLD_BUTTON = cn(BUTTON, "border-accent text-accent");

/** Every other press: Cancel, Archive, Scan. */
export const PLAIN_BUTTON = cn(BUTTON, "border-border text-text");

/**
 * The press that opened a sheet, kept so the sheet can hand the caret back to it.
 *
 * **`ActionSheet`'s two ways out are told apart here**: Escape, the ✕ and a choice give the caret
 * back to the opener, and a press on the scrim leaves it where the reader put it. The opener is
 * looked at again when the time comes rather than trusted — a line that was removed, or moved to
 * the other side, is a press that is no longer on the page.
 */
export function useOpener(): { remember: (el: HTMLElement | null) => void; restore: () => void } {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: (el) => {
      opener.current = el;
    },
    restore: () => {
      if (opener.current?.isConnected === true) opener.current.focus({ preventScroll: true });
      opener.current = null;
    },
  };
}

/**
 * A card's picture, small, beside its name — the whole card and never the art crop, the scanner
 * tray's rule: two printings of one card are told apart by the frame. Decoration to a reader who
 * cannot see it, since the name is in words beside it.
 */
export function Thumb({ cardId, className }: { cardId: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block shrink-0 overflow-hidden rounded-[3px] bg-bg", className)}
      style={{ aspectRatio: CARD_ASPECT }}
    >
      <CardImage
        src={cardImageUrl(cardId, 0, "thumb")}
        alt=""
        loading="lazy"
        className="size-full object-contain"
      />
    </span>
  );
}

/**
 * Who owes whom: the sentence, the figure, and an arrow at the side that is owed.
 *
 * **The arrow points where the money goes** — right, at their column, when the reader owes; left,
 * at the reader's own, when they do — and it is on that side of the figure. An even trade has no
 * figure and no direction: a tick, in the one green this app keeps for "nothing is wrong".
 *
 * `past` is `trade.ts`'s `isSettled`: only a finished trade's balance is a record.
 */
export function BalanceFigure({
  balance,
  past,
  currency,
  size = "page",
}: {
  balance: Balance;
  past: boolean;
  currency: Currency;
  /** The page's footer draws it a step larger than the finish sheet's summary box. */
  size?: "page" | "box";
}) {
  const figure = cn(
    "flex items-center justify-center gap-2 font-mono leading-tight font-semibold tabular-nums",
    size === "page" ? "text-[1.0625rem]" : "text-base",
  );
  const arrow = size === "page" ? "size-3.5 shrink-0" : "size-[0.8125rem] shrink-0";
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-[0.8125rem] text-dim">{balanceHeading(balance, past)}</span>
      {balance.kind === "even" ? (
        <span
          className={cn(
            "flex items-center justify-center gap-2 leading-tight font-semibold text-ok",
            size === "page" ? "text-sm" : "text-[0.8125rem]",
          )}
        >
          <Check aria-hidden className={arrow} />
          Even trade
        </span>
      ) : balance.kind === "youOwe" ? (
        <span className={cn(figure, "text-accent")}>
          {money(balance.cents, currency)}
          <ArrowRight aria-hidden className={arrow} />
        </span>
      ) : (
        <span className={cn(figure, "text-accent")}>
          <ArrowLeft aria-hidden className={arrow} />
          {money(balance.cents, currency)}
        </span>
      )}
    </div>
  );
}

/**
 * A write the backend refused, in its own sentence.
 *
 * **Words on the page, never a tooltip** (`apps/light/CLAUDE.md`): a finger opens none. Mounted
 * only while there is a refusal, as the scanner's footer mounts its own — an alert that arrives
 * with its words is what a screen reader announces.
 */
export function Refusal({ children, className }: { children: ReactNode; className?: string }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive",
        className,
      )}
    >
      {children}
    </p>
  );
}
