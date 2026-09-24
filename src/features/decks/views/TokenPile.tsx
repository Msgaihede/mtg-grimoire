/**
 * The deck's tokens and emblems drawn as a pile **inside** the four views (issue #507) — the same
 * `useDeckTokens` answer the band at the foot of the editor draws, a second time, where the cards
 * that make them are.
 *
 * ## A token is not a deck row, and nothing here may pretend it is
 *
 * It is not a `deck_cards` row, so no deck write may reach it: **no drag source, no drop target,
 * no deck card menu, no card modal, no selection ring, and it is not in `StackView`'s arrow walk.**
 * None of `cardControl.tsx`'s per-card spreads are used here — not `deckCardProps`, not
 * `deckCardBodyProps`, not `deckCardMenuProps` — because each one of them is a promise to some
 * listener that the element is a deck card, and every one of those listeners would then act on a
 * row that does not exist. What a token *can* be asked is the band's two questions: how many to
 * bring (the stepper) and which picture (a press on it opens the one art picker the editor mounts).
 *
 * **It is appended in the view layer and never enters `deck.cards` or `buildGroups`**, which is
 * what makes "never counted" structural rather than remembered: no pile total, no heading count,
 * no ledger figure, no stat and no validation rule can see a row that was never in the list they
 * read. The pile's heading carries no card count and no price for the same reason — its one
 * figure is {@link TokenCountPill}, the distinct tokens to bring.
 *
 * ## One name per control, and the subtitle is in every one
 *
 * A token's name does not identify it (`DeckTokensPanel.tsx`'s header has the corpus figures —
 * `Wurmcoil Engine` alone puts two `Wurm`s on one wall), so every control here spells its own
 * accessible name through {@link tokenControlName}, the band's `tileName` rule: the subtitle folded
 * in, never assembled from two flex children that would compute to `"Wurm3/3"`.
 */
import { useCallback, useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ImageIcon } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { CountTag } from "@/components/CountTag";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { atLeast, cardScaleVars } from "@/lib/cardZoom";
import { plural } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS, stackCard } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  STACK_LIFTED_MARGIN,
  STACK_OPEN_ATTR,
  stackAdvance,
  stackCardWidth,
  useFlipThrough,
} from "../CardStack";
import { REVEALED_ON_CARD, revealedWhenOpen } from "../cardControl";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import type { DeckTokenView } from "../deckTokens";
import { TokenCountPill } from "../TokenCountPill";

/** What a view is handed to draw the pile — the band's own answer, never a copy of it. */
export interface TokenPile {
  /** What the pile draws, in `deckTokenViews` order — never a dismissed token. */
  tokens: readonly DeckTokenView[];
  setQuantity: (oracleId: string, quantity: number) => void;
  /** Open the one art picker the editor mounts, on this token. */
  pickArt: (oracleId: string) => void;
}

/**
 * How a test — or a live pass — finds the pile's root in any of the four views. An attribute
 * rather than a role, for `STACK_ATTR`'s reason: where the pile is drawn is a layout.
 */
export const TOKEN_PILE_ATTR = "data-token-pile";

/** Whether a view has anything to draw — absent and empty are one answer, and both leave the view
 *  exactly as it was before the pile existed. */
export function hasTokenPile(pile: TokenPile | undefined): pile is TokenPile {
  return pile !== undefined && pile.tokens.length > 0;
}

/**
 * One token's name folded into a verb, for a control's accessible name — the band's `tileName`,
 * spelled once for the four views.
 *
 * **The subtitle is in every one of them**, which is the whole of what keeps two `Wurm`s apart
 * for a reader who cannot see them.
 */
export function tokenControlName(verb: string, view: DeckTokenView): string {
  return view.subtitle === null
    ? `${verb} ${view.name}`
    : `${verb} ${view.name}, ${view.subtitle}`;
}

