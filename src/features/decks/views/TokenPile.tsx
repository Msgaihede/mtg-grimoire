/**
 * The deck's tokens and emblems drawn as a pile **inside** the four views (issue #507) — the same
 * `useDeckTokens` answer the band at the foot of the editor draws, a second time, where the cards
 * that make them are.
 *
 * ## Drawn with the deck's own parts, so it cannot drift from them
 *
 * It was a parallel drawing — a heading of its own, a bare 5:7 picture with a `CountTag` laid on
 * it, geometry of its own — and the reader asked for the token stack to "look and function like
 * the other stack", with "our regular deck components". So it is those components, fed a token:
 * the heading is `GroupHeader` (the name, the pill, the price), each card is `DeckCardFace` with
 * `CardChin` under it — the same grey quantity tag top-left, the same plan's mark top-right, the
 * printed frame under the picture, the finish and the price in the foot — and the Stacks drawing
 * is the deck stack's own arithmetic (`stackHeight`, `stackCollapsedMargin`, `useFlipThrough`) on
 * the deck stack's own card body (`STACKED_CARD_BODY`, `stackedCardShadow`). A token card with a
 * chin *is* a deck card's height, so the pile needs no sums of its own. Two small adapters are the
 * whole of the join: {@link tokenFaceFacts} (a token as the face reads one) and
 * {@link tokenPileHeading} (the pile as the heading reads one).
 *
 * ## A token is not a deck row, and nothing here may pretend it is
 *
 * Being *drawn* as a deck card is not being one. It is not a `deck_cards` row, so no deck write
 * may reach it: **no drag source, no drop target, no deck card menu, no card modal, no selection
 * ring, and it is not in `StackView`'s arrow walk.** None of `cardControl.tsx`'s per-card spreads
 * are used here — not `deckCardProps`, not `deckCardBodyProps`, not `deckCardMenuProps` — because
 * each one of them is a promise to some listener that the element is a deck card, and every one
 * of those listeners would then act on a row that does not exist. What a token *can* be asked is
 * the band's two questions: how many to bring (the stepper) and which picture (a press on it
 * opens the one art picker the editor mounts). The **pile** may be moved along the rail, by the
 * grip the caller hands {@link TokenStackPile} — the cards in it never are.
 *
 * **It is appended in the view layer and never enters `deck.cards` or `buildGroups`**, which is
 * what makes "never counted" structural rather than remembered: no deck pile's total, no ledger
 * figure, no stat and no validation rule can see a row that was never in the list they read.
 * **The pile's own heading does carry figures** — the copies across the pile in the count pill,
 * and a price summed by `grouping.ts`' `totals` rule — and those two numbers are the tokens' and
 * go nowhere else: they are never added to the deck's size, the ledger's price or any other
 * pile's heading. A token's price is summed in exactly one place, this heading.
 *
 * ## One name per control, and the subtitle is in every one
 *
 * A token's name does not identify it (`DeckTokensPanel.tsx`'s header has the corpus figures —
 * `Wurmcoil Engine` alone puts two `Wurm`s on one wall), so every control here spells its own
 * accessible name through {@link tokenControlName}, the band's `tileName` rule: the subtitle folded
 * in, never assembled from two flex children that would compute to `"Wurm3/3"`.
 */
import { useCallback, useId, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ImageIcon } from "lucide-react";
import { CardChin } from "@/components/CardChin";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { atLeast, cardScaleVars } from "@/lib/cardZoom";
import { playedFinish } from "@/lib/finish";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import type { Currency } from "@/lib/marketplace";
import { PRESS, stackCard } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { theoryMatchLabel } from "../CardMarks";
import {
  STACK_LIFTED_MARGIN,
  STACK_OPEN_ATTR,
  STACKED_CARD_BODY,
  stackCardWidth,
  stackCollapsedMargin,
  stackedCardShadow,
  stackHeight,
  useFlipThrough,
} from "../CardStack";
import { REVEALED_ON_CARD, revealedWhenOpen } from "../cardControl";
import { tokenCountWords } from "../CountPill";
import { DeckCardFace, type DeckCardFaceFacts } from "../DeckCardFace";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import type { DeckTokenView } from "../deckTokens";
import type { TheoryMark } from "../theoryMatch";
import { GroupHeader, type GroupHeading } from "./GroupHeader";

