/**
 * The two class recipes a deck form is drawn from — a field's caption, and the field.
 *
 * They exist as a module because **three files grew a copy of each** the day
 * `DeckSettingsDialog` was split into `DeckSettingsForm` and `DeckCoverPicker`, and a duplicated
 * class list is worse than a duplicated function: nothing type-checks it, nothing sweeps it, and
 * the first divergence is a caption a shade smaller in one column than in the next — which reads
 * as a rendering bug rather than as an edit somebody made.
 *
 * **Its own file rather than `cardControl.tsx`**, which is the other module here holding shared
 * class recipes. That one's subject is *a deck card drawn as a control*
 * — its doc says so, and it carries the drag registration, the drop target, the stepper and the
 * accessible-name contract with it, pulling in `@atlaskit/pragmatic-drag-and-drop` and
 * `QuantityStepper`. A caption over a text box is not a deck card, and a dialog that asks for a
 * deck's *name* should not import the drag-and-drop machinery to find out how to draw the label.
 * Two small modules with one subject each, rather than one with two.
 *
 * **`FOCUS` and `FOCUS_INSET` were the counter-example this paragraph never applied itself to,
 * and they left on 2026-08-16**: 22 modules imported those two strings out of `cardControl.tsx`
 * and nothing else, dragging the whole drag-and-drop graph in behind them. They are
 * `src/lib/focus.ts` now, which imports nothing at all.
 */
import { cn } from "@/lib/utils";

/** A field's label: 11px and dim, the direction's caption size, used for every one in these
 *  forms. Dim is `text-dim` and only that — `src/lib/tokens.test.ts` sweeps for the old
 *  spelling, which still compiles and paints text in the surface colour. */
export const CAPTION = "block text-[0.6875rem] text-dim";

/** A text field, the shape `CreateDeckDialog` set for this app's inputs — and now the shape both
 *  deck dialogs share, which is what put it here. */
export const FIELD = cn(
  "w-full rounded-md border border-border bg-bg px-2.5 text-sm text-text",
  "focus:border-accent focus:outline-none",
);