/** Why this token is in the pile — the deck cards that make it, or the reader's own press. */
export function tokenMadeBy(view: DeckTokenView): string {
  return view.sources.length > 0
    ? `From ${view.sources.map((source) => source.name).join(", ")}`
    : "Added by hand";
}

/** The copies to bring, in words — what the quantity mark's tooltip says. */
function copiesToBring(view: DeckTokenView): string {
  return `${plural(view.quantity, "copy", "copies")} to bring`;
}

/**
 * The pile's heading: `Tokens & Emblems` and the pill, in a pile heading's own type
 * (`GroupHeader`'s name line) — **but not a `GroupHeader`**, because that component states a card
 * count and a total price and a token pile has neither. No grip, no rename, no menu: it is not a
 * category.
 */
function TokenPileHeading({
  id,
  count,
  className,
}: {
  id: string;
  count: number;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span id={id} className="min-w-0 truncate text-[0.8125rem] font-medium text-text">
        {TOKENS_HEADING}
      </span>
      <TokenCountPill count={count} />
    </div>
  );
}

/**
 * The pile's root props, shared by the four drawings.
 *
 * **`role="group"`, never a `<section>`'s implicit region**: the band is already a region named
 * `Tokens & Emblems`, and a second region of the same name on the same screen is two landmarks a
 * reader cannot tell apart. A group is named by the same heading without being a landmark.
 */
function pileRootProps(headingId: string) {
  return {
    role: "group" as const,
    "aria-labelledby": headingId,
    [TOKEN_PILE_ATTR]: "",
  };
}

/* ------------------------------------------------------------------------------------------ */
/*  Stacks                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * A token card's picture height at this zoom — `CardArt`'s own 5:7 box at the stacked card's
 * width. A token card has no chin (it has no rarity, no set line and no price to put in one), so
 * this *is* the card, and the stack's arithmetic runs on it exactly as `CardStack`'s runs on
 * `stackCardHeight`.
 */
export function tokenStackCardHeight(zoom: number): number {
  return Math.round((stackCardWidth(zoom) * 7) / 5);
}

/** The pile's list height for `count` tokens — `stackHeight`'s formula over the token card: a
 *  function of the count and the zoom and never of which card is open. */
export function tokenStackHeight(count: number, zoom: number): number {
  if (count === 0) return 0;
  return stackAdvance(zoom) * (count - 1) + tokenStackCardHeight(zoom) + STACK_LIFTED_MARGIN;
}

/**
 * The Stacks view's pile — the **last** item of the rail, drawn with the stacked card's own
 * geometry and its hover flip-through (`CardStack`'s `useFlipThrough`, shared rather than copied,
 * so the dwell and the close delay are one pair of numbers on the desk).
 *
 * The box is the rail's width and carries `StackGroup`'s own `p-1.5` and transparent hairline, so
 * a token card is exactly `stackCardWidth(zoom)` wide, like every card above it.
 */
