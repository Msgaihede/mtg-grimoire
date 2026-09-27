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
 * the band's two questions: how many to bring (the stepper) and which printing (a press on it
 * opens the one printing picker the editor mounts, to swap **that entry**). The **pile** may be
 * moved along the rail, by the grip the caller hands {@link TokenStackPile} — the cards in it
 * never are.
 *
 * ## One card per entry, since token stacks PR 2
 *
 * A token has an **entry** per printing-and-finish the list holds (spec §4.2) — a foil and a
 * regular copy of one printing are two — and the pile draws one card per entry, so one token can
 * be two cards side by side. Everything here is addressed by the entry rather than by the token:
 * React keys are {@link DeckTokenView.entryKey} (an oracle id would be one key twice), the stepper
 * writes through the entry's address (`entryRef`), a press hands the editor the entry's view, and
 * the face, the chin and the compact drawings' finish mark all read the entry's own finish.
 *
 * **It is appended in the view layer and never enters `deck.cards` or `buildGroups`**, which is
 * what makes "never counted" structural rather than remembered: no deck pile's total, no ledger
 * figure, no stat and no validation rule can see a row that was never in the list they read.
 * **The pile's own heading does carry figures** — the copies across the pile in the count pill,
 * and a price summed by `grouping.ts`' `totals` rule — and those two numbers are the tokens' and
 * go nowhere else: they are never added to the deck's size, the ledger's price or any other
 * pile's heading. A token's price is summed in exactly one place, this heading.
 *
 * ## The counted tokens only, and a token the deck does not make is marked
 *
 * **The pile draws what the reader has counted** (managed tokens spec §3.2) — the editor hands it
 * `deckTokens.ts`' `pileTokens`, the band's list less every entry at 0 — so nothing here filters,
 * and the band is where a token at 0 is found and counted. **A token nothing in the deck makes is
 * drawn as a rule-break card is** (spec §3.5): the card's edge and its chin in the destructive
 * colour and `NOT MADE BY DECK` in the rule-break mark's corner on the two card drawings, and the
 * same words as a small destructive tag after the name on the two compact ones. And every card
 * carries **Remove printing** (spec §3.4), the one way to take a hand-added token off the deck.
 *
 * ## One name per control, and the subtitle is in every one
 *
 * A token's name does not identify it (`DeckTokensPanel.tsx`'s header has the corpus figures —
 * `Wurmcoil Engine` alone puts two `Wurm`s on one wall), so every control here spells its own
 * accessible name through `deckTokens.ts`' {@link tokenEntryName} — the helper the band calls too:
 * the subtitle folded in, never assembled from two flex children that would compute to
 * `"Wurm3/3"`. **And nor does a token identify an entry**, so the name carries the entry's
 * printing and finish too — one spelling, so one entry answers to one name on both surfaces.
 */
import { useCallback, useId, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ImageIcon, Trash2 } from "lucide-react";
import { CardChin } from "@/components/CardChin";
import {
  BUTTON_OVER_ART,
  QUANTITY_STEPPER_CARD_BOX,
  QUANTITY_STEPPER_CARD_ICON,
  QuantityStepper,
} from "@/components/QuantityStepper";
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
import { DeckFinishMark, theoryMatchLabel } from "../CardMarks";
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
import {
  entryRef,
  isHandAdded,
  NOT_MADE_BY_DECK,
  notMadeByDeckHint,
  tokenArtName,
  tokenEntryName,
  type DeckTokenView,
  type TokenEntryRef,
} from "../deckTokens";
import type { TheoryMark } from "../theoryMatch";
import { tokenDeckFinish } from "../tokenTheory";
import { GroupHeader, type GroupHeading } from "./GroupHeader";

