import type { ReactElement, ReactNode } from "react";
import { FinishMark } from "@/components/FinishMark";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { CHIN_RISE, chinHeight } from "@/lib/cardZoom";
import type { Finish } from "@/lib/finish";
import type { Treatment } from "@/lib/treatment";
import { cn } from "@/lib/utils";

/**
 * **What the chin says about the printing — one of two shapes, and never neither.**
 *
 * A union rather than four independent optionals, because independent optionals let
 * `<CardChin rarity={r} zoom={z} seam="art" />` type-check and then draw a bare `" · "` on a wall
 * of cards. The compiler asks the question instead: either the caller supplies the two halves of
 * the default line, or it supplies a line of its own.
 *
 * **{@link ChinPrinting.printingTitle} is required on the caller's arm, and that is the point of
 * writing it this way rather than as two loose props.** A caller that passes
 * `printing="Any printing"` while leaving the title at the set's name gets a hover reading
 * `Commander 2021 · #179` under a line that deliberately refuses to name that cardboard — the
 * exact defect `printing` exists to prevent, one layer down. Required, it is a question the
 * caller answered; optional, it is one they inherited.
 */
type ChinPrinting =
  | {
      /**
       * What this line says about the printing, in the caller's own words.
       *
       * The wishlist's "Any printing" and the search's "12 printings" are the live cases: a wish
       * for any printing is *drawn* as one particular one, and a caption naming that cardboard
       * would say the reader had asked for it.
       */
      printing: ReactNode;
      /**
       * The tooltip on the line — **required here**, because the honest answer for a line the
       * caller wrote is usually `null`: a wish for any printing has no set name to give, and the
       * one belonging to the printing it happens to be drawn as would contradict the words above
       * it.
       */
      printingTitle: string | null;
      setCode?: never;
      collectorNumber?: never;
    }
  | {
      printing?: never;
      /**
       * The tooltip on the printing line — the set's *name*, because `PF26` is not a word anybody
       * knows. `null` or omitted where the caller has none, which is an orphan: then the code
       * stands on its own rather than being annotated with a guess.
       *
       * No `whenClipped`: the line shows the set **code** and the tip says the set **name**, which
       * is a different string, so gating the panel on the code's own clip would gate it on
       * something the tip is not about.
       */
      printingTitle?: string | null;
      /** The default line's two halves — `SET · number`. Both, or neither and a {@link printing}. */
      setCode: string;
      collectorNumber: string;
    };

/**
 * **The card's foot, and the one definition of it.**
 *
 * Facts about the *printing* rather than about the list it is in, in the data face and one step
 * dimmer: rarity, which printing this is, its finish, and what one copy costs.
 *
 * ## Why this is a component
 *
 * Three surfaces drew a foot and each held its own numbers — 28px of 10px type on the deck's
 * stacks, 25px of 12px on the walls `CardGrid` draws, 20px of 9px on the deck's grid — and
 * only the first had the felt, the edges and the rise that make a foot read as part of the card
 * rather than as a caption under it. Three copies is how a shared look stops being shared. This is
 * the stack's, which is the one that was right, and `chinHeight` in `lib/cardZoom.ts` is its
 * height.
 *
 * ## It is a sibling of the card's button, never a child of it
 *
 * Everything here is a *fact* rather than a mark, so unlike the overlays on the art it is
 * genuinely announced instead of being swallowed by the button's `aria-label`. The price and the
 * printing had no reader at all while they were inside it.
 *
 * ## The rise, and why the edges are a prop
 *
 * `marginTop: -CHIN_RISE` rides the chin up so the face's clipped corners cover its square ones:
 * butted flush, two hairlines of background show through the gap.
 *
 * {@link seam} is the other half of that join, and it is not decoration. The chin's edges have to
 * be the *card's* edges, and the two hosts own their outline differently — see the prop.
 */