export function TokenStackPile({ pile, zoom }: { pile: TokenPile; zoom: number }) {
  const headingId = useId();
  const { openIndex, arm, openNow, release } = useFlipThrough();
  const reduced = useReducedMotion();
  const cardHeight = tokenStackCardHeight(zoom);
  const collapsed = stackAdvance(zoom) - cardHeight;
  const open = openIndex;

  return (
    <div
      {...pileRootProps(headingId)}
      className="relative rounded-lg border border-transparent p-1.5"
    >
      <TokenPileHeading id={headingId} count={pile.tokens.length} className="px-1 pb-1.5" />
      <ul
        aria-label={TOKENS_HEADING}
        onPointerLeave={release}
        style={{ height: tokenStackHeight(pile.tokens.length, zoom) }}
        className={cn("relative block overflow-visible", open !== null && LAYER.raised)}
      >
        {pile.tokens.map((view, index) => (
          <motion.li
            key={view.oracleId}
            onPointerEnter={() => arm(index)}
            onFocus={() => openNow(index)}
            onBlur={release}
            {...(index === open ? { [STACK_OPEN_ATTR]: "" } : {})}
            style={cardScaleVars(zoom)}
            initial={false}
            animate={{ marginBottom: index === open ? STACK_LIFTED_MARGIN : collapsed }}
            transition={reduced ? { duration: 0 } : stackCard}
            className={cn(
              "relative block rounded-lg",
              index === open
                ? "shadow-[0_25px_50px_-12px_rgb(0_0_0/0.55)]"
                : "shadow-[0_10px_15px_-3px_rgb(0_0_0/0.45),0_4px_6px_-4px_rgb(0_0_0/0.45)]",
            )}
          >
            <TokenFace view={view} pile={pile} />
            <span
              className={cn(
                "absolute top-9 right-1.5 flex flex-col items-end",
                revealedWhenOpen(index === open),
              )}
            >
              <QuantityStepper
                size="card"
                orientation="vertical"
                tone="art"
                focus="inset"
                value={view.quantity}
                min={0}
                label={tokenControlName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(view.oracleId, next)}
              />
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A token's picture as the press that opens the art picker, with its copy count laid on the
 * top-left corner the way a deck card's `QuantityTag` is. Shared by Stacks and Grid.
 *
 * The count is `CountTag` — grey, since a token wears no label — and it is `aria-hidden` by that
 * component's rule, so the number reaches a screen reader through the stepper beside it.
 */
function TokenFace({ view, pile }: { view: DeckTokenView; pile: TokenPile }) {
  const tip = useTooltip();
  const press = useCallback(() => pile.pickArt(view.oracleId), [pile, view.oracleId]);
  return (
    <>
      <button
        type="button"
        onClick={press}
        aria-label={tokenControlName("Change the art for", view)}
        // What separates two same-named tokens, for a pointer: the subtitle, under the hand. The
        // name already carries it, so this describes nothing further.
        {...tip(view.subtitle ?? undefined, { describes: false })}
        className={cn("block w-full cursor-pointer rounded-lg text-left", FOCUS_INSET)}
      >
        <CardArt
          cardId={view.printingId}
          imageUrl={view.imageUrl}
          name={view.name}
          loading="lazy"
        />
      </button>
      <CountTag
        count={view.quantity}
        title={copiesToBring(view)}
        className="absolute top-[calc(0.25rem*var(--mark-scale,1))] left-px"
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*  Grid                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The Grid view's pile — a trailing group after every other group, the tiles at the wall's own
 * width for the zoom (`tileWidth`, which is `GridView`'s to know) and its gutter.
 */
export function TokenGridPile({
  pile,
  zoom,
  tileWidth,
  gap,
}: {
  pile: TokenPile;
  zoom: number;
  tileWidth: number;
  /** The wall's gutter at 1× — scaled here through `atLeast`, as the wall's own is. */
  gap: number;
}) {
  const headingId = useId();
  return (
    <div {...pileRootProps(headingId)} className="relative rounded-md">
      <TokenPileHeading id={headingId} count={pile.tokens.length} className="px-0.5 pb-1.5" />
      <ul
        aria-label={TOKENS_HEADING}
        style={{ gap: atLeast(gap, zoom) }}
        className="flex flex-wrap"
      >
        {pile.tokens.map((view) => (
          <li
            key={view.oracleId}
            style={{ width: tileWidth, ...cardScaleVars(zoom) }}
            className="group relative block rounded-lg shadow-[0_10px_15px_-3px_rgb(0_0_0/0.45),0_4px_6px_-4px_rgb(0_0_0/0.45)]"
          >
            <TokenFace view={view} pile={pile} />
            <span
              className={cn("absolute top-9 right-1.5 flex flex-col items-end", REVEALED_ON_CARD)}
            >
              <QuantityStepper
                size="card"
                orientation="vertical"
                tone="art"
                focus="inset"
                value={view.quantity}
                min={0}
                label={tokenControlName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(view.oracleId, next)}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*  Text                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The Text view's pile — a trailing group of lines in `TextRow`'s grammar: a 22px line with the
 * quantity in the data face and the name, the subtitle dim after it. The line itself is the press
 * that opens the art picker; the stepper rides over its tail on hover, as a deck line's does.
 */
export function TokenTextPile({ pile }: { pile: TokenPile }) {
  const headingId = useId();
  return (
    <div {...pileRootProps(headingId)} className="relative rounded-md">
      <TokenPileHeading
        id={headingId}
        count={pile.tokens.length}
        className="border-b border-border px-1 pb-1"
      />
      <ul aria-label={TOKENS_HEADING}>
        {pile.tokens.map((view) => (
          <li key={view.oracleId} className="group relative rounded">
            <button
              type="button"
              onClick={() => pile.pickArt(view.oracleId)}
              aria-label={tokenControlName("Change the art for", view)}
              className={cn(
                "flex h-[22px] w-full cursor-pointer items-center gap-1.5 rounded px-1 text-xs",
                "transition-colors duration-150 hover:bg-surface motion-reduce:transition-none",
                FOCUS,
              )}
            >
              {/* The crown's gutter on a deck line — reserved here too, so the numbers of the two
                  groups sit in one column down the view. */}
              <span aria-hidden="true" className="w-2.5 shrink-0" />
              <span className="w-4 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-dim">
                {view.quantity}
              </span>
              <span className="min-w-0 shrink-0 truncate border-l-2 border-transparent pl-1.5 text-left">
                {view.name}
              </span>
              {view.subtitle !== null && (
                <span className="min-w-0 flex-1 truncate text-left text-[0.6875rem] text-dim">
                  {view.subtitle}
                </span>
              )}
            </button>
            <span
              className={cn(
                "absolute inset-y-0 right-1 flex items-center rounded bg-surface pl-1",
                REVEALED_ON_CARD,
              )}
            >
              <QuantityStepper
                size="xs"
                value={view.quantity}
                min={0}
                label={tokenControlName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(view.oracleId, next)}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*  Table                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * The Table view's pile — a trailing section under the table's bands, as a compact list rather
 * than more `VirtualTable` rows: its columns (price, owned, rarity, printing) are facts about a
 * deck card that a token does not have, and a row with six empty cells reads as a row that failed
 * to load. Four things per token: the stepper, the name over its subtitle, what makes it, and the
 * art press.
 */
export function TokenTablePile({ pile }: { pile: TokenPile }) {
  const headingId = useId();
  const tip = useTooltip();
  return (
    <div {...pileRootProps(headingId)} className="relative mt-4 rounded-md">
      <TokenPileHeading
        id={headingId}
        count={pile.tokens.length}
        className="border-b border-border px-2 pb-1"
      />
      <ul aria-label={TOKENS_HEADING} className="divide-y divide-border">
        {pile.tokens.map((view) => (
          <li
            key={view.oracleId}
            className="grid min-h-9 grid-cols-[6.5rem_minmax(12rem,3fr)_minmax(0,2fr)_auto] items-center gap-x-3 px-2 py-1 text-sm"
          >
            <span className="flex justify-center">
              <QuantityStepper
                size="xs"
                value={view.quantity}
                min={0}
                label={tokenControlName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(view.oracleId, next)}
              />
            </span>
            {/* Two paragraphs, never one line assembled from two — the band's rule. */}
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{view.name}</span>
              {view.subtitle !== null && (
                <span className="truncate text-xs text-dim">{view.subtitle}</span>
              )}
            </span>
            <span
              className="min-w-0 truncate text-xs text-dim"
              {...tip(tokenMadeBy(view), { whenClipped: true })}
            >
              {tokenMadeBy(view)}
            </span>
            <button
              type="button"
              onClick={() => pile.pickArt(view.oracleId)}
              aria-label={tokenControlName("Change the art for", view)}
              {...tip("Change the art", { describes: false })}
              className={cn(
                "grid size-7 place-items-center rounded-md border border-border text-dim hover:text-text",
                PRESS,
                FOCUS,
              )}
            >
              <ImageIcon aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
