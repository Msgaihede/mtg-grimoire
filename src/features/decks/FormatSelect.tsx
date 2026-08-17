import { useEffect, useMemo } from "react";
import { FOCUS } from "@/lib/focus";
import type { DeckGame } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { ANY_GAME, GAME_OPTIONS, pickerFormats, useFormatSpecs } from "./useFormatSpecs";

/** The one `<select>` recipe both controls in this file draw, and the settings form's third. */
export const SELECT = cn(
  "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
  "disabled:opacity-60",
  FOCUS,
);

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
 * `pickerFormats(specs)` — `format_specs` filtered to `enabled_in_picker`, which is the whole of
 * why Future Standard, a format you can test a card against but cannot build for, is not
 * offered, and then **alphabetically by display name** rather than in the seed's `sort_order`,
 * because a reader looking for Modern looks under M — and the empty case answers
 * {@link DEFAULT_FORMAT} in words. Copied into a second dialog those three become three things
 * to keep in step; here they are one.
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
  game = ANY_GAME,
}: {
  /** The `<select>`'s own id, so the caller can keep one `useId` prefix for its whole form. */
  id: string;
  value: string;
  onChange: (formatKey: string) => void;
  /**
   * Which platform to narrow the list to. Absent is {@link ANY_GAME}, which narrows nothing —
   * so a host that has not grown a game control of its own is unchanged.
   *
   * **No `keep` goes with it, and that is this control's situation rather than a shortcut**:
   * it is only ever asked before a deck exists, so there is no format already chosen for the
   * filter to drop. The two surfaces that edit a deck pass `keep` themselves.
   */
  game?: DeckGame;
}): React.JSX.Element {
  const { specs } = useFormatSpecs();
  const picker = useMemo(() => pickerFormats(specs, null, game), [specs, game]);

  /**
   * Keep the caller's value among the options.
   *
   * **This control owns the list, so it owns "the value has to be in it".** A controlled
   * `<select>` whose `value` matches no option shows its *first* row while still reporting the
   * old one — so a reader who picks Modern and then sets the game to Arena would be looking at
   * `Alchemy` and importing into a Modern deck. Reporting the change up is what keeps the host's
   * state and the screen the same answer.
   *
   * **Not while the list is empty.** That is the one launch where `format_specs` has not
   * answered yet, the select is drawing its `Casual` fallback, and there is nothing to repair
   * *to* — a write here would overwrite the reader's format with a placeholder.
   *
   * The first row rather than {@link DEFAULT_FORMAT}: it is what the select is already showing,
   * so the value moves to agree with the screen rather than to a third answer neither showed.
   *
   * **`CreateDeckDialog` solves the same problem by *deriving* instead, and the difference is
   * ownership rather than taste.** That host holds the draft *and* calls `pickerFormats` itself,
   * so it can compute the effective format during render — which React's own lint prefers, and
   * which is non-destructive: narrowing and un-narrowing leaves the reader's pick intact. Here
   * the state is the host's and the list is this component's, and the host cannot see the list.
   * Reporting up is the only way the two can agree, and the cost is the real one — a game
   * change the reader takes back does not restore the format they had.
   */
  useEffect(() => {
    if (picker.length === 0) return;
    if (picker.some((f) => f.key === value)) return;
    onChange(picker[0].key);
  }, [picker, value, onChange]);

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
        className={SELECT}
      >
        {picker.length === 0 ? (
          <option value={DEFAULT_FORMAT}>Casual</option>
        ) : (
          picker.map((f) => (
            <option key={f.key} value={f.key}>
              {f.name}
            </option>
          ))
        )}
      </select>
    </>
  );
}

/**
 * "Which platform is this deck for" — the control that narrows every format picker beside it.
 *
 * Four fixed rows out of {@link GAME_OPTIONS}, so unlike {@link FormatSelect} it mounts no
 * query and has no empty state: the vocabulary is a constant, not a seeded table. That is the
 * whole difference between the two controls, and it is why this one never greys.
 *
 * **It changes no format.** Setting a game narrows a list; the deck keeps the format it has,
 * folded back into that list by `pickerFormats`' `keep`. A control that re-formatted a deck as
 * a side effect of a filter would be the one thing a reader could not undo by looking at it.
 */
export function GameSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: DeckGame;
  onChange: (gameKey: DeckGame) => void;
}): React.JSX.Element {
  return (
    <>
      <label htmlFor={id} className="mb-1 block text-xs text-dim">
        Game
      </label>
      <select
        id={id}
        value={value}
        // The cast is safe by construction and is the narrowing a native `<select>` cannot do
        // for itself: every option below is written out of `GAME_OPTIONS`, so the only strings
        // this handler can ever meet are that list's own keys.
        onChange={(e) => onChange(e.target.value as DeckGame)}
        className={SELECT}
      >
        {GAME_OPTIONS.map((g) => (
          <option key={g.key} value={g.key}>
            {g.name}
          </option>
        ))}
      </select>
    </>
  );
}
