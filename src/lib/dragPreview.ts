/**
 * What a multi-card drag looks like while it is in the air: a gold chip reading `4 cards`.
 *
 * ## Why a drag needs to say this at all
 *
 * Picking up four cards and picking up one look identical without it. The preview is a ghost of
 * the element the pointer went down on — one card — so a reader who has Ctrl-clicked their way
 * through a deck and then grabs a row has nothing on screen telling them whether the other three
 * are coming. The chip is the answer, and it is the *only* moment in the gesture where the answer
 * can be given: by the time they let go it is a write.
 *
 * **Only for two or more.** A single-card drag keeps the preview it has always had, which is a
 * picture of the card and better than any chip could be. `1 card` on a preview is an app telling
 * the reader something they can already see.
 *
 * ## Plain DOM the app owns, rather than the library's
 *
 * **Not dnd-kit's `Feedback`.** That plugin clones the source element into an overlay it
 * positions from `--dnd-*` custom properties; its `feedback` option takes
 * `'default' | 'move' | 'clone' | 'none'` and nothing that means "and also draw this". Reaching
 * into `Feedback.overlay` would be reaching into a plugin instance the manager exposes as a flat
 * `Plugin<any>[]` with no typed lookup. One `<div>` this app owns outright depends on no library
 * internals and survives an upgrade.
 *
 * **Inline styles rather than Tailwind classes**, and that is now a CSP fact rather than a timing
 * one: the chip is appended straight to `document.body`, and `style-src-attr 'unsafe-inline'` is
 * the half of the shipped policy that permits a style *attribute*. `index.css` gains nothing. The
 * values are read off the app's own custom properties with fallbacks, so the chip is the app's
 * gold rather than a hard-coded one whether or not those properties have reached the element.
 */
import type { DragDropManager } from "@dnd-kit/dom";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { readDragGroup } from "@/features/decks/dnd";

/** The attribute the chip carries, so a test can find it and nothing else can be mistaken for
 *  it. Not a class: the chip is drawn with inline styles for the reason above, and a class the
 *  stylesheet does not define would be a name meaning nothing. */
export const CARD_COUNT_CHIP = "data-drag-count";

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
 * **`composedDraggable`'s half of the chip, and the last thing in this file that is
 * pragmatic-dnd's.** It survives exactly as long as that function's `onGenerateDragPreview` does;
 * taking it out before the card payload moves would leave the shipped multi-card drag with no
 * chip at all for one commit.
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

/**
 * Draw the count chip for a drag carrying two or more cards, for as long as it is in the air.
 *
 * **The count comes off the payload, not off the source.** `dnd.ts`'s `dragData` already writes
 * every member of a multi-select drag under its group key and `readDragGroup` reads them back, so
 * there is nothing for a call site to pass and nothing for one to get wrong. A drag this app did
 * not put in the air reads as no cards and draws nothing.
 *
 * Installed once, from `lib/dndManager.ts`, beside that module's own `data-dragging` listeners
 * and for the same reason: the manager is a singleton with no teardown, so its subscriptions are
 * the window's rather than something a component owns and could forget. The cleanup is returned
 * anyway, because a subscription with no way out is a subscription a test cannot isolate.
 *
 * It takes the manager as an argument rather than importing it, so the dependency runs one way —
 * `dndManager.ts` may import this module and this module must not import that one.
 */
export function installCardCountPreview(manager: DragDropManager): () => void {
  let chip: HTMLElement | null = null;

  const place = (at: { x: number; y: number }) => {
    if (!chip) return;
    chip.style.left = `${at.x + OFFSET.x}px`;
    chip.style.top = `${at.y + OFFSET.y}px`;
  };

  const off = [
    manager.monitor.addEventListener("dragstart", ({ operation }) => {
      const count = operation.source ? readDragGroup(operation.source.data).length : 0;
      // Below two keeps the drag exactly as it was: the preview is a picture of the card, which
      // is better than any chip could be, and `1 card` tells the reader what they can see.
      if (count < 2) return;
      chip = document.createElement("div");
      chip.setAttribute(CARD_COUNT_CHIP, "");
      chip.setAttribute("aria-hidden", "true");
      chip.textContent = cardCountLabel(count);
      Object.assign(chip.style, {
        position: "fixed",
        // Above the drag preview, which the library gives `z-index: calc(infinity)` — clamped by
        // the engine to 2147483647, measured in the built app on 2026-08-27. There is nothing
        // above that, so the chip is drawn *after* it in the document instead and wins on order.
        zIndex: "2147483647",
        pointerEvents: "none",
        background: "var(--color-bg, oklch(0.16 0.01 270))",
        color: "var(--color-accent, oklch(0.75 0.12 85))",
        border: "1px solid var(--color-accent, oklch(0.75 0.12 85))",
        borderRadius: "6px",
        padding: "3px 8px",
        font: "600 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      });
      document.body.append(chip);
      place(operation.position.current);
    }),
    manager.monitor.addEventListener("dragmove", ({ operation }) => {
      place(operation.position.current);
    }),
    // Dropped or cancelled — the library ends both the same way, so the chip goes without this
    // hearing an Escape.
    manager.monitor.addEventListener("dragend", () => {
      chip?.remove();
      chip = null;
    }),
  ];

  return () => {
    for (const stop of off) stop();
    chip?.remove();
    chip = null;
  };
}
