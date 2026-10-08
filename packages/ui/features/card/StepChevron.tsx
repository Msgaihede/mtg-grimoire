import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { type CardWalkStop } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * One step control, drawn in the room {@link Dialog}'s `flanks` reserved beside the panel.
 *
 * **`disabled` and not `aria-disabled`, which is the reverse of this app's usual rule** and is
 * `QuantityStepper`'s exception rather than a new one: that rule is for a control that greys as
 * the reader types, where leaving the tab order under their hands is what makes it wrong. A
 * chevron at the end of the walk has nothing left to do at all — there is no next card, and no
 * keystroke made in this dialog can produce one — so holding a tab stop buys the caret a place to
 * stop and no action to take there. It is also the state `trapTab` already reads: it filters
 * `disabled` out of the cycle, so the end of a walk costs Tab one stop rather than swallowing a
 * wrap.
 *
 * **Both chevrons are drawn whenever either is**, one of them greyed, rather than the ends of the
 * walk dropping their control. The pair is positioned against the panel's edges, so a chevron that
 * came and went would move nothing on screen — but the *first* step of a walk would then be the
 * moment a second control appeared under the reader's pointer, which is exactly where they are
 * pointing.
 *
 * The name says what the press does, **which list it does it in, and what it will land on**,
 * because a chevron says none of the three: `Next card in the deck, Lightning Bolt`. The list is
 * the walk's own `label` rather than a constant here, which is the whole of what that field is
 * for — this same control is drawn over the collection and the wishlist, and "in the deck" there
 * would be the one part of the feature that lies. It is the `title` as well — a glyph is silent
 * to a pointer too — and the app's own `Move <name>, <n> of <total>` shape, where the comma is
 * what keeps a card's name out of the verb.
 */
export function StepChevron({
  direction,
  listLabel,
  stop,
  onStep,
}: {
  direction: "previous" | "next";
  /** What to call the list being walked, as a noun phrase — `the deck`, `your collection`. */
  listLabel: string;
  /** The card that press lands on, or `null` at that end of the walk. */
  stop: CardWalkStop | null;
  onStep: (stop: CardWalkStop) => void;
}) {
  const Glyph = direction === "previous" ? ChevronLeft : ChevronRight;
  const label = `${direction === "previous" ? "Previous" : "Next"} card in ${listLabel}`;
  const name = stop === null ? label : `${label}, ${stop.name}`;
  const tip = useTooltip();

  return (
    // **Wrapped, where nothing else here is.** `aria-label` already carries the whole of what
    // this button says, so the tooltip is `describes: false` — pure redundancy for a pointer that
    // cannot read the name. At the end of the walk the button is `disabled`, and a `disabled`
    // element fires no pointer events at all: `{...tip()}` bound to the button directly would be
    // silently inert exactly there, which is a real loss (Chromium still draws a native `title`
    // on a disabled control today) rather than a no-op. The wrapper has no box of its own beyond
    // the button's, so hovering the disc still hits *something* — the disabled button is skipped
    // by hit-testing and the span underneath it answers instead — while an enabled button keeps
    // working exactly as before, because entering the span's rect (which the button fills) fires
    // the span's handlers too.
    <span {...tip(name, { describes: false })}>
      <button
        type="button"
        disabled={stop === null}
        aria-label={name}
        onClick={() => {
          // The `disabled` attribute above already refuses this press from both hands; the test is
          // what narrows `stop` for the type checker, and it costs nothing to have both.
          if (stop !== null) onStep(stop);
        }}
        // A filled disc rather than a bare glyph: it is drawn on the scrim, which is the app at 75%
        // — a 1px outline with a card wall showing through it is `QuantityStepper`'s own
        // "disappears over art of any brightness", one layer up. `bg-bg` is the app's own ground, so
        // the disc reads as part of the dialog rather than as part of the view behind it.
        className={cn(
          "grid size-9 place-items-center rounded-full border border-border bg-bg text-dim",
          "hover:text-text disabled:opacity-40 disabled:hover:text-dim disabled:active:scale-100",
          PRESS,
          FOCUS,
        )}
      >
        <Glyph className="size-4" aria-hidden="true" />
      </button>
    </span>
  );
}
