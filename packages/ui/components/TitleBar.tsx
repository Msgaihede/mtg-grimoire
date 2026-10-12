import { type ReactNode, useEffect, useState } from "react";
import { Copy, Keyboard, Minus, Square, X } from "lucide-react";
import { CaptionButton } from "@/components/CaptionButton";
import { GrimoireMark } from "@/components/GrimoireMark";
import { KEY_MAP_LABEL, KeyMap } from "@/components/KeyMap";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import {
  SNAP_BUTTON_ID,
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onSnapHover,
  onWindowResized,
  toggleMaximizeWindow,
} from "@/lib/window";
import { cn } from "@/lib/utils";

/** 34px. Windows' own caption is 32 and VS Code's is 35; this sits between them, and the
 *  number is here rather than inline because the snap overlay's rectangle is derived from
 *  this element's box and a change to it moves a native child window. */
const BAR_H = "h-[34px]";
/**
 * Where a full-window surface starts so the caption stays uncovered: {@link BAR_H}'s height, as a
 * `top`. Written out whole beside it for Tailwind's scanner, and moved with it. The goldfish board
 * is the one reader (`LAYER.stage`).
 */
export const BELOW_CAPTION = "top-[34px]";

/**
 * The window's own title bar, drawn by the app rather than by Windows.
 *
 * `decorations: false` in `tauri.conf.json` is what makes this necessary rather than
 * decorative: with the native caption gone, this row is the only way to move, maximize or
 * close the window, so a failure here is an app the reader cannot put down. That is the
 * argument for the wrapper in `packages/ui/lib/window.ts` and for this component being testable at
 * all.
 *
 * **The wordmark is here because it stopped being anywhere else.** The ribbon (gone since 2026-10-11) drew a dim `MTG`
 * and said why in a comment — "the window title bar already says that in full" — which was
 * true of Windows' caption and is now this component's job. So the mark moved up and grew to
 * the full name, and the ribbon's first slot is the view title. It is a *lockup* now rather
 * than a wordmark alone: `GrimoireMark` leads it, at the one size in the app small enough to
 * get the simplified variant.
 *
 * **Four drag regions, not one.** `data-tauri-drag-region` does not inherit: Tauri reads it
 * off the element under the pointer and nothing else, so a child without it is a hole in the
 * grab area. The row carries it (that is the empty middle), and so do the lockup's wrapper
 * and the wordmark inside it. The buttons deliberately do not — a drag region swallows the
 * click.
 *
 * **A fourth button, and it is not a window verb.** {@link KeyMap} is here because the caption
 * is the one row on screen in every view, in the editor, and over every modal — the same
 * argument `LAYER.caption` makes about the rung — so the list of what the keyboard does is
 * reachable from wherever a reader wondered. It sits *before* Minimize rather than after Close:
 * the three window verbs are a run the reader's hand knows from every other window on the
 * desktop, and inserting anything into it or after it would put a non-destructive button where
 * Close has always been. The 46px square, the missing radius and the missing press-scale all
 * stay — a rounded chip in a row of three square full-height buttons reads as foreign, and the
 * coherence of the row outranks a corner rule written about Fitts's law.
 *
 * **The app's status rides here too, since 2026-10-11** — `children`, which `AppShell` fills
 * with `ChromeStatus`: the status line, the device-sync marker and Refresh, right-aligned
 * against the keyboard map. The 56px ribbon and its page heading that used to carry them are
 * gone; the mana line sits directly under this row now, and the page directly under that.
 *
 * **`windowControls` is false wherever a browser or an OS owns the frame** — the light
 * edition's desktop face, in a browser tab or on a tablet. There this row is a header band of
 * the same height carrying the same lockup, status and keyboard map, minus the three window
 * verbs, and minus every drag region (nothing there can be dragged, and nothing there should
 * claim it can).
 */
