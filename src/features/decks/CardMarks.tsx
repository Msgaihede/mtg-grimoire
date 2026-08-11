/**
 * The three marks a card in a deck can carry, in one place because five surfaces draw them.
 *
 * The stack, the table, the text columns, the grid and the categories panel all say the same
 * three things about a card, and the spec is explicit that **a rule break and a game changer
 * must never be confusable** — one is a problem, the other is a fact about a powerful card.
 * That is only true if they are drawn the same way everywhere, which is what this file buys.
 *
 * Four things separate them and every surface keeps all four: the words (`RULE BREAK` spelled
 * out against two letters), the colour (destructive against the pie gold), the place (over
 * the card's art against its title bar) and the card's own edge, which only a rule break
 * changes. The place is the caller's — a 150px grid tile and a 224px stacked card put them in
 * different corners — so it rides in `className`; the other three are here.
 */
import { cn } from "@/lib/utils";
import { tagColorCss } from "./tagColors";

/**
 * The one tag a card wears, as an 8px chip in its own colour with the name one hover away.
 *
 * A dot rather than a word: a tag is a mark the reader put there and already knows, and a
 * 224px column has no room for a second label beside a card's name. The name is not lost —
 * it is the `title` and it is read aloud, so the colour is a shortcut rather than the only
 * way to know.
 */
export function TagDot({
  name,
  color,
  className,
}: {
  name: string;
  /** The stored palette token, never a CSS colour — see `tagColors.ts`. */
  color: string | null;
  className?: string;
}) {
  return (
    <span
      title={name}
      style={{ backgroundColor: tagColorCss(color) }}
      className={cn("size-2 shrink-0 rounded-[2px] shadow-[0_0_0_1px_var(--color-bg)]", className)}
    >
      <span className="sr-only">Tagged {name}</span>
    </span>
  );
}

/**
 * A game changer, as two gold letters.
 *
 * Gold and abbreviated on purpose: it is a fact about the card, not a problem with the deck,
 * and a deck may hold a dozen of them legally. `bracket.ts` counts them into an advisory;
 * nothing about one is a finding.
 */
export function GameChangerBadge({ className }: { className?: string }) {
  return (
    <span
      title="Game changer"
      className={cn(
        "shrink-0 rounded-[2px] border border-pie-gold px-0.5 font-mono text-[0.5625rem]",
        "leading-3 text-pie-gold",
        className,
      )}
    >
      <span aria-hidden="true">GC</span>
      <span className="sr-only">Game changer</span>
    </span>
  );
}

/**
 * A rule this card breaks, spelled out in the destructive colour with the whole sentence one
 * hover away.
 *
 * Errors only — `ruleBreak` in `violations.ts` is what decides, and a warning (an orphaned
 * row, a legality blob this app cannot read) is a fact worth a look rather than a rule the
 * reader broke. It is drawn over the art rather than beside the name so that it cannot be
 * mistaken for part of the card's own printed line.
 */
export function RuleBreakMark({ text, className }: { text: string; className?: string }) {
  return (
    <span
      title={text}
      className={cn(
        "rounded-[3px] border border-destructive/50 bg-bg/85 px-1 py-px",
        "font-mono text-[0.5625rem] text-destructive",
        className,
      )}
    >
      <span aria-hidden="true">RULE BREAK</span>
      <span className="sr-only">Rule break: {text}</span>
    </span>
  );
}

/**
 * The 2px stripe down the left of a text or table row that says, at a glance down a column of
 * eighty, which rows are worth stopping at.
 *
 * Destructive beats gold: a card that is both a game changer and a rule break is a problem
 * first. `transparent` rather than nothing, so every row keeps the same 2px of indent and the
 * names stay in one column.
 */
export function rowMarkColor(ruleBreakText: string | null, gameChanger: boolean | null): string {
  if (ruleBreakText !== null) return "var(--color-destructive)";
  return gameChanger === true ? "var(--color-pie-gold)" : "transparent";
}
