import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
} from "react";
import { CardImage } from "@/components/CardImage";
import { OPEN_POPUP } from "@/features/card/PrintingPreview";
import { INSPECT_DELAY, INSPECT_WIDTH, placePreview } from "@/features/playtesting/table/Inspect";
import { cardImageUrl } from "@/lib/images";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";

/**
 * The draft's large card preview (issue #1472): the card a pointer rests on in the pack, a
 * Winston pile or the pool, drawn big enough to read its cost, type line and rules text — the
 * pick screen's tiles are sized to see a whole pack at once, and the pool shows only name strips.
 *
 * **The playtest board's inspect box, made for a wall** (`playtesting/table/Inspect.tsx`): the same
 * rest before it opens ({@link INSPECT_DELAY}), the same width ({@link INSPECT_WIDTH}), and the
 * same place beside the pointer, following it (`placePreview`). Two things differ, both because a
 * draft is a page and not a table:
 *
 * * **The wheel scrolls the page.** The board's wheel resizes its preview because the board does
 *   not scroll; here a resting pointer is over a card nearly all the time, and a wheel that resized
 *   the preview would leave the pick screen unscrollable. The size instead follows the tile: never
 *   smaller than the card it previews ({@link previewWidth}).
 * * **It is `fixed`, placed in the window.** The pick screen is a scroller under a flow bar, and a
 *   preview positioned inside it would be cut off by the scroller's edge at the bottom of the
 *   visible pack. `fixed` escapes that clip, the way the sort `Dropdown` on this same screen does.
 */

/** The `display` variant is 672 × 936, and the frame is that shape so the art is never cropped. */
const PREVIEW_RATIO = 936 / 672;
/** How much bigger than its tile the preview is drawn when the tile is already past {@link INSPECT_WIDTH}. */
const OVER_TILE = 1.5;
/** How close the preview may come to the window's edge, and how far it stands off a focused tile. */
const EDGE = 8;
const GAP = 12;

/** What a draft surface hands the preview: the printing to draw. */
export interface PreviewCard {
  cardId: string;
  name: string;
}

/** Where the preview hangs: off the pointer (a hover), or beside a tile (the caret). */
export type PreviewAim = { kind: "pointer"; x: number; y: number } | { kind: "tile" };

/** What is on screen: the card, the tile it was asked for from, and where it hangs. */
export interface ShownPreview {
  card: PreviewCard;
  anchor: HTMLElement;
  aim: PreviewAim;
}

/** A window-sized box — `{ width: innerWidth, height: innerHeight }`, or a test's own. */
export interface ViewSize {
  width: number;
  height: number;
}

/** The parts of a tile's `DOMRect` the placement reads. */
export interface TileRect {
  top: number;
  left: number;
  right: number;
  width: number;
}

/**
 * The preview's card width for a tile `tileWidth` wide in a window of `view`: the board's
 * {@link INSPECT_WIDTH}, or half again the tile when the draft's zoom has already drawn it bigger
 * than that — a preview no larger than the card under it would show nothing new — and never so
 * big that it leaves the window.
 */
export function previewWidth(tileWidth: number, view: ViewSize): number {
  const wanted = Math.max(INSPECT_WIDTH, Math.round(tileWidth * OVER_TILE));
  const tall = Math.floor((view.height - 2 * EDGE) / PREVIEW_RATIO);
  const wide = view.width - 2 * EDGE;
  return Math.max(0, Math.min(wanted, tall, wide));
}

/** The preview's height for a card `width` wide — the variant's own shape, floored. */
export function previewHeight(width: number): number {
  return Math.floor(width * PREVIEW_RATIO);
}

/**
 * Where the preview goes for a tile the **caret** is on, in window coordinates: beside the tile on
 * the right, or on the left when the right has no room, top-aligned with it and kept inside the
 * window. A keyboard reader has no pointer to hang it off, and over the tile it would hide the
 * very card the arrows just moved to.
 */
export function besideTile(
  tile: TileRect,
  size: ViewSize,
  view: ViewSize,
): { left: number; top: number } {
  const right = tile.right + GAP;
  const left =
    right + size.width <= view.width - EDGE
      ? right
      : tile.left - GAP - size.width >= EDGE
        ? tile.left - GAP - size.width
        : Math.max(EDGE, view.width - EDGE - size.width);
  const top = Math.max(EDGE, Math.min(tile.top, view.height - EDGE - size.height));
  return { left, top };
}

/** What a tile spreads onto itself to take part in the preview. */
export type PreviewTileProps = Pick<
  HTMLAttributes<HTMLElement>,
  | "onPointerEnter"
  | "onPointerMove"
  | "onPointerLeave"
  | "onPointerDown"
  | "onPointerUp"
  | "onFocus"
  | "onBlur"
>;

export interface CardPreviewState {
  /** The preview to draw, or `null`. Hand straight to {@link CardPreview}. */
  shown: ShownPreview | null;
  tileProps: (card: PreviewCard) => PreviewTileProps;
  /** Take it down from outside the tiles. Stable. */
  cancel: () => void;
}

