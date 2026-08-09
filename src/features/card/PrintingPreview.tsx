import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { CardImage } from "@/components/CardImage";
import { cardImageUrl } from "@/lib/images";
import { LAYER } from "@/lib/layers";
import { shouldFlipUp } from "@/lib/shouldFlipUp";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";

/**
 * How long the pointer — or the caret — has to rest on a printings row before its art appears.
 *
 * A quarter of a second is the difference between asking and passing through: a reader dragging
 * the pointer down forty rows on the way to the scrollbar crosses each of them in a few
 * milliseconds, and every one of those would otherwise be a picture. It is a **dwell**, not a
 * transition: nothing fades, so there is nothing for `prefers-reduced-motion` to turn off.
 */
export const PREVIEW_DWELL_MS = 250;

/**
 * How the preview finds the box it is positioned in and clipped by — the card pane.
 *
 * An attribute rather than a ref chain, because the preview is two components away from the
 * pane and owns none of it (`ZoneColumn`'s `SCROLLER_ATTR`, for its reason). One mark for both
 * jobs, because they are one box: the pane is `relative`, so absolute coordinates are the
 * pane's own, and it is the scroller, so it is also what would cut a picture in half.
 */
export const PREVIEW_FRAME_ATTR = "data-preview-frame";

/**
 * How wide the picture is drawn at most, capped further by the row it hangs off and by the room
 * the pane leaves above or below that row (see the measurement).
 *
 * 240px is a little over two-thirds of the pane's 352px content column: wide enough to read an
 * illustration by, and narrow enough that the rarity, set and collector number of the rows it
 * covers stay legible down its left edge.
 */
const PREVIEW_WIDTH = 240;

/**
 * The `display` variant is **672 × 936** (`Variant::dimensions`, `images.rs`), and the frame
 * keeps that ratio rather than the 5:7 `CARD_ASPECT` the app's own card frames use — a box
 * holding exactly one variant should be that variant's shape, so the art is not cropped by
 * even a pixel. Scryfall's usage rules forbid the crop, not the rounding.
 */
const PREVIEW_RATIO = 936 / 672;

/** What the picture stands off its row by — the 4px a row menu keeps from what it hangs off. */
const PREVIEW_GAP = 4;

/**
 * What tells a **dismissible layer** apart from a disclosure that is merely open.
 *
 * `aria-expanded` alone is not it, and getting that wrong would be a silent kill switch for
 * this whole feature: the app uses the bare attribute for plain disclosures that are open for
 * minutes at a time (`DeckSearchPanel`'s rail, `DeckEditor`'s Maybe pile, `DecksPage`'s
 * archived list, `ValidationPanel`'s "why"), and a pane that ever grows one — an expanded
 * Rulings section — would stop previewing anything, everywhere, with nothing to say why.
 * Every layer this has to be exclusive with is a *popup*, and every popup trigger in this app
 * pairs the two attributes (`AddToCollection`, `SetCombobox`, both row menus, both panels).
 */
const OPEN_POPUP = '[aria-haspopup][aria-expanded="true"]';

/** The printing whose art is on screen, and the row it hangs off. */
interface Shown {
  printingId: string;
  anchor: HTMLElement;
}

/** What a printings row spreads onto its `<li>` to take part in the dwell. */
export type DwellRowProps = Pick<
  HTMLAttributes<HTMLElement>,
  | "onMouseEnter"
  | "onMouseLeave"
  | "onFocus"
  | "onBlur"
  | "onDragStart"
  | "onPointerDown"
  | "onKeyDown"
>;

export interface PrintingDwell {
  /** The printing to draw, or `null`. Hand straight to {@link PrintingPreview}. */
  printingId: string | null;
  /** The row it was asked for from, which is what it is measured against. */
  anchor: HTMLElement | null;
  rowProps: (printingId: string) => DwellRowProps;
  /**
   * Take it down from outside the rows — for the list, when the rows themselves are replaced.
   * A picture measured against an element that has left the document is a 0×0 layer nobody can
   * see and Escape still has to close. Stable, so it can be an effect's dependency.
   */
  cancel: () => void;
}

