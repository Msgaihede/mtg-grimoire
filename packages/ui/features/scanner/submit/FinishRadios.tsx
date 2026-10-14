import { useId } from "react";
import { FILTER_CONTROL, FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import { FINISH_LABEL, FINISHES, parseFinishes, type Finish } from "@/lib/finish";
import type { CardSummary } from "@/lib/ipc";
import { radioKeys } from "@/lib/radioGroup";
import { cn } from "@/lib/utils";
import { FINISH, FINISH_NEEDS_CARD, ONE_FINISH } from "./submitText";

/**
 * The finishes a printing is offered in. An empty or unreadable list is **unknown**, never "none"
 * (`CardSummary.finishes`), so it offers all three and selects none of them.
 */
export function finishesOf(card: CardSummary): readonly Finish[] {
  const listed = parseFinishes(card.finishes);
  return listed.length > 0 ? listed : FINISHES;
}

/**
 * *Finish* — the ways the chosen printing was sold, as a radio group.
 *
 * **Only what the printing comes in is offered**, as everywhere a finish is chosen in this app:
 * the engine refuses a finish the printing does not have, and a chip that can only be refused is
 * a question with a wrong answer in it. Before there is a printing, all three are drawn out of
 * reach with a sentence saying what they are waiting for — the group does not appear from nowhere
 * under the reader's press, and the dialog's shape says from the start that there are two things
 * to answer.
 *
 * The chips are the filter row's own (`FilterChips`), which is what the desktop's add-to-collection
 * popup draws a finish with, and they carry the 44px floor for the phone. The keys are
 * `radioGroup.ts`'s: one Tab stop, and the arrows choose.
 *
 * Shared by *Send scan…* and the tray's *Add a card…* (`reader/AddCardDialog.tsx`), which ask the
 * same second question about a printing the reader picked by hand.
 */
export function FinishRadios({
  chosen,
  finish,
  onFinish,
}: {
  chosen: CardSummary | null;
  finish: Finish | null;
  onFinish: (finish: Finish) => void;
}) {
  const id = useId();
  const waiting = chosen === null;
  const offered = waiting ? FINISHES : finishesOf(chosen);
  const pick = (next: Finish | null) => {
    if (!waiting && next !== null) onFinish(next);
  };
  const note = waiting ? FINISH_NEEDS_CARD : offered.length === 1 ? ONE_FINISH : "";

  return (
    <div className="flex flex-col gap-2">
      <p id={`${id}-label`} className="text-sm font-medium text-text">
        {FINISH}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-note`}
        aria-disabled={waiting || undefined}
        className="flex flex-wrap gap-1.5"
      >
        {offered.map((one, index) => (
          <button
            key={one}
            type="button"
            role="radio"
            aria-checked={finish === one}
            // Out of reach rather than gone from the tab order, like every greyed chip here.
            aria-disabled={waiting || undefined}
            {...radioKeys<Finish | null>(offered, finish, pick, index)}
            onClick={() => pick(one)}
            className={cn(
              FILTER_CONTROL,
              FILTER_FOCUS,
              "px-3",
              filterChipState(finish === one, waiting),
              // The two responses the state's classes cannot reach — `ToggleChip` carries the
              // same pair for the same reason.
              waiting && "hover:text-dim active:scale-100",
            )}
          >
            {FINISH_LABEL[one]}
          </button>
        ))}
      </div>
      <p id={`${id}-note`} className="min-h-4 text-xs text-dim">
        {note}
      </p>
    </div>
  );
}
