/**
 * The mark a folder with rules wears on its heading and its card (issue #980, spec §5): a
 * `ListChecks` glyph, and beside it — only when the folder's sub-tree holds cards that break
 * them — that count in destructive red.
 *
 * **Drawn for effective rules, not own ones**: a subfolder adopts its parent's rules, and a drawer
 * that judged its cards by rules it did not show would be the inheritance made invisible exactly
 * where it applies — `lockedFolderIds`' argument for the lock, made again for rules.
 *
 * **A press shows the breakers** (issue #1057): given {@link FolderRulesBadgeProps.onShow} and a
 * count above zero, the mark is a button, and the page answers it by opening the folder with the
 * wall narrowed to the cards that break its rules. With nothing out of place it stays an image —
 * a press that could only show an empty wall is not offered.
 *
 * The glyph's size and tone are the folder card's own `size-3.5 text-dim` (`ParentFolderCard`), so
 * it sits beside a folder name as the `Lock` does. The tooltip says the rules in words, and the
 * accessible name says the same in one sentence, since a tooltip is not a name.
 */
import type { ReactElement } from "react";
import { ListChecks } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count } from "@/lib/counts";
import { conflictSentence, describeRule, hasRules, type EffectiveRules } from "@/lib/folderRules";
import { FOCUS } from "@/lib/focus";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

/** What a press of a badge with breakers does, said in its name and at the foot of its tooltip. */
export const SHOW_SENTENCE = "Press to show them.";

export interface FolderRulesBadgeProps {
  effective: EffectiveRules;
  /** Conflicting cards in the folder's sub-tree (`subtreeConflicts`), `0` for none. */
  conflicts: number;
  className?: string;
  /**
   * A tab stop of its own, so a keyboard reader can bring the tooltip up. **Pass `false` inside an
   * element that is already interactive** — a folder card's button — where a nested tab stop is
   * axe's `nested-interactive` and the host's own name should carry {@link FolderRulesBadge}'s
   * sentence instead. Default `true`, for a heading.
   */
  focusable?: boolean;
  /**
   * Show the cards that break the rules — the folder opened, the wall narrowed to them. Read only
   * while {@link conflicts} is above zero and the badge is {@link focusable}: inside a control the
   * mark cannot be a second one.
   */
  onShow?: () => void;
}

export function FolderRulesBadge({
  effective,
  conflicts,
  className,
  focusable = true,
  onShow,
}: FolderRulesBadgeProps): ReactElement | null {
  const tip = useTooltip();
  const { marketplace } = useMarketplace();
  if (!hasRules(effective)) return null;

  const money = (v: number) => formatPrice(v, marketplace.currency);
  const own = effective.own.map((r) => describeRule(r, money));
  const groups = effective.inherited.map((g) => ({
    name: g.folderName,
    rules: g.rules.map((r) => describeRule(r, money)),
  }));
  const conflict = conflicts > 0 ? conflictSentence(conflicts) : null;

  const spoken = [
    own.length > 0 ? `This folder's rules: ${own.join("; ")}.` : null,
    ...groups.map((g) => `From “${g.name}”: ${g.rules.join("; ")}.`),
    conflict === null ? null : `${conflict}.`,
  ]
    .filter((s) => s !== null)
    .join(" ");

  const tooltip = (
    <div className="flex flex-col gap-1.5 text-left">
      {own.length > 0 && (
        <div>
          <p className="text-dim">This folder's rules:</p>
          <ul>
            {own.map((words, i) => (
              <li key={i}>{words}</li>
            ))}
          </ul>
        </div>
      )}
      {groups.map((g, i) => (
        <div key={i}>
          <p className="text-dim">From “{g.name}”:</p>
          <ul>
            {g.rules.map((words, j) => (
              <li key={j}>{words}</li>
            ))}
          </ul>
        </div>
      ))}
      {conflict !== null && <p className="text-destructive">{conflict}</p>}
    </div>
  );

  const glyph = (
    <>
      <ListChecks className="size-3.5 text-dim" aria-hidden="true" />
      {conflicts > 0 && (
        <span className="text-xs tabular-nums text-destructive" aria-hidden="true">
          {count(conflicts)}
        </span>
      )}
    </>
  );
  const shape = cn("inline-flex shrink-0 items-center gap-1 rounded-sm", FOCUS, className);

  if (onShow !== undefined && focusable && conflicts > 0) {
    return (
      <button
        type="button"
        aria-label={`${spoken} ${SHOW_SENTENCE}`}
        {...tip(
          <div className="flex flex-col gap-1.5">
            {tooltip}
            <p className="text-dim">{SHOW_SENTENCE}</p>
          </div>,
          { describes: false },
        )}
        onClick={(event) => {
          // A heading's own press opens or folds its shelf; this one is the badge's alone.
          event.stopPropagation();
          onShow();
        }}
        className={cn(shape, "cursor-pointer hover:bg-accent/10")}
      >
        {glyph}
      </button>
    );
  }

  return (
    // An `img` rather than a button: with nothing out of place, or no `onShow`, it does nothing
    // when pressed. Focusable (by default) because a keyboard reader needs a stop to bring the
    // tooltip up on.
    <span
      role="img"
      tabIndex={focusable ? 0 : undefined}
      aria-label={spoken}
      // `describes: false`: the `aria-label` already says every word the panel does.
      {...tip(tooltip, { describes: false })}
      className={shape}
    >
      {glyph}
    </span>
  );
}
