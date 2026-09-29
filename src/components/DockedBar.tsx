import type { ReactElement, ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { isTextField } from "@/components/menu/useContextMenu";
import { DOCKED_BAR_HEIGHT_PX, DOCKED_BAR_SHELL_PAD_PX, DOCKED_SHADOW } from "@/lib/dockedBar";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { dockBar } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * The two pieces a bar docked across the top of `main` is built from, shared by the deck
 * editor's `DeckHeaderBar` and the filter quick bar (spec 2026-09-29). They lived in
 * `DeckHeaderBar.tsx` until the second bar needed them, and moved rather than being copied so the
 * two bars cannot come to disagree about the box or about when a caret holds one down.
 */

/**
 * Whether a caret arriving on this element should keep the bar drawn after the header docks.
 *
 * **In one of the two fields, always** — that is the case the hold exists for: a reader typing a
 * card name scrolls up to look at the deck, and a field that left the DOM under them would drop
 * the caret on `<body>` mid-word. **On a button, only when the keyboard put it there.** A mouse
 * press focuses a button as a side effect in Chromium on Windows, so holding on *any* caret would
 * keep the bar pinned over a docked header after nearly every press — over the header's own
 * actions row, until the reader happened to click somewhere else — for a caret the reader never
 * asked for and cannot see. A keyboard reader's caret is the one they steer by, so it holds.
 *
 * "The keyboard put it there" is `lib/keyboardModality`'s answer and not `:focus-visible`, for
 * the reason that module is written: it is decided when focus *moves*, which is exactly when this
 * is asked. Its attribute is written by a `window` capture listener, so it already describes this
 * move by the time React's `onFocus` hears it.
 */
export function holdsBar(target: EventTarget | null): boolean {
  return isTextField(target) || document.documentElement.hasAttribute(KEYBOARD_MODALITY_ATTR);
}

/**
 * The bar's own box: `PopupPanel`'s exit handling on the {@link dockBar} preset.
 *
 * Not `PopupPanel` itself, whose `popup` preset scales — see {@link dockBar} for why a box as
 * wide as the page must not. What it keeps from that component is the half a test leans on: on
 * the way out it leaves the accessibility tree and stops taking the pointer, so a bar fading away
 * already reads as gone rather than as a second, stale toolbar.
 */
export function DockedPanel({ children }: { children: ReactNode }): ReactElement {
  const present = useIsPresent();
  return (
    <motion.div
      {...dockBar}
      aria-hidden={present ? undefined : true}
      // From the constants rather than as classes, so the clearance a neighbour is offset by and
      // the box it is offset from are one set of numbers — see {@link DOCKED_BAR_SHELL_PAD_PX}.
      style={{
        top: -DOCKED_BAR_SHELL_PAD_PX,
        left: -DOCKED_BAR_SHELL_PAD_PX,
        right: -DOCKED_BAR_SHELL_PAD_PX,
        height: DOCKED_BAR_HEIGHT_PX,
        paddingInline: DOCKED_BAR_SHELL_PAD_PX,
      }}
      className={cn(
        // Docked: square, flush to the ribbon above and to both edges of the scroller, with one
        // hairline under it where it meets the deck. Opaque, because a bar the cards can be seen
        // through is the complaint this box answers.
        "absolute border-b border-border bg-surface py-2",
        DOCKED_SHADOW,
        !present && "pointer-events-none",
      )}
    >
      {children}
    </motion.div>
  );
}
