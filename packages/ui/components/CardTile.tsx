import type { ReactElement, ReactNode } from "react";
import { CardArt } from "@/components/CardArt";
import { CardChin, type ChinPrinting } from "@/components/CardChin";
import { cardScaleVars, DEFAULT_ZOOM } from "@/lib/cardZoom";
import type { Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

export interface CardTileProps {
  cardId: string | null;
  name: string;
  /** Absent means the image cache; a present `null` means no picture. Passed through as given —
   *  see `CardArt`'s own prop for why the two are different answers. */
  remoteSrc?: string | null;
  finish?: Finish | null;
  rarity: string | null;
  chin: ChinPrinting;
  money?: ReactNode;
  zoom?: number;
  /**
   * Drawn over the art — a count tag, say. Inside the button when there is one.
   *
   * **So on a pressable tile the overlay must be decorative and non-interactive** — an
   * `aria-hidden` mark like `CountTag` — because the button's `aria-label` replaces its contents
   * for naming, which leaves text in here unreachable to a screen reader and makes a control in
   * here interactive content nested in a button; a tile that needs a real control in a corner
   * draws it as a sibling of the button, as `CardGrid` does.
   */
  overlay?: ReactNode;
  /** Makes the art a button. Absent, the tile is not a control at all. */
  onPress?: () => void;
  /** The button's accessible name. Defaults to `name`. */
  pressLabel?: string;
  loading?: "eager" | "lazy";
  className?: string;
}

/**
 * One card, drawn as a tile: the art, and the chin under it.
 *
 * **This is a composition and owns no drawing of its own.** `CardArt` is the frame and `CardChin`
 * the foot; what this file is the one definition of is *how the two are put together* — the scale
 * variables the chin's type reads, the seam between them, and whether the art is a control. It
 * exists because that composition was spelled out separately by every wall that drew a tile, and
 * a second app drawing cards is the point at which two spellings become drift.
 *
 * **The chin is a sibling of the button, never a child of it** — `CardChin`'s own rule. A button's
 * accessible name swallows its contents, and the printing and the price are facts a screen reader
 * should reach.
 *
 * `CardGrid` does not call this yet. It composes the same two components itself, with a selection
 * ring, a quick-add and a drag source this file knows nothing about; folding it in is a change to
 * that file, made when somebody is next in it.
 */
export function CardTile({
  cardId,
  name,
  remoteSrc,
  finish = null,
  rarity,
  chin,
  money,
  zoom = DEFAULT_ZOOM,
  overlay,
  onPress,
  pressLabel,
  loading,
  className,
}: CardTileProps): ReactElement {
  const art = (
    <>
      <CardArt
        cardId={cardId}
        name={name}
        finish={finish}
        loading={loading}
        // Spread only when given: an absent `remoteSrc` and a present `null` are two answers.
        {...(remoteSrc !== undefined ? { remoteSrc } : {})}
      />
      {overlay}
    </>
  );

  return (
    <div className={cn("group flex flex-col", className)} style={cardScaleVars(zoom)}>
      {onPress ? (
        <button
          type="button"
          aria-label={pressLabel ?? name}
          onClick={onPress}
          className={cn("relative block w-full rounded-lg text-left", FOCUS)}
        >
          {art}
        </button>
      ) : (
        <div className="relative">{art}</div>
      )}
      <CardChin {...chin} zoom={zoom} rarity={rarity} finish={finish} money={money} seam="art" />
    </div>
  );
}
