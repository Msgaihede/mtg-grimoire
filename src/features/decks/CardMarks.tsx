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
 *
 * ## Every one of these is `aria-hidden`, and that is deliberate
 *
 * It is `FoilOverlay`'s rule, for `FoilOverlay`'s reason. Three of these five surfaces draw a
 * card as a **button with an explicit `aria-label`**, and an `aria-label` *replaces* the
 * element's content for naming purposes — so an `sr-only` span inside one of these marks is
 * announced to nobody at all, which is worse than no text, because it looks accessible. The
 * mark is the decoration; the **statement** is `deckCardName` in `cardControl.ts` on those
 * three, and text the surface owns on the two that are not buttons (`TableView` writes its
 * own `sr-only` beside the badge, in a cell, where it is really read).
 *
 * Adding a mark here means asking which of those two says it in words.
 */
import { Crown } from "lucide-react";
import { CountTag } from "@/components/CountTag";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { tagColorCss, tagFgCss } from "./tagColors";

/**
 * The one tag a card wears, as an 8px chip in its own colour with the name one hover away.
 *
 * A dot rather than a word: a tag is a mark the reader put there and already knows, and a
 * 224px column has no room for a second label beside a card's name.
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
      aria-hidden="true"
      title={name}
      style={{ backgroundColor: tagColorCss(color) }}
      className={cn("size-2 shrink-0 rounded-[2px] shadow-[0_0_0_1px_var(--color-bg)]", className)}
    />
  );
}

/**
 * The copy count as a **filled tag in the card's own tag colour** — the deck stack's mark, and
 * the one place the tag and the quantity are drawn as a single object.
 *
 * ## Why the two were merged
 *
 * The stack draws whole card faces, and the only part of a collapsed one the reader sees is a
 * 34px strip. Two separate marks in it — an 8px dot and a grey count chip — spend that strip
 * twice to say two things a reader takes in as one ("three of these, and they are my ramp").
 * So the count is *printed on* the tag: one object, one glance, and the strip keeps room for
 * the printed name underneath it.
 *
 * **An untagged card is grey** — {@link CountTag}'s own `NEUTRAL_COUNT_PAINT`, never the gold a
 * missing token falls to. A filled mark has to be some colour, and if the untagged one were gold
 * then gold would stop being something a tag says. This is the one caller that draws the
 * distinction, which is why it passes `paint` for a tag and nothing at all without one.
 *
 * **The box is {@link CountTag}'s and no longer this file's** — the slant, the height, the mono
 * face, the `aria-hidden` and the number-with-no-`×`. The search wall makes the same statement
 * about a different quantity (how many printings a collapsed tile stands for) and the two have to
 * be one object. What stays here is what makes this one a *tag*: the colour it is filled with,
 * the sentence naming both facts, and the z-index below.
 *
 * {@link TagDot} is untouched and is still what the table, the text columns and the categories
 * panel draw — a row has a column for the count and does not need the two folded together.
 */
export function QuantityTag({
  quantity,
  name,
  color,
  className,
}: {
  quantity: number;
  /** The tag's name, or `null` for an untagged card. `deck_cards` answers `tagId`, `tagName`
   *  and `tagColor` as a set — all three `null` together — so this decides both. */
  name: string | null;
  /** The stored palette token, never a CSS colour — see `tagColors.ts`. */
  color: string | null;
  className?: string;
}) {
  return (
    <CountTag
      count={quantity}
      // Both facts, because the count alone would make the colour a riddle and the name alone
      // would make the number one. The words themselves are in `deckCardName`, which is the
      // only text inside a labelled button anyone hears.
      title={name === null ? `${quantity} in this pile` : `${name} · ${quantity} in this pile`}
      // Nothing for an untagged card, which is how it lands on the neutral grey — see above.
      paint={name === null ? undefined : { css: tagColorCss(color), fg: tagFgCss(color) }}
      className={cn(
        // **The z-index is load-bearing and `relative` alone was not enough.** This tag has to
        // cover the Game Changer banner tucked 10px under its slanted tail, and the obvious
        // trick — leave the banner static and make this positioned — does not work on flex
        // items: they paint in order-modified document order, so the later sibling won. The
        // lowest rung on the scale, and `layers.ts` has the measurement.
        "relative",
        LAYER.overlappingMark,
        className,
      )}
    />
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
      aria-hidden="true"
      title="Game changer"
      className={cn(
        "shrink-0 rounded-[2px] border border-pie-gold px-0.5 font-mono text-[0.5625rem]",
        "leading-3 text-pie-gold",
        className,
      )}
    >
      GC
    </span>
  );
}

