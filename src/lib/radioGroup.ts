/**
 * The keyboard half of a `role="radiogroup"` — one Tab stop, and the arrow keys move the choice.
 *
 * **Every radio group in the app goes through this, and that is the point of it.** Until issue
 * #558 each `role="radio"` was its own Tab stop and the arrows did nothing, on a deliberate
 * argument written at `TagSearchBox` and `DeckBracket`: two groups in one app that answered the
 * arrow keys differently would be worse than one that answered them nowhere. The argument was
 * right about consistency and wrong about which way to be consistent — `PriceHistoryDialog`'s range
 * row already walked on the arrows and was the odd one out, and a reader who knows radio groups
 * from anywhere else presses an arrow and gets nothing. So the pattern is now the WAI-ARIA one,
 * written once, and a new group is consistent by importing it rather than by remembering to be.
 *
 * What it does:
 *
 * * **One stop.** The checked radio is `tabIndex={0}` and the rest `-1`; with none checked, the
 *   first takes the stop so the group is still reachable.
 * * **Arrows choose as they move**, which is what a radio group does — there is no separate
 *   "focused but not chosen" state for a reader to lose track of. Right/Down step forward,
 *   Left/Up back, both wrap; Home and End go to the ends.
 * * **A press with Ctrl, Alt, Meta or Shift is not the group's**, and neither is one another
 *   handler already claimed (`defaultPrevented`, this app's handshake for "that press was mine").
 *
 * **The radios are found in the DOM, not held in refs**, so a call site needs no ref array and
 * no per-button callback ref: the group is `currentTarget`'s closest `radiogroup`, and its
 * radios are in document order — which is `options` order at every call site, because each
 * draws its radios with `options.map`.
 */

import type { KeyboardEvent } from "react";

/** The two props that make one radio in a group keyboard-walkable. */
export interface RadioKeyProps {
  tabIndex: 0 | -1;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Props for the `index`th radio of a group whose options are `options` and whose choice is
 * `value`. Spread them onto the `role="radio"` element beside its own `onClick`.
 *
 * `onChoose` is called with the option the arrow landed on — the same callback the radio's click
 * already calls, so a keyboard choice and a pointer choice cannot mean two different things.
 */
export function radioKeys<T>(
  options: readonly T[],
  value: T,
  onChoose: (next: T) => void,
  index: number,
): RadioKeyProps {
  const checked = options.indexOf(value);
  const stop = checked === -1 ? 0 : checked;
  return {
    tabIndex: index === stop ? 0 : -1,
    onKeyDown: (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const next = nextRadio(e.key, index, options.length);
      if (next === null) return;
      e.preventDefault();
      const radios = e.currentTarget
        .closest('[role="radiogroup"]')
        ?.querySelectorAll<HTMLElement>('[role="radio"]');
      radios?.[next]?.focus();
      onChoose(options[next]);
    },
  };
}

/** Where an arrow, Home or End moves from `at` in a group of `count`; `null` for any other key. */
export function nextRadio(key: string, at: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