/** What a view is handed to draw the pile — the band's own answer, never a copy of it. */
export interface TokenPile {
  /** What the pile draws, one view **per entry**, in `deckTokenViews` order — the entries the
   *  reader has counted (`pileTokens`), never one at 0. The pile filters nothing itself. */
  tokens: readonly DeckTokenView[];
  /** Step one entry — addressed by its token, printing and finish, never by the token alone, which
   *  a token with two entries would share between them. */
  setQuantity: (entry: TokenEntryRef, quantity: number) => void;
  /**
   * **Remove printing** — one stored entry, deleted (managed tokens spec §3.4). Drawn on the two
   * card drawings' controls, on every card that is a stored entry. Absent draws no button, which is
   * a host that has not wired the write — never a statement about the token.
   */
  remove?: (entry: TokenEntryRef) => void;
  /** Open the one printing picker the editor mounts, to swap this entry. The whole view, so the
   *  editor can hold its `entryKey` — the editor keeps the key, never the view. */
  pickArt: (view: DeckTokenView) => void;
  /** The drawn index: the in-flight move, else the stored column (`-1` is last). */
  railIndex: number;
  /** Move the pile to rail slot `index` (`-1` = last). Absent: the pile draws no grip. */
  moveTo?: (index: number) => void;
  /** The plan's mark for one entry, or `null`. Absent: no marks (no plan, or on the plan). */
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
 * **`finish` is the entry's own**, spelled as a deck row's is (`tokenDeckFinish`: the regular copy
 * is `null`) — so a foil entry sheens and the regular copy of the same printing does not, which is
 * exactly a deck card's arrangement. It was a flat `null` until token stacks PR 2, when a token
 * stated no finish at all; a regular entry still arrives as `null`, so `playedFinish` still falls
 * to the printing's sole finish and a foil-only printing still wears the sheen.
 * `imageUris` is the entry's printing's map, passed through: the face picks its own variant
 * (`DECK_CARD_VARIANT`) off it on the web and the phone, as it does for every deck card.
 */
export function tokenFaceFacts(view: DeckTokenView): DeckCardFaceFacts {
  return {
    cardId: view.printingId,
    needsReview: null,
    imageUris: view.imageUris,
    finish: tokenDeckFinish(view),
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
 * An entry as `DeckFinishMark` reads a deck row — the entry's finish, the printing's finishes and
 * no treatment (a token row carries no promo types) — so the two compact drawings mark a foil
 * entry with the very glyph a deck line and a deck row draw, and never a second spelling of it.
 */
function entryFinishFacts(view: DeckTokenView) {
  return { finish: tokenDeckFinish(view), finishes: view.finishes, promoTypes: null };
}

/**
 * The card's own edge on the two card drawings — **the destructive colour for a token nothing in
 * the deck makes**, the rule-break card's own outline (managed tokens spec §3.5), and the neutral
 * hairline otherwise. The chin under the face takes the matching `tone`, because it paints over
 * the card's edge along its whole height and a neutral chin would put the wrong colour back
 * through the foot of a red card.
 */
function cardEdge(view: DeckTokenView): string {
  return isHandAdded(view) ? "border-destructive" : "border-border";
}

/**
 * **Remove printing on a card** — the trash glyph in the controls column under the stepper, the
 * same 36px box the stepper's own buttons are (`QUANTITY_STEPPER_CARD_BOX`) and the same backing
 * over art, so the column reads as one set of controls rather than a stepper with a stray icon
 * beside it — the wishlist tile's pencil makes the same move. Named for its entry through
 * `tokenEntryName`, so a token's two entries are two presses; `Remove printing` is the pointer's
 * word. Drawn only on a stored entry — never an implicit one, which is not stored and has nothing
 * to delete — and only where the host wired the write.
 */
function CardRemove({ view, pile }: { view: DeckTokenView; pile: TokenPile }) {
  const tip = useTooltip();
  const remove = pile.remove;
  if (remove === undefined || view.implicit) return null;
  return (
    <button
      type="button"
      onClick={() => remove(entryRef(view))}
      aria-label={tokenEntryName("Remove", view)}
      {...tip("Remove printing", { describes: false })}
      className={cn(
        "grid shrink-0 place-items-center border border-border",
        QUANTITY_STEPPER_CARD_BOX,
        BUTTON_OVER_ART,
        "hover:text-destructive",
        PRESS,
        FOCUS_INSET,
      )}
    >
      <Trash2 aria-hidden="true" className={QUANTITY_STEPPER_CARD_ICON} />
    </button>
  );
}

/**
 * `NOT MADE BY DECK` on a line of the two compact drawings — **a small destructive tag after the
 * name** (managed tokens spec §3.5), because a 22px line and a table row have no corner to put a
 * badge in and no card edge to colour. The words are the badge's and the tag says them outright,
 * so the pointer's sentence is all it adds; `aria-hidden` for the badge's reason — the line's
 * press carries the words in its own name (`tokenArtName`).
 */
function NotMadeByDeckTag({ view }: { view: DeckTokenView }) {
  const tip = useTooltip();
  if (!isHandAdded(view)) return null;
  return (
    <span
      aria-hidden="true"
      {...tip(notMadeByDeckHint(view.name), { describes: false })}
      className="shrink-0 whitespace-nowrap rounded-[3px] border border-destructive/50 px-1 font-mono text-[0.5625rem] leading-3 text-destructive"
    >
      {NOT_MADE_BY_DECK}
    </span>
  );
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
            key={view.entryKey}
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
            // The deck stack's card body, class for class — its edge the destructive colour for a
            // token the deck does not make ({@link cardEdge}), as a rule-break card's is, and no
            // ring because a token is never picked.
            className={cn(STACKED_CARD_BODY, cardEdge(view), stackedCardShadow(index === open))}
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
                so the list is still `stackHeight` of the count. `gap-1` is `DeckCardControls`'
                column's, so the stepper and Remove printing under it are one column of controls. */}
            <span
              className={cn(
                "absolute top-9 right-1.5 flex flex-col items-end gap-1",
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
                label={tokenEntryName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(entryRef(view), next)}
              />
              <CardRemove view={view} pile={pile} />
            </span>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One token entry as the deck's card: `DeckCardFace` inside the press that opens the printing
 * picker on this entry, and `CardChin` under it. Shared by Stacks and Grid, whose boxes differ
 * and whose card does not.
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
 * body, and its `tone` follows the card's edge ({@link cardEdge}): destructive for a token nothing
 * in the deck makes, whose face wears `NOT MADE BY DECK` in the rule-break mark's corner and whose
 * press says the same words in its name ({@link tokenArtName}) — a token never breaks a rule, so
 * the two never compete for the corner.
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
  const press = useCallback(() => pile.pickArt(view), [pile, view]);
  const mark = pile.theoryMark?.(view) ?? null;
  const name = tokenArtName(view);
  const handAdded = isHandAdded(view);
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
          // In the rule-break mark's corner and style, where a token has no rule to break.
          notMadeByDeck={handAdded ? view.name : null}
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
        // `tokenFaceFacts`' own answer — the entry's finish, the regular copy falling to the
        // printing's sole finish — so the sheen on the face and the word in the foot cannot
        // disagree, and a token's foil entry and its regular one say two different things.
        finish={playedFinish(tokenDeckFinish(view), view.finishes)}
        money={formatPrice(view.unitPrice, currency)}
        seam="card"
        // The card's own edge, carried down through the foot — see {@link cardEdge}.
        tone={handAdded ? "destructive" : "default"}
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
            key={view.entryKey}
            style={{ width: tileWidth, ...cardScaleVars(zoom) }}
            // `group` is the one thing here that is not the stack's, for `GridView`'s tile's
            // reason: nothing overlaps a tile, so the pointer is the honest question and
            // `REVEALED_ON_CARD` hangs off it. The resting shadow, since a tile is never fanned;
            // the edge is {@link cardEdge}'s, as on the stack.
            className={cn("group", STACKED_CARD_BODY, cardEdge(view), stackedCardShadow(false))}
          >
            <TokenFace
              view={view}
              pile={pile}
              width={tileWidth}
              zoom={zoom}
              currency={marketplace.currency}
            />
            <span
              className={cn(
                "absolute top-9 right-1.5 flex flex-col items-end gap-1",
                REVEALED_ON_CARD,
              )}
            >
              <QuantityStepper
                size="card"
                orientation="vertical"
                tone="art"
                focus="inset"
                value={view.quantity}
                min={0}
                label={tokenEntryName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(entryRef(view), next)}
              />
              <CardRemove view={view} pile={pile} />
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
 * The Text view's pile — a trailing group of lines in `TextRow`'s grammar: a 22px line per entry
 * with the quantity in the data face and the name, the subtitle dim after it and the entry's finish
 * mark in the tail. The line itself is the press that opens the printing picker on that entry; the
 * stepper rides over its tail on hover, as a deck line's does. A token nothing in the deck makes
 * carries `NOT MADE BY DECK` as a tag right after its name ({@link NotMadeByDeckTag}).
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
          <li key={view.entryKey} className="group relative rounded">
            <button
              type="button"
              onClick={() => pile.pickArt(view)}
              // The mark's words are in this name for a hand-added token, since the tag inside the
              // button is covered by it — an `aria-label` replaces its element's content.
              aria-label={tokenArtName(view)}
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
              <NotMadeByDeckTag view={view} />
              {view.subtitle !== null && (
                <span className="min-w-0 flex-1 truncate text-left text-[0.6875rem] text-dim">
                  {view.subtitle}
                </span>
              )}
              {/* The entry's finish, in the tail where a deck line draws its own — the one thing on
                  this line that tells a token's foil entry from its regular twin. Decoration: the
                  line is a button with an explicit `aria-label`, whose words already say it. */}
              <DeckFinishMark card={entryFinishFacts(view)} />
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
                label={tokenEntryName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(entryRef(view), next)}
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
 * to load. Four things per entry: the stepper, the name (with the entry's finish mark, and
 * `NOT MADE BY DECK` after it for a token the deck does not make) over its subtitle, what makes
 * it, and the press that opens the printing picker on that entry.
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
            key={view.entryKey}
            className="grid min-h-9 grid-cols-[6.5rem_minmax(12rem,3fr)_minmax(0,2fr)_auto] items-center gap-x-3 px-2 py-1 text-sm"
          >
            <span className="flex justify-center">
              <QuantityStepper
                size="xs"
                value={view.quantity}
                min={0}
                label={tokenEntryName("Quantity of", view)}
                onChange={(next) => pile.setQuantity(entryRef(view), next)}
              />
            </span>
            {/* Two paragraphs, never one line assembled from two — the band's rule. The finish
                mark beside the name is the deck row's own, and names itself (`role="img"`), so
                the name line is still one word and one mark rather than a phrase built of two. */}
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{view.name}</span>
                <NotMadeByDeckTag view={view} />
                <DeckFinishMark card={entryFinishFacts(view)} />
              </span>
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
              onClick={() => pile.pickArt(view)}
              aria-label={tokenArtName(view)}
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