/**
 * **One** timer for a whole printings list, and the row handlers that drive it.
 *
 * One, not one per row: two timers are two pictures, and a list of sixty rows crossed by a
 * moving pointer would open every one of them a quarter second apart. Moving from row to row
 * therefore *restarts* the same dwell — the leave clears it and takes any picture down, the
 * enter arms it again from zero — so there is never a second preview and never one to close.
 *
 * **It is never the pane's second open layer, and that has two halves** — because
 * `useDismissOnEscape` orders exactly two rungs, so two `"inner"` peers open at once are not
 * ordered at all, and one of them would draw a card over the other.
 *
 * * *This one first.* It goes down on the pointer leaving the row, the caret leaving it, a drag
 *   starting on it, unmounting — and on a **press** inside it, pointer or Enter/Space. The
 *   press is the load-bearing one: every other layer in this pane is opened by a press on a
 *   control inside a row, so the press that raises one has already taken this down.
 * * *The other one first.* A dwell **refuses to start** while a popup is open in the pane
 *   ({@link OPEN_POPUP}) — the case a press cannot cover, since hovering a neighbouring row
 *   moves no focus and presses nothing. Measured in the running window before the guard
 *   existed: the quick-add popup open, the pointer resting two rows down, and a card image
 *   over the finish chips a quarter second later.
 *
 * Escape is its own case and needs no hand-back: the caret was never in here — the picture is
 * `aria-hidden` decoration with nothing to focus — so a dismissed preview leaves the reader
 * exactly where they were, which for the keyboard is the row that asked for it.
 */
export function usePrintingDwell(): PrintingDwell {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // A no-op when nothing is shown: React bails out of a re-render on identical state, so
    // every pointer crossing the list costs one comparison rather than one commit.
    setShown(null);
  }, []);

  const start = useCallback(
    (printingId: string, anchor: HTMLElement) => {
      cancel();
      // Not over a layer the reader already opened. The trigger's own two attributes say so
      // ({@link OPEN_POPUP}), read off the pane rather than out of state the popup keeps to
      // itself — one query over one docked pane, on the enter and nowhere else. See the second
      // half of this hook's doc for the case it is here for, and `OPEN_POPUP` for why it is
      // not the bare `aria-expanded`.
      if (anchor.closest(`[${PREVIEW_FRAME_ATTR}]`)?.querySelector(OPEN_POPUP)) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        // The row can leave while the quarter second runs — a refetch that replaces the list,
        // a card that is no longer in `cards`. Measuring against a detached element gives a
        // 0×0 picture at the top of the pane and an Escape press with nothing to show for it.
        if (anchor.isConnected) setShown({ printingId, anchor });
      }, PREVIEW_DWELL_MS);
    },
    [cancel],
  );

  // A timer outliving the list it belongs to would set state on a component that is gone —
  // and the commonest way to leave this pane is a click somewhere else, which fires no leave.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  // The innermost open thing in the pane: capture phase, and the press is consumed so the pane
  // underneath — which returns early on a press something else has taken — stays open. No
  // listener at all while nothing is shown, so Escape reaches the pane on the first press.
  useDismissOnEscape({ layer: "inner", onDismiss: cancel, enabled: shown !== null });

  const rowProps = useCallback(
    (printingId: string): DwellRowProps => ({
      onMouseEnter: (e) => start(printingId, e.currentTarget),
      onMouseLeave: cancel,
      // Focus *arriving in* the row, which is the keyboard's version of the pointer resting on
      // it — the row is not focusable itself, its controls are. A caret moving between two of
      // those controls is not an arrival and not a departure, which is what the containment
      // check is for: without it, opening the quick-add popup inside a row would re-arm the
      // dwell and draw a picture over the popup a quarter second later.
      onFocus: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) start(printingId, e.currentTarget);
      },
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) cancel();
      },
      // A row being dragged is not a row being read. Wired here rather than into any drag
      // machinery, so it is already right on the day these rows carry their printing away.
      onDragStart: cancel,
      // A press is the reader doing something other than reading — and it is what opens every
      // other dismissible layer in this pane. See the note above: this is what keeps them from
      // ever being open at once.
      onPointerDown: cancel,
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") cancel();
      },
    }),
    [start, cancel],
  );

  return { printingId: shown?.printingId ?? null, anchor: shown?.anchor ?? null, rowProps, cancel };
}

/**
 * One printing's art, floating over the list it was asked for from.
 *
 * Positioned in the pane rather than portalled, like every other layer in this app: the shipped
 * CSP is `style-src 'self'` and the overlay primitives in reach inject a runtime `<style>` the
 * moment they open. Which means it is *inside* the pane's scroller and clipped by it, so it
 * flips above the row when there is no room below — `shouldFlipUp`, the same arithmetic the
 * deck editor's row menus are placed by.
 *
 * Renders nothing at all while `printingId` is null, which is most of the time.
 */
export function PrintingPreview({
  printingId,
  anchor,
}: {
  printingId: string | null;
  anchor: HTMLElement | null;
}) {
  if (printingId === null || anchor === null) return null;
  // Keyed on the printing, so a new row is a new frame with its own image state rather than
  // one frame that inherits the last picture's failed fetch.
  return <Preview key={printingId} printingId={printingId} anchor={anchor} />;
}

/** Where the picture sits, and how big it is. */
interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The parts of a `DOMRect` the placement reads — so the arithmetic can be tested without one. */
export interface PreviewRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

