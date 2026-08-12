import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { useFormatSpecs } from "./useFormatSpecs";

/**
 * What a new deck's format is until the reader says otherwise — `decks.format_key`'s own DDL
 * default and `deck::DEFAULT_FORMAT`, spelled here because the picker has to *select* something
 * before the seeded table has answered.
 *
 * Casual rather than the first row of the list: Casual caps nothing and is judged against no
 * card pool, so a deck that has not been given a format yet is not a deck full of complaints.
 *
 * It lives beside the one control that reads it — which is now {@link FormatSelect} rather than
 * `CreateDeckDialog`, because two dialogs ask this question and a constant next to one of them
 * is a constant the other has to reach across for.
 */
export const DEFAULT_FORMAT = "casual";

/**
 * "What is this deck for", as the one control that asks it.
 *
 * **Lifted out of `CreateDeckDialog` when the import dialog needed the same question**, and the
 * lift is worth it for the three rules inside rather than for the markup: the list is
 * `format_specs` in its own `sort_order` **filtered to `enabled_in_picker`** — which is the whole
 * of why Future Standard, a format you can test a card against but cannot build for, is not
 * offered — and the empty case answers {@link DEFAULT_FORMAT} in words. Copied into a second
 * dialog those three become three things to keep in step; here they are one.
 *
 * The name field beside it in both dialogs is deliberately **not** lifted with it. That one is a
 * labelled `<input>` and carries no rule at all, and the two dialogs already disagree about it —
 * this one starts empty, the import's starts on whatever the pasted file called the deck.
 *
 * `useFormatSpecs` is mounted here, inside the surface that draws the control, so a dialog
 * nobody has opened mounts no query. It is cached for the session, so reopening costs nothing.
 */
export function FormatSelect({
  id,
  value,
  onChange,
}: {
  /** The `<select>`'s own id, so the caller can keep one `useId` prefix for its whole form. */
  id: string;
  value: string;
  onChange: (formatKey: string) => void;
}): React.JSX.Element {
  const { specs } = useFormatSpecs();
  const picker = useMemo(() => specs.filter((s) => s.enabledInPicker), [specs]);

  return (
    <>
      <label htmlFor={id} className="mb-1 block text-xs text-dim">
        Format
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // The seeded table is read once per session and is normally already in hand by the time
        // a dialog opens; on the one launch where it is not, the select still has to *say*
        // something, and what it says is what it would create. The one place a real `disabled`
        // is right on a control that greys: there is no reader input to make it grey, and a
        // select with a single option is not a choice to keep in the tab order.
        disabled={picker.length === 0}
        className={cn(
          "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
          "disabled:opacity-60",
          FOCUS,
        )}
      >
        {picker.length === 0 ? (
          <option value={DEFAULT_FORMAT}>Casual</option>
        ) : (
          picker.map((s) => (
            <option key={s.key} value={s.key}>
              {s.displayName}
            </option>
          ))
        )}
      </select>
    </>
  );
}