/**
 * **One** rest timer for a whole wall of tiles, and the handlers that drive it — the playtest
 * board's one-hover-one-rest: moving from tile to tile restarts the rest, so a pointer sweeping
 * across the pack never flashes a preview under every card it crosses, and there is never a
 * second preview to close.
 *
 * It goes down on the pointer leaving the tile, the caret leaving it, a scroll, Escape, and a
 * **press** — a press is a choice or the start of a drag onto the pool, and a preview following the
 * pointer over the pool would hide the drop. The press's **release** over the tile rests anew, so a
 * reader who clicks to choose a card can keep reading it; a drag is released over the pool, so it
 * re-arms nothing. It refuses to start while a popup is open (`OPEN_POPUP`, the printing preview's
 * guard): the pack's Sort menu drops over the first row.
 *
 * The caret takes part too: a tile the keyboard moved to (the app's own `data-kbd` mark,
 * `lib/keyboardModality.ts`, not `:focus-visible`) rests the same way and the preview opens beside
 * it. A tile focused by a click does not — that click's press is the pointer's business.
 */
export function useCardPreview(): CardPreviewState {
  const [shown, setShown] = useState<ShownPreview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the pointer last was over a tile, so the preview opens where the pointer now rests. */
  const point = useRef({ x: 0, y: 0 });
  const shownRef = useRef<ShownPreview | null>(null);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (shownRef.current === null) return;
    shownRef.current = null;
    setShown(null);
  }, []);

  const start = useCallback(
    (card: PreviewCard, anchor: HTMLElement, kind: PreviewAim["kind"]) => {
      cancel();
      if (document.querySelector(OPEN_POPUP)) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        // A pick replaces the pack while the rest runs; a detached tile has nothing to hang off.
        if (!anchor.isConnected) return;
        const aim: PreviewAim =
          kind === "pointer" ? { kind, x: point.current.x, y: point.current.y } : { kind };
        const next = { card, anchor, aim };
        shownRef.current = next;
        setShown(next);
      }, INSPECT_DELAY);
    },
    [cancel],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // A scroll moves the tile out from under a preview that would stay where it was. The capture
  // phase is what hears a scroll of an element — the pick screen's own scroller — from `document`.
  useEffect(() => {
    if (shown === null) return;
    document.addEventListener("scroll", cancel, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", cancel, { capture: true });
  }, [shown, cancel]);

  useDismissOnEscape({ layer: "inner", onDismiss: cancel, enabled: shown !== null });

  const tileProps = useCallback(
    (card: PreviewCard): PreviewTileProps => ({
      onPointerEnter: (e) => {
        // A finger has no hover to rest; the press it makes is a choice.
        if (e.pointerType === "touch") return;
        point.current = { x: e.clientX, y: e.clientY };
        start(card, e.currentTarget, "pointer");
      },
      onPointerMove: (e) => {
        point.current = { x: e.clientX, y: e.clientY };
      },
      onPointerLeave: cancel,
      onPointerDown: cancel,
      onPointerUp: (e) => {
        if (e.pointerType === "touch") return;
        point.current = { x: e.clientX, y: e.clientY };
        start(card, e.currentTarget, "pointer");
      },
      onFocus: (e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        // `keyboardModality` decides at `focusin` on the window's capture phase, before this.
        if (document.documentElement.hasAttribute(KEYBOARD_MODALITY_ATTR)) {
          start(card, e.currentTarget, "tile");
        }
      },
      onBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) cancel();
      },
    }),
    [start, cancel],
  );

  return { shown, tileProps, cancel };
}

/**
 * The preview itself, or nothing while `shown` is null — which is most of the time.
 *
 * Keyed on the card and its tile, so the next card is a new frame with its own image state.
 */
export function CardPreview({ shown }: { shown: ShownPreview | null }): JSX.Element | null {
  if (shown === null) return null;
  return <Preview key={`${shown.card.cardId}:${shown.aim.kind}`} shown={shown} />;
}

function Preview({ shown }: { shown: ShownPreview }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { card, anchor, aim } = shown;
  const [width] = useState(() =>
    previewWidth(anchor.getBoundingClientRect().width, {
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  );
  const height = previewHeight(width);
  const image = useImageRetry(cardImageUrl(card.cardId, 0, "display"));

  // Placed straight from the event rather than through a render, so it keeps up with the cursor —
  // and in a layout effect, so it is never painted at the window's corner on its way there.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const view = () => ({ width: window.innerWidth, height: window.innerHeight });
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const put = (at: { left: number; top: number }) => {
      el.style.transform = `translate(${at.left}px, ${at.top}px)`;
    };
    if (aim.kind === "tile") {
      put(besideTile(anchor.getBoundingClientRect(), size, view()));
      return;
    }
    put(placePreview(aim, size, view()));
    const onMove = (e: PointerEvent) =>
      put(placePreview({ x: e.clientX, y: e.clientY }, size, view()));
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [aim, anchor]);

  return (
    <div
      ref={ref}
      // Redundant art: the tile under it already names the card.
      aria-hidden="true"
      data-testid="draft-card-preview"
      // `pointer-events-none`, or the preview — beside the cursor, over the next tiles — would take
      // the hover that opened it, close, and open again under a perfectly still hand.
      className={cn(
        "pointer-events-none fixed top-0 left-0 overflow-hidden rounded-[14px] border border-border bg-surface shadow-lg",
        LAYER.popup,
      )}
      style={{ width, height }}
    >
      {image.src !== null && (
        <CardImage
          alt=""
          src={image.src}
          onError={image.onError}
          className="size-full object-cover"
        />
      )}
    </div>
  );
}