export function CardChin(
  props: ChinPrinting & {
    /** The gem, always drawn. `null` is a printing `cards` has forgotten, which the gem says. */
    rarity: string | null;
    /** The reader's zoom for this surface — the chin's height, and nothing else. Everything *in*
     *  it sizes itself off `--mark-scale`, which the card's own root publishes. */
    zoom: number;
    /**
     * The finish this copy **is**. `null` draws nothing, and so does `nonfoil` — that is
     * `FinishMark`'s own rule, and it is right: nonfoil is the finish a price is assumed to be,
     * and 61 % of the corpus has a foil version, so a mark on every plain card would be chrome.
     */
    finish?: Finish | null;
    /** What this copy is *called*, from `finishTreatments`. A named treatment replaces the
     *  finish's glyph and its word — a Surge Foil is not "a foil" — and outlives `nonfoil`,
     *  because serialized cardboard is serialized either way. */
    treatments?: readonly Treatment[];
    /** What one copy of this exact printing and finish costs. A node rather than a number so a
     *  caller can hang a tooltip on it; `formatPrice` is what fills it, and it draws an em dash
     *  rather than a `$0.00` nobody quoted. `null` and `undefined` both draw no slot at all —
     *  `null` is this codebase's word for "no price" (`formatPrice(value: number | null, …)`), so
     *  a caller holding one must not get an empty box for it. */
    money?: ReactNode;
    /** After the money. Two callers: the deck's shortage (`owned/wanted`), and the walls
     *  `CardGrid` draws, whose tiles append an `sr-only` game-changer word here — the crown is
     *  drawn only inside `CardArt`'s `aria-hidden` overlay and this bar is the sibling of the
     *  button that can say so. */
    extra?: ReactNode;
    /**
     * Whose outline the chin joins, and it is not decoration.
     *
     * * **`"card"`** — under a bordered card (the deck's stacks). `border-x` only, ridden `-mx-px`
     *   onto the card's own border so the two are one line rather than two. **No bottom edge**:
     *   the card's border is the bottom edge, and a `border-b` here sits 1px *above* it — a red
     *   card with a 2px foot and a 1px everything-else.
     * * **`"art"`** — under a `CardArt` frame (every wall `CardGrid` draws, and the deck's grid),
     *   which draws its own edge in this same colour and stops where this bar begins. The chin
     *   supplies all three of its own edges and rounds to the art's own `lg` corner, so the two
     *   read as one outline down the card and round its foot. The art's edge is **flush** rather
     *   than ridden onto: both boxes are the tile's full width, so the side edges are already
     *   collinear and the offset the stack needs would put this bar a pixel wide of the picture.
     *   It was a bare frame until 2026-08-26, and a reader reported the join as a rough cut-off:
     *   the picture simply stopped and a bordered bar started.
     *
     * **Required, and deliberately not defaulted, because the wrong answer is silent.** Exactly
     * one of the surfaces this is drawn on is a bordered card, so any default serves the
     * minority — and a call site that simply forgot the prop would compile, pass its tests, and
     * ship a chin missing its bottom edge, which jsdom cannot see and a screenshot barely can. It
     * is a fact about the host that no caller can be ignorant of.
     */
    seam: "card" | "art";
    /**
     * The card's own edge colour, which the chin **must** match.
     *
     * This bar is `relative` and later in the document than the face, so its border paints *over*
     * the card's along every pixel of its height. A rule break outlines the card in destructive
     * and a `border-border` chin then puts 28px of the wrong colour back through the left and
     * right edges of it — which is the one thing the outline exists to prevent.
     */
    tone?: "default" | "destructive";
  },
): ReactElement {
  const {
    rarity,
    zoom,
    printing,
    setCode,
    collectorNumber,
    printingTitle,
    finish = null,
    treatments = [],
    money,
    extra,
    seam,
    tone = "default",
  } = props;
  const tip = useTooltip();
  const marked = finish !== null || treatments.length > 0;
  return (
    <span
      style={{ height: chinHeight(zoom), marginTop: -CHIN_RISE }}
      className={cn(
        "relative box-border flex items-center border-x",
        // The gutter, the right padding and the type are all sizes on a card at 100% zoom, and
        // move with the chin's own height — the bar and its contents are one proportion.
        "gap-[calc(0.375rem*var(--mark-scale,1))] pr-[calc(0.375rem*var(--mark-scale,1))]",
        "bg-surface font-mono text-[calc(0.625rem*var(--mark-scale,1))] text-dim",
        seam === "card" ? "-mx-px rounded-b-[7px]" : "rounded-b-lg border-b",
        tone === "destructive" ? "border-destructive" : "border-border",
      )}
    >
      <RarityGem rarity={rarity} className="ml-[calc(0.375rem*var(--mark-scale,1))]" />
      <span {...tip(printingTitle ?? null)} className="min-w-0 flex-1 truncate">
        {printing ?? `${(setCode ?? "").toUpperCase()} · ${collectorNumber ?? ""}`}
      </span>
      {marked && <FinishMark finish={finish ?? "nonfoil"} treatments={treatments} />}
      {/* `!= null` and not `!== undefined`: `null` is this codebase's word for an absent price,
          and a caller holding one must get no slot rather than an empty box in the row. */}
      {money != null && <span className="shrink-0 tabular-nums text-text">{money}</span>}
      {extra}
    </span>
  );
}
