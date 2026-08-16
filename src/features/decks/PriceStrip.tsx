import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Trash2 } from "lucide-react";
import { LAYER } from "@/lib/layers";
import type { Marketplace } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { dropWrite, readDragData, type DeckWrite, type DragPayload } from "./dnd";

/**
 * The strip under the deck: how old the prices are, and — while a card is in the air — the way
 * out of the deck drawn over it.
 *
 * **Named for the strip rather than for the tray, because the strip is the permanent half.**
 * Spec §5: a price is never shown without saying how old it is, said once here rather than as a
 * tooltip on every one of sixty cards. The tray is the transient thing drawn *on* it, and it
 * takes the place of the price line rather than a place of its own — appearing in the flow would
 * push every pile up by its own height at the exact moment the reader is aiming at one.
 *
 * ## Why this owns its own monitor rather than living in `DeckEditor`
 *
 * `QuickZones.tsx` wrote this argument down first and it is the same one: a component with a
 * `monitorForElements` of its own re-renders **itself** on `dragstart` and `drop`. In
 * `DeckEditor` that same monitor re-rendered the editor — and with it all four views,
 * `DeckStats`, `ValidationPanel` and `DeckSearchPanel` — twice per drag, for two pieces of state
 * (`dragging`, `overTray`) nothing outside these forty lines ever read.
 *
 * **So this cut is not behaviour-neutral, and that is the point of it.** The editor no longer
 * re-renders on a deck card's `dragstart` or `drop`. jsdom cannot show what that was costing —
 * a mid-drag re-render can drop a `draggable` registration out from under the reader's
 * pointer — so it wants a live pass rather than a green suite.
 *
 * The monitor is still narrowed to the deck's **own** cards by `canMonitor`: a tile dragged in
 * from the docked search panel is not something the tray can take, and a tray that offered to
 * remove it would be offering to undo something that never happened. `QuickZones` is the
 * component that answers for *every* drag, which is why it is a second one rather than a widening
 * of this.
 *
 * ## Where it must sit
 *
 * **A direct child of the editor's `flex flex-col gap-3` column.** The tray's `-top-3` *is* that
 * column's `gap-3` — the empty gap above this line, and exactly the strip and not a pixel more.
 * A tray taller than that overhangs the deck, and an overhang here is a drop aimed at a pile's
 * last card that removes the card instead: the one mistake in this view with nothing to undo it.
 * `DeckEditor.test.tsx` pins the document order — the stats band comes after this line, because
 * a band between them would put four charts between a card and the one drop that takes it out.
 */
export function PriceStrip({
  marketplace,
  onDrop,
}: {
  /** Whose prices the deck was read at — its label and whether it is a feed, which is the whole
   *  of what {@link pricesAsOf} needs. The editor's, so the strip and the stats band under it
   *  can never name two marketplaces. */
  marketplace: Marketplace;
  /** What a drop writes. `DeckEditor`'s `applyDrop`, which is stable — see it. The tray's own
   *  write is always the zero the stepper's last press writes; there is no remove mutation. */
  onDrop: (write: DeckWrite) => void;
}): ReactElement {
  /**
   * The card a **card** drag is carrying, or `null` when nothing is being dragged out of the
   * deck.
   *
   * Only ever a `deck-card` — `canMonitor` says so — and that is the whole reason this state
   * exists: the tray is drawn from it, and a card being dragged *in* from the search panel has
   * nothing to remove.
   */
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  /** Whether the card being dragged is over the tray, so the tray can say what letting go
   *  would do. */
  const [overTray, setOverTray] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

  // What is being dragged out of the deck, for as long as it is. `canMonitor` narrows this to
  // the deck's own cards: a tile dragged in from the panel is not something the tray can take,
  // and a monitor that answered for it would re-render this strip — and, when this lived in the
  // editor, the panel and the very tile the reader has hold of — in the middle of the drag.
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readDragData(source.data)?.kind === "deck-card",
        onDragStart: ({ source }) => setDragging(readDragData(source.data)),
        // Dropped, or cancelled with Escape: the platform's own way out of a drag ends in the
        // same event, so the tray goes away either way without this view hearing a keypress.
        onDrop: () => {
          setDragging(null);
          setOverTray(false);
        },
      }),
    [],
  );

  // The tray, while it exists. Registered from an effect that re-runs when it mounts, because
  // it only exists during a drag — a drop target added mid-drag is picked up on the next
  // `dragover`, which is how a tray that appears on `dragstart` can be dropped on at all.
  const trayShown = dragging !== null;
  useEffect(() => {
    const element = trayRef.current;
    if (!element) return;
    const writeFor = (data: Record<string, unknown>) => {
      const payload = readDragData(data);
      return payload && dropWrite(payload, { kind: "remove" });
    };
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => writeFor(source.data) !== null,
      onDragEnter: () => setOverTray(true),
      onDragLeave: () => setOverTray(false),
      onDrop: ({ source }) => {
        setOverTray(false);
        const write = writeFor(source.data);
        if (write) onDrop(write);
      },
    });
  }, [trayShown, onDrop]);

  return (
    /* **`sticky bottom-0` while a card is in the air, and only then** (2026-08-14). The deck
       grows down the page now, so this strip — and the remove tray drawn on it — is at the
       foot of however tall the deck is, which for a large one is a long way below the window.
       The drag auto-scroll would carry the reader there eventually; a drop target that has to
       be *travelled to* is not the same affordance as one that is simply there. Stuck to the
       bottom of the page for the length of the drag, it is, and the tray keeps its exact
       `-top-3` relationship to the strip because the strip is what moved. Out of a drag the
       class is gone and the strip sits in the flow under the deck, which is where a line
       saying how old the prices are belongs. */
    <div className={cn("relative shrink-0", dragging && "sticky bottom-0")}>
      <p className="text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>

      {dragging && (
        // The way out of a deck, for a hand that is already holding the card. It exists only
        // while a card is in the air.
        //
        // **Exactly the strip and not a pixel more.** `-top-3` is the `gap-3` above this
        // line, which is empty; the height is whatever the price line is. A tray taller than
        // that overhangs the deck, and an overhang here is a drop aimed at a pile's last card
        // that removes the card instead — the one mistake in this view with nothing to undo
        // it.
        //
        // Nothing tweens on either state — it appears instantly and it answers instantly. An
        // affordance that fades in during a drag is an affordance that is still arriving when
        // the reader has let go.
        //
        // Destructive rather than gold: gold is where a card is *going*, and this is the one
        // drop that takes something away. It names the card once it has it, because by then
        // the platform's drag preview is the only other thing saying which card this is.
        //
        // `aria-hidden` like the drop line: this is chrome for a gesture only a pointer can
        // make, and the click path it shortcuts — the stepper's zero — is the one a screen
        // reader is given.
        <div
          ref={trayRef}
          aria-hidden="true"
          className={cn(
            "absolute inset-x-0 -top-3 bottom-0 flex items-center justify-center gap-1.5",
            "rounded-md border border-dashed text-xs",
            // Above the popups rather than among them: a drag can start while a select is
            // open, and this is the target the pointer is being carried to.
            LAYER.dragTray,
            overTray
              ? "border-destructive/60 bg-destructive/10 text-destructive"
              : "border-border bg-surface text-dim",
          )}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {overTray ? `Remove ${dragging.name} from deck` : "Remove from deck"}
        </div>
      )}
    </div>
  );
}