/** What a view is handed to draw the pile — the band's own answer, never a copy of it. */
export interface TokenPile {
  /** What the pile draws, in `deckTokenViews` order — never a dismissed token. */
  tokens: readonly DeckTokenView[];
  setQuantity: (oracleId: string, quantity: number) => void;
  /** Open the one art picker the editor mounts, on this token. */
  pickArt: (oracleId: string) => void;
  /** The deck's stored rail index — `decks.token_rail_index`; `-1` is last. */
  railIndex: number;
  /** Move the pile to rail slot `index` (`-1` = last). Absent: the pile draws no grip. */
  moveTo?: (index: number) => void;
  /** The plan's mark for one token, or `null`. Absent: no marks (no plan, or on the plan). */
  theoryMark?: (view: DeckTokenView) => TheoryMark | null;
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

/**
 * A token as `DeckCardFace` reads a card — the narrow `DeckCardFaceFacts`, never a `DeckCard`.
 *
 * Each constant is a thing a token does not have rather than a guess at one: **no mana cost**
 * (the frame's cost slot draws nothing), **no review state** (the resolver named a printing the
 * corpus holds, so the picture is asked for), **no label** (the quantity tag is grey, which is
 * `QuantityTag`'s own unlabelled colour) and **no crown** (a token is never a game changer).
 *
 * `finish: null` is `DeckFinish`'s *not said*, which is exactly a token's state — nobody has
 * stated a finish for it — so `DeckCardFace`'s `playedFinish` falls to the printing's sole finish
 * the way it does for a deck card, and a foil-only token printing still wears the sheen.
 * `imageUris` is the resolved printing's map, passed through: the face picks its own variant
 * (`DECK_CARD_VARIANT`) off it on the web and the phone, as it does for every deck card.
 */
export function tokenFaceFacts(view: DeckTokenView): DeckCardFaceFacts {
  return {
    cardId: view.printingId,
    needsReview: null,
    imageUris: view.imageUris,
    finish: null,
    finishes: view.finishes,
    name: view.name,
    manaCost: null,
    typeLine: view.typeLine,
    quantity: view.quantity,
    labelName: null,
    labelColor: null,
    gameChanger: false,
  };
}

/**
 * The pile as `GroupHeader` reads a group: `Tokens & Emblems`, the **copies** across the pile, and
 * what they cost.
 *
 * **The price is `grouping.ts`' `totals` rule, restated rather than imported** (that function is
 * module-private and takes `DeckCard`s): sum `unitPrice × quantity` over the tokens that are
 * priced, leave an unpriced one out rather than valuing it at anything, and answer `null` only
 * when **none** is priced — so the heading draws an em dash for a pile nothing prices and a figure
 * for a pile something does. A token zeroed on the stepper is still a priced printing and adds
 * nothing, exactly as a zero-copy deck row would. Keep the two in step if either moves.
 *
 * `isActive: true` and `kind: null`, because the pile is neither switched off nor a rules zone —
 * it is not in the deck at all — so it draws no `INACTIVE`, no `RULE` and no wash.
 */
export function tokenPileHeading(tokens: readonly DeckTokenView[]): GroupHeading {
  let count = 0;
  let price = 0;
  let priced = false;
  for (const view of tokens) {
    count += view.quantity;
    if (view.unitPrice !== null) {
      price += view.unitPrice * view.quantity;
      priced = true;
    }
  }
  return {
    name: TOKENS_HEADING,
    count,
    totalPrice: priced ? price : null,
    isActive: true,
    kind: null,
  };
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
 * The Stacks view's pile — in the rail, drawn with the deck stack's own geometry and its hover
 * flip-through (`CardStack`'s `useFlipThrough`, shared rather than copied, so the dwell and the
 * close delay are one pair of numbers on the desk).
 *
 * The box is the rail's width and carries `StackGroup`'s own `p-1.5` and transparent hairline, so
 * a token card is exactly `stackCardWidth(zoom)` wide, like every card above it — and, with the
 * chin under it, exactly `stackCardHeight(zoom)` tall, so the list is `stackHeight` of the count
 * and the pile and a deck pile of the same count are one height.
 *
 * **`handle` and `sourceRef` are the caller's, and they are how the pile moves along the rail.**
 * `handle` is drawn in `GroupHeader`'s own grip slot, before the name on the name's line, where a
 * category's `CategoryGrip` goes; `sourceRef` goes on the heading's wrapper `<div>` — the element
 * a category's `attachSource` goes on — so what travels under the pointer is the pile's name and
 * its figures rather than a ghost of the glyph. Neither is a card: the tokens in the pile are no
 * drag source, and absent both, the pile is exactly as still as it always was.
 */
export function TokenStackPile({
  pile,
  zoom,
  handle,
  sourceRef,
}: {
  pile: TokenPile;
  zoom: number;
  handle?: ReactNode;
  sourceRef?: (node: HTMLElement | null) => void | (() => void);
}) {
  const headingId = useId();
  // One value app-wide, read here rather than threaded down from `StackView` — the heading's
  // total and every chin's price are written in it.
  const { marketplace } = useMarketplace();
  const { openIndex, arm, openNow, release } = useFlipThrough();
  const reduced = useReducedMotion();
  const open = openIndex;

  return (
    <div
      {...pileRootProps(headingId)}
      className="relative rounded-lg border border-transparent p-1.5"
    >
      <div ref={sourceRef}>
        <GroupHeader
          group={tokenPileHeading(pile.tokens)}
          marketplace={marketplace}
          layout="stacked"
          id={headingId}
          handle={handle}
          words={tokenCountWords}
          className="px-1 pb-1.5"
        />
      </div>
      <ul
        aria-label={TOKENS_HEADING}
        onPointerLeave={release}
        style={{ height: stackHeight(pile.tokens.length, zoom) }}
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
            animate={{
              marginBottom: index === open ? STACK_LIFTED_MARGIN : stackCollapsedMargin(zoom),
            }}
            // `marginBottom` is not among the keys `MotionConfig reducedMotion="user"` reduces, so
            // the opt-out is this component's own — `CardStack`'s `STILL`, for its reason.
            transition={reduced ? { duration: 0 } : stackCard}
            // The deck stack's card body, class for class — `border-border` because a token has
            // no rule to break, and no ring because a token is never picked.
            className={cn(STACKED_CARD_BODY, "border-border", stackedCardShadow(index === open))}
          >
            <TokenFace
              view={view}
              pile={pile}
              width={stackCardWidth(zoom)}
              zoom={zoom}
              currency={marketplace.currency}
            />
            {/* The stacked card's controls column, at its offset: `top-9` clears the 27px title
                bar the quantity tag and the plan's mark are in. Over the card and taking no height,
                so the list is still `stackHeight` of the count. */}
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
 * A token as the deck's card: `DeckCardFace` inside the press that opens the art picker, and
 * `CardChin` under it. Shared by Stacks and Grid, whose boxes differ and whose card does not.
 *
 * **The face is the deck card's, marks and all** — the grey `QuantityTag` top-left (a token wears
 * no label) and, where the pile is given a plan, `TheoryMatchMark` top-right. Both are
 * `aria-hidden` by their own components' rule, so the words are this button's: the copies reach a
 * screen reader through the stepper beside it, and the plan's sentence is folded into the name —
 * `theoryMatchLabel`, the same words the mark's tooltip says, as `deckCardName` folds them for a
 * deck card.
 *
 * **The chin is a sibling of the button, never a child**, for `CardChin`'s own reason: everything
 * in it is a fact (the set, the number, the finish, what one copy costs) and a button's
 * `aria-label` would swallow it. `seam="card"` because this sits in the stacked card's bordered
 * body, and `tone` is left at its default because a token has no rule to break.
 */
function TokenFace({
  view,
  pile,
  width,
  zoom,
  currency,
}: {
  view: DeckTokenView;
  pile: TokenPile;
  /** How wide the card is drawn — the face's height follows by `cardFaceHeight`. */
  width: number;
  /** The chin's height, and nothing else; everything *on* the card reads `--mark-scale`. */
  zoom: number;
  /** How the chin writes the printing's one unit price. */
  currency: Currency;
}) {
  const tip = useTooltip();
  const press = useCallback(() => pile.pickArt(view.oracleId), [pile, view.oracleId]);
  const mark = pile.theoryMark?.(view) ?? null;
  const name = tokenControlName("Change the art for", view);
  return (
    <>
      <button
        type="button"
        onClick={press}
        aria-label={
          mark === null
            ? name
            : `${name}, ${theoryMatchLabel(mark.tier, mark.delta).toLowerCase()}`
        }
        // What separates two same-named tokens, for a pointer: the subtitle, under the hand. The
        // name already carries it, so this describes nothing further.
        {...tip(view.subtitle ?? undefined, { describes: false })}
        // Inset, for the stacked card's reason: the button *is* the card face, so an outline
        // standing off it would be drawn over the chin and read as a thicker card.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        <DeckCardFace
          card={tokenFaceFacts(view)}
          width={width}
          ruleBreakText={null}
          theoryMark={mark}
          landedKey={undefined}
        />
      </button>
      <CardChin
        zoom={zoom}
        rarity={view.rarity}
        setCode={view.setCode ?? ""}
        collectorNumber={view.collectorNumber ?? ""}
        // The code is what fits; the set's name is one hover away, exactly as on a deck card.
        printingTitle={view.setName === null ? null : `${view.setName} · #${view.collectorNumber}`}
        // `tokenFaceFacts`' own answer — nothing stated, so the printing's sole finish — so the
        // sheen on the face and the word in the foot cannot disagree.
        finish={playedFinish(null, view.finishes)}
        money={formatPrice(view.unitPrice, currency)}
        seam="card"
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/*  Grid                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The Grid view's pile — a trailing group after every other group, the tiles at the wall's own
 * width for the zoom (`tileWidth`, which is `GridView`'s to know) and its gutter. Each tile is
 * the deck tile's card — {@link TokenFace} in the stacked card's body at its resting shadow — so a
 * token and a deck card on one wall are one object.
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
  const { marketplace } = useMarketplace();
  return (
    <div {...pileRootProps(headingId)} className="relative rounded-md">
      <GroupHeader
        group={tokenPileHeading(pile.tokens)}
        marketplace={marketplace}
        layout="tight"
        id={headingId}
        words={tokenCountWords}
        className="px-0.5 pb-1.5"
      />
      <ul
        aria-label={TOKENS_HEADING}
        style={{ gap: atLeast(gap, zoom) }}
        className="flex flex-wrap"
      >
        {pile.tokens.map((view) => (
          <li
            key={view.oracleId}
            style={{ width: tileWidth, ...cardScaleVars(zoom) }}
            // `group` is the one thing here that is not the stack's, for `GridView`'s tile's
            // reason: nothing overlaps a tile, so the pointer is the honest question and
            // `REVEALED_ON_CARD` hangs off it. The resting shadow, since a tile is never fanned.
            className={cn("group", STACKED_CARD_BODY, "border-border", stackedCardShadow(false))}
          >
            <TokenFace
              view={view}
              pile={pile}
              width={tileWidth}
              zoom={zoom}
              currency={marketplace.currency}
            />
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
  const { marketplace } = useMarketplace();
  return (
    <div {...pileRootProps(headingId)} className="relative rounded-md">
      <GroupHeader
        group={tokenPileHeading(pile.tokens)}
        marketplace={marketplace}
        layout="spread"
        id={headingId}
        words={tokenCountWords}
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
  const { marketplace } = useMarketplace();
  return (
    <div {...pileRootProps(headingId)} className="relative mt-4 rounded-md">
      <GroupHeader
        group={tokenPileHeading(pile.tokens)}
        marketplace={marketplace}
        layout="spread"
        id={headingId}
        words={tokenCountWords}
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
