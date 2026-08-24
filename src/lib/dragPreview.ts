/**
 * What a multi-card drag looks like while it is in the air: a gold chip reading `4 cards`.
 *
 * ## Why a drag needs to say this at all
 *
 * Picking up four cards and picking up one look identical without it. The native preview is a
 * ghost of the element the pointer went down on — one card — so a reader who has Ctrl-clicked
 * their way through a deck and then grabs a row has nothing on screen telling them whether the
 * other three are coming. The chip is the answer, and it is the *only* moment in the gesture
 * where the answer can be given: by the time they let go it is a write.
 *
 * **Only for two or more.** A single-card drag keeps the native preview it has always had, which
 * is a picture of the card and better than any chip could be. `1 card` on a preview is an app
 * telling the reader something they can already see.
 *
 * ## Plain DOM rather than React
 *
 * `setCustomNativeDragPreview` renders into a container it appends to `document.body` and
 * photographs **one microtask later** — see its own source, which queues the `nativeSetDragImage`
 * call precisely so a framework that renders asynchronously has landed by then. A React root
 * would be creating and tearing down a root per drag to draw two words, and it would be betting
 * on that microtask. Six lines of `createElement` are synchronous and have no such bet in them.
 *
 * That also means **no Tailwind classes**: the container is outside the app's tree for a single
 * frame, and inline styles are what cannot be wrong about a stylesheet that may not have been
 * consulted yet. The values are read off the app's own custom properties where they exist, so
 * the chip is the app's gold rather than a hard-coded one.
 */
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";

/**
 * How far the chip sits from the pointer.
 *
 * Down and right, so the chip is *below* the cursor rather than under it: a preview centred on
 * the pointer covers the drop target the reader is aiming at, which on a deck with a dozen
 * category headings is the one thing they need to see. 12px is far enough to clear a standard
 * cursor and near enough to read as attached to it.
 */
const OFFSET = { x: 12, y: 12 };

/** `4 cards`, and `1 card` for the case this module refuses to draw — spelled here anyway so the
 *  string has one home if a caller ever wants it in a sentence. */
export function cardCountLabel(count: number): string {
  return `${count} ${count === 1 ? "card" : "cards"}`;
}

/**
 * Draw the count chip for this drag, or leave the native preview alone.
 *
 * Call it from `onGenerateDragPreview`, handing it that event's `nativeSetDragImage`. A `count`
 * below two returns without touching anything, which is what keeps every single-card drag in the
 * app exactly as it was.
 */
export function setCardCountPreview(
  count: number,
  nativeSetDragImage: Parameters<typeof setCustomNativeDragPreview>[0]["nativeSetDragImage"],
): void {
  if (count < 2) return;
  setCustomNativeDragPreview({
    nativeSetDragImage,
    getOffset: () => OFFSET,
    render: ({ container }) => {
      const chip = document.createElement("div");
      chip.textContent = cardCountLabel(count);
      Object.assign(chip.style, {
        // The app's own gold on the app's own felt, read from the stylesheet rather than copied:
        // `var()` with a fallback is correct whether or not the custom properties have reached
        // this element, which is a container appended to `document.body` for one frame.
        background: "var(--color-bg, oklch(0.16 0.01 270))",
        color: "var(--color-accent, oklch(0.75 0.12 85))",
        border: "1px solid var(--color-accent, oklch(0.75 0.12 85))",
        borderRadius: "6px",
        padding: "3px 8px",
        font: "600 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      });
      container.append(chip);
      // No cleanup of our own: `setCustomNativeDragPreview` removes the whole container from the
      // document, and this node is inside it.
    },
  });
}
