import { useCallback, useRef, useState, type ReactElement } from "react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * The narrowest the deck's name field may be squeezed to.
 *
 * 10rem, which at the field's `text-xl` is about thirteen characters — enough to tell two decks
 * apart, and enough that the caret has somewhere to go. Below that the field stops being a
 * field: measured in the shipped window, with nothing holding it, it collapsed to **18px**,
 * which draws as a sliver with no glyph in it at all.
 *
 * A floor rather than a fixed width, because the field is still the row's flexible child: it
 * takes every pixel the chrome beside it does not need, and 10rem is only what it falls back on
 * when there are none. At the app's own 1280×800 it is never reached — the field measures 238px
 * there — which is the point of the number: **10rem is the largest floor that still lets the
 * whole header sit on one line at 1280.** At 12rem the row wrapped even with the Theory switch
 * off, costing 44px of deck height in the common case to protect a width that was never at
 * risk. Measured both ways; see the report.
 *
 * Written out whole rather than built from a constant — Tailwind scans source text for class
 * names, and one assembled at runtime emits no rule at all. It travels with the field rather
 * than staying in `DeckEditor.tsx`, for that same reason read one step further: the class is a
 * fact about *this* control, and `DeckEditor.test.tsx` asserts the literal `min-w-40` on it.
 */
const NAME_FLOOR = "min-w-40";

/**
 * What the deck is called, as a field the reader types in.
 *
 * **It returns the bare `<input>` and must go on doing so.** It is the flexible child of the
 * editor's identity row, so a wrapper `<div>` would take the flex item's place and leave the
 * field's own `flex-1` and {@link NAME_FLOOR} governing nothing — and it would do that
 * silently, because `DeckEditor.test.tsx` walks `name.parentElement` to reach the row and
 * `identity.parentElement.lastElementChild` to reach the controls beside it. Both assertions
 * would go on passing about two different elements.
 *
 * **There is no Save**, here or anywhere in this editor: the row in the database *is* the draft,
 * so the name is committed the moment the reader is done with the field — on blur, and on Enter
 * without waiting for the caret to leave.
 *
 * The whole of what this owns is the draft, which is why it is a component rather than markup in
 * the editor: five locals (`nameDraft`, `draftRef`, `typeName`, `dropDraft`, `commitName`) that
 * nothing else in a 3 300-line body reads. No state was lifted to make this — the editor never
 * read them either.
 */
export function DeckNameField({
  name,
  onRename,
}: {
  /** What the deck is called *now*, straight off the loaded row. The field draws this whenever
   *  there is no draft, and it is what a commit compares against so that re-typing the name a
   *  deck already has writes nothing. */
  name: string;
  /**
   * The reader has settled on a new name.
   *
   * Only ever called with a non-blank name that differs from {@link name} — a blank is not a
   * rename and this field does not send one, which is the same answer the backend gives in
   * words. So the host wires this straight to `deck.update` with nothing to re-check.
   */
  onRename: (name: string) => void;
}): ReactElement {
  /** What is in the field while it is being typed in, or `null` when the field is simply the
   *  deck's name (`QuantityStepper`'s draft, for its reason). */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  /**
   * The same draft, readable *now*.
   *
   * Enter commits and then blurs, and the blur handler commits again — in the same tick, with
   * `nameDraft` still holding the closure's value, which is one rename written twice. A ref is
   * cleared where it is read, so the second call has nothing to send.
   */
  const draftRef = useRef<string | null>(null);
  const typeName = useCallback((value: string) => {
    draftRef.current = value;
    setNameDraft(value);
  }, []);
  const dropDraft = useCallback(() => {
    draftRef.current = null;
    setNameDraft(null);
  }, []);

  /** Whatever is half-typed, the field goes back to standing for the deck's name. A blank is
   *  not a rename: the backend refuses it in words, and a name is not something a deck can lose
   *  by tabbing through it. */
  const commitName = useCallback(() => {
    // The ref rather than `nameDraft`, and that is the whole reason the ref exists — see it.
    const draft = draftRef.current;
    dropDraft();
    if (draft === null) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) return;
    onRename(trimmed);
  }, [dropDraft, name, onRename]);

  return (
    <input
      aria-label="Deck name"
      // **`size={1}` is load-bearing, and it is not about the drawn width.** A text
      // input with no `size` defaults to 20 characters, and *that* is what a flex
      // container reports as its min-content — at this field's `text-xl` it measured
      // over 240px, which is what pushed the whole row of deck controls onto a second
      // line at 1280 even with the Theory switch off. With `size={1}` the intrinsic
      // width is a character and {@link NAME_FLOOR} is the only floor left, which is
      // the one this file actually chose. The width you see is the flex layout's.
      size={1}
      value={nameDraft ?? name}
      onChange={(e) => typeName(e.target.value)}
      onBlur={commitName}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commitName();
          e.currentTarget.blur();
        }
        // **Only when there is something to revert**, and **on the input rather than on
        // `window`.** Escape consumed here is Escape the card pane never sees — the pane is
        // an `"outer"` layer listening on `window` in the bubble phase, and a handler at the
        // event's own target has already run by then. This is neither an `"inner"` layer nor
        // a capture-phase listener, and moving it to `window` would make it one: it would
        // then eat presses belonging to whatever is open behind the editor. A field nobody
        // has typed in has nothing to undo, so the press belongs to whatever is open behind
        // it; a field that has been typed in owns exactly one press, and the next one is the
        // pane's again.
        // The ref rather than the state, for the reason it exists: two presses inside
        // one tick — a key held down, an autorepeat — both read a `nameDraft` React
        // has not re-rendered yet, and the second would consume a press it has
        // nothing to spend it on. The ref is cleared where it is read.
        if (e.key === "Escape" && draftRef.current !== null) {
          e.preventDefault();
          dropDraft();
        }
      }}
      // Geist, not the display face, for the reason the card pane gives about a
      // card's name: this is *content*, and Cinzel is for view titles and hero copy.
      // Cinzel is also drawn in caps — which in a field you type into means the
      // letters never match the ones being typed.
      className={cn(
        "flex-1 rounded-md border border-transparent bg-transparent px-2 py-1",
        NAME_FLOOR,
        "text-xl font-medium leading-tight",
        "transition-colors duration-150 hover:border-border motion-reduce:transition-none",
        FOCUS,
      )}
    />
  );
}
