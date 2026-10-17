import type { JSX } from "react";
import { CardImage } from "@/components/CardImage";
import { cardImageUrl } from "@/lib/images";

/**
 * The commander's art across the whole board, dimmed to 28% under the cards — the game menu's
 * Playmat "<commander>'s art" (`menus.ts`' `gameMenu`).
 *
 * **Drawn under everything and taking no pointer**: it is the background, so it sits first in the
 * board's box and lets every press through to the table above it. The dimming is a sheet of
 * `--color-bg` over the art rather than an opacity on the picture, so the cards and plates drawn
 * on it read against the same colour they do on the plain felt. The art is a `CardImage` like
 * every card picture, never a raw image.
 */
export function CommanderMat({ cardId, name }: { cardId: string; name: string }): JSX.Element {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <CardImage
        src={cardImageUrl(cardId, 0, "art")}
        alt=""
        className="block h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-bg opacity-[0.72]" />
      <span className="absolute top-[58px] right-4 text-[11px] text-dim">Playmat: {name}</span>
    </div>
  );
}
