import type { ReactElement } from "react";
import { Layers } from "lucide-react";

/** The two labels, spelled once — a test and a page find the section by them. */
export const SHELF_LABEL = { decks: "Decks", managed: "Managed by decks" } as const;

/**
 * The overline above the app-owned shelves at the root — spec §3.1 item 3.
 *
 * `PinnedFolders`' `Decks` heading and `ManagedWishFolders`' `Managed by decks`, which this
 * replaces: the same `h3`, the same overline type and the same `Layers` glyph, plus the hairline the
 * canvas draws to the right edge so the label reads as a divider across the wall. It is what tells a
 * reader where their own drawers stop and the app's records of where the rest of their copies are
 * begin. 40px, `SHELF_LABEL_HEIGHT`.
 */
export function ShelfLabel({ group }: { group: "decks" | "managed" }): ReactElement {
  return (
    <h3 className="flex h-10 items-center gap-2 text-[0.7rem] font-medium uppercase tracking-wide text-dim">
      <Layers className="size-3.5 flex-none" aria-hidden="true" />
      {SHELF_LABEL[group]}
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />
    </h3>
  );
}
