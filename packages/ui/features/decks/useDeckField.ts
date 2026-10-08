import { useCallback, useEffect, useRef, useState } from "react";
import { useIsPresent } from "motion/react";

/**
 * The **edit host's** hook, and deliberately not the form's.
 *
 * `DeckSettingsForm` is controlled: it holds no draft, writes nothing, and hands every change
 * up. What it hands up has to land somewhere, and for a surface where each field writes as soon
 * as the reader is finished with it, "somewhere" is one of these per text field —
 * `DeckSettingsDialog` keeps three. `CreateDeckDialog` keeps none, because there is nothing to
 * write until the deck exists.
 *
 * It lives in its own file for that reason: a hook the form must not use has no business sitting
 * inside the form.
 */

/**
 * A text field that writes what it holds when the reader is finished with it.
 *
 * Three of them here, and all three need the same two things `DeckEditor`'s name field needed:
 *
 * * **a draft plus a ref.** Enter commits and then blurs, and the blur handler commits again —
 *   in the same tick, with the draft state still holding the closure's value, which is one edit
 *   written twice. The ref is cleared *where it is read*, so the second call has nothing to
 *   send.
 * * **a commit on the way out.** Every other control in this dialog has already written by the
 *   time the reader reaches for the scrim; a field that threw its paragraph away would be the
 *   one control that punishes closing. So closing commits too — through the same ref, so a
 *   field that was blurred normally writes once and not twice.
 *
 * ## "On the way out" is the *close*, not the unmount, and that is a decision
 *
 * It used to be the unmount, which was the same instant. It is not any more: the panel now
 * outlives the flag by the length of its fade, so an unmount commit would hold a paragraph the
 * reader typed for a fifth of a second after they asked for it to be put away — a **write
 * waiting on an animation**, which is a coupling with nothing to recommend it and one real
 * hazard behind it: whatever else takes the write connection in that window goes first, and a
 * dialog dismissed as part of leaving the deck entirely would be racing its own editor's
 * teardown. So the commit is driven by `useIsPresent`, which is false on the render that starts
 * the exit — the same instant `open` went false upstairs.
 *
 * The unmount cleanup stays as a backstop and cannot double-write: `commit` clears the ref
 * **where it reads it**, so the second caller has nothing to send. It is what covers the paths
 * that have no exit at all — the editor unmounting under the dialog, a story or a test
 * rendering the panel outside an `AnimatePresence` (where `useIsPresent` is `true` forever,
 * which is exactly the answer that leaves those callers on the old behaviour).
 *
 * `blankIsNoop` is the name's: the backend refuses a blank name in words, and a name is not
 * something a deck should be able to lose by tabbing through the field. A description or a set
 * of notes emptied on purpose *is* an edit, and `coalesce(?n, column)` writes an empty string
 * happily — what no patch can do is put the column back to NULL, which is a distinction nothing
 * on screen can see.
 */
export function useDeckField(
  current: string,
  write: (value: string) => void,
  { blankIsNoop = false }: { blankIsNoop?: boolean } = {},
) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  const present = useIsPresent();

  const commit = useCallback(() => {
    const value = ref.current;
    ref.current = null;
    setDraft(null);
    if (value === null) return;
    const trimmed = value.trim();
    if (blankIsNoop && trimmed === "") return;
    if (trimmed === current) return;
    write(trimmed);
  }, [blankIsNoop, current, write]);

  // The latest-ref pattern, and it has to be one: the cleanup below runs with an empty
  // dependency list — it is an *unmount* commit, not a re-commit on every keystroke — so
  // without this it would call the very first render's `commit`, which closes over the empty
  // draft and would write nothing at all.
  const latest = useRef(commit);
  useEffect(() => {
    latest.current = commit;
  });
  // The close, and then the unmount behind it. Both go through `latest` and both are the same
  // idempotent call; see this hook's doc for why there are two.
  useEffect(() => {
    if (!present) latest.current();
  }, [present]);
  useEffect(() => () => latest.current(), []);

  return {
    value: draft ?? current,
    onChange: (value: string) => {
      ref.current = value;
      setDraft(value);
    },
    onBlur: commit,
  };
}
