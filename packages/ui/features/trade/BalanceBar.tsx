import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { balanceShares } from "./trade";

/** One stretch of the track. Dim unless it is the gap, whose gold is written after this. */
const SEGMENT = "min-w-0 basis-0 bg-dim";

/**
 * The balance drawn: the reader's share, the gap, their share, and a tick at the middle.
 *
 * **Three segments and not two**, which is what makes it read as a scale rather than as a
 * progress bar. Two segments meeting off-centre say "64 against 87" and leave the reader to
 * subtract; the gold stretch between where they meet and the tick *is* the subtraction — it sits
 * on the half of whoever owes, and it is as wide as what would bring that side level. An even
 * trade draws no gold at all, which is the one state the bar exists to make obvious.
 *
 * The widths are {@link balanceShares}', and they are handed to the browser as `flex-grow` rather
 * than as percentages: the bar has a 2px gap between its segments, and three percentages that sum
 * to 100 beside two gaps overflow the track by four pixels. Grow factors divide what the gaps
 * leave.
 *
 * `aria-hidden`, on both faces. The sentence beside it — *You owe them $22.70* — is the fact, and
 * a picture of that sentence read aloud would be the same fact with less in it.
 *
 * 320px wide by default, which is the desktop balance panel's; a caller with a narrower box
 * passes its own width and `tailwind-merge` keeps the later of the two.
 */
export function BalanceBar({
  mineTotal,
  theirsTotal,
  className,
}: {
  /** The reader's side, in cents, at its own percentage. */
  mineTotal: number;
  /** Their side, in cents, at its own percentage. */
  theirsTotal: number;
  className?: string;
}): JSX.Element {
  const shares = balanceShares(mineTotal, theirsTotal);
  return (
    <div aria-hidden="true" className={cn("relative h-3.5 w-80", className)}>
      <div className="absolute inset-x-0 top-1 flex h-1.5 gap-0.5 overflow-hidden rounded-[3px] bg-border">
        {/* `basis-0 min-w-0`, so a share of zero is zero pixels: a flex item's floor is its
            content, and an empty span's is nothing, but the basis has to be said. */}
        <span data-share="mine" className={SEGMENT} style={{ flexGrow: shares.mine }} />
        <span
          data-share="gap"
          className={cn(SEGMENT, "bg-accent")}
          style={{ flexGrow: shares.gap }}
        />
        <span data-share="theirs" className={SEGMENT} style={{ flexGrow: shares.theirs }} />
      </div>
      <div className="absolute top-0 left-1/2 -ml-px h-3.5 w-0.5 rounded-[1px] bg-text" />
    </div>
  );
}