export function TitleBar({
  children,
  windowControls = true,
}: {
  /** The app's status run, drawn right-aligned before the keyboard map. */
  children?: ReactNode;
  windowControls?: boolean;
}) {
  // Shared with `AppShell`, which binds `F1`, because the key and the panel are in two
  // components — see the store's own note on the flag.
  const keyMapOpen = useAppStore((s) => s.keyMapOpen);
  const setKeyMapOpen = useAppStore((s) => s.setKeyMapOpen);
  const dragRegion = windowControls ? { "data-tauri-drag-region": true } : {};

  return (
    // `LAYER.caption` is what keeps this row drawn, and it is not decoration: without it the
    // window has no caption at all for the length of a first sync, and none while any modal is
    // open. Both of those surfaces are `fixed inset-0`, and this row is a flex item carrying no
    // z-index of its own — a positioned element paints over non-positioned content in the same
    // stacking context however small its number, so the bar was never competing. It needs no
    // `position` of its own: a z-index on a flex item creates a stacking context whatever its
    // position. The reasoning, and the measurement it came from, are on the rung itself.
    // **No `border-b` since the mana line moved directly beneath it**: the line is the chrome's
    // edge now, and a hairline over a 2px rule is two edges a pixel apart.
    <div
      {...dragRegion}
      className={cn(
        "flex shrink-0 items-center justify-between gap-4 bg-surface pl-3",
        BAR_H,
        LAYER.caption,
      )}
    >
      {/* The mark and the wordmark are one lockup, and this wrapper exists for the drag region
          rather than for the layout — a flex row of two items in a row that is already flex
          would otherwise be a box for nothing. `data-tauri-drag-region` does not inherit, so
          without the attribute here the `gap-2.5` between the two is a 10px strip of caption
          the reader can press while the window sits still. That is the worst shape a bug can
          take in this row: it is intermittent by geometry, so nobody reports it, they just
          try again a few pixels to the right. The wordmark keeps its own attribute for the
          same reason — this wrapper is its parent to CSS and to nothing else.

          `gap-2.5` (10px) rather than the 8px an icon and a label usually take. The wordmark
          is set at `tracking-[0.2em]`, which opens the name into a spread field rather than a
          tight block, and a gap sized for a tight label reads as *narrower* than the air
          inside the word it sits next to — so the mark stops being adjacent to the name and
          starts looking like the first glyph of it.

          `pl-3` rather than the `pl-4` this row carried while the wordmark led it alone, and
          two things point the same way. The artwork is centred on the **book** and lets the
          clasp and the ribbon reach into the margin (`logos/README.md`), so the mark carries
          its own clear space before any ink — at `size={20}` the front board's outer stroke
          lands about 3.3px in from the left of the box, which at `pl-4` would start the
          lockup ~19px from the window's edge and visibly further in than the bare wordmark
          began. And the sidebar directly below this row is `p-3`, so 12px is where that
          column's entries start: the mark and the first nav entry now share a left edge down
          the window instead of missing it by 4px. */}
      <div {...dragRegion} className="flex shrink-0 items-center gap-2.5">
        {/* `size={20}` for the wordmark's own arithmetic — a 34px row leaves 7px above and
            below — and that number does a second job: it is under `GrimoireMark`'s 24px
            detail floor, so the component picks the simplified variant here without being
            asked. That is the whole reason it takes a pixel size instead of a variant flag.
            The full artwork's casting circle, runes and clasp rivets fill in below about 24px
            (`logos/README.md`), and a caption bar drawing them would be a gold smudge that
            looks deliberate — invisible in jsdom, and the kind of thing nobody thinks to go
            and check in the window.

            `text-accent` rather than the wordmark's `text-dim`, and that is a deliberate
            exception to the rule `SyncProgress.tsx` states beside the same name: "Dim rather
            than gold — gold means 'you can act on this', and a name is not an action." That
            rule governs **type and controls**, where gold is a verb the reader has learnt
            from every other gold thing in the chrome. A mark is a picture: nobody reads a
            book glyph as something to press, and there is no control within 46px of it to
            confuse it with. The colour is also specified rather than chosen — the logo
            package sets it in the same breath as the geometry ("gold `#D1A84B`
            (--color-accent)") — so extending the type rule to the product's own logo would
            mean the app may never draw that logo in its own colour, which is a rule about
            identity that nobody meant to write.

            `pointer-events-none` so the element under the pointer resolves to the wrapper
            above: Tauri hit-tests and then asks *that* element for the attribute, and an
            `<svg>` without one is a 20×20 dead spot in the middle of the grab area. It is
            free here only because the mark draws no `<title>` and binds no tooltip —
            `pointer-events` inherits, so a hint inside a `pointer-events-none` subtree is one
            that can never be shown. */}
        <GrimoireMark size={20} className="pointer-events-none text-accent" />

        {/* Cinzel, and the one place in the chrome it is allowed below 18px — see the note in
            `index.css`, which fences the display face at "never below 18px, which is the whole
            of Cinzel's brief". A caption bar is 34px tall and a 20px wordmark in it leaves 7px
            above and below, so the rule and the row cannot both be honoured. What pays for the
            exception is that this is a *wordmark* rather than a title: it is the product's name
            in its own face, set once, never read as interface text, and `tracking-[0.2em]` is
            what keeps it legible at 13px where Cinzel's thin strokes would otherwise close up.
            `select-none` because a title bar the reader can accidentally highlight while
            dragging the window is a title bar that fights them. */}
        <span
          {...dragRegion}
          className="select-none font-heading text-[13px] leading-none tracking-[0.2em] text-dim"
        >
          MTG GRIMOIRE
        </span>
      </div>

      <div {...dragRegion} className="flex h-full min-w-0 items-center">
        {children}
        {/* The panel is rendered inside `KeyMap`'s own box, immediately after the button it
            belongs to — which is what makes the pair a disclosure rather than a dialog, and
            what gives the placement something to measure. See {@link KeyMap}. */}
        <KeyMap>
          <CaptionButton
            label={KEY_MAP_LABEL}
            Icon={Keyboard}
            expanded={keyMapOpen}
            onSelect={() => setKeyMapOpen(!keyMapOpen)}
          />
        </KeyMap>
        {windowControls && <WindowControls />}
      </div>
    </div>
  );
}