/**
 * Where one printing's picture goes, in **viewport** coordinates: beside its row, as big as the
 * pane will take, on whichever side has the room.
 *
 * Pure and exported because nothing about it can be seen in jsdom — every rectangle there is
 * zero — and because it has already been wrong once in a way only the running window showed.
 * The size is fitted to `max(room above, room below)` rather than to the pane or the row alone:
 * at the direction's **1024 × 768 floor** a row halfway down the pane has 323px above it and
 * 323px below, `shouldFlipUp` correctly answers "neither side takes it, open the way it reads",
 * and a picture that did not shrink was **cut off by 15px** at the pane's edge. Both cases are
 * fixtures in this module's test.
 *
 * The caller translates the answer into the pane's own box; this decides the shape and the side.
 */
export function previewBox(row: PreviewRect, view: PreviewRect): Box {
  const below = view.bottom - row.bottom - PREVIEW_GAP;
  const above = row.top - view.top - PREVIEW_GAP;
  const width = Math.max(
    0,
    Math.min(PREVIEW_WIDTH, row.width, Math.floor(Math.max(above, below) / PREVIEW_RATIO)),
  );
  // Floored, not rounded: a height rounded *up* past the room measured above is the 15px again,
  // one pixel at a time.
  const height = Math.floor(width * PREVIEW_RATIO);
  // Beside the row, not over it: the picture starts at the row's *bottom* edge going down and
  // ends at its *top* edge coming up, which is the other way round from a menu drawn over its
  // row. The gap is part of what has to fit.
  const up = shouldFlipUp({
    rowTop: row.bottom,
    rowBottom: row.top,
    menuHeight: height + PREVIEW_GAP,
    viewTop: view.top,
    viewBottom: view.bottom,
  });
  return {
    top: up ? row.top - PREVIEW_GAP - height : row.bottom + PREVIEW_GAP,
    // Right-aligned to the row, which leaves the rarity, set and collector number of the rows
    // underneath showing down the left — so the reader can still see where they are.
    left: row.right - width,
    width,
    height,
  };
}

function Preview({ printingId, anchor }: { printingId: string; anchor: HTMLElement }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  // The one retry schedule every card frame in the app shares. A preview lives for as long as
  // a pointer rests, so a retry rarely lands inside one — what this buys is the frame not
  // being left holding a URL that has already failed.
  const image = useImageRetry(cardImageUrl(printingId, 0, "display"));

  // `useLayoutEffect`, so the picture is never painted at the top of the pane on its way to the
  // row it belongs to. Measured once: the component is keyed on the printing, so a different
  // row is a different instance.
  useLayoutEffect(() => {
    const element = frameRef.current;
    const frame = element?.closest<HTMLElement>(`[${PREVIEW_FRAME_ATTR}]`);
    if (!element || !frame) return;
    const view = frame.getBoundingClientRect();
    const placed = previewBox(anchor.getBoundingClientRect(), view);
    // Viewport coordinates into the pane's own box. An absolutely positioned child is placed
    // against its containing block's *padding* box — hence `clientTop`/`clientLeft`, which are
    // exactly the border widths — and those coordinates are the pane's **content**, which the
    // scroller moves under the reader. `getBoundingClientRect` has already had that movement
    // taken out of it, so adding the scroll offset back is what puts the picture on the row
    // rather than where the row would be at the top of the list.
    setBox({
      ...placed,
      top: placed.top - view.top - frame.clientTop + frame.scrollTop,
      left: placed.left - view.left - frame.clientLeft + frame.scrollLeft,
    });
  }, [anchor]);

  return (
    <div
      ref={frameRef}
      // Redundant art: the row underneath already names the printing, and this is drawn from
      // that row's own id. A screen reader that read it would read the same card twice.
      aria-hidden="true"
      style={{
        top: box?.top ?? 0,
        left: box?.left ?? 0,
        width: box?.width,
        height: box?.height,
        // The measurement decides where this sits, not the cascade: the list it is mounted in
        // is a `space-y` column, whose top margin on every child after the first would move an
        // absolutely positioned box as surely as it moves a flow one.
        marginTop: 0,
      }}
      // `pointer-events-none` is not decoration: the picture covers the rows below the one it
      // belongs to, and a layer that took the pointer would make them unhoverable — the reader
      // would leave the row, the preview would close, the row would be entered again, and the
      // list would flicker under a perfectly still hand.
      className={cn(
        "pointer-events-none absolute overflow-hidden rounded-xl border border-border bg-bg shadow-lg",
        LAYER.popup,
      )}
    >
      {/* An empty frame while the bytes are on their way (~127 ms cold) and if they never
          arrive — `useImageRetry`'s own answer: the frame *is* the placeholder, and a preview
          is on screen for a second at a time. No filters and no crop: the frame is the
          variant's own 672 × 936, so `object-cover` is a no-op that stays safe if that ever
          changes. */}
      {image.src && (
        <CardImage
          alt=""
          src={image.src}
          onError={image.onError}
          decoding="async"
          className="size-full object-cover"
        />
      )}
    </div>
  );
}
