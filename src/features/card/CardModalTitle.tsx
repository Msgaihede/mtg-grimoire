import type { ReactElement } from "react";

import { ManaText } from "@/components/ManaText";
import type { CardDetail } from "@/lib/ipc";

/**
 * `Dialog`'s heading for a card: its name, with its type line and mana cost beside it above the
 * fold and stacked under it below.
 *
 * **A `ReactNode` title is what makes this legal**, and it is why the type line is here rather
 * than in `subtitle`: the two facts are the card's identity read at a glance, and a subtitle
 * truncates to one line. The name is `font-heading` by `Dialog`'s own header; the two facts
 * beside it are `text-sm text-dim` so the name is still the loudest thing in the row.
 *
 * `Dialog` sets `aria-labelledby` to this heading, so the modal is addressed **by the card**
 * rather than by a category word — which is what `App.test.tsx`'s dialog queries become.
 *
 * **Its own file because two dialogs draw it** — `CardDetailModal`, where it was born, and the
 * home page's `NewPrintingDialog` (issue #514), which was asked to look like the card modal and
 * so opens on the same heading rather than a second drawing of one. The fold is the panel's
 * `@container/card`, so a host has to pass `Dialog` its `container` prop for the row arrangement
 * to appear at all.
 *
 * @param fallback The name to draw while `card` is not here yet. The card modal knows nothing
 *   but an id until its read lands and says *Loading…*; a host that already holds the name says it
 *   instead, so the heading does not flicker from a placeholder to the word it could have drawn.
 */
export function CardModalTitle({
  card,
  pending,
  fallback,
}: {
  card: CardDetail | null;
  pending: boolean;
  fallback?: string;
}): ReactElement {
  const name = card?.name ?? fallback ?? (pending ? "Loading…" : "Card");
  return (
    <span className="flex min-w-0 flex-col gap-1 @min-[640px]/card:flex-row @min-[640px]/card:items-baseline @min-[640px]/card:gap-3">
      <span className="min-w-0 truncate">{name}</span>
      {card !== null && (
        <span className="flex min-w-0 items-baseline gap-2 font-sans text-sm font-normal text-dim">
          {card.typeLine !== null && <span className="min-w-0 truncate">{card.typeLine}</span>}
          <ManaText source={card.manaCost} className="shrink-0" />
        </span>
      )}
    </span>
  );
}