/**
 * The same fact as a **stamped gold banner**, for the one surface with room to spell it out.
 *
 * `GC` is what a 150px grid tile and a table row can afford; a 210px card face in the stack can
 * carry the words, and it should — two letters are a code the reader has to have learnt, and
 * this is the surface a new reader meets the concept on. The four separations
 * {@link RuleBreakMark} must keep are all still kept, which is the only thing that made
 * spelling it out safe: the **words** differ (`Game Changer` against `RULE BREAK`), the
 * **colour** differs (the gold stamp against destructive), the **place** differs (tucked into
 * the title strip on the left against the top-right corner), and only a rule break changes the
 * card's own **edge**.
 *
 * ## The two details that are not decoration
 *
 * **It is deliberately not positioned, and that is no longer what decides the paint order.**
 * It sits 10px under {@link QuantityTag}'s slanted tail, and the tag has to be the one on top.
 * The first attempt did it by leaving this static and marking the tag `relative`, on the rule
 * that a positioned element paints above a static sibling — **which is false for flex items**,
 * as the shipped window then demonstrated. `LAYER.overlappingMark` on the tag is the answer;
 * this staying static is now only tidiness.
 *
 * What it still buys is the fold — the dark seam that makes the ribbon read as folded rather
 * than printed. It is a **background layer** rather than an absolutely positioned child, which
 * costs nothing and means this element never has to be a containing block for anything.
 *
 * The lettering is `font-heading` at 8px, which is the one place Cinzel goes under the 18px its
 * brief sets. A seal is the exception the brief is about the absence of: two fixed words, never
 * body text, never a string that can grow — and the serif is what makes it read as *stamped
 * into* the metal rather than typed on it.
 */
export function GameChangerBanner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      title="Game changer"
      style={{
        // The ribbon's forked tail. The notch is cut into the *right* edge, so the banner
        // points away from the tag it emerges from rather than back into it.
        clipPath: "polygon(0 0, 100% 0, calc(100% - 10px) 50%, 100% 100%, 0 100%)",
        backgroundImage: "linear-gradient(90deg, rgba(0,0,0,0.30), rgba(0,0,0,0.05))",
        backgroundSize: "5px 100%",
        backgroundPosition: "right 9px top",
        backgroundRepeat: "no-repeat",
      }}
      className={cn(
        "-ml-2.5 mt-1 flex h-3 flex-none items-center gap-1 bg-pie-gold-deep pl-3.5 pr-[21px]",
        "text-accent-fg shadow-[0_1px_5px_rgba(0,0,0,0.45)]",
        className,
      )}
    >
      <Crown className="block size-[9px] shrink-0" strokeWidth={2.5} aria-hidden="true" />
      <span
        className={cn(
          "font-heading text-[0.5rem] leading-none font-semibold tracking-[0.06em] whitespace-nowrap",
          "[text-shadow:0_1px_0_rgba(255,255,255,0.25)]",
        )}
      >
        Game Changer
      </span>
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
      aria-hidden="true"
      title={text}
      className={cn(
        "rounded-[3px] border border-destructive/50 bg-bg/85 px-1 py-px",
        "font-mono text-[0.5625rem] text-destructive",
        className,
      )}
    >
      RULE BREAK
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