/**
 * Minimize, Maximize/Restore and Close — the three window verbs, and the two window reads they
 * need. A component of its own so the light edition, which draws none of them, never asks a
 * window it does not own whether it is maximized.
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  // Whether the pointer is inside the native Snap Layouts overlay. See `SNAP_HOVER_EVENTS`:
  // on Windows 11 the maximize button is underneath a transparent Win32 child window, so its
  // CSS `:hover` never fires and this is the only signal that the pointer is on it.
  const [snapHover, setSnapHover] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => {
      void isWindowMaximized().then((next) => {
        if (live) setMaximized(next);
      });
    };
    read();
    // Every resize, not just a maximize — there is no `onMaximized`. Re-reading rather than
    // toggling is what keeps an edge-drag from flipping the glyph to the wrong one.
    const stop = onWindowResized(read);
    return () => {
      live = false;
      void stop.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const stop = onSnapHover(setSnapHover);
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  return (
    <>
      <CaptionButton label="Minimize" Icon={Minus} onSelect={() => void minimizeWindow()} />
      {/* `id` is read by the native overlay, which finds this button by DOM id and parks
            itself over its rectangle. The constant is shared with the Rust side through
            `SNAP_BUTTON_ID` because a mismatch fails silently in both directions.

            **Two glyphs, one lucide family**: `Square` is one frame, `Copy` is two offset
            frames — the same 24-grid and the same 2px round-cap stroke as every other icon in
            this app, which is what "restore" has meant since Windows 3.1 drawn in the set the
            sidebar and the ribbon already use. */}
      <CaptionButton
        id={SNAP_BUTTON_ID}
        label={maximized ? "Restore Down" : "Maximize"}
        Icon={maximized ? Copy : Square}
        forceHover={snapHover}
        onSelect={() => void toggleMaximizeWindow()}
      />
      <CaptionButton label="Close" Icon={X} danger onSelect={() => void closeWindow()} />
    </>
  );
}
